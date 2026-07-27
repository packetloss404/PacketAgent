import assert from "node:assert/strict";
import test from "node:test";
import {
  ALERTS_DELIVER_JOB_TYPE,
  ALERTS_EVALUATE_JOB_TYPE,
  ensureAlertsCronJob,
  handleAlertsEvaluateJob,
  type AlertsEvaluateHandlerDeps,
} from "./alerts-evaluate-handler.js";
import type { AlertEvent, EvaluateAlertsInput } from "./alert-engine.js";
import type { AlertWebhookConfig, DeliverAlertWebhookResult } from "./alert-webhook.js";
import type { OperationsHealthReport } from "../operations-health.js";
import type { JobTypeMetrics } from "../jobs/scheduler-metrics.js";
import type { EnqueueJobInput } from "../jobs/store.js";
import type { JobRecord, PacketAgentData } from "../packetagent-store.js";
import { nextAfter } from "../jobs/cron.js";

function makeStore(jobs: JobRecord[] = []): PacketAgentData {
  return { jobs: [...jobs] } as unknown as PacketAgentData;
}

function makeJob(overrides: Partial<JobRecord> & { id: string; type: string; status: JobRecord["status"] }): JobRecord {
  return {
    id: overrides.id,
    workspaceId: overrides.workspaceId ?? "__system__",
    type: overrides.type,
    payload: overrides.payload ?? {},
    status: overrides.status,
    attempts: overrides.attempts ?? 0,
    maxAttempts: overrides.maxAttempts ?? 3,
    scheduledAt: overrides.scheduledAt ?? "2026-04-26T12:00:00.000Z",
    createdAt: overrides.createdAt ?? "2026-04-26T12:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-26T12:00:00.000Z",
    ...(overrides.cron ? { cron: overrides.cron } : {}),
  };
}

