import { type DatabaseSync, type SQLInputValue } from "node:sqlite";
import { normalizeEmail } from "../../auth-utils";
import {
  decrementMutateSqliteDepth,
  getMutateSqliteDepth,
  incrementMutateSqliteDepth,
  setCachedStore,
} from "../cache.js";
import { workspaceBriefEntries, releaseConfirmationEntries } from "../collections.js";
import {
  loadDedicatedRelationalCollections,
  mergeDedicatedRelationalCollections,
  persistDedicatedRelationalRows,
} from "../dedicated-tables.js";
import { clearPendingDualWrites, flushPendingDualWrites } from "../dual-write.js";
import { normalizeStore } from "../normalize.js";
import { seedStore } from "../seed.js";
import { openStoreDatabase } from "../sqlite-db.js";
import type {
  RateLimitRecord,
  PacketAgentData,
  WorkspaceRecordCollectionKey,
  WorkspaceRecordCollectionMap,
  WorkspaceRecordOrder,
} from "../types.js";
import type { AsyncStoreBackend, StoreBackend } from "./types.js";

// BACKEND module: sqlite load/mutate/persist. Imports leaves only
// (cache/collections/dedicated-tables/dual-write/normalize/seed/sqlite-db) —
// never another backend or the barrel. The `begin immediate` transaction
// boundaries and post-commit dual-write flush are moved verbatim.

type StoreCollectionKey = keyof PacketAgentData;

const RECORD_COLLECTIONS = [
  "users",
  "sessions",
  "workspaces",
  "memberships",
  "workspaceInvitations",
  "workspaceBriefs",
  "workspaceBriefVersions",
  "requirements",
  "implementationPlanItems",
  "workflowConcerns",
  "validationEvidence",
  "releaseConfirmations",
  "onboardingStates",
  "agents",
  "generatedApps",
  "providers",
  "workspaceEnvVars",
  "apiKeys",
  "shareTokens",
] as const satisfies readonly StoreCollectionKey[];

const MAP_COLLECTIONS = ["activationFacts", "activationMilestones", "activationReadModels"] as const satisfies readonly StoreCollectionKey[];

interface SqliteStoreRow {
  collection: StoreCollectionKey;
  payload: string;
}

interface SqliteRateLimitRow {
  id: string;
  count: number;
  reset_at: string;
  updated_at: string;
}

export function sqliteStoreBackend(dbPath: string): StoreBackend {
  return {
    key: `sqlite:${dbPath}`,
    load() {
      const db = openStoreDatabase(dbPath);
      try {
        const data = loadSqliteStore(db);
        if (data) return data;
        const seeded = seedStore();
        persistSqliteStore(db, seeded);
        return seeded;
      } finally {
        db.close();
      }
    },
    persist(data) {
      const db = openStoreDatabase(dbPath);
      try {
        persistSqliteStore(db, data);
      } finally {
        db.close();
      }
    },
    reset() {
      const db = openStoreDatabase(dbPath);
      try {
        const seeded = seedStore();
        persistSqliteStore(db, seeded);
        return seeded;
      } finally {
        db.close();
      }
    },
  };
}

export function sqliteAsyncStoreBackend(dbPath: string): AsyncStoreBackend {
  const backend = sqliteStoreBackend(dbPath);
  return {
    key: backend.key,
    async load() {
      return backend.load();
    },
    mutate(mutator) {
      return mutateSqliteStoreAsync(dbPath, mutator);
    },
  };
}

export function mutateSqliteStore<T>(dbPath: string, mutator: (data: PacketAgentData) => T): T {
  const db = openStoreDatabase(dbPath);
  const backendKey = `sqlite:${dbPath}`;
  incrementMutateSqliteDepth();
  try {
    db.exec("begin immediate");
    try {
      const data = loadSqliteStore(db) ?? seedStore();
      const result = mutator(data);
      persistSqliteStoreRows(db, data);
      db.exec("commit");
      setCachedStore(data, backendKey);
      return result;
    } catch (error) {
      db.exec("rollback");
      clearPendingDualWrites();
      throw error;
    }
  } finally {
    db.close();
    decrementMutateSqliteDepth();
    if (getMutateSqliteDepth() === 0) {
      flushPendingDualWrites();
    }
  }
}

export async function mutateSqliteStoreAsync<T>(dbPath: string, mutator: (data: PacketAgentData) => T | Promise<T>): Promise<T> {
  const db = openStoreDatabase(dbPath);
  const backendKey = `sqlite:${dbPath}`;
  incrementMutateSqliteDepth();
  try {
    db.exec("begin immediate");
    try {
      const data = loadSqliteStore(db) ?? seedStore();
      const result = await mutator(data);
      persistSqliteStoreRows(db, data);
      db.exec("commit");
      setCachedStore(data, backendKey);
      return result;
    } catch (error) {
      db.exec("rollback");
      clearPendingDualWrites();
      throw error;
    }
  } finally {
    db.close();
    decrementMutateSqliteDepth();
    if (getMutateSqliteDepth() === 0) {
      flushPendingDualWrites();
    }
  }
}

