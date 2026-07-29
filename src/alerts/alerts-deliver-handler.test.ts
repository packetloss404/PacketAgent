import assert from "node:assert/strict";
import test from "node:test";
import {
  ALERTS_DELIVER_JOB_TYPE,
  handleAlertsDeliverJob,
  type AlertsDeliverHandlerDeps,
} from "./alerts-deliver-handler.js";
import type { AlertEvent } from "./alert-engine.js";
import type { AlertWebhookConfig, DeliverAlertWebhookResult } from "./alert-webhook.js";
import type { UpdateAlertDeliveryStatusInput } from "./alert-store.js";
import type { AlertEventRecord, PacketAgentData } from "../packetagent-store.js";

function makeRecord(overrides: Partial<AlertEventRecord> & { id: string }): AlertEventRecord {
  return {
    id: overrides.id,
    ruleId: overrides.ruleId ?? "subsystem-degraded",
    severity: overrides.severity ?? "warning",
    title: overrides.title ?? "Title",
    detail: overrides.detail ?? "Detail",
    observedAt: overrides.observedAt ?? "2026-04-26T12:00:00.000Z",
    context: overrides.context ?? { subsystem: "store" },
    delivered: overrides.delivered ?? false,
    ...(overrides.deliveryError !== undefined ? { deliveryError: overrides.deliveryError } : {}),
    ...(overrides.deliveryAttempts !== undefined
      ? { deliveryAttempts: overrides.deliveryAttempts }
      : {}),
    ...(overrides.lastDeliveryAttemptAt !== undefined
      ? { lastDeliveryAttemptAt: overrides.lastDeliveryAttemptAt }
      : {}),
    ...(overrides.deadLettered !== undefined ? { deadLettered: overrides.deadLettered } : {}),
  };
}

function makeStore(records: AlertEventRecord[]): PacketAgentData {
  return { alertEvents: [...records] } as unknown as PacketAgentData;
}

function makeConfig(): AlertWebhookConfig {
  return {
    url: "https://example.com/hook",
    secretHeader: "x-packetagent-alert-secret",
    timeoutMs: 5000,
  };
}

interface DeliverCall {
  config: AlertWebhookConfig;
  events: AlertEvent[];
}

interface UpdateCall {
  input: UpdateAlertDeliveryStatusInput;
}

