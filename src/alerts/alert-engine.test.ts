import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAlerts } from "./alert-engine.js";
import type {
  OperationsHealthReport,
  SubsystemHealth,
  SubsystemStatus,
} from "../operations-health.js";
import type { JobTypeMetrics } from "../jobs/scheduler-metrics.js";

function makeSubsystem(
  overrides: Partial<SubsystemHealth> & { name: string; status: SubsystemStatus },
): SubsystemHealth {
  return {
    name: overrides.name,
    status: overrides.status,
    detail: overrides.detail ?? `${overrides.name} ${overrides.status}`,
    checkedAt: overrides.checkedAt ?? "2026-04-26T00:00:00.000Z",
    observedAt: overrides.observedAt,
  };
}

function makeHealth(
  subsystems: SubsystemHealth[],
  overall: SubsystemStatus = "ok",
): OperationsHealthReport {
  return {
    generatedAt: "2026-04-26T00:00:00.000Z",
    overall,
    subsystems,
  };
}

function makeMetric(overrides: Partial<JobTypeMetrics> & { type: string }): JobTypeMetrics {
  return {
    type: overrides.type,
    totalRuns: overrides.totalRuns ?? 0,
    succeededRuns: overrides.succeededRuns ?? 0,
    failedRuns: overrides.failedRuns ?? 0,
    canceledRuns: overrides.canceledRuns ?? 0,
    lastRunStartedAt: overrides.lastRunStartedAt ?? null,
    lastRunFinishedAt: overrides.lastRunFinishedAt ?? null,
    lastDurationMs: overrides.lastDurationMs ?? null,
    averageDurationMs: overrides.averageDurationMs ?? null,
    p95DurationMs: overrides.p95DurationMs ?? null,
  };
}

function makeIdGenerator(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `id-${counter}`;
  };
}

const fixedNow = () => new Date("2026-04-26T12:00:00.000Z");

test("evaluateAlerts returns empty array when nothing is wrong", () => {
  const result = evaluateAlerts(
    {
      health: makeHealth([
        makeSubsystem({ name: "store", status: "ok" }),
        makeSubsystem({ name: "scheduler", status: "ok" }),
      ]),
      metrics: [],
    },
    { now: fixedNow, generateId: makeIdGenerator() },
  );
  assert.deepEqual(result, []);
});

test("evaluateAlerts emits a warning for a degraded subsystem", () => {
  const result = evaluateAlerts(
    {
      health: makeHealth([
        makeSubsystem({
          name: "scheduler",
          status: "degraded",
          detail: "last tick was 90s ago",
          observedAt: "2026-04-26T11:58:30.000Z",
        }),
      ]),
      metrics: [],
    },
    { now: fixedNow, generateId: makeIdGenerator() },
  );
  assert.equal(result.length, 1);
  const [event] = result;
  assert.equal(event.ruleId, "subsystem-degraded");
  assert.equal(event.severity, "warning");
  assert.equal(event.title, "Subsystem scheduler degraded");
  assert.equal(event.detail, "last tick was 90s ago");
  assert.equal(event.observedAt, "2026-04-26T12:00:00.000Z");
  assert.deepEqual(event.context, {
    subsystem: "scheduler",
    status: "degraded",
    observedAt: "2026-04-26T11:58:30.000Z",
  });
  assert.equal(event.id, "id-1");
});

test("evaluateAlerts emits a critical event for a down subsystem", () => {
  const result = evaluateAlerts(
    {
      health: makeHealth([
        makeSubsystem({ name: "store", status: "down", detail: "store load failed: io" }),
      ]),
      metrics: [],
    },
    { now: fixedNow, generateId: makeIdGenerator() },
  );
  assert.equal(result.length, 1);
  const [event] = result;
  assert.equal(event.ruleId, "subsystem-down");
  assert.equal(event.severity, "critical");
  assert.equal(event.title, "Subsystem store down");
  assert.equal(event.context.status, "down");
  assert.equal(event.context.observedAt, null);
});

test("evaluateAlerts does not fire when failure rate is exactly at threshold", () => {
  const result = evaluateAlerts(
    {
      health: makeHealth([]),
      metrics: [
        makeMetric({
          type: "send-email",
          totalRuns: 10,
          succeededRuns: 5,
          failedRuns: 5,
        }),
      ],
    },
    { now: fixedNow, generateId: makeIdGenerator() },
  );
  assert.deepEqual(result, []);
});

