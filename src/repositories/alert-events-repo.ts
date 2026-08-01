import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PACKETAGENT_MIGRATIONS_DIR } from "../db/migrations-path.js";
import { DatabaseSync } from "node:sqlite";
import type { AlertEventRecord, PacketAgentData } from "../packetagent-store.js";
import {
  loadStore as defaultLoadStore,
  mutateStore as defaultMutateStore,
} from "../packetagent-store.js";

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const DEFAULT_DB_FILE = "data/packetagent.sqlite";
const MIGRATIONS_DIR = PACKETAGENT_MIGRATIONS_DIR;

export interface ListAlertsFilter {
  severity?: "info" | "warning" | "critical";
  since?: string;
  until?: string;
  limit?: number;
}

export interface UpdateAlertDeliveryStatusPatch {
  delivered: boolean;
  deliveryError?: string;
  deadLettered?: boolean;
  attemptedAt: string;
}

export interface AlertEventsRepository {
  list(filter?: ListAlertsFilter): AlertEventRecord[];
  insertMany(records: AlertEventRecord[]): void;
  updateDeliveryStatus(
    alertId: string,
    patch: UpdateAlertDeliveryStatusPatch,
  ): AlertEventRecord | null;
  prune(retainAfterIso: string): number;
  count(): number;
}

export interface AlertEventsRepositoryDeps {
  loadStore?: () => PacketAgentData;
  mutateStore?: <T>(mutator: (data: PacketAgentData) => T) => T;
  dbPath?: string;
}

type MaybePromise<T> = T | Promise<T>;

export interface AsyncAlertEventsRepository {
  list(filter?: ListAlertsFilter): Promise<AlertEventRecord[]>;
  insertMany(records: AlertEventRecord[]): Promise<void>;
  updateDeliveryStatus(
    alertId: string,
    patch: UpdateAlertDeliveryStatusPatch,
  ): Promise<AlertEventRecord | null>;
  prune(retainAfterIso: string): Promise<number>;
  count(): Promise<number>;
}

export interface AsyncAlertEventsRepositoryDeps {
  loadStore?: () => MaybePromise<PacketAgentData>;
  mutateStore?: <T>(mutator: (data: PacketAgentData) => MaybePromise<T>) => MaybePromise<T>;
  repository?: AlertEventsRepository;
  dbPath?: string;
}

export function createAlertEventsRepository(
  deps: AlertEventsRepositoryDeps = {},
): AlertEventsRepository {
  if (process.env.PACKETAGENT_STORE === "sqlite") return sqliteAlertEventsRepository(deps);
  return jsonAlertEventsRepository(deps);
}

export function createAsyncAlertEventsRepository(
  deps: AsyncAlertEventsRepositoryDeps = {},
): AsyncAlertEventsRepository {
  if (deps.repository) return asyncAlertEventsRepositoryFromSync(deps.repository);
  if (process.env.PACKETAGENT_STORE === "sqlite") {
    return asyncAlertEventsRepositoryFromSync(sqliteAlertEventsRepository({ dbPath: deps.dbPath }));
  }
  return asyncJsonAlertEventsRepository(deps);
}

export function asyncAlertEventsRepositoryFromSync(
  repository: AlertEventsRepository,
): AsyncAlertEventsRepository {
  return {
    async list(filter) {
      return repository.list(filter);
    },
    async insertMany(records) {
      repository.insertMany(records);
    },
    async updateDeliveryStatus(alertId, patch) {
      return repository.updateDeliveryStatus(alertId, patch);
    },
    async prune(retainAfterIso) {
      return repository.prune(retainAfterIso);
    },
    async count() {
      return repository.count();
    },
  };
}

