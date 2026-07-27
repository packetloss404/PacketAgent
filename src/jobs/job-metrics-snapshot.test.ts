import assert from "node:assert/strict";
import test from "node:test";
import {
  listJobMetricSnapshots,
  pruneJobMetricSnapshots,
  snapshotJobMetrics,
} from "./job-metrics-snapshot.js";
import type { JobTypeMetrics } from "./scheduler-metrics.js";
import type { JobMetricSnapshotRecord, PacketAgentData } from "../packetagent-store.js";

function makeStore(snapshots: JobMetricSnapshotRecord[] = []): PacketAgentData {
  return { jobMetricSnapshots: [...snapshots] } as unknown as PacketAgentData;
}

function makeStoreDeps(data: PacketAgentData) {
  return {
    loadStore: () => data,
    mutateStore: <T,>(mutator: (target: PacketAgentData) => T) => mutator(data),
  };
}

function makeMetric(overrides: Partial<JobTypeMetrics> & { type: string }): JobTypeMetrics {
  return {
    type: overrides.type,
    totalRuns: overrides.totalRuns ?? 0,
    succeededRuns: overrides.succeededRuns ?? 0,
    failedRuns: overrides.failedRuns ?? 0,
    canceledRuns: overrides.canceledRuns ?? 0,
    lastRunStartedAt: overrides.lastRunStartedAt ?? null,
    lastRunFinishedAt: overrides.lastRunFinishedAt ?? null,
    lastDurationMs: overrides.lastDurationMs ?? null,
    averageDurationMs: overrides.averageDurationMs ?? null,
    p95DurationMs: overrides.p95DurationMs ?? null,
  };
}

function makeSnapshot(overrides: Partial<JobMetricSnapshotRecord> & { id: string; capturedAt: string; type: string }): JobMetricSnapshotRecord {
  return {
    id: overrides.id,
    capturedAt: overrides.capturedAt,
    type: overrides.type,
    totalRuns: overrides.totalRuns ?? 0,
    succeededRuns: overrides.succeededRuns ?? 0,
    failedRuns: overrides.failedRuns ?? 0,
    canceledRuns: overrides.canceledRuns ?? 0,
    lastRunStartedAt: overrides.lastRunStartedAt ?? null,
    lastRunFinishedAt: overrides.lastRunFinishedAt ?? null,
    lastDurationMs: overrides.lastDurationMs ?? null,
    averageDurationMs: overrides.averageDurationMs ?? null,
    p95DurationMs: overrides.p95DurationMs ?? null,
  };
}

test("snapshotJobMetrics writes one row per metric entry with expected fields", () => {
  const data = makeStore();
  const metrics: JobTypeMetrics[] = [
    makeMetric({
      type: "scheduler.tick",
      totalRuns: 4,
      succeededRuns: 3,
      failedRuns: 1,
      canceledRuns: 0,
      lastRunStartedAt: "2026-04-26T11:59:00.000Z",
      lastRunFinishedAt: "2026-04-26T11:59:01.000Z",
      lastDurationMs: 1000,
      averageDurationMs: 950,
      p95DurationMs: 1200,
    }),
    makeMetric({
      type: "invitation.reconcile",
      totalRuns: 2,
      succeededRuns: 2,
    }),
  ];
  let counter = 0;
  const ids = ["id_a", "id_b"];

  const result = snapshotJobMetrics(
    {},
    {
      ...makeStoreDeps(data),
      jobTypeMetrics: () => metrics,
      now: () => new Date("2026-04-26T12:00:00.000Z"),
      generateId: () => ids[counter++] ?? `id_${counter}`,
    },
  );

  assert.equal(result.command, "snapshot-job-metrics");
  assert.equal(result.capturedAt, "2026-04-26T12:00:00.000Z");
  assert.equal(result.removed, 0);
  assert.equal(data.jobMetricSnapshots.length, 2);

  const stored = data.jobMetricSnapshots;
  assert.deepEqual(stored[0], {
    id: "id_a",
    capturedAt: "2026-04-26T12:00:00.000Z",
    type: "scheduler.tick",
    totalRuns: 4,
    succeededRuns: 3,
    failedRuns: 1,
    canceledRuns: 0,
    lastRunStartedAt: "2026-04-26T11:59:00.000Z",
    lastRunFinishedAt: "2026-04-26T11:59:01.000Z",
    lastDurationMs: 1000,
    averageDurationMs: 950,
    p95DurationMs: 1200,
  });
  assert.equal(stored[1].type, "invitation.reconcile");
  assert.equal(stored[1].totalRuns, 2);
  assert.equal(stored[1].succeededRuns, 2);
  assert.equal(stored[1].lastRunStartedAt, null);
  assert.equal(stored[1].averageDurationMs, null);
  assert.equal(stored[1].p95DurationMs, null);
  assert.deepEqual(result.snapshots, stored);
});

test("snapshotJobMetrics with empty metrics returns empty snapshots array and zero removed", () => {
  const data = makeStore();
  const result = snapshotJobMetrics(
    {},
    {
      ...makeStoreDeps(data),
      jobTypeMetrics: () => [],
      now: () => new Date("2026-04-26T12:00:00.000Z"),
      generateId: () => "should-not-be-used",
    },
  );

  assert.deepEqual(result.snapshots, []);
  assert.equal(result.removed, 0);
  assert.equal(data.jobMetricSnapshots.length, 0);
});

