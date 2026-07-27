import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type {
  InvitationEmailDeliveryMode,
  InvitationEmailDeliveryRecord,
  InvitationEmailDeliveryStatus,
  PacketAgentData,
} from "../packetagent-store.js";
import { loadStore as defaultLoadStore, mutateStore as defaultMutateStore } from "../packetagent-store.js";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_DB_FILE = "data/packetagent.sqlite";
const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");

export interface ListInvitationEmailDeliveriesFilter {
  workspaceId: string;
  invitationId?: string;
  limit?: number;
}

export interface InvitationEmailDeliveriesRepository {
  list(filter: ListInvitationEmailDeliveriesFilter): InvitationEmailDeliveryRecord[];
  find(id: string): InvitationEmailDeliveryRecord | null;
  upsert(record: InvitationEmailDeliveryRecord): void;
  count(): number;
}

export interface InvitationEmailDeliveriesRepositoryDeps {
  loadStore?: () => PacketAgentData;
  mutateStore?: <T>(mutator: (data: PacketAgentData) => T) => T;
  dbPath?: string;
}

type MaybePromise<T> = T | Promise<T>;

export interface AsyncInvitationEmailDeliveriesRepository {
  list(filter: ListInvitationEmailDeliveriesFilter): Promise<InvitationEmailDeliveryRecord[]>;
  find(id: string): Promise<InvitationEmailDeliveryRecord | null>;
  upsert(record: InvitationEmailDeliveryRecord): Promise<void>;
  count(): Promise<number>;
}

export interface AsyncInvitationEmailDeliveriesRepositoryDeps {
  loadStore?: () => MaybePromise<PacketAgentData>;
  mutateStore?: <T>(mutator: (data: PacketAgentData) => MaybePromise<T>) => MaybePromise<T>;
  repository?: InvitationEmailDeliveriesRepository;
  dbPath?: string;
}

export function createInvitationEmailDeliveriesRepository(
  deps: InvitationEmailDeliveriesRepositoryDeps = {},
): InvitationEmailDeliveriesRepository {
  if (process.env.PACKETAGENT_STORE === "sqlite") return sqliteInvitationEmailDeliveriesRepository(deps);
  return jsonInvitationEmailDeliveriesRepository(deps);
}

export function createAsyncInvitationEmailDeliveriesRepository(
  deps: AsyncInvitationEmailDeliveriesRepositoryDeps = {},
): AsyncInvitationEmailDeliveriesRepository {
  if (deps.repository) return asyncInvitationEmailDeliveriesRepositoryFromSync(deps.repository);
  if (process.env.PACKETAGENT_STORE === "sqlite") {
    return asyncInvitationEmailDeliveriesRepositoryFromSync(
      sqliteInvitationEmailDeliveriesRepository({ dbPath: deps.dbPath }),
    );
  }
  return asyncJsonInvitationEmailDeliveriesRepository(deps);
}

