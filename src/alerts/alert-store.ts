import type { AlertEvent, AlertSeverity } from "./alert-engine.js";
import type { AlertEventRecord, PacketAgentData } from "../packetagent-store.js";
import {
  loadStore as defaultLoadStore,
  loadStoreAsync as defaultLoadStoreAsync,
  mutateStore as defaultMutateStore,
  mutateStoreAsync as defaultMutateStoreAsync,
} from "../packetagent-store.js";
// Phase 33B: read path delegated to repository wrapper.
import { listAlertsViaRepository } from "./alert-store-read.js";
// Phase 33C: dedicated alert_events table dual-write.
import { createAlertEventsRepository, createAsyncAlertEventsRepository } from "../repositories/alert-events-repo.js";
import type { AlertEventsRepository } from "../repositories/alert-events-repo.js";
import { redactedErrorMessage } from "../security/redaction.js";

const DAY_MS = 86_400_000;

// The dedicated alert_events table is a secondary/derived copy of the canonical
// JSON-side store. The canonical mutation commits first; the dual-write below is
// best-effort. A failure here must NOT surface as a primary failure (the caller
// already succeeded) nor diverge silently — log it (redacted) so the dedicated
// table can be reconciled out-of-band. See repair/reconcile jobs in src/jobs.ts.
function logAlertDualWriteFailure(operation: string, error: unknown): void {
  console.warn(`[alert-store] dedicated alert_events dual-write failed during ${operation}: ${redactedErrorMessage(error)}`);
}
const DEFAULT_RETENTION_DAYS = 30;

export interface RecordAlertsOptions {
  retentionDays?: number;
  now?: () => Date;
}

export interface RecordAlertsDeps {
  mutateStore?: <T>(mutator: (data: PacketAgentData) => T) => T;
  alertEventsRepository?: AlertEventsRepository;
}

export interface RecordAlertsAsyncDeps {
  mutateStore?: <T>(mutator: (data: PacketAgentData) => T | Promise<T>) => Promise<T>;
  alertEventsRepository?: AlertEventsRepository;
}

export interface RecordAlertsResult {
  stored: number;
  pruned: number;
}

export interface ListAlertsOptions {
  severity?: AlertSeverity;
  since?: string;
  until?: string;
  limit?: number;
}

export interface ListAlertsDeps {
  loadStore?: () => PacketAgentData;
}

export interface ListAlertsAsyncDeps {
  loadStore?: () => Promise<PacketAgentData>;
}

function ensureAlertCollection(data: PacketAgentData): AlertEventRecord[] {
  if (!Array.isArray(data.alertEvents)) {
    data.alertEvents = [];
  }
  return data.alertEvents;
}

// Idempotent insert keyed by record id: evaluate-job retries replay the same
// event ids, so a plain push would create duplicates. Replace in place when the
// id already exists, otherwise append.
function upsertAlertRecord(collection: AlertEventRecord[], record: AlertEventRecord): void {
  const index = collection.findIndex((entry) => entry.id === record.id);
  if (index >= 0) {
    collection[index] = record;
  } else {
    collection.push(record);
  }
}

function toRecord(
  event: AlertEvent,
  deliveryOk: boolean,
  deliveryError: string | undefined,
  attemptedAt: string,
): AlertEventRecord {
  const record: AlertEventRecord = {
    id: event.id,
    ruleId: event.ruleId,
    severity: event.severity,
    title: event.title,
    detail: event.detail,
    observedAt: event.observedAt,
    context: event.context,
    delivered: deliveryOk,
    deliveryAttempts: 1,
    lastDeliveryAttemptAt: attemptedAt,
    deadLettered: false,
  };
  if (deliveryError !== undefined) {
    record.deliveryError = deliveryError;
  }
  return record;
}