test("snapshotJobMetrics with retentionDays prunes older rows", () => {
  const data = makeStore([
    makeSnapshot({ id: "old_a", type: "scheduler.tick", capturedAt: "2026-01-01T00:00:00.000Z" }),
    makeSnapshot({ id: "old_b", type: "scheduler.tick", capturedAt: "2026-04-20T12:00:00.000Z" }),
    makeSnapshot({ id: "recent", type: "scheduler.tick", capturedAt: "2026-04-25T12:00:00.000Z" }),
  ]);

  let counter = 0;
  const result = snapshotJobMetrics(
    { retentionDays: 7 },
    {
      ...makeStoreDeps(data),
      jobTypeMetrics: () => [makeMetric({ type: "scheduler.tick", totalRuns: 1 })],
      now: () => new Date("2026-04-26T12:00:00.000Z"),
      generateId: () => `new_${counter++}`,
    },
  );

  assert.equal(result.removed, 1);
  assert.equal(result.snapshots.length, 1);
  const ids = data.jobMetricSnapshots.map((entry) => entry.id);
  assert.deepEqual(ids.sort(), ["new_0", "old_b", "recent"].sort());
});

test("listJobMetricSnapshots returns ascending by capturedAt", () => {
  const data = makeStore([
    makeSnapshot({ id: "c", type: "x", capturedAt: "2026-04-26T03:00:00.000Z" }),
    makeSnapshot({ id: "a", type: "x", capturedAt: "2026-04-26T01:00:00.000Z" }),
    makeSnapshot({ id: "b", type: "x", capturedAt: "2026-04-26T02:00:00.000Z" }),
  ]);

  const result = listJobMetricSnapshots({}, { loadStore: () => data });
  assert.deepEqual(result.map((entry) => entry.id), ["a", "b", "c"]);
});

test("listJobMetricSnapshots filters by type, since, and until", () => {
  const data = makeStore([
    makeSnapshot({ id: "alpha_old", type: "alpha", capturedAt: "2026-04-20T00:00:00.000Z" }),
    makeSnapshot({ id: "alpha_mid", type: "alpha", capturedAt: "2026-04-22T00:00:00.000Z" }),
    makeSnapshot({ id: "alpha_new", type: "alpha", capturedAt: "2026-04-25T00:00:00.000Z" }),
    makeSnapshot({ id: "beta_mid", type: "beta", capturedAt: "2026-04-22T00:00:00.000Z" }),
  ]);

  const byType = listJobMetricSnapshots({ type: "alpha" }, { loadStore: () => data });
  assert.deepEqual(byType.map((entry) => entry.id), ["alpha_old", "alpha_mid", "alpha_new"]);

  const sinceFiltered = listJobMetricSnapshots(
    { type: "alpha", since: "2026-04-21T00:00:00.000Z" },
    { loadStore: () => data },
  );
  assert.deepEqual(sinceFiltered.map((entry) => entry.id), ["alpha_mid", "alpha_new"]);

  const untilFiltered = listJobMetricSnapshots(
    { type: "alpha", until: "2026-04-23T00:00:00.000Z" },
    { loadStore: () => data },
  );
  assert.deepEqual(untilFiltered.map((entry) => entry.id), ["alpha_old", "alpha_mid"]);

  const ranged = listJobMetricSnapshots(
    { since: "2026-04-21T00:00:00.000Z", until: "2026-04-23T00:00:00.000Z" },
    { loadStore: () => data },
  );
  assert.deepEqual(ranged.map((entry) => entry.id).sort(), ["alpha_mid", "beta_mid"].sort());
});

test("listJobMetricSnapshots honors limit defaulting to 100 and capping at 500", () => {
  const many: JobMetricSnapshotRecord[] = [];
  for (let index = 0; index < 600; index += 1) {
    const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString();
    many.push(makeSnapshot({ id: `n_${index.toString().padStart(4, "0")}`, type: "x", capturedAt: stamp }));
  }
  const data = makeStore(many);

  const defaultLimit = listJobMetricSnapshots({}, { loadStore: () => data });
  assert.equal(defaultLimit.length, 100);
  assert.equal(defaultLimit[0].id, "n_0000");
  assert.equal(defaultLimit[99].id, "n_0099");

  const explicit = listJobMetricSnapshots({ limit: 250 }, { loadStore: () => data });
  assert.equal(explicit.length, 250);

  const capped = listJobMetricSnapshots({ limit: 1000 }, { loadStore: () => data });
  assert.equal(capped.length, 500);
});

test("pruneJobMetricSnapshots with retentionDays=0 is a no-op", () => {
  const data = makeStore([
    makeSnapshot({ id: "old", type: "x", capturedAt: "2020-01-01T00:00:00.000Z" }),
    makeSnapshot({ id: "new", type: "x", capturedAt: "2026-04-26T00:00:00.000Z" }),
  ]);

  const result = pruneJobMetricSnapshots(
    { retentionDays: 0 },
    { ...makeStoreDeps(data), now: () => new Date("2026-04-26T12:00:00.000Z") },
  );

  assert.equal(result.removed, 0);
  assert.equal(data.jobMetricSnapshots.length, 2);
});

test("pruneJobMetricSnapshots with retentionDays drops older rows and returns the count", () => {
  const data = makeStore([
    makeSnapshot({ id: "ancient", type: "x", capturedAt: "2026-01-01T00:00:00.000Z" }),
    makeSnapshot({ id: "stale", type: "x", capturedAt: "2026-04-10T00:00:00.000Z" }),
    makeSnapshot({ id: "fresh", type: "x", capturedAt: "2026-04-25T00:00:00.000Z" }),
  ]);

  const result = pruneJobMetricSnapshots(
    { retentionDays: 7 },
    { ...makeStoreDeps(data), now: () => new Date("2026-04-26T12:00:00.000Z") },
  );

  assert.equal(result.removed, 2);
  assert.deepEqual(data.jobMetricSnapshots.map((entry) => entry.id), ["fresh"]);
});
