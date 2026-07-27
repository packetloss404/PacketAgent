import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listJobMetricSnapshots } from "./job-metrics-snapshot.js";
import {
  createJobMetricSnapshotsRepository,
  jsonJobMetricSnapshotsRepository,
} from "../repositories/job-metric-snapshots-repo.js";
import type { JobMetricSnapshotRecord, PacketAgentData } from "../packetagent-store.js";

function makeStore(snapshots: JobMetricSnapshotRecord[] = []): PacketAgentData {
  return { jobMetricSnapshots: [...snapshots] } as unknown as PacketAgentData;
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

function withTempSqlite<T>(fn: (dbPath: string) => T): T {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-job-metric-snapshots-read-parity-"));
  const dbPath = join(tempDir, "packetagent.sqlite");
  const previousStore = process.env.PACKETAGENT_STORE;
  const previousDbPath = process.env.PACKETAGENT_DB_PATH;
  process.env.PACKETAGENT_STORE = "sqlite";
  process.env.PACKETAGENT_DB_PATH = dbPath;
  try {
    return fn(dbPath);
  } finally {
    if (previousStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = previousStore;
    if (previousDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = previousDbPath;
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test("listJobMetricSnapshots delegates through repository and preserves ascending capturedAt sort", () => {
  const data = makeStore([
    makeSnapshot({ id: "c", type: "scheduler.tick", capturedAt: "2026-04-26T03:00:00.000Z" }),
    makeSnapshot({ id: "a", type: "scheduler.tick", capturedAt: "2026-04-26T01:00:00.000Z" }),
    makeSnapshot({ id: "b", type: "scheduler.tick", capturedAt: "2026-04-26T02:00:00.000Z" }),
  ]);

  const result = listJobMetricSnapshots({}, { loadStore: () => data });

  assert.deepEqual(result.map((entry) => entry.id), ["a", "b", "c"]);
});

test("listJobMetricSnapshots preserves type/since/until filtering through the repository", () => {
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

test("listJobMetricSnapshots returns an empty array when the store has no snapshots", () => {
  const data = makeStore();
  const result = listJobMetricSnapshots({}, { loadStore: () => data });
  assert.deepEqual(result, []);
});

test("listJobMetricSnapshots default limit is 100 and cap is 500", () => {
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

test("listJobMetricSnapshots can be backed directly by an injected repository instance", () => {
  const data = makeStore([
    makeSnapshot({ id: "first", type: "scheduler.tick", capturedAt: "2026-04-26T01:00:00.000Z" }),
    makeSnapshot({ id: "second", type: "scheduler.tick", capturedAt: "2026-04-26T02:00:00.000Z" }),
  ]);
  const repository = jsonJobMetricSnapshotsRepository({ loadStore: () => data });

  const viaInjectedRepository = repository.list({});
  const viaListFunction = listJobMetricSnapshots({}, { loadStore: () => data });

  assert.deepEqual(viaInjectedRepository.map((entry) => entry.id), ["first", "second"]);
  assert.deepEqual(
    viaListFunction.map((entry) => entry.id),
    viaInjectedRepository.map((entry) => entry.id),
  );
});

test("listJobMetricSnapshots reads from the SQLite repository when PACKETAGENT_STORE=sqlite", () => {
  withTempSqlite((dbPath) => {
    const seedRecords: JobMetricSnapshotRecord[] = [
      makeSnapshot({ id: "sqlite_a", type: "scheduler.tick", capturedAt: "2026-04-26T01:00:00.000Z", totalRuns: 3, succeededRuns: 2, failedRuns: 1 }),
      makeSnapshot({ id: "sqlite_b", type: "invitation.reconcile", capturedAt: "2026-04-26T02:00:00.000Z", totalRuns: 5, succeededRuns: 5 }),
      makeSnapshot({ id: "sqlite_c", type: "scheduler.tick", capturedAt: "2026-04-26T03:00:00.000Z", totalRuns: 4, succeededRuns: 3, failedRuns: 1 }),
    ];

    const seedingRepo = createJobMetricSnapshotsRepository({ dbPath });
    seedingRepo.insertMany(seedRecords);
    assert.equal(seedingRepo.count(), 3);

    const ascending = listJobMetricSnapshots();
    assert.deepEqual(ascending.map((entry) => entry.id), ["sqlite_a", "sqlite_b", "sqlite_c"]);

    const filtered = listJobMetricSnapshots({ type: "scheduler.tick" });
    assert.deepEqual(filtered.map((entry) => entry.id), ["sqlite_a", "sqlite_c"]);

    const tickRecord = filtered[0];
    assert.equal(tickRecord.totalRuns, 3);
    assert.equal(tickRecord.succeededRuns, 2);
    assert.equal(tickRecord.failedRuns, 1);
  });
});
