import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "./db/cli.js";
import {
  cancelJob,
  claimNextJob,
  enqueueJob,
  enqueueRecurringJob,
  maintainScheduledAgentJobs,
  sweepStaleRunningJobs,
  updateJob,
} from "./jobs/store.js";
import {
  clearStoreCacheForTests,
  loadStore,
  mutateStore,
  resetStoreForTests,
  type AgentRecord,
  type JobRecord,
} from "./packetagent-store.js";

interface JobRow {
  id: string;
  workspace_id: string;
  type: string;
  payload: string;
  status: string;
  attempts: number;
  max_attempts: number;
  scheduled_at: string;
  started_at: string | null;
  completed_at: string | null;
  cron: string | null;
  result: string | null;
  error: string | null;
  cancel_requested: number | null;
  created_at: string;
  updated_at: string;
}

function readDedicatedJobs(dbPath: string): JobRow[] {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare(
        `
      select id, workspace_id, type, payload, status, attempts, max_attempts,
        scheduled_at, started_at, completed_at, cron, result, error,
        cancel_requested, created_at, updated_at
      from jobs
      order by created_at, id
    `,
      )
      .all() as unknown as JobRow[];
  } finally {
    db.close();
  }
}

function readAppRecordJobs(dbPath: string): JobRecord[] {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db
      .prepare("select payload from app_records where collection = 'jobs'")
      .all() as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as JobRecord);
  } finally {
    db.close();
  }
}

function findAppRecordJob(dbPath: string, id: string): JobRecord | null {
  return readAppRecordJobs(dbPath).find((entry) => entry.id === id) ?? null;
}

function findDedicatedJob(dbPath: string, id: string): JobRow | null {
  return readDedicatedJobs(dbPath).find((entry) => entry.id === id) ?? null;
}

function withSqliteEnv(dbPath: string) {
  const previousStore = process.env.PACKETAGENT_STORE;
  const previousDbPath = process.env.PACKETAGENT_DB_PATH;
  process.env.PACKETAGENT_STORE = "sqlite";
  process.env.PACKETAGENT_DB_PATH = dbPath;
  clearStoreCacheForTests();
  return () => {
    if (previousStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = previousStore;
    if (previousDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = previousDbPath;
    clearStoreCacheForTests();
  };
}

function seedAgentDirectly(dbPath: string, agent: AgentRecord): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(
      `
      insert into app_records (collection, id, workspace_id, payload, updated_at)
      values ('agents', ?, ?, json(?), ?)
      on conflict(collection, id) do update set workspace_id = excluded.workspace_id, payload = excluded.payload, updated_at = excluded.updated_at
    `,
    ).run(agent.id, agent.workspaceId, JSON.stringify(agent), agent.updatedAt);
  } finally {
    db.close();
  }
}

