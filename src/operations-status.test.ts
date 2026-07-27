import assert from "node:assert/strict";
import test from "node:test";
import type { JobRecord, PacketAgentData } from "./packetagent-store.js";
import {
  getOperationsStatus,
  type JobTypeMetrics,
} from "./operations-status.js";

function emptyStore(): PacketAgentData {
  return { jobs: [] } as unknown as PacketAgentData;
}

function storeWithJobs(jobs: JobRecord[]): PacketAgentData {
  return { jobs } as unknown as PacketAgentData;
}

function fakeJob(type: string, status: JobRecord["status"], id: string): JobRecord {
  return {
    id,
    workspaceId: "alpha",
    type,
    payload: {},
    status,
    attempts: 0,
    maxAttempts: 1,
    scheduledAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("default env yields json store, off leader mode, off access log, default knobs", () => {
  const status = getOperationsStatus({
    loadStore: () => emptyStore(),
    env: {},
    now: () => new Date("2026-04-26T12:00:00.000Z"),
  });

  assert.equal(status.store.mode, "json");
  assert.equal(status.scheduler.leaderMode, "off");
  assert.equal(status.scheduler.leaderTtlMs, 30000);
  assert.equal(status.scheduler.leaderHeldLocally, true);
  assert.equal(status.scheduler.lockSummary, "local");
  assert.equal(status.accessLog.mode, "off");
  assert.equal(status.accessLog.path, null);
  assert.equal(status.accessLog.maxBytes, 0);
  assert.equal(status.accessLog.maxFiles, 5);
  assert.deepEqual(status.jobs, []);
  assert.equal(status.runtime.nodeVersion, process.versions.node);
});

test("PACKETAGENT_STORE=sqlite flips store mode", () => {
  const status = getOperationsStatus({
    loadStore: () => emptyStore(),
    env: { PACKETAGENT_STORE: "sqlite" },
    now: () => new Date("2026-04-26T12:00:00.000Z"),
  });

  assert.equal(status.store.mode, "sqlite");
});

test("file leader mode reflects custom path and not-held when no probe registered", () => {
  const status = getOperationsStatus({
    loadStore: () => emptyStore(),
    env: {
      PACKETAGENT_SCHEDULER_LEADER_MODE: "FILE",
      PACKETAGENT_SCHEDULER_LEADER_FILE_PATH: "var/lib/packetagent/leader.json",
    },
    now: () => new Date("2026-04-26T12:00:00.000Z"),
  });

  assert.equal(status.scheduler.leaderMode, "file");
  assert.equal(status.scheduler.lockSummary, "var/lib/packetagent/leader.json");
  assert.equal(status.scheduler.leaderHeldLocally, false);
});

test("http leader mode strips query string from URL summary", () => {
  const status = getOperationsStatus({
    loadStore: () => emptyStore(),
    env: {
      PACKETAGENT_SCHEDULER_LEADER_MODE: "http",
      PACKETAGENT_SCHEDULER_LEADER_HTTP_URL: "https://coord.internal/leader?token=secret123&extra=yes",
    },
    now: () => new Date("2026-04-26T12:00:00.000Z"),
  });

  assert.equal(status.scheduler.leaderMode, "http");
  assert.equal(status.scheduler.lockSummary, "https://coord.internal/leader");
  assert.equal(status.scheduler.leaderHeldLocally, false);
});

test("invalid leader mode falls back to off without throwing", () => {
  const status = getOperationsStatus({
    loadStore: () => emptyStore(),
    env: { PACKETAGENT_SCHEDULER_LEADER_MODE: "bogus" },
    now: () => new Date("2026-04-26T12:00:00.000Z"),
  });

  assert.equal(status.scheduler.leaderMode, "off");
  assert.equal(status.scheduler.lockSummary, "local");
  assert.equal(status.scheduler.leaderHeldLocally, true);
});

test("jobs grouping aggregates statuses across types and uses succeeded for success", () => {
  const status = getOperationsStatus({
    loadStore: () => storeWithJobs([
      fakeJob("agent.run", "queued", "j1"),
      fakeJob("agent.run", "queued", "j2"),
      fakeJob("agent.run", "running", "j3"),
      fakeJob("agent.run", "success", "j4"),
      fakeJob("agent.run", "failed", "j5"),
      fakeJob("agent.run", "canceled", "j6"),
      fakeJob("brief.send", "queued", "j7"),
      fakeJob("brief.send", "success", "j8"),
      fakeJob("brief.send", "success", "j9"),
    ]),
    env: {},
    now: () => new Date("2026-04-26T12:00:00.000Z"),
  });

  assert.deepEqual(status.jobs, [
    { type: "agent.run", queued: 2, running: 1, succeeded: 1, failed: 1, canceled: 1 },
    { type: "brief.send", queued: 1, running: 0, succeeded: 2, failed: 0, canceled: 0 },
  ]);
});

test("access log reads max bytes, clamps max files to >= 1, and exposes file path", () => {
  const clamped = getOperationsStatus({
    loadStore: () => emptyStore(),
    env: {
      PACKETAGENT_ACCESS_LOG_MODE: "FILE",
      PACKETAGENT_ACCESS_LOG_PATH: "logs/access.log",
      PACKETAGENT_ACCESS_LOG_MAX_BYTES: "1048576",
      PACKETAGENT_ACCESS_LOG_MAX_FILES: "0",
    },
    now: () => new Date("2026-04-26T12:00:00.000Z"),
  });

  assert.equal(clamped.accessLog.mode, "file");
  assert.equal(clamped.accessLog.path, "logs/access.log");
  assert.equal(clamped.accessLog.maxBytes, 1048576);
  assert.equal(clamped.accessLog.maxFiles, 1);

  const stdoutMode = getOperationsStatus({
    loadStore: () => emptyStore(),
    env: {
      PACKETAGENT_ACCESS_LOG_MODE: "stdout",
      PACKETAGENT_ACCESS_LOG_MAX_FILES: "10",
    },
    now: () => new Date("2026-04-26T12:00:00.000Z"),
  });

  assert.equal(stdoutMode.accessLog.mode, "stdout");
  assert.equal(stdoutMode.accessLog.path, null);
  assert.equal(stdoutMode.accessLog.maxFiles, 10);
});

test("generatedAt reflects the injected now", () => {
  const fixedDate = new Date("2026-04-26T13:37:00.000Z");
  const status = getOperationsStatus({
    loadStore: () => emptyStore(),
    env: {},
    now: () => fixedDate,
  });

  assert.equal(status.generatedAt, "2026-04-26T13:37:00.000Z");
});

test("jobMetrics defaults to an empty array when the fixture returns none", () => {
  const status = getOperationsStatus({
    loadStore: () => emptyStore(),
    env: {},
    now: () => new Date("2026-04-26T12:00:00.000Z"),
    jobTypeMetrics: () => [],
  });

  assert.deepEqual(status.jobMetrics, []);
});

test("jobMetrics fixture appears verbatim in the result", () => {
  const fixture: JobTypeMetrics[] = [
    {
      type: "agent.run",
      totalRuns: 3,
      succeededRuns: 2,
      failedRuns: 1,
      canceledRuns: 0,
      lastRunStartedAt: "2026-04-26T11:59:00.000Z",
      lastRunFinishedAt: "2026-04-26T11:59:30.000Z",
      lastDurationMs: 30000,
      averageDurationMs: 25000,
      p95DurationMs: 29000,
    },
  ];
  const status = getOperationsStatus({
    loadStore: () => emptyStore(),
    env: {},
    now: () => new Date("2026-04-26T12:00:00.000Z"),
    jobTypeMetrics: () => fixture,
  });

  assert.deepEqual(status.jobMetrics, fixture);
});

test("jobMetricsSnapshots reports zero and null when the store has no snapshots", () => {
  const status = getOperationsStatus({
    loadStore: () => emptyStore(),
    env: {},
    now: () => new Date("2026-04-26T12:00:00.000Z"),
  });

  assert.deepEqual(status.jobMetricsSnapshots, { total: 0, lastCapturedAt: null });
});

test("jobMetricsSnapshots picks the max capturedAt across out-of-order rows", () => {
  const store = {
    jobs: [],
    jobMetricSnapshots: [
      { id: "s1", capturedAt: "2026-01-01T00:00:00.000Z", type: "agent.run" },
      { id: "s2", capturedAt: "2026-01-03T00:00:00.000Z", type: "agent.run" },
      { id: "s3", capturedAt: "2026-01-02T00:00:00.000Z", type: "agent.run" },
    ],
  } as unknown as PacketAgentData;

  const status = getOperationsStatus({
    loadStore: () => store,
    env: {},
    now: () => new Date("2026-04-26T12:00:00.000Z"),
  });

  assert.equal(status.jobMetricsSnapshots.total, 3);
  assert.equal(status.jobMetricsSnapshots.lastCapturedAt, "2026-01-03T00:00:00.000Z");
});

test("jobMetricsSnapshots falls back to null when the only row has an unparseable capturedAt", () => {
  const store = {
    jobs: [],
    jobMetricSnapshots: [
      { id: "s1", capturedAt: "not-a-date", type: "agent.run" },
    ],
  } as unknown as PacketAgentData;

  const status = getOperationsStatus({
    loadStore: () => store,
    env: {},
    now: () => new Date("2026-04-26T12:00:00.000Z"),
  });

  assert.equal(status.jobMetricsSnapshots.total, 1);
  assert.equal(status.jobMetricsSnapshots.lastCapturedAt, null);
});

test("jobMetrics preserves the order returned by the fixture", () => {
  const fixture: JobTypeMetrics[] = [
    {
      type: "zeta.task",
      totalRuns: 1,
      succeededRuns: 1,
      failedRuns: 0,
      canceledRuns: 0,
      lastRunStartedAt: "2026-04-26T10:00:00.000Z",
      lastRunFinishedAt: "2026-04-26T10:00:05.000Z",
      lastDurationMs: 5000,
      averageDurationMs: 5000,
      p95DurationMs: null,
    },
    {
      type: "alpha.task",
      totalRuns: 2,
      succeededRuns: 0,
      failedRuns: 2,
      canceledRuns: 0,
      lastRunStartedAt: "2026-04-26T11:00:00.000Z",
      lastRunFinishedAt: "2026-04-26T11:00:10.000Z",
      lastDurationMs: 10000,
      averageDurationMs: null,
      p95DurationMs: null,
    },
  ];
  const status = getOperationsStatus({
    loadStore: () => emptyStore(),
    env: {},
    now: () => new Date("2026-04-26T12:00:00.000Z"),
    jobTypeMetrics: () => fixture,
  });

  assert.equal(status.jobMetrics.length, 2);
  assert.equal(status.jobMetrics[0].type, "zeta.task");
  assert.equal(status.jobMetrics[1].type, "alpha.task");
  assert.deepEqual(status.jobMetrics, fixture);
});
