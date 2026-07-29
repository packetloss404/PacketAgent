import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  findJobIndexed,
  listJobsForWorkspaceIndexed,
} from "./packetagent-store.js";
import {
  createJobsRepository,
  jsonJobsRepository,
} from "./repositories/jobs-repo.js";
import {
  findJobViaRepository,
  listJobsForWorkspaceViaRepository,
} from "./jobs-read.js";
import type { JobRecord, JobStatus, PacketAgentData } from "./packetagent-store.js";

function makeStore(records: JobRecord[] = []): PacketAgentData {
  return { jobs: [...records] } as unknown as PacketAgentData;
}

function makeRecord(
  overrides: Partial<JobRecord> & { id: string; workspaceId: string; createdAt: string },
): JobRecord {
  const status: JobStatus = overrides.status ?? "queued";
  const record: JobRecord = {
    id: overrides.id,
    workspaceId: overrides.workspaceId,
    type: overrides.type ?? "agent.run",
    payload: overrides.payload ?? {},
    status,
    attempts: overrides.attempts ?? 0,
    maxAttempts: overrides.maxAttempts ?? 3,
    scheduledAt: overrides.scheduledAt ?? overrides.createdAt,
    createdAt: overrides.createdAt,
    updatedAt: overrides.updatedAt ?? overrides.createdAt,
  };
  if (overrides.startedAt !== undefined) record.startedAt = overrides.startedAt;
  if (overrides.completedAt !== undefined) record.completedAt = overrides.completedAt;
  if (overrides.cron !== undefined) record.cron = overrides.cron;
  if (overrides.result !== undefined) record.result = overrides.result;
  if (overrides.error !== undefined) record.error = overrides.error;
  if (overrides.cancelRequested !== undefined) record.cancelRequested = overrides.cancelRequested;
  return record;
}

