import assert from "node:assert/strict";
import test from "node:test";
import {
  METRICS_SNAPSHOT_JOB_TYPE,
  ensureMetricsSnapshotCronJob,
  handleMetricsSnapshotJob,
  type MetricsSnapshotHandlerDeps,
} from "./metrics-snapshot-handler.js";
import type { EnqueueJobInput } from "./store.js";
import type { JobRecord, PacketAgentData } from "../packetagent-store.js";
import { nextAfter } from "./cron.js";

function makeStore(jobs: JobRecord[] = []): PacketAgentData {
  return { jobs: [...jobs] } as unknown as PacketAgentData;
}

function makeJob(overrides: Partial<JobRecord> & { id: string; type: string; status: JobRecord["status"] }): JobRecord {
  return {
    id: overrides.id,
    workspaceId: overrides.workspaceId ?? "__system__",
    type: overrides.type,
    payload: overrides.payload ?? {},
    status: overrides.status,
    attempts: overrides.attempts ?? 0,
    maxAttempts: overrides.maxAttempts ?? 3,
    scheduledAt: overrides.scheduledAt ?? "2026-04-26T12:00:00.000Z",
    createdAt: overrides.createdAt ?? "2026-04-26T12:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-26T12:00:00.000Z",
    ...(overrides.cron ? { cron: overrides.cron } : {}),
  };
}

function makeSnapshotStub(): {
  deps: MetricsSnapshotHandlerDeps;
  calls: Array<{ retentionDays?: number }>;
} {
  const calls: Array<{ retentionDays?: number }> = [];
  const deps: MetricsSnapshotHandlerDeps = {
    snapshot: (options) => {
      calls.push({ retentionDays: options?.retentionDays });
      return {
        command: "snapshot-job-metrics",
        capturedAt: "2026-04-26T12:00:00.000Z",
        snapshots: [
          {
            id: "snap_a",
            capturedAt: "2026-04-26T12:00:00.000Z",
            type: "scheduler.tick",
            totalRuns: 1,
            succeededRuns: 1,
            failedRuns: 0,
            canceledRuns: 0,
            lastRunStartedAt: null,
            lastRunFinishedAt: null,
            lastDurationMs: null,
            averageDurationMs: null,
            p95DurationMs: null,
          },
          {
            id: "snap_b",
            capturedAt: "2026-04-26T12:00:00.000Z",
            type: "metrics.snapshot",
            totalRuns: 0,
            succeededRuns: 0,
            failedRuns: 0,
            canceledRuns: 0,
            lastRunStartedAt: null,
            lastRunFinishedAt: null,
            lastDurationMs: null,
            averageDurationMs: null,
            p95DurationMs: null,
          },
        ],
        removed: 3,
      };
    },
  };
  return { deps, calls };
}

function captureWarn(): { restore: () => void; calls: unknown[][] } {
  const original = console.warn;
  const calls: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    calls.push(args);
  };
  return {
    restore: () => {
      console.warn = original;
    },
    calls,
  };
}

test("handleMetricsSnapshotJob with valid retentionDays calls snapshot and returns mapped result", async () => {
  const { deps, calls } = makeSnapshotStub();
  const result = await handleMetricsSnapshotJob({ retentionDays: 14 }, deps);
  assert.deepEqual(calls, [{ retentionDays: 14 }]);
  assert.deepEqual(result, {
    snapshotCount: 2,
    removed: 3,
    capturedAt: "2026-04-26T12:00:00.000Z",
  });
});

test("handleMetricsSnapshotJob with no payload defaults retentionDays to 30", async () => {
  const { deps, calls } = makeSnapshotStub();
  const result = await handleMetricsSnapshotJob({}, deps);
  assert.deepEqual(calls, [{ retentionDays: 30 }]);
  assert.equal(result.snapshotCount, 2);
});

test("handleMetricsSnapshotJob throws when retentionDays is negative", async () => {
  const { deps } = makeSnapshotStub();
  await assert.rejects(
    () => handleMetricsSnapshotJob({ retentionDays: -1 }, deps),
    /retentionDays must be a non-negative integer/,
  );
});

test("handleMetricsSnapshotJob throws when retentionDays is non-integer", async () => {
  const { deps } = makeSnapshotStub();
  await assert.rejects(
    () => handleMetricsSnapshotJob({ retentionDays: 1.5 }, deps),
    /retentionDays must be a non-negative integer/,
  );
});

