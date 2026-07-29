import assert from "node:assert/strict";
import test from "node:test";
import { getOperationsHealth, type OperationsHealthDeps } from "./operations-health.js";
import type { SchedulerHeartbeat } from "./jobs/scheduler-heartbeat.js";

function fixedNow(iso: string): () => Date {
  const date = new Date(iso);
  return () => date;
}

function heartbeat(overrides: Partial<SchedulerHeartbeat> = {}): SchedulerHeartbeat {
  return {
    schedulerStartedAt: "2026-04-26T09:59:00.000Z",
    lastTickStartedAt: "2026-04-26T10:00:00.000Z",
    lastTickEndedAt: "2026-04-26T10:00:00.500Z",
    lastTickDurationMs: 500,
    ticksSinceStart: 7,
    ...overrides,
  };
}

function baseDeps(overrides: Partial<OperationsHealthDeps> = {}): OperationsHealthDeps {
  return {
    loadStore: () => ({ ok: true }),
    schedulerHeartbeat: () => heartbeat(),
    env: { PACKETAGENT_ACCESS_LOG_MODE: "off" },
    now: fixedNow("2026-04-26T10:00:01.000Z"),
    fileExists: () => true,
    schedulerStaleAfterMs: 60_000,
    ...overrides,
  };
}

function findSubsystem(report: ReturnType<typeof getOperationsHealth>, name: string) {
  const subsystem = report.subsystems.find((entry) => entry.name === name);
  assert.ok(subsystem, `expected subsystem ${name} to be present`);
  return subsystem;
}

test("default healthy deps yield overall ok with disabled accessLog", () => {
  const report = getOperationsHealth(baseDeps());
  assert.equal(report.overall, "ok");
  assert.equal(findSubsystem(report, "store").status, "ok");
  assert.equal(findSubsystem(report, "scheduler").status, "ok");
  assert.equal(findSubsystem(report, "accessLog").status, "disabled");
  assert.match(findSubsystem(report, "scheduler").detail, /ticksSinceStart=7/);
  assert.equal(report.generatedAt, "2026-04-26T10:00:01.000Z");
});

test("store throws -> store down and overall down", () => {
  const report = getOperationsHealth(
    baseDeps({
      loadStore: () => {
        throw new Error("disk on fire");
      },
    }),
  );
  const store = findSubsystem(report, "store");
  assert.equal(store.status, "down");
  assert.match(store.detail, /store load failed: disk on fire/);
  assert.equal(report.overall, "down");
});

test("store returns null -> store down", () => {
  const report = getOperationsHealth(baseDeps({ loadStore: () => null }));
  const store = findSubsystem(report, "store");
  assert.equal(store.status, "down");
  assert.equal(store.detail, "store returned an unexpected shape");
  assert.equal(report.overall, "down");
});

test("scheduler with schedulerStartedAt null -> down", () => {
  const report = getOperationsHealth(
    baseDeps({
      schedulerHeartbeat: () =>
        heartbeat({ schedulerStartedAt: null, lastTickEndedAt: null, lastTickStartedAt: null }),
    }),
  );
  const scheduler = findSubsystem(report, "scheduler");
  assert.equal(scheduler.status, "down");
  assert.equal(scheduler.detail, "scheduler has not been started in this process");
  assert.equal(report.overall, "down");
});

test("scheduler with no completed tick -> degraded", () => {
  const report = getOperationsHealth(
    baseDeps({
      schedulerHeartbeat: () =>
        heartbeat({ lastTickEndedAt: null, lastTickStartedAt: "2026-04-26T10:00:00.000Z" }),
    }),
  );
  const scheduler = findSubsystem(report, "scheduler");
  assert.equal(scheduler.status, "degraded");
  assert.equal(scheduler.detail, "scheduler has started but no tick has completed yet");
  assert.equal(report.overall, "degraded");
});

test("scheduler with stale lastTickEndedAt -> degraded with rounded seconds", () => {
  const report = getOperationsHealth(
    baseDeps({
      schedulerHeartbeat: () => heartbeat({ lastTickEndedAt: "2026-04-26T09:58:00.000Z" }),
      now: fixedNow("2026-04-26T10:00:00.400Z"),
    }),
  );
  const scheduler = findSubsystem(report, "scheduler");
  assert.equal(scheduler.status, "degraded");
  assert.equal(scheduler.detail, "last tick was 120s ago");
  assert.equal(scheduler.observedAt, "2026-04-26T09:58:00.000Z");
  assert.equal(report.overall, "degraded");
});

