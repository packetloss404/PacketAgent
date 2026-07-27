import assert from "node:assert/strict";
import test from "node:test";
import {
  asyncJobSchedulerStorage,
  enqueueJobAsync,
  findJob,
  sweepStaleRunningJobsAsync,
  type EnqueueJobInput,
  type JobSchedulerStorageSync,
} from "./store.js";
import { resetStoreForTests, type JobRecord, type JobStatus } from "../packetagent-store.js";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function makeJob(overrides: Partial<JobRecord> & { id: string }): JobRecord {
  return {
    id: overrides.id,
    workspaceId: overrides.workspaceId ?? "alpha",
    type: overrides.type ?? "async.boundary",
    payload: overrides.payload ?? {},
    status: overrides.status ?? "queued",
    attempts: overrides.attempts ?? 0,
    maxAttempts: overrides.maxAttempts ?? 3,
    scheduledAt: overrides.scheduledAt ?? "2026-04-26T09:00:00.000Z",
    ...(overrides.startedAt !== undefined ? { startedAt: overrides.startedAt } : {}),
    ...(overrides.completedAt !== undefined ? { completedAt: overrides.completedAt } : {}),
    ...(overrides.cron !== undefined ? { cron: overrides.cron } : {}),
    ...(overrides.result !== undefined ? { result: overrides.result } : {}),
    ...(overrides.error !== undefined ? { error: overrides.error } : {}),
    ...(overrides.cancelRequested !== undefined ? { cancelRequested: overrides.cancelRequested } : {}),
    createdAt: overrides.createdAt ?? "2026-04-26T09:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-26T09:00:00.000Z",
  };
}

test("asyncJobSchedulerStorage returns the underlying sync boundary results", async () => {
  const enqueued = makeJob({ id: "enqueued" });
  const claimed = makeJob({ id: "claimed", status: "running", attempts: 1, startedAt: "2026-04-26T10:00:00.000Z" });
  const syncStorage: JobSchedulerStorageSync = {
    enqueueJob(input: EnqueueJobInput) {
      return { ...enqueued, workspaceId: input.workspaceId, type: input.type };
    },
    maintainScheduledAgentJobs() {
      return [enqueued];
    },
    enqueueRecurringJob() {
      return enqueued;
    },
    listJobs(_workspaceId: string, _opts?: { status?: JobStatus; limit?: number }) {
      return [enqueued];
    },
    findJob() {
      return enqueued;
    },
    updateJob() {
      return claimed;
    },
    cancelJob() {
      return { ...claimed, status: "canceled" };
    },
    async claimNextJob() {
      return claimed;
    },
    sweepStaleRunningJobs() {
      return 1;
    },
  };
  const storage = asyncJobSchedulerStorage(syncStorage);

  assert.deepEqual(await storage.enqueueJob({ workspaceId: "alpha", type: "async.boundary" }), enqueued);
  assert.deepEqual(await storage.claimNextJob(new Date("2026-04-26T10:00:00.000Z")), claimed);
  assert.equal(await storage.sweepStaleRunningJobs(5 * 60 * 1000, new Date("2026-04-26T10:10:00.000Z")), 1);
});

test("default async job scheduler boundary enqueues, claims, and sweeps through the existing store", async () => {
  const previousStore = process.env.PACKETAGENT_STORE;
  try {
    delete process.env.PACKETAGENT_STORE;
    resetStoreForTests();
    const storage = asyncJobSchedulerStorage();

    const job = await enqueueJobAsync({
      workspaceId: "alpha",
      type: "async.boundary",
      scheduledAt: "2026-04-26T09:00:00.000Z",
    });
    assert.equal(findJob(job.id)?.id, job.id);

    const claimTime = new Date("2026-04-26T10:00:00.000Z");
    const claimed = await storage.claimNextJob(claimTime);
    assert.equal(claimed?.id, job.id);
    assert.equal(findJob(job.id)?.status, "running");
    assert.equal(findJob(job.id)?.startedAt, claimTime.toISOString());

    const swept = await sweepStaleRunningJobsAsync(5 * 60 * 1000, new Date("2026-04-26T10:10:00.000Z"));
    assert.equal(swept, 1);
    assert.equal(findJob(job.id)?.status, "queued");
    assert.equal(findJob(job.id)?.startedAt, undefined);
  } finally {
    restoreEnv("PACKETAGENT_STORE", previousStore);
    resetStoreForTests();
  }
});
