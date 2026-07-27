import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { JobRecord, JobStatus, PacketAgentData } from "../packetagent-store.js";
import { loadStore as defaultLoadStore, mutateStore as defaultMutateStore } from "../packetagent-store.js";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_DB_FILE = "data/packetagent.sqlite";
const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");

export interface ListJobsFilter {
  workspaceId: string;
  status?: JobStatus;
  limit?: number;
}

export interface JobsRepository {
  list(filter: ListJobsFilter): JobRecord[];
  find(id: string): JobRecord | null;
  upsert(record: JobRecord): void;
  update(id: string, patch: Partial<JobRecord>): JobRecord | null;
  count(): number;
  claimNext(now: Date): JobRecord | null;
  sweepStaleRunning(staleAfterMs: number, now: Date): number;
}

export interface AsyncJobsRepository {
  list(filter: ListJobsFilter): Promise<JobRecord[]>;
  find(id: string): Promise<JobRecord | null>;
  upsert(record: JobRecord): Promise<void>;
  update(id: string, patch: Partial<JobRecord>): Promise<JobRecord | null>;
  count(): Promise<number>;
  claimNext(now: Date): Promise<JobRecord | null>;
  sweepStaleRunning(staleAfterMs: number, now: Date): Promise<number>;
}

export interface JobsRepositoryDeps {
  loadStore?: () => PacketAgentData;
  mutateStore?: <T>(mutator: (data: PacketAgentData) => T) => T;
  dbPath?: string;
}

type MaybePromise<T> = T | Promise<T>;

export interface AsyncJobsRepositoryDeps {
  loadStore?: () => MaybePromise<PacketAgentData>;
  mutateStore?: <T>(mutator: (data: PacketAgentData) => MaybePromise<T>) => MaybePromise<T>;
  repository?: JobsRepository;
  dbPath?: string;
}

export function createJobsRepository(deps: JobsRepositoryDeps = {}): JobsRepository {
  if (process.env.PACKETAGENT_STORE === "sqlite") return sqliteJobsRepository(deps);
  return jsonJobsRepository(deps);
}

export function asyncJobsRepository(repository: JobsRepository): AsyncJobsRepository {
  return {
    async list(filter) {
      return repository.list(filter);
    },
    async find(id) {
      return repository.find(id);
    },
    async upsert(record) {
      repository.upsert(record);
    },
    async update(id, patch) {
      return repository.update(id, patch);
    },
    async count() {
      return repository.count();
    },
    async claimNext(now) {
      return repository.claimNext(now);
    },
    async sweepStaleRunning(staleAfterMs, now) {
      return repository.sweepStaleRunning(staleAfterMs, now);
    },
  };
}

export function asyncJobsRepositoryFromSync(repository: JobsRepository): AsyncJobsRepository {
  return asyncJobsRepository(repository);
}

export function createAsyncJobsRepository(deps: AsyncJobsRepositoryDeps = {}): AsyncJobsRepository {
  if (deps.repository) return asyncJobsRepository(deps.repository);
  if (process.env.PACKETAGENT_STORE === "sqlite") {
    return asyncJobsRepository(sqliteJobsRepository({ dbPath: deps.dbPath }));
  }
  return asyncJsonJobsRepository(deps);
}

export function jsonJobsRepository(deps: JobsRepositoryDeps = {}): JobsRepository {
  const load = deps.loadStore ?? defaultLoadStore;
  const mutate = deps.mutateStore ?? defaultMutateStore;
  return {
    list(filter) {
      const data = load();
      const collection = Array.isArray(data.jobs) ? data.jobs : [];
      const filtered = collection.filter((entry) => {
        if (entry.workspaceId !== filter.workspaceId) return false;
        if (filter.status !== undefined && entry.status !== filter.status) return false;
        return true;
      });
      return sortAndLimit(filtered, filter.limit);
    },
    find(id) {
      const data = load();
      const collection = Array.isArray(data.jobs) ? data.jobs : [];
      return collection.find((entry) => entry.id === id) ?? null;
    },
    upsert(record) {
      mutate((data) => {
        if (!Array.isArray(data.jobs)) data.jobs = [];
        const index = data.jobs.findIndex((entry) => entry.id === record.id);
        if (index >= 0) {
          data.jobs[index] = record;
        } else {
          data.jobs.push(record);
        }
        return null;
      });
    },
    update(id, patch) {
      return mutate((data) => {
        if (!Array.isArray(data.jobs)) {
          data.jobs = [];
          return null;
        }
        const target = data.jobs.find((entry) => entry.id === id);
        if (!target) return null;
        Object.assign(target, patch, { updatedAt: new Date().toISOString() });
        return target;
      });
    },
    count() {
      const data = load();
      return Array.isArray(data.jobs) ? data.jobs.length : 0;
    },
    claimNext(now) {
      return mutate((data) => {
        if (!Array.isArray(data.jobs)) {
          data.jobs = [];
          return null;
        }
        const candidate = data.jobs
          .filter((entry) => entry.status === "queued" && Date.parse(entry.scheduledAt) <= now.getTime())
          .sort((left, right) => Date.parse(left.scheduledAt) - Date.parse(right.scheduledAt))[0];
        if (!candidate) return null;
        const ts = now.toISOString();
        candidate.status = "running";
        candidate.attempts += 1;
        candidate.startedAt = ts;
        candidate.updatedAt = ts;
        return candidate;
      });
    },
    sweepStaleRunning(staleAfterMs, now) {
      return mutate((data) => {
        if (!Array.isArray(data.jobs)) {
          data.jobs = [];
          return 0;
        }
        const cutoff = now.getTime() - staleAfterMs;
        const ts = now.toISOString();
        let count = 0;
        for (const entry of data.jobs) {
          if (entry.status !== "running") continue;
          if (!entry.startedAt) continue;
          const startedMs = Date.parse(entry.startedAt);
          if (Number.isNaN(startedMs) || startedMs >= cutoff) continue;
          entry.status = "queued";
          entry.updatedAt = ts;
          delete entry.startedAt;
          count += 1;
        }
        return count;
      });
    },
  };
}

