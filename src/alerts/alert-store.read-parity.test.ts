import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listAlerts } from "./alert-store.js";
import {
  createAlertEventsRepository,
  jsonAlertEventsRepository,
} from "../repositories/alert-events-repo.js";
import type { AlertEventRecord, PacketAgentData } from "../packetagent-store.js";

function makeStore(records: AlertEventRecord[] = []): PacketAgentData {
  return { alertEvents: [...records] } as unknown as PacketAgentData;
}

function makeRecord(
  overrides: Partial<AlertEventRecord> & { id: string; observedAt: string },
): AlertEventRecord {
  return {
    id: overrides.id,
    ruleId: overrides.ruleId ?? "subsystem-degraded",
    severity: overrides.severity ?? "warning",
    title: overrides.title ?? "Title",
    detail: overrides.detail ?? "Detail",
    observedAt: overrides.observedAt,
    context: overrides.context ?? {},
    delivered: overrides.delivered ?? true,
    deliveryAttempts: overrides.deliveryAttempts ?? 1,
    lastDeliveryAttemptAt: overrides.lastDeliveryAttemptAt ?? overrides.observedAt,
    deadLettered: overrides.deadLettered ?? false,
    ...(overrides.deliveryError !== undefined ? { deliveryError: overrides.deliveryError } : {}),
  };
}

function withTempSqlite<T>(fn: (dbPath: string) => T): T {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-alert-events-read-parity-"));
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

test("listAlerts delegates through repository and preserves descending observedAt sort", () => {
  const data = makeStore([
    makeRecord({ id: "a", observedAt: "2026-04-26T01:00:00.000Z" }),
    makeRecord({ id: "c", observedAt: "2026-04-26T03:00:00.000Z" }),
    makeRecord({ id: "b", observedAt: "2026-04-26T02:00:00.000Z" }),
  ]);

  const result = listAlerts({}, { loadStore: () => data });

  assert.deepEqual(result.map((entry) => entry.id), ["c", "b", "a"]);
});

test("listAlerts preserves severity/since/until filtering through the repository", () => {
  const data = makeStore([
    makeRecord({ id: "warn_old", severity: "warning", observedAt: "2026-04-20T00:00:00.000Z" }),
    makeRecord({ id: "warn_mid", severity: "warning", observedAt: "2026-04-22T00:00:00.000Z" }),
    makeRecord({ id: "warn_new", severity: "warning", observedAt: "2026-04-25T00:00:00.000Z" }),
    makeRecord({ id: "crit_mid", severity: "critical", observedAt: "2026-04-22T12:00:00.000Z" }),
  ]);

  const bySeverity = listAlerts({ severity: "warning" }, { loadStore: () => data });
  assert.deepEqual(bySeverity.map((entry) => entry.id), ["warn_new", "warn_mid", "warn_old"]);

  const sinceFiltered = listAlerts(
    { severity: "warning", since: "2026-04-21T00:00:00.000Z" },
    { loadStore: () => data },
  );
  assert.deepEqual(sinceFiltered.map((entry) => entry.id), ["warn_new", "warn_mid"]);

  const untilFiltered = listAlerts(
    { severity: "warning", until: "2026-04-23T00:00:00.000Z" },
    { loadStore: () => data },
  );
  assert.deepEqual(untilFiltered.map((entry) => entry.id), ["warn_mid", "warn_old"]);

  const ranged = listAlerts(
    { since: "2026-04-21T00:00:00.000Z", until: "2026-04-23T00:00:00.000Z" },
    { loadStore: () => data },
  );
  assert.deepEqual(ranged.map((entry) => entry.id).sort(), ["crit_mid", "warn_mid"].sort());
});

test("listAlerts returns an empty array when the store has no alert events", () => {
  const data = makeStore();
  const result = listAlerts({}, { loadStore: () => data });
  assert.deepEqual(result, []);
});

test("listAlerts default limit is 100 and cap is 500", () => {
  const many: AlertEventRecord[] = [];
  for (let index = 0; index < 600; index += 1) {
    const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString();
    many.push(makeRecord({ id: `alert_${index.toString().padStart(4, "0")}`, observedAt: stamp }));
  }
  const data = makeStore(many);

  const defaultLimit = listAlerts({}, { loadStore: () => data });
  assert.equal(defaultLimit.length, 100);
  // descending order — newest first
  assert.equal(defaultLimit[0].id, "alert_0599");
  assert.equal(defaultLimit[99].id, "alert_0500");

  const explicit = listAlerts({ limit: 250 }, { loadStore: () => data });
  assert.equal(explicit.length, 250);

  const capped = listAlerts({ limit: 1000 }, { loadStore: () => data });
  assert.equal(capped.length, 500);
});

test("listAlerts can be backed directly by an injected repository instance", () => {
  const data = makeStore([
    makeRecord({ id: "first", observedAt: "2026-04-26T01:00:00.000Z" }),
    makeRecord({ id: "second", observedAt: "2026-04-26T02:00:00.000Z" }),
  ]);
  const repository = jsonAlertEventsRepository({ loadStore: () => data });

  const viaInjectedRepository = repository.list({});
  const viaListFunction = listAlerts({}, { loadStore: () => data });

  assert.deepEqual(viaInjectedRepository.map((entry) => entry.id), ["second", "first"]);
  assert.deepEqual(
    viaListFunction.map((entry) => entry.id),
    viaInjectedRepository.map((entry) => entry.id),
  );
});

test("listAlerts reads from the SQLite repository when PACKETAGENT_STORE=sqlite", () => {
  withTempSqlite((dbPath) => {
    const seedRecords: AlertEventRecord[] = [
      makeRecord({ id: "sqlite_a", severity: "warning", observedAt: "2026-04-26T01:00:00.000Z" }),
      makeRecord({ id: "sqlite_b", severity: "critical", observedAt: "2026-04-26T02:00:00.000Z" }),
      makeRecord({ id: "sqlite_c", severity: "warning", observedAt: "2026-04-26T03:00:00.000Z" }),
    ];

    const seedingRepo = createAlertEventsRepository({ dbPath });
    seedingRepo.insertMany(seedRecords);
    assert.equal(seedingRepo.count(), 3);

    const descending = listAlerts();
    assert.deepEqual(descending.map((entry) => entry.id), ["sqlite_c", "sqlite_b", "sqlite_a"]);

    const filtered = listAlerts({ severity: "warning" });
    assert.deepEqual(filtered.map((entry) => entry.id), ["sqlite_c", "sqlite_a"]);
  });
});
