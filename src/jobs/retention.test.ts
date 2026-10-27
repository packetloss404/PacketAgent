import assert from "node:assert/strict";
import test from "node:test";

import { createSeedStore, type JobRecord } from "../packetagent-store.js";
import {
  DEFAULT_JOB_RETENTION_DAYS,
  parseJobRetentionDays,
  pruneTerminalJobs,
} from "./retention.js";

const NOW = new Date("2026-10-27T12:00:00.000Z");

function makeJob(overrides: Partial<JobRecord>): JobRecord {
  return {
    id: "job-1",
    workspaceId: "alpha",
    type: "test.job",
    payload: {},
    status: "success",
    attempts: 1,
    maxAttempts: 3,
    scheduledAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("parseJobRetentionDays defaults, accepts non-negative integers, and rejects junk", () => {
  assert.equal(parseJobRetentionDays(undefined), DEFAULT_JOB_RETENTION_DAYS);
  assert.equal(parseJobRetentionDays(""), DEFAULT_JOB_RETENTION_DAYS);
  assert.equal(parseJobRetentionDays("14"), 14);
  assert.equal(parseJobRetentionDays("0"), 0);
  assert.equal(parseJobRetentionDays("-1"), DEFAULT_JOB_RETENTION_DAYS);
  assert.equal(parseJobRetentionDays("nope"), DEFAULT_JOB_RETENTION_DAYS);
});

test("pruneTerminalJobs drops only old terminal jobs and keeps active work", () => {
  const data = createSeedStore();
  data.jobs = [
    makeJob({ id: "old-success", status: "success", updatedAt: "2026-10-01T00:00:00.000Z" }),
    makeJob({ id: "old-failed", status: "failed", updatedAt: "2026-10-01T00:00:00.000Z" }),
    makeJob({ id: "old-canceled", status: "canceled", updatedAt: "2026-10-01T00:00:00.000Z" }),
    makeJob({ id: "recent-success", status: "success", updatedAt: "2026-10-27T00:00:00.000Z" }),
    makeJob({ id: "old-queued", status: "queued", updatedAt: "2026-01-01T00:00:00.000Z" }),
    makeJob({ id: "old-running", status: "running", updatedAt: "2026-01-01T00:00:00.000Z" }),
  ];

  const removed = pruneTerminalJobs(data, { retentionDays: 7, now: NOW });

  assert.equal(removed, 3);
  assert.deepEqual(data.jobs.map((job) => job.id).sort(), [
    "old-queued",
    "old-running",
    "recent-success",
  ]);
});

test("pruneTerminalJobs honours the per-pass cap and never exceeds it", () => {
  const data = createSeedStore();
  data.jobs = Array.from({ length: 10 }, (_unused, index) =>
    makeJob({
      id: `old-${String(index).padStart(2, "0")}`,
      status: "success",
      updatedAt: `2026-10-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    }),
  );

  const removed = pruneTerminalJobs(data, { retentionDays: 7, maxPerPass: 4, now: NOW });

  assert.equal(removed, 4);
  assert.equal(data.jobs.length, 6);
  // The four oldest are removed first.
  assert.deepEqual(
    data.jobs.map((job) => job.id),
    ["old-04", "old-05", "old-06", "old-07", "old-08", "old-09"],
  );
});

test("pruneTerminalJobs is a no-op when nothing is old enough", () => {
  const data = createSeedStore();
  data.jobs = [makeJob({ id: "recent", status: "failed", updatedAt: "2026-10-27T00:00:00.000Z" })];

  assert.equal(pruneTerminalJobs(data, { retentionDays: 7, now: NOW }), 0);
  assert.equal(data.jobs.length, 1);
});
