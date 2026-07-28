import assert from "node:assert/strict";
import test from "node:test";
import { createSeedStore, type PacketAgentData } from "../packetagent-store.js";
import {
  makeWorkerDefinition,
  makeWorkerDeployment,
  makeWorkerRun,
  makeWorkerVersion,
  TEST_NOW,
} from "./__tests__/fixtures.js";
import {
  createWorkerEffectCoordinator,
  createWorkerEffectRepository,
  WorkerEffectInterruptionError,
  WorkerUnsafeReplayError,
  type WorkerEffectExecutionInput,
} from "./effects.js";
import { createWorkerRuntimeRepository } from "./runtime/repository.js";
import type { WorkerRuntimeToolResult } from "./runtime/ports.js";

test("completed mutating effects replay their receipt without a second external call", async () => {
  const harness = await effectHarness();
  let externalCalls = 0;
  const input = effectInput(harness, {
    classification: "non_replayable_mutation",
    execute: async () => {
      externalCalls += 1;
      return toolResult({ output: { token: "do-not-store-me", ok: true } });
    },
  });

  const first = await harness.coordinator.execute(input);
  const replay = await harness.coordinator.execute(input);

  assert.equal(externalCalls, 1);
  assert.equal(first.effectReceiptId, replay.effectReceiptId);
  assert.equal(harness.data.workerEffectReceipts.length, 1);
  assert.equal(harness.data.workerEffectReceipts[0].status, "completed");
  assert.doesNotMatch(JSON.stringify(harness.data.workerEffectReceipts[0]), /do-not-store-me/);
});

test("a crash after a non-replayable effect quarantines replay instead of duplicating it", async () => {
  const harness = await effectHarness({
    interruptAfterExternal: true,
  });
  let externalCalls = 0;
  const input = effectInput(harness, {
    classification: "non_replayable_mutation",
    execute: async () => {
      externalCalls += 1;
      return toolResult();
    },
  });

  await assert.rejects(harness.coordinator.execute(input), WorkerEffectInterruptionError);
  assert.equal(harness.data.workerEffectReceipts[0].status, "prepared");

  const restarted = createWorkerEffectCoordinator({
    repository: harness.effectRepository,
  });
  await assert.rejects(restarted.execute(input), WorkerUnsafeReplayError);
  assert.equal(externalCalls, 1);
});

test("an idempotent prepared effect retries with the same effect key and completes once", async () => {
  const harness = await effectHarness({
    interruptAfterExternal: true,
  });
  const committedKeys = new Set<string>();
  let attempts = 0;
  const input = effectInput(harness, {
    classification: "idempotent_mutation",
    execute: async (effectKey) => {
      attempts += 1;
      assert.ok(effectKey);
      committedKeys.add(effectKey);
      return toolResult();
    },
  });

  await assert.rejects(harness.coordinator.execute(input), WorkerEffectInterruptionError);
  const restarted = createWorkerEffectCoordinator({
    repository: harness.effectRepository,
  });
  const completed = await restarted.execute(input);
  const replay = await restarted.execute(input);

  assert.equal(attempts, 2);
  assert.equal(committedKeys.size, 1);
  assert.equal(completed.effectReceiptId, replay.effectReceiptId);
  assert.equal(harness.data.workerEffectReceipts[0].status, "completed");
});

test("a reconcilable prepared effect records a proven external completion", async () => {
  const harness = await effectHarness({
    interruptAfterExternal: true,
  });
  const externallyCommitted = new Set<string>();
  let attempts = 0;
  const input = effectInput(harness, {
    classification: "reconcilable_mutation",
    execute: async (effectKey) => {
      attempts += 1;
      assert.ok(effectKey);
      externallyCommitted.add(effectKey);
      return toolResult();
    },
    reconcile: async (effectKey) =>
      externallyCommitted.has(effectKey)
        ? { disposition: "completed", result: toolResult() }
        : { disposition: "absent" },
  });

  await assert.rejects(harness.coordinator.execute(input), WorkerEffectInterruptionError);
  const restarted = createWorkerEffectCoordinator({
    repository: harness.effectRepository,
  });
  await restarted.execute(input);

  assert.equal(attempts, 1);
  assert.equal(harness.data.workerEffectReceipts[0].status, "completed");
});

