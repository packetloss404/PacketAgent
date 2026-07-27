import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "./db/cli.js";
import {
  clearStoreCacheForTests,
  createInvitationEmailDelivery,
  markInvitationEmailDeliveryFailed,
  markInvitationEmailDeliverySent,
  markInvitationEmailDeliverySkipped,
  mutateStore,
  recordInvitationEmailProviderStatus,
  resetStoreForTests,
  type InvitationEmailDeliveryRecord,
} from "./packetagent-store.js";

interface InvitationEmailDeliveryRow {
  id: string;
  workspace_id: string;
  invitation_id: string;
  recipient_email: string;
  subject: string;
  status: string;
  provider: string;
  mode: string;
  created_at: string;
  sent_at: string | null;
  error: string | null;
  provider_status: string | null;
  provider_delivery_id: string | null;
  provider_status_at: string | null;
  provider_error: string | null;
}

function readDedicatedRows(dbPath: string): InvitationEmailDeliveryRow[] {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(`
      select id, workspace_id, invitation_id, recipient_email, subject,
        status, provider, mode, created_at, sent_at, error,
        provider_status, provider_delivery_id, provider_status_at, provider_error
      from invitation_email_deliveries
      order by created_at, id
    `).all() as unknown as InvitationEmailDeliveryRow[];
  } finally {
    db.close();
  }
}

function readAppRecordRows(dbPath: string): InvitationEmailDeliveryRecord[] {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare("select payload from app_records where collection = 'invitationEmailDeliveries'").all() as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as InvitationEmailDeliveryRecord);
  } finally {
    db.close();
  }
}

function findAppRecord(dbPath: string, id: string): InvitationEmailDeliveryRecord | null {
  return readAppRecordRows(dbPath).find((entry) => entry.id === id) ?? null;
}

function findDedicated(dbPath: string, id: string): InvitationEmailDeliveryRow | null {
  return readDedicatedRows(dbPath).find((entry) => entry.id === id) ?? null;
}

