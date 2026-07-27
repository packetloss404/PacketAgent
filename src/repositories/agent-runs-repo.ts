import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentRunLogEntry,
  AgentRunRecord,
  AgentRunStatus,
  AgentRunStep,
  AgentRunToolCall,
  AgentTriggerKind,
  PacketAgentData,
} from "../packetagent-store.js";
import { loadStore as defaultLoadStore, mutateStore as defaultMutateStore } from "../packetagent-store.js";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_DB_FILE = "data/packetagent.sqlite";
const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");

export interface AgentRunsRepository {
  list(workspaceId: string, limit?: number): AgentRunRecord[];
  listForAgent(workspaceId: string, agentId: string, limit?: number): AgentRunRecord[];
  find(workspaceId: string, runId: string): AgentRunRecord | null;
  upsert(record: AgentRunRecord): void;
  count(): number;
}

export interface AgentRunsRepositoryDeps {
  loadStore?: () => PacketAgentData;
  mutateStore?: <T>(mutator: (data: PacketAgentData) => T) => T;
  dbPath?: string;
}

type MaybePromise<T> = T | Promise<T>;

export interface AsyncAgentRunsRepository {
  list(workspaceId: string, limit?: number): Promise<AgentRunRecord[]>;
  listForAgent(workspaceId: string, agentId: string, limit?: number): Promise<AgentRunRecord[]>;
  find(workspaceId: string, runId: string): Promise<AgentRunRecord | null>;
  upsert(record: AgentRunRecord): Promise<void>;
  count(): Promise<number>;
}

export interface AsyncAgentRunsRepositoryDeps {
  loadStore?: () => MaybePromise<PacketAgentData>;
  mutateStore?: <T>(mutator: (data: PacketAgentData) => MaybePromise<T>) => MaybePromise<T>;
  repository?: AgentRunsRepository;
  dbPath?: string;
}

export function createAgentRunsRepository(
  deps: AgentRunsRepositoryDeps = {},
): AgentRunsRepository {
  if (process.env.PACKETAGENT_STORE === "sqlite") return sqliteAgentRunsRepository(deps);
  return jsonAgentRunsRepository(deps);
}

export function createAsyncAgentRunsRepository(
  deps: AsyncAgentRunsRepositoryDeps = {},
): AsyncAgentRunsRepository {
  if (deps.repository) return asyncAgentRunsRepositoryFromSync(deps.repository);
  if (process.env.PACKETAGENT_STORE === "sqlite") {
    return asyncAgentRunsRepositoryFromSync(sqliteAgentRunsRepository({ dbPath: deps.dbPath }));
  }
  return asyncJsonAgentRunsRepository(deps);
}

export function asyncAgentRunsRepositoryFromSync(
  repository: AgentRunsRepository,
): AsyncAgentRunsRepository {
  return {
    async list(workspaceId, limit) {
      return repository.list(workspaceId, limit);
    },
    async listForAgent(workspaceId, agentId, limit) {
      return repository.listForAgent(workspaceId, agentId, limit);
    },
    async find(workspaceId, runId) {
      return repository.find(workspaceId, runId);
    },
    async upsert(record) {
      repository.upsert(record);
    },
    async count() {
      return repository.count();
    },
  };
}

export function jsonAgentRunsRepository(
  deps: AgentRunsRepositoryDeps = {},
): AgentRunsRepository {
  const load = deps.loadStore ?? defaultLoadStore;
  const mutate = deps.mutateStore ?? defaultMutateStore;
  return {
    list(workspaceId, limit) {
      const data = load();
      const collection = Array.isArray(data.agentRuns) ? data.agentRuns : [];
      const filtered = collection.filter((entry) => entry.workspaceId === workspaceId);
      return sortAndLimit(filtered, limit);
    },
    listForAgent(workspaceId, agentId, limit) {
      const data = load();
      const collection = Array.isArray(data.agentRuns) ? data.agentRuns : [];
      const filtered = collection.filter(
        (entry) => entry.workspaceId === workspaceId && entry.agentId === agentId,
      );
      return sortAndLimit(filtered, limit);
    },
    find(workspaceId, runId) {
      const data = load();
      const collection = Array.isArray(data.agentRuns) ? data.agentRuns : [];
      return collection.find((entry) => entry.workspaceId === workspaceId && entry.id === runId) ?? null;
    },
    upsert(record) {
      mutate((data) => {
        if (!Array.isArray(data.agentRuns)) data.agentRuns = [];
        const index = data.agentRuns.findIndex((entry) => entry.id === record.id);
        if (index >= 0) {
          data.agentRuns[index] = record;
        } else {
          data.agentRuns.push(record);
        }
        return null;
      });
    },
    count() {
      const data = load();
      return Array.isArray(data.agentRuns) ? data.agentRuns.length : 0;
    },
  };
}

