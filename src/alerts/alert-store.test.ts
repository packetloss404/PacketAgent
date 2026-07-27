import assert from "node:assert/strict";
import test from "node:test";
import { listAlerts, recordAlerts, updateAlertDeliveryStatus } from "./alert-store.js";
import type { AlertEvent } from "./alert-engine.js";
import type { AlertEventRecord, PacketAgentData } from "../packetagent-store.js";

function makeStore(records: AlertEventRecord[] = []): PacketAgentData {
  return { alertEvents: [...records] } as unknown as PacketAgentData;
}

function makeStoreDeps(data: PacketAgentData) {
  return {
    mutateStore: <T,>(mutator: (target: PacketAgentData) => T) => mutator(data),
  };
}

function makeEvent(overrides: Partial<AlertEvent> & { id: string }): AlertEvent {
  return {
    id: overrides.id,
    ruleId: overrides.ruleId ?? "subsystem-degraded",
    severity: overrides.severity ?? "warning",
    title: overrides.title ?? "Title",
    detail: overrides.detail ?? "Detail",
    observedAt: overrides.observedAt ?? "2026-04-26T12:00:00.000Z",
    context: overrides.context ?? {},
  };
}

function makeRecord(overrides: Partial<AlertEventRecord> & { id: string; observedAt: string }): AlertEventRecord {
  return {
    id: overrides.id,
    ruleId: overrides.ruleId ?? "subsystem-degraded",
    severity: overrides.severity ?? "warning",
    title: overrides.title ?? "Title",
    detail: overrides.detail ?? "Detail",
    observedAt: overrides.observedAt,
    context: overrides.context ?? {},
    delivered: overrides.delivered ?? true,
    ...(overrides.deliveryError !== undefined ? { deliveryError: overrides.deliveryError } : {}),
  };
}

test("recordAlerts inserts events as records with delivery flags", () => {
  const data = makeStore();
  const events: AlertEvent[] = [
    makeEvent({ id: "evt_a", severity: "warning" }),
    makeEvent({ id: "evt_b", severity: "critical" }),
  ];

  const result = recordAlerts(
    events,
    true,
    undefined,
    { now: () => new Date("2026-04-26T12:30:00.000Z") },
    makeStoreDeps(data),
  );

  assert.deepEqual(result, { stored: 2, pruned: 0 });
  assert.equal(data.alertEvents.length, 2);
  assert.equal(data.alertEvents[0].id, "evt_a");
  assert.equal(data.alertEvents[0].delivered, true);
  assert.equal(data.alertEvents[0].deliveryError, undefined);
  assert.equal(data.alertEvents[0].deliveryAttempts, 1);
  assert.equal(data.alertEvents[0].lastDeliveryAttemptAt, "2026-04-26T12:30:00.000Z");
  assert.equal(data.alertEvents[0].deadLettered, false);
  assert.equal(data.alertEvents[1].id, "evt_b");
  assert.equal(data.alertEvents[1].deliveryAttempts, 1);
  assert.equal(data.alertEvents[1].deadLettered, false);
});

test("recordAlerts with deliveryOk=false stores deliveryError", () => {
  const data = makeStore();
  const events: AlertEvent[] = [makeEvent({ id: "evt_a" })];

  const result = recordAlerts(
    events,
    false,
    "network: timeout",
    { now: () => new Date("2026-04-26T12:30:00.000Z") },
    makeStoreDeps(data),
  );

  assert.deepEqual(result, { stored: 1, pruned: 0 });
  assert.equal(data.alertEvents[0].delivered, false);
  assert.equal(data.alertEvents[0].deliveryError, "network: timeout");
  assert.equal(data.alertEvents[0].deliveryAttempts, 1);
  assert.equal(data.alertEvents[0].lastDeliveryAttemptAt, "2026-04-26T12:30:00.000Z");
  assert.equal(data.alertEvents[0].deadLettered, false);
});

