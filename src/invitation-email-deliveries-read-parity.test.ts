import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listInvitationEmailDeliveriesIndexed, mutateStore } from "./packetagent-store.js";
import {
  createInvitationEmailDeliveriesRepository,
  jsonInvitationEmailDeliveriesRepository,
} from "./repositories/invitation-email-deliveries-repo.js";
import { listInvitationEmailDeliveriesViaRepository } from "./invitation-email-deliveries-read.js";
import type { InvitationEmailDeliveryRecord, PacketAgentData } from "./packetagent-store.js";

function makeStore(records: InvitationEmailDeliveryRecord[] = []): PacketAgentData {
  return { invitationEmailDeliveries: [...records] } as unknown as PacketAgentData;
}

function makeRecord(
  overrides: Partial<InvitationEmailDeliveryRecord> & {
    id: string;
    workspaceId: string;
    invitationId: string;
    createdAt: string;
  },
): InvitationEmailDeliveryRecord {
  const record: InvitationEmailDeliveryRecord = {
    id: overrides.id,
    workspaceId: overrides.workspaceId,
    invitationId: overrides.invitationId,
    recipientEmail: overrides.recipientEmail ?? "user@example.com",
    subject: overrides.subject ?? "Invitation",
    status: overrides.status ?? "pending",
    provider: overrides.provider ?? "log",
    mode: overrides.mode ?? "dev",
    createdAt: overrides.createdAt,
  };
  if (overrides.sentAt !== undefined) record.sentAt = overrides.sentAt;
  if (overrides.error !== undefined) record.error = overrides.error;
  if (overrides.providerStatus !== undefined) record.providerStatus = overrides.providerStatus;
  if (overrides.providerDeliveryId !== undefined)
    record.providerDeliveryId = overrides.providerDeliveryId;
  if (overrides.providerStatusAt !== undefined)
    record.providerStatusAt = overrides.providerStatusAt;
  if (overrides.providerError !== undefined) record.providerError = overrides.providerError;
  return record;
}

