/**
 * Sandbox exec persistence layer.
 *
 * Mirrors the existing dual-write convention: when PACKETAGENT_STORE=sqlite the
 * canonical store is a sqlite table backed by the migrations under
 * src/db/migrations/. Otherwise the data lives in the JSON store under a new
 * `sandboxExecs` collection.
 */

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  loadStore as defaultLoadStore,
  mutateStore as defaultMutateStore,
  type PacketAgentData,
} from "../packetagent-store.js";
import type {
  SandboxDriver as SandboxDriverId,
  SandboxExecRecord,
  SandboxExecStatus,
} from "./types.js";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_DB_FILE = "data/packetagent.sqlite";
const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");

export interface SandboxStoreFilters {
  appId?: string;
  status?: SandboxExecStatus;
  limit?: number;
}

export interface SandboxStore {
  insertExec(record: SandboxExecRecord): Promise<SandboxExecRecord>;
  updateExec(id: string, patch: Partial<SandboxExecRecord>): Promise<SandboxExecRecord | null>;
  listExecs(workspaceId: string, filters?: SandboxStoreFilters): Promise<SandboxExecRecord[]>;
  getExec(workspaceId: string, id: string): Promise<SandboxExecRecord | null>;
}

export interface SandboxStoreDeps {
  loadStore?: () => PacketAgentData | Promise<PacketAgentData>;
  mutateStore?: <T>(mutator: (data: PacketAgentData) => T) => T | Promise<T>;
  dbPath?: string;
}

interface MutablePacketAgentData extends PacketAgentData {
  sandboxExecs?: SandboxExecRecord[];
}

export function createSandboxStore(deps: SandboxStoreDeps = {}): SandboxStore {
  if (process.env.PACKETAGENT_STORE === "sqlite") return createSqliteSandboxStore(deps);
  return createJsonSandboxStore(deps);
}

export function createJsonSandboxStore(deps: SandboxStoreDeps = {}): SandboxStore {
  const load = deps.loadStore ?? defaultLoadStore;
  const mutate = deps.mutateStore ?? defaultMutateStore;

  return {
    async insertExec(record) {
      await mutate((data) => {
        const collection = ensureSandboxCollection(data as MutablePacketAgentData);
        const idx = collection.findIndex((entry) => entry.id === record.id);
        if (idx >= 0) collection[idx] = record;
        else collection.push(record);
        return null;
      });
      return record;
    },

    async updateExec(id, patch) {
      const result = await mutate((data) => {
        const collection = ensureSandboxCollection(data as MutablePacketAgentData);
        const idx = collection.findIndex((entry) => entry.id === id);
        if (idx < 0) return null;
        const existing = collection[idx]!;
        const next: SandboxExecRecord = {
          ...existing,
          ...patch,
          updatedAt: patch.updatedAt ?? new Date().toISOString(),
        };
        collection[idx] = next;
        return next;
      });
      return result ?? null;
    },

    async listExecs(workspaceId, filters = {}) {
      const data = (await load()) as MutablePacketAgentData;
      const collection = Array.isArray(data.sandboxExecs) ? data.sandboxExecs : [];
      const filtered = collection.filter((entry) => {
        if (entry.workspaceId !== workspaceId) return false;
        if (filters.appId !== undefined && entry.appId !== filters.appId) return false;
        if (filters.status !== undefined && entry.status !== filters.status) return false;
        return true;
      });
      return sortAndLimit(filtered, filters.limit);
    },

    async getExec(workspaceId, id) {
      const data = (await load()) as MutablePacketAgentData;
      const collection = Array.isArray(data.sandboxExecs) ? data.sandboxExecs : [];
      return (
        collection.find((entry) => entry.workspaceId === workspaceId && entry.id === id) ?? null
      );
    },
  };
}

function ensureSandboxCollection(data: MutablePacketAgentData): SandboxExecRecord[] {
  if (!Array.isArray(data.sandboxExecs)) data.sandboxExecs = [];
  return data.sandboxExecs;
}