function makeHealth(): OperationsHealthReport {
  return {
    generatedAt: "2026-04-26T12:00:00.000Z",
    overall: "ok",
    subsystems: [],
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

interface RecordCall {
  events: AlertEvent[];
  deliveryOk: boolean;
  deliveryError: string | undefined;
  options: { retentionDays?: number } | undefined;
}

function makeDeps(overrides: {
  events?: AlertEvent[];
  config?: AlertWebhookConfig | null;
  deliverResult?: DeliverAlertWebhookResult;
  metrics?: JobTypeMetrics[];
  health?: OperationsHealthReport;
  env?: NodeJS.ProcessEnv;
} = {}): {
  deps: AlertsEvaluateHandlerDeps;
  evaluateCalls: EvaluateAlertsInput[];
  deliverCalls: Array<{ config: AlertWebhookConfig; events: AlertEvent[] }>;
  recordCalls: RecordCall[];
  enqueueDeliverCalls: EnqueueJobInput[];
} {
  const evaluateCalls: EvaluateAlertsInput[] = [];
  const deliverCalls: Array<{ config: AlertWebhookConfig; events: AlertEvent[] }> = [];
  const recordCalls: RecordCall[] = [];
  const enqueueDeliverCalls: EnqueueJobInput[] = [];
  const events = overrides.events ?? [];
  const deps: AlertsEvaluateHandlerDeps = {
    evaluate: (input) => {
      evaluateCalls.push(input);
      return events;
    },
    health: () => overrides.health ?? makeHealth(),
    metrics: () => overrides.metrics ?? [],
    webhookConfig: () => overrides.config ?? null,
    deliver: async (config, evts) => {
      deliverCalls.push({ config, events: evts });
      return overrides.deliverResult ?? { ok: true, status: 200 };
    },
    record: (evts, deliveryOk, deliveryError, options) => {
      recordCalls.push({ events: evts, deliveryOk, deliveryError, options });
      return { stored: evts.length, pruned: 0 };
    },
    enqueueDeliverJob: (input) => {
      enqueueDeliverCalls.push(input);
      return {
        id: `deliver-${enqueueDeliverCalls.length}`,
        workspaceId: input.workspaceId,
        type: input.type,
        payload: input.payload ?? {},
        status: "queued",
        attempts: 0,
        maxAttempts: input.maxAttempts ?? 3,
        scheduledAt: input.scheduledAt ?? "2026-04-26T12:00:00.000Z",
        createdAt: "2026-04-26T12:00:00.000Z",
        updatedAt: "2026-04-26T12:00:00.000Z",
      };
    },
    env: overrides.env ?? {},
    now: () => new Date("2026-04-26T12:00:00.000Z"),
  };
  return { deps, evaluateCalls, deliverCalls, recordCalls, enqueueDeliverCalls };
}

function captureWarn(): { restore: () => void; calls: unknown[][] } {
  const original = console.warn;
  const calls: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    calls.push(args);
  };
  return {
    restore: () => {
      console.warn = original;
    },
    calls,
  };
}

test("handleAlertsEvaluateJob with no events skips delivery and records nothing extra", async () => {
  const { deps, evaluateCalls, deliverCalls, recordCalls, enqueueDeliverCalls } = makeDeps({ events: [] });
  const result = await handleAlertsEvaluateJob({}, deps);

  assert.equal(evaluateCalls.length, 1);
  assert.equal(deliverCalls.length, 0);
  assert.equal(recordCalls.length, 1);
  assert.equal(recordCalls[0].deliveryOk, true);
  assert.equal(recordCalls[0].deliveryError, undefined);
  assert.equal(result.eventCount, 0);
  assert.equal(result.delivered, true);
  assert.equal(result.storedCount, 0);
  assert.equal(result.pruned, 0);
  assert.equal(result.enqueuedDeliverJobs, 0);
  assert.equal(enqueueDeliverCalls.length, 0);
  assert.equal(result.evaluatedAt, "2026-04-26T12:00:00.000Z");
});

test("handleAlertsEvaluateJob delivers when events present and webhook configured", async () => {
  const events = [makeEvent({ id: "evt_1", severity: "critical" })];
  const config: AlertWebhookConfig = {
    url: "https://example.com/hook",
    secretHeader: "x-packetagent-alert-secret",
    timeoutMs: 5000,
  };
  const { deps, deliverCalls, recordCalls, enqueueDeliverCalls } = makeDeps({
    events,
    config,
    deliverResult: { ok: true, status: 200 },
  });
  const result = await handleAlertsEvaluateJob({}, deps);

  assert.equal(deliverCalls.length, 1);
  assert.equal(deliverCalls[0].config, config);
  assert.deepEqual(deliverCalls[0].events, events);
  assert.equal(recordCalls[0].deliveryOk, true);
  assert.equal(recordCalls[0].deliveryError, undefined);
  assert.equal(result.delivered, true);
  assert.equal(result.eventCount, 1);
  assert.equal(result.storedCount, 1);
  assert.equal(result.enqueuedDeliverJobs, 0);
  assert.equal(enqueueDeliverCalls.length, 0);
});

test("handleAlertsEvaluateJob records delivery failure when webhook returns ok=false", async () => {
  const events = [makeEvent({ id: "evt_1" })];
  const config: AlertWebhookConfig = {
    url: "https://example.com/hook",
    secretHeader: "x-packetagent-alert-secret",
    timeoutMs: 5000,
  };
  const { deps, recordCalls } = makeDeps({
    events,
    config,
    deliverResult: { ok: false, status: 503, error: "http 503" },
  });
  const result = await handleAlertsEvaluateJob({}, deps);

  assert.equal(result.delivered, false);
  assert.equal(result.deliveryError, "http 503");
  assert.equal(recordCalls[0].deliveryOk, false);
  assert.equal(recordCalls[0].deliveryError, "http 503");
});

test("handleAlertsEvaluateJob enqueues a deliver retry job for each undelivered event when delivery fails", async () => {
  const events = [
    makeEvent({ id: "evt_1" }),
    makeEvent({ id: "evt_2", severity: "critical" }),
  ];
  const config: AlertWebhookConfig = {
    url: "https://example.com/hook",
    secretHeader: "x-packetagent-alert-secret",
    timeoutMs: 5000,
  };
  const { deps, enqueueDeliverCalls } = makeDeps({
    events,
    config,
    deliverResult: { ok: false, status: 502, error: "http 502" },
  });
  const result = await handleAlertsEvaluateJob({}, deps);

  assert.equal(result.delivered, false);
  assert.equal(result.enqueuedDeliverJobs, 2);
  assert.equal(enqueueDeliverCalls.length, 2);
  for (let index = 0; index < enqueueDeliverCalls.length; index += 1) {
    const call = enqueueDeliverCalls[index];
    assert.equal(call.type, ALERTS_DELIVER_JOB_TYPE);
    assert.equal(call.workspaceId, "__system__");
    assert.deepEqual(call.payload, { alertId: events[index].id });
    assert.ok(typeof call.maxAttempts === "number" && call.maxAttempts >= 1);
    assert.equal(call.maxAttempts, 2);
    assert.equal(call.scheduledAt, "2026-04-26T12:00:00.000Z");
  }
});

test("handleAlertsEvaluateJob honors custom PACKETAGENT_ALERT_DELIVER_MAX_ATTEMPTS env knob", async () => {
  const events = [makeEvent({ id: "evt_1" })];
  const config: AlertWebhookConfig = {
    url: "https://example.com/hook",
    secretHeader: "x-packetagent-alert-secret",
    timeoutMs: 5000,
  };
  const { deps, enqueueDeliverCalls } = makeDeps({
    events,
    config,
    deliverResult: { ok: false, status: 500, error: "http 500" },
    env: { PACKETAGENT_ALERT_DELIVER_MAX_ATTEMPTS: "5" },
  });
  await handleAlertsEvaluateJob({}, deps);

  assert.equal(enqueueDeliverCalls.length, 1);
  assert.equal(enqueueDeliverCalls[0].maxAttempts, 4);
});

test("handleAlertsEvaluateJob clamps deliver retry maxAttempts to >= 1", async () => {
  const events = [makeEvent({ id: "evt_1" })];
  const config: AlertWebhookConfig = {
    url: "https://example.com/hook",
    secretHeader: "x-packetagent-alert-secret",
    timeoutMs: 5000,
  };
  const { deps, enqueueDeliverCalls } = makeDeps({
    events,
    config,
    deliverResult: { ok: false, status: 500, error: "http 500" },
    env: { PACKETAGENT_ALERT_DELIVER_MAX_ATTEMPTS: "1" },
  });
  await handleAlertsEvaluateJob({}, deps);

  assert.equal(enqueueDeliverCalls.length, 1);
  assert.equal(enqueueDeliverCalls[0].maxAttempts, 1);
});

test("handleAlertsEvaluateJob falls back to default deliver max attempts when env is invalid", async () => {
  const events = [makeEvent({ id: "evt_1" })];
  const config: AlertWebhookConfig = {
    url: "https://example.com/hook",
    secretHeader: "x-packetagent-alert-secret",
    timeoutMs: 5000,
  };
  const cases = ["", "abc", "0", "-2", "1.5"];
  for (const value of cases) {
    const { deps, enqueueDeliverCalls } = makeDeps({
      events,
      config,
      deliverResult: { ok: false, status: 500, error: "http 500" },
      env: { PACKETAGENT_ALERT_DELIVER_MAX_ATTEMPTS: value },
    });
    await handleAlertsEvaluateJob({}, deps);
    assert.equal(enqueueDeliverCalls.length, 1, `case ${JSON.stringify(value)}`);
    assert.equal(enqueueDeliverCalls[0].maxAttempts, 2, `case ${JSON.stringify(value)}`);
  }
});

test("handleAlertsEvaluateJob honors workspace env override on retry jobs", async () => {
  const events = [makeEvent({ id: "evt_1" })];
  const config: AlertWebhookConfig = {
    url: "https://example.com/hook",
    secretHeader: "x-packetagent-alert-secret",
    timeoutMs: 5000,
  };
  const { deps, enqueueDeliverCalls } = makeDeps({
    events,
    config,
    deliverResult: { ok: false, status: 500, error: "boom" },
    env: { PACKETAGENT_ALERT_WORKSPACE_ID: "ops-workspace" },
  });
  await handleAlertsEvaluateJob({}, deps);

  assert.equal(enqueueDeliverCalls.length, 1);
  assert.equal(enqueueDeliverCalls[0].workspaceId, "ops-workspace");
});

test("handleAlertsEvaluateJob with events but null webhook config persists with informational error", async () => {
  const events = [makeEvent({ id: "evt_1" })];
  const { deps, deliverCalls, recordCalls, enqueueDeliverCalls } = makeDeps({ events, config: null });
  const result = await handleAlertsEvaluateJob({}, deps);

  assert.equal(deliverCalls.length, 0);
  assert.equal(result.delivered, true);
  assert.equal(result.deliveryError, "webhook not configured");
  assert.equal(recordCalls[0].deliveryOk, true);
  assert.equal(recordCalls[0].deliveryError, "webhook not configured");
  assert.equal(result.enqueuedDeliverJobs, 0);
  assert.equal(enqueueDeliverCalls.length, 0);
});

test("handleAlertsEvaluateJob passes payload thresholds to evaluate", async () => {
  const { deps, evaluateCalls } = makeDeps({ events: [] });
  await handleAlertsEvaluateJob({ jobFailureRateThreshold: 0.25, jobFailureMinSamples: 10 }, deps);

  assert.equal(evaluateCalls[0].jobFailureRateThreshold, 0.25);
  assert.equal(evaluateCalls[0].jobFailureMinSamples, 10);
});

test("handleAlertsEvaluateJob falls back to env thresholds when payload omits them", async () => {
  const { deps, evaluateCalls } = makeDeps({
    events: [],
    env: {
      PACKETAGENT_ALERT_JOB_FAILURE_RATE_THRESHOLD: "0.75",
      PACKETAGENT_ALERT_JOB_FAILURE_MIN_SAMPLES: "20",
    },
  });
  await handleAlertsEvaluateJob({}, deps);

  assert.equal(evaluateCalls[0].jobFailureRateThreshold, 0.75);
  assert.equal(evaluateCalls[0].jobFailureMinSamples, 20);
});

test("handleAlertsEvaluateJob defaults thresholds when neither payload nor env provide them", async () => {
  const { deps, evaluateCalls } = makeDeps({ events: [] });
  await handleAlertsEvaluateJob({}, deps);

  assert.equal(evaluateCalls[0].jobFailureRateThreshold, 0.5);
  assert.equal(evaluateCalls[0].jobFailureMinSamples, 5);
});

test("handleAlertsEvaluateJob forwards retentionDays to record", async () => {
  const { deps, recordCalls } = makeDeps({ events: [makeEvent({ id: "e" })] });
  await handleAlertsEvaluateJob({ retentionDays: 7 }, deps);

  assert.deepEqual(recordCalls[0].options, { retentionDays: 7 });
});

test("handleAlertsEvaluateJob falls back to env retention when payload omits it", async () => {
  const { deps, recordCalls } = makeDeps({
    events: [makeEvent({ id: "e" })],
    env: { PACKETAGENT_ALERT_RETENTION_DAYS: "14" },
  });
  await handleAlertsEvaluateJob({}, deps);

  assert.deepEqual(recordCalls[0].options, { retentionDays: 14 });
});

test("ensureAlertsCronJob returns skipped when cron env is unset", () => {
  const enqueueCalls: EnqueueJobInput[] = [];
  const result = ensureAlertsCronJob({
    env: {},
    loadStore: () => makeStore(),
    enqueue: (input) => {
      enqueueCalls.push(input);
      return makeJob({ id: "should-not-happen", type: input.type, status: "queued" });
    },
  });
  assert.deepEqual(result, { action: "skipped" });
  assert.equal(enqueueCalls.length, 0);
});

test("ensureAlertsCronJob returns skipped and warns when cron is invalid", () => {
  const warn = captureWarn();
  try {
    const enqueueCalls: EnqueueJobInput[] = [];
    const result = ensureAlertsCronJob({
      env: { PACKETAGENT_ALERT_EVALUATE_CRON: "this is not cron" },
      loadStore: () => makeStore(),
      enqueue: (input) => {
        enqueueCalls.push(input);
        return makeJob({ id: "x", type: input.type, status: "queued" });
      },
    });
    assert.deepEqual(result, { action: "skipped" });
    assert.equal(enqueueCalls.length, 0);
    assert.equal(warn.calls.length, 1);
    const message = String(warn.calls[0][0]);
    assert.ok(message.includes("alerts.evaluate"), `expected warning to mention alerts.evaluate, got: ${message}`);
  } finally {
    warn.restore();
  }
});

test("ensureAlertsCronJob returns exists when an active recurring job is present", () => {
  const cron = "0 * * * *";
  const existing = makeJob({
    id: "existing-1",
    type: ALERTS_EVALUATE_JOB_TYPE,
    status: "queued",
    cron,
  });
  const enqueueCalls: EnqueueJobInput[] = [];
  const result = ensureAlertsCronJob({
    env: { PACKETAGENT_ALERT_EVALUATE_CRON: cron },
    loadStore: () => makeStore([existing]),
    enqueue: (input) => {
      enqueueCalls.push(input);
      return makeJob({ id: "new", type: input.type, status: "queued" });
    },
  });
  assert.deepEqual(result, { action: "exists", jobId: "existing-1" });
  assert.equal(enqueueCalls.length, 0);
});

test("ensureAlertsCronJob enqueues with default workspaceId, retentionDays, and computed scheduledAt", () => {
  const cron = "0 * * * *";
  const enqueueCalls: EnqueueJobInput[] = [];
  const before = new Date();
  const result = ensureAlertsCronJob({
    env: { PACKETAGENT_ALERT_EVALUATE_CRON: cron },
    loadStore: () => makeStore(),
    enqueue: (input) => {
      enqueueCalls.push(input);
      return makeJob({ id: "new-2", type: input.type, status: "queued", cron: input.cron });
    },
  });
  assert.deepEqual(result, { action: "enqueued", jobId: "new-2" });
  assert.equal(enqueueCalls.length, 1);
  const call = enqueueCalls[0];
  assert.equal(call.type, ALERTS_EVALUATE_JOB_TYPE);
  assert.equal(call.cron, cron);
  assert.equal(call.workspaceId, "__system__");
  assert.deepEqual(call.payload, { retentionDays: 30 });
  assert.ok(call.scheduledAt, "scheduledAt should be set");
  const scheduledMs = Date.parse(call.scheduledAt!);
  const expectedAtLeast = nextAfter(cron, before).getTime();
  assert.ok(scheduledMs >= expectedAtLeast);
  assert.ok(scheduledMs > Date.now());
});

test("ensureAlertsCronJob honors custom workspaceId env override", () => {
  const cron = "0 * * * *";
  const enqueueCalls: EnqueueJobInput[] = [];
  ensureAlertsCronJob({
    env: {
      PACKETAGENT_ALERT_EVALUATE_CRON: cron,
      PACKETAGENT_ALERT_WORKSPACE_ID: "ops-workspace",
    },
    loadStore: () => makeStore(),
    enqueue: (input) => {
      enqueueCalls.push(input);
      return makeJob({ id: "new-3", type: input.type, status: "queued", cron: input.cron });
    },
  });
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].workspaceId, "ops-workspace");
});