export function asyncJsonJobsRepository(deps: AsyncJobsRepositoryDeps = {}): AsyncJobsRepository {
  const load = deps.loadStore ?? defaultLoadStore;
  const mutate = deps.mutateStore ?? defaultMutateStore;
  return {
    async list(filter) {
      const data = await load();
      const collection = Array.isArray(data.jobs) ? data.jobs : [];
      const filtered = collection.filter((entry) => {
        if (entry.workspaceId !== filter.workspaceId) return false;
        if (filter.status !== undefined && entry.status !== filter.status) return false;
        return true;
      });
      return sortAndLimit(filtered, filter.limit);
    },
    async find(id) {
      const data = await load();
      const collection = Array.isArray(data.jobs) ? data.jobs : [];
      return collection.find((entry) => entry.id === id) ?? null;
    },
    async upsert(record) {
      await mutate((data) => {
        if (!Array.isArray(data.jobs)) data.jobs = [];
        const index = data.jobs.findIndex((entry) => entry.id === record.id);
        if (index >= 0) {
          data.jobs[index] = record;
        } else {
          data.jobs.push(record);
        }
        return null;
      });
    },
    async update(id, patch) {
      return mutate((data) => {
        if (!Array.isArray(data.jobs)) {
          data.jobs = [];
          return null;
        }
        const target = data.jobs.find((entry) => entry.id === id);
        if (!target) return null;
        Object.assign(target, patch, { updatedAt: new Date().toISOString() });
        return target;
      });
    },
    async count() {
      const data = await load();
      return Array.isArray(data.jobs) ? data.jobs.length : 0;
    },
    async claimNext(now) {
      return mutate((data) => {
        if (!Array.isArray(data.jobs)) {
          data.jobs = [];
          return null;
        }
        const candidate = data.jobs
          .filter((entry) => entry.status === "queued" && Date.parse(entry.scheduledAt) <= now.getTime())
          .sort((left, right) => Date.parse(left.scheduledAt) - Date.parse(right.scheduledAt))[0];
        if (!candidate) return null;
        const ts = now.toISOString();
        candidate.status = "running";
        candidate.attempts += 1;
        candidate.startedAt = ts;
        candidate.updatedAt = ts;
        return candidate;
      });
    },
    async sweepStaleRunning(staleAfterMs, now) {
      return mutate((data) => {
        if (!Array.isArray(data.jobs)) {
          data.jobs = [];
          return 0;
        }
        const cutoff = now.getTime() - staleAfterMs;
        const ts = now.toISOString();
        let count = 0;
        for (const entry of data.jobs) {
          if (entry.status !== "running") continue;
          if (!entry.startedAt) continue;
          const startedMs = Date.parse(entry.startedAt);
          if (Number.isNaN(startedMs) || startedMs >= cutoff) continue;
          entry.status = "queued";
          entry.updatedAt = ts;
          delete entry.startedAt;
          count += 1;
        }
        return count;
      });
    },
  };
}