export function createSqliteSandboxStore(deps: SandboxStoreDeps = {}): SandboxStore {
  const dbPath = resolveDbPath(deps.dbPath);
  // We also dual-write to the JSON store so that other read paths see the row.
  const jsonStore = createJsonSandboxStore({
    ...(deps.loadStore ? { loadStore: deps.loadStore } : {}),
    ...(deps.mutateStore ? { mutateStore: deps.mutateStore } : {}),
  });

  return {
    async insertExec(record) {
      const db = openDatabase(dbPath);
      try {
        upsertRow(db, record);
      } finally {
        db.close();
      }
      await jsonStore.insertExec(record);
      return record;
    },

    async updateExec(id, patch) {
      const next = await jsonStore.updateExec(id, patch);
      if (!next) return null;
      const db = openDatabase(dbPath);
      try {
        upsertRow(db, next);
      } finally {
        db.close();
      }
      return next;
    },

    async listExecs(workspaceId, filters = {}) {
      const db = openDatabase(dbPath);
      try {
        const cap = clampLimit(filters.limit);
        const conditions: string[] = ["workspace_id = ?"];
        const values: unknown[] = [workspaceId];
        if (filters.appId !== undefined) {
          conditions.push("app_id = ?");
          values.push(filters.appId);
        }
        if (filters.status !== undefined) {
          conditions.push("status = ?");
          values.push(filters.status);
        }
        const sql = `select * from sandbox_execs where ${conditions.join(" and ")} order by created_at desc, id asc limit ?`;
        values.push(cap);
        const rows = db.prepare(sql).all(...(values as never[])) as unknown as SandboxExecRow[];
        return rows.map(rowToRecord);
      } finally {
        db.close();
      }
    },

    async getExec(workspaceId, id) {
      const db = openDatabase(dbPath);
      try {
        const row = db
          .prepare("select * from sandbox_execs where workspace_id = ? and id = ?")
          .get(workspaceId, id) as SandboxExecRow | undefined;
        return row ? rowToRecord(row) : null;
      } finally {
        db.close();
      }
    },
  };
}

interface SandboxExecRow {
  id: string;
  workspace_id: string;
  app_id: string | null;
  checkpoint_id: string | null;
  sandbox_id: string;
  driver: SandboxDriverId;
  runtime: string;
  command: string;
  working_dir: string;
  env: string | null;
  status: SandboxExecStatus;
  exit_code: number | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  stdout_preview: string | null;
  stderr_preview: string | null;
  error_message: string | null;
  cpu_limit_ms: number | null;
  memory_limit_mb: number | null;
  created_at: string;
  updated_at: string;
}

function upsertRow(db: DatabaseSync, record: SandboxExecRecord): void {
  db.prepare(
    `
    insert or replace into sandbox_execs (
      id, workspace_id, app_id, checkpoint_id, sandbox_id, driver, runtime,
      command, working_dir, env, status, exit_code, started_at, completed_at,
      duration_ms, stdout_preview, stderr_preview, error_message,
      cpu_limit_ms, memory_limit_mb, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    record.id,
    record.workspaceId,
    record.appId ?? null,
    record.checkpointId ?? null,
    record.sandboxId,
    record.driver,
    record.runtime,
    record.command,
    record.workingDir,
    record.env === undefined ? null : JSON.stringify(record.env),
    record.status,
    record.exitCode ?? null,
    record.startedAt ?? null,
    record.completedAt ?? null,
    record.durationMs ?? null,
    record.stdoutPreview ?? null,
    record.stderrPreview ?? null,
    record.errorMessage ?? null,
    record.cpuLimitMs ?? null,
    record.memoryLimitMb ?? null,
    record.createdAt,
    record.updatedAt,
  );
}

function rowToRecord(row: SandboxExecRow): SandboxExecRecord {
  const record: SandboxExecRecord = {
    id: row.id,
    workspaceId: row.workspace_id,
    sandboxId: row.sandbox_id,
    driver: row.driver,
    runtime: row.runtime,
    command: row.command,
    workingDir: row.working_dir,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.app_id !== null) record.appId = row.app_id;
  if (row.checkpoint_id !== null) record.checkpointId = row.checkpoint_id;
  if (row.env !== null) {
    try {
      const parsed = JSON.parse(row.env);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        record.env = parsed as Record<string, string>;
      }
    } catch {
      /* ignore */
    }
  }
  if (row.exit_code !== null) record.exitCode = row.exit_code;
  if (row.started_at !== null) record.startedAt = row.started_at;
  if (row.completed_at !== null) record.completedAt = row.completed_at;
  if (row.duration_ms !== null) record.durationMs = row.duration_ms;
  if (row.stdout_preview !== null) record.stdoutPreview = row.stdout_preview;
  if (row.stderr_preview !== null) record.stderrPreview = row.stderr_preview;
  if (row.error_message !== null) record.errorMessage = row.error_message;
  if (row.cpu_limit_ms !== null) record.cpuLimitMs = row.cpu_limit_ms;
  if (row.memory_limit_mb !== null) record.memoryLimitMb = row.memory_limit_mb;
  return record;
}

function sortAndLimit(records: SandboxExecRecord[], limit?: number): SandboxExecRecord[] {
  const sorted = records.slice().sort((left, right) => {
    const cmp = right.createdAt.localeCompare(left.createdAt);
    if (cmp !== 0) return cmp;
    return left.id.localeCompare(right.id);
  });
  return sorted.slice(0, clampLimit(limit));
}

function clampLimit(limit?: number): number {
  const requested = limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isFinite(requested)) return DEFAULT_LIST_LIMIT;
  return Math.min(Math.max(Math.floor(requested), 0), MAX_LIST_LIMIT);
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