export function jsonAlertEventsRepository(
  deps: AlertEventsRepositoryDeps = {},
): AlertEventsRepository {
  const load = deps.loadStore ?? defaultLoadStore;
  const mutate = deps.mutateStore ?? defaultMutateStore;
  return {
    list(filter = {}) {
      const data = load();
      const collection = Array.isArray(data.alertEvents) ? data.alertEvents : [];
      return applyListFilter(collection, filter);
    },
    insertMany(records) {
      if (records.length === 0) return;
      mutate((data) => {
        if (!Array.isArray(data.alertEvents)) data.alertEvents = [];
        const lastIndexById = new Map<string, number>();
        for (const record of records) {
          lastIndexById.set(record.id, (lastIndexById.get(record.id) ?? -1) + 1);
        }
        const latestById = new Map<string, AlertEventRecord>();
        for (const record of records) {
          latestById.set(record.id, record);
        }
        const existingIndex = new Map<string, number>();
        data.alertEvents.forEach((entry, index) => existingIndex.set(entry.id, index));
        for (const [id, record] of latestById) {
          const index = existingIndex.get(id);
          if (index !== undefined) {
            data.alertEvents[index] = record;
          } else {
            existingIndex.set(id, data.alertEvents.length);
            data.alertEvents.push(record);
          }
        }
        return null;
      });
    },
    updateDeliveryStatus(alertId, patch) {
      return mutate((data) => {
        if (!Array.isArray(data.alertEvents)) {
          data.alertEvents = [];
          return null;
        }
        const target = data.alertEvents.find((entry) => entry.id === alertId);
        if (!target) return null;

        const previousAttempts =
          typeof target.deliveryAttempts === "number" ? target.deliveryAttempts : 0;
        target.deliveryAttempts = previousAttempts + 1;
        target.lastDeliveryAttemptAt = patch.attemptedAt;
        target.delivered = patch.delivered;

        if (patch.deliveryError !== undefined) {
          target.deliveryError = patch.deliveryError;
        } else if (patch.delivered === true) {
          target.deliveryError = undefined;
        }

        if (patch.deadLettered !== undefined) {
          target.deadLettered = patch.deadLettered;
        }

        return { ...target };
      });
    },
    prune(retainAfterIso) {
      const cutoffMs = Date.parse(retainAfterIso);
      return mutate((data) => {
        if (!Array.isArray(data.alertEvents)) {
          data.alertEvents = [];
          return 0;
        }
        const before = data.alertEvents.length;
        data.alertEvents = data.alertEvents.filter((entry) => {
          const observedMs = Date.parse(entry.observedAt);
          if (Number.isNaN(observedMs)) return true;
          return observedMs >= cutoffMs;
        });
        return before - data.alertEvents.length;
      });
    },
    count() {
      const data = load();
      return Array.isArray(data.alertEvents) ? data.alertEvents.length : 0;
    },
  };
}

export function asyncJsonAlertEventsRepository(
  deps: AsyncAlertEventsRepositoryDeps = {},
): AsyncAlertEventsRepository {
  const load = deps.loadStore ?? defaultLoadStore;
  const mutate = deps.mutateStore ?? defaultMutateStore;
  return {
    async list(filter = {}) {
      const data = await load();
      const collection = Array.isArray(data.alertEvents) ? data.alertEvents : [];
      return applyListFilter(collection, filter);
    },
    async insertMany(records) {
      if (records.length === 0) return;
      await mutate((data) => {
        if (!Array.isArray(data.alertEvents)) data.alertEvents = [];
        const latestById = new Map<string, AlertEventRecord>();
        for (const record of records) {
          latestById.set(record.id, record);
        }
        const existingIndex = new Map<string, number>();
        data.alertEvents.forEach((entry, index) => existingIndex.set(entry.id, index));
        for (const [id, record] of latestById) {
          const index = existingIndex.get(id);
          if (index !== undefined) {
            data.alertEvents[index] = record;
          } else {
            existingIndex.set(id, data.alertEvents.length);
            data.alertEvents.push(record);
          }
        }
        return null;
      });
    },
    async updateDeliveryStatus(alertId, patch) {
      return mutate((data) => {
        if (!Array.isArray(data.alertEvents)) {
          data.alertEvents = [];
          return null;
        }
        const target = data.alertEvents.find((entry) => entry.id === alertId);
        if (!target) return null;

        const previousAttempts =
          typeof target.deliveryAttempts === "number" ? target.deliveryAttempts : 0;
        target.deliveryAttempts = previousAttempts + 1;
        target.lastDeliveryAttemptAt = patch.attemptedAt;
        target.delivered = patch.delivered;

        if (patch.deliveryError !== undefined) {
          target.deliveryError = patch.deliveryError;
        } else if (patch.delivered === true) {
          target.deliveryError = undefined;
        }

        if (patch.deadLettered !== undefined) {
          target.deadLettered = patch.deadLettered;
        }

        return { ...target };
      });
    },
    async prune(retainAfterIso) {
      const cutoffMs = Date.parse(retainAfterIso);
      return mutate((data) => {
        if (!Array.isArray(data.alertEvents)) {
          data.alertEvents = [];
          return 0;
        }
        const before = data.alertEvents.length;
        data.alertEvents = data.alertEvents.filter((entry) => {
          const observedMs = Date.parse(entry.observedAt);
          if (Number.isNaN(observedMs)) return true;
          return observedMs >= cutoffMs;
        });
        return before - data.alertEvents.length;
      });
    },
    async count() {
      const data = await load();
      return Array.isArray(data.alertEvents) ? data.alertEvents.length : 0;
    },
  };
}

