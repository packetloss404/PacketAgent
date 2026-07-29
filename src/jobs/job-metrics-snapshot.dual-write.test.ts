import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "../db/cli.js";
import { pruneJobMetricSnapshots, snapshotJobMetrics } from "./job-metrics-snapshot.js";
import type { JobTypeMetrics } from "./scheduler-metrics.js";
import type { JobMetricSnapshotRecord, PacketAgentData } from "../packetagent-store.js";

function makeStore(snapshots: JobMetricSnapshotRecord[] = []): PacketAgentData {
  return { jobMetricSnapshots: [...snapshots] } as unknown as PacketAgentData;
}

function makeStoreDeps(data: PacketAgentData) {
  return {
    loadStore: () => data,
    mutateStore: <T>(mutator: (target: PacketAgentData) => T) => mutator(data),
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

function makeSnapshot(
  overrides: Partial<JobMetricSnapshotRecord> & { id: string; capturedAt: string; type: string },
): JobMetricSnapshotRecord {
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

function readDedicated(dbPath: string): JobMetricSnapshotRecord[] {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db
      .prepare(
        `
      select id, captured_at, type, total_runs, succeeded_runs, failed_runs, canceled_runs,
        last_run_started_at, last_run_finished_at, last_duration_ms, average_duration_ms, p95_duration_ms
      from job_metric_snapshots
      order by captured_at, id
    `,
      )
      .all() as Array<{
      id: string;
      captured_at: string;
      type: string;
      total_runs: number;
      succeeded_runs: number;
      failed_runs: number;
      canceled_runs: number;
      last_run_started_at: string | null;
      last_run_finished_at: string | null;
      last_duration_ms: number | null;
      average_duration_ms: number | null;
      p95_duration_ms: number | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      capturedAt: row.captured_at,
      type: row.type,
      totalRuns: row.total_runs,
      succeededRuns: row.succeeded_runs,
      failedRuns: row.failed_runs,
      canceledRuns: row.canceled_runs,
      lastRunStartedAt: row.last_run_started_at,
      lastRunFinishedAt: row.last_run_finished_at,
      lastDurationMs: row.last_duration_ms,
      averageDurationMs: row.average_duration_ms,
      p95DurationMs: row.p95_duration_ms,
    }));
  } finally {
    db.close();
  }
}

function withSqliteEnv(dbPath: string) {
  const previousStore = process.env.PACKETAGENT_STORE;
  const previousDbPath = process.env.PACKETAGENT_DB_PATH;
  process.env.PACKETAGENT_STORE = "sqlite";
  process.env.PACKETAGENT_DB_PATH = dbPath;
  return () => {
    if (previousStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = previousStore;
    if (previousDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = previousDbPath;
  };
}

test("snapshotJobMetrics dual-writes JSON-side and dedicated SQLite table in SQLite mode", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-dual-write-"));
  const dbPath = join(tempDir, "packetagent.sqlite");
  migrateDatabase({ dbPath });
  const restore = withSqliteEnv(dbPath);
  try {
    const data = makeStore();
    let counter = 0;
    const result = snapshotJobMetrics(
      { retentionDays: 0 },
      {
        ...makeStoreDeps(data),
        jobTypeMetrics: () => [
          makeMetric({ type: "scheduler.tick", totalRuns: 4, succeededRuns: 4 }),
          makeMetric({ type: "invitation.reconcile", totalRuns: 2, succeededRuns: 2 }),
        ],
        now: () => new Date("2026-04-26T12:00:00.000Z"),
        generateId: () => `snap_${counter++}`,
      },
    );

    assert.equal(result.snapshots.length, 2);
    assert.equal(data.jobMetricSnapshots.length, 2);
    const dedicated = readDedicated(dbPath);
    assert.equal(dedicated.length, 2);
    const idsJson = data.jobMetricSnapshots.map((entry) => entry.id).sort();
    const idsDedicated = dedicated.map((entry) => entry.id).sort();
    assert.deepEqual(idsDedicated, idsJson);
  } finally {
    restore();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("pruneJobMetricSnapshots dual-deletes from JSON-side and dedicated SQLite table in SQLite mode", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-dual-write-"));
  const dbPath = join(tempDir, "packetagent.sqlite");
  migrateDatabase({ dbPath });
  const restore = withSqliteEnv(dbPath);
  try {
    const ancient = makeSnapshot({
      id: "ancient",
      type: "x",
      capturedAt: "2026-01-01T00:00:00.000Z",
    });
    const stale = makeSnapshot({ id: "stale", type: "x", capturedAt: "2026-04-10T00:00:00.000Z" });
    const fresh = makeSnapshot({ id: "fresh", type: "x", capturedAt: "2026-04-25T00:00:00.000Z" });
    const data = makeStore([ancient, stale, fresh]);

    const seedDb = new DatabaseSync(dbPath);
    try {
      const stmt = seedDb.prepare(`
        insert or replace into job_metric_snapshots (
          id, captured_at, type, total_runs, succeeded_runs, failed_runs, canceled_runs,
          last_run_started_at, last_run_finished_at, last_duration_ms, average_duration_ms, p95_duration_ms
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const record of [ancient, stale, fresh]) {
        stmt.run(
          record.id,
          record.capturedAt,
          record.type,
          record.totalRuns,
          record.succeededRuns,
          record.failedRuns,
          record.canceledRuns,
          record.lastRunStartedAt,
          record.lastRunFinishedAt,
          record.lastDurationMs,
          record.averageDurationMs,
          record.p95DurationMs,
        );
      }
    } finally {
      seedDb.close();
    }

    const result = pruneJobMetricSnapshots(
      { retentionDays: 7 },
      { ...makeStoreDeps(data), now: () => new Date("2026-04-26T12:00:00.000Z") },
    );

    assert.equal(result.removed, 2);
    assert.deepEqual(
      data.jobMetricSnapshots.map((entry) => entry.id),
      ["fresh"],
    );
    const dedicated = readDedicated(dbPath);
    assert.deepEqual(
      dedicated.map((entry) => entry.id),
      ["fresh"],
    );
  } finally {
    restore();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("snapshotJobMetrics is a no-op for the dedicated table in JSON-default mode", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-dual-write-"));
  const dbPath = join(tempDir, "packetagent.sqlite");
  migrateDatabase({ dbPath });
  const previousStore = process.env.PACKETAGENT_STORE;
  delete process.env.PACKETAGENT_STORE;
  try {
    const data = makeStore();
    let counter = 0;
    snapshotJobMetrics(
      { retentionDays: 0 },
      {
        ...makeStoreDeps(data),
        jobTypeMetrics: () => [makeMetric({ type: "scheduler.tick", totalRuns: 1 })],
        now: () => new Date("2026-04-26T12:00:00.000Z"),
        generateId: () => `snap_${counter++}`,
      },
    );

    assert.equal(data.jobMetricSnapshots.length, 1);
    const dedicated = readDedicated(dbPath);
    assert.equal(dedicated.length, 0);
  } finally {
    if (previousStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = previousStore;
    rmSync(tempDir, { recursive: true, force: true });
  }
});