function withTempSqlite<T>(fn: (dbPath: string) => T): T {
  const tempDir = mkdtempSync(
    join(tmpdir(), "packetagent-invitation-email-deliveries-read-parity-"),
  );
  const dbPath = join(tempDir, "packetagent.sqlite");
  const previousStore = process.env.PACKETAGENT_STORE;
  const previousDbPath = process.env.PACKETAGENT_DB_PATH;
  process.env.PACKETAGENT_STORE = "sqlite";
  process.env.PACKETAGENT_DB_PATH = dbPath;
  try {
    return fn(dbPath);
  } finally {
    if (previousStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = previousStore;
    if (previousDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = previousDbPath;
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test("listInvitationEmailDeliveriesIndexed returns workspace-scoped rows sorted by createdAt DESC via repository", () => {
  const data = makeStore([
    makeRecord({
      id: "del_a",
      workspaceId: "ws_target",
      invitationId: "inv_1",
      createdAt: "2026-04-26T01:00:00.000Z",
    }),
    makeRecord({
      id: "del_c",
      workspaceId: "ws_target",
      invitationId: "inv_1",
      createdAt: "2026-04-26T03:00:00.000Z",
    }),
    makeRecord({
      id: "del_b",
      workspaceId: "ws_target",
      invitationId: "inv_2",
      createdAt: "2026-04-26T02:00:00.000Z",
    }),
    makeRecord({
      id: "del_other",
      workspaceId: "ws_other",
      invitationId: "inv_x",
      createdAt: "2026-04-26T04:00:00.000Z",
    }),
  ]);
  const repository = jsonInvitationEmailDeliveriesRepository({ loadStore: () => data });

  const result = listInvitationEmailDeliveriesViaRepository("ws_target", undefined, { repository });

  assert.deepEqual(
    result.map((entry) => entry.id),
    ["del_c", "del_b", "del_a"],
  );
});

test("listInvitationEmailDeliveriesIndexed filters by invitationId", () => {
  const data = makeStore([
    makeRecord({
      id: "del_a",
      workspaceId: "ws_target",
      invitationId: "inv_1",
      createdAt: "2026-04-26T01:00:00.000Z",
    }),
    makeRecord({
      id: "del_b",
      workspaceId: "ws_target",
      invitationId: "inv_2",
      createdAt: "2026-04-26T02:00:00.000Z",
    }),
    makeRecord({
      id: "del_c",
      workspaceId: "ws_target",
      invitationId: "inv_1",
      createdAt: "2026-04-26T03:00:00.000Z",
    }),
  ]);
  const repository = jsonInvitationEmailDeliveriesRepository({ loadStore: () => data });

  const inv1 = listInvitationEmailDeliveriesViaRepository("ws_target", "inv_1", { repository });
  assert.deepEqual(
    inv1.map((entry) => entry.id),
    ["del_c", "del_a"],
  );

  const inv2 = listInvitationEmailDeliveriesViaRepository("ws_target", "inv_2", { repository });
  assert.deepEqual(
    inv2.map((entry) => entry.id),
    ["del_b"],
  );

  const missing = listInvitationEmailDeliveriesViaRepository("ws_target", "inv_missing", {
    repository,
  });
  assert.deepEqual(missing, []);
});

test("listInvitationEmailDeliveriesIndexed returns [] when the workspace has no deliveries", () => {
  const data = makeStore([
    makeRecord({
      id: "del_other",
      workspaceId: "ws_other",
      invitationId: "inv_x",
      createdAt: "2026-04-26T01:00:00.000Z",
    }),
  ]);
  const repository = jsonInvitationEmailDeliveriesRepository({ loadStore: () => data });

  const result = listInvitationEmailDeliveriesViaRepository("ws_target", undefined, { repository });

  assert.deepEqual(result, []);
});

test("listInvitationEmailDeliveriesIndexed reads from the SQLite repository when PACKETAGENT_STORE=sqlite", () => {
  withTempSqlite((dbPath) => {
    const seedRecords: InvitationEmailDeliveryRecord[] = [
      makeRecord({
        id: "sqlite_a",
        workspaceId: "ws_target",
        invitationId: "inv_1",
        createdAt: "2026-04-26T01:00:00.000Z",
      }),
      makeRecord({
        id: "sqlite_b",
        workspaceId: "ws_target",
        invitationId: "inv_2",
        createdAt: "2026-04-26T02:00:00.000Z",
      }),
      makeRecord({
        id: "sqlite_c",
        workspaceId: "ws_target",
        invitationId: "inv_1",
        createdAt: "2026-04-26T03:00:00.000Z",
      }),
      makeRecord({
        id: "sqlite_other",
        workspaceId: "ws_other",
        invitationId: "inv_x",
        createdAt: "2026-04-26T04:00:00.000Z",
      }),
    ];

    const seedingRepo = createInvitationEmailDeliveriesRepository({ dbPath });
    for (const record of seedRecords) {
      seedingRepo.upsert(record);
    }
    assert.equal(seedingRepo.count(), seedRecords.length);

    const descending = listInvitationEmailDeliveriesIndexed("ws_target");
    assert.deepEqual(
      descending.map((entry) => entry.id),
      ["sqlite_c", "sqlite_b", "sqlite_a"],
    );

    const inv1 = listInvitationEmailDeliveriesIndexed("ws_target", "inv_1");
    assert.deepEqual(
      inv1.map((entry) => entry.id),
      ["sqlite_c", "sqlite_a"],
    );
  });
});

test("listInvitationEmailDeliveriesIndexed merges JSON-side fall-back rows when in SQLite mode", () => {
  withTempSqlite(() => {
    // Seed the repository with one row.
    const seedingRepo = createInvitationEmailDeliveriesRepository();
    const repoRecord = makeRecord({
      id: "sqlite_repo",
      workspaceId: "ws_target",
      invitationId: "inv_1",
      createdAt: "2026-04-26T01:00:00.000Z",
    });
    seedingRepo.upsert(repoRecord);

    // Seed a fallback record only via mutateStore (NOT via the repository).
    const fallbackRecord = makeRecord({
      id: "json_only",
      workspaceId: "ws_target",
      invitationId: "inv_1",
      createdAt: "2026-04-26T05:00:00.000Z",
    });
    mutateStore((data) => {
      if (!Array.isArray(data.invitationEmailDeliveries)) data.invitationEmailDeliveries = [];
      data.invitationEmailDeliveries.push(fallbackRecord);
      return null;
    });

    const merged = listInvitationEmailDeliveriesIndexed("ws_target");
    const ids = merged.map((entry) => entry.id);
    assert.ok(ids.includes("sqlite_repo"), "expected repository row to be present");
    assert.ok(ids.includes("json_only"), "expected JSON fallback row to be merged in SQLite mode");
    // Newest first by createdAt.
    assert.equal(ids[0], "json_only");
  });
});