test("recordAlerts with retentionDays prunes older rows", () => {
  const data = makeStore([
    makeRecord({ id: "ancient", observedAt: "2026-01-01T00:00:00.000Z" }),
    makeRecord({ id: "stale", observedAt: "2026-04-10T00:00:00.000Z" }),
    makeRecord({ id: "fresh", observedAt: "2026-04-25T00:00:00.000Z" }),
  ]);
  const events: AlertEvent[] = [makeEvent({ id: "new", observedAt: "2026-04-26T11:00:00.000Z" })];

  const result = recordAlerts(
    events,
    true,
    undefined,
    { retentionDays: 7, now: () => new Date("2026-04-26T12:00:00.000Z") },
    makeStoreDeps(data),
  );

  assert.equal(result.stored, 1);
  assert.equal(result.pruned, 2);
  const ids = data.alertEvents.map((entry) => entry.id).sort();
  assert.deepEqual(ids, ["fresh", "new"]);
});

test("recordAlerts with retentionDays=0 disables pruning", () => {
  const data = makeStore([
    makeRecord({ id: "ancient", observedAt: "2020-01-01T00:00:00.000Z" }),
  ]);
  const events: AlertEvent[] = [makeEvent({ id: "new", observedAt: "2026-04-26T11:00:00.000Z" })];

  const result = recordAlerts(
    events,
    true,
    undefined,
    { retentionDays: 0, now: () => new Date("2026-04-26T12:00:00.000Z") },
    makeStoreDeps(data),
  );

  assert.equal(result.stored, 1);
  assert.equal(result.pruned, 0);
  assert.equal(data.alertEvents.length, 2);
});

test("listAlerts returns descending by observedAt", () => {
  const data = makeStore([
    makeRecord({ id: "a", observedAt: "2026-04-26T01:00:00.000Z" }),
    makeRecord({ id: "c", observedAt: "2026-04-26T03:00:00.000Z" }),
    makeRecord({ id: "b", observedAt: "2026-04-26T02:00:00.000Z" }),
  ]);

  const result = listAlerts({}, { loadStore: () => data });
  assert.deepEqual(result.map((entry) => entry.id), ["c", "b", "a"]);
});

test("listAlerts filters by severity", () => {
  const data = makeStore([
    makeRecord({ id: "warn_1", severity: "warning", observedAt: "2026-04-26T01:00:00.000Z" }),
    makeRecord({ id: "crit_1", severity: "critical", observedAt: "2026-04-26T02:00:00.000Z" }),
    makeRecord({ id: "warn_2", severity: "warning", observedAt: "2026-04-26T03:00:00.000Z" }),
  ]);

  const result = listAlerts({ severity: "critical" }, { loadStore: () => data });
  assert.deepEqual(result.map((entry) => entry.id), ["crit_1"]);
});

test("listAlerts filters by since and until", () => {
  const data = makeStore([
    makeRecord({ id: "old", observedAt: "2026-04-20T00:00:00.000Z" }),
    makeRecord({ id: "mid", observedAt: "2026-04-22T00:00:00.000Z" }),
    makeRecord({ id: "new", observedAt: "2026-04-25T00:00:00.000Z" }),
  ]);

  const sinceFiltered = listAlerts({ since: "2026-04-21T00:00:00.000Z" }, { loadStore: () => data });
  assert.deepEqual(sinceFiltered.map((entry) => entry.id), ["new", "mid"]);

  const untilFiltered = listAlerts({ until: "2026-04-23T00:00:00.000Z" }, { loadStore: () => data });
  assert.deepEqual(untilFiltered.map((entry) => entry.id), ["mid", "old"]);

  const ranged = listAlerts(
    { since: "2026-04-21T00:00:00.000Z", until: "2026-04-23T00:00:00.000Z" },
    { loadStore: () => data },
  );
  assert.deepEqual(ranged.map((entry) => entry.id), ["mid"]);
});

test("listAlerts honors limit defaulting to 100 and capping at 500", () => {
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

  const explicit = listAlerts({ limit: 250 }, { loadStore: () => data });
  assert.equal(explicit.length, 250);

  const capped = listAlerts({ limit: 1000 }, { loadStore: () => data });
  assert.equal(capped.length, 500);
});

test("updateAlertDeliveryStatus returns null for unknown alertId", () => {
  const data = makeStore([
    makeRecord({ id: "evt_a", observedAt: "2026-04-26T12:00:00.000Z" }),
  ]);
  const result = updateAlertDeliveryStatus(
    {
      alertId: "missing",
      delivered: true,
      attemptedAt: "2026-04-26T13:00:00.000Z",
    },
    makeStoreDeps(data),
  );
  assert.equal(result, null);
});

