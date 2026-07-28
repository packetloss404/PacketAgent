import assert from "node:assert/strict";
import test from "node:test";
import { createSeedStore, type JobRecord, type PacketAgentData } from "../packetagent-store.js";
import type { EnqueueJobInput } from "./store.js";
import {
  createWorkerRetentionJobHandler,
  ensureWorkerRetentionJobs,
  WORKER_RETENTION_JOB_TYPE,
} from "./worker-retention-handler.js";
import {
  DEFAULT_WORKER_RETENTION_POLICY,
  type WorkerRetentionCleanupInput,
  type WorkerRetentionCleanupResult,
} from "../workers/observability/retention-types.js";

test("Worker retention job requires an explicit matching tenant and bounded payload", async () => {
  const calls: WorkerRetentionCleanupInput[] = [];
  const handler = createWorkerRetentionJobHandler({
    async cleanup(input) {
      calls.push(input);
      return resultFor(input);
    },
  });
  const job = retentionJob();

  const result = await handler.handle(job);
  assert.equal(result.workspaceId, "alpha");
  assert.equal(calls.length, 1);

  await assert.rejects(
    handler.handle({
      ...job,
      workspaceId: "beta",
    }),
    /must match the scheduler tenant/,
  );
  await assert.rejects(
    handler.handle({
      ...job,
      payload: { ...job.payload, maxItems: 501 },
    }),
    /maxItems/,
  );
  await assert.rejects(
    handler.handle({
      ...job,
      payload: { ...job.payload, unexpected: true },
    }),
    /unsupported fields/,
  );
});

test("retention cron bootstrap creates one explicitly scoped bounded job per workspace", async () => {
  const data = workspacesData();
  data.jobs.push(
    retentionJob({
      id: "existing-alpha",
      cron: "0 3 * * *",
      status: "queued",
    }),
  );
  const enqueued: EnqueueJobInput[] = [];

  const result = await ensureWorkerRetentionJobs({
    env: {
      PACKETAGENT_WORKER_RETENTION_CRON: "0 3 * * *",
      PACKETAGENT_WORKER_RETENTION_PROMPT_DAYS: "7",
      PACKETAGENT_WORKER_RETENTION_MAX_ITEMS: "25",
      PACKETAGENT_WORKER_RETENTION_MAX_DURATION_MS: "2500",
      PACKETAGENT_WORKER_RETENTION_DRY_RUN: "true",
    },
    loadStore: () => data,
    enqueue: (input) => {
      enqueued.push(input);
      return retentionJob({
        id: `job-${enqueued.length}`,
        workspaceId: input.workspaceId,
        payload: input.payload,
        cron: input.cron,
        scheduledAt: input.scheduledAt,
      });
    },
  });

  assert.deepEqual(result, { action: "ensured", existing: 1, enqueued: 1 });
  assert.equal(enqueued[0].workspaceId, "beta");
  assert.equal(enqueued[0].type, WORKER_RETENTION_JOB_TYPE);
  assert.equal(enqueued[0].payload?.workspaceId, "beta");
  assert.equal((enqueued[0].payload?.policy as { promptDays: number }).promptDays, 7);
  assert.equal(enqueued[0].payload?.maxItems, 25);
  assert.equal(enqueued[0].payload?.maxDurationMs, 2500);
  assert.equal(enqueued[0].payload?.dryRun, true);
});

function retentionJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "retention-job-1",
    workspaceId: "alpha",
    type: WORKER_RETENTION_JOB_TYPE,
    payload: {
      workspaceId: "alpha",
      policy: DEFAULT_WORKER_RETENTION_POLICY,
      dryRun: false,
      maxItems: 100,
      maxDurationMs: 5_000,
    },
    status: "queued",
    attempts: 0,
    maxAttempts: 3,
    scheduledAt: "2026-07-27T12:00:00.000Z",
    createdAt: "2026-07-27T12:00:00.000Z",
    updatedAt: "2026-07-27T12:00:00.000Z",
    ...overrides,
  };
}

function workspacesData(): PacketAgentData {
  const data = createSeedStore();
  const template = data.workspaces[0];
  assert.ok(template);
  data.workspaces = [
    { ...template, id: "alpha", slug: "alpha" },
    { ...template, id: "beta", slug: "beta" },
  ];
  data.jobs = [];
  return data;
}

function resultFor(input: WorkerRetentionCleanupInput): WorkerRetentionCleanupResult {
  const metric = { scanned: 0, eligible: 0, deleted: 0, skipped: 0, failed: 0 };
  return {
    workspaceId: input.workspaceId,
    policy: input.policy,
    dryRun: input.dryRun ?? false,
    maxItems: input.maxItems ?? 100,
    maxDurationMs: input.maxDurationMs ?? 5_000,
    processed: 0,
    deleted: 0,
    hasMore: false,
    startedAt: "2026-07-27T12:00:00.000Z",
    completedAt: "2026-07-27T12:00:00.000Z",
    elapsedMs: 0,
    categories: {
      metadata: metric,
      summary: metric,
      prompt: metric,
      tool_payload: metric,
      artifact: metric,
    },
  };
}
