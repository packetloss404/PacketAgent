import assert from "node:assert/strict";
import test from "node:test";
import { createSeedStore, type JobRecord, type PacketAgentData } from "../../packetagent-store.js";
import { createWorkerEffectRepository } from "../effects.js";
import {
  makeWorkerDefinition,
  makeWorkerDeployment,
  makeWorkerRun,
  makeWorkerVersion,
} from "../__tests__/fixtures.js";
import { createPermissiveWorkerBudgetPort } from "../__tests__/budget-port.js";
import { initialWorkerSupervisorState, reduceWorkerSupervisor } from "./reducer.js";
import { snapshotWorkerSupervisorState } from "./checkpoint.js";
import { createWorkerRuntimeRepository, type WorkerLeaseAcquisition } from "./repository.js";
import { createWorkerRecoveryCoordinator } from "./recovery.js";
import { runWorkerSupervisor } from "./supervisor.js";
import type {
  WorkerClockPort,
  WorkerRuntimeProviderResult,
  WorkerRuntimeToolResult,
  WorkerSupervisorPorts,
} from "./ports.js";

const START = new Date("2030-01-01T00:00:00.000Z");

test("expired Worker work is requeued once and resumes the exact action cursor", async () => {
  const harness = await recoveryHarness();
  harness.advance(2_000);

  const first = await harness.recovery.recoverExpired();
  const second = await harness.recovery.recoverExpired();

  assert.deepEqual(first.requeuedRunIds, ["run-1"]);
  assert.deepEqual(second.unchangedRunIds, ["run-1"]);
  assert.equal(harness.run.runtimeLease, undefined);
  assert.equal(harness.job.status, "queued");
  assert.equal(harness.job.attempts, 0);
  assert.equal(
    harness.data.workerEvents.filter((event) => event.type === "worker.run.recovery_queued").length,
    1,
  );

  const reacquired = await harness.runtime.acquire({
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    ownerId: "restarted-owner",
    now: harness.now(),
  });
  assert.equal(reacquired.disposition, "acquired");
  if (reacquired.disposition !== "acquired") return;
  assert.equal(reacquired.context.checkpoint?.cursor.phase, "act");
  assert.equal(reacquired.context.checkpoint?.cursor.actionIndex, 0);

  let planCalls = 0;
  let evaluationCalls = 0;
  let toolCalls = 0;
  const ports: WorkerSupervisorPorts = {
    budgets: createPermissiveWorkerBudgetPort(),
    provider: {
      async call(request) {
        if (request.phase === "plan") planCalls += 1;
        else evaluationCalls += 1;
        return providerResult({
          content: '{"predicateId":"release-decision","matched":true,"evidence":"resumed"}',
        });
      },
    },
    tools: {
      definitions: () => [],
      async execute(input): Promise<WorkerRuntimeToolResult> {
        toolCalls += 1;
        return {
          callId: input.call.id,
          toolName: input.call.name,
          status: "ok",
          output: { resumed: true },
          durationMs: 1,
          startedAt: harness.now().toISOString(),
          completedAt: harness.now().toISOString(),
        };
      },
    },
    clock: harness.clock,
    checkpoints: harness.runtime,
    events: harness.runtime,
    leases: harness.runtime,
    cancellation: harness.runtime,
    runs: harness.runtime,
  };
  const completed = await runWorkerSupervisor({
    context: reacquired.context,
    lease: reacquired.lease,
    ports,
    signal: new AbortController().signal,
  });

  assert.equal(completed.run.status, "completed");
  assert.equal(planCalls, 0);
  assert.equal(evaluationCalls, 1);
  assert.equal(toolCalls, 1);
  assert.equal(completed.run.budgetUsage.iterations, 1);
});

test("recovery quarantines a prepared non-replayable effect", async () => {
  const harness = await recoveryHarness();
  const effects = createWorkerEffectRepository({
    ...harness.store,
    now: harness.now,
    id: harness.id,
  });
  await effects.prepare({
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    workerVersionId: "worker-version-1",
    workerDeploymentId: "deployment-1",
    fencingToken: harness.acquisition.lease.fencingToken,
    iteration: 1,
    actionId: "call-resume",
    capabilityId: "release-read",
    toolName: "http_fetch",
    operation: "http.post",
    inputDigest: `sha256:${"a".repeat(64)}`,
    effectKey: `sha256:${"b".repeat(64)}`,
    classification: "non_replayable_mutation",
  });
  harness.advance(2_000);

  const recovered = await harness.recovery.recoverExpired();

  assert.deepEqual(recovered.quarantinedRunIds, ["run-1"]);
  assert.equal(harness.run.status, "quarantined");
  assert.equal(harness.run.terminalReason, "unsafe_replay");
  assert.equal(harness.job.status, "failed");
});

test("recovery quarantines a checkpoint whose chained digest was corrupted", async () => {
  const harness = await recoveryHarness();
  const checkpoint = harness.data.workerCheckpoints[0];
  harness.data.workerCheckpoints[0] = {
    ...checkpoint,
    workingMemory: {
      ...checkpoint.workingMemory,
      pendingTools: [],
    },
  };
  harness.advance(2_000);

  const recovered = await harness.recovery.recoverExpired();

  assert.deepEqual(recovered.quarantinedRunIds, ["run-1"]);
  assert.equal(harness.run.status, "quarantined");
  assert.match(harness.run.error ?? "", /digest/i);
});

