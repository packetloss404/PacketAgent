import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "hono";
import { createSeedStore, type PacketAgentData } from "../packetagent-store.js";
import {
  createWorkerOperatorRoutes,
  type AuthorizedWorkerOperatorContext,
} from "../worker-operator-routes.js";
import { createWorkerActivationRepository } from "./activation-repository.js";
import { createWorkerActivationService, type WorkerActivationService } from "./activation.js";
import { createWorkerAttentionService, type WorkerAttentionService } from "./attention-service.js";
import { createPermissiveWorkerBudgetPort } from "./__tests__/budget-port.js";
import {
  makeWorkerDefinition,
  makeWorkerDeployment,
  makeWorkerRun,
  makeWorkerVersion,
  makeWorkerVersionContent,
} from "./__tests__/fixtures.js";
import { compileWorkerCapabilityPolicy } from "./capabilities.js";
import { createWorkerControlService, type WorkerControlService } from "./control-service.js";
import { WorkerLifecycleError } from "./errors.js";
import { createSystemWorkerClock } from "./runtime/adapters.js";
import { snapshotWorkerSupervisorState } from "./runtime/checkpoint.js";
import type { WorkerLeaseAcquisition, WorkerRuntimeRepository } from "./runtime/repository.js";
import { createWorkerRuntimeRepository } from "./runtime/repository.js";
import type {
  WorkerAttentionResolutionInput,
  WorkerRuntimeProviderResult,
  WorkerRuntimeToolResult,
  WorkerSupervisorPorts,
} from "./runtime/ports.js";
import { initialWorkerSupervisorState, reduceWorkerSupervisor } from "./runtime/reducer.js";
import { runWorkerSupervisor } from "./runtime/supervisor.js";
import type { WorkerRun, WorkerSupervisorPhase } from "./types.js";

const NOW = new Date("2026-07-27T16:00:00.000Z");
const ACTOR = {
  type: "user" as const,
  id: "operator-gate",
  displayName: "Gate Operator",
};
const OPERATION_DIGEST = `sha256:${"a".repeat(64)}`;

test("approval attention survives process replacement and callback replay", async () => {
  const beforeRestart = transactionalStore(canonicalData({ approval: true }));
  const original = createAttentionRuntime(beforeRestart, "before");
  const acquisition = await acquire(original.runtime, "before-owner");
  const waiting = await original.attention.resolve(
    approvalInput(acquisition, original.policyDigest, NOW),
  );
  assert.equal(waiting.disposition, "waiting");
  if (waiting.disposition !== "waiting") return;

  const durableSnapshot = structuredClone(beforeRestart.data);
  const afterRestart = transactionalStore(durableSnapshot);
  const control = createControl(afterRestart, "after");
  const approved = await control.approveOnce({
    workspaceId: "workspace-1",
    attentionRequestId: waiting.attention.id,
    actor: ACTOR,
    idempotencyKey: "restart-approve",
    expectedRevision: waiting.run.revision,
  });
  assert.equal(approved.disposition, "applied");
  assert.equal(approved.approvalNonce, "after-nonce");

  const replayedByAnotherProcess = await createControl(afterRestart, "callback-replay").approveOnce(
    {
      workspaceId: "workspace-1",
      attentionRequestId: waiting.attention.id,
      actor: ACTOR,
      idempotencyKey: "restart-approve",
      expectedRevision: waiting.run.revision,
    },
  );
  assert.equal(replayedByAnotherProcess.disposition, "replayed");
  assert.equal(replayedByAnotherProcess.approvalNonce, undefined);
  assert.equal(afterRestart.data.workerApprovalGrants.length, 1);

  const resumed = await createControl(afterRestart, "resume").resumeRun({
    workspaceId: "workspace-1",
    workerRunId: waiting.run.id,
    actor: ACTOR,
    idempotencyKey: "restart-resume",
    expectedRevision: waiting.run.revision,
  });
  assert.equal(resumed.run?.status, "queued");

  const restartedRuntime = createAttentionRuntime(afterRestart, "resumed");
  const resumedAcquisition = await acquire(restartedRuntime.runtime, "after-owner");
  const claimed = await restartedRuntime.attention.resolve(
    approvalInput(
      resumedAcquisition,
      restartedRuntime.policyDigest,
      NOW,
      resumedAcquisition.context.checkpoint?.sequence ?? -1,
    ),
  );
  assert.equal(claimed.disposition, "approved");
  if (claimed.disposition !== "approved") return;
  assert.equal(claimed.approval.attentionRequestId, waiting.attention.id);
  assert.equal(afterRestart.data.workerApprovalGrants[0]?.status, "consumed");
});