test("scheduler with recent tick -> ok with ticksSinceStart in detail", () => {
  const report = getOperationsHealth(
    baseDeps({
      schedulerHeartbeat: () =>
        heartbeat({ lastTickEndedAt: "2026-04-26T10:00:00.000Z", ticksSinceStart: 42 }),
      now: fixedNow("2026-04-26T10:00:00.250Z"),
    }),
  );
  const scheduler = findSubsystem(report, "scheduler");
  assert.equal(scheduler.status, "ok");
  assert.equal(scheduler.detail, "last tick 250ms ago, ticksSinceStart=42");
  assert.equal(scheduler.observedAt, "2026-04-26T10:00:00.000Z");
});

test("access log mode stdout -> ok", () => {
  const report = getOperationsHealth(baseDeps({ env: { PACKETAGENT_ACCESS_LOG_MODE: "stdout" } }));
  const accessLog = findSubsystem(report, "accessLog");
  assert.equal(accessLog.status, "ok");
  assert.equal(accessLog.detail, "writing to stdout");
  assert.equal(report.overall, "ok");
});

test("access log mode file without path -> down", () => {
  const report = getOperationsHealth(baseDeps({ env: { PACKETAGENT_ACCESS_LOG_MODE: "file" } }));
  const accessLog = findSubsystem(report, "accessLog");
  assert.equal(accessLog.status, "down");
  assert.equal(accessLog.detail, "file mode requires PACKETAGENT_ACCESS_LOG_PATH");
  assert.equal(report.overall, "down");
});

test("access log mode file with missing parent dir -> down", () => {
  const report = getOperationsHealth(
    baseDeps({
      env: {
        PACKETAGENT_ACCESS_LOG_MODE: "file",
        PACKETAGENT_ACCESS_LOG_PATH: "var/logs/access.log",
      },
      fileExists: () => false,
    }),
  );
  const accessLog = findSubsystem(report, "accessLog");
  assert.equal(accessLog.status, "down");
  assert.match(accessLog.detail, /^access log directory does not exist: /);
  assert.equal(report.overall, "down");
});

test("access log mode file with parent dir present but file absent -> degraded", () => {
  const report = getOperationsHealth(
    baseDeps({
      env: {
        PACKETAGENT_ACCESS_LOG_MODE: "file",
        PACKETAGENT_ACCESS_LOG_PATH: "var/logs/access.log",
      },
      fileExists: (path) => !path.endsWith("access.log"),
    }),
  );
  const accessLog = findSubsystem(report, "accessLog");
  assert.equal(accessLog.status, "degraded");
  assert.match(accessLog.detail, /^access log file does not exist yet: /);
  assert.equal(report.overall, "degraded");
});

test("access log mode file with file present -> ok", () => {
  const report = getOperationsHealth(
    baseDeps({
      env: {
        PACKETAGENT_ACCESS_LOG_MODE: "file",
        PACKETAGENT_ACCESS_LOG_PATH: "var/logs/access.log",
      },
      fileExists: () => true,
    }),
  );
  const accessLog = findSubsystem(report, "accessLog");
  assert.equal(accessLog.status, "ok");
  assert.match(accessLog.detail, /^file present at /);
  assert.equal(report.overall, "ok");
});

test("overall is down whenever any subsystem is down", () => {
  const report = getOperationsHealth(
    baseDeps({
      loadStore: () => null,
      schedulerHeartbeat: () => heartbeat({ lastTickEndedAt: null, lastTickStartedAt: null }),
    }),
  );
  assert.equal(report.overall, "down");
});

test("overall is degraded when only degraded subsystems exist", () => {
  const report = getOperationsHealth(
    baseDeps({
      schedulerHeartbeat: () => heartbeat({ lastTickEndedAt: null, lastTickStartedAt: null }),
    }),
  );
  assert.equal(report.overall, "degraded");
});

test("disabled access log does not poison overall", () => {
  const report = getOperationsHealth(baseDeps({ env: { PACKETAGENT_ACCESS_LOG_MODE: "off" } }));
  assert.equal(findSubsystem(report, "accessLog").status, "disabled");
  assert.equal(report.overall, "ok");
});