function withSqliteEnv(dbPath: string) {
  const previousStore = process.env.PACKETAGENT_STORE;
  const previousDbPath = process.env.PACKETAGENT_DB_PATH;
  process.env.PACKETAGENT_STORE = "sqlite";
  process.env.PACKETAGENT_DB_PATH = dbPath;
  clearStoreCacheForTests();
  return () => {
    if (previousStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = previousStore;
    if (previousDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = previousDbPath;
    clearStoreCacheForTests();
  };
}

function createDelivery(): InvitationEmailDeliveryRecord {
  return mutateStore((data) =>
    createInvitationEmailDelivery(
      data,
      {
        workspaceId: "workspace_a",
        invitationId: "inv_a",
        recipientEmail: "user@example.com",
        subject: "You're invited",
        provider: "local",
        mode: "dev",
      },
      "2026-04-26T12:00:00.000Z",
    ),
  );
}

test("createInvitationEmailDelivery writes the dedicated invitation_email_deliveries table in SQLite mode", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-ied-dual-"));
  const dbPath = join(tempDir, "packetagent.sqlite");
  migrateDatabase({ dbPath });
  const restore = withSqliteEnv(dbPath);
  try {
    const delivery = createDelivery();

    assert.equal(delivery.workspaceId, "workspace_a");
    assert.equal(delivery.invitationId, "inv_a");
    assert.equal(delivery.status, "pending");

    const appRecord = findAppRecord(dbPath, delivery.id);
    assert.equal(appRecord, null);

    const dedicated = findDedicated(dbPath, delivery.id);
    assert.ok(dedicated, "dedicated row should exist");
    assert.equal(dedicated.id, delivery.id);
    assert.equal(dedicated.workspace_id, "workspace_a");
    assert.equal(dedicated.invitation_id, "inv_a");
    assert.equal(dedicated.status, "pending");
    assert.equal(dedicated.provider, "local");
    assert.equal(dedicated.mode, "dev");
  } finally {
    restore();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("markInvitationEmailDeliverySent writes the sent record to the dedicated table", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-ied-dual-"));
  const dbPath = join(tempDir, "packetagent.sqlite");
  migrateDatabase({ dbPath });
  const restore = withSqliteEnv(dbPath);
  try {
    const delivery = createDelivery();
    const updated = mutateStore((data) =>
      markInvitationEmailDeliverySent(data, delivery.id, "2026-04-26T12:05:00.000Z"),
    );

    assert.ok(updated);
    assert.equal(updated.status, "sent");
    assert.equal(updated.sentAt, "2026-04-26T12:05:00.000Z");

    const appRecord = findAppRecord(dbPath, delivery.id);
    assert.equal(appRecord, null);

    const dedicated = findDedicated(dbPath, delivery.id);
    assert.ok(dedicated);
    assert.equal(dedicated.status, "sent");
    assert.equal(dedicated.sent_at, "2026-04-26T12:05:00.000Z");
    assert.equal(dedicated.error, null);
  } finally {
    restore();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("markInvitationEmailDeliverySkipped writes the skipped record to the dedicated table", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-ied-dual-"));
  const dbPath = join(tempDir, "packetagent.sqlite");
  migrateDatabase({ dbPath });
  const restore = withSqliteEnv(dbPath);
  try {
    const delivery = createDelivery();
    const updated = mutateStore((data) =>
      markInvitationEmailDeliverySkipped(data, delivery.id, "skipped-by-config"),
    );

    assert.ok(updated);
    assert.equal(updated.status, "skipped");
    assert.equal(updated.error, "skipped-by-config");

    const appRecord = findAppRecord(dbPath, delivery.id);
    assert.equal(appRecord, null);

    const dedicated = findDedicated(dbPath, delivery.id);
    assert.ok(dedicated);
    assert.equal(dedicated.status, "skipped");
    assert.equal(dedicated.error, "skipped-by-config");
    assert.equal(dedicated.sent_at, null);
  } finally {
    restore();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("markInvitationEmailDeliveryFailed writes the failed record to the dedicated table", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-ied-dual-"));
  const dbPath = join(tempDir, "packetagent.sqlite");
  migrateDatabase({ dbPath });
  const restore = withSqliteEnv(dbPath);
  try {
    const delivery = createDelivery();
    const updated = mutateStore((data) =>
      markInvitationEmailDeliveryFailed(data, delivery.id, "smtp timeout"),
    );

    assert.ok(updated);
    assert.equal(updated.status, "failed");
    assert.equal(updated.error, "smtp timeout");

    const appRecord = findAppRecord(dbPath, delivery.id);
    assert.equal(appRecord, null);

    const dedicated = findDedicated(dbPath, delivery.id);
    assert.ok(dedicated);
    assert.equal(dedicated.status, "failed");
    assert.equal(dedicated.error, "smtp timeout");
    assert.equal(dedicated.sent_at, null);
  } finally {
    restore();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("recordInvitationEmailProviderStatus writes the provider-status update to the dedicated table", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-ied-dual-"));
  const dbPath = join(tempDir, "packetagent.sqlite");
  migrateDatabase({ dbPath });
  const restore = withSqliteEnv(dbPath);
  try {
    const delivery = createDelivery();
    const updated = mutateStore((data) =>
      recordInvitationEmailProviderStatus(data, {
        deliveryId: delivery.id,
        providerStatus: "delivered",
        providerDeliveryId: "provider-id-123",
        occurredAt: "2026-04-26T12:10:00.000Z",
      }),
    );

    assert.ok(updated);
    assert.equal(updated.providerStatus, "delivered");
    assert.equal(updated.providerDeliveryId, "provider-id-123");
    assert.equal(updated.providerStatusAt, "2026-04-26T12:10:00.000Z");

    const appRecord = findAppRecord(dbPath, delivery.id);
    assert.equal(appRecord, null);

    const dedicated = findDedicated(dbPath, delivery.id);
    assert.ok(dedicated);
    assert.equal(dedicated.provider_status, "delivered");
    assert.equal(dedicated.provider_delivery_id, "provider-id-123");
    assert.equal(dedicated.provider_status_at, "2026-04-26T12:10:00.000Z");
  } finally {
    restore();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("invitation-email-delivery mutators do not touch the dedicated table in JSON-default mode", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-ied-dual-"));
  const dbPath = join(tempDir, "packetagent.sqlite");
  migrateDatabase({ dbPath });
  const previousStore = process.env.PACKETAGENT_STORE;
  const previousDbPath = process.env.PACKETAGENT_DB_PATH;
  delete process.env.PACKETAGENT_STORE;
  // Point the SQLite path at our temp DB so any accidental writes would land there
  // (and we can detect them); but since PACKETAGENT_STORE is unset, the dual-write
  // code path is gated off and should not open this DB at all.
  process.env.PACKETAGENT_DB_PATH = dbPath;
  clearStoreCacheForTests();
  resetStoreForTests();
  try {
    const before = readDedicatedRows(dbPath);
    const delivery = mutateStore((data) =>
      createInvitationEmailDelivery(
        data,
        {
          workspaceId: "workspace_a",
          invitationId: "inv_a",
          recipientEmail: "user@example.com",
          subject: "Subject",
          provider: "local",
          mode: "dev",
        },
        "2026-04-26T12:00:00.000Z",
      ),
    );
    mutateStore((data) => markInvitationEmailDeliverySent(data, delivery.id, "2026-04-26T12:05:00.000Z"));
    mutateStore((data) => markInvitationEmailDeliveryFailed(data, delivery.id, "later failure"));
    mutateStore((data) => markInvitationEmailDeliverySkipped(data, delivery.id, "later skipped"));
    mutateStore((data) =>
      recordInvitationEmailProviderStatus(data, {
        deliveryId: delivery.id,
        providerStatus: "delivered",
        occurredAt: "2026-04-26T12:10:00.000Z",
      }),
    );

    const after = readDedicatedRows(dbPath);
    assert.equal(after.length, before.length, "dedicated table must remain unchanged in JSON mode");
  } finally {
    if (previousStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = previousStore;
    if (previousDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = previousDbPath;
    clearStoreCacheForTests();
    resetStoreForTests();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
