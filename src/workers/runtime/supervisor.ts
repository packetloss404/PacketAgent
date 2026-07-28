import type {
  JsonObject,
  WorkerCompiledCapability,
  WorkerRetryPolicy,
  WorkerRun,
} from "../types.js";
import type {
  WorkerLease,
  WorkerRuntimeContext,
  WorkerRuntimeProviderRequest,
  WorkerRuntimeProviderResult,
  WorkerSupervisorPorts,
} from "./ports.js";
import {
  initialWorkerSupervisorState,
  parseWorkerEvaluation,
  reduceWorkerSupervisor,
  type WorkerSupervisorState,
} from "./reducer.js";
import { restoreWorkerSupervisorState, snapshotWorkerSupervisorState } from "./checkpoint.js";
import { WorkerEffectInterruptionError, WorkerUnsafeReplayError } from "../effects.js";
import { resolveWorkerRollingBudgetPolicy } from "../budget-types.js";
import { WorkerRollingBudgetExceededError } from "../rolling-budget.js";
import type { ToolPolicyDecision, WorkerToolApprovalEvidence } from "../../tools/types.js";

export const WORKER_SCHEDULER_SHUTDOWN_REASON = "packetagent.scheduler_shutdown";
export const WORKER_OPERATOR_CANCEL_REASON = "packetagent.operator_cancelled";
const WORKER_TOOL_ACTOR = {
  type: "system" as const,
  id: "packetagent.worker-supervisor",
  displayName: "PacketAgent Worker Supervisor",
};

export class WorkerRuntimeReleasedError extends Error {
  readonly reason: "scheduler_shutdown" | "lease_lost" | "operator_paused" | "operator_controlled";

  constructor(reason: WorkerRuntimeReleasedError["reason"]) {
    super(`Worker runtime released: ${reason}`);
    this.name = "WorkerRuntimeReleasedError";
    this.reason = reason;
  }
}

class WorkerAwaitDeadlineError extends Error {
  constructor() {
    super("Worker await exceeded the remaining elapsed-time budget.");
    this.name = "WorkerAwaitDeadlineError";
  }
}

class WorkerOperationAbortedError extends Error {
  constructor() {
    super("Worker operation aborted.");
    this.name = "WorkerOperationAbortedError";
  }
}

class WorkerProviderPhaseError extends Error {
  readonly result: WorkerRuntimeProviderResult;

  constructor(phase: "plan" | "evaluate", result: WorkerRuntimeProviderResult) {
    super(`Worker provider ${phase} phase ended with ${result.finishReason}.`);
    this.name = "WorkerProviderPhaseError";
    this.result = result;
  }
}

class WorkerPerRunProviderBudgetExceededError extends Error {
  constructor() {
    super("Worker per-run provider budget has no remaining reservable amount.");
    this.name = "WorkerPerRunProviderBudgetExceededError";
  }
}

