import { randomUUID } from "node:crypto";
import {
  loadStoreAsync as defaultLoadStore,
  mutateStoreAsync as defaultMutateStore,
  type PacketAgentData,
} from "../../packetagent-store.js";
import { WorkerLifecycleError } from "../errors.js";
import { WORKER_EVENT_SCHEMA_VERSION, type WorkerEvent } from "../persistence-types.js";
import { validateWorkerPersistence } from "../repository.js";
import { assertWorkerRunUpdate, isTerminalWorkerRunStatus } from "../transitions.js";
import {
  WORKER_CONTRACT_SCHEMA_VERSION,
  type WorkerCheckpoint,
  type WorkerRun,
  type WorkerRuntimeLease,
} from "../types.js";
import type {
  WorkerCancellationPort,
  WorkerCheckpointPort,
  WorkerEventPort,
  WorkerLease,
  WorkerLeasePort,
  WorkerRunPort,
  WorkerRuntimeContext,
} from "./ports.js";
import {
  assertCheckpointDigest,
  remainingWorkerBudget,
  workerCheckpointStateDigest,
  WorkerCheckpointRecoveryError,
} from "./checkpoint.js";

type MaybePromise<T> = T | Promise<T>;

const DEFAULT_WORKER_LEASE_MS = 30_000;
const RUNTIME_ACTOR = {
  type: "system" as const,
  id: "packetagent.worker-supervisor",
  displayName: "PacketAgent Worker Supervisor",
};

export interface WorkerRuntimeRepositoryDependencies {
  readonly loadStore?: () => MaybePromise<PacketAgentData>;
  readonly mutateStore?: <T>(
    mutator: (data: PacketAgentData) => MaybePromise<T>,
  ) => MaybePromise<T>;
  readonly id?: (kind: "checkpoint" | "event") => string;
  readonly leaseDurationMs?: number;
  readonly now?: () => Date;
}

export type WorkerLeaseAcquisition =
  | {
      readonly disposition: "acquired";
      readonly context: WorkerRuntimeContext;
      readonly lease: WorkerLease;
    }
  | {
      readonly disposition: "busy";
      readonly retryAt: string;
    }
  | {
      readonly disposition: "terminal";
      readonly run: WorkerRun;
    };

export interface WorkerRuntimeRepository
  extends
    WorkerCheckpointPort,
    WorkerEventPort,
    WorkerLeasePort,
    WorkerCancellationPort,
    WorkerRunPort {
  acquire(input: {
    readonly workspaceId: string;
    readonly workerRunId: string;
    readonly ownerId: string;
    readonly now: Date;
  }): Promise<WorkerLeaseAcquisition>;
}

