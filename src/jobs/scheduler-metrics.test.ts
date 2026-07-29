import { test } from "node:test";
import assert from "node:assert/strict";
import {
  __overrideWindowSizeForTests,
  __resetSchedulerMetricsForTests,
  getJobTypeMetrics,
  recordJobRun,
} from "./scheduler-metrics.js";

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

test("getJobTypeMetrics returns empty when nothing recorded", () => {
  __resetSchedulerMetricsForTests();
  assert.deepEqual(getJobTypeMetrics(), []);
});

test("single success populates counters and last fields", () => {
  __resetSchedulerMetricsForTests();
  const startedAt = isoAt(1_700_000_000_000);
  const finishedAt = isoAt(1_700_000_000_500);
  recordJobRun({ type: "demo", startedAt, finishedAt, durationMs: 500, status: "success" });
  const metrics = getJobTypeMetrics();
  assert.equal(metrics.length, 1);
  const entry = metrics[0];
  assert.equal(entry.type, "demo");
  assert.equal(entry.totalRuns, 1);
  assert.equal(entry.succeededRuns, 1);
  assert.equal(entry.failedRuns, 0);
  assert.equal(entry.canceledRuns, 0);
  assert.equal(entry.lastRunStartedAt, startedAt);
  assert.equal(entry.lastRunFinishedAt, finishedAt);
  assert.equal(entry.lastDurationMs, 500);
  assert.equal(entry.averageDurationMs, 500);
  assert.equal(entry.p95DurationMs, null);
});

test("multiple successes compute mean and p95", () => {
  __resetSchedulerMetricsForTests();
  const durations = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  for (const durationMs of durations) {
    recordJobRun({
      type: "demo",
      startedAt: isoAt(1_700_000_000_000),
      finishedAt: isoAt(1_700_000_000_000 + durationMs),
      durationMs,
      status: "success",
    });
  }
  const metrics = getJobTypeMetrics();
  assert.equal(metrics.length, 1);
  const entry = metrics[0];
  assert.equal(entry.totalRuns, 10);
  assert.equal(entry.succeededRuns, 10);
  assert.equal(entry.averageDurationMs, 55);
  assert.ok(entry.p95DurationMs !== null);
  assert.ok(entry.p95DurationMs! >= 90 && entry.p95DurationMs! <= 100);
  assert.equal(entry.lastDurationMs, 100);
});

test("failure-only run leaves duration aggregates null but tracks last duration", () => {
  __resetSchedulerMetricsForTests();
  recordJobRun({
    type: "demo",
    startedAt: isoAt(1_700_000_000_000),
    finishedAt: isoAt(1_700_000_030_000),
    durationMs: 30_000,
    status: "failed",
  });
  const metrics = getJobTypeMetrics();
  assert.equal(metrics.length, 1);
  const entry = metrics[0];
  assert.equal(entry.totalRuns, 1);
  assert.equal(entry.succeededRuns, 0);
  assert.equal(entry.failedRuns, 1);
  assert.equal(entry.canceledRuns, 0);
  assert.equal(entry.averageDurationMs, null);
  assert.equal(entry.p95DurationMs, null);
  assert.equal(entry.lastDurationMs, 30_000);
});

test("rolling window evicts oldest successes once full", () => {
  __resetSchedulerMetricsForTests();
  __overrideWindowSizeForTests(3);
  for (const durationMs of [100, 200, 300, 1_000, 1_100, 1_200]) {
    recordJobRun({
      type: "demo",
      startedAt: isoAt(1_700_000_000_000),
      finishedAt: isoAt(1_700_000_000_000 + durationMs),
      durationMs,
      status: "success",
    });
  }
  const metrics = getJobTypeMetrics();
  assert.equal(metrics.length, 1);
  const entry = metrics[0];
  assert.equal(entry.totalRuns, 6);
  assert.equal(entry.succeededRuns, 6);
  assert.equal(entry.averageDurationMs, (1_000 + 1_100 + 1_200) / 3);
  assert.equal(entry.lastDurationMs, 1_200);
});

test("getJobTypeMetrics returns multiple types sorted ascending", () => {
  __resetSchedulerMetricsForTests();
  const startedAt = isoAt(1_700_000_000_000);
  const finishedAt = isoAt(1_700_000_000_100);
  recordJobRun({ type: "zeta", startedAt, finishedAt, durationMs: 100, status: "success" });
  recordJobRun({ type: "alpha", startedAt, finishedAt, durationMs: 100, status: "success" });
  recordJobRun({ type: "mu", startedAt, finishedAt, durationMs: 100, status: "success" });
  const metrics = getJobTypeMetrics();
  assert.deepEqual(
    metrics.map((entry) => entry.type),
    ["alpha", "mu", "zeta"],
  );
});

test("__resetSchedulerMetricsForTests clears every record", () => {
  __resetSchedulerMetricsForTests();
  recordJobRun({
    type: "demo",
    startedAt: isoAt(1_700_000_000_000),
    finishedAt: isoAt(1_700_000_000_500),
    durationMs: 500,
    status: "success",
  });
  assert.equal(getJobTypeMetrics().length, 1);
  __resetSchedulerMetricsForTests();
  assert.deepEqual(getJobTypeMetrics(), []);
});