export function recordAlerts(
  events: AlertEvent[],
  deliveryOk: boolean,
  deliveryError: string | undefined,
  options: RecordAlertsOptions = {},
  deps: RecordAlertsDeps = {},
): RecordAlertsResult {
  const mutate = deps.mutateStore ?? defaultMutateStore;
  const nowFn = options.now ?? (() => new Date());
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const attemptedAt = nowFn().toISOString();

  const outcome = mutate((data) => {
    const collection = ensureAlertCollection(data);
    const records = events.map((event) => toRecord(event, deliveryOk, deliveryError, attemptedAt));
    for (const record of records) {
      upsertAlertRecord(collection, record);
    }

    let pruned = 0;
    let retainAfterIso: string | null = null;
    if (retentionDays > 0) {
      const cutoff = nowFn().getTime() - retentionDays * DAY_MS;
      retainAfterIso = new Date(cutoff).toISOString();
      const retained = collection.filter((entry) => Date.parse(entry.observedAt) >= cutoff);
      pruned = collection.length - retained.length;
      if (pruned > 0) {
        data.alertEvents = retained;
      }
    }

    return { stored: records.length, pruned, records, retainAfterIso };
  });

  if (process.env.PACKETAGENT_STORE === "sqlite") {
    try {
      const repo = deps.alertEventsRepository ?? createAlertEventsRepository({});
      if (outcome.records.length > 0) {
        repo.insertMany(outcome.records);
      }
      if (outcome.retainAfterIso !== null) {
        repo.prune(outcome.retainAfterIso);
      }
    } catch (error) {
      logAlertDualWriteFailure("recordAlerts", error);
    }
  }

  return { stored: outcome.stored, pruned: outcome.pruned };
}

export async function recordAlertsAsync(
  events: AlertEvent[],
  deliveryOk: boolean,
  deliveryError: string | undefined,
  options: RecordAlertsOptions = {},
  deps: RecordAlertsAsyncDeps = {},
): Promise<RecordAlertsResult> {
  const mutate = deps.mutateStore ?? defaultMutateStoreAsync;
  const nowFn = options.now ?? (() => new Date());
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const attemptedAt = nowFn().toISOString();

  const outcome = await mutate((data) => {
    const collection = ensureAlertCollection(data);
    const records = events.map((event) => toRecord(event, deliveryOk, deliveryError, attemptedAt));
    for (const record of records) {
      upsertAlertRecord(collection, record);
    }

    let pruned = 0;
    let retainAfterIso: string | null = null;
    if (retentionDays > 0) {
      const cutoff = nowFn().getTime() - retentionDays * DAY_MS;
      retainAfterIso = new Date(cutoff).toISOString();
      const retained = collection.filter((entry) => Date.parse(entry.observedAt) >= cutoff);
      pruned = collection.length - retained.length;
      if (pruned > 0) {
        data.alertEvents = retained;
      }
    }

    return { stored: records.length, pruned, records, retainAfterIso };
  });

  if (process.env.PACKETAGENT_STORE === "sqlite") {
    try {
      const repo = deps.alertEventsRepository ?? createAlertEventsRepository({});
      if (outcome.records.length > 0) {
        repo.insertMany(outcome.records);
      }
      if (outcome.retainAfterIso !== null) {
        repo.prune(outcome.retainAfterIso);
      }
    } catch (error) {
      logAlertDualWriteFailure("recordAlertsAsync", error);
    }
  }

  return { stored: outcome.stored, pruned: outcome.pruned };
}

export interface UpdateAlertDeliveryStatusInput {
  alertId: string;
  delivered: boolean;
  deliveryError?: string;
  deadLettered?: boolean;
  attemptedAt: string;
}

export interface UpdateAlertDeliveryStatusDeps {
  mutateStore?: <T>(mutator: (data: PacketAgentData) => T) => T;
  alertEventsRepository?: AlertEventsRepository;
}

export interface UpdateAlertDeliveryStatusAsyncDeps {
  mutateStore?: <T>(mutator: (data: PacketAgentData) => T | Promise<T>) => Promise<T>;
  alertEventsRepository?: AlertEventsRepository;
}

