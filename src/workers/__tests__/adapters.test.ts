import assert from "node:assert/strict";
import test from "node:test";
import { createSeedStore, type JobRecord, type PacketAgentData } from "../../packetagent-store.js";
import { createWorkerActivationService } from "../activation.js";
import type { AdmitWorkerActivationInput, WorkerActivationService } from "../activation.js";
import { createWorkerActivationRepository } from "../activation-repository.js";
import {
  WORKER_CRON_ACTIVATION_JOB_TYPE,
  activateWorkerAlertEvents,
  activateWorkerQueueDelivery,
  activateWorkerWebhookDelivery,
  ensureWorkerCronProjectionJob,
  handleWorkerCronActivationJob,
  projectWorkerCronTriggers,
} from "../adapters.js";
import {
  makeWorkerDefinition,
  makeWorkerDeployment,
  makeWorkerVersion,
  makeWorkerVersionContent,
  TEST_NOW,
} from "./fixtures.js";

test("webhook, queue, cron, and alert adapters preserve upstream delivery identity", async () => {
  const data = activeAdapterData();
  const calls: AdmitWorkerActivationInput[] = [];
  const service = capturingService(calls);

  await activateWorkerWebhookDelivery(
    {
      webhookRef: "hook:opaque-1",
      deliveryId: "webhook-delivery-1",
      occurredAt: TEST_NOW,
      payload: { value: "webhook" },
    },
    { service, loadStore: async () => data },
  );
  await activateWorkerQueueDelivery(
    {
      workspaceId: "alpha",
      workerDeploymentId: "deployment-1",
      triggerId: "queue",
      queueRef: "queue:test",
      upstreamMessageId: "queue-message-1",
      occurredAt: TEST_NOW,
      payload: { value: "queue" },
    },
    { service, loadStore: async () => data },
  );
  await handleWorkerCronActivationJob(
    makeJob({
      id: "cron-occurrence-1",
      type: WORKER_CRON_ACTIVATION_JOB_TYPE,
      scheduledAt: TEST_NOW,
      payload: {
        workerDeploymentId: "deployment-1",
        workerVersionId: "worker-version-1",
        triggerId: "cron",
        timezone: "America/Chicago",
      },
    }),
    { service },
  );
  const alertCount = await activateWorkerAlertEvents(
    [
      {
        id: "alert-occurrence-1",
        ruleId: "subsystem-down",
        severity: "critical",
        title: "Database down",
        detail: "The database health probe failed.",
        observedAt: TEST_NOW,
        context: { subsystem: "database" },
      },
    ],
    { service, loadStore: async () => data },
  );

  assert.equal(alertCount, 1);
  assert.deepEqual(
    calls.map((call) => [call.source, call.deliveryId, call.triggerId]),
    [
      ["webhook", "webhook-delivery-1", "webhook"],
      ["queue", "queue-message-1", "queue"],
      ["cron", "cron-occurrence-1", "cron"],
      ["alert", "alert-occurrence-1", "alert"],
    ],
  );
});

test("cron projection creates one timezone-aware durable occurrence and cancels it when paused", async () => {
  let data = activeAdapterData();
  let nextId = 0;
  const dependencies = {
    now: () => new Date(TEST_NOW),
    id: () => `cron-job-${++nextId}`,
    mutateStore: async <T>(mutator: (store: PacketAgentData) => T | Promise<T>): Promise<T> => {
      const result = await mutator(data);
      return result;
    },
  };

  const first = await projectWorkerCronTriggers(dependencies);
  const second = await projectWorkerCronTriggers(dependencies);
  const occurrence = data.jobs.find((job) => job.type === WORKER_CRON_ACTIVATION_JOB_TYPE);

  assert.deepEqual(first, { desired: 1, enqueued: 1, canceled: 0 });
  assert.deepEqual(second, { desired: 1, enqueued: 0, canceled: 0 });
  assert.equal(occurrence?.scheduledAt, "2026-07-27T14:00:00.000Z");
  assert.equal(occurrence?.cron, "0 9 * * *");
  assert.equal(occurrence?.payload.timezone, "America/Chicago");

  data.workerDeployments[0] = {
    ...data.workerDeployments[0],
    status: "paused",
    pausedAt: TEST_NOW,
  };
  const paused = await projectWorkerCronTriggers(dependencies);
  assert.deepEqual(paused, { desired: 0, enqueued: 0, canceled: 1 });
  assert.equal(occurrence?.status, "canceled");

  data = activeAdapterData();
  const projection1 = await ensureWorkerCronProjectionJob(dependencies);
  const projection2 = await ensureWorkerCronProjectionJob(dependencies);
  assert.equal(projection2.id, projection1.id);
});