interface EffectHarness {
  readonly coordinator: ReturnType<typeof createWorkerEffectCoordinator>;
  readonly effectRepository: ReturnType<typeof createWorkerEffectRepository>;
  readonly workspaceId: string;
  readonly workerRunId: string;
  readonly workerVersionId: string;
  readonly workerDeploymentId: string;
  readonly fencingToken: number;
  readonly data: PacketAgentData;
}

async function effectHarness(
  options: { readonly interruptAfterExternal?: boolean } = {},
): Promise<EffectHarness> {
  let data = createSeedStore();
  data.workerDefinitions.push(
    makeWorkerDefinition({
      status: "active",
      currentVersionId: "worker-version-1",
    }),
  );
  data.workerVersions.push(
    makeWorkerVersion({
      status: "validated",
      validatedAt: TEST_NOW,
    }),
  );
  data.workerDeployments.push(
    makeWorkerDeployment({
      status: "active",
      activatedAt: TEST_NOW,
    }),
  );
  data.workerRuns.push(makeWorkerRun());
  const store = {
    loadStore: () => data,
    mutateStore: async <T>(mutation: (draft: PacketAgentData) => T | Promise<T>): Promise<T> => {
      const draft = structuredClone(data);
      const result = await mutation(draft);
      data = draft;
      return result;
    },
  };
  let nextId = 0;
  const now = () => new Date(TEST_NOW);
  const runtime = createWorkerRuntimeRepository({
    ...store,
    now,
    id: (kind) => `${kind}-${++nextId}`,
  });
  const acquisition = await runtime.acquire({
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    ownerId: "effect-test",
    now: now(),
  });
  assert.equal(acquisition.disposition, "acquired");
  if (acquisition.disposition !== "acquired") {
    throw new Error("effect test failed to acquire its run");
  }
  const effectRepository = createWorkerEffectRepository({
    ...store,
    now,
    id: (kind) => `${kind}-${++nextId}`,
  });
  const coordinator = createWorkerEffectCoordinator({
    repository: effectRepository,
    ...(options.interruptAfterExternal
      ? {
          onPhase(phase) {
            if (phase === "after_external_effect") {
              throw new WorkerEffectInterruptionError(phase);
            }
          },
        }
      : {}),
  });
  return {
    coordinator,
    effectRepository,
    workspaceId: acquisition.context.run.workspaceId,
    workerRunId: acquisition.context.run.id,
    workerVersionId: acquisition.context.run.workerVersionId,
    workerDeploymentId: acquisition.context.run.workerDeploymentId,
    fencingToken: acquisition.lease.fencingToken,
    get data() {
      return data;
    },
  };
}

function effectInput(
  harness: EffectHarness,
  overrides: Pick<WorkerEffectExecutionInput, "classification" | "execute"> &
    Partial<Pick<WorkerEffectExecutionInput, "reconcile">>,
): WorkerEffectExecutionInput {
  return {
    workspaceId: harness.workspaceId,
    workerRunId: harness.workerRunId,
    workerVersionId: harness.workerVersionId,
    workerDeploymentId: harness.workerDeploymentId,
    fencingToken: harness.fencingToken,
    iteration: 1,
    capabilityId: "release-read",
    call: {
      id: "effect-action-1",
      name: "http_fetch",
      input: {
        url: "https://example.test/releases",
        authorization: "Bearer do-not-store-me",
      },
    },
    operation: "http.post",
    ...overrides,
  };
}

function toolResult(overrides: Partial<WorkerRuntimeToolResult> = {}): WorkerRuntimeToolResult {
  return {
    callId: "effect-action-1",
    toolName: "http_fetch",
    status: "ok",
    output: { ok: true },
    durationMs: 1,
    startedAt: TEST_NOW,
    completedAt: TEST_NOW,
    ...overrides,
  };
}
