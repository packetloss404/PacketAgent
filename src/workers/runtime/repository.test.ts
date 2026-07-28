import assert from "node:assert/strict";
import test from "node:test";
import { createSeedStore, type JobRecord, type PacketAgentData } from "../../packetagent-store.js";
import { WorkerLifecycleError } from "../errors.js";
import {
  makeWorkerDefinition,
  makeWorkerDeployment,
  makeWorkerRun,
  makeWorkerVersion,
  TEST_NOW,
} from "../__tests__/fixtures.js";
import { createWorkerRuntimeRepository } from "./repository.js";
import { createWorkerExecutionJobHandler } from "./job-handler.js";
import { createSystemWorkerClock } from "./adapters.js";

test("runtime repository fences leases and run revisions atomically", async () => {
  const harness = repositoryHarness();
  const first = await harness.repository.acquire({
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    ownerId: "owner-a",
    now: new Date(TEST_NOW),
  });
  assert.equal(first.disposition, "acquired");
  if (first.disposition !== "acquired") return;
  assert.equal(first.context.run.status, "running");
  assert.equal(first.context.run.revision, 2);
  assert.equal(first.lease.fencingToken, 1);

  const competing = await harness.repository.acquire({
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    ownerId: "owner-b",
    now: new Date("2026-07-27T12:00:01.000Z"),
  });
  assert.equal(competing.disposition, "busy");

  await assert.rejects(
    harness.repository.save({
      workspaceId: "workspace-1",
      workerRunId: "run-1",
      workerVersionId: "worker-version-1",
      expectedRunRevision: 1,
      fencingToken: first.lease.fencingToken,
      cursor: { phase: "checkpoint", iteration: 1, actionIndex: 0 },
      budgetUsage: {
        elapsedMs: 10,
        iterations: 1,
        providerCostUsd: 0.01,
        consecutiveFailures: 0,
        toolCalls: 0,
      },
      workingMemory: {},
    }),
    (error: unknown) => error instanceof WorkerLifecycleError && error.code === "conflict",
  );

  const checkpoint = await harness.repository.save({
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    workerVersionId: "worker-version-1",
    expectedRunRevision: 2,
    fencingToken: first.lease.fencingToken,
    cursor: { phase: "checkpoint", iteration: 1, actionIndex: 0 },
    budgetUsage: {
      elapsedMs: 10,
      iterations: 1,
      providerCostUsd: 0.01,
      consecutiveFailures: 0,
      toolCalls: 0,
    },
    workingMemory: {},
  });
  assert.equal(checkpoint.runRevision, 3);

  const terminal = await harness.repository.finalize({
    context: first.context,
    finalization: {
      expectedRunRevision: checkpoint.runRevision,
      fencingToken: first.lease.fencingToken,
      status: "completed",
      terminalReason: "objective_satisfied",
      budgetUsage: {
        elapsedMs: 12,
        iterations: 1,
        providerCostUsd: 0.01,
        consecutiveFailures: 0,
        toolCalls: 0,
      },
      output: "ready",
    },
    now: new Date("2026-07-27T12:00:02.000Z"),
  });
  assert.equal(terminal.revision, 4);
  assert.equal(terminal.runtimeLease, undefined);
  assert.equal(harness.data.workerCheckpoints.length, 1);
  assert.equal(
    harness.data.workerEvents.some((event) => event.type === "worker.run.terminal"),
    true,
  );
});

