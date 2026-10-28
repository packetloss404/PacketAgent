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
  snapshotDedicatedRelationalRows,
  type DedicatedRowSnapshot,
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
  "workerCredentials",
  "packetProductSigningKeys",
  "workerBudgetReservations",
  "workerAttentionRequests",
  "workerApprovalGrants",
  "workerControlCommands",
  "workerNotificationDeliveries",
] as const satisfies readonly StoreCollectionKey[];

/** True when the collection is persisted in `app_records` and can be read there. */
export function isSqliteRecordCollection(collection: string): boolean {
  return (RECORD_COLLECTIONS as readonly string[]).includes(collection);
}

const MAP_COLLECTIONS = [
  "activationFacts",
  "activationMilestones",
  "activationReadModels",
] as const satisfies readonly StoreCollectionKey[];

interface SqliteStoreRow {
  collection: StoreCollectionKey;
  id: string;
  payload: string;
}

/**
 * Signatures of every persisted row as they were loaded, so a mutation can
 * write back only what changed instead of rewriting every table. Captured from
 * the loaded dataset (which mirrors the database) rather than re-read at persist
 * time, because the mutator edits the loaded objects in place.
 */
export interface SqliteStoreSnapshot {
  /** `${collection}\u0000${id}` -> signature for every row the store manages. */
  appRecords: Map<string, string>;
  /** Every `${collection}\u0000${id}` key present in `app_records` when loaded. */
  appRecordKeys: Set<string>;
  /** rate-limit bucket id -> signature. */
  rateLimits: Map<string, string>;
  dedicated: DedicatedRowSnapshot;
}

const ROW_KEY_SEPARATOR = "\u0000";

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
      const loaded = loadSqliteStoreForMutation(db);
      const data = loaded?.data ?? seedStore();
      const result = mutator(data);
      persistSqliteStoreRows(db, data, loaded?.snapshot);
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