for (const first of ["approve", "reject"] as const) {
  test(`${first} wins an atomic approve/reject race without a split outcome`, async () => {
    const prepared = await waitingStore(`race-${first}`);
    const control = createControl(prepared.store, `race-${first}`);
    const approve = () =>
      control.approveOnce({
        workspaceId: "workspace-1",
        attentionRequestId: prepared.attentionId,
        actor: ACTOR,
        idempotencyKey: `race-${first}-approve`,
        expectedRevision: prepared.runRevision,
      });
    const reject = () =>
      control.rejectAttention({
        workspaceId: "workspace-1",
        attentionRequestId: prepared.attentionId,
        actor: ACTOR,
        idempotencyKey: `race-${first}-reject`,
        expectedRevision: prepared.runRevision,
      });
    const results =
      first === "approve"
        ? await Promise.all([approve(), reject()])
        : await Promise.all([reject(), approve()]);

    assert.equal(results.filter((result) => result.disposition === "applied").length, 1);
    assert.equal(results.filter((result) => result.disposition === "rejected").length, 1);
    assert.equal(prepared.store.data.workerControlCommands.length, 2);
    assert.equal(
      prepared.store.data.workerControlCommands.filter((command) => command.status === "applied")
        .length,
      1,
    );
    const attention = prepared.store.data.workerAttentionRequests[0]!;
    const run = prepared.store.data.workerRuns[0]!;
    if (first === "approve") {
      assert.equal(attention.status, "approved");
      assert.equal(run.status, "waiting_for_approval");
      assert.equal(prepared.store.data.workerApprovalGrants.length, 1);
    } else {
      assert.equal(attention.status, "rejected");
      assert.equal(run.status, "failed");
      assert.equal(run.terminalReason, "approval_rejected");
      assert.equal(prepared.store.data.workerApprovalGrants.length, 0);
    }
  });
}

for (const phase of [
  "plan",
  "act",
  "evaluate",
  "checkpoint",
  "decide",
] satisfies readonly WorkerSupervisorPhase[]) {
  test(`a durable stop at supervisor ${phase} prevents all later work`, async () => {
    const result = await stopAtSupervisorPhase(phase);

    assert.equal(
      result.controlDisposition,
      "applied",
      `run: ${result.run.status}/${result.run.terminalReason}; control error: ${result.controlError}; observed phases: ${result.observedPhases.join(", ")}`,
    );
    assert.equal(result.run.status, "cancelled");
    assert.equal(result.run.terminalReason, "operator_cancelled");
    assert.equal(result.stopObserved, true);
    if (phase === "plan" || phase === "act") {
      assert.equal(result.toolCalls, 0);
    }
    assert.equal(result.eventsAfterStop, 0);
  });
}

for (const first of ["activation", "revoke"] as const) {
  test(`${first} wins an activation/revoke race without leaving runnable work`, async () => {
    const store = transactionalStore(canonicalData({ includeRun: false }));
    const activation = createActivation(store, `activation-race-${first}`);
    const control = createControl(store, `activation-race-${first}`);
    const admit = () =>
      activation.admit({
        workspaceId: "workspace-1",
        workerDeploymentId: "deployment-1",
        triggerId: "manual",
        source: "manual",
        deliveryId: `delivery-${first}`,
        occurredAt: NOW.toISOString(),
        actor: ACTOR,
        payload: { release_id: "release-race" },
        trace: { traceId: "0123456789abcdef0123456789abcdef" },
      });
    const revoke = () =>
      control.revokeDeployment({
        workspaceId: "workspace-1",
        workerDeploymentId: "deployment-1",
        actor: ACTOR,
        idempotencyKey: `revoke-${first}`,
        expectedRevision: 1,
      });
    const results =
      first === "activation"
        ? await Promise.allSettled([admit(), revoke()])
        : await Promise.allSettled([revoke(), admit()]);

    assert.equal(
      results.some((result) => result.status === "fulfilled"),
      true,
    );
    assert.equal(store.data.workerDeployments[0]?.status, "revoked");
    assert.equal(
      store.data.workerRuns.every(
        (run) => run.status === "cancelled" && run.terminalReason === "deployment_revoked",
      ),
      true,
    );
    assert.equal(
      store.data.jobs
        .filter((job) => job.type === "worker.run")
        .every((job) => job.status === "canceled"),
      true,
    );

    await assert.rejects(
      activation.admit({
        workspaceId: "workspace-1",
        workerDeploymentId: "deployment-1",
        triggerId: "manual",
        source: "manual",
        deliveryId: `delivery-after-${first}`,
        occurredAt: NOW.toISOString(),
        actor: ACTOR,
        payload: { release_id: "release-after-revoke" },
        trace: { traceId: "1123456789abcdef0123456789abcdef" },
      }),
      (error: unknown) =>
        error instanceof WorkerLifecycleError && error.code === "invalid_transition",
    );
  });
}