export function sqliteAlertEventsRepository(
  deps: AlertEventsRepositoryDeps = {},
): AlertEventsRepository {
  const dbPath = resolveDbPath(deps.dbPath);
  return {
    list(filter = {}) {
      const db = openDatabase(dbPath);
      try {
        const sql: string[] = ["select * from alert_events"];
        const params: Array<string | number> = [];
        const where: string[] = [];
        if (filter.severity !== undefined) {
          where.push("severity = ?");
          params.push(filter.severity);
        }
        if (filter.since !== undefined) {
          where.push("observed_at >= ?");
          params.push(filter.since);
        }
        if (filter.until !== undefined) {
          where.push("observed_at <= ?");
          params.push(filter.until);
        }
        if (where.length > 0) sql.push("where " + where.join(" and "));
        sql.push("order by observed_at desc, id asc");
        const requestedLimit = filter.limit ?? DEFAULT_LIST_LIMIT;
        const limit = Math.min(Math.max(requestedLimit, 0), MAX_LIST_LIMIT);
        sql.push("limit ?");
        params.push(limit);
        const rows = db.prepare(sql.join(" ")).all(...params) as unknown as AlertEventRow[];
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
            insert or replace into alert_events (
              id, rule_id, severity, title, detail, observed_at, context,
              delivered, delivery_error, delivery_attempts, last_delivery_attempt_at, dead_lettered
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          for (const record of records) {
            stmt.run(
              record.id,
              record.ruleId,
              record.severity,
              record.title,
              record.detail,
              record.observedAt,
              JSON.stringify(record.context ?? {}),
              record.delivered ? 1 : 0,
              record.deliveryError ?? null,
              record.deliveryAttempts ?? null,
              record.lastDeliveryAttemptAt ?? null,
              record.deadLettered === undefined ? null : record.deadLettered ? 1 : 0,
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
    updateDeliveryStatus(alertId, patch) {
      const db = openDatabase(dbPath);
      try {
        const existing = db.prepare("select * from alert_events where id = ?").get(alertId) as
          | AlertEventRow
          | undefined;
        if (!existing) return null;

        const previousAttempts =
          typeof existing.delivery_attempts === "number" ? existing.delivery_attempts : 0;
        const nextAttempts = previousAttempts + 1;
        const nextDelivered = patch.delivered ? 1 : 0;

        let nextDeliveryError: string | null;
        if (patch.deliveryError !== undefined) {
          nextDeliveryError = patch.deliveryError;
        } else if (patch.delivered === true) {
          nextDeliveryError = null;
        } else {
          nextDeliveryError = existing.delivery_error;
        }

        const nextDeadLettered =
          patch.deadLettered === undefined ? existing.dead_lettered : patch.deadLettered ? 1 : 0;

        db.prepare(
          `update alert_events
             set delivered = ?,
                 delivery_error = ?,
                 delivery_attempts = ?,
                 last_delivery_attempt_at = ?,
                 dead_lettered = ?
           where id = ?`,
        ).run(
          nextDelivered,
          nextDeliveryError,
          nextAttempts,
          patch.attemptedAt,
          nextDeadLettered,
          alertId,
        );

        const updated = db.prepare("select * from alert_events where id = ?").get(alertId) as
          | AlertEventRow
          | undefined;
        return updated ? rowToRecord(updated) : null;
      } finally {
        db.close();
      }
    },
    prune(retainAfterIso) {
      const db = openDatabase(dbPath);
      try {
        const result = db
          .prepare("delete from alert_events where observed_at < ?")
          .run(retainAfterIso);
        return Number(result.changes ?? 0);
      } finally {
        db.close();
      }
    },
    count() {
      const db = openDatabase(dbPath);
      try {
        const row = db.prepare("select count(*) as count from alert_events").get() as
          | { count: number }
          | undefined;
        return row?.count ?? 0;
      } finally {
        db.close();
      }
    },
  };
}

interface AlertEventRow {
  id: string;
  rule_id: string;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  observed_at: string;
  context: string;
  delivered: number;
  delivery_error: string | null;
  delivery_attempts: number | null;
  last_delivery_attempt_at: string | null;
  dead_lettered: number | null;
}

function rowToRecord(row: AlertEventRow): AlertEventRecord {
  const record: AlertEventRecord = {
    id: row.id,
    ruleId: row.rule_id,
    severity: row.severity,
    title: row.title,
    detail: row.detail,
    observedAt: row.observed_at,
    context: parseContext(row.context),
    delivered: row.delivered === 1,
  };
  if (row.delivery_error !== null) record.deliveryError = row.delivery_error;
  if (row.delivery_attempts !== null) record.deliveryAttempts = row.delivery_attempts;
  if (row.last_delivery_attempt_at !== null)
    record.lastDeliveryAttemptAt = row.last_delivery_attempt_at;
  if (row.dead_lettered !== null) record.deadLettered = row.dead_lettered === 1;
  return record;
}

function parseContext(raw: string): Record<string, unknown> {
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

function applyListFilter(
  collection: AlertEventRecord[],
  filter: ListAlertsFilter,
): AlertEventRecord[] {
  const sinceMs = filter.since ? Date.parse(filter.since) : null;
  const untilMs = filter.until ? Date.parse(filter.until) : null;
  const filtered = collection.filter((entry) => {
    if (filter.severity !== undefined && entry.severity !== filter.severity) return false;
    const observedMs = Date.parse(entry.observedAt);
    if (sinceMs !== null && !Number.isNaN(sinceMs) && observedMs < sinceMs) return false;
    if (untilMs !== null && !Number.isNaN(untilMs) && observedMs > untilMs) return false;
    return true;
  });
  filtered.sort((left, right) => {
    const cmp = right.observedAt.localeCompare(left.observedAt);
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