export function asyncJsonAgentRunsRepository(
  deps: AsyncAgentRunsRepositoryDeps = {},
): AsyncAgentRunsRepository {
  const load = deps.loadStore ?? defaultLoadStore;
  const mutate = deps.mutateStore ?? defaultMutateStore;
  return {
    async list(workspaceId, limit) {
      const data = await load();
      const collection = Array.isArray(data.agentRuns) ? data.agentRuns : [];
      const filtered = collection.filter((entry) => entry.workspaceId === workspaceId);
      return sortAndLimit(filtered, limit);
    },
    async listForAgent(workspaceId, agentId, limit) {
      const data = await load();
      const collection = Array.isArray(data.agentRuns) ? data.agentRuns : [];
      const filtered = collection.filter(
        (entry) => entry.workspaceId === workspaceId && entry.agentId === agentId,
      );
      return sortAndLimit(filtered, limit);
    },
    async find(workspaceId, runId) {
      const data = await load();
      const collection = Array.isArray(data.agentRuns) ? data.agentRuns : [];
      return collection.find((entry) => entry.workspaceId === workspaceId && entry.id === runId) ?? null;
    },
    async upsert(record) {
      await mutate((data) => {
        if (!Array.isArray(data.agentRuns)) data.agentRuns = [];
        const index = data.agentRuns.findIndex((entry) => entry.id === record.id);
        if (index >= 0) {
          data.agentRuns[index] = record;
        } else {
          data.agentRuns.push(record);
        }
        return null;
      });
    },
    async count() {
      const data = await load();
      return Array.isArray(data.agentRuns) ? data.agentRuns.length : 0;
    },
  };
}

export function sqliteAgentRunsRepository(
  deps: AgentRunsRepositoryDeps = {},
): AgentRunsRepository {
  const dbPath = resolveDbPath(deps.dbPath);
  return {
    list(workspaceId, limit) {
      const db = openDatabase(dbPath);
      try {
        const cap = clampLimit(limit);
        const rows = db
          .prepare(
            "select * from agent_runs where workspace_id = ? order by created_at desc, id asc limit ?",
          )
          .all(workspaceId, cap) as unknown as AgentRunRow[];
        return rows.map(rowToRecord);
      } finally {
        db.close();
      }
    },
    listForAgent(workspaceId, agentId, limit) {
      const db = openDatabase(dbPath);
      try {
        const cap = clampLimit(limit);
        const rows = db
          .prepare(
            "select * from agent_runs where workspace_id = ? and agent_id = ? order by created_at desc, id asc limit ?",
          )
          .all(workspaceId, agentId, cap) as unknown as AgentRunRow[];
        return rows.map(rowToRecord);
      } finally {
        db.close();
      }
    },
    find(workspaceId, runId) {
      const db = openDatabase(dbPath);
      try {
        const row = db
          .prepare("select * from agent_runs where workspace_id = ? and id = ?")
          .get(workspaceId, runId) as AgentRunRow | undefined;
        return row ? rowToRecord(row) : null;
      } finally {
        db.close();
      }
    },
    upsert(record) {
      const db = openDatabase(dbPath);
      try {
        db.prepare(`
          insert or replace into agent_runs (
            id, workspace_id, agent_id, title, status, trigger_kind,
            started_at, completed_at, inputs, output, error,
            logs, tool_calls, transcript, model_used, cost_usd,
            created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          record.id,
          record.workspaceId,
          record.agentId ?? null,
          record.title,
          record.status,
          record.triggerKind ?? null,
          record.startedAt ?? null,
          record.completedAt ?? null,
          record.inputs === undefined ? null : JSON.stringify(record.inputs),
          record.output ?? null,
          record.error ?? null,
          JSON.stringify(record.logs ?? []),
          record.toolCalls === undefined ? null : JSON.stringify(record.toolCalls),
          record.transcript === undefined ? null : JSON.stringify(record.transcript),
          record.modelUsed ?? null,
          record.costUsd ?? null,
          record.createdAt,
          record.updatedAt,
        );
      } finally {
        db.close();
      }
    },
    count() {
      const db = openDatabase(dbPath);
      try {
        const row = db.prepare("select count(*) as count from agent_runs").get() as
          | { count: number }
          | undefined;
        return row?.count ?? 0;
      } finally {
        db.close();
      }
    },
  };
}

interface AgentRunRow {
  id: string;
  workspace_id: string;
  agent_id: string | null;
  title: string;
  status: AgentRunStatus;
  trigger_kind: AgentTriggerKind | null;
  started_at: string | null;
  completed_at: string | null;
  inputs: string | null;
  output: string | null;
  error: string | null;
  logs: string;
  tool_calls: string | null;
  transcript: string | null;
  model_used: string | null;
  cost_usd: number | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: AgentRunRow): AgentRunRecord {
  const record: AgentRunRecord = {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    status: row.status,
    logs: parseJsonArray<AgentRunLogEntry>(row.logs),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.agent_id !== null) record.agentId = row.agent_id;
  if (row.trigger_kind !== null) record.triggerKind = row.trigger_kind;
  if (row.transcript !== null) record.transcript = parseJsonArray<AgentRunStep>(row.transcript);
  if (row.started_at !== null) record.startedAt = row.started_at;
  if (row.completed_at !== null) record.completedAt = row.completed_at;
  if (row.inputs !== null) record.inputs = parseInputs(row.inputs);
  if (row.output !== null) record.output = row.output;
  if (row.error !== null) record.error = row.error;
  if (row.tool_calls !== null) record.toolCalls = parseJsonArray<AgentRunToolCall>(row.tool_calls);
  if (row.model_used !== null) record.modelUsed = row.model_used;
  if (row.cost_usd !== null) record.costUsd = row.cost_usd;
  return record;
}

function parseJsonArray<T>(raw: string | null): T[] {
  if (raw === null || raw === undefined) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseInputs(raw: string): Record<string, string | number | boolean> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string | number | boolean>;
    }
    return {};
  } catch {
    return {};
  }
}

function sortAndLimit(records: AgentRunRecord[], limit?: number): AgentRunRecord[] {
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
