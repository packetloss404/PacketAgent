import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInvitationEmailDeliveriesRepository,
  jsonInvitationEmailDeliveriesRepository,
  sqliteInvitationEmailDeliveriesRepository,
  type InvitationEmailDeliveriesRepository,
  type InvitationEmailDeliveriesRepositoryDeps,
} from "./invitation-email-deliveries-repo.js";
import type { InvitationEmailDeliveryRecord, PacketAgentData } from "../packetagent-store.js";

function makeRecord(
  overrides: Partial<InvitationEmailDeliveryRecord> & { id: string; createdAt: string },
): InvitationEmailDeliveryRecord {
  const record: InvitationEmailDeliveryRecord = {
    id: overrides.id,
    workspaceId: overrides.workspaceId ?? "ws_default",
    invitationId: overrides.invitationId ?? "inv_default",
    recipientEmail: overrides.recipientEmail ?? "user@example.com",
    subject: overrides.subject ?? "You're invited",
    status: overrides.status ?? "pending",
    provider: overrides.provider ?? "dev",
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

function makeJsonRepo(): InvitationEmailDeliveriesRepository {
  const data = {
    invitationEmailDeliveries: [] as InvitationEmailDeliveryRecord[],
  } as unknown as PacketAgentData;
  const deps: InvitationEmailDeliveriesRepositoryDeps = {
    loadStore: () => data,
    mutateStore: <T>(mutator: (target: PacketAgentData) => T) => mutator(data),
  };
  return jsonInvitationEmailDeliveriesRepository(deps);
}

function withTempSqlite(testFn: (repo: InvitationEmailDeliveriesRepository) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "packetagent-invitation-email-repo-"));
  const dbPath = join(dir, "packetagent.sqlite");
  const prevStore = process.env.PACKETAGENT_STORE;
  const prevDbPath = process.env.PACKETAGENT_DB_PATH;
  process.env.PACKETAGENT_STORE = "sqlite";
  process.env.PACKETAGENT_DB_PATH = dbPath;
  try {
    const repo = sqliteInvitationEmailDeliveriesRepository({ dbPath });
    testFn(repo);
  } finally {
    if (prevStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = prevStore;
    if (prevDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = prevDbPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

function runOnBoth(scenario: (repo: InvitationEmailDeliveriesRepository) => void): void {
  scenario(makeJsonRepo());
  withTempSqlite(scenario);
}

test("empty repository returns no rows for a workspace", () => {
  runOnBoth((repo) => {
    assert.deepEqual(repo.list({ workspaceId: "ws_a" }), []);
    assert.equal(repo.count(), 0);
    assert.equal(repo.find("missing"), null);
  });
});

test("upsert then list returns the record verbatim", () => {
  runOnBoth((repo) => {
    const record = makeRecord({
      id: "del_1",
      workspaceId: "ws_a",
      invitationId: "inv_a",
      recipientEmail: "alice@example.com",
      subject: "Welcome to PacketAgent",
      status: "pending",
      provider: "webhook",
      mode: "webhook",
      createdAt: "2026-04-26T10:00:00.000Z",
    });
    repo.upsert(record);
    const rows = repo.list({ workspaceId: "ws_a" });
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], record);
    assert.equal(repo.count(), 1);
  });
});

test("list returns rows sorted descending by createdAt", () => {
  runOnBoth((repo) => {
    repo.upsert(
      makeRecord({ id: "a", workspaceId: "ws_a", createdAt: "2026-04-26T12:00:00.000Z" }),
    );
    repo.upsert(
      makeRecord({ id: "b", workspaceId: "ws_a", createdAt: "2026-04-26T10:00:00.000Z" }),
    );
    repo.upsert(
      makeRecord({ id: "c", workspaceId: "ws_a", createdAt: "2026-04-26T11:00:00.000Z" }),
    );
    const ids = repo.list({ workspaceId: "ws_a" }).map((entry) => entry.id);
    assert.deepEqual(ids, ["a", "c", "b"]);
  });
});

test("list filters by workspaceId", () => {
  runOnBoth((repo) => {
    repo.upsert(
      makeRecord({ id: "a", workspaceId: "ws_a", createdAt: "2026-04-26T10:00:00.000Z" }),
    );
    repo.upsert(
      makeRecord({ id: "b", workspaceId: "ws_b", createdAt: "2026-04-26T11:00:00.000Z" }),
    );
    repo.upsert(
      makeRecord({ id: "c", workspaceId: "ws_a", createdAt: "2026-04-26T12:00:00.000Z" }),
    );
    const idsA = repo.list({ workspaceId: "ws_a" }).map((entry) => entry.id);
    const idsB = repo.list({ workspaceId: "ws_b" }).map((entry) => entry.id);
    assert.deepEqual(idsA, ["c", "a"]);
    assert.deepEqual(idsB, ["b"]);
  });
});

test("list filters by invitationId", () => {
  runOnBoth((repo) => {
    repo.upsert(
      makeRecord({
        id: "a",
        workspaceId: "ws_a",
        invitationId: "inv_1",
        createdAt: "2026-04-26T10:00:00.000Z",
      }),
    );
    repo.upsert(
      makeRecord({
        id: "b",
        workspaceId: "ws_a",
        invitationId: "inv_2",
        createdAt: "2026-04-26T11:00:00.000Z",
      }),
    );
    repo.upsert(
      makeRecord({
        id: "c",
        workspaceId: "ws_a",
        invitationId: "inv_1",
        createdAt: "2026-04-26T12:00:00.000Z",
      }),
    );
    const ids = repo.list({ workspaceId: "ws_a", invitationId: "inv_1" }).map((entry) => entry.id);
    assert.deepEqual(ids, ["c", "a"]);
  });
});

test("list applies default limit of 50 and caps at 200", () => {
  runOnBoth((repo) => {
    for (let index = 0; index < 210; index += 1) {
      const minute = String(index).padStart(3, "0");
      repo.upsert(
        makeRecord({
          id: `del_${minute}`,
          workspaceId: "ws_a",
          createdAt: `2026-04-26T10:00:${String(index % 60).padStart(2, "0")}.${minute}Z`,
        }),
      );
    }
    assert.equal(repo.list({ workspaceId: "ws_a", limit: 1 }).length, 1);
    assert.equal(repo.list({ workspaceId: "ws_a", limit: 1000 }).length, 200);
    assert.equal(repo.list({ workspaceId: "ws_a" }).length, 50);
  });
});

test("find returns the record regardless of workspace", () => {
  runOnBoth((repo) => {
    const record = makeRecord({
      id: "del_x",
      workspaceId: "ws_a",
      invitationId: "inv_x",
      createdAt: "2026-04-26T10:00:00.000Z",
    });
    repo.upsert(record);
    assert.deepEqual(repo.find("del_x"), record);
    assert.equal(repo.find("nope"), null);
  });
});

test("upsert replaces an existing record by id", () => {
  runOnBoth((repo) => {
    const original = makeRecord({
      id: "dup",
      workspaceId: "ws_a",
      createdAt: "2026-04-26T10:00:00.000Z",
      status: "pending",
      subject: "first subject",
    });
    repo.upsert(original);
    const replacement = makeRecord({
      id: "dup",
      workspaceId: "ws_a",
      createdAt: "2026-04-26T10:00:00.000Z",
      status: "sent",
      subject: "second subject",
      sentAt: "2026-04-26T10:00:05.000Z",
    });
    repo.upsert(replacement);
    assert.equal(repo.count(), 1);
    const found = repo.find("dup");
    assert.deepEqual(found, replacement);
  });
});

test("optional fields round-trip undefined and populated values", () => {
  runOnBoth((repo) => {
    const minimal = makeRecord({
      id: "min",
      workspaceId: "ws_a",
      createdAt: "2026-04-26T10:00:00.000Z",
    });
    repo.upsert(minimal);
    const fromList = repo.list({ workspaceId: "ws_a" })[0];
    assert.equal(fromList?.sentAt, undefined);
    assert.equal(fromList?.error, undefined);
    assert.equal(fromList?.providerStatus, undefined);
    assert.equal(fromList?.providerDeliveryId, undefined);
    assert.equal(fromList?.providerStatusAt, undefined);
    assert.equal(fromList?.providerError, undefined);
    assert.ok(!("sentAt" in (fromList ?? {})));
    assert.ok(!("error" in (fromList ?? {})));
    assert.ok(!("providerStatus" in (fromList ?? {})));
    assert.ok(!("providerDeliveryId" in (fromList ?? {})));
    assert.ok(!("providerStatusAt" in (fromList ?? {})));
    assert.ok(!("providerError" in (fromList ?? {})));

    const populated = makeRecord({
      id: "full",
      workspaceId: "ws_a",
      createdAt: "2026-04-26T11:00:00.000Z",
      status: "sent",
      sentAt: "2026-04-26T11:00:05.000Z",
      error: "transient warning",
      providerStatus: "delivered",
      providerDeliveryId: "prov_123",
      providerStatusAt: "2026-04-26T11:00:10.000Z",
      providerError: "none",
    });
    repo.upsert(populated);
    const reloaded = repo.find("full");
    assert.deepEqual(reloaded, populated);
  });
});

test("createInvitationEmailDeliveriesRepository selects implementation by env", () => {
  const prevStore = process.env.PACKETAGENT_STORE;
  try {
    delete process.env.PACKETAGENT_STORE;
    const data = {
      invitationEmailDeliveries: [] as InvitationEmailDeliveryRecord[],
    } as unknown as PacketAgentData;
    const json = createInvitationEmailDeliveriesRepository({
      loadStore: () => data,
      mutateStore: <T>(mutator: (target: PacketAgentData) => T) => mutator(data),
    });
    json.upsert(
      makeRecord({ id: "a", workspaceId: "ws_a", createdAt: "2026-04-26T10:00:00.000Z" }),
    );
    assert.equal(json.count(), 1);
    assert.equal(data.invitationEmailDeliveries.length, 1);
  } finally {
    if (prevStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = prevStore;
  }
});

test("createInvitationEmailDeliveriesRepository returns sqlite impl when env requests it", () => {
  const dir = mkdtempSync(join(tmpdir(), "packetagent-invitation-email-repo-factory-"));
  const dbPath = join(dir, "packetagent.sqlite");
  const prevStore = process.env.PACKETAGENT_STORE;
  const prevDbPath = process.env.PACKETAGENT_DB_PATH;
  process.env.PACKETAGENT_STORE = "sqlite";
  process.env.PACKETAGENT_DB_PATH = dbPath;
  try {
    const repo = createInvitationEmailDeliveriesRepository({ dbPath });
    repo.upsert(
      makeRecord({ id: "a", workspaceId: "ws_a", createdAt: "2026-04-26T10:00:00.000Z" }),
    );
    assert.equal(repo.count(), 1);
    assert.equal(repo.list({ workspaceId: "ws_a" })[0]?.id, "a");
  } finally {
    if (prevStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = prevStore;
    if (prevDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = prevDbPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