export function asyncInvitationEmailDeliveriesRepositoryFromSync(
  repository: InvitationEmailDeliveriesRepository,
): AsyncInvitationEmailDeliveriesRepository {
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

export function jsonInvitationEmailDeliveriesRepository(
  deps: InvitationEmailDeliveriesRepositoryDeps = {},
): InvitationEmailDeliveriesRepository {
  const load = deps.loadStore ?? defaultLoadStore;
  const mutate = deps.mutateStore ?? defaultMutateStore;
  return {
    list(filter) {
      const data = load();
      const collection = Array.isArray(data.invitationEmailDeliveries) ? data.invitationEmailDeliveries : [];
      return applyListFilter(collection, filter);
    },
    find(id) {
      const data = load();
      const collection = Array.isArray(data.invitationEmailDeliveries) ? data.invitationEmailDeliveries : [];
      return collection.find((entry) => entry.id === id) ?? null;
    },
    upsert(record) {
      mutate((data) => {
        if (!Array.isArray(data.invitationEmailDeliveries)) data.invitationEmailDeliveries = [];
        const index = data.invitationEmailDeliveries.findIndex((entry) => entry.id === record.id);
        if (index >= 0) {
          data.invitationEmailDeliveries[index] = record;
        } else {
          data.invitationEmailDeliveries.push(record);
        }
        return null;
      });
    },
    count() {
      const data = load();
      return Array.isArray(data.invitationEmailDeliveries) ? data.invitationEmailDeliveries.length : 0;
    },
  };
}

export function asyncJsonInvitationEmailDeliveriesRepository(
  deps: AsyncInvitationEmailDeliveriesRepositoryDeps = {},
): AsyncInvitationEmailDeliveriesRepository {
  const load = deps.loadStore ?? defaultLoadStore;
  const mutate = deps.mutateStore ?? defaultMutateStore;
  return {
    async list(filter) {
      const data = await load();
      const collection = Array.isArray(data.invitationEmailDeliveries) ? data.invitationEmailDeliveries : [];
      return applyListFilter(collection, filter);
    },
    async find(id) {
      const data = await load();
      const collection = Array.isArray(data.invitationEmailDeliveries) ? data.invitationEmailDeliveries : [];
      return collection.find((entry) => entry.id === id) ?? null;
    },
    async upsert(record) {
      await mutate((data) => {
        if (!Array.isArray(data.invitationEmailDeliveries)) data.invitationEmailDeliveries = [];
        const index = data.invitationEmailDeliveries.findIndex((entry) => entry.id === record.id);
        if (index >= 0) {
          data.invitationEmailDeliveries[index] = record;
        } else {
          data.invitationEmailDeliveries.push(record);
        }
        return null;
      });
    },
    async count() {
      const data = await load();
      return Array.isArray(data.invitationEmailDeliveries) ? data.invitationEmailDeliveries.length : 0;
    },
  };
}

export function sqliteInvitationEmailDeliveriesRepository(
  deps: InvitationEmailDeliveriesRepositoryDeps = {},
): InvitationEmailDeliveriesRepository {
  const dbPath = resolveDbPath(deps.dbPath);
  return {
    list(filter) {
      const db = openDatabase(dbPath);
      try {
        const sql: string[] = ["select * from invitation_email_deliveries"];
        const params: Array<string | number> = [];
        const where: string[] = ["workspace_id = ?"];
        params.push(filter.workspaceId);
        if (filter.invitationId !== undefined) {
          where.push("invitation_id = ?");
          params.push(filter.invitationId);
        }
        sql.push("where " + where.join(" and "));
        sql.push("order by created_at desc, id asc");
        const requestedLimit = filter.limit ?? DEFAULT_LIST_LIMIT;
        const limit = Math.min(Math.max(requestedLimit, 0), MAX_LIST_LIMIT);
        sql.push("limit ?");
        params.push(limit);
        const rows = db.prepare(sql.join(" ")).all(...params) as unknown as InvitationEmailDeliveryRow[];
        return rows.map(rowToRecord);
      } finally {
        db.close();
      }
    },
    find(id) {
      const db = openDatabase(dbPath);
      try {
        const row = db
          .prepare("select * from invitation_email_deliveries where id = ?")
          .get(id) as InvitationEmailDeliveryRow | undefined;
        return row ? rowToRecord(row) : null;
      } finally {
        db.close();
      }
    },
    upsert(record) {
      const db = openDatabase(dbPath);
      try {
        db.prepare(
          `insert or replace into invitation_email_deliveries (
             id, workspace_id, invitation_id, recipient_email, subject,
             status, provider, mode, created_at, sent_at, error,
             provider_status, provider_delivery_id, provider_status_at, provider_error
           ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          record.id,
          record.workspaceId,
          record.invitationId,
          record.recipientEmail,
          record.subject,
          record.status,
          record.provider,
          record.mode,
          record.createdAt,
          record.sentAt ?? null,
          record.error ?? null,
          record.providerStatus ?? null,
          record.providerDeliveryId ?? null,
          record.providerStatusAt ?? null,
          record.providerError ?? null,
        );
      } finally {
        db.close();
      }
    },
    count() {
      const db = openDatabase(dbPath);
      try {
        const row = db
          .prepare("select count(*) as count from invitation_email_deliveries")
          .get() as { count: number } | undefined;
        return row?.count ?? 0;
      } finally {
        db.close();
      }
    },
  };
}

interface InvitationEmailDeliveryRow {
  id: string;
  workspace_id: string;
  invitation_id: string;
  recipient_email: string;
  subject: string;
  status: InvitationEmailDeliveryStatus;
  provider: string;
  mode: InvitationEmailDeliveryMode;
  created_at: string;
  sent_at: string | null;
  error: string | null;
  provider_status: string | null;
  provider_delivery_id: string | null;
  provider_status_at: string | null;
  provider_error: string | null;
}

function rowToRecord(row: InvitationEmailDeliveryRow): InvitationEmailDeliveryRecord {
  const record: InvitationEmailDeliveryRecord = {
    id: row.id,
    workspaceId: row.workspace_id,
    invitationId: row.invitation_id,
    recipientEmail: row.recipient_email,
    subject: row.subject,
    status: row.status,
    provider: row.provider,
    mode: row.mode,
    createdAt: row.created_at,
  };
  if (row.sent_at !== null) record.sentAt = row.sent_at;
  if (row.error !== null) record.error = row.error;
  if (row.provider_status !== null) record.providerStatus = row.provider_status;
  if (row.provider_delivery_id !== null) record.providerDeliveryId = row.provider_delivery_id;
  if (row.provider_status_at !== null) record.providerStatusAt = row.provider_status_at;
  if (row.provider_error !== null) record.providerError = row.provider_error;
  return record;
}

function applyListFilter(
  collection: InvitationEmailDeliveryRecord[],
  filter: ListInvitationEmailDeliveriesFilter,
): InvitationEmailDeliveryRecord[] {
  const filtered = collection.filter((entry) => {
    if (entry.workspaceId !== filter.workspaceId) return false;
    if (filter.invitationId !== undefined && entry.invitationId !== filter.invitationId) return false;
    return true;
  });
  filtered.sort((left, right) => {
    const cmp = right.createdAt.localeCompare(left.createdAt);
    if (cmp !== 0) return cmp;
    return left.id.localeCompare(right.id);
  });
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
