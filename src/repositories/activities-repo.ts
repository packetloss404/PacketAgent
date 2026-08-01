import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PACKETAGENT_MIGRATIONS_DIR } from "../db/migrations-path.js";
import { DatabaseSync } from "node:sqlite";
import type { ActivityRecord, PacketAgentData } from "../packetagent-store.js";
import {
  loadStore as defaultLoadStore,
  mutateStore as defaultMutateStore,
} from "../packetagent-store.js";

const DEFAULT_DB_FILE = "data/packetagent.sqlite";
const MIGRATIONS_DIR = PACKETAGENT_MIGRATIONS_DIR;

export interface ListActivitiesFilter {
  workspaceId: string;
  limit?: number;
}

export interface ActivitiesRepository {
  list(filter: ListActivitiesFilter): ActivityRecord[];
  find(id: string): ActivityRecord | null;
  upsert(record: ActivityRecord): void;
  count(): number;
}

export interface ActivitiesRepositoryDeps {
  loadStore?: () => PacketAgentData;
  mutateStore?: <T>(mutator: (data: PacketAgentData) => T) => T;
  dbPath?: string;
}

type MaybePromise<T> = T | Promise<T>;

export interface AsyncActivitiesRepository {
  list(filter: ListActivitiesFilter): Promise<ActivityRecord[]>;
  find(id: string): Promise<ActivityRecord | null>;
  upsert(record: ActivityRecord): Promise<void>;
  count(): Promise<number>;
}

export interface AsyncActivitiesRepositoryDeps {
  loadStore?: () => MaybePromise<PacketAgentData>;
  mutateStore?: <T>(mutator: (data: PacketAgentData) => MaybePromise<T>) => MaybePromise<T>;
  repository?: ActivitiesRepository;
  dbPath?: string;
}

export function createActivitiesRepository(
  deps: ActivitiesRepositoryDeps = {},
): ActivitiesRepository {
  if (process.env.PACKETAGENT_STORE === "sqlite") return sqliteActivitiesRepository(deps);
  return jsonActivitiesRepository(deps);
}

export function createAsyncActivitiesRepository(
  deps: AsyncActivitiesRepositoryDeps = {},
): AsyncActivitiesRepository {
  if (deps.repository) return asyncActivitiesRepositoryFromSync(deps.repository);
  if (process.env.PACKETAGENT_STORE === "sqlite") {
    return asyncActivitiesRepositoryFromSync(sqliteActivitiesRepository({ dbPath: deps.dbPath }));
  }
  return asyncJsonActivitiesRepository(deps);
}

export function asyncActivitiesRepositoryFromSync(
  repository: ActivitiesRepository,
): AsyncActivitiesRepository {
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
    async count() {
      return repository.count();
    },
  };
}

export function jsonActivitiesRepository(
  deps: ActivitiesRepositoryDeps = {},
): ActivitiesRepository {
  const load = deps.loadStore ?? defaultLoadStore;
  const mutate = deps.mutateStore ?? defaultMutateStore;
  return {
    list(filter) {
      const data = load();
      const collection = Array.isArray(data.activities) ? data.activities : [];
      const filtered = collection.filter((entry) => entry.workspaceId === filter.workspaceId);
      return sortAndLimit(filtered, filter.limit);
    },
    find(id) {
      const data = load();
      const collection = Array.isArray(data.activities) ? data.activities : [];
      return collection.find((entry) => entry.id === id) ?? null;
    },
    upsert(record) {
      mutate((data) => {
        if (!Array.isArray(data.activities)) data.activities = [];
        const index = data.activities.findIndex((entry) => entry.id === record.id);
        if (index >= 0) {
          data.activities[index] = record;
        } else {
          data.activities.push(record);
        }
        return null;
      });
    },
    count() {
      const data = load();
      return Array.isArray(data.activities) ? data.activities.length : 0;
    },
  };
}