test("fresh operator routes stop and revoke using durable state without authoring services", async () => {
  const durableSnapshot = structuredClone(canonicalData());
  const store = transactionalStore(durableSnapshot);
  const control = createControl(store, "headless");
  const routes = createWorkerOperatorRoutes({
    control,
    loadStore: store.loadStore,
    authorize: async (_context: Context): Promise<AuthorizedWorkerOperatorContext> => ({
      workspaceId: "workspace-1",
      actor: ACTOR,
    }),
  });

  const stopped = await postOperator(routes, "/runs/run-1/stop", 1, "headless-stop");
  assert.equal(stopped.status, 200);
  assert.equal(
    ((await stopped.json()) as { run: { terminalReason: string } }).run.terminalReason,
    "operator_cancelled",
  );

  const revoked = await postOperator(
    routes,
    "/deployments/deployment-1/revoke",
    1,
    "headless-revoke",
  );
  assert.equal(revoked.status, 200);
  assert.equal(
    ((await revoked.json()) as { deployment: { status: string } }).deployment.status,
    "revoked",
  );
  assert.equal(store.data.workerDeployments[0]?.status, "revoked");
});

interface TransactionalStore {
  readonly data: PacketAgentData;
  readonly loadStore: () => PacketAgentData;
  readonly mutateStore: <T>(mutation: (draft: PacketAgentData) => T | Promise<T>) => Promise<T>;
}

function transactionalStore(initial: PacketAgentData): TransactionalStore {
  let data = initial;
  let tail: Promise<void> = Promise.resolve();
  return {
    get data() {
      return data;
    },
    loadStore: () => data,
    async mutateStore<T>(mutation: (draft: PacketAgentData) => T | Promise<T>): Promise<T> {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        const draft = structuredClone(data);
        const result = await mutation(draft);
        data = draft;
        return result;
      } finally {
        release();
      }
    },
  };
}

function canonicalData(
  options: {
    readonly approval?: boolean;
    readonly includeRun?: boolean;
  } = {},
): PacketAgentData {
  const data = createSeedStore();
  const base = makeWorkerVersionContent();
  const content = makeWorkerVersionContent({
    ...(options.approval
      ? {
          tools: base.tools.map((capability) => ({
            ...capability,
            approval: "always" as const,
          })),
        }
      : {}),
  });
  const version = makeWorkerVersion({
    status: "validated",
    content,
    createdAt: NOW.toISOString(),
    validatedAt: NOW.toISOString(),
  });
  const compilation = compileWorkerCapabilityPolicy({
    workerVersionContentDigest: version.contentDigest,
    requestedCapabilities: version.content.tools,
    allowedCapabilityIds: version.content.policy.permissions.allowedCapabilityIds,
    credentialRefs: version.content.credentialRefs,
  });
  data.workerDefinitions.push(
    makeWorkerDefinition({
      status: "active",
      currentVersionId: version.id,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    }),
  );
  data.workerVersions.push(version);
  data.workerDeployments.push(
    makeWorkerDeployment({
      status: "active",
      capabilityGrants: compilation.grants,
      compiledPolicy: compilation.policy,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      activatedAt: NOW.toISOString(),
    }),
  );
  if (options.includeRun !== false) {
    data.workerRuns.push(
      makeWorkerRun({
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      }),
    );
  }
  return data;
}

function createControl(
  store: TransactionalStore,
  prefix: string,
  now: () => Date = () => NOW,
): WorkerControlService {
  let id = 0;
  return createWorkerControlService({
    mutateStore: store.mutateStore,
    now,
    id: (kind) => `${kind}-${prefix}-${++id}`,
    nonce: () => `${prefix}-nonce`,
  });
}