function makeDeps(overrides: {
  records: AlertEventRecord[];
  config?: AlertWebhookConfig | null;
  deliverResult?: DeliverAlertWebhookResult;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): {
  deps: AlertsDeliverHandlerDeps;
  deliverCalls: DeliverCall[];
  updateCalls: UpdateCall[];
} {
  const deliverCalls: DeliverCall[] = [];
  const updateCalls: UpdateCall[] = [];
  const records = overrides.records;
  const deps: AlertsDeliverHandlerDeps = {
    loadStore: () => makeStore(records),
    webhookConfig: () => (overrides.config === undefined ? makeConfig() : overrides.config),
    deliver: async (config, events) => {
      deliverCalls.push({ config, events });
      return overrides.deliverResult ?? { ok: true, status: 200 };
    },
    updateStatus: (input) => {
      updateCalls.push({ input });
      const target = records.find((entry) => entry.id === input.alertId);
      if (!target) return null;
      target.delivered = input.delivered;
      if (input.deliveryError !== undefined) target.deliveryError = input.deliveryError;
      target.deadLettered = input.deadLettered ?? false;
      target.lastDeliveryAttemptAt = input.attemptedAt;
      target.deliveryAttempts = (target.deliveryAttempts ?? 0) + 1;
      return target;
    },
    now: () => overrides.now ?? new Date("2026-04-26T12:00:00.000Z"),
    env: overrides.env ?? {},
  };
  return { deps, deliverCalls, updateCalls };
}

test("ALERTS_DELIVER_JOB_TYPE constant equals alerts.deliver", () => {
  assert.equal(ALERTS_DELIVER_JOB_TYPE, "alerts.deliver");
});

test("handleAlertsDeliverJob throws when alertId is missing", async () => {
  const { deps } = makeDeps({ records: [] });
  await assert.rejects(() => handleAlertsDeliverJob({ alertId: "" }, deps), /payload\.alertId/);
  await assert.rejects(() => handleAlertsDeliverJob({ alertId: "   " }, deps), /payload\.alertId/);
  await assert.rejects(
    () => handleAlertsDeliverJob({} as { alertId: string }, deps),
    /payload\.alertId/,
  );
});

test("handleAlertsDeliverJob throws 404 when alert is not found", async () => {
  const { deps } = makeDeps({ records: [makeRecord({ id: "evt_other" })] });
  await assert.rejects(
    () => handleAlertsDeliverJob({ alertId: "evt_missing" }, deps),
    (error: Error & { status?: number }) => {
      assert.equal(error.message, "alert not found");
      assert.equal(error.status, 404);
      return true;
    },
  );
});

test("handleAlertsDeliverJob no-ops when the alert is already delivered", async () => {
  const record = makeRecord({ id: "evt_a", delivered: true, deliveryAttempts: 1 });
  const { deps, deliverCalls, updateCalls } = makeDeps({ records: [record] });

  const result = await handleAlertsDeliverJob({ alertId: "evt_a" }, deps);

  assert.equal(deliverCalls.length, 0);
  assert.equal(updateCalls.length, 1);
  assert.deepEqual(updateCalls[0].input, {
    alertId: "evt_a",
    delivered: true,
    deadLettered: false,
    attemptedAt: "2026-04-26T12:00:00.000Z",
  });
  assert.deepEqual(result, {
    alertId: "evt_a",
    delivered: true,
    deadLettered: false,
    attemptNumber: 2,
  });
});

test("handleAlertsDeliverJob treats null webhook config as delivered no-op", async () => {
  const record = makeRecord({ id: "evt_a", delivered: false });
  const { deps, deliverCalls, updateCalls } = makeDeps({ records: [record], config: null });

  const result = await handleAlertsDeliverJob({ alertId: "evt_a" }, deps);

  assert.equal(deliverCalls.length, 0);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].input.delivered, true);
  assert.equal(updateCalls[0].input.deadLettered, false);
  assert.equal(result.delivered, true);
  assert.equal(result.deadLettered, false);
  assert.equal(result.attemptNumber, 1);
});

test("handleAlertsDeliverJob delivers successfully and records delivered=true", async () => {
  const record = makeRecord({ id: "evt_a", delivered: false, deliveryAttempts: 1 });
  const { deps, deliverCalls, updateCalls } = makeDeps({
    records: [record],
    deliverResult: { ok: true, status: 200 },
  });

  const result = await handleAlertsDeliverJob({ alertId: "evt_a" }, deps);

  assert.equal(deliverCalls.length, 1);
  assert.equal(deliverCalls[0].events.length, 1);
  assert.equal(deliverCalls[0].events[0].id, "evt_a");
  assert.equal(updateCalls.length, 1);
  assert.deepEqual(updateCalls[0].input, {
    alertId: "evt_a",
    delivered: true,
    deadLettered: false,
    attemptedAt: "2026-04-26T12:00:00.000Z",
  });
  assert.equal(result.delivered, true);
  assert.equal(result.deadLettered, false);
  assert.equal(result.attemptNumber, 2);
});

test("handleAlertsDeliverJob throws when delivery fails under maxAttempts", async () => {
  const record = makeRecord({ id: "evt_a", delivered: false, deliveryAttempts: 0 });
  const { deps, updateCalls } = makeDeps({
    records: [record],
    deliverResult: { ok: false, status: 503, error: "http 503" },
    env: { PACKETAGENT_ALERT_DELIVER_MAX_ATTEMPTS: "3" },
  });

  await assert.rejects(
    () => handleAlertsDeliverJob({ alertId: "evt_a" }, deps),
    (error: Error) => {
      assert.match(error.message, /alert delivery attempt 1 failed: http 503/);
      return true;
    },
  );
  assert.equal(updateCalls.length, 0);
});