function withTempSqlite<T>(fn: (dbPath: string) => T): T {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-jobs-read-parity-"));
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

test("listJobsForWorkspaceIndexed returns workspace-scoped jobs sorted by createdAt DESC via repository", () => {
  const data = makeStore([
    makeRecord({ id: "job_a", workspaceId: "ws_target", createdAt: "2026-04-26T01:00:00.000Z" }),
    makeRecord({ id: "job_c", workspaceId: "ws_target", createdAt: "2026-04-26T03:00:00.000Z" }),
    makeRecord({ id: "job_b", workspaceId: "ws_target", createdAt: "2026-04-26T02:00:00.000Z" }),
    makeRecord({ id: "job_other", workspaceId: "ws_other", createdAt: "2026-04-26T04:00:00.000Z" }),
  ]);
  const repository = jsonJobsRepository({ loadStore: () => data });

  const result = listJobsForWorkspaceViaRepository("ws_target", {}, { repository });

  assert.deepEqual(result.map((entry) => entry.id), ["job_c", "job_b", "job_a"]);
});

test("listJobsForWorkspaceIndexed returns [] when the workspace has no jobs", () => {
  const data = makeStore([
    makeRecord({ id: "job_other", workspaceId: "ws_other", createdAt: "2026-04-26T01:00:00.000Z" }),
  ]);
  const repository = jsonJobsRepository({ loadStore: () => data });

  const result = listJobsForWorkspaceViaRepository("ws_target", {}, { repository });

  assert.deepEqual(result, []);
});

test("listJobsForWorkspaceIndexed default limit is 50 and cap is 200", () => {
  const many: JobRecord[] = [];
  for (let index = 0; index < 250; index += 1) {
    const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString();
    many.push(
      makeRecord({
        id: `job_${index.toString().padStart(4, "0")}`,
        workspaceId: "ws_target",
        createdAt: stamp,
      }),
    );
  }
  const data = makeStore(many);
  const repository = jsonJobsRepository({ loadStore: () => data });

  const defaultLimit = listJobsForWorkspaceViaRepository("ws_target", {}, { repository });
  assert.equal(defaultLimit.length, 50);
  // descending — newest (highest index) first
  assert.equal(defaultLimit[0].id, "job_0249");
  assert.equal(defaultLimit[49].id, "job_0200");

  const explicit = listJobsForWorkspaceViaRepository("ws_target", { limit: 100 }, { repository });
  assert.equal(explicit.length, 100);

  const capped = listJobsForWorkspaceViaRepository("ws_target", { limit: 1000 }, { repository });
  assert.equal(capped.length, 200);
});

test("listJobsForWorkspaceIndexed filters by status", () => {
  const data = makeStore([
    makeRecord({ id: "job_q1", workspaceId: "ws_target", status: "queued", createdAt: "2026-04-26T01:00:00.000Z" }),
    makeRecord({ id: "job_q2", workspaceId: "ws_target", status: "queued", createdAt: "2026-04-26T02:00:00.000Z" }),
    makeRecord({ id: "job_running", workspaceId: "ws_target", status: "running", createdAt: "2026-04-26T03:00:00.000Z" }),
    makeRecord({ id: "job_done", workspaceId: "ws_target", status: "success", createdAt: "2026-04-26T04:00:00.000Z" }),
  ]);
  const repository = jsonJobsRepository({ loadStore: () => data });

  const queued = listJobsForWorkspaceViaRepository("ws_target", { status: "queued" }, { repository });
  assert.deepEqual(queued.map((entry) => entry.id), ["job_q2", "job_q1"]);

  const running = listJobsForWorkspaceViaRepository("ws_target", { status: "running" }, { repository });
  assert.deepEqual(running.map((entry) => entry.id), ["job_running"]);

  const failed = listJobsForWorkspaceViaRepository("ws_target", { status: "failed" }, { repository });
  assert.deepEqual(failed, []);
});

test("findJobIndexed requires the matching workspace and returns null for cross-workspace reads", () => {
  const data = makeStore([
    makeRecord({ id: "job_match", workspaceId: "ws_target", createdAt: "2026-04-26T01:00:00.000Z" }),
    makeRecord({ id: "job_other_ws", workspaceId: "ws_other", createdAt: "2026-04-26T02:00:00.000Z" }),
  ]);
  const repository = jsonJobsRepository({ loadStore: () => data });

  const found = findJobViaRepository("ws_target", "job_match", { repository });
  assert.equal(found?.id, "job_match");
  assert.equal(found?.workspaceId, "ws_target");

  const crossWorkspace = findJobViaRepository("ws_target", "job_other_ws", { repository });
  assert.equal(crossWorkspace, null);

  const missing = findJobViaRepository("ws_target", "job_does_not_exist", { repository });
  assert.equal(missing, null);
});

test("listJobsForWorkspaceIndexed reads from the SQLite repository when PACKETAGENT_STORE=sqlite", () => {
  withTempSqlite((dbPath) => {
    const seedRecords: JobRecord[] = [
      makeRecord({ id: "sqlite_a", workspaceId: "ws_target", status: "queued", createdAt: "2026-04-26T01:00:00.000Z" }),
      makeRecord({ id: "sqlite_b", workspaceId: "ws_target", status: "running", createdAt: "2026-04-26T02:00:00.000Z" }),
      makeRecord({ id: "sqlite_c", workspaceId: "ws_target", status: "queued", createdAt: "2026-04-26T03:00:00.000Z" }),
      makeRecord({ id: "sqlite_other", workspaceId: "ws_other", status: "queued", createdAt: "2026-04-26T04:00:00.000Z" }),
    ];

    const seedingRepo = createJobsRepository({ dbPath });
    for (const record of seedRecords) {
      seedingRepo.upsert(record);
    }
    assert.equal(seedingRepo.count(), seedRecords.length);

    const descending = listJobsForWorkspaceIndexed("ws_target");
    assert.deepEqual(descending.map((entry) => entry.id), ["sqlite_c", "sqlite_b", "sqlite_a"]);

    const queuedOnly = listJobsForWorkspaceIndexed("ws_target", { status: "queued" });
    assert.deepEqual(queuedOnly.map((entry) => entry.id), ["sqlite_c", "sqlite_a"]);

    const found = findJobIndexed("ws_target", "sqlite_b");
    assert.equal(found?.id, "sqlite_b");
    assert.equal(found?.status, "running");

    const crossWorkspace = findJobIndexed("ws_target", "sqlite_other");
    assert.equal(crossWorkspace, null);

    const missing = findJobIndexed("ws_target", "does_not_exist");
    assert.equal(missing, null);
  });
});

test("listJobsForWorkspaceIndexed merges JSON-side fall-back rows when in SQLite mode", () => {
  withTempSqlite(() => {
    // Seed the repository with one row.
    const seedingRepo = createJobsRepository();
    const repoRecord = makeRecord({
      id: "sqlite_repo",
      workspaceId: "ws_target",
      status: "queued",
      createdAt: "2026-04-26T01:00:00.000Z",
    });
    seedingRepo.upsert(repoRecord);

    // Seed a fallback record only via the JSON store (NOT via enqueueJob/repository).
    const fallbackRecord = makeRecord({
      id: "json_only",
      workspaceId: "ws_target",
      status: "queued",
      createdAt: "2026-04-26T05:00:00.000Z",
    });
    const fallbackData = makeStore([fallbackRecord]);
    const loadStore = () => fallbackData;

    const merged = listJobsForWorkspaceViaRepository("ws_target", {}, { loadStore });
    const ids = merged.map((entry) => entry.id);
    assert.ok(ids.includes("sqlite_repo"), "expected repository row to be present");
    assert.ok(ids.includes("json_only"), "expected JSON fallback row to be merged in SQLite mode");
    // Newest first by createdAt.
    assert.equal(ids[0], "json_only");

    const foundFallback = findJobViaRepository("ws_target", "json_only", { loadStore });
    assert.equal(foundFallback?.id, "json_only");
  });
});