test("handleMetricsSnapshotJob throws when retentionDays is not a number", async () => {
  const { deps } = makeSnapshotStub();
  await assert.rejects(
    () => handleMetricsSnapshotJob({ retentionDays: "30" as unknown as number }, deps),
    /retentionDays must be a non-negative integer/,
  );
});

test("ensureMetricsSnapshotCronJob returns skipped when cron env is unset", () => {
  const enqueueCalls: EnqueueJobInput[] = [];
  const result = ensureMetricsSnapshotCronJob({
    env: {},
    loadStore: () => makeStore(),
    enqueue: (input) => {
      enqueueCalls.push(input);
      return makeJob({ id: "should-not-happen", type: input.type, status: "queued" });
    },
  });
  assert.deepEqual(result, { action: "skipped" });
  assert.equal(enqueueCalls.length, 0);
});

test("ensureMetricsSnapshotCronJob returns skipped and warns when cron is invalid", () => {
  const warn = captureWarn();
  try {
    const enqueueCalls: EnqueueJobInput[] = [];
    const result = ensureMetricsSnapshotCronJob({
      env: { PACKETAGENT_JOB_METRICS_SNAPSHOT_CRON: "this is not cron" },
      loadStore: () => makeStore(),
      enqueue: (input) => {
        enqueueCalls.push(input);
        return makeJob({ id: "x", type: input.type, status: "queued" });
      },
    });
    assert.deepEqual(result, { action: "skipped" });
    assert.equal(enqueueCalls.length, 0);
    assert.equal(warn.calls.length, 1);
    const message = String(warn.calls[0][0]);
    assert.ok(message.includes("metrics.snapshot"), `expected warning to mention metrics.snapshot, got: ${message}`);
  } finally {
    warn.restore();
  }
});

test("ensureMetricsSnapshotCronJob returns exists when an active recurring job is present", () => {
  const cron = "0 * * * *";
  const existing = makeJob({
    id: "existing-1",
    type: METRICS_SNAPSHOT_JOB_TYPE,
    status: "queued",
    cron,
  });
  const enqueueCalls: EnqueueJobInput[] = [];
  const result = ensureMetricsSnapshotCronJob({
    env: { PACKETAGENT_JOB_METRICS_SNAPSHOT_CRON: cron },
    loadStore: () => makeStore([existing]),
    enqueue: (input) => {
      enqueueCalls.push(input);
      return makeJob({ id: "new", type: input.type, status: "queued" });
    },
  });
  assert.deepEqual(result, { action: "exists", jobId: "existing-1" });
  assert.equal(enqueueCalls.length, 0);
});

test("ensureMetricsSnapshotCronJob ignores failed/canceled jobs and enqueues a fresh one", () => {
  const cron = "0 * * * *";
  const stale = [
    makeJob({ id: "failed-1", type: METRICS_SNAPSHOT_JOB_TYPE, status: "failed", cron }),
    makeJob({ id: "canceled-1", type: METRICS_SNAPSHOT_JOB_TYPE, status: "canceled", cron }),
  ];
  const enqueueCalls: EnqueueJobInput[] = [];
  const result = ensureMetricsSnapshotCronJob({
    env: { PACKETAGENT_JOB_METRICS_SNAPSHOT_CRON: cron },
    loadStore: () => makeStore(stale),
    enqueue: (input) => {
      enqueueCalls.push(input);
      return makeJob({ id: "new-1", type: input.type, status: "queued", cron: input.cron });
    },
  });
  assert.equal(result.action, "enqueued");
  assert.equal(result.jobId, "new-1");
  assert.equal(enqueueCalls.length, 1);
});

