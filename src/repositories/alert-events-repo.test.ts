import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAlertEventsRepository,
  jsonAlertEventsRepository,
  sqliteAlertEventsRepository,
  type AlertEventsRepository,
  type AlertEventsRepositoryDeps,
} from "./alert-events-repo.js";
import type { AlertEventRecord, PacketAgentData } from "../packetagent-store.js";

function makeRecord(overrides: Partial<AlertEventRecord> & { id: string; observedAt: string }): AlertEventRecord {
  const record: AlertEventRecord = {
    id: overrides.id,
    ruleId: overrides.ruleId ?? "rule_default",
    severity: overrides.severity ?? "info",
    title: overrides.title ?? "Default title",
    detail: overrides.detail ?? "Default detail",
    observedAt: overrides.observedAt,
    context: overrides.context ?? {},
    delivered: overrides.delivered ?? false,
  };
  if (overrides.deliveryError !== undefined) record.deliveryError = overrides.deliveryError;
  if (overrides.deliveryAttempts !== undefined) record.deliveryAttempts = overrides.deliveryAttempts;
  if (overrides.lastDeliveryAttemptAt !== undefined) record.lastDeliveryAttemptAt = overrides.lastDeliveryAttemptAt;
  if (overrides.deadLettered !== undefined) record.deadLettered = overrides.deadLettered;
  return record;
}

function makeJsonRepo(): AlertEventsRepository {
  const data = { alertEvents: [] as AlertEventRecord[] } as unknown as PacketAgentData;
  const deps: AlertEventsRepositoryDeps = {
    loadStore: () => data,
    mutateStore: <T,>(mutator: (target: PacketAgentData) => T) => mutator(data),
  };
  return jsonAlertEventsRepository(deps);
}