test("handleAlertsDeliverJob dead-letters at maxAttempts without throwing", async () => {
  const record = makeRecord({ id: "evt_a", delivered: false, deliveryAttempts: 2 });
  const { deps, updateCalls } = makeDeps({
    records: [record],
    deliverResult: { ok: false, status: 500, error: "http 500" },
    env: { PACKETAGENT_ALERT_DELIVER_MAX_ATTEMPTS: "3" },
  });

  const result = await handleAlertsDeliverJob({ alertId: "evt_a" }, deps);

  assert.equal(result.delivered, false);
  assert.equal(result.deadLettered, true);
  assert.equal(result.attemptNumber, 3);
  assert.equal(result.deliveryError, "http 500");
  assert.equal(updateCalls.length, 1);
  assert.deepEqual(updateCalls[0].input, {
    alertId: "evt_a",
    delivered: false,
    deliveryError: "http 500",
    deadLettered: true,
    attemptedAt: "2026-04-26T12:00:00.000Z",
  });
});

test("handleAlertsDeliverJob honors custom maxAttempts via env override", async () => {
  const record = makeRecord({ id: "evt_a", delivered: false, deliveryAttempts: 0 });
  const { deps, updateCalls } = makeDeps({
    records: [record],
    deliverResult: { ok: false, error: "boom" },
    env: { PACKETAGENT_ALERT_DELIVER_MAX_ATTEMPTS: "1" },
  });

  const result = await handleAlertsDeliverJob({ alertId: "evt_a" }, deps);

  assert.equal(result.deadLettered, true);
  assert.equal(result.attemptNumber, 1);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].input.deadLettered, true);
});

test("handleAlertsDeliverJob falls back to default maxAttempts on invalid env values", async () => {
  for (const value of ["", "abc", "0", "-1", "1.5"]) {
    const record = makeRecord({ id: "evt_a", delivered: false, deliveryAttempts: 0 });
    const { deps } = makeDeps({
      records: [record],
      deliverResult: { ok: false, error: "boom" },
      env: { PACKETAGENT_ALERT_DELIVER_MAX_ATTEMPTS: value },
    });
    await assert.rejects(
      () => handleAlertsDeliverJob({ alertId: "evt_a" }, deps),
      /alert delivery attempt 1 failed/,
      `expected throw under default maxAttempts=3 with env=${JSON.stringify(value)}`,
    );
  }
});

test("handleAlertsDeliverJob delivers AlertEvent shape excluding persistence-only fields", async () => {
  const record = makeRecord({
    id: "evt_a",
    delivered: false,
    deliveryError: "previous",
    deliveryAttempts: 2,
    lastDeliveryAttemptAt: "2026-04-26T11:00:00.000Z",
    deadLettered: false,
  });
  const { deps, deliverCalls } = makeDeps({
    records: [record],
    deliverResult: { ok: true, status: 200 },
  });

  await handleAlertsDeliverJob({ alertId: "evt_a" }, deps);

  assert.equal(deliverCalls.length, 1);
  assert.equal(deliverCalls[0].events.length, 1);
  const sent = deliverCalls[0].events[0] as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(sent).sort(), [
    "context",
    "detail",
    "id",
    "observedAt",
    "ruleId",
    "severity",
    "title",
  ]);
  assert.equal("delivered" in sent, false);
  assert.equal("deliveryError" in sent, false);
  assert.equal("deliveryAttempts" in sent, false);
  assert.equal("lastDeliveryAttemptAt" in sent, false);
  assert.equal("deadLettered" in sent, false);
});