export function sqliteJobsRepository(deps: JobsRepositoryDeps = {}): JobsRepository {
  const dbPath = resolveDbPath(deps.dbPath);
  return {
    list(filter) {
      const db = openDatabase(dbPath);
      try {
        const sql: string[] = ["select * from jobs where workspace_id = ?"];
        const params: Array<string | number> = [filter.workspaceId];
        if (filter.status !== undefined) {
          sql.push("and status = ?");
          params.push(filter.status);
        }
        sql.push("order by created_at desc, id asc limit ?");
        params.push(clampLimit(filter.limit));
        const rows = db.prepare(sql.join(" ")).all(...params) as unknown as JobRow[];
        return rows.map(rowToRecord);
      } finally {
        db.close();
      }
    },
    find(id) {
      const db = openDatabase(dbPath);
      try {
        const row = db.prepare("select * from jobs where id = ?").get(id) as JobRow | undefined;
        return row ? rowToRecord(row) : null;
      } finally {
        db.close();
      }
    },
    upsert(record) {
      const db = openDatabase(dbPath);
      try {
        upsertRow(db, record);
      } finally {
        db.close();
      }
    },
    update(id, patch) {
      const db = openDatabase(dbPath);
      try {
        db.exec("begin immediate");
        try {
          const existing = db.prepare("select * from jobs where id = ?").get(id) as JobRow | undefined;
          if (!existing) {
            db.exec("commit");
            return null;
          }
          const merged: JobRecord = { ...rowToRecord(existing), ...patch, updatedAt: new Date().toISOString() };
          upsertRow(db, merged);
          db.exec("commit");
          return merged;
        } catch (error) {
          db.exec("rollback");
          throw error;
        }
      } finally {
        db.close();
      }
    },
    count() {
      const db = openDatabase(dbPath);
      try {
        const row = db.prepare("select count(*) as count from jobs").get() as
          | { count: number }
          | undefined;
        return row?.count ?? 0;
      } finally {
        db.close();
      }
    },
    claimNext(now) {
      const db = openDatabase(dbPath);
      try {
        db.exec("begin immediate");
        try {
          const nowMs = now.getTime();
          // Push the claimable predicate + ordering + limit into SQL so the
          // idx_jobs_status_scheduled index does the work instead of scanning
          // every queued row and sorting in JS. The predicate mirrors the old
          // JS filter (status = 'queued' and scheduledAt due now) and the
          // ordering mirrors the old sort (oldest scheduledAt first, then id).
          //
          // scheduled_at is stored as an ISO-8601 string, for which lexical
          // ordering and the `<= ?` comparison match chronological order, so
          // the index range scan returns the correct due row for ISO values.
          const isoCandidate = db
            .prepare(
              `select * from jobs
                 where status = 'queued' and scheduled_at <= ?
                 order by scheduled_at, id
                 limit 1`,
            )
            .get(now.toISOString()) as JobRow | undefined;
          // Also recover any due row whose scheduled_at is a non-ISO (but
          // Date.parse-valid) string that the lexical `<= ?` comparison skips,
          // then pick the global Date.parse-minimum across both candidates so
          // semantics exactly match the prior JS implementation.
          const nonIsoCandidate = claimNextNonIsoFallback(db, nowMs);
          // Defensive chronological guard: the lexical `scheduled_at <= ?` query
          // can return a row that is actually in the future when scheduled_at
          // carries a non-UTC offset (e.g. `...T09:00:00.000-05:00` sorts before
          // an ISO `now` but is chronologically later). Enqueue normalizes new
          // rows to canonical UTC, so this only guards legacy/edge rows — but it
          // guarantees we never claim a not-yet-due job (matching the JSON
          // backend and the old JS semantics).
          const dueIsoCandidate =
            isoCandidate && Date.parse(isoCandidate.scheduled_at) <= nowMs
              ? isoCandidate
              : undefined;
          const candidate = pickEarlierCandidate(dueIsoCandidate, nonIsoCandidate);
          if (!candidate) {
            db.exec("commit");
            return null;
          }
          const ts = now.toISOString();
          const nextAttempts = candidate.attempts + 1;
          db.prepare(
            `update jobs
               set status = 'running',
                   attempts = ?,
                   started_at = ?,
                   updated_at = ?
             where id = ?`,
          ).run(nextAttempts, ts, ts, candidate.id);
          const updated = db.prepare("select * from jobs where id = ?").get(candidate.id) as
            | JobRow
            | undefined;
          db.exec("commit");
          return updated ? rowToRecord(updated) : null;
        } catch (error) {
          db.exec("rollback");
          throw error;
        }
      } finally {
        db.close();
      }
    },
    sweepStaleRunning(staleAfterMs, now) {
      const db = openDatabase(dbPath);
      try {
        db.exec("begin immediate");
        try {
          const cutoffMs = now.getTime() - staleAfterMs;
          const staleRows = (db
            .prepare("select id, started_at from jobs where status = 'running' and started_at is not null")
            .all() as Array<{ id: string; started_at: string | null }>)
            .filter((row) => {
              if (row.started_at === null) return false;
              const startedMs = Date.parse(row.started_at);
              return !Number.isNaN(startedMs) && startedMs < cutoffMs;
            });
        const ts = now.toISOString();
          const update = db.prepare(
            `update jobs
               set status = 'queued',
                   started_at = null,
                   updated_at = ?
             where id = ?`,
          );
          for (const row of staleRows) {
            update.run(ts, row.id);
          }
          db.exec("commit");
          return staleRows.length;
        } catch (error) {
          db.exec("rollback");
          throw error;
        }
      } finally {
        db.close();
      }
    },
  };
}