test("every source adapter replays through the common inbox without creating another run", async () => {
  const data = activeAdapterData();
  const repository = createWorkerActivationRepository({
    loadStore: () => data,
    mutateStore: async (mutator) => await mutator(data),
  });
  let nextId = 0;
  const service = createWorkerActivationService({
    repository,
    now: () => new Date(TEST_NOW),
    id: (kind) => `${kind}-adapter-replay-${++nextId}`,
  });
  const dependencies = { service, loadStore: async () => data };
  const webhook = () =>
    activateWorkerWebhookDelivery(
      {
        webhookRef: "hook:opaque-1",
        deliveryId: "webhook-replay",
        payload: { value: "webhook" },
      },
      dependencies,
    );
  const queue = () =>
    activateWorkerQueueDelivery(
      {
        workspaceId: "alpha",
        workerDeploymentId: "deployment-1",
        triggerId: "queue",
        queueRef: "queue:test",
        upstreamMessageId: "queue-replay",
        payload: { value: "queue" },
      },
      dependencies,
    );
  const cronJob = makeJob({
    id: "cron-replay",
    type: WORKER_CRON_ACTIVATION_JOB_TYPE,
    payload: {
      workerDeploymentId: "deployment-1",
      workerVersionId: "worker-version-1",
      triggerId: "cron",
      timezone: "America/Chicago",
    },
  });
  const cron = () => handleWorkerCronActivationJob(cronJob, dependencies);
  const alertEvent = {
    id: "alert-replay",
    ruleId: "subsystem-down",
    severity: "critical" as const,
    title: "Database down",
    detail: "The database health probe failed.",
    observedAt: TEST_NOW,
    context: { subsystem: "database" },
  };
  const alert = () => activateWorkerAlertEvents([alertEvent], dependencies);

  for (const deliver of [webhook, queue, cron, alert]) {
    await deliver();
    await deliver();
  }

  assert.equal(data.workerActivationInboxes.length, 4);
  assert.equal(data.workerRuns.length, 4);
  assert.deepEqual(
    data.workerActivationInboxes
      .map((record) => `${record.source}:${record.duplicateCount}`)
      .sort(),
    ["alert:1", "cron:1", "queue:1", "webhook:1"],
  );
});

function activeAdapterData(): PacketAgentData {
  const data = createSeedStore();
  const content = makeWorkerVersionContent({
    inputSchema: {
      fields: [],
      additionalProperties: true,
    },
    triggers: [
      {
        id: "webhook",
        kind: "webhook",
        enabled: true,
        adapter: "http",
        eventType: "test",
        webhookRef: "hook:opaque-1",
      },
      {
        id: "queue",
        kind: "queue",
        enabled: true,
        queueRef: "queue:test",
        eventType: "test",
      },
      {
        id: "cron",
        kind: "cron",
        enabled: true,
        expression: "0 9 * * *",
        timezone: "America/Chicago",
      },
      {
        id: "alert",
        kind: "alert",
        enabled: true,
        alertRuleId: "subsystem-down",
      },
    ],
  });
  data.workerDefinitions.push(
    makeWorkerDefinition({
      workspaceId: "alpha",
      status: "active",
      currentVersionId: "worker-version-1",
    }),
  );
  data.workerVersions.push(
    makeWorkerVersion({
      workspaceId: "alpha",
      status: "validated",
      content,
    }),
  );
  data.workerDeployments.push(makeWorkerDeployment({ workspaceId: "alpha", status: "active" }));
  return data;
}

function capturingService(calls: AdmitWorkerActivationInput[]): WorkerActivationService {
  return {
    async admit(input) {
      calls.push(input);
      return undefined as never;
    },
    async listInboxes() {
      return [];
    },
    async resolvePayload() {
      return {};
    },
    async pruneExpiredPayloads() {
      return 0;
    },
  };
}

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    workspaceId: "alpha",
    type: "test",
    payload: {},
    status: "running",
    attempts: 1,
    maxAttempts: 3,
    scheduledAt: TEST_NOW,
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...overrides,
  };
}