function createAttentionRuntime(
  store: TransactionalStore,
  prefix: string,
): {
  readonly runtime: WorkerRuntimeRepository;
  readonly attention: WorkerAttentionService;
  readonly policyDigest: string;
} {
  let id = 0;
  const nextId = (kind: "attention" | "checkpoint" | "delivery" | "event" | "job") =>
    `${kind}-${prefix}-${++id}`;
  return {
    runtime: createWorkerRuntimeRepository({
      loadStore: store.loadStore,
      mutateStore: store.mutateStore,
      now: () => NOW,
      id: (kind) => `${kind}-${prefix}-runtime-${++id}`,
      leaseDurationMs: 60_000,
    }),
    attention: createWorkerAttentionService({
      mutateStore: store.mutateStore,
      now: () => NOW,
      id: nextId,
    }),
    policyDigest: store.data.workerDeployments[0]!.compiledPolicy!.policyDigest,
  };
}

async function acquire(
  runtime: WorkerRuntimeRepository,
  ownerId: string,
  now: Date = NOW,
): Promise<Extract<WorkerLeaseAcquisition, { disposition: "acquired" }>> {
  const result = await runtime.acquire({
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    ownerId,
    now,
  });
  assert.equal(result.disposition, "acquired");
  if (result.disposition !== "acquired") {
    throw new Error("W7 control gate could not acquire its Worker run.");
  }
  return result;
}

function approvalInput(
  acquisition: Extract<WorkerLeaseAcquisition, { disposition: "acquired" }>,
  policyDigest: string,
  requestedAt: Date,
  expectedCheckpointSequence = -1,
): WorkerAttentionResolutionInput {
  const state = reduceWorkerSupervisor(
    reduceWorkerSupervisor(
      initialWorkerSupervisorState(
        acquisition.context.run.budgetUsage,
        acquisition.context.version.content.policy.budgets,
      ),
      { type: "iteration.begin" },
    ),
    {
      type: "provider.plan_succeeded",
      result: providerResult({
        toolCalls: [
          {
            id: "call-approval",
            name: "http_fetch",
            input: {
              url: "https://releases.example.test/latest",
            },
          },
        ],
      }),
    },
  );
  return {
    context: acquisition.context,
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    workerVersionId: acquisition.context.version.id,
    expectedRunRevision: acquisition.context.run.revision,
    expectedCheckpointSequence,
    fencingToken: acquisition.lease.fencingToken,
    cursor: state.cursor,
    budgetUsage: state.usage,
    workingMemory: snapshotWorkerSupervisorState(state),
    completedActionIds: state.completedActionIds,
    pendingApprovalIds: state.pendingApprovalIds,
    artifactRefs: state.artifactRefs,
    effectReceiptIds: state.effectReceiptIds,
    actionId: "call-approval",
    policyDecision: {
      allowed: false,
      code: "approval_required",
      tool: "http_fetch",
      verb: "GET",
      effect: "read",
      operationDigest: OPERATION_DIGEST,
      resourceCount: 1,
      resourceSchemes: ["https"],
      policyDigest,
      capabilityId: "release-read",
    },
    requestedAt,
  };
}

async function waitingStore(prefix: string): Promise<{
  readonly store: TransactionalStore;
  readonly attentionId: string;
  readonly runRevision: number;
}> {
  const store = transactionalStore(canonicalData({ approval: true }));
  const runtime = createAttentionRuntime(store, prefix);
  const acquisition = await acquire(runtime.runtime, `${prefix}-owner`);
  const result = await runtime.attention.resolve(
    approvalInput(acquisition, runtime.policyDigest, NOW),
  );
  assert.equal(result.disposition, "waiting");
  if (result.disposition !== "waiting") {
    throw new Error("W7 control gate did not create approval attention.");
  }
  return {
    store,
    attentionId: result.attention.id,
    runRevision: result.run.revision,
  };
}