export function updateAlertDeliveryStatus(
  input: UpdateAlertDeliveryStatusInput,
  deps: UpdateAlertDeliveryStatusDeps = {},
): AlertEventRecord | null {
  const mutate = deps.mutateStore ?? defaultMutateStore;
  const updated = mutate((data) => {
    const collection = ensureAlertCollection(data);
    const target = collection.find((entry) => entry.id === input.alertId);
    if (!target) return null;

    const previousAttempts = typeof target.deliveryAttempts === "number" ? target.deliveryAttempts : 0;
    target.deliveryAttempts = previousAttempts + 1;
    target.lastDeliveryAttemptAt = input.attemptedAt;
    target.delivered = input.delivered;

    if (input.deliveryError !== undefined) {
      target.deliveryError = input.deliveryError;
    } else if (input.delivered === true) {
      target.deliveryError = undefined;
    }

    if (input.deadLettered !== undefined) {
      target.deadLettered = input.deadLettered;
    }

    return { ...target };
  });

  if (updated && process.env.PACKETAGENT_STORE === "sqlite") {
    try {
      const repo = deps.alertEventsRepository ?? createAlertEventsRepository({});
      const patch: {
        delivered: boolean;
        attemptedAt: string;
        deliveryError?: string;
        deadLettered?: boolean;
      } = {
        delivered: input.delivered,
        attemptedAt: input.attemptedAt,
      };
      if (input.deliveryError !== undefined) {
        patch.deliveryError = input.deliveryError;
      }
      if (input.deadLettered !== undefined) {
        patch.deadLettered = input.deadLettered;
      }
      repo.updateDeliveryStatus(input.alertId, patch);
    } catch (error) {
      logAlertDualWriteFailure("updateAlertDeliveryStatus", error);
    }
  }

  return updated;
}

export async function updateAlertDeliveryStatusAsync(
  input: UpdateAlertDeliveryStatusInput,
  deps: UpdateAlertDeliveryStatusAsyncDeps = {},
): Promise<AlertEventRecord | null> {
  const mutate = deps.mutateStore ?? defaultMutateStoreAsync;
  const updated = await mutate((data) => {
    const collection = ensureAlertCollection(data);
    const target = collection.find((entry) => entry.id === input.alertId);
    if (!target) return null;

    const previousAttempts = typeof target.deliveryAttempts === "number" ? target.deliveryAttempts : 0;
    target.deliveryAttempts = previousAttempts + 1;
    target.lastDeliveryAttemptAt = input.attemptedAt;
    target.delivered = input.delivered;

    if (input.deliveryError !== undefined) {
      target.deliveryError = input.deliveryError;
    } else if (input.delivered === true) {
      target.deliveryError = undefined;
    }

    if (input.deadLettered !== undefined) {
      target.deadLettered = input.deadLettered;
    }

    return { ...target };
  });

  if (updated && process.env.PACKETAGENT_STORE === "sqlite") {
    try {
      const repo = deps.alertEventsRepository ?? createAlertEventsRepository({});
      const patch: {
        delivered: boolean;
        attemptedAt: string;
        deliveryError?: string;
        deadLettered?: boolean;
      } = {
        delivered: input.delivered,
        attemptedAt: input.attemptedAt,
      };
      if (input.deliveryError !== undefined) {
        patch.deliveryError = input.deliveryError;
      }
      if (input.deadLettered !== undefined) {
        patch.deadLettered = input.deadLettered;
      }
      repo.updateDeliveryStatus(input.alertId, patch);
    } catch (error) {
      logAlertDualWriteFailure("updateAlertDeliveryStatusAsync", error);
    }
  }

  return updated;
}

export function listAlerts(
  options: ListAlertsOptions = {},
  deps: ListAlertsDeps = {},
): AlertEventRecord[] {
  return listAlertsViaRepository(options, { loadStore: deps.loadStore });
}

export async function listAlertsAsync(
  options: ListAlertsOptions = {},
  deps: ListAlertsAsyncDeps = {},
): Promise<AlertEventRecord[]> {
  const repository = createAsyncAlertEventsRepository({
    loadStore: deps.loadStore ?? defaultLoadStoreAsync,
    mutateStore: defaultMutateStoreAsync,
  });
  return repository.list(options);
}