test("expired lease takeover increments the fence and rejects stale writers", async () => {
  const harness = repositoryHarness({ leaseDurationMs: 1_000 });
  const first = await harness.repository.acquire({
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    ownerId: "owner-a",
    now: new Date(TEST_NOW),
  });
  assert.equal(first.disposition, "acquired");
  if (first.disposition !== "acquired") return;

  const second = await harness.repository.acquire({
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    ownerId: "owner-b",
    now: new Date("2026-07-27T12:00:02.000Z"),
  });
  assert.equal(second.disposition, "acquired");
  if (second.disposition !== "acquired") return;
  assert.equal(second.lease.fencingToken, 2);
  assert.equal(second.context.run.revision, 3);

  await assert.rejects(
    harness.repository.append({
      context: first.context,
      fencingToken: first.lease.fencingToken,
      event: {
        type: "worker.stale.write",
        phase: "act",
        cursor: { phase: "act", iteration: 1, actionIndex: 0 },
        summary: "This event must not commit.",
      },
    }),
    (error: unknown) => error instanceof WorkerLifecycleError && error.code === "conflict",
  );
  assert.equal(
    harness.data.workerEvents.some((event) => event.type === "worker.stale.write"),
    false,
  );
});

test("released work retains its fence before the next owner acquires", async () => {
  const harness = repositoryHarness();
  const first = await harness.repository.acquire({
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    ownerId: "owner-a",
    now: new Date(TEST_NOW),
  });
  assert.equal(first.disposition, "acquired");
  if (first.disposition !== "acquired") return;
  await harness.repository.release({
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    lease: first.lease,
    now: new Date("2026-07-27T12:00:01.000Z"),
  });
  assert.equal(harness.data.workerRuns[0].runtimeFence, 1);
  assert.equal(harness.data.workerRuns[0].runtimeLease, undefined);

  const second = await harness.repository.acquire({
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    ownerId: "owner-b",
    now: new Date("2026-07-27T12:00:02.000Z"),
  });
  assert.equal(second.disposition, "acquired");
  if (second.disposition !== "acquired") return;
  assert.equal(second.lease.fencingToken, 2);
  assert.equal(second.context.run.revision, 4);
});

test("worker.run job handler executes the canonical supervisor and persists terminal state", async () => {
  const clock = createSystemWorkerClock();
  const harness = repositoryHarness({ now: () => clock.now() });
  const handler = createWorkerExecutionJobHandler({
    repository: harness.repository,
    ports: {
      clock,
      provider: {
        async call(request) {
          return {
            content:
              request.phase === "evaluate"
                ? '{"predicateId":"release-decision","matched":true,"evidence":"done"}'
                : "ready",
            toolCalls: [],
            finishReason: "stop",
            usage: {
              promptTokens: 1,
              completionTokens: 1,
              costUsd: 0.01,
            },
            model: "test-model",
            provider: "test-provider",
          };
        },
      },
      tools: {
        definitions: () => [],
        async execute() {
          throw new Error("no tool should execute");
        },
      },
    },
    ownerId: () => "job-owner",
  });
  const timestamp = clock.now().toISOString();
  const job: JobRecord = {
    id: "job-worker-run",
    workspaceId: "workspace-1",
    type: "worker.run",
    payload: {
      workerRunId: "run-1",
      workerDeploymentId: "deployment-1",
      workerVersionId: "worker-version-1",
      activationInboxId: "inbox-1",
    },
    status: "running",
    attempts: 1,
    maxAttempts: 3,
    scheduledAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
  };

  const result = (await handler.handle(job, {
    signal: new AbortController().signal,
  })) as { status: string; terminalReason: string };

  assert.equal(result.status, "completed");
  assert.equal(result.terminalReason, "objective_satisfied");
  assert.equal(harness.data.workerRuns[0].status, "completed");
  assert.equal(harness.data.workerCheckpoints.length, 1);
});

function repositoryHarness(options: { leaseDurationMs?: number; now?: () => Date } = {}) {
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
  let nextId = 0;
  const repository = createWorkerRuntimeRepository({
    loadStore: () => data,
    mutateStore: async <T>(mutation: (draft: PacketAgentData) => T | Promise<T>) => {
      const draft = structuredClone(data);
      const result = await mutation(draft);
      data = draft;
      return result;
    },
    id: (kind) => `${kind}-${++nextId}`,
    now: options.now ?? (() => new Date(TEST_NOW)),
    ...(options.leaseDurationMs ? { leaseDurationMs: options.leaseDurationMs } : {}),
  });
  return {
    repository,
    get data() {
      return data;
    },
  };
}