export async function mutateSqliteStoreAsync<T>(
  dbPath: string,
  mutator: (data: PacketAgentData) => T | Promise<T>,
): Promise<T> {
  const db = openStoreDatabase(dbPath);
  const backendKey = `sqlite:${dbPath}`;
  incrementMutateSqliteDepth();
  try {
    db.exec("begin immediate");
    try {
      const loaded = loadSqliteStoreForMutation(db);
      const data = loaded?.data ?? seedStore();
      const pending = mutator(data);
      const result = pending instanceof Promise || isPromiseLike(pending) ? await pending : pending;
      persistSqliteStoreRows(db, data, loaded?.snapshot);
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

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
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

function loadSqliteStoreCore(
  db: DatabaseSync,
): { data: PacketAgentData; appRecordKeys: Set<string> } | null {
  const rows = db
    .prepare("select collection, id, payload from app_records order by collection, id")
    .all() as unknown as SqliteStoreRow[];
  const rateLimitRows = db
    .prepare("select id, count, reset_at, updated_at from rate_limit_buckets order by id")
    .all() as unknown as SqliteRateLimitRow[];
  const rateLimits = rateLimitRows.map(rateLimitRowToRecord);
  const dedicatedCollections = loadDedicatedRelationalCollections(db);
  const hasDedicatedRows = Object.values(dedicatedCollections).some(
    (records) => records.length > 0,
  );
  if (rows.length === 0 && rateLimits.length === 0 && !hasDedicatedRows) return null;

  const partial: Partial<PacketAgentData> = { rateLimits };
  const appRecordKeys = new Set<string>();
  for (const row of rows) {
    appRecordKeys.add(`${row.collection}${ROW_KEY_SEPARATOR}${row.id}`);
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

  return { data: normalizeStore(partial), appRecordKeys };
}

export function loadSqliteStore(db: DatabaseSync): PacketAgentData | null {
  return loadSqliteStoreCore(db)?.data ?? null;
}

/**
 * Signature of every persisted row for `data`, computed exactly the way the
 * write path computes it. Deriving it from the loaded dataset (rather than from
 * the stored column text) keeps the comparison exact even when normalization or
 * a legacy row format means the stored text differs from the canonical JSON.
 */
export function snapshotSqliteStore(
  data: PacketAgentData,
  appRecordKeys: Set<string>,
): SqliteStoreSnapshot {
  return {
    appRecords: new Map(
      appRecordRows(data).map((row) => [
        `${row.collection}${ROW_KEY_SEPARATOR}${row.id}`,
        row.signature,
      ]),
    ),
    appRecordKeys,
    rateLimits: new Map(
      (data.rateLimits ?? []).map((bucket) => [
        bucket.id,
        JSON.stringify([bucket.count, bucket.resetAt, bucket.updatedAt]),
      ]),
    ),
    dedicated: snapshotDedicatedRelationalRows(data),
  };
}

/**
 * Load the dataset together with the signature of every row currently stored, so
 * the matching mutation can persist only the rows it changed.
 */
export function loadSqliteStoreForMutation(
  db: DatabaseSync,
): { data: PacketAgentData; snapshot: SqliteStoreSnapshot } | null {
  const core = loadSqliteStoreCore(db);
  if (!core) return null;
  return { data: core.data, snapshot: snapshotSqliteStore(core.data, core.appRecordKeys) };
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

interface AppRecordRow {
  collection: StoreCollectionKey;
  id: string;
  workspaceId: SQLInputValue;
  payload: unknown;
  signature: string;
  updatedAt: SQLInputValue;
}

function appRecordRows(data: PacketAgentData): AppRecordRow[] {
  const rows: AppRecordRow[] = [];
  for (const collection of RECORD_COLLECTIONS) {
    for (const payload of recordsForCollection(data, collection)) {
      rows.push({
        collection,
        id: recordId(collection, payload),
        workspaceId: workspaceIdForRecord(payload),
        payload,
        signature: JSON.stringify(payload),
        updatedAt: updatedAtForRecord(payload),
      });
    }
  }
  for (const collection of MAP_COLLECTIONS) {
    const map = data[collection] as Record<string, unknown>;
    for (const [workspaceId, payload] of Object.entries(map)) {
      rows.push({
        collection,
        id: workspaceId,
        workspaceId,
        payload: { [workspaceId]: payload },
        signature: JSON.stringify({ [workspaceId]: payload }),
        updatedAt: null,
      });
    }
  }
  return rows;
}

/**
 * Write `app_records`/`app_record_search`. With `snapshot` only changed rows are
 * upserted and vanished rows deleted (the search row follows via `on delete
 * cascade`); without it the tables are cleared and fully re-inserted.
 */
function persistAppRecords(
  db: DatabaseSync,
  data: PacketAgentData,
  snapshot?: SqliteStoreSnapshot,
): void {
  const previous = snapshot?.appRecords;
  if (!previous) {
    db.exec("delete from app_record_search");
    db.exec("delete from app_records");
  }

  const upsertRecord = db.prepare(`
    insert into app_records (collection, id, workspace_id, payload, updated_at)
    values (?, ?, ?, ?, ?)
    on conflict(collection, id) do update set
      workspace_id = excluded.workspace_id,
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `);
  const upsertSearch = db.prepare(`
    insert into app_record_search (collection, id, workspace_id, user_id, email, token)
    values (?, ?, ?, ?, ?, ?)
    on conflict(collection, id) do update set
      workspace_id = excluded.workspace_id,
      user_id = excluded.user_id,
      email = excluded.email,
      token = excluded.token
  `);

  const present = new Set<string>();
  for (const row of appRecordRows(data)) {
    const key = `${row.collection}${ROW_KEY_SEPARATOR}${row.id}`;
    present.add(key);
    if (previous?.get(key) === row.signature) continue;
    upsertRecord.run(row.collection, row.id, row.workspaceId, row.signature, row.updatedAt);
    const searchValues = searchValuesForRecord(row.collection, row.payload);
    if (searchValues) {
      upsertSearch.run(
        row.collection,
        row.id,
        searchValues.workspaceId,
        searchValues.userId,
        searchValues.email,
        searchValues.token,
      );
    }
  }

  if (!previous) return;
  const remove = db.prepare("delete from app_records where collection = ? and id = ?");
  for (const key of snapshot.appRecordKeys) {
    if (present.has(key)) continue;
    const separator = key.indexOf(ROW_KEY_SEPARATOR);
    remove.run(key.slice(0, separator), key.slice(separator + 1));
  }
}

export function persistSqliteStoreRows(
  db: DatabaseSync,
  data: PacketAgentData,
  snapshot?: SqliteStoreSnapshot,
): void {
  persistAppRecords(db, data, snapshot);
  persistSqliteRateLimitBuckets(db, data.rateLimits ?? [], snapshot?.rateLimits);
  persistDedicatedRelationalRows(db, data, snapshot?.dedicated);
}

interface AppRecordSearchValues {
  workspaceId: SQLInputValue;
  userId: SQLInputValue;
  email: SQLInputValue;
  token: SQLInputValue;
}

function searchValuesForRecord(
  collection: StoreCollectionKey,
  payload: unknown,
): AppRecordSearchValues | null {
  const record = payload as Record<string, unknown>;
  if (
    ![
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
    ].includes(collection)
  )
    return null;
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

export function sqliteIndexedRecord<T>(
  dbPath: string,
  collection: IndexedCollection,
  whereSql: string,
  values: SQLInputValue[],
): T | null {
  const db = openStoreDatabase(dbPath);
  try {
    const row = db
      .prepare(
        `
      select app_records.payload as payload
      from app_record_search
      join app_records
        on app_records.collection = app_record_search.collection
       and app_records.id = app_record_search.id
      where app_record_search.collection = ? and ${whereSql}
      limit 1
    `,
      )
      .get(collection, ...values) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as T) : null;
  } finally {
    db.close();
  }
}

export function sqliteIndexedRecords<T>(
  dbPath: string,
  collection: IndexedCollection,
  whereSql: string,
  values: SQLInputValue[],
  orderSql = "app_records.id",
): T[] | null {
  const db = openStoreDatabase(dbPath);
  try {
    const rows = db
      .prepare(
        `
      select app_records.payload as payload
      from app_record_search
      join app_records
        on app_records.collection = app_record_search.collection
       and app_records.id = app_record_search.id
      where app_record_search.collection = ? and ${whereSql}
      order by ${orderSql}
    `,
      )
      .all(collection, ...values) as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as T);
  } finally {
    db.close();
  }
}

const WORKSPACE_RECORD_ORDER_SQL = {
  id: "app_records.id",
  createdAtAsc: "json_extract(app_records.payload, '$.createdAt') asc, app_records.id asc",
  createdAtDesc: "json_extract(app_records.payload, '$.createdAt') desc, app_records.id desc",
  updatedAtDesc:
    "coalesce(app_records.updated_at, json_extract(app_records.payload, '$.updatedAt'), json_extract(app_records.payload, '$.createdAt')) desc, app_records.id desc",
  occurredAtDesc: "json_extract(app_records.payload, '$.occurredAt') desc, app_records.id desc",
  scheduledAtAsc: "json_extract(app_records.payload, '$.scheduledAt') asc, app_records.id asc",
  completedAtDesc: "json_extract(app_records.payload, '$.completedAt') desc, app_records.id desc",
  orderAsc: "json_extract(app_records.payload, '$.order') asc, app_records.id asc",
  versionNumberDesc:
    "json_extract(app_records.payload, '$.versionNumber') desc, app_records.id desc",
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
    const rows = db
      .prepare(
        `
      select payload
      from app_records
      where collection = ? and workspace_id = ?
      order by ${WORKSPACE_RECORD_ORDER_SQL[orderBy]}
      ${limitSql}
    `,
      )
      .all(...values) as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as WorkspaceRecordCollectionMap[K]);
  } finally {
    db.close();
  }
}

function rateLimitRowToRecord(row: SqliteRateLimitRow): RateLimitRecord {
  return {
    id: row.id,
    count: row.count,
    resetAt: row.reset_at,
    updatedAt: row.updated_at,
  };
}

function persistSqliteRateLimitBuckets(
  db: DatabaseSync,
  rateLimits: RateLimitRecord[],
  previous?: Map<string, string>,
): void {
  if (!previous) db.exec("delete from rate_limit_buckets");
  const upsert = db.prepare(`
    insert into rate_limit_buckets (id, count, reset_at, updated_at)
    values (?, ?, ?, ?)
    on conflict(id) do update set
      count = excluded.count,
      reset_at = excluded.reset_at,
      updated_at = excluded.updated_at
  `);
  const present = new Set<string>();
  for (const bucket of rateLimits) {
    present.add(bucket.id);
    const signature = JSON.stringify([bucket.count, bucket.resetAt, bucket.updatedAt]);
    if (previous?.get(bucket.id) === signature) continue;
    upsert.run(bucket.id, bucket.count, bucket.resetAt, bucket.updatedAt);
  }
  if (!previous) return;
  const remove = db.prepare("delete from rate_limit_buckets where id = ?");
  for (const id of previous.keys()) {
    if (!present.has(id)) remove.run(id);
  }
}

function recordsForCollection(
  data: PacketAgentData,
  collection: (typeof RECORD_COLLECTIONS)[number],
): unknown[] {
  if (collection === "workspaceBriefs") return workspaceBriefEntries(data.workspaceBriefs);
  if (collection === "releaseConfirmations")
    return releaseConfirmationEntries(data.releaseConfirmations);
  return (data[collection] ?? []) as unknown[];
}

function recordId(collection: StoreCollectionKey, payload: unknown): string {
  const record = payload as Record<string, unknown>;
  if (typeof record.id === "string") return record.id;
  if (collection === "memberships") return `${record.workspaceId}:${record.userId}`;
  if (
    collection === "workspaceBriefs" ||
    collection === "onboardingStates" ||
    collection === "releaseConfirmations"
  ) {
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
  return typeof record.updatedAt === "string"
    ? record.updatedAt
    : typeof record.createdAt === "string"
      ? record.createdAt
      : null;
}