interface RecoveryHarness {
  readonly data: PacketAgentData;
  readonly store: {
    loadStore: () => PacketAgentData;
    mutateStore: <T>(mutation: (draft: PacketAgentData) => T | Promise<T>) => Promise<T>;
  };
  readonly runtime: ReturnType<typeof createWorkerRuntimeRepository>;
  readonly recovery: ReturnType<typeof createWorkerRecoveryCoordinator>;
  readonly acquisition: Extract<WorkerLeaseAcquisition, { readonly disposition: "acquired" }>;
  readonly clock: WorkerClockPort;
  readonly now: () => Date;
  readonly id: (kind: "job" | "event" | "checkpoint" | "effect_receipt") => string;
  readonly run: ReturnType<typeof makeWorkerRun>;
  readonly job: JobRecord;
  advance(ms: number): void;
}

async function recoveryHarness(): Promise<RecoveryHarness> {
  let data = createSeedStore();
  let nowMs = START.getTime();
  let nextId = 0;
  let mutationTail: Promise<void> = Promise.resolve();
  const id = (kind: "job" | "event" | "checkpoint" | "effect_receipt"): string =>
    `${kind}-${++nextId}`;
  const now = (): Date => new Date(nowMs);
  const store = {
    loadStore: () => data,
    mutateStore: async <T>(mutation: (draft: PacketAgentData) => T | Promise<T>): Promise<T> => {
      const previous = mutationTail;
      let release!: () => void;
      mutationTail = new Promise<void>((resolve) => {
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
  const version = makeWorkerVersion({
    status: "validated",
    createdAt: now().toISOString(),
    validatedAt: now().toISOString(),
  });
  data.workerDefinitions.push(
    makeWorkerDefinition({
      status: "active",
      currentVersionId: version.id,
      createdAt: now().toISOString(),
      updatedAt: now().toISOString(),
    }),
  );
  data.workerVersions.push(version);
  data.workerDeployments.push(
    makeWorkerDeployment({
      status: "active",
      createdAt: now().toISOString(),
      updatedAt: now().toISOString(),
      activatedAt: now().toISOString(),
    }),
  );
  data.workerRuns.push(
    makeWorkerRun({
      createdAt: now().toISOString(),
      updatedAt: now().toISOString(),
    }),
  );
  const runtime = createWorkerRuntimeRepository({
    ...store,
    now,
    leaseDurationMs: 1_000,
    id: (kind) => id(kind),
  });
  const acquisition = await runtime.acquire({
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    ownerId: "crashed-owner",
    now: now(),
  });
  assert.equal(acquisition.disposition, "acquired");
  if (acquisition.disposition !== "acquired") {
    throw new Error("recovery test failed to acquire its run");
  }

  let state = initialWorkerSupervisorState(
    acquisition.context.run.budgetUsage,
    version.content.policy.budgets,
  );
  state = reduceWorkerSupervisor(state, { type: "iteration.begin" });
  state = reduceWorkerSupervisor(state, {
    type: "provider.plan_succeeded",
    result: providerResult({
      content: "resume candidate",
      toolCalls: [
        {
          id: "call-resume",
          name: "http_fetch",
          input: { url: "https://example.test/releases" },
        },
      ],
    }),
  });
  await runtime.save({
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    workerVersionId: "worker-version-1",
    expectedRunRevision: acquisition.context.run.revision,
    expectedCheckpointSequence: -1,
    fencingToken: acquisition.lease.fencingToken,
    cursor: state.cursor,
    budgetUsage: state.usage,
    workingMemory: snapshotWorkerSupervisorState(state),
    completedActionIds: [],
    pendingApprovalIds: [],
    artifactRefs: [],
    effectReceiptIds: [],
  });
  data.jobs.push({
    id: "worker-job-1",
    workspaceId: "workspace-1",
    type: "worker.run",
    payload: {
      workerRunId: "run-1",
      workerDeploymentId: "deployment-1",
      workerVersionId: "worker-version-1",
    },
    status: "running",
    attempts: 1,
    maxAttempts: 3,
    scheduledAt: now().toISOString(),
    startedAt: now().toISOString(),
    createdAt: now().toISOString(),
    updatedAt: now().toISOString(),
  });
  const recovery = createWorkerRecoveryCoordinator({
    mutateStore: store.mutateStore,
    now,
    id: (kind) => id(kind),
  });
  const clock: WorkerClockPort = {
    now,
    monotonicMs: () => performance.now(),
    sleep(ms, signal) {
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    },
  };
  return {
    get data() {
      return data;
    },
    store,
    runtime,
    recovery,
    acquisition,
    clock,
    now,
    id,
    get run() {
      return data.workerRuns[0];
    },
    get job() {
      return data.jobs.find((job) => job.id === "worker-job-1")!;
    },
    advance(ms) {
      nowMs += ms;
    },
  };
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
    model: "test-model",
    provider: "test-provider",
    ...overrides,
  };
}