export function loadSqliteAppData(dbPath: string): PacketAgentData | null {
  const db = openStoreDatabase(dbPath);
  try {
    return loadSqliteStore(db);
  } finally {
    db.close();
  }
}

export function persistSqliteAppData(dbPath: string, data: PacketAgentData): void {
  const db = openStoreDatabase(dbPath);
  try {
    persistSqliteStore(db, normalizeStore(data));
  } finally {
    db.close();
  }
}

export function loadSqliteStore(db: DatabaseSync): PacketAgentData | null {
  const rows = db.prepare("select collection, payload from app_records order by collection, id").all() as unknown as SqliteStoreRow[];
  const rateLimits = loadSqliteRateLimitBuckets(db);
  const dedicatedCollections = loadDedicatedRelationalCollections(db);
  const hasDedicatedRows = Object.values(dedicatedCollections).some((records) => records.length > 0);
  if (rows.length === 0 && rateLimits.length === 0 && !hasDedicatedRows) return null;

  const partial: Partial<PacketAgentData> = { rateLimits };
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as unknown;
    if (MAP_COLLECTIONS.includes(row.collection as (typeof MAP_COLLECTIONS)[number])) {
      const existing = partial[row.collection] as Record<string, unknown> | undefined;
      partial[row.collection] = { ...existing, ...(payload as Record<string, unknown>) } as never;
      continue;
    }
    const existing = partial[row.collection] as unknown[] | undefined;
    partial[row.collection] = [...(existing ?? []), payload] as never;
  }
  mergeDedicatedRelationalCollections(partial, dedicatedCollections);

  return normalizeStore(partial);
}

function persistSqliteStore(db: DatabaseSync, data: PacketAgentData): void {
  db.exec("begin immediate");
  try {
    persistSqliteStoreRows(db, data);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

export function persistSqliteStoreRows(db: DatabaseSync, data: PacketAgentData): void {
  db.exec("delete from app_record_search");
  db.exec("delete from app_records");
  persistSqliteRateLimitBuckets(db, data.rateLimits ?? []);
  const insert = db.prepare(`
    insert into app_records (collection, id, workspace_id, payload, updated_at)
    values (?, ?, ?, json(?), ?)
  `);
  const insertSearch = db.prepare(`
    insert into app_record_search (collection, id, workspace_id, user_id, email, token)
    values (?, ?, ?, ?, ?, ?)
  `);

  for (const collection of RECORD_COLLECTIONS) {
    for (const payload of recordsForCollection(data, collection)) {
      const id = recordId(collection, payload);
      insert.run(collection, id, workspaceIdForRecord(payload), JSON.stringify(payload), updatedAtForRecord(payload));
      const searchValues = searchValuesForRecord(collection, payload);
      if (searchValues) {
        insertSearch.run(collection, id, searchValues.workspaceId, searchValues.userId, searchValues.email, searchValues.token);
      }
    }
  }
  persistDedicatedRelationalRows(db, data);

  for (const collection of MAP_COLLECTIONS) {
    const map = data[collection] as Record<string, unknown>;
    for (const [workspaceId, payload] of Object.entries(map)) {
      insert.run(collection, workspaceId, workspaceId, JSON.stringify({ [workspaceId]: payload }), null);
    }
  }
}

interface AppRecordSearchValues {
  workspaceId: SQLInputValue;
  userId: SQLInputValue;
  email: SQLInputValue;
  token: SQLInputValue;
}

function searchValuesForRecord(collection: StoreCollectionKey, payload: unknown): AppRecordSearchValues | null {
  const record = payload as Record<string, unknown>;
  if (![
    "users",
    "sessions",
    "workspaces",
    "memberships",
    "workspaceInvitations",
    "shareTokens",
    "workspaceBriefs",
    "workspaceBriefVersions",
    "requirements",
    "implementationPlanItems",
    "workflowConcerns",
    "validationEvidence",
    "releaseConfirmations",
    "agents",
    "providers",
    "workspaceEnvVars",
  ].includes(collection)) return null;
  const workspaceId = typeof record.workspaceId === "string" ? record.workspaceId : null;
  const userId = typeof record.userId === "string" ? record.userId : null;
  const email = typeof record.email === "string" ? normalizeEmail(record.email) : null;
  const token = typeof record.token === "string" ? record.token : null;
  return { workspaceId, userId, email, token };
}

type IndexedCollection =
  | "users"
  | "sessions"
  | "workspaces"
  | "memberships"
  | "workspaceInvitations"
  | "workspaceBriefs"
  | "workspaceBriefVersions"
  | "requirements"
  | "implementationPlanItems"
  | "workflowConcerns"
  | "validationEvidence"
  | "releaseConfirmations"
  | "agents"
  | "providers"
  | "shareTokens";

export function sqliteIndexedRecord<T>(dbPath: string, collection: IndexedCollection, whereSql: string, values: SQLInputValue[]): T | null {
  const db = openStoreDatabase(dbPath);
  try {
    const row = db.prepare(`
      select app_records.payload as payload
      from app_record_search
      join app_records
        on app_records.collection = app_record_search.collection
       and app_records.id = app_record_search.id
      where app_record_search.collection = ? and ${whereSql}
      limit 1
    `).get(collection, ...values) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as T : null;
  } finally {
    db.close();
  }
}

export function sqliteIndexedRecords<T>(dbPath: string, collection: IndexedCollection, whereSql: string, values: SQLInputValue[], orderSql = "app_records.id"): T[] | null {
  const db = openStoreDatabase(dbPath);
  try {
    const rows = db.prepare(`
      select app_records.payload as payload
      from app_record_search
      join app_records
        on app_records.collection = app_record_search.collection
       and app_records.id = app_record_search.id
      where app_record_search.collection = ? and ${whereSql}
      order by ${orderSql}
    `).all(collection, ...values) as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as T);
  } finally {
    db.close();
  }
}

const WORKSPACE_RECORD_ORDER_SQL = {
  id: "app_records.id",
  createdAtAsc: "json_extract(app_records.payload, '$.createdAt') asc, app_records.id asc",
  createdAtDesc: "json_extract(app_records.payload, '$.createdAt') desc, app_records.id desc",
  updatedAtDesc: "coalesce(app_records.updated_at, json_extract(app_records.payload, '$.updatedAt'), json_extract(app_records.payload, '$.createdAt')) desc, app_records.id desc",
  occurredAtDesc: "json_extract(app_records.payload, '$.occurredAt') desc, app_records.id desc",
  scheduledAtAsc: "json_extract(app_records.payload, '$.scheduledAt') asc, app_records.id asc",
  completedAtDesc: "json_extract(app_records.payload, '$.completedAt') desc, app_records.id desc",
  orderAsc: "json_extract(app_records.payload, '$.order') asc, app_records.id asc",
  versionNumberDesc: "json_extract(app_records.payload, '$.versionNumber') desc, app_records.id desc",
  nameAsc: "json_extract(app_records.payload, '$.name') collate nocase asc, app_records.id asc",
  keyAsc: "json_extract(app_records.payload, '$.key') collate nocase asc, app_records.id asc",
} as const satisfies Record<WorkspaceRecordOrder, string>;

export function sqliteWorkspaceRecords<K extends WorkspaceRecordCollectionKey>(
  dbPath: string,
  collection: K,
  workspaceId: string,
  orderBy: WorkspaceRecordOrder,
  limit: number | undefined,
): WorkspaceRecordCollectionMap[K][] | null {
  const db = openStoreDatabase(dbPath);
  try {
    const values: SQLInputValue[] = [collection, workspaceId];
    const hasLimit = typeof limit === "number" && limit > 0;
    const limitSql = hasLimit ? "limit ?" : "";
    if (hasLimit) values.push(limit);
    const rows = db.prepare(`
      select payload
      from app_records
      where collection = ? and workspace_id = ?
      order by ${WORKSPACE_RECORD_ORDER_SQL[orderBy]}
      ${limitSql}
    `).all(...values) as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as WorkspaceRecordCollectionMap[K]);
  } finally {
    db.close();
  }
}