test("updateAlertDeliveryStatus increments attempts and updates timestamp", () => {
  const data = makeStore([
    makeRecord({
      id: "evt_a",
      observedAt: "2026-04-26T12:00:00.000Z",
      delivered: false,
      deliveryError: "network: timeout",
    }),
  ]);
  data.alertEvents[0].deliveryAttempts = 1;
  data.alertEvents[0].lastDeliveryAttemptAt = "2026-04-26T12:00:00.000Z";
  data.alertEvents[0].deadLettered = false;

  const result = updateAlertDeliveryStatus(
    {
      alertId: "evt_a",
      delivered: false,
      deliveryError: "still failing",
      attemptedAt: "2026-04-26T13:00:00.000Z",
    },
    makeStoreDeps(data),
  );

  assert.ok(result);
  assert.equal(result?.deliveryAttempts, 2);
  assert.equal(result?.lastDeliveryAttemptAt, "2026-04-26T13:00:00.000Z");
  assert.equal(result?.delivered, false);
  assert.equal(result?.deliveryError, "still failing");
  assert.equal(data.alertEvents[0].deliveryAttempts, 2);
  assert.equal(data.alertEvents[0].lastDeliveryAttemptAt, "2026-04-26T13:00:00.000Z");
});

test("updateAlertDeliveryStatus treats undefined attempts as 0 then increments", () => {
  const data = makeStore([
    makeRecord({ id: "evt_a", observedAt: "2026-04-26T12:00:00.000Z", delivered: false }),
  ]);
  delete data.alertEvents[0].deliveryAttempts;

  const result = updateAlertDeliveryStatus(
    {
      alertId: "evt_a",
      delivered: false,
      attemptedAt: "2026-04-26T13:00:00.000Z",
    },
    makeStoreDeps(data),
  );

  assert.equal(result?.deliveryAttempts, 1);
});

test("updateAlertDeliveryStatus updates delivered flag", () => {
  const data = makeStore([
    makeRecord({ id: "evt_a", observedAt: "2026-04-26T12:00:00.000Z", delivered: false }),
  ]);
  const result = updateAlertDeliveryStatus(
    {
      alertId: "evt_a",
      delivered: true,
      attemptedAt: "2026-04-26T13:00:00.000Z",
    },
    makeStoreDeps(data),
  );

  assert.equal(result?.delivered, true);
  assert.equal(data.alertEvents[0].delivered, true);
});

test("updateAlertDeliveryStatus clears deliveryError on successful retry", () => {
  const data = makeStore([
    makeRecord({
      id: "evt_a",
      observedAt: "2026-04-26T12:00:00.000Z",
      delivered: false,
      deliveryError: "network: timeout",
    }),
  ]);
  const result = updateAlertDeliveryStatus(
    {
      alertId: "evt_a",
      delivered: true,
      attemptedAt: "2026-04-26T13:00:00.000Z",
    },
    makeStoreDeps(data),
  );

  assert.equal(result?.delivered, true);
  assert.equal(result?.deliveryError, undefined);
  assert.equal(data.alertEvents[0].deliveryError, undefined);
});

test("updateAlertDeliveryStatus preserves deliveryError when neither delivered nor error provided", () => {
  const data = makeStore([
    makeRecord({
      id: "evt_a",
      observedAt: "2026-04-26T12:00:00.000Z",
      delivered: false,
      deliveryError: "network: timeout",
    }),
  ]);
  const result = updateAlertDeliveryStatus(
    {
      alertId: "evt_a",
      delivered: false,
      attemptedAt: "2026-04-26T13:00:00.000Z",
    },
    makeStoreDeps(data),
  );

  assert.equal(result?.delivered, false);
  assert.equal(result?.deliveryError, "network: timeout");
  assert.equal(data.alertEvents[0].deliveryError, "network: timeout");
});

test("updateAlertDeliveryStatus updates deadLettered when provided", () => {
  const data = makeStore([
    makeRecord({ id: "evt_a", observedAt: "2026-04-26T12:00:00.000Z", delivered: false }),
  ]);
  data.alertEvents[0].deadLettered = false;

  const result = updateAlertDeliveryStatus(
    {
      alertId: "evt_a",
      delivered: false,
      deliveryError: "exhausted",
      deadLettered: true,
      attemptedAt: "2026-04-26T13:00:00.000Z",
    },
    makeStoreDeps(data),
  );

  assert.equal(result?.deadLettered, true);
  assert.equal(data.alertEvents[0].deadLettered, true);
});