export function createWorkerRuntimeRepository(
  dependencies: WorkerRuntimeRepositoryDependencies = {},
): WorkerRuntimeRepository {
  const loadStore = dependencies.loadStore ?? defaultLoadStore;
  const mutateStore = dependencies.mutateStore ?? defaultMutateStore;
  const id = dependencies.id ?? ((kind: "checkpoint" | "event") => `${kind}_${randomUUID()}`);
  const now = dependencies.now ?? (() => new Date());
  const leaseDurationMs = dependencies.leaseDurationMs ?? DEFAULT_WORKER_LEASE_MS;
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1_000) {
    throw new Error("Worker lease duration must be an integer of at least 1000ms.");
  }

  return {
    async acquire(input) {
      return await mutateStore((data) => {
        validateWorkerPersistence(data);
        const run = requireRun(data, input.workspaceId, input.workerRunId);
        if (isTerminalWorkerRunStatus(run.status)) {
          return { disposition: "terminal" as const, run: clone(run) };
        }
        if (run.status !== "queued" && run.status !== "running") {
          throw new WorkerLifecycleError(
            "conflict",
            `WorkerRun ${run.id} cannot execute from status ${run.status}.`,
          );
        }

        const nowIso = input.now.toISOString();
        const currentLease = run.runtimeLease;
        if (
          currentLease &&
          currentLease.ownerId !== input.ownerId &&
          Date.parse(currentLease.expiresAt) > input.now.getTime()
        ) {
          return {
            disposition: "busy" as const,
            retryAt: currentLease.expiresAt,
          };
        }

        const definition = data.workerDefinitions.find(
          (record) =>
            record.workspaceId === input.workspaceId && record.id === run.workerDefinitionId,
        );
        const version = data.workerVersions.find(
          (record) => record.workspaceId === input.workspaceId && record.id === run.workerVersionId,
        );
        const deployment = data.workerDeployments.find(
          (record) =>
            record.workspaceId === input.workspaceId && record.id === run.workerDeploymentId,
        );
        if (!definition || !version || !deployment) {
          throw new WorkerLifecycleError(
            "integrity",
            `WorkerRun ${run.id} has missing runtime context.`,
          );
        }
        const checkpoint = latestValidWorkerCheckpoint(data, run);

        const fencingToken = Math.max(run.runtimeFence, currentLease?.fencingToken ?? 0) + 1;
        const runtimeLease: WorkerRuntimeLease = {
          ownerId: input.ownerId,
          fencingToken,
          acquiredAt: nowIso,
          renewedAt: nowIso,
          expiresAt: new Date(input.now.getTime() + leaseDurationMs).toISOString(),
        };
        const next: WorkerRun = {
          ...run,
          status: "running",
          revision: run.revision + 1,
          runtimeFence: fencingToken,
          runtimeLease,
          updatedAt: nowIso,
          ...(run.startedAt ? {} : { startedAt: nowIso }),
        };
        assertWorkerRunUpdate(run, next);
        replaceRun(data, next);
        appendRuntimeEvent(data, id("event"), next, {
          type: "worker.run.lease_acquired",
          summary: "Worker execution lease acquired.",
          data: {
            workerRunId: next.id,
            ownerId: runtimeLease.ownerId,
            fencingToken: runtimeLease.fencingToken,
            expiresAt: runtimeLease.expiresAt,
            runRevision: next.revision,
          },
          occurredAt: nowIso,
        });
        validateWorkerPersistence(data);
        return {
          disposition: "acquired" as const,
          context: {
            definition: clone(definition),
            version: clone(version),
            deployment: clone(deployment),
            run: clone(next),
            input: clone(next.input ?? {}),
            ...(checkpoint ? { checkpoint: clone(checkpoint) } : {}),
          },
          lease: clone(runtimeLease),
        };
      });
    },

    async renew(input) {
      return await mutateStore((data) => {
        validateWorkerPersistence(data);
        const run = requireRun(data, input.workspaceId, input.workerRunId);
        const current = run.runtimeLease;
        if (
          !current ||
          current.ownerId !== input.lease.ownerId ||
          current.fencingToken !== input.lease.fencingToken ||
          Date.parse(current.expiresAt) <= input.now.getTime()
        ) {
          return null;
        }
        const renewed: WorkerRuntimeLease = {
          ...current,
          renewedAt: input.now.toISOString(),
          expiresAt: new Date(input.now.getTime() + leaseDurationMs).toISOString(),
        };
        replaceRun(data, { ...run, runtimeLease: renewed });
        validateWorkerPersistence(data);
        return clone(renewed);
      });
    },

    async release(input) {
      await mutateStore((data) => {
        validateWorkerPersistence(data);
        const run = requireRun(data, input.workspaceId, input.workerRunId);
        const current = run.runtimeLease;
        if (
          !current ||
          current.ownerId !== input.lease.ownerId ||
          current.fencingToken !== input.lease.fencingToken
        ) {
          return;
        }
        const { runtimeLease: _released, ...withoutLease } = run;
        const next: WorkerRun = {
          ...withoutLease,
          revision: run.revision + 1,
          updatedAt: input.now.toISOString(),
        };
        assertWorkerRunUpdate(run, next);
        replaceRun(data, next);
        validateWorkerPersistence(data);
      });
    },

    async inspect(input) {
      const data = await loadStore();
      validateWorkerPersistence(data);
      const run = requireRun(data, input.workspaceId, input.workerRunId);
      const deployment = data.workerDeployments.find(
        (record) =>
          record.workspaceId === input.workspaceId && record.id === input.workerDeploymentId,
      );
      if (!deployment) {
        throw new WorkerLifecycleError(
          "integrity",
          `WorkerDeployment ${input.workerDeploymentId} was not found.`,
        );
      }
      if (deployment.status === "revoked" || deployment.status === "retired") {
        return { kind: "deployment_revoked" as const };
      }
      if (run.status === "cancelled") return { kind: "operator_cancelled" as const };
      return { kind: "active" as const };
    },

    async save(write) {
      return await mutateStore((data) => {
        validateWorkerPersistence(data);
        const run = requireFencedRun(
          data,
          write.workspaceId,
          write.workerRunId,
          write.expectedRunRevision,
          write.fencingToken,
          now(),
        );
        if (run.workerVersionId !== write.workerVersionId) {
          throw new WorkerLifecycleError(
            "integrity",
            "Worker checkpoint attempted to change the pinned WorkerVersion.",
          );
        }
        const version = data.workerVersions.find(
          (record) =>
            record.workspaceId === write.workspaceId && record.id === write.workerVersionId,
        );
        if (!version) {
          throw new WorkerLifecycleError("integrity", "Pinned WorkerVersion was not found.");
        }
        const previous = latestValidWorkerCheckpoint(data, run);
        const currentSequence = previous?.sequence ?? -1;
        if (currentSequence !== write.expectedCheckpointSequence) {
          throw new WorkerLifecycleError(
            "conflict",
            `Worker checkpoint sequence changed from expected ${write.expectedCheckpointSequence} to ${currentSequence}.`,
          );
        }
        const sequence = currentSequence + 1;
        const checkpointId = id("checkpoint");
        const createdAt = now().toISOString();
        const remainingBudget = remainingWorkerBudget(
          {
            ...version.content.policy.budgets,
            maxConsecutiveFailures: Math.min(
              version.content.policy.budgets.maxConsecutiveFailures,
              version.content.policy.retry.maxAttempts,
            ),
          },
          write.budgetUsage,
        );
        if (previous) assertRemainingBudgetDidNotIncrease(previous, remainingBudget);
        const checkpointContent: Omit<WorkerCheckpoint, "stateDigest"> = {
          schemaVersion: WORKER_CONTRACT_SCHEMA_VERSION,
          id: checkpointId,
          workspaceId: write.workspaceId,
          workerRunId: write.workerRunId,
          workerVersionId: write.workerVersionId,
          sequence,
          ...(previous ? { previousCheckpointId: previous.id } : {}),
          cursor: write.cursor,
          workingMemory: write.workingMemory,
          completedActionIds: [...write.completedActionIds],
          pendingApprovalIds: [...write.pendingApprovalIds],
          artifactRefs: [...write.artifactRefs],
          effectReceiptIds: [...write.effectReceiptIds],
          remainingBudget,
          ...(run.trace ? { trace: run.trace } : {}),
          createdAt,
        };
        const checkpoint: WorkerCheckpoint = {
          ...checkpointContent,
          stateDigest: workerCheckpointStateDigest(checkpointContent),
        };
        const next: WorkerRun = {
          ...run,
          revision: run.revision + 1,
          latestCheckpointId: checkpoint.id,
          budgetUsage: write.budgetUsage,
          updatedAt: createdAt,
        };
        assertWorkerRunUpdate(run, next);
        data.workerCheckpoints.push(checkpoint);
        replaceRun(data, next);
        appendRuntimeEvent(data, id("event"), next, {
          type: "worker.checkpoint.persisted",
          summary: "Worker phase cursor persisted.",
          data: {
            workerRunId: next.id,
            checkpointId,
            checkpointSequence: sequence,
            phase: write.cursor.phase,
            iteration: write.cursor.iteration,
            actionIndex: write.cursor.actionIndex,
            runRevision: next.revision,
          },
          occurredAt: createdAt,
        });
        validateWorkerPersistence(data);
        return {
          checkpointId,
          checkpointSequence: sequence,
          runRevision: next.revision,
        };
      });
    },

    async append(input) {
      await mutateStore((data) => {
        validateWorkerPersistence(data);
        const run = requireFencedRun(
          data,
          input.context.run.workspaceId,
          input.context.run.id,
          undefined,
          input.fencingToken,
          now(),
        );
        appendRuntimeEvent(data, id("event"), run, {
          type: input.event.type,
          summary: input.event.summary,
          data: {
            workerRunId: run.id,
            phase: input.event.phase,
            iteration: input.event.cursor.iteration,
            actionIndex: input.event.cursor.actionIndex,
            ...(input.event.data ?? {}),
          },
          occurredAt: now().toISOString(),
        });
        validateWorkerPersistence(data);
      });
    },

    async finalize(input) {
      return await mutateStore((data) => {
        validateWorkerPersistence(data);
        const run = requireFencedRun(
          data,
          input.context.run.workspaceId,
          input.context.run.id,
          input.finalization.expectedRunRevision,
          input.finalization.fencingToken,
          input.now,
        );
        const { runtimeLease: _released, ...withoutLease } = run;
        const next: WorkerRun = {
          ...withoutLease,
          status: input.finalization.status,
          revision: run.revision + 1,
          terminalReason: input.finalization.terminalReason,
          budgetUsage: input.finalization.budgetUsage,
          ...(input.finalization.output !== undefined ? { output: input.finalization.output } : {}),
          ...(input.finalization.error !== undefined ? { error: input.finalization.error } : {}),
          updatedAt: input.now.toISOString(),
          completedAt: input.now.toISOString(),
        };
        assertWorkerRunUpdate(run, next);
        replaceRun(data, next);
        appendRuntimeEvent(data, id("event"), next, {
          type: "worker.run.terminal",
          summary: `Worker run reached ${next.status}.`,
          data: {
            workerRunId: next.id,
            status: next.status,
            terminalReason: next.terminalReason ?? "unhandled_error",
            runRevision: next.revision,
            elapsedMs: next.budgetUsage.elapsedMs,
            iterations: next.budgetUsage.iterations,
            providerCostUsd: next.budgetUsage.providerCostUsd,
            toolCalls: next.budgetUsage.toolCalls,
          },
          occurredAt: input.now.toISOString(),
        });
        validateWorkerPersistence(data);
        return clone(next);
      });
    },
  };
}