function seedDedicatedJobDirectly(dbPath: string, job: JobRecord): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(
      `
      insert or replace into jobs (
        id, workspace_id, type, payload, status, attempts, max_attempts,
        scheduled_at, started_at, completed_at, cron, result, error,
        cancel_requested, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      job.id,
      job.workspaceId,
      job.type,
      JSON.stringify(job.payload ?? {}),
      job.status,
      job.attempts,
      job.maxAttempts,
      job.scheduledAt,
      job.startedAt ?? null,
      job.completedAt ?? null,
      job.cron ?? null,
      job.result === undefined ? null : JSON.stringify(job.result),
      job.error ?? null,
      job.cancelRequested === undefined ? null : job.cancelRequested ? 1 : 0,
      job.createdAt,
      job.updatedAt,
    );
  } finally {
    db.close();
  }
}

function seedAppRecordJobDirectly(dbPath: string, job: JobRecord): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(
      `
      insert into app_records (collection, id, workspace_id, payload, updated_at)
      values ('jobs', ?, ?, json(?), ?)
      on conflict(collection, id) do update set workspace_id = excluded.workspace_id, payload = excluded.payload, updated_at = excluded.updated_at
    `,
    ).run(job.id, job.workspaceId, JSON.stringify(job), job.updatedAt);
  } finally {
    db.close();
  }
}

function makeJobRecord(overrides: Partial<JobRecord> & { id: string }): JobRecord {
  return {
    id: overrides.id,
    workspaceId: overrides.workspaceId ?? "workspace_a",
    type: overrides.type ?? "agent.run",
    payload: overrides.payload ?? {},
    status: overrides.status ?? "queued",
    attempts: overrides.attempts ?? 0,
    maxAttempts: overrides.maxAttempts ?? 3,
    scheduledAt: overrides.scheduledAt ?? "2026-04-25T12:00:00.000Z",
    ...(overrides.startedAt !== undefined ? { startedAt: overrides.startedAt } : {}),
    ...(overrides.completedAt !== undefined ? { completedAt: overrides.completedAt } : {}),
    ...(overrides.cron !== undefined ? { cron: overrides.cron } : {}),
    ...(overrides.result !== undefined ? { result: overrides.result } : {}),
    ...(overrides.error !== undefined ? { error: overrides.error } : {}),
    ...(overrides.cancelRequested !== undefined
      ? { cancelRequested: overrides.cancelRequested }
      : {}),
    createdAt: overrides.createdAt ?? "2026-04-25T12:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-25T12:00:00.000Z",
  };
}

function makeAgent(overrides: Partial<AgentRecord> & { id: string }): AgentRecord {
  return {
    id: overrides.id,
    workspaceId: overrides.workspaceId ?? "workspace_a",
    name: overrides.name ?? "Scheduled agent",
    description: overrides.description ?? "test",
    instructions: overrides.instructions ?? "Be helpful",
    tools: overrides.tools ?? [],
    schedule: overrides.schedule ?? "*/5 * * * *",
    triggerKind: overrides.triggerKind ?? "schedule",
    status: overrides.status ?? "active",
    createdByUserId: overrides.createdByUserId ?? "user_a",
    inputSchema: overrides.inputSchema ?? [],
    createdAt: overrides.createdAt ?? "2026-04-26T12:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-26T12:00:00.000Z",
  };
}

test("enqueueJob writes the dedicated jobs table in SQLite mode", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-jobs-dual-"));
  const dbPath = join(tempDir, "packetagent.sqlite");
  migrateDatabase({ dbPath });
  const restore = withSqliteEnv(dbPath);
  try {
    const job = enqueueJob({ workspaceId: "workspace_a", type: "agent.run", payload: { x: 1 } });

    assert.equal(job.workspaceId, "workspace_a");
    assert.equal(job.type, "agent.run");

    const appRecord = findAppRecordJob(dbPath, job.id);
    assert.equal(appRecord, null);

    const dedicated = findDedicatedJob(dbPath, job.id);
    assert.ok(dedicated, "dedicated row should exist");
    assert.equal(dedicated.id, job.id);
    assert.equal(dedicated.status, "queued");
    assert.equal(dedicated.workspace_id, "workspace_a");
    assert.deepEqual(JSON.parse(dedicated.payload), { x: 1 });
  } finally {
    restore();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("updateJob writes the updated record to the dedicated table", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-jobs-dual-"));
  const dbPath = join(tempDir, "packetagent.sqlite");
  migrateDatabase({ dbPath });
  const restore = withSqliteEnv(dbPath);
  try {
    const job = enqueueJob({ workspaceId: "workspace_a", type: "agent.run" });
    const updated = updateJob(job.workspaceId, job.id, { status: "success", result: { ok: true } });

    assert.ok(updated);
    assert.equal(updated.status, "success");

    const appRecord = findAppRecordJob(dbPath, job.id);
    assert.equal(appRecord, null);

    const dedicated = findDedicatedJob(dbPath, job.id);
    assert.ok(dedicated);
    assert.equal(dedicated.status, "success");
    assert.deepEqual(JSON.parse(dedicated.result ?? "null"), { ok: true });
  } finally {
    restore();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("cancelJob writes the canceled record to the dedicated table", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-jobs-dual-"));
  const dbPath = join(tempDir, "packetagent.sqlite");
  migrateDatabase({ dbPath });
  const restore = withSqliteEnv(dbPath);
  try {
    const job = enqueueJob({ workspaceId: "workspace_a", type: "agent.run" });
    const canceled = cancelJob(job.workspaceId, job.id);

    assert.ok(canceled);
    assert.equal(canceled.status, "canceled");
    assert.equal(canceled.cancelRequested, true);

    const appRecord = findAppRecordJob(dbPath, job.id);
    assert.equal(appRecord, null);

    const dedicated = findDedicatedJob(dbPath, job.id);
    assert.ok(dedicated);
    assert.equal(dedicated.status, "canceled");
    assert.equal(dedicated.cancel_requested, 1);
  } finally {
    restore();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("claimNextJob claims a jobs-table-only row in SQLite mode", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-jobs-dual-"));
  const dbPath = join(tempDir, "packetagent.sqlite");
  migrateDatabase({ dbPath });
  const restore = withSqliteEnv(dbPath);
  try {
    const queued = makeJobRecord({
      id: "dedicated_claim_only",
      scheduledAt: "2026-04-25T12:00:00.000Z",
      createdAt: "2026-04-25T12:00:00.000Z",
      updatedAt: "2026-04-25T12:00:00.000Z",
    });
    const appRecordDecoy = makeJobRecord({
      id: "app_record_claim_decoy",
      scheduledAt: "2026-04-25T11:00:00.000Z",
      createdAt: "2026-04-25T11:00:00.000Z",
      updatedAt: "2026-04-25T11:00:00.000Z",
    });
    seedDedicatedJobDirectly(dbPath, queued);
    seedAppRecordJobDirectly(dbPath, appRecordDecoy);

    assert.equal(findAppRecordJob(dbPath, queued.id), null);
    // Establish a store cache before the repository-native claim; claimNextJob
    // must invalidate it because the mutation bypasses mutateStore.
    loadStore();

    const claimTime = new Date("2026-04-26T12:00:00.000Z");
    const claimed = await claimNextJob(claimTime);
    assert.ok(claimed);
    assert.equal(claimed.id, queued.id);
    assert.equal(claimed.status, "running");
    assert.equal(claimed.attempts, 1);
    assert.equal(claimed.startedAt, claimTime.toISOString());

    const appRecord = findAppRecordJob(dbPath, queued.id);
    assert.equal(appRecord, null);
    assert.deepEqual(findAppRecordJob(dbPath, appRecordDecoy.id), appRecordDecoy);

    const dedicated = findDedicatedJob(dbPath, queued.id);
    assert.ok(dedicated);
    assert.equal(dedicated.status, "running");
    assert.equal(dedicated.attempts, 1);
    assert.equal(dedicated.started_at, claimTime.toISOString());
    const hydrated = loadStore().jobs.find((entry) => entry.id === queued.id);
    assert.equal(hydrated?.status, "running");
    assert.equal(hydrated?.startedAt, claimTime.toISOString());

    mutateStore((data) => {
      data.workspaces[0] = { ...data.workspaces[0], name: "Unrelated mutation" };
      return null;
    });
    const afterUnrelatedMutation = findDedicatedJob(dbPath, queued.id);
    assert.equal(afterUnrelatedMutation?.status, "running");
    assert.equal(afterUnrelatedMutation?.attempts, 1);
    assert.equal(loadStore().jobs.find((entry) => entry.id === queued.id)?.status, "running");
  } finally {
    restore();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sweepStaleRunningJobs sweeps jobs-table-only rows in SQLite mode", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-jobs-dual-"));
  const dbPath = join(tempDir, "packetagent.sqlite");
  migrateDatabase({ dbPath });
  const restore = withSqliteEnv(dbPath);
  try {
    const staleA = makeJobRecord({
      id: "dedicated_stale_a",
      status: "running",
      attempts: 1,
      startedAt: "2020-01-01T00:00:00.000Z",
    });
    const staleB = makeJobRecord({
      id: "dedicated_stale_b",
      workspaceId: "workspace_b",
      status: "running",
      attempts: 2,
      startedAt: "2020-01-01T00:01:00.000Z",
    });
    const fresh = makeJobRecord({
      id: "dedicated_fresh_running",
      status: "running",
      attempts: 1,
      startedAt: new Date().toISOString(),
    });
    const appRecordDecoy = makeJobRecord({
      id: "app_record_sweep_decoy",
      status: "running",
      attempts: 1,
      startedAt: "2020-01-01T00:00:00.000Z",
    });
    seedDedicatedJobDirectly(dbPath, staleA);
    seedDedicatedJobDirectly(dbPath, staleB);
    seedDedicatedJobDirectly(dbPath, fresh);
    seedAppRecordJobDirectly(dbPath, appRecordDecoy);

    assert.equal(findAppRecordJob(dbPath, staleA.id), null);
    assert.equal(findAppRecordJob(dbPath, staleB.id), null);
    // Establish a store cache before the repository-native sweep; sweep must
    // invalidate it because the mutation bypasses mutateStore.
    loadStore();

    const sweepTime = new Date("2026-04-26T12:00:00.000Z");
    const swept = sweepStaleRunningJobs(5 * 60 * 1000, sweepTime);
    assert.equal(swept, 2);

    assert.equal(findAppRecordJob(dbPath, staleA.id), null);
    assert.equal(findAppRecordJob(dbPath, staleB.id), null);
    assert.deepEqual(findAppRecordJob(dbPath, appRecordDecoy.id), appRecordDecoy);

    const dedicatedA = findDedicatedJob(dbPath, staleA.id);
    assert.ok(dedicatedA);
    assert.equal(dedicatedA.status, "queued");
    assert.equal(dedicatedA.started_at, null);

    const dedicatedB = findDedicatedJob(dbPath, staleB.id);
    assert.ok(dedicatedB);
    assert.equal(dedicatedB.status, "queued");
    assert.equal(dedicatedB.started_at, null);
    assert.equal(dedicatedB.updated_at, sweepTime.toISOString());

    const dedicatedFresh = findDedicatedJob(dbPath, fresh.id);
    assert.ok(dedicatedFresh);
    assert.equal(dedicatedFresh.status, "running");
    assert.equal(dedicatedFresh.started_at, fresh.startedAt);
    const hydratedA = loadStore().jobs.find((entry) => entry.id === staleA.id);
    const hydratedB = loadStore().jobs.find((entry) => entry.id === staleB.id);
    assert.equal(hydratedA?.status, "queued");
    assert.equal(hydratedA?.startedAt, undefined);
    assert.equal(hydratedB?.status, "queued");
    assert.equal(hydratedB?.startedAt, undefined);
  } finally {
    restore();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("enqueueRecurringJob writes a non-scheduled-agent job to the dedicated table", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-jobs-dual-"));
  const dbPath = join(tempDir, "packetagent.sqlite");
  migrateDatabase({ dbPath });
  const restore = withSqliteEnv(dbPath);
  try {
    const seed = enqueueJob({
      workspaceId: "workspace_a",
      type: "scheduler.tick",
      payload: { foo: "bar" },
      cron: "*/5 * * * *",
    });

    const recurring = enqueueRecurringJob(seed, "2026-04-27T00:00:00.000Z");
    assert.ok(recurring);
    assert.equal(recurring.type, "scheduler.tick");
    assert.equal(recurring.scheduledAt, "2026-04-27T00:00:00.000Z");

    const appRecord = findAppRecordJob(dbPath, recurring.id);
    assert.equal(appRecord, null);

    const dedicated = findDedicatedJob(dbPath, recurring.id);
    assert.ok(dedicated);
    assert.equal(dedicated.scheduled_at, "2026-04-27T00:00:00.000Z");
    assert.equal(dedicated.cron, "*/5 * * * *");
  } finally {
    restore();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("enqueueRecurringJob writes a scheduled agent job and any cancelled stale entries", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-jobs-dual-"));
  const dbPath = join(tempDir, "packetagent.sqlite");
  migrateDatabase({ dbPath });
  const restore = withSqliteEnv(dbPath);
  try {
    seedAgentDirectly(dbPath, makeAgent({ id: "agent_alpha" }));

    const seedJob: JobRecord = {
      id: "seed-id",
      workspaceId: "workspace_a",
      type: "agent.run",
      payload: { agentId: "agent_alpha", triggerKind: "schedule" },
      status: "running",
      attempts: 1,
      maxAttempts: 3,
      cron: "*/5 * * * *",
      scheduledAt: "2026-04-26T12:00:00.000Z",
      createdAt: "2026-04-26T12:00:00.000Z",
      updatedAt: "2026-04-26T12:00:00.000Z",
    };
    const result = enqueueRecurringJob(seedJob, "2026-04-26T12:05:00.000Z");
    assert.ok(result);
    assert.equal(result.workspaceId, "workspace_a");
    assert.equal(result.type, "agent.run");

    const dedicated = findDedicatedJob(dbPath, result.id);
    assert.ok(dedicated);
    assert.equal(dedicated.status, "queued");
    assert.equal(dedicated.cron, "*/5 * * * *");
    assert.equal(dedicated.scheduled_at, "2026-04-26T12:05:00.000Z");

    const appRecord = findAppRecordJob(dbPath, result.id);
    assert.equal(appRecord, null);
  } finally {
    restore();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("maintainScheduledAgentJobs writes maintained records to the dedicated table", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-jobs-dual-"));
  const dbPath = join(tempDir, "packetagent.sqlite");
  migrateDatabase({ dbPath });
  const restore = withSqliteEnv(dbPath);
  try {
    seedAgentDirectly(dbPath, makeAgent({ id: "agent_alpha" }));

    const maintained = maintainScheduledAgentJobs("agent_alpha");
    assert.equal(maintained.length, 1);
    const record = maintained[0];
    assert.equal(record.type, "agent.run");
    assert.equal(record.payload.agentId, "agent_alpha");

    const dedicated = findDedicatedJob(dbPath, record.id);
    assert.ok(dedicated, "dedicated row should exist for the maintained job");
    assert.equal(dedicated.status, "queued");
    assert.equal(dedicated.cron, "*/5 * * * *");

    const appRecord = findAppRecordJob(dbPath, record.id);
    assert.equal(appRecord, null);
  } finally {
    restore();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("maintainScheduledAgentJobs writes cancellations of stale scheduled jobs to the dedicated table", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-jobs-dual-"));
  const dbPath = join(tempDir, "packetagent.sqlite");
  migrateDatabase({ dbPath });
  const restore = withSqliteEnv(dbPath);
  try {
    seedAgentDirectly(dbPath, makeAgent({ id: "agent_alpha", schedule: "*/10 * * * *" }));

    // First pass produces one queued job with cron "*/10 * * * *".
    const first = maintainScheduledAgentJobs("agent_alpha");
    assert.equal(first.length, 1);
    const initialId = first[0].id;
    assert.equal(first[0].cron, "*/10 * * * *");

    // Now change the agent's schedule. The next maintain should cancel the stale job and create a new one.
    seedAgentDirectly(dbPath, makeAgent({ id: "agent_alpha", schedule: "*/15 * * * *" }));

    const second = maintainScheduledAgentJobs("agent_alpha");
    assert.equal(second.length, 1);
    const newId = second[0].id;
    assert.notEqual(newId, initialId);

    // The dedicated table should now reflect both: the cancelled stale job and the newly maintained one.
    const dedicatedStale = findDedicatedJob(dbPath, initialId);
    assert.ok(dedicatedStale);
    assert.equal(dedicatedStale.status, "canceled");
    assert.equal(dedicatedStale.cancel_requested, 1);

    const dedicatedNew = findDedicatedJob(dbPath, newId);
    assert.ok(dedicatedNew);
    assert.equal(dedicatedNew.status, "queued");
    assert.equal(dedicatedNew.cron, "*/15 * * * *");
  } finally {
    restore();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("enqueueJob does not touch the dedicated jobs table in JSON-default mode", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-jobs-dual-"));
  const dbPath = join(tempDir, "packetagent.sqlite");
  migrateDatabase({ dbPath });
  const previousStore = process.env.PACKETAGENT_STORE;
  const previousDbPath = process.env.PACKETAGENT_DB_PATH;
  delete process.env.PACKETAGENT_STORE;
  // Point the SQLite path at our temp DB so any accidental writes would land there
  // and we can detect them; with PACKETAGENT_STORE unset, JSON mode should not open this DB.
  process.env.PACKETAGENT_DB_PATH = dbPath;
  clearStoreCacheForTests();
  resetStoreForTests();
  try {
    const before = readDedicatedJobs(dbPath);
    const job = enqueueJob({ workspaceId: "workspace_a", type: "agent.run" });
    const updated = updateJob(job.workspaceId, job.id, { status: "success" });
    assert.ok(updated);
    const canceled = enqueueJob({ workspaceId: "workspace_a", type: "agent.run.two" });
    cancelJob(canceled.workspaceId, canceled.id);

    const after = readDedicatedJobs(dbPath);
    assert.equal(after.length, before.length, "dedicated table must remain unchanged in JSON mode");
  } finally {
    if (previousStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = previousStore;
    if (previousDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = previousDbPath;
    clearStoreCacheForTests();
    resetStoreForTests();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