function loadSqliteRateLimitBuckets(db: DatabaseSync): RateLimitRecord[] {
  const rows = db.prepare("select id, count, reset_at, updated_at from rate_limit_buckets order by id").all() as unknown as SqliteRateLimitRow[];
  return rows.map((row) => ({
    id: row.id,
    count: row.count,
    resetAt: row.reset_at,
    updatedAt: row.updated_at,
  }));
}

function persistSqliteRateLimitBuckets(db: DatabaseSync, rateLimits: RateLimitRecord[]): void {
  db.exec("delete from rate_limit_buckets");
  const insert = db.prepare(`
    insert into rate_limit_buckets (id, count, reset_at, updated_at)
    values (?, ?, ?, ?)
  `);
  for (const bucket of rateLimits) {
    insert.run(bucket.id, bucket.count, bucket.resetAt, bucket.updatedAt);
  }
}

function recordsForCollection(data: PacketAgentData, collection: (typeof RECORD_COLLECTIONS)[number]): unknown[] {
  if (collection === "workspaceBriefs") return workspaceBriefEntries(data.workspaceBriefs);
  if (collection === "releaseConfirmations") return releaseConfirmationEntries(data.releaseConfirmations);
  return data[collection] as unknown[];
}

function recordId(collection: StoreCollectionKey, payload: unknown): string {
  const record = payload as Record<string, unknown>;
  if (typeof record.id === "string") return record.id;
  if (collection === "memberships") return `${record.workspaceId}:${record.userId}`;
  if (collection === "workspaceBriefs" || collection === "onboardingStates" || collection === "releaseConfirmations") {
    return String(record.workspaceId);
  }
  return JSON.stringify(record);
}

function workspaceIdForRecord(payload: unknown): SQLInputValue {
  const workspaceId = (payload as Record<string, unknown>).workspaceId;
  return typeof workspaceId === "string" ? workspaceId : null;
}

function updatedAtForRecord(payload: unknown): SQLInputValue {
  const record = payload as Record<string, unknown>;
  return typeof record.updatedAt === "string" ? record.updatedAt : typeof record.createdAt === "string" ? record.createdAt : null;
}
