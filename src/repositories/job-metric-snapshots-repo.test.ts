import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createJobMetricSnapshotsRepository,
  jsonJobMetricSnapshotsRepository,
  sqliteJobMetricSnapshotsRepository,
  type JobMetricSnapshotsRepository,
  type JobMetricSnapshotsRepositoryDeps,
} from "./job-metric-snapshots-repo.js";
import type { JobMetricSnapshotRecord, PacketAgentData } from "../packetagent-store.js";

function makeRecord(
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

function makeJsonRepo(): JobMetricSnapshotsRepository {
  const data = {
    jobMetricSnapshots: [] as JobMetricSnapshotRecord[],
  } as unknown as PacketAgentData;
  const deps: JobMetricSnapshotsRepositoryDeps = {
    loadStore: () => data,
    mutateStore: <T>(mutator: (target: PacketAgentData) => T) => mutator(data),
  };
  return jsonJobMetricSnapshotsRepository(deps);
}

function withTempSqlite(testFn: (repo: JobMetricSnapshotsRepository) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "packetagent-repo-"));
  const dbPath = join(dir, "packetagent.sqlite");
  const prevStore = process.env.PACKETAGENT_STORE;
  const prevDbPath = process.env.PACKETAGENT_DB_PATH;
  process.env.PACKETAGENT_STORE = "sqlite";
  process.env.PACKETAGENT_DB_PATH = dbPath;
  try {
    const repo = sqliteJobMetricSnapshotsRepository({ dbPath });
    testFn(repo);
  } finally {
    if (prevStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = prevStore;
    if (prevDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = prevDbPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

function runOnBoth(scenario: (repo: JobMetricSnapshotsRepository) => void): void {
  scenario(makeJsonRepo());
  withTempSqlite(scenario);
}

test("empty repository returns no rows", () => {
  runOnBoth((repo) => {
    assert.deepEqual(repo.list(), []);
    assert.equal(repo.count(), 0);
  });
});

test("insertMany then list returns the record verbatim", () => {
  runOnBoth((repo) => {
    const record = makeRecord({
      id: "snap_1",
      capturedAt: "2026-04-26T10:00:00.000Z",
      type: "agent.run",
      totalRuns: 5,
      succeededRuns: 4,
      failedRuns: 1,
      canceledRuns: 0,
      lastRunStartedAt: "2026-04-26T09:55:00.000Z",
      lastRunFinishedAt: "2026-04-26T09:56:00.000Z",
      lastDurationMs: 60000,
      averageDurationMs: 55000,
      p95DurationMs: 90000,
    });
    repo.insertMany([record]);
    const rows = repo.list();
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], record);
    assert.equal(repo.count(), 1);
  });
});

test("list returns rows sorted ascending by capturedAt", () => {
  runOnBoth((repo) => {
    const a = makeRecord({ id: "a", capturedAt: "2026-04-26T12:00:00.000Z", type: "agent.run" });
    const b = makeRecord({ id: "b", capturedAt: "2026-04-26T10:00:00.000Z", type: "agent.run" });
    const c = makeRecord({ id: "c", capturedAt: "2026-04-26T11:00:00.000Z", type: "agent.run" });
    repo.insertMany([a, b, c]);
    const ids = repo.list().map((entry) => entry.id);
    assert.deepEqual(ids, ["b", "c", "a"]);
  });
});

test("list filters by type", () => {
  runOnBoth((repo) => {
    repo.insertMany([
      makeRecord({ id: "a", capturedAt: "2026-04-26T10:00:00.000Z", type: "agent.run" }),
      makeRecord({ id: "b", capturedAt: "2026-04-26T11:00:00.000Z", type: "metrics.snapshot" }),
      makeRecord({ id: "c", capturedAt: "2026-04-26T12:00:00.000Z", type: "agent.run" }),
    ]);
    const rows = repo.list({ type: "agent.run" });
    assert.deepEqual(
      rows.map((entry) => entry.id),
      ["a", "c"],
    );
  });
});

test("list filters by since (inclusive)", () => {
  runOnBoth((repo) => {
    repo.insertMany([
      makeRecord({ id: "a", capturedAt: "2026-04-26T10:00:00.000Z", type: "agent.run" }),
      makeRecord({ id: "b", capturedAt: "2026-04-26T12:00:00.000Z", type: "agent.run" }),
      makeRecord({ id: "c", capturedAt: "2026-04-26T14:00:00.000Z", type: "agent.run" }),
    ]);
    const rows = repo.list({ since: "2026-04-26T12:00:00.000Z" });
    assert.deepEqual(
      rows.map((entry) => entry.id),
      ["b", "c"],
    );
  });
});

test("list filters by until (inclusive)", () => {
  runOnBoth((repo) => {
    repo.insertMany([
      makeRecord({ id: "a", capturedAt: "2026-04-26T10:00:00.000Z", type: "agent.run" }),
      makeRecord({ id: "b", capturedAt: "2026-04-26T12:00:00.000Z", type: "agent.run" }),
      makeRecord({ id: "c", capturedAt: "2026-04-26T14:00:00.000Z", type: "agent.run" }),
    ]);
    const rows = repo.list({ until: "2026-04-26T12:00:00.000Z" });
    assert.deepEqual(
      rows.map((entry) => entry.id),
      ["a", "b"],
    );
  });
});

test("list applies default limit of 100 and caps at 500", () => {
  runOnBoth((repo) => {
    const records: JobMetricSnapshotRecord[] = [];
    for (let index = 0; index < 510; index += 1) {
      const minute = String(index).padStart(3, "0");
      records.push(
        makeRecord({
          id: `snap_${minute}`,
          capturedAt: `2026-04-26T10:00:${String(index % 60).padStart(2, "0")}.${minute}Z`,
          type: "agent.run",
        }),
      );
    }
    repo.insertMany(records);
    assert.equal(repo.list({ limit: 1 }).length, 1);
    assert.equal(repo.list({ limit: 1000 }).length, 500);
    assert.equal(repo.list().length, 100);
  });
});

test("prune removes older rows and returns count", () => {
  runOnBoth((repo) => {
    repo.insertMany([
      makeRecord({ id: "old1", capturedAt: "2026-03-01T00:00:00.000Z", type: "agent.run" }),
      makeRecord({ id: "old2", capturedAt: "2026-03-15T00:00:00.000Z", type: "agent.run" }),
      makeRecord({ id: "keep", capturedAt: "2026-04-26T00:00:00.000Z", type: "agent.run" }),
    ]);
    const removed = repo.prune("2026-04-01T00:00:00.000Z");
    assert.equal(removed, 2);
    assert.equal(repo.count(), 1);
    assert.deepEqual(
      repo.list().map((entry) => entry.id),
      ["keep"],
    );
  });
});

test("prune with cutoff matching capturedAt retains the row", () => {
  runOnBoth((repo) => {
    repo.insertMany([
      makeRecord({ id: "boundary", capturedAt: "2026-04-26T00:00:00.000Z", type: "agent.run" }),
    ]);
    const removed = repo.prune("2026-04-26T00:00:00.000Z");
    assert.equal(removed, 0);
    assert.equal(repo.count(), 1);
  });
});

test("insertMany dedupes by id (idempotent re-insert)", () => {
  runOnBoth((repo) => {
    const record = makeRecord({
      id: "dup",
      capturedAt: "2026-04-26T10:00:00.000Z",
      type: "agent.run",
      totalRuns: 1,
    });
    repo.insertMany([record]);
    repo.insertMany([record]);
    assert.equal(repo.count(), 1);
    assert.equal(repo.list().length, 1);
    const updated = makeRecord({
      id: "dup",
      capturedAt: "2026-04-26T10:00:00.000Z",
      type: "agent.run",
      totalRuns: 7,
    });
    repo.insertMany([updated]);
    assert.equal(repo.count(), 1);
    assert.equal(repo.list()[0]?.totalRuns, 7);
  });
});

test("createJobMetricSnapshotsRepository selects implementation by env", () => {
  const prevStore = process.env.PACKETAGENT_STORE;
  try {
    delete process.env.PACKETAGENT_STORE;
    const data = {
      jobMetricSnapshots: [] as JobMetricSnapshotRecord[],
    } as unknown as PacketAgentData;
    const json = createJobMetricSnapshotsRepository({
      loadStore: () => data,
      mutateStore: <T>(mutator: (target: PacketAgentData) => T) => mutator(data),
    });
    json.insertMany([
      makeRecord({ id: "a", capturedAt: "2026-04-26T10:00:00.000Z", type: "agent.run" }),
    ]);
    assert.equal(json.count(), 1);
    assert.equal(data.jobMetricSnapshots.length, 1);
  } finally {
    if (prevStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = prevStore;
  }
});

test("createJobMetricSnapshotsRepository returns sqlite impl when env requests it", () => {
  const dir = mkdtempSync(join(tmpdir(), "packetagent-repo-factory-"));
  const dbPath = join(dir, "packetagent.sqlite");
  const prevStore = process.env.PACKETAGENT_STORE;
  const prevDbPath = process.env.PACKETAGENT_DB_PATH;
  process.env.PACKETAGENT_STORE = "sqlite";
  process.env.PACKETAGENT_DB_PATH = dbPath;
  try {
    const repo = createJobMetricSnapshotsRepository({ dbPath });
    repo.insertMany([
      makeRecord({ id: "a", capturedAt: "2026-04-26T10:00:00.000Z", type: "agent.run" }),
    ]);
    assert.equal(repo.count(), 1);
    assert.equal(repo.list()[0]?.id, "a");
  } finally {
    if (prevStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = prevStore;
    if (prevDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = prevDbPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