test("evaluateAlerts emits a warning when failure rate is just above threshold", () => {
  const result = evaluateAlerts(
    {
      health: makeHealth([]),
      metrics: [
        makeMetric({
          type: "send-email",
          totalRuns: 10,
          succeededRuns: 4,
          failedRuns: 6,
        }),
      ],
    },
    { now: fixedNow, generateId: makeIdGenerator() },
  );
  assert.equal(result.length, 1);
  const [event] = result;
  assert.equal(event.ruleId, "job-failure-rate");
  assert.equal(event.severity, "warning");
  assert.equal(event.title, "Job type send-email failing");
  assert.equal(event.detail, "60% failure rate over 10 recent runs");
  assert.deepEqual(event.context, {
    type: "send-email",
    totalRuns: 10,
    failedRuns: 6,
    canceledRuns: 0,
    succeededRuns: 4,
    failureRate: 0.6,
  });
});

test("evaluateAlerts escalates to critical when failure rate exceeds 0.8", () => {
  const result = evaluateAlerts(
    {
      health: makeHealth([]),
      metrics: [
        makeMetric({
          type: "send-email",
          totalRuns: 10,
          succeededRuns: 1,
          failedRuns: 9,
        }),
      ],
    },
    { now: fixedNow, generateId: makeIdGenerator() },
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].severity, "critical");
  assert.equal(result[0].ruleId, "job-failure-rate");
});

test("evaluateAlerts ignores job metrics with fewer than minSamples runs", () => {
  const result = evaluateAlerts(
    {
      health: makeHealth([]),
      metrics: [
        makeMetric({
          type: "send-email",
          totalRuns: 4,
          succeededRuns: 0,
          failedRuns: 4,
        }),
      ],
    },
    { now: fixedNow, generateId: makeIdGenerator() },
  );
  assert.deepEqual(result, []);
});

test("evaluateAlerts respects custom jobFailureMinSamples", () => {
  const result = evaluateAlerts(
    {
      health: makeHealth([]),
      metrics: [
        makeMetric({
          type: "send-email",
          totalRuns: 4,
          succeededRuns: 0,
          failedRuns: 4,
        }),
      ],
      jobFailureMinSamples: 4,
    },
    { now: fixedNow, generateId: makeIdGenerator() },
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].ruleId, "job-failure-rate");
});

test("evaluateAlerts emits multiple events sorted by severity then ruleId", () => {
  const result = evaluateAlerts(
    {
      health: makeHealth([
        makeSubsystem({ name: "scheduler", status: "degraded" }),
        makeSubsystem({ name: "store", status: "down" }),
      ]),
      metrics: [
        makeMetric({
          type: "send-email",
          totalRuns: 10,
          succeededRuns: 1,
          failedRuns: 9,
        }),
        makeMetric({
          type: "reconcile",
          totalRuns: 10,
          succeededRuns: 4,
          failedRuns: 6,
        }),
      ],
    },
    { now: fixedNow, generateId: makeIdGenerator() },
  );
  assert.equal(result.length, 4);
  assert.deepEqual(
    result.map((event) => ({ ruleId: event.ruleId, severity: event.severity })),
    [
      { ruleId: "job-failure-rate", severity: "critical" },
      { ruleId: "subsystem-down", severity: "critical" },
      { ruleId: "job-failure-rate", severity: "warning" },
      { ruleId: "subsystem-degraded", severity: "warning" },
    ],
  );
});

test("evaluateAlerts deduplicates by ruleId + subsystem name", () => {
  const result = evaluateAlerts(
    {
      health: makeHealth([
        makeSubsystem({ name: "scheduler", status: "degraded", detail: "first" }),
        makeSubsystem({ name: "scheduler", status: "degraded", detail: "second" }),
      ]),
      metrics: [],
    },
    { now: fixedNow, generateId: makeIdGenerator() },
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].detail, "first");
});

test("evaluateAlerts uses injected now and generateId for deterministic output", () => {
  const result = evaluateAlerts(
    {
      health: makeHealth([makeSubsystem({ name: "scheduler", status: "degraded" })]),
      metrics: [],
    },
    {
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      generateId: () => "fixed-id",
    },
  );
  assert.equal(result[0].id, "fixed-id");
  assert.equal(result[0].observedAt, "2030-01-01T00:00:00.000Z");
});