function requireRun(data: PacketAgentData, workspaceId: string, workerRunId: string): WorkerRun {
  const run = data.workerRuns.find(
    (record) => record.workspaceId === workspaceId && record.id === workerRunId,
  );
  if (!run) {
    throw new WorkerLifecycleError("not_found", `WorkerRun ${workerRunId} was not found.`);
  }
  return run;
}

function requireFencedRun(
  data: PacketAgentData,
  workspaceId: string,
  workerRunId: string,
  expectedRevision: number | undefined,
  fencingToken: number,
  now: Date,
): WorkerRun {
  const run = requireRun(data, workspaceId, workerRunId);
  if (expectedRevision !== undefined && run.revision !== expectedRevision) {
    throw new WorkerLifecycleError(
      "conflict",
      `WorkerRun ${run.id} revision changed from expected ${expectedRevision} to ${run.revision}.`,
    );
  }
  if (
    !run.runtimeLease ||
    run.runtimeLease.fencingToken !== fencingToken ||
    Date.parse(run.runtimeLease.expiresAt) <= now.getTime()
  ) {
    throw new WorkerLifecycleError("conflict", `WorkerRun ${run.id} execution lease was lost.`);
  }
  return run;
}

function replaceRun(data: PacketAgentData, run: WorkerRun): void {
  const index = data.workerRuns.findIndex(
    (record) => record.workspaceId === run.workspaceId && record.id === run.id,
  );
  if (index < 0) {
    throw new WorkerLifecycleError("not_found", `WorkerRun ${run.id} was not found.`);
  }
  data.workerRuns[index] = run;
}