function withTempSqlite(testFn: (repo: AlertEventsRepository) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "packetagent-alerts-repo-"));
  const dbPath = join(dir, "packetagent.sqlite");
  const prevStore = process.env.PACKETAGENT_STORE;
  const prevDbPath = process.env.PACKETAGENT_DB_PATH;
  process.env.PACKETAGENT_STORE = "sqlite";
  process.env.PACKETAGENT_DB_PATH = dbPath;
  try {
    const repo = sqliteAlertEventsRepository({ dbPath });
    testFn(repo);
  } finally {
    if (prevStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = prevStore;
    if (prevDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = prevDbPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

function runOnBoth(scenario: (repo: AlertEventsRepository) => void): void {
  scenario(makeJsonRepo());
  withTempSqlite(scenario);
}

test("empty repository returns no rows", () => {
  runOnBoth((repo) => {
    assert.deepEqual(repo.list(), []);
    assert.equal(repo.count(), 0);
  });
});

test("insertMany then list returns the record verbatim", () => {
  runOnBoth((repo) => {
    const record = makeRecord({
      id: "alert_1",
      ruleId: "rule_a",
      severity: "warning",
      title: "Disk almost full",
      detail: "Disk usage at 92%",
      observedAt: "2026-04-26T10:00:00.000Z",
      context: { host: "node-1", usage: 0.92 },
      delivered: true,
      deliveryAttempts: 1,
      lastDeliveryAttemptAt: "2026-04-26T10:00:01.000Z",
      deadLettered: false,
    });
    repo.insertMany([record]);
    const rows = repo.list();
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], record);
    assert.equal(repo.count(), 1);
  });
});

test("list returns rows sorted descending by observedAt", () => {
  runOnBoth((repo) => {
    const a = makeRecord({ id: "a", observedAt: "2026-04-26T12:00:00.000Z" });
    const b = makeRecord({ id: "b", observedAt: "2026-04-26T10:00:00.000Z" });
    const c = makeRecord({ id: "c", observedAt: "2026-04-26T11:00:00.000Z" });
    repo.insertMany([a, b, c]);
    const ids = repo.list().map((entry) => entry.id);
    assert.deepEqual(ids, ["a", "c", "b"]);
  });
});

test("list filters by severity", () => {
  runOnBoth((repo) => {
    repo.insertMany([
      makeRecord({ id: "a", observedAt: "2026-04-26T10:00:00.000Z", severity: "info" }),
      makeRecord({ id: "b", observedAt: "2026-04-26T11:00:00.000Z", severity: "critical" }),
      makeRecord({ id: "c", observedAt: "2026-04-26T12:00:00.000Z", severity: "critical" }),
    ]);
    const rows = repo.list({ severity: "critical" });
    assert.deepEqual(rows.map((entry) => entry.id), ["c", "b"]);
  });
});

test("list filters by since (inclusive)", () => {
  runOnBoth((repo) => {
    repo.insertMany([
      makeRecord({ id: "a", observedAt: "2026-04-26T10:00:00.000Z" }),
      makeRecord({ id: "b", observedAt: "2026-04-26T12:00:00.000Z" }),
      makeRecord({ id: "c", observedAt: "2026-04-26T14:00:00.000Z" }),
    ]);
    const rows = repo.list({ since: "2026-04-26T12:00:00.000Z" });
    assert.deepEqual(rows.map((entry) => entry.id), ["c", "b"]);
  });
});

test("list filters by until (inclusive)", () => {
  runOnBoth((repo) => {
    repo.insertMany([
      makeRecord({ id: "a", observedAt: "2026-04-26T10:00:00.000Z" }),
      makeRecord({ id: "b", observedAt: "2026-04-26T12:00:00.000Z" }),
      makeRecord({ id: "c", observedAt: "2026-04-26T14:00:00.000Z" }),
    ]);
    const rows = repo.list({ until: "2026-04-26T12:00:00.000Z" });
    assert.deepEqual(rows.map((entry) => entry.id), ["b", "a"]);
  });
});

test("list applies default limit of 100 and caps at 500", () => {
  runOnBoth((repo) => {
    const records: AlertEventRecord[] = [];
    for (let index = 0; index < 510; index += 1) {
      const minute = String(index).padStart(3, "0");
      records.push(
        makeRecord({
          id: `alert_${minute}`,
          observedAt: `2026-04-26T10:00:${String(index % 60).padStart(2, "0")}.${minute}Z`,
        }),
      );
    }
    repo.insertMany(records);
    assert.equal(repo.list({ limit: 1 }).length, 1);
    assert.equal(repo.list({ limit: 1000 }).length, 500);
    assert.equal(repo.list().length, 100);
  });
});

test("prune removes older rows and returns count", () => {
  runOnBoth((repo) => {
    repo.insertMany([
      makeRecord({ id: "old1", observedAt: "2026-03-01T00:00:00.000Z" }),
      makeRecord({ id: "old2", observedAt: "2026-03-15T00:00:00.000Z" }),
      makeRecord({ id: "keep", observedAt: "2026-04-26T00:00:00.000Z" }),
    ]);
    const removed = repo.prune("2026-04-01T00:00:00.000Z");
    assert.equal(removed, 2);
    assert.equal(repo.count(), 1);
    assert.deepEqual(repo.list().map((entry) => entry.id), ["keep"]);
  });
});

test("prune with cutoff matching observedAt retains the row", () => {
  runOnBoth((repo) => {
    repo.insertMany([
      makeRecord({ id: "boundary", observedAt: "2026-04-26T00:00:00.000Z" }),
    ]);
    const removed = repo.prune("2026-04-26T00:00:00.000Z");
    assert.equal(removed, 0);
    assert.equal(repo.count(), 1);
  });
});

test("insertMany dedupes by id (idempotent re-insert)", () => {
  runOnBoth((repo) => {
    const record = makeRecord({ id: "dup", observedAt: "2026-04-26T10:00:00.000Z", title: "first" });
    repo.insertMany([record]);
    repo.insertMany([record]);
    assert.equal(repo.count(), 1);
    assert.equal(repo.list().length, 1);
    const updated = makeRecord({ id: "dup", observedAt: "2026-04-26T10:00:00.000Z", title: "second" });
    repo.insertMany([updated]);
    assert.equal(repo.count(), 1);
    assert.equal(repo.list()[0]?.title, "second");
  });
});

test("updateDeliveryStatus returns null when alert id is unknown", () => {
  runOnBoth((repo) => {
    const result = repo.updateDeliveryStatus("missing", {
      delivered: true,
      attemptedAt: "2026-04-26T10:00:00.000Z",
    });
    assert.equal(result, null);
  });
});

test("updateDeliveryStatus on success increments attempts and clears deliveryError", () => {
  runOnBoth((repo) => {
    repo.insertMany([
      makeRecord({
        id: "alert_a",
        observedAt: "2026-04-26T10:00:00.000Z",
        delivered: false,
        deliveryError: "previous failure",
        deliveryAttempts: 2,
        lastDeliveryAttemptAt: "2026-04-26T09:00:00.000Z",
      }),
    ]);
    const result = repo.updateDeliveryStatus("alert_a", {
      delivered: true,
      attemptedAt: "2026-04-26T10:30:00.000Z",
    });
    assert.ok(result);
    assert.equal(result?.delivered, true);
    assert.equal(result?.deliveryAttempts, 3);
    assert.equal(result?.lastDeliveryAttemptAt, "2026-04-26T10:30:00.000Z");
    assert.equal(result?.deliveryError, undefined);
    const reloaded = repo.list()[0];
    assert.equal(reloaded?.delivered, true);
    assert.equal(reloaded?.deliveryError, undefined);
    assert.equal(reloaded?.deliveryAttempts, 3);
  });
});

test("updateDeliveryStatus on failure records error and increments attempts", () => {
  runOnBoth((repo) => {
    repo.insertMany([
      makeRecord({
        id: "alert_b",
        observedAt: "2026-04-26T10:00:00.000Z",
        delivered: false,
      }),
    ]);
    const result = repo.updateDeliveryStatus("alert_b", {
      delivered: false,
      deliveryError: "smtp timeout",
      attemptedAt: "2026-04-26T10:05:00.000Z",
    });
    assert.ok(result);
    assert.equal(result?.delivered, false);
    assert.equal(result?.deliveryError, "smtp timeout");
    assert.equal(result?.deliveryAttempts, 1);
    assert.equal(result?.lastDeliveryAttemptAt, "2026-04-26T10:05:00.000Z");
  });
});

test("updateDeliveryStatus marks dead-lettered when patch.deadLettered is true", () => {
  runOnBoth((repo) => {
    repo.insertMany([
      makeRecord({
        id: "alert_c",
        observedAt: "2026-04-26T10:00:00.000Z",
        delivered: false,
        deliveryAttempts: 4,
      }),
    ]);
    const result = repo.updateDeliveryStatus("alert_c", {
      delivered: false,
      deadLettered: true,
      deliveryError: "exhausted retries",
      attemptedAt: "2026-04-26T11:00:00.000Z",
    });
    assert.ok(result);
    assert.equal(result?.deadLettered, true);
    assert.equal(result?.delivered, false);
    assert.equal(result?.deliveryError, "exhausted retries");
    assert.equal(result?.deliveryAttempts, 5);
  });
});

test("updateDeliveryStatus preserves deliveryError when patch omits it and delivered is not true", () => {
  runOnBoth((repo) => {
    repo.insertMany([
      makeRecord({
        id: "alert_d",
        observedAt: "2026-04-26T10:00:00.000Z",
        delivered: false,
        deliveryError: "original error",
        deliveryAttempts: 1,
      }),
    ]);
    const result = repo.updateDeliveryStatus("alert_d", {
      delivered: false,
      attemptedAt: "2026-04-26T10:30:00.000Z",
    });
    assert.ok(result);
    assert.equal(result?.deliveryError, "original error");
    assert.equal(result?.deliveryAttempts, 2);
    assert.equal(result?.delivered, false);
  });
});

test("createAlertEventsRepository selects implementation by env", () => {
  const prevStore = process.env.PACKETAGENT_STORE;
  try {
    delete process.env.PACKETAGENT_STORE;
    const data = { alertEvents: [] as AlertEventRecord[] } as unknown as PacketAgentData;
    const json = createAlertEventsRepository({
      loadStore: () => data,
      mutateStore: <T,>(mutator: (target: PacketAgentData) => T) => mutator(data),
    });
    json.insertMany([makeRecord({ id: "a", observedAt: "2026-04-26T10:00:00.000Z" })]);
    assert.equal(json.count(), 1);
    assert.equal(data.alertEvents.length, 1);
  } finally {
    if (prevStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = prevStore;
  }
});

test("createAlertEventsRepository returns sqlite impl when env requests it", () => {
  const dir = mkdtempSync(join(tmpdir(), "packetagent-alerts-repo-factory-"));
  const dbPath = join(dir, "packetagent.sqlite");
  const prevStore = process.env.PACKETAGENT_STORE;
  const prevDbPath = process.env.PACKETAGENT_DB_PATH;
  process.env.PACKETAGENT_STORE = "sqlite";
  process.env.PACKETAGENT_DB_PATH = dbPath;
  try {
    const repo = createAlertEventsRepository({ dbPath });
    repo.insertMany([makeRecord({ id: "a", observedAt: "2026-04-26T10:00:00.000Z" })]);
    assert.equal(repo.count(), 1);
    assert.equal(repo.list()[0]?.id, "a");
  } finally {
    if (prevStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = prevStore;
    if (prevDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = prevDbPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