test("ensureMetricsSnapshotCronJob enqueues with default workspaceId, retentionDays, and computed scheduledAt", () => {
  const cron = "0 * * * *";
  const enqueueCalls: EnqueueJobInput[] = [];
  const before = new Date();
  const result = ensureMetricsSnapshotCronJob({
    env: { PACKETAGENT_JOB_METRICS_SNAPSHOT_CRON: cron },
    loadStore: () => makeStore(),
    enqueue: (input) => {
      enqueueCalls.push(input);
      return makeJob({ id: "new-2", type: input.type, status: "queued", cron: input.cron });
    },
  });
  assert.deepEqual(result, { action: "enqueued", jobId: "new-2" });
  assert.equal(enqueueCalls.length, 1);
  const call = enqueueCalls[0];
  assert.equal(call.type, METRICS_SNAPSHOT_JOB_TYPE);
  assert.equal(call.cron, cron);
  assert.equal(call.workspaceId, "__system__");
  assert.deepEqual(call.payload, { retentionDays: 30 });
  assert.ok(call.scheduledAt, "scheduledAt should be set");
  const scheduledMs = Date.parse(call.scheduledAt!);
  const expectedAtLeast = nextAfter(cron, before).getTime();
  assert.ok(scheduledMs >= expectedAtLeast, `scheduledAt ${call.scheduledAt} should be >= ${new Date(expectedAtLeast).toISOString()}`);
  assert.ok(scheduledMs > Date.now(), "scheduledAt should be in the future");
});

test("ensureMetricsSnapshotCronJob honors custom workspaceId env override", () => {
  const cron = "0 * * * *";
  const enqueueCalls: EnqueueJobInput[] = [];
  ensureMetricsSnapshotCronJob({
    env: {
      PACKETAGENT_JOB_METRICS_SNAPSHOT_CRON: cron,
      PACKETAGENT_JOB_METRICS_SNAPSHOT_WORKSPACE_ID: "ops-workspace",
    },
    loadStore: () => makeStore(),
    enqueue: (input) => {
      enqueueCalls.push(input);
      return makeJob({ id: "new-3", type: input.type, status: "queued", cron: input.cron });
    },
  });
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].workspaceId, "ops-workspace");
});

test("ensureMetricsSnapshotCronJob honors valid custom retentionDays env override", () => {
  const cron = "0 * * * *";
  const enqueueCalls: EnqueueJobInput[] = [];
  ensureMetricsSnapshotCronJob({
    env: {
      PACKETAGENT_JOB_METRICS_SNAPSHOT_CRON: cron,
      PACKETAGENT_JOB_METRICS_SNAPSHOT_RETENTION_DAYS: "7",
    },
    loadStore: () => makeStore(),
    enqueue: (input) => {
      enqueueCalls.push(input);
      return makeJob({ id: "new-4", type: input.type, status: "queued", cron: input.cron });
    },
  });
  assert.equal(enqueueCalls.length, 1);
  assert.deepEqual(enqueueCalls[0].payload, { retentionDays: 7 });
});

test("ensureMetricsSnapshotCronJob falls back to default retentionDays when env value is invalid", () => {
  const cron = "0 * * * *";
  const cases = ["", "-1", "abc", "1.5"];
  for (const value of cases) {
    const enqueueCalls: EnqueueJobInput[] = [];
    ensureMetricsSnapshotCronJob({
      env: {
        PACKETAGENT_JOB_METRICS_SNAPSHOT_CRON: cron,
        PACKETAGENT_JOB_METRICS_SNAPSHOT_RETENTION_DAYS: value,
      },
      loadStore: () => makeStore(),
      enqueue: (input) => {
        enqueueCalls.push(input);
        return makeJob({ id: "new-fallback", type: input.type, status: "queued", cron: input.cron });
      },
    });
    assert.equal(enqueueCalls.length, 1, `expected enqueue for value=${JSON.stringify(value)}`);
    assert.deepEqual(enqueueCalls[0].payload, { retentionDays: 30 }, `expected fallback for value=${JSON.stringify(value)}`);
  }
});

test("ensureMetricsSnapshotCronJob accepts retentionDays=0 from env", () => {
  const cron = "0 * * * *";
  const enqueueCalls: EnqueueJobInput[] = [];
  ensureMetricsSnapshotCronJob({
    env: {
      PACKETAGENT_JOB_METRICS_SNAPSHOT_CRON: cron,
      PACKETAGENT_JOB_METRICS_SNAPSHOT_RETENTION_DAYS: "0",
    },
    loadStore: () => makeStore(),
    enqueue: (input) => {
      enqueueCalls.push(input);
      return makeJob({ id: "zero", type: input.type, status: "queued", cron: input.cron });
    },
  });
  assert.equal(enqueueCalls.length, 1);
  assert.deepEqual(enqueueCalls[0].payload, { retentionDays: 0 });
});
