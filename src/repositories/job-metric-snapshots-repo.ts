import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { JobMetricSnapshotRecord, PacketAgentData } from "../packetagent-store.js";
import { loadStore as defaultLoadStore, mutateStore as defaultMutateStore } from "../packetagent-store.js";

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const DEFAULT_DB_FILE = "data/packetagent.sqlite";
const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");

export interface ListJobMetricSnapshotsFilter {
  type?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export interface JobMetricSnapshotsRepository {
  list(filter?: ListJobMetricSnapshotsFilter): JobMetricSnapshotRecord[];
  insertMany(records: JobMetricSnapshotRecord[]): void;
  prune(retainAfterIso: string): number;
  count(): number;
}

export interface JobMetricSnapshotsRepositoryDeps {
  loadStore?: () => PacketAgentData;
  mutateStore?: <T>(mutator: (data: PacketAgentData) => T) => T;
  dbPath?: string;
}

type MaybePromise<T> = T | Promise<T>;

export interface AsyncJobMetricSnapshotsRepository {
  list(filter?: ListJobMetricSnapshotsFilter): Promise<JobMetricSnapshotRecord[]>;
  insertMany(records: JobMetricSnapshotRecord[]): Promise<void>;
  prune(retainAfterIso: string): Promise<number>;
  count(): Promise<number>;
}

export interface AsyncJobMetricSnapshotsRepositoryDeps {
  loadStore?: () => MaybePromise<PacketAgentData>;
  mutateStore?: <T>(mutator: (data: PacketAgentData) => MaybePromise<T>) => MaybePromise<T>;
  repository?: JobMetricSnapshotsRepository;
  dbPath?: string;
}

export function createJobMetricSnapshotsRepository(
  deps: JobMetricSnapshotsRepositoryDeps = {},
): JobMetricSnapshotsRepository {
  if (process.env.PACKETAGENT_STORE === "sqlite") return sqliteJobMetricSnapshotsRepository(deps);
  return jsonJobMetricSnapshotsRepository(deps);
}

export function createAsyncJobMetricSnapshotsRepository(
  deps: AsyncJobMetricSnapshotsRepositoryDeps = {},
): AsyncJobMetricSnapshotsRepository {
  if (deps.repository) return asyncJobMetricSnapshotsRepositoryFromSync(deps.repository);
  if (process.env.PACKETAGENT_STORE === "sqlite") {
    return asyncJobMetricSnapshotsRepositoryFromSync(sqliteJobMetricSnapshotsRepository({ dbPath: deps.dbPath }));
  }
  return asyncJsonJobMetricSnapshotsRepository(deps);
}

export function asyncJobMetricSnapshotsRepositoryFromSync(
  repository: JobMetricSnapshotsRepository,
): AsyncJobMetricSnapshotsRepository {
  return {
    async list(filter) {
      return repository.list(filter);
    },
    async insertMany(records) {
      repository.insertMany(records);
    },
    async prune(retainAfterIso) {
      return repository.prune(retainAfterIso);
    },
    async count() {
      return repository.count();
    },
  };
}

export function jsonJobMetricSnapshotsRepository(
  deps: JobMetricSnapshotsRepositoryDeps = {},
): JobMetricSnapshotsRepository {
  const load = deps.loadStore ?? defaultLoadStore;
  const mutate = deps.mutateStore ?? defaultMutateStore;
  return {
    list(filter = {}) {
      const data = load();
      const collection = Array.isArray(data.jobMetricSnapshots) ? data.jobMetricSnapshots : [];
      return applyListFilter(collection, filter);
    },
    insertMany(records) {
      if (records.length === 0) return;
      mutate((data) => {
        if (!Array.isArray(data.jobMetricSnapshots)) data.jobMetricSnapshots = [];
        const existingIds = new Set(data.jobMetricSnapshots.map((entry) => entry.id));
        for (const record of records) {
          if (existingIds.has(record.id)) {
            const index = data.jobMetricSnapshots.findIndex((entry) => entry.id === record.id);
            if (index >= 0) data.jobMetricSnapshots[index] = record;
          } else {
            data.jobMetricSnapshots.push(record);
            existingIds.add(record.id);
          }
        }
        return null;
      });
    },
    prune(retainAfterIso) {
      const cutoffMs = Date.parse(retainAfterIso);
      return mutate((data) => {
        if (!Array.isArray(data.jobMetricSnapshots)) {
          data.jobMetricSnapshots = [];
          return 0;
        }
        const before = data.jobMetricSnapshots.length;
        data.jobMetricSnapshots = data.jobMetricSnapshots.filter((entry) => {
          const capturedMs = Date.parse(entry.capturedAt);
          if (Number.isNaN(capturedMs)) return true;
          return capturedMs >= cutoffMs;
        });
        return before - data.jobMetricSnapshots.length;
      });
    },
    count() {
      const data = load();
      return Array.isArray(data.jobMetricSnapshots) ? data.jobMetricSnapshots.length : 0;
    },
  };
}

export function asyncJsonJobMetricSnapshotsRepository(
  deps: AsyncJobMetricSnapshotsRepositoryDeps = {},
): AsyncJobMetricSnapshotsRepository {
  const load = deps.loadStore ?? defaultLoadStore;
  const mutate = deps.mutateStore ?? defaultMutateStore;
  return {
    async list(filter = {}) {
      const data = await load();
      const collection = Array.isArray(data.jobMetricSnapshots) ? data.jobMetricSnapshots : [];
      return applyListFilter(collection, filter);
    },
    async insertMany(records) {
      if (records.length === 0) return;
      await mutate((data) => {
        if (!Array.isArray(data.jobMetricSnapshots)) data.jobMetricSnapshots = [];
        const existingIds = new Set(data.jobMetricSnapshots.map((entry) => entry.id));
        for (const record of records) {
          if (existingIds.has(record.id)) {
            const index = data.jobMetricSnapshots.findIndex((entry) => entry.id === record.id);
            if (index >= 0) data.jobMetricSnapshots[index] = record;
          } else {
            data.jobMetricSnapshots.push(record);
            existingIds.add(record.id);
          }
        }
        return null;
      });
    },
    async prune(retainAfterIso) {
      const cutoffMs = Date.parse(retainAfterIso);
      return mutate((data) => {
        if (!Array.isArray(data.jobMetricSnapshots)) {
          data.jobMetricSnapshots = [];
          return 0;
        }
        const before = data.jobMetricSnapshots.length;
        data.jobMetricSnapshots = data.jobMetricSnapshots.filter((entry) => {
          const capturedMs = Date.parse(entry.capturedAt);
          if (Number.isNaN(capturedMs)) return true;
          return capturedMs >= cutoffMs;
        });
        return before - data.jobMetricSnapshots.length;
      });
    },
    async count() {
      const data = await load();
      return Array.isArray(data.jobMetricSnapshots) ? data.jobMetricSnapshots.length : 0;
    },
  };
}

export function sqliteJobMetricSnapshotsRepository(
  deps: JobMetricSnapshotsRepositoryDeps = {},
): JobMetricSnapshotsRepository {
  const dbPath = resolveDbPath(deps.dbPath);
  return {
    list(filter = {}) {
      const db = openDatabase(dbPath);
      try {
        const sql: string[] = ["select * from job_metric_snapshots"];
        const params: Array<string | number> = [];
        const where: string[] = [];
        if (filter.type !== undefined) {
          where.push("type = ?");
          params.push(filter.type);
        }
        if (filter.since !== undefined) {
          where.push("captured_at >= ?");
          params.push(filter.since);
        }
        if (filter.until !== undefined) {
          where.push("captured_at <= ?");
          params.push(filter.until);
        }
        if (where.length > 0) sql.push("where " + where.join(" and "));
        sql.push("order by captured_at asc, id asc");
        const requestedLimit = filter.limit ?? DEFAULT_LIST_LIMIT;
        const limit = Math.min(Math.max(requestedLimit, 0), MAX_LIST_LIMIT);
        sql.push("limit ?");
        params.push(limit);
        const rows = db.prepare(sql.join(" ")).all(...params) as unknown as JobMetricSnapshotRow[];
        return rows.map(rowToRecord);
      } finally {
        db.close();
      }
    },
    insertMany(records) {
      if (records.length === 0) return;
      const db = openDatabase(dbPath);
      try {
        db.exec("begin immediate");
        try {
          const stmt = db.prepare(`
            insert or replace into job_metric_snapshots (
              id, captured_at, type, total_runs, succeeded_runs, failed_runs, canceled_runs,
              last_run_started_at, last_run_finished_at, last_duration_ms, average_duration_ms, p95_duration_ms
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          for (const record of records) {
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
          db.exec("commit");
        } catch (error) {
          db.exec("rollback");
          throw error;
        }
      } finally {
        db.close();
      }
    },
    prune(retainAfterIso) {
      const db = openDatabase(dbPath);
      try {
        const result = db.prepare("delete from job_metric_snapshots where captured_at < ?").run(retainAfterIso);
        return Number(result.changes ?? 0);
      } finally {
        db.close();
      }
    },
    count() {
      const db = openDatabase(dbPath);
      try {
        const row = db.prepare("select count(*) as count from job_metric_snapshots").get() as { count: number } | undefined;
        return row?.count ?? 0;
      } finally {
        db.close();
      }
    },
  };
}

interface JobMetricSnapshotRow {
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
}

function rowToRecord(row: JobMetricSnapshotRow): JobMetricSnapshotRecord {
  return {
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
  };
}

function applyListFilter(
  collection: JobMetricSnapshotRecord[],
  filter: ListJobMetricSnapshotsFilter,
): JobMetricSnapshotRecord[] {
  const sinceMs = filter.since ? Date.parse(filter.since) : null;
  const untilMs = filter.until ? Date.parse(filter.until) : null;
  const filtered = collection.filter((entry) => {
    if (filter.type !== undefined && entry.type !== filter.type) return false;
    const capturedMs = Date.parse(entry.capturedAt);
    if (sinceMs !== null && !Number.isNaN(sinceMs) && capturedMs < sinceMs) return false;
    if (untilMs !== null && !Number.isNaN(untilMs) && capturedMs > untilMs) return false;
    return true;
  });
  filtered.sort((left, right) => left.capturedAt.localeCompare(right.capturedAt) || left.id.localeCompare(right.id));
  const requestedLimit = filter.limit ?? DEFAULT_LIST_LIMIT;
  const limit = Math.min(Math.max(requestedLimit, 0), MAX_LIST_LIMIT);
  return filtered.slice(0, limit);
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
  db.exec("create table if not exists schema_migrations (name text primary key, applied_at text not null default (datetime('now')))");
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