interface JobRow {
  id: string;
  workspace_id: string;
  type: string;
  payload: string;
  status: JobStatus;
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

function pickEarlierCandidate(
  left: JobRow | undefined,
  right: JobRow | undefined,
): JobRow | undefined {
  if (!left) return right;
  if (!right) return left;
  const cmp = Date.parse(left.scheduled_at) - Date.parse(right.scheduled_at);
  if (cmp !== 0) return cmp < 0 ? left : right;
  return left.id.localeCompare(right.id) <= 0 ? left : right;
}

function claimNextNonIsoFallback(db: DatabaseSync, nowMs: number): JobRow | undefined {
  // Only reached when the indexed `scheduled_at <= ?` lexical query found no
  // candidate. Recovers queued rows whose scheduled_at is Date.parse-valid but
  // not lexically comparable to the ISO `now` (e.g. RFC-2822 timestamps).
  const isoNow = new Date(nowMs).toISOString();
  const rows = db
    .prepare("select * from jobs where status = 'queued' and scheduled_at > ?")
    .all(isoNow) as unknown as JobRow[];
  return rows
    .filter((row) => {
      const scheduledMs = Date.parse(row.scheduled_at);
      return !Number.isNaN(scheduledMs) && scheduledMs <= nowMs;
    })
    .sort((left, right) => {
      const cmp = Date.parse(left.scheduled_at) - Date.parse(right.scheduled_at);
      if (cmp !== 0) return cmp;
      return left.id.localeCompare(right.id);
    })[0];
}

function upsertRow(db: DatabaseSync, record: JobRecord): void {
  db.prepare(`
    insert or replace into jobs (
      id, workspace_id, type, payload, status, attempts, max_attempts,
      scheduled_at, started_at, completed_at, cron, result, error,
      cancel_requested, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.workspaceId,
    record.type,
    JSON.stringify(record.payload ?? {}),
    record.status,
    record.attempts,
    record.maxAttempts,
    record.scheduledAt,
    record.startedAt ?? null,
    record.completedAt ?? null,
    record.cron ?? null,
    record.result === undefined ? null : JSON.stringify(record.result),
    record.error ?? null,
    record.cancelRequested === undefined ? null : record.cancelRequested ? 1 : 0,
    record.createdAt,
    record.updatedAt,
  );
}

function rowToRecord(row: JobRow): JobRecord {
  const record: JobRecord = {
    id: row.id,
    workspaceId: row.workspace_id,
    type: row.type,
    payload: parsePayload(row.payload),
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    scheduledAt: row.scheduled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.started_at !== null) record.startedAt = row.started_at;
  if (row.completed_at !== null) record.completedAt = row.completed_at;
  if (row.cron !== null) record.cron = row.cron;
  if (row.result !== null) record.result = parseResult(row.result);
  if (row.error !== null) record.error = row.error;
  if (row.cancel_requested !== null) record.cancelRequested = row.cancel_requested === 1;
  return record;
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function parseResult(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function sortAndLimit(records: JobRecord[], limit?: number): JobRecord[] {
  const sorted = records.slice().sort((left, right) => {
    const cmp = right.createdAt.localeCompare(left.createdAt);
    if (cmp !== 0) return cmp;
    return left.id.localeCompare(right.id);
  });
  return sorted.slice(0, clampLimit(limit));
}

function clampLimit(limit?: number): number {
  const requested = limit ?? DEFAULT_LIST_LIMIT;
  return Math.min(Math.max(requested, 0), MAX_LIST_LIMIT);
}

function resolveDbPath(override?: string): string {
  if (override) return resolve(override);
  return resolve(process.cwd(), process.env.PACKETAGENT_DB_PATH ?? DEFAULT_DB_FILE);
}

function openDatabase(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("pragma busy_timeout = 5000");
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  applyMigrations(db);
  return db;
}

function applyMigrations(db: DatabaseSync): void {
  db.exec(
    "create table if not exists schema_migrations (name text primary key, applied_at text not null default (datetime('now')))",
  );
  const appliedRows = db.prepare("select name from schema_migrations order by name").all() as Array<{ name: string }>;
  const alreadyApplied = new Set(appliedRows.map((row) => row.name));
  const migrations = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort();
  for (const name of migrations) {
    if (alreadyApplied.has(name)) continue;
    const sql = readFileSync(resolve(MIGRATIONS_DIR, name), "utf8");
    db.exec("begin");
    try {
      db.exec(sql);
      db.prepare("insert into schema_migrations (name) values (?)").run(name);
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  }
}