class WorkerCheckpointPersistenceError extends Error {
  constructor(readonly cause: unknown) {
    super(
      `Worker checkpoint persistence failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "WorkerCheckpointPersistenceError";
  }
}

export interface RunWorkerSupervisorInput {
  readonly context: WorkerRuntimeContext;
  readonly lease: WorkerLease;
  readonly ports: WorkerSupervisorPorts;
  readonly signal: AbortSignal;
  readonly startupError?: string;
}

export interface RunWorkerSupervisorResult {
  readonly state: WorkerSupervisorState;
  readonly run: WorkerRun;
}

export async function runWorkerSupervisor(
  input: RunWorkerSupervisorInput,
): Promise<RunWorkerSupervisorResult> {
  const { context, ports, signal } = input;
  const retry = context.version.content.policy.retry;
  const limits = {
    ...context.version.content.policy.budgets,
    maxConsecutiveFailures: Math.min(
      context.version.content.policy.budgets.maxConsecutiveFailures,
      retry.maxAttempts,
    ),
  };
  let state = context.checkpoint
    ? restoreWorkerSupervisorState(context.checkpoint, context.run.budgetUsage, limits)
    : initialWorkerSupervisorState(context.run.budgetUsage, limits);
  let lease = input.lease;
  let runRevision = context.run.revision;
  let checkpointSequence = context.checkpoint?.sequence ?? -1;
  const monotonicStartedAt = ports.clock.monotonicMs();
  const elapsedAtStart = context.run.budgetUsage.elapsedMs;

  const observeElapsed = (): void => {
    state = reduceWorkerSupervisor(state, {
      type: "elapsed.observed",
      elapsedMs: elapsedAtStart + Math.max(0, ports.clock.monotonicMs() - monotonicStartedAt),
    });
  };

  const inspectSignal = (): void => {
    if (!signal.aborted || state.terminal) return;
    if (signal.reason === WORKER_SCHEDULER_SHUTDOWN_REASON) {
      throw new WorkerRuntimeReleasedError("scheduler_shutdown");
    }
    state = reduceWorkerSupervisor(state, {
      type: "cancelled",
      reason: "operator_cancelled",
    });
  };

  const awaitBounded = async <T>(
    operation: (operationSignal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    observeElapsed();
    inspectSignal();
    if (state.terminal) throw new WorkerAwaitDeadlineError();
    const remainingMs = Math.max(1, limits.maxElapsedMs - state.usage.elapsedMs);
    const leaseRemainingMs = Math.max(1, Date.parse(lease.expiresAt) - ports.clock.now().getTime());
    const deadlineMs = Math.min(remainingMs, leaseRemainingMs);
    const operationController = new AbortController();
    const timeoutController = new AbortController();
    let rejectAbort: ((error: Error) => void) | undefined;
    const onAbort = (): void => {
      operationController.abort(signal.reason);
      rejectAbort?.(new WorkerOperationAbortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
      if (signal.aborted) onAbort();
    });
    const timeout = ports.clock.sleep(deadlineMs, timeoutController.signal).then(() => {
      operationController.abort("elapsed_time");
      if (leaseRemainingMs <= remainingMs) {
        state = reduceWorkerSupervisor(state, {
          type: "cancelled",
          reason: "lease_lost",
        });
        throw new WorkerRuntimeReleasedError("lease_lost");
      }
      throw new WorkerAwaitDeadlineError();
    });
    try {
      return await Promise.race([operation(operationController.signal), timeout, aborted]);
    } finally {
      timeoutController.abort();
      signal.removeEventListener("abort", onAbort);
      observeElapsed();
      inspectSignal();
    }
  };

  const refreshControl = async (): Promise<void> => {
    observeElapsed();
    inspectSignal();
    if (state.terminal) return;

    const cancellation = await awaitBounded(() =>
      ports.cancellation.inspect({
        workspaceId: context.run.workspaceId,
        workerRunId: context.run.id,
        workerDeploymentId: context.run.workerDeploymentId,
      }),
    );
    if (cancellation.kind === "paused") {
      throw new WorkerRuntimeReleasedError("operator_paused");
    }
    if (cancellation.kind !== "active") {
      state = reduceWorkerSupervisor(state, {
        type: "cancelled",
        reason: cancellation.kind,
      });
      return;
    }

    const now = ports.clock.now();
    if (Date.parse(lease.expiresAt) <= now.getTime()) {
      state = reduceWorkerSupervisor(state, { type: "cancelled", reason: "lease_lost" });
      throw new WorkerRuntimeReleasedError("lease_lost");
    }
    const renewed = await awaitBounded(() =>
      ports.leases.renew({
        workspaceId: context.run.workspaceId,
        workerRunId: context.run.id,
        lease,
        now,
      }),
    );
    if (!renewed) {
      state = reduceWorkerSupervisor(state, { type: "cancelled", reason: "lease_lost" });
      throw new WorkerRuntimeReleasedError("lease_lost");
    }
    lease = renewed;
  };

  const persistState = async (
    cursor = state.cursor,
  ): Promise<{ checkpointId: string; checkpointSequence: number }> => {
    try {
      const result = await awaitBounded(() =>
        ports.checkpoints.save({
          workspaceId: context.run.workspaceId,
          workerRunId: context.run.id,
          workerVersionId: context.run.workerVersionId,
          expectedRunRevision: runRevision,
          expectedCheckpointSequence: checkpointSequence,
          fencingToken: lease.fencingToken,
          cursor,
          budgetUsage: state.usage,
          workingMemory: snapshotWorkerSupervisorState(state),
          completedActionIds: state.completedActionIds,
          pendingApprovalIds: state.pendingApprovalIds,
          artifactRefs: state.artifactRefs,
          effectReceiptIds: state.effectReceiptIds,
        }),
      );
      runRevision = result.runRevision;
      checkpointSequence = result.checkpointSequence;
      return result;
    } catch (error) {
      if (
        error instanceof WorkerRuntimeReleasedError ||
        error instanceof WorkerAwaitDeadlineError ||
        error instanceof WorkerOperationAbortedError
      ) {
        throw error;
      }
      const control = await ports.cancellation.inspect({
        workspaceId: context.run.workspaceId,
        workerRunId: context.run.id,
        workerDeploymentId: context.run.workerDeploymentId,
      });
      if (control.kind !== "active") {
        throw new WorkerRuntimeReleasedError(
          control.kind === "paused" ? "operator_paused" : "operator_controlled",
        );
      }
      throw new WorkerCheckpointPersistenceError(error);
    }
  };

  const emit = async (type: string, summary: string, data?: JsonObject): Promise<void> => {
    await refreshControl();
    if (state.terminal) return;
    await awaitBounded(() =>
      ports.events.append({
        context,
        fencingToken: lease.fencingToken,
        event: {
          type,
          phase: state.phase,
          cursor: state.cursor,
          summary,
          ...(data ? { data } : {}),
        },
      }),
    );
    await refreshControl();
  };

  const appendPolicyDecision = async (decision: ToolPolicyDecision): Promise<void> => {
    await ports.events.append({
      context,
      fencingToken: lease.fencingToken,
      event: {
        type: decision.allowed ? "worker.policy.allowed" : "worker.policy.denied",
        phase: state.phase,
        cursor: state.cursor,
        summary: decision.allowed
          ? `Worker policy allowed ${decision.tool}.`
          : `Worker policy denied ${decision.tool}.`,
        data: {
          decision: decision.allowed ? "allow" : "deny",
          code: decision.code,
          tool: decision.tool,
          verb: decision.verb,
          effect: decision.effect,
          operationDigest: decision.operationDigest,
          resourceCount: decision.resourceCount,
          resourceSchemes: [...decision.resourceSchemes],
          ...(decision.policyDigest ? { policyDigest: decision.policyDigest } : {}),
          ...(decision.capabilityId ? { capabilityId: decision.capabilityId } : {}),
          ...(decision.approvalGrantId ? { approvalGrantId: decision.approvalGrantId } : {}),
          ...(decision.attentionRequestId
            ? { attentionRequestId: decision.attentionRequestId }
            : {}),
        },
      },
    });
  };

  const failPhase = async (error: unknown): Promise<void> => {
    const message = error instanceof Error ? error.message : String(error);
    state = reduceWorkerSupervisor(state, { type: "phase.failed", error: message });
    if (state.terminal) return;
    await persistState();
    const backoffMs = retryBackoffMs(retry, state.usage.consecutiveFailures);
    await refreshControl();
    if (state.terminal) return;
    await awaitBounded((operationSignal) => ports.clock.sleep(backoffMs, operationSignal));
    await refreshControl();
  };

  const applyBudgetExhaustion = (error: unknown): boolean => {
    if (error instanceof WorkerPerRunProviderBudgetExceededError) {
      state = reduceWorkerSupervisor(state, {
        type: "bound.reached",
        reason: "provider_cost",
      });
      return true;
    }
    if (error instanceof WorkerRollingBudgetExceededError) {
      state = reduceWorkerSupervisor(state, {
        type: "bound.reached",
        reason:
          error.kind === "provider_cost_usd"
            ? "rolling_provider_cost"
            : "rolling_billable_actions",
      });
      return true;
    }
    return false;
  };

  try {
    await emit("worker.run.started", "Worker supervisor started.");
    if (input.startupError) {
      while (!state.terminal) {
        state = reduceWorkerSupervisor(state, {
          type: "phase.failed",
          error: input.startupError,
        });
      }
    }

    while (!state.terminal) {
      await refreshControl();
      if (state.terminal) break;

      if (state.phase === "plan") {
        if (!state.iterationOpen) {
          state = reduceWorkerSupervisor(state, { type: "iteration.begin" });
          if (state.terminal) break;
          await persistState();
        }
        try {
          const result = await callProvider(
            ports,
            context,
            state,
            lease.fencingToken,
            "plan",
            signal,
            awaitBounded,
          );
          state = reduceWorkerSupervisor(state, {
            type: "provider.plan_succeeded",
            result,
          });
          await persistState();
          await emit("worker.phase.planned", "Worker planning phase completed.", {
            iteration: state.cursor.iteration,
            requestedToolCalls: result.toolCalls.length,
            providerCostUsd: result.usage.costUsd,
          });
        } catch (error) {
          if (
            error instanceof WorkerRuntimeReleasedError ||
            error instanceof WorkerCheckpointPersistenceError ||
            error instanceof WorkerEffectInterruptionError
          ) {
            throw error;
          }
          if (error instanceof WorkerUnsafeReplayError) {
            state = reduceWorkerSupervisor(state, {
              type: "quarantined",
              error: error.message,
            });
            continue;
          }
          if (applyBudgetExhaustion(error)) continue;
          if (error instanceof WorkerAwaitDeadlineError) {
            observeElapsed();
          } else {
            if (error instanceof WorkerProviderPhaseError) {
              state = reduceWorkerSupervisor(state, {
                type: "provider.evaluation_charged",
                result: error.result,
              });
              if (state.terminal) continue;
            }
            await failPhase(error);
          }
        }
        continue;
      }

      if (state.phase === "act") {
        const call = state.pendingTools[state.cursor.actionIndex];
        if (!call) {
          state = reduceWorkerSupervisor(state, {
            type: "quarantined",
            error: "Worker action cursor did not resolve to a planned tool call.",
          });
          continue;
        }
        try {
          const authorizationInput = {
            workspaceId: context.run.workspaceId,
            workerDefinitionId: context.run.workerDefinitionId,
            workerRunId: context.run.id,
            workerVersionId: context.run.workerVersionId,
            workerVersionContentDigest: context.version.contentDigest,
            declaredCredentialRefs: context.version.content.credentialRefs,
            workerDeploymentId: context.run.workerDeploymentId,
            workerDeploymentRevision: context.deployment.revision,
            ...(context.deployment.compiledPolicy
              ? { compiledPolicy: context.deployment.compiledPolicy }
              : {}),
            budgetUsage: state.usage,
            actor: WORKER_TOOL_ACTOR,
            call,
            authorizedAt: ports.clock.now(),
            signal,
          };
          let approval: WorkerToolApprovalEvidence | undefined;
          let decision = await awaitBounded((operationSignal) =>
            ports.tools.authorize({
              ...authorizationInput,
              signal: operationSignal,
            }),
          );
          if (decision.code === "approval_required") {
            await appendPolicyDecision(decision);
            const resolution = await ports.attention.resolve({
              context,
              workspaceId: context.run.workspaceId,
              workerRunId: context.run.id,
              workerVersionId: context.run.workerVersionId,
              expectedRunRevision: runRevision,
              expectedCheckpointSequence: checkpointSequence,
              fencingToken: lease.fencingToken,
              cursor: state.cursor,
              budgetUsage: state.usage,
              workingMemory: snapshotWorkerSupervisorState(state),
              completedActionIds: state.completedActionIds,
              pendingApprovalIds: state.pendingApprovalIds,
              artifactRefs: state.artifactRefs,
              effectReceiptIds: state.effectReceiptIds,
              actionId: call.id,
              policyDecision: decision,
              requestedAt: ports.clock.now(),
            });
            if (resolution.disposition !== "approved") {
              state = {
                ...state,
                pendingApprovalIds: [
                  ...new Set([...state.pendingApprovalIds, resolution.attention.id]),
                ],
              };
              return { state, run: resolution.run };
            }
            approval = resolution.approval;
            decision = await awaitBounded((operationSignal) =>
              ports.tools.authorize({
                ...authorizationInput,
                approval,
                signal: operationSignal,
              }),
            );
          }
          if (!decision.allowed) {
            await appendPolicyDecision(decision);
            await failPhase(
              new Error(`Worker policy denied tool "${call.name}" (${decision.code}).`),
            );
            continue;
          }
          state = reduceWorkerSupervisor(state, { type: "tool.reserve" });
          if (state.terminal) continue;
          const result = await awaitBounded((operationSignal) =>
            ports.tools.execute({
              workspaceId: context.run.workspaceId,
              workerDefinitionId: context.run.workerDefinitionId,
              workerRunId: context.run.id,
              workerVersionId: context.run.workerVersionId,
              workerVersionContentDigest: context.version.contentDigest,
              declaredCredentialRefs: context.version.content.credentialRefs,
              workerDeploymentId: context.run.workerDeploymentId,
              workerDeploymentRevision: context.deployment.revision,
              ...(context.deployment.compiledPolicy
                ? { compiledPolicy: context.deployment.compiledPolicy }
                : {}),
              budgetUsage: state.usage,
              budgetPolicy: context.version.content.policy.budgets,
              actor: WORKER_TOOL_ACTOR,
              iteration: state.cursor.iteration,
              fencingToken: lease.fencingToken,
              reservedAt: ports.clock.now(),
              call,
              ...(approval ? { approval } : {}),
              recordPolicyDecision: appendPolicyDecision,
              signal: operationSignal,
            }),
          );
          await refreshControl();
          if (state.terminal) continue;
          if (result.status !== "ok") {
            await failPhase(new Error(result.error ?? `Tool ${result.toolName} failed.`));
            continue;
          }
          if (approval) {
            state = {
              ...state,
              pendingApprovalIds: state.pendingApprovalIds.filter(
                (id) => id !== approval.attentionRequestId,
              ),
            };
          }
          state = reduceWorkerSupervisor(state, {
            type: "tool.succeeded",
            result,
            ...(result.effectReceiptId ? { effectReceiptId: result.effectReceiptId } : {}),
          });
          await persistState();
          await emit("worker.tool.completed", `Worker tool ${result.toolName} completed.`, {
            callId: result.callId,
            tool: result.toolName,
            status: result.status,
            durationMs: result.durationMs,
          });
        } catch (error) {
          if (
            error instanceof WorkerRuntimeReleasedError ||
            error instanceof WorkerCheckpointPersistenceError ||
            error instanceof WorkerEffectInterruptionError
          ) {
            throw error;
          }
          if (error instanceof WorkerUnsafeReplayError) {
            state = reduceWorkerSupervisor(state, {
              type: "quarantined",
              error: error.message,
            });
            continue;
          }
          if (applyBudgetExhaustion(error)) continue;
          if (error instanceof WorkerAwaitDeadlineError) observeElapsed();
          else {
            if (error instanceof WorkerProviderPhaseError) {
              state = reduceWorkerSupervisor(state, {
                type: "provider.evaluation_charged",
                result: error.result,
              });
              if (state.terminal) continue;
            }
            await failPhase(error);
          }
        }
        continue;
      }

      if (state.phase === "evaluate") {
        try {
          const result = await callProvider(
            ports,
            context,
            state,
            lease.fencingToken,
            "evaluate",
            signal,
            awaitBounded,
          );
          state = reduceWorkerSupervisor(state, {
            type: "provider.evaluation_charged",
            result,
          });
          if (state.terminal) continue;
          const evaluation = parseWorkerEvaluation(
            result.content,
            context.version.content.exitPredicates,
            state.cursor.iteration,
          );
          if (!evaluation) {
            await failPhase(
              new Error("Provider returned an invalid or undeclared Worker exit evaluation."),
            );
            continue;
          }
          state = reduceWorkerSupervisor(state, {
            type: "evaluation.accepted",
            evaluation,
          });
          const checkpoint = await persistState({
            ...state.cursor,
            phase: "decide",
          });
          await emit("worker.checkpoint.saved", "Worker phase cursor checkpointed.", {
            checkpointId: checkpoint.checkpointId,
            runRevision,
          });
          state = reduceWorkerSupervisor(state, { type: "checkpoint.saved" });
          await emit("worker.phase.evaluated", "Worker exit predicate evaluated.", {
            predicateId: evaluation.predicateId,
            predicateKind: evaluation.predicateKind,
            matched: evaluation.matched,
            checkpointId: checkpoint.checkpointId,
          });
        } catch (error) {
          if (
            error instanceof WorkerRuntimeReleasedError ||
            error instanceof WorkerCheckpointPersistenceError
          ) {
            throw error;
          }
          if (applyBudgetExhaustion(error)) continue;
          if (error instanceof WorkerAwaitDeadlineError) observeElapsed();
          else await failPhase(error);
        }
        continue;
      }

      if (state.phase === "checkpoint") {
        try {
          const result = await persistState({
            ...state.cursor,
            phase: "decide",
          });
          state = reduceWorkerSupervisor(state, { type: "checkpoint.saved" });
          await emit("worker.checkpoint.saved", "Worker phase cursor checkpointed.", {
            checkpointId: result.checkpointId,
            runRevision,
          });
        } catch (error) {
          if (
            error instanceof WorkerRuntimeReleasedError ||
            error instanceof WorkerCheckpointPersistenceError
          ) {
            throw error;
          }
          if (error instanceof WorkerAwaitDeadlineError) observeElapsed();
          else await failPhase(error);
        }
        continue;
      }

      if (state.phase === "decide") {
        state = reduceWorkerSupervisor(state, { type: "decide" });
        if (!state.terminal) await persistState();
        continue;
      }

      state = reduceWorkerSupervisor(state, {
        type: "quarantined",
        error: `Unsupported supervisor phase ${state.phase}.`,
      });
    }
  } catch (error) {
    if (
      error instanceof WorkerRuntimeReleasedError ||
      error instanceof WorkerCheckpointPersistenceError ||
      error instanceof WorkerEffectInterruptionError
    ) {
      throw error;
    }
    if (error instanceof WorkerAwaitDeadlineError) {
      observeElapsed();
    } else if (!state.terminal) {
      state = reduceWorkerSupervisor(state, {
        type: "phase.failed",
        error: error instanceof Error ? error.message : String(error),
      });
      while (!state.terminal) {
        state = reduceWorkerSupervisor(state, {
          type: "phase.failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const selected = state.terminal;
  if (!selected) {
    throw new Error("Worker supervisor stopped without a reducer-selected terminal outcome.");
  }
  const run = await ports.runs.finalize({
    context,
    finalization: {
      expectedRunRevision: runRevision,
      fencingToken: lease.fencingToken,
      status: selected.status,
      terminalReason: selected.reason,
      budgetUsage: state.usage,
      ...(selected.output !== undefined ? { output: selected.output } : {}),
      ...(selected.error !== undefined ? { error: selected.error } : {}),
    },
    now: ports.clock.now(),
  });
  await ports.leases.release({
    workspaceId: context.run.workspaceId,
    workerRunId: context.run.id,
    lease,
    now: ports.clock.now(),
  });
  return { state, run };
}

async function callProvider(
  ports: WorkerSupervisorPorts,
  context: WorkerRuntimeContext,
  state: WorkerSupervisorState,
  fencingToken: number,
  phase: "plan" | "evaluate",
  parentSignal: AbortSignal,
  awaitBounded: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>,
): Promise<WorkerRuntimeProviderResult> {
  const reservableAmount =
    state.limits.maxProviderCostUsd - state.usage.providerCostUsd;
  if (!Number.isFinite(reservableAmount) || reservableAmount <= 0) {
    throw new WorkerPerRunProviderBudgetExceededError();
  }
  const reservationResult = await ports.budgets.reserve({
    workspaceId: context.run.workspaceId,
    workerDeploymentId: context.run.workerDeploymentId,
    workerRunId: context.run.id,
    workerVersionId: context.run.workerVersionId,
    fencingToken,
    reservationKey: [
      context.run.id,
      fencingToken,
      "provider",
      phase,
      state.cursor.iteration,
      state.usage.consecutiveFailures,
    ].join(":"),
    kind: "provider_cost_usd",
    amount: reservableAmount,
    policy: resolveWorkerRollingBudgetPolicy(state.limits),
    now: ports.clock.now(),
  });
  if (!reservationResult.allowed) {
    throw new WorkerRollingBudgetExceededError(
      "provider_cost_usd",
      reservationResult.code === "workspace_limit" ? "workspace" : "deployment",
    );
  }
  const request = providerRequest(context, state, phase, parentSignal, ports);
  let result: WorkerRuntimeProviderResult;
  try {
    result = await awaitBounded((signal) => ports.provider.call({ ...request, signal }));
  } catch (error) {
    await ports.budgets.release({
      workspaceId: context.run.workspaceId,
      workerRunId: context.run.id,
      fencingToken,
      reservationId: reservationResult.reservation.id,
      reason: "call_failed_before_result",
      now: ports.clock.now(),
    });
    throw error;
  }
  await ports.budgets.settle({
    workspaceId: context.run.workspaceId,
    workerRunId: context.run.id,
    fencingToken,
    reservationId: reservationResult.reservation.id,
    actualAmount: Math.max(0, result.usage.costUsd),
    now: ports.clock.now(),
  });
  if (result.finishReason === "error" || result.finishReason === "length") {
    throw new WorkerProviderPhaseError(phase, result);
  }
  return result;
}

function providerRequest(
  context: WorkerRuntimeContext,
  state: WorkerSupervisorState,
  phase: "plan" | "evaluate",
  signal: AbortSignal,
  ports: WorkerSupervisorPorts,
): WorkerRuntimeProviderRequest {
  const content = context.version.content;
  const base = {
    workspaceId: context.run.workspaceId,
    workerRunId: context.run.id,
    routeKey: content.execution.routeKey,
    ...(content.execution.providerId ? { providerId: content.execution.providerId } : {}),
    ...(content.execution.model ? { model: content.execution.model } : {}),
    phase,
    signal,
  } as const;
  if (phase === "plan") {
    return {
      ...base,
      systemPrompt:
        "You are the planning phase of a bounded PacketAgent Worker. Use only supplied tools. Return a concise result when no tool is needed.",
      userPrompt: [
        `OBJECTIVE: ${content.objective}`,
        `INSTRUCTIONS: ${content.instructions}`,
        `INPUT: ${JSON.stringify(context.input)}`,
        `ITERATION: ${state.cursor.iteration}`,
        state.toolResults.length > 0
          ? `PRIOR TOOL RESULTS: ${JSON.stringify(state.toolResults)}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
      tools: ports.tools.definitions(executableCapabilities(context)),
    };
  }
  return {
    ...base,
    systemPrompt:
      "You are the evaluation phase of a bounded PacketAgent Worker. Return only JSON with predicateId, matched, and evidence. Test exactly one declared predicate.",
    userPrompt: [
      `OBJECTIVE: ${content.objective}`,
      `CANDIDATE OUTPUT: ${JSON.stringify(state.candidateOutput ?? null)}`,
      `TOOL RESULTS: ${JSON.stringify(state.toolResults)}`,
      `EXIT PREDICATES: ${JSON.stringify(content.exitPredicates)}`,
      'RESPONSE SHAPE: {"predicateId":"declared-id","matched":true,"evidence":"concise evidence"}',
    ].join("\n"),
    tools: [],
  };
}

function executableCapabilities(
  context: WorkerRuntimeContext,
): readonly WorkerCompiledCapability[] {
  return (
    context.deployment.compiledPolicy?.capabilities.filter(
      (capability) => capability.approval === "never",
    ) ?? []
  );
}

function retryBackoffMs(policy: WorkerRetryPolicy, failure: number): number {
  const exponent = Math.max(0, failure - 1);
  return Math.min(
    policy.maxBackoffMs,
    Math.floor(policy.initialBackoffMs * policy.backoffMultiplier ** exponent),
  );
}