async function stopAtSupervisorPhase(phase: WorkerSupervisorPhase): Promise<{
  readonly run: WorkerRun;
  readonly controlDisposition: string;
  readonly stopObserved: boolean;
  readonly toolCalls: number;
  readonly eventsAfterStop: number;
  readonly observedPhases: readonly WorkerSupervisorPhase[];
  readonly controlError?: string;
}> {
  const store = transactionalStore(canonicalData());
  let id = 0;
  const clock = createSystemWorkerClock();
  const runtime = createWorkerRuntimeRepository({
    loadStore: store.loadStore,
    mutateStore: store.mutateStore,
    now: clock.now,
    id: (kind) => `${kind}-runtime-phase-${phase}-${++id}`,
    leaseDurationMs: 60_000,
  });
  const control = createControl(store, `phase-${phase}`, clock.now);
  const acquisition = await acquire(runtime, `phase-${phase}-owner`, clock.now());
  let stopped = false;
  let controlDisposition = "";
  let toolCalls = 0;
  let eventsAfterStop = 0;
  const observedPhases: WorkerSupervisorPhase[] = [];
  let controlError: string | undefined;
  const events: WorkerSupervisorPorts["events"] = {
    async append(input) {
      observedPhases.push(input.event.phase);
      if (stopped) eventsAfterStop += 1;
      await runtime.append(input);
      if (!stopped && input.event.phase === phase) {
        const current = store.data.workerRuns.find(
          (run) => run.workspaceId === "workspace-1" && run.id === "run-1",
        )!;
        try {
          const result = await control.stopRun({
            workspaceId: "workspace-1",
            workerRunId: "run-1",
            actor: ACTOR,
            idempotencyKey: `stop-at-${phase}`,
            expectedRevision: current.revision,
          });
          controlDisposition = result.disposition;
          stopped = true;
        } catch (error) {
          controlError = error instanceof Error ? error.message : String(error);
          throw error;
        }
      }
    },
  };
  const ports: WorkerSupervisorPorts = {
    checkpoints: runtime,
    events,
    leases: runtime,
    cancellation: runtime,
    runs: runtime,
    budgets: createPermissiveWorkerBudgetPort(),
    clock,
    provider: {
      async call(request) {
        return request.phase === "plan"
          ? providerResult({
              content: "candidate",
              toolCalls: [
                {
                  id: "call-1",
                  name: "http_fetch",
                  input: {
                    url: "https://releases.example.test/latest",
                  },
                },
              ],
            })
          : providerResult({
              content: '{"predicateId":"release-decision","matched":true,"evidence":"done"}',
            });
      },
    },
    tools: {
      definitions(capabilities) {
        return capabilities.map((capability) => ({
          name: capability.tool,
          description: capability.tool,
          inputSchema: {},
        }));
      },
      async authorize(input) {
        const capability = input.compiledPolicy?.capabilities.find(
          (candidate) => candidate.tool === input.call.name,
        );
        return {
          allowed: Boolean(capability),
          code: capability ? "allowed" : "capability_not_granted",
          tool: input.call.name,
          verb: capability?.verb ?? "UNKNOWN",
          effect: capability?.effect ?? "execute",
          operationDigest: OPERATION_DIGEST,
          resourceCount: 1,
          resourceSchemes: ["https"],
          ...(input.compiledPolicy ? { policyDigest: input.compiledPolicy.policyDigest } : {}),
          ...(capability ? { capabilityId: capability.capabilityId } : {}),
        };
      },
      async execute(input): Promise<WorkerRuntimeToolResult> {
        toolCalls += 1;
        const timestamp = clock.now().toISOString();
        return {
          callId: input.call.id,
          toolName: input.call.name,
          status: "ok",
          output: { ok: true },
          durationMs: 0,
          startedAt: timestamp,
          completedAt: timestamp,
        };
      },
    },
    attention: {
      async resolve() {
        throw new Error("W7 stop gate unexpectedly requested approval.");
      },
    },
  };
  const result = await runWorkerSupervisor({
    context: acquisition.context,
    lease: acquisition.lease,
    ports,
    signal: new AbortController().signal,
  });
  return {
    run: result.run,
    controlDisposition,
    stopObserved: stopped,
    toolCalls,
    eventsAfterStop,
    observedPhases,
    ...(controlError ? { controlError } : {}),
  };
}

function createActivation(store: TransactionalStore, prefix: string): WorkerActivationService {
  let id = 0;
  return createWorkerActivationService({
    repository: createWorkerActivationRepository({
      loadStore: store.loadStore,
      mutateStore: store.mutateStore,
    }),
    now: () => NOW,
    id: (kind) => `${kind}-${prefix}-${++id}`,
  });
}

function providerResult(
  overrides: Partial<WorkerRuntimeProviderResult> = {},
): WorkerRuntimeProviderResult {
  return {
    content: "",
    toolCalls: [],
    finishReason: "stop",
    usage: {
      promptTokens: 1,
      completionTokens: 1,
      costUsd: 0.01,
    },
    model: "gate-model",
    provider: "gate-provider",
    ...overrides,
  };
}

function postOperator(
  routes: ReturnType<typeof createWorkerOperatorRoutes>,
  path: string,
  expectedRevision: number,
  idempotencyKey: string,
): Promise<Response> {
  return Promise.resolve(
    routes.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({ expectedRevision }),
    }),
  );
}