export function asyncJsonActivitiesRepository(
  deps: AsyncActivitiesRepositoryDeps = {},
): AsyncActivitiesRepository {
  const load = deps.loadStore ?? defaultLoadStore;
  const mutate = deps.mutateStore ?? defaultMutateStore;
  return {
    async list(filter) {
      const data = await load();
      const collection = Array.isArray(data.activities) ? data.activities : [];
      const filtered = collection.filter((entry) => entry.workspaceId === filter.workspaceId);
      return sortAndLimit(filtered, filter.limit);
    },
    async find(id) {
      const data = await load();
      const collection = Array.isArray(data.activities) ? data.activities : [];
      return collection.find((entry) => entry.id === id) ?? null;
    },
    async upsert(record) {
      await mutate((data) => {
        if (!Array.isArray(data.activities)) data.activities = [];
        const index = data.activities.findIndex((entry) => entry.id === record.id);
        if (index >= 0) {
          data.activities[index] = record;
        } else {
          data.activities.push(record);
        }
        return null;
      });
    },
    async count() {
      const data = await load();
      return Array.isArray(data.activities) ? data.activities.length : 0;
    },
  };
}

export function sqliteActivitiesRepository(
  deps: ActivitiesRepositoryDeps = {},
): ActivitiesRepository {
  const dbPath = resolveDbPath(deps.dbPath);
  return {
    list(filter) {
      const db = openDatabase(dbPath);
      try {
        const sql: string[] = [
          "select id, workspace_id, occurred_at, type, payload from activities where workspace_id = ? order by occurred_at desc, id desc",
        ];
        const params: Array<string | number> = [filter.workspaceId];
        if (isPositiveLimit(filter.limit)) {
          sql.push("limit ?");
          params.push(filter.limit);
        }
        const rows = db.prepare(sql.join(" ")).all(...params) as unknown as ActivityRow[];
        return rows.map(rowToRecord);
      } finally {
        db.close();
      }
    },
    find(id) {
      const db = openDatabase(dbPath);
      try {
        const row = db
          .prepare(
            "select id, workspace_id, occurred_at, type, payload from activities where id = ?",
          )
          .get(id) as ActivityRow | undefined;
        return row ? rowToRecord(row) : null;
      } finally {
        db.close();
      }
    },
    upsert(record) {
      const db = openDatabase(dbPath);
      try {
        db.prepare(
          `insert or replace into activities (
             id, workspace_id, occurred_at, type, payload, user_id, related_subject
           ) values (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          record.id,
          record.workspaceId,
          record.occurredAt,
          record.event,
          JSON.stringify(record),
          userId(record),
          null,
        );
      } finally {
        db.close();
      }
    },
    count() {
      const db = openDatabase(dbPath);
      try {
        const row = db.prepare("select count(*) as count from activities").get() as
          | { count: number }
          | undefined;
        return row?.count ?? 0;
      } finally {
        db.close();
      }
    },
  };
}

interface ActivityRow {
  id: string;
  workspace_id: string;
  occurred_at: string;
  type: string;
  payload: string;
}

function rowToRecord(row: ActivityRow): ActivityRecord {
  try {
    return JSON.parse(row.payload) as ActivityRecord;
  } catch {
    // A corrupt payload must not break list()/find() for the whole workspace.
    // Fall back to a minimally-valid record reconstructed from the indexed columns.
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      scope: "workspace",
      event: row.type,
      occurredAt: row.occurred_at,
      actor: { type: "system", id: "system" },
      data: {},
    };
  }
}

function userId(record: ActivityRecord): string | null {
  return record.actor.type === "user" ? record.actor.id : null;
}

function sortAndLimit(records: ActivityRecord[], limit?: number): ActivityRecord[] {
  const sorted = records.slice().sort((left, right) => {
    const cmp = right.occurredAt.localeCompare(left.occurredAt);
    if (cmp !== 0) return cmp;
    return right.id.localeCompare(left.id);
  });
  return isPositiveLimit(limit) ? sorted.slice(0, limit) : sorted;
}

function isPositiveLimit(limit: number | undefined): limit is number {
  return typeof limit === "number" && limit > 0;
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
  const appliedRows = db
    .prepare("select name from schema_migrations order by name")
    .all() as Array<{ name: string }>;
  const alreadyApplied = new Set(appliedRows.map((row) => row.name));
  const migrations = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
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