test("ensureAlertsCronJob honors valid custom retentionDays env override", () => {
  const cron = "0 * * * *";
  const enqueueCalls: EnqueueJobInput[] = [];
  ensureAlertsCronJob({
    env: {
      PACKETAGENT_ALERT_EVALUATE_CRON: cron,
      PACKETAGENT_ALERT_RETENTION_DAYS: "7",
    },
    loadStore: () => makeStore(),
    enqueue: (input) => {
      enqueueCalls.push(input);
      return makeJob({ id: "new-4", type: input.type, status: "queued", cron: input.cron });
    },
  });
  assert.equal(enqueueCalls.length, 1);
  assert.deepEqual(enqueueCalls[0].payload, { retentionDays: 7 });
});

test("ensureAlertsCronJob falls back to default retention when env value is invalid", () => {
  const cron = "0 * * * *";
  const cases = ["", "-1", "abc", "1.5"];
  for (const value of cases) {
    const enqueueCalls: EnqueueJobInput[] = [];
    ensureAlertsCronJob({
      env: {
        PACKETAGENT_ALERT_EVALUATE_CRON: cron,
        PACKETAGENT_ALERT_RETENTION_DAYS: value,
      },
      loadStore: () => makeStore(),
      enqueue: (input) => {
        enqueueCalls.push(input);
        return makeJob({ id: "fallback", type: input.type, status: "queued", cron: input.cron });
      },
    });
    assert.equal(enqueueCalls.length, 1);
    assert.deepEqual(enqueueCalls[0].payload, { retentionDays: 30 });
  }
});
