import { resolve } from "node:path";
import { createActivitiesRepository } from "../repositories/activities-repo.js";
import { createAgentRunsRepository } from "../repositories/agent-runs-repo.js";
import { createInvitationEmailDeliveriesRepository } from "../repositories/invitation-email-deliveries-repo.js";
import { redactedErrorMessage } from "../security/redaction.js";
import { getMutateSqliteDepth } from "./cache.js";
import { upsertDedicatedActivationSignal } from "./dedicated-tables.js";
import { DEFAULT_DB_FILE, openStoreDatabase } from "./sqlite-db.js";
import type {
  ActivationSignalRecord,
  ActivityRecord,
  AgentRunRecord,
  InvitationEmailDeliveryRecord,
} from "./types.js";

// LEAF module: inherited best-effort compatibility upserts into dedicated
// SQLite tables. Imports cache (depth counter), sqlite-db, dedicated-tables,
// the repositories, and redaction — never a backend or the barrel. The
// canonical SQLite transaction already persists these promoted collections;
// do not extend this compatibility path to new collections.

const pendingActivityDualWrites: ActivityRecord[] = [];
const pendingActivationSignalDualWrites: ActivationSignalRecord[] = [];
const pendingAgentRunDualWrites: AgentRunRecord[] = [];
const pendingInvitationEmailDeliveryDualWrites: InvitationEmailDeliveryRecord[] = [];

// These redundant compatibility upserts run after mutateSqliteStore* has
// committed the same collection in its dedicated table. If an upsert throws,
// the canonical write already succeeded, so the error must NOT propagate to
// the caller (which would falsely report the whole operation as failed). Log
// it (redacted) and continue so the other compatibility writes still flush.
function logDualWriteFlushFailure(table: string, error: unknown): void {
  console.warn(
    `[packetagent-store] dedicated ${table} dual-write flush failed (primary write already committed): ${redactedErrorMessage(error)}`,
  );
}

// Called when a sqlite mutation transaction rolls back: discard everything that
// was queued during the aborted transaction so it is never flushed.
export function clearPendingDualWrites(): void {
  pendingActivityDualWrites.length = 0;
  pendingActivationSignalDualWrites.length = 0;
  pendingAgentRunDualWrites.length = 0;
  pendingInvitationEmailDeliveryDualWrites.length = 0;
}

// Called when the outermost sqlite mutation (depth 0) completes successfully.
export function flushPendingDualWrites(): void {
  flushPendingActivityDualWrites();
  flushPendingActivationSignalDualWrites();
  flushPendingAgentRunDualWrites();
  flushPendingInvitationEmailDeliveryDualWrites();
}

function flushPendingActivityDualWrites(): void {
  if (pendingActivityDualWrites.length === 0) return;
  const drained = pendingActivityDualWrites.splice(0, pendingActivityDualWrites.length);
  if (process.env.PACKETAGENT_STORE !== "sqlite") return;
  try {
    const repo = createActivitiesRepository({});
    for (const record of drained) {
      repo.upsert(record);
    }
  } catch (error) {
    logDualWriteFlushFailure("activities", error);
  }
}

function flushPendingActivationSignalDualWrites(): void {
  if (pendingActivationSignalDualWrites.length === 0) return;
  const drained = pendingActivationSignalDualWrites.splice(
    0,
    pendingActivationSignalDualWrites.length,
  );
  if (process.env.PACKETAGENT_STORE !== "sqlite") return;
  try {
    const db = openStoreDatabase(resolve(process.env.PACKETAGENT_DB_PATH ?? DEFAULT_DB_FILE));
    try {
      db.exec("begin immediate");
      try {
        for (const record of drained) {
          upsertDedicatedActivationSignal(db, record);
        }
        db.exec("commit");
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
    } finally {
      db.close();
    }
  } catch (error) {
    logDualWriteFlushFailure("activation_signals", error);
  }
}

function flushPendingAgentRunDualWrites(): void {
  if (pendingAgentRunDualWrites.length === 0) return;
  const drained = pendingAgentRunDualWrites.splice(0, pendingAgentRunDualWrites.length);
  if (process.env.PACKETAGENT_STORE !== "sqlite") return;
  try {
    const repo = createAgentRunsRepository({});
    for (const record of drained) {
      repo.upsert(record);
    }
  } catch (error) {
    logDualWriteFlushFailure("agent_runs", error);
  }
}

function flushPendingInvitationEmailDeliveryDualWrites(): void {
  if (pendingInvitationEmailDeliveryDualWrites.length === 0) return;
  const drained = pendingInvitationEmailDeliveryDualWrites.splice(
    0,
    pendingInvitationEmailDeliveryDualWrites.length,
  );
  if (process.env.PACKETAGENT_STORE !== "sqlite") return;
  try {
    const repo = createInvitationEmailDeliveriesRepository({});
    for (const record of drained) {
      repo.upsert(record);
    }
  } catch (error) {
    logDualWriteFlushFailure("invitation_email_deliveries", error);
  }
}

export function enqueueActivityDualWrite(record: ActivityRecord): void {
  if (process.env.PACKETAGENT_STORE !== "sqlite") return;
  const snapshot = cloneActivityRecord(record);
  if (getMutateSqliteDepth() > 0) {
    pendingActivityDualWrites.push(snapshot);
  } else {
    const repo = createActivitiesRepository({});
    repo.upsert(snapshot);
  }
}

export function enqueueActivationSignalDualWrite(record: ActivationSignalRecord): void {
  if (process.env.PACKETAGENT_STORE !== "sqlite") return;
  const snapshot = cloneActivationSignalRecord(record);
  if (getMutateSqliteDepth() > 0) {
    pendingActivationSignalDualWrites.push(snapshot);
    return;
  }
  const db = openStoreDatabase(resolve(process.env.PACKETAGENT_DB_PATH ?? DEFAULT_DB_FILE));
  try {
    upsertDedicatedActivationSignal(db, snapshot);
  } finally {
    db.close();
  }
}

export function enqueueInvitationEmailDeliveryDualWrite(
  record: InvitationEmailDeliveryRecord,
): void {
  if (process.env.PACKETAGENT_STORE !== "sqlite") return;
  if (getMutateSqliteDepth() > 0) {
    pendingInvitationEmailDeliveryDualWrites.push({ ...record });
  } else {
    const repo = createInvitationEmailDeliveriesRepository({});
    repo.upsert(record);
  }
}

export function enqueueAgentRunDualWrite(record: AgentRunRecord): void {
  if (process.env.PACKETAGENT_STORE !== "sqlite") return;
  if (getMutateSqliteDepth() > 0) {
    pendingAgentRunDualWrites.push({ ...record });
  } else {
    const repo = createAgentRunsRepository({});
    repo.upsert(record);
  }
}

function cloneActivityRecord(record: ActivityRecord): ActivityRecord {
  return {
    ...record,
    actor: { ...record.actor },
    data: { ...record.data },
  };
}

function cloneActivationSignalRecord(record: ActivationSignalRecord): ActivationSignalRecord {
  return {
    ...record,
    ...(record.data ? { data: { ...record.data } } : {}),
  };
}