export function latestValidWorkerCheckpoint(
  data: PacketAgentData,
  run: WorkerRun,
): WorkerCheckpoint | undefined {
  const checkpoints = data.workerCheckpoints
    .filter((record) => record.workspaceId === run.workspaceId && record.workerRunId === run.id)
    .sort((left, right) => left.sequence - right.sequence);
  let previous: WorkerCheckpoint | undefined;
  for (const checkpoint of checkpoints) {
    if (checkpoint.workerVersionId !== run.workerVersionId) {
      throw new WorkerCheckpointRecoveryError(
        `Checkpoint ${checkpoint.id} changed the run's pinned WorkerVersion.`,
      );
    }
    if (checkpoint.sequence !== (previous?.sequence ?? -1) + 1) {
      throw new WorkerCheckpointRecoveryError(
        `Checkpoint ${checkpoint.id} breaks the run checkpoint sequence.`,
      );
    }
    if (checkpoint.previousCheckpointId !== previous?.id) {
      throw new WorkerCheckpointRecoveryError(
        `Checkpoint ${checkpoint.id} breaks the run checkpoint chain.`,
      );
    }
    assertCheckpointDigest(checkpoint);
    if (previous) {
      assertRemainingBudgetDidNotIncrease(previous, checkpoint.remainingBudget);
    }
    previous = checkpoint;
  }
  if (run.latestCheckpointId !== previous?.id) {
    throw new WorkerCheckpointRecoveryError(
      `WorkerRun ${run.id} does not point at its latest checkpoint.`,
    );
  }
  return previous;
}

function assertRemainingBudgetDidNotIncrease(
  previous: WorkerCheckpoint,
  next: WorkerCheckpoint["remainingBudget"],
): void {
  for (const key of ["elapsedMs", "iterations", "providerCostUsd", "toolCalls"] as const) {
    if (next[key] > previous.remainingBudget[key] + Number.EPSILON) {
      throw new WorkerLifecycleError(
        "integrity",
        `Worker checkpoint remaining ${key} cannot increase.`,
      );
    }
  }
}

function appendRuntimeEvent(
  data: PacketAgentData,
  eventId: string,
  run: WorkerRun,
  input: Pick<WorkerEvent, "type" | "summary" | "data" | "occurredAt">,
): void {
  const sequence =
    data.workerEvents
      .filter((record) => record.workspaceId === run.workspaceId)
      .reduce((maximum, record) => Math.max(maximum, record.sequence), 0) + 1;
  data.workerEvents.push({
    schemaVersion: WORKER_EVENT_SCHEMA_VERSION,
    id: eventId,
    workspaceId: run.workspaceId,
    sequence,
    type: input.type,
    workerDefinitionId: run.workerDefinitionId,
    workerVersionId: run.workerVersionId,
    workerDeploymentId: run.workerDeploymentId,
    actor: RUNTIME_ACTOR,
    summary: input.summary,
    ...(input.data ? { data: input.data } : {}),
    occurredAt: input.occurredAt,
  });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
