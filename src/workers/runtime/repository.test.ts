import assert from "node:assert/strict";
import test from "node:test";
import { createSeedStore, type JobRecord, type PacketAgentData } from "../../packetagent-store.js";
import { JobReleasedError } from "../../jobs/scheduler.js";
import { WorkerLifecycleError } from "../errors.js";
import {
  makeWorkerDefinition,
  makeWorkerDeployment,
  makeWorkerRun,
  makeWorkerVersion,
  makeWorkerVersionContent,
  TEST_NOW,
} from "../__tests__/fixtures.js";
import { createPermissiveWorkerBudgetPort } from "../__tests__/budget-port.js";
import type { WorkerVersion } from "../types.js";
import { createWorkerRuntimeRepository } from "./repository.js";
import { createWorkerExecutionJobHandler } from "./job-handler.js";
import { createSystemWorkerClock } from "./adapters.js";
import { createVirtualWorkerClock } from "./__tests__/virtual-clock.js";

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
      expectedCheckpointSequence: -1,
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
      completedActionIds: [],
      pendingApprovalIds: [],
      artifactRefs: [],
      effectReceiptIds: [],
    }),
    (error: unknown) => error instanceof WorkerLifecycleError && error.code === "conflict",
  );

  const checkpoint = await harness.repository.save({
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    workerVersionId: "worker-version-1",
    expectedRunRevision: 2,
    expectedCheckpointSequence: -1,
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
    completedActionIds: [],
    pendingApprovalIds: [],
    artifactRefs: [],
    effectReceiptIds: [],
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
  const terminalOutbox = harness.data.workerNotificationDeliveries.find(
    (record) => record.event === "terminal" && record.workerRunId === terminal.id,
  );
  assert.ok(terminalOutbox);
  assert.ok(
    harness.data.jobs.some(
      (job) =>
        job.type === "worker.notification.deliver" &&
        job.payload.outboxItemId === terminalOutbox.id,
    ),
  );
});

test("runtime finalization observes an operator-terminalized run idempotently", async () => {
  const harness = repositoryHarness();
  const acquisition = await harness.repository.acquire({
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    ownerId: "operator-race-owner",
    now: new Date(TEST_NOW),
  });
  assert.equal(acquisition.disposition, "acquired");
  if (acquisition.disposition !== "acquired") return;

  const current = harness.data.workerRuns[0];
  const { runtimeLease: _lease, ...withoutLease } = current;
  harness.data.workerRuns[0] = {
    ...withoutLease,
    status: "cancelled",
    revision: current.revision + 1,
    terminalReason: "operator_cancelled",
    updatedAt: "2026-07-27T12:00:01.000Z",
    completedAt: "2026-07-27T12:00:01.000Z",
  };
  const eventCount = harness.data.workerEvents.length;

  const observed = await harness.repository.finalize({
    context: acquisition.context,
    finalization: {
      expectedRunRevision: acquisition.context.run.revision,
      fencingToken: acquisition.lease.fencingToken,
      status: "cancelled",
      terminalReason: "operator_cancelled",
      budgetUsage: acquisition.context.run.budgetUsage,
    },
    now: new Date("2026-07-27T12:00:02.000Z"),
  });

  assert.equal(observed.status, "cancelled");
  assert.equal(observed.revision, current.revision + 1);
  assert.equal(observed.runtimeLease, undefined);
  assert.equal(harness.data.workerEvents.length, eventCount);
});

test("checkpoint append enforces expected sequence, digest chaining, and monotonic budgets", async () => {
  const harness = repositoryHarness();
  const acquisition = await harness.repository.acquire({
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    ownerId: "checkpoint-owner",
    now: new Date(TEST_NOW),
  });
  assert.equal(acquisition.disposition, "acquired");
  if (acquisition.disposition !== "acquired") return;
  const write = {
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    workerVersionId: "worker-version-1",
    fencingToken: acquisition.lease.fencingToken,
    cursor: { phase: "plan", iteration: 1, actionIndex: 0 } as const,
    workingMemory: {},
    completedActionIds: [] as string[],
    pendingApprovalIds: [] as string[],
    artifactRefs: [] as string[],
    effectReceiptIds: [] as string[],
  };
  const first = await harness.repository.save({
    ...write,
    expectedRunRevision: acquisition.context.run.revision,
    expectedCheckpointSequence: -1,
    budgetUsage: {
      elapsedMs: 10,
      iterations: 1,
      providerCostUsd: 0.2,
      consecutiveFailures: 0,
      toolCalls: 0,
    },
  });
  await assert.rejects(
    harness.repository.save({
      ...write,
      expectedRunRevision: first.runRevision,
      expectedCheckpointSequence: -1,
      budgetUsage: {
        elapsedMs: 11,
        iterations: 1,
        providerCostUsd: 0.3,
        consecutiveFailures: 0,
        toolCalls: 0,
      },
    }),
    (error: unknown) => error instanceof WorkerLifecycleError && error.code === "conflict",
  );
  await assert.rejects(
    harness.repository.save({
      ...write,
      expectedRunRevision: first.runRevision,
      expectedCheckpointSequence: first.checkpointSequence,
      budgetUsage: {
        elapsedMs: 11,
        iterations: 1,
        providerCostUsd: 0.1,
        consecutiveFailures: 0,
        toolCalls: 0,
      },
    }),
    (error: unknown) => error instanceof WorkerLifecycleError && error.code === "integrity",
  );
  const second = await harness.repository.save({
    ...write,
    expectedRunRevision: first.runRevision,
    expectedCheckpointSequence: first.checkpointSequence,
    budgetUsage: {
      elapsedMs: 11,
      iterations: 1,
      providerCostUsd: 0.3,
      consecutiveFailures: 0,
      toolCalls: 0,
    },
  });

  assert.equal(second.checkpointSequence, 1);
  assert.equal(
    harness.data.workerCheckpoints[1].previousCheckpointId,
    harness.data.workerCheckpoints[0].id,
  );
  assert.match(harness.data.workerCheckpoints[1].stateDigest, /^sha256:[a-f0-9]{64}$/);
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

test("worker.run job handler consumes paused work without starting a supervisor", async () => {
  const harness = repositoryHarness();
  harness.data.workerRuns[0] = makeWorkerRun({
    status: "paused",
    revision: 2,
    startedAt: TEST_NOW,
    updatedAt: TEST_NOW,
  });
  const handler = createWorkerExecutionJobHandler({
    repository: harness.repository,
    ownerId: () => "paused-job-owner",
  });
  const job: JobRecord = {
    id: "job-paused",
    workspaceId: "workspace-1",
    type: "worker.run",
    payload: {
      workerRunId: "run-1",
      workerDeploymentId: "deployment-1",
      workerVersionId: "worker-version-1",
    },
    status: "running",
    attempts: 1,
    maxAttempts: 2,
    scheduledAt: TEST_NOW,
    startedAt: TEST_NOW,
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
  };

  const result = (await handler.handle(job, {
    signal: new AbortController().signal,
  })) as { status: string; pausedExecution: boolean };

  assert.equal(result.status, "paused");
  assert.equal(result.pausedExecution, true);
  assert.equal(harness.data.workerRuns[0].status, "paused");
  assert.equal(harness.data.workerRuns[0].runtimeLease, undefined);
});

test("worker.run job handler executes the canonical supervisor and persists terminal state", async () => {
  const clock = createSystemWorkerClock();
  const harness = repositoryHarness({ now: () => clock.now() });
  const handler = createWorkerExecutionJobHandler({
    repository: harness.repository,
    budgets: createPermissiveWorkerBudgetPort(),
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
        async authorize() {
          throw new Error("no tool should authorize");
        },
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
  assert.equal(harness.data.workerCheckpoints.length, 3);
});

test("lease renewal advances the run ledger monotonically without a checkpoint", async () => {
  const harness = repositoryHarness();
  const first = await harness.repository.acquire({
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    ownerId: "owner-a",
    now: new Date(TEST_NOW),
  });
  assert.equal(first.disposition, "acquired");
  if (first.disposition !== "acquired") return;

  const renewed = await harness.repository.renew({
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    lease: first.lease,
    now: new Date("2026-07-27T12:00:05.000Z"),
    budgetUsage: {
      elapsedMs: 5_000,
      iterations: 1,
      providerCostUsd: 0.05,
      consecutiveFailures: 1,
      toolCalls: 0,
    },
  });
  assert.ok(renewed);
  assert.equal(harness.data.workerRuns[0].revision, first.context.run.revision);
  assert.deepEqual(harness.data.workerRuns[0].budgetUsage, {
    elapsedMs: 5_000,
    iterations: 1,
    providerCostUsd: 0.05,
    consecutiveFailures: 1,
    toolCalls: 0,
  });

  // A lower snapshot never regresses the ledger.
  await harness.repository.renew({
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    lease: renewed,
    now: new Date("2026-07-27T12:00:06.000Z"),
    budgetUsage: {
      elapsedMs: 1_000,
      iterations: 0,
      providerCostUsd: 0,
      consecutiveFailures: 0,
      toolCalls: 0,
    },
  });
  assert.equal(harness.data.workerRuns[0].budgetUsage.elapsedMs, 5_000);
  assert.equal(harness.data.workerRuns[0].budgetUsage.iterations, 1);

  // A stale owner cannot renew or write usage.
  const stale = await harness.repository.renew({
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    lease: { ...renewed, ownerId: "owner-b" },
    now: new Date("2026-07-27T12:00:07.000Z"),
    budgetUsage: {
      elapsedMs: 99_000,
      iterations: 5,
      providerCostUsd: 1,
      consecutiveFailures: 0,
      toolCalls: 0,
    },
  });
  assert.equal(stale, null);
  assert.equal(harness.data.workerRuns[0].budgetUsage.elapsedMs, 5_000);
  assert.equal(harness.data.workerCheckpoints.length, 0);
});

test("worker.run job handler converges when the lease is stolen during every long operation", async () => {
  const clock = createVirtualWorkerClock();
  const baseContent = makeWorkerVersionContent();
  const harness = repositoryHarness({
    now: () => clock.now(),
    version: makeWorkerVersion({
      status: "validated",
      validatedAt: TEST_NOW,
      content: makeWorkerVersionContent({
        policy: {
          ...baseContent.policy,
          budgets: { ...baseContent.policy.budgets, maxElapsedMs: 50_000 },
        },
      }),
    }),
  });
  let providerCalls = 0;
  const stealLease = (): void => {
    const run = harness.data.workerRuns[0];
    assert.ok(run.runtimeLease);
    const at = clock.now();
    harness.data.workerRuns[0] = {
      ...run,
      runtimeFence: run.runtimeLease.fencingToken + 1,
      runtimeLease: {
        ownerId: "competing-supervisor",
        fencingToken: run.runtimeLease.fencingToken + 1,
        acquiredAt: at.toISOString(),
        renewedAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + 1_000).toISOString(),
      },
    };
  };
  const handler = createWorkerExecutionJobHandler({
    repository: harness.repository,
    budgets: createPermissiveWorkerBudgetPort(),
    ports: {
      clock,
      provider: {
        async call(request) {
          providerCalls += 1;
          // Longer than the 30s lease: heartbeats at 10s and 20s must keep it alive.
          await clock.sleep(25_000, request.signal);
          stealLease();
          await clock.sleep(75_000, request.signal);
          return {
            content: "ready",
            toolCalls: [],
            finishReason: "stop",
            usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.01 },
            model: "test-model",
            provider: "test-provider",
          };
        },
      },
      tools: {
        definitions: () => [],
        async authorize() {
          throw new Error("no tool should authorize");
        },
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
    },
    status: "running",
    attempts: 1,
    maxAttempts: 3,
    scheduledAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
  };

  const releasedElapsed: number[] = [];
  let outcome: { status: string; terminalReason: string } | undefined;
  for (let attempt = 0; attempt < 10 && !outcome; attempt += 1) {
    try {
      outcome = (await handler.handle(job, { signal: new AbortController().signal })) as {
        status: string;
        terminalReason: string;
      };
    } catch (error) {
      assert.ok(error instanceof JobReleasedError, String(error));
      releasedElapsed.push(harness.data.workerRuns[0].budgetUsage.elapsedMs);
      assert.equal(harness.data.workerRuns[0].status, "running");
    }
  }

  assert.ok(outcome, "the run must reach a terminal outcome within a bounded number of attempts");
  assert.equal(outcome.status, "budget_exhausted");
  assert.equal(outcome.terminalReason, "elapsed_time");
  assert.equal(providerCalls, 3);
  assert.equal(releasedElapsed.length, 2);
  // Each released attempt left the ledger further along than it found it.
  assert.ok(releasedElapsed[0] >= 20_000, `first release recorded ${releasedElapsed[0]}`);
  assert.ok(releasedElapsed[1] >= 40_000, `second release recorded ${releasedElapsed[1]}`);
  assert.ok(releasedElapsed[1] > releasedElapsed[0]);
  const run = harness.data.workerRuns[0];
  assert.equal(run.status, "budget_exhausted");
  assert.equal(run.runtimeLease, undefined);
  assert.ok(run.budgetUsage.elapsedMs >= 50_000);
  assert.equal(run.budgetUsage.iterations, 1);
  // The resumed attempts restored an open iteration from the checkpoint rather than a fresh one.
  assert.ok(harness.data.workerCheckpoints.length >= 1);
  assert.equal(harness.data.workerCheckpoints[0].workingMemory.iterationOpen, true);
  assert.ok(
    harness.data.workerEvents.filter((event) => event.type === "worker.run.lease_acquired")
      .length === 3,
  );
});

function repositoryHarness(
  options: { leaseDurationMs?: number; now?: () => Date; version?: WorkerVersion } = {},
) {
  let data = createSeedStore();
  data.workerDefinitions.push(
    makeWorkerDefinition({
      status: "active",
      currentVersionId: "worker-version-1",
    }),
  );
  data.workerVersions.push(
    options.version ??
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
