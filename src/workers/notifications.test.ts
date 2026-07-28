import assert from "node:assert/strict";
import test from "node:test";
import { createSeedStore, type PacketAgentData } from "../packetagent-store.js";
import {
  makeWorkerDefinition,
  makeWorkerDeployment,
  makeWorkerRun,
  makeWorkerVersion,
  makeWorkerVersionContent,
} from "./__tests__/fixtures.js";
import {
  WORKER_NOTIFICATION_DELIVERY_JOB_TYPE,
  WorkerNotificationDeliveryError,
  appendWorkerEventWithNotifications,
  createWorkerNotificationDeliveryJobHandler,
  createWorkerNotificationService,
  type WorkerNotificationTransport,
} from "./notifications.js";
import { createWorkerRetentionService } from "./observability/retention.js";
import {
  WORKER_RETENTION_POLICY_SCHEMA_VERSION,
  type WorkerRetentionPolicy,
} from "./observability/retention-types.js";
import { validateWorkerPersistence } from "./repository.js";

const START = new Date("2026-07-28T12:00:00.000Z");
const SECRET = "packetagent-test-secret-value";
const ACTOR = {
  type: "system" as const,
  id: "packetagent.worker-supervisor",
};
const RETENTION_POLICY: WorkerRetentionPolicy = {
  schemaVersion: WORKER_RETENTION_POLICY_SCHEMA_VERSION,
  metadataDays: 30,
  summaryDays: 1,
  promptDays: 3_650,
  toolPayloadDays: 3_650,
  artifactDays: 3_650,
};

test("source event, evidence, outbox envelope, and retry job are one durable unit", async () => {
  const harness = notificationHarness();
  const before = snapshotCounts(harness.data);
  await assert.rejects(
    () =>
      harness.transact((draft) => {
        appendProgressNotification(draft);
        throw new Error("injected transaction failure");
      }),
    /injected transaction failure/,
  );
  assert.deepEqual(snapshotCounts(harness.data), before);

  const result = await harness.transact((draft) => appendProgressNotification(draft));
  assert.equal(result.outboxItems.length, 1);
  assert.equal(result.jobs.length, 1);
  const outbox = result.outboxItems[0];
  const job = result.jobs[0];
  assert.ok(outbox);
  assert.ok(job);
  assert.equal(outbox.sourceEventId, result.event.id);
  assert.equal(outbox.sourceEventDigest, result.event.eventDigest);
  assert.equal(outbox.envelope.evidenceId, result.evidence.id);
  assert.equal(outbox.envelope.specversion, "1.0");
  assert.equal(outbox.envelope.type, "com.packetagent.worker.progress.v1");
  assert.equal(outbox.envelope.threadKey, "worker-run:run-1");
  assert.equal(job.type, WORKER_NOTIFICATION_DELIVERY_JOB_TYPE);
  assert.deepEqual(job.payload, { outboxItemId: outbox.id });
  assert.equal(JSON.stringify(job).includes("channel:operations"), false);
  assert.equal(JSON.stringify(harness.data).includes(SECRET), false);
  assert.doesNotThrow(() => validateWorkerPersistence(harness.data));
});

test("delivery retries with one idempotency key and records only redacted metadata", async () => {
  const harness = notificationHarness();
  const created = await harness.transact((draft) => appendProgressNotification(draft));
  const outbox = created.outboxItems[0]!;
  const seenKeys: string[] = [];
  let attempts = 0;
  const transport: WorkerNotificationTransport = {
    async deliver(input) {
      attempts += 1;
      seenKeys.push(input.idempotencyKey);
      if (attempts === 1) {
        throw new WorkerNotificationDeliveryError("provider unavailable", true);
      }
      return {
        deliveryReference: "provider-request-42",
        metadata: {
          provider: "fake-packetchat",
          responseCode: 202,
        },
      };
    },
  };
  const service = createWorkerNotificationService({
    mutateStore: harness.mutateStore,
    transport,
    now: harness.now,
  });

  const first = await service.deliver({
    workspaceId: "workspace-1",
    outboxItemId: outbox.id,
  });
  assert.equal(first.disposition, "retry");
  if (first.disposition !== "retry") return;
  assert.equal(first.outbox.status, "failed");
  assert.equal(first.outbox.attemptCount, 1);
  assert.equal(first.outbox.lastFailureCode, "provider_unavailable");

  harness.setNow(new Date(first.retryAt));
  const second = await service.deliver({
    workspaceId: "workspace-1",
    outboxItemId: outbox.id,
  });
  assert.equal(second.disposition, "delivered");
  assert.equal(second.outbox.status, "delivered");
  assert.equal(second.outbox.attemptCount, 2);
  assert.equal(second.outbox.deliveryReference, "provider-request-42");
  assert.deepEqual(second.outbox.deliveryMetadata, {
    provider: "fake-packetchat",
    responseCode: 202,
    latencyMs: 0,
  });
  assert.deepEqual(seenKeys, [outbox.idempotencyKey, outbox.idempotencyKey]);

  const replay = await service.deliver({
    workspaceId: "workspace-1",
    outboxItemId: outbox.id,
  });
  assert.equal(replay.disposition, "delivered");
  assert.equal(attempts, 2);
  assert.doesNotThrow(() => validateWorkerPersistence(harness.data));
});

test("retry exhaustion and expiry become durable terminal outbox states", async () => {
  const deadLetterHarness = notificationHarness();
  const created = await deadLetterHarness.transact((draft) =>
    appendProgressNotification(draft, { maxAttempts: 2 }),
  );
  const outbox = created.outboxItems[0]!;
  let calls = 0;
  const service = createWorkerNotificationService({
    mutateStore: deadLetterHarness.mutateStore,
    transport: {
      async deliver() {
        calls += 1;
        throw new WorkerNotificationDeliveryError("route unavailable", true);
      },
    },
    now: deadLetterHarness.now,
  });
  const first = await service.deliver({
    workspaceId: "workspace-1",
    outboxItemId: outbox.id,
  });
  assert.equal(first.disposition, "retry");
  if (first.disposition !== "retry") return;
  deadLetterHarness.setNow(new Date(first.retryAt));
  const second = await service.deliver({
    workspaceId: "workspace-1",
    outboxItemId: outbox.id,
  });
  assert.equal(second.disposition, "dead_letter");
  assert.equal(second.outbox.status, "dead_letter");
  assert.equal(second.outbox.attemptCount, 2);
  await service.deliver({
    workspaceId: "workspace-1",
    outboxItemId: outbox.id,
  });
  assert.equal(calls, 2);

  const expiryHarness = notificationHarness();
  const expiring = await expiryHarness.transact((draft) =>
    appendProgressNotification(draft, {
      expiresAt: "2026-07-28T12:01:00.000Z",
    }),
  );
  let expiryCalls = 0;
  const expiryService = createWorkerNotificationService({
    mutateStore: expiryHarness.mutateStore,
    transport: {
      async deliver() {
        expiryCalls += 1;
        return { deliveryReference: "must-not-send" };
      },
    },
    now: expiryHarness.now,
  });
  expiryHarness.setNow(new Date("2026-07-28T12:02:00.000Z"));
  const expired = await expiryService.deliver({
    workspaceId: "workspace-1",
    outboxItemId: expiring.outboxItems[0]!.id,
  });
  assert.equal(expired.disposition, "expired");
  assert.equal(expired.outbox.status, "expired");
  assert.equal(expired.outbox.attemptCount, 0);
  assert.equal(expiryCalls, 0);
});

test("the scheduler handler defers a transient failure without exposing route data", async () => {
  const harness = notificationHarness();
  const created = await harness.transact((draft) => appendProgressNotification(draft));
  let calls = 0;
  const service = createWorkerNotificationService({
    mutateStore: harness.mutateStore,
    transport: {
      async deliver() {
        calls += 1;
        if (calls === 1) {
          throw new WorkerNotificationDeliveryError("temporary failure", true);
        }
        return { deliveryReference: "provider-request-after-retry" };
      },
    },
    now: harness.now,
  });
  const handler = createWorkerNotificationDeliveryJobHandler(service);
  const job = created.jobs[0]!;
  await assert.rejects(
    () => handler.handle(job, { signal: new AbortController().signal }),
    /scheduled for bounded retry/,
  );
  const failed = harness.data.workerNotificationDeliveries.find(
    (record) => record.id === created.outboxItems[0]!.id,
  );
  assert.equal(failed?.status, "failed");
  assert.equal(JSON.stringify(job).includes("channel:operations"), false);
  if (!failed || failed.schemaVersion !== "packetagent.worker-notification-outbox/v1") {
    return;
  }
  harness.setNow(new Date(failed.scheduledAt));
  const delivered = (await handler.handle(job, {
    signal: new AbortController().signal,
  })) as { disposition: string };
  assert.equal(delivered.disposition, "delivered");
});

test("retention pins pending delivery evidence and tombstones delivered sources", async () => {
  const pendingHarness = notificationHarness();
  const pending = await pendingHarness.transact((draft) => appendProgressNotification(draft));
  const pendingRetention = createWorkerRetentionService({
    mutateStore: pendingHarness.mutateStore,
    now: () => new Date("2026-08-02T12:00:00.000Z"),
    id: () => "retention-pending",
  });
  await pendingRetention.cleanup({
    workspaceId: "workspace-1",
    policy: RETENTION_POLICY,
    maxItems: 100,
    maxDurationMs: 5_000,
  });
  assert.ok(pendingHarness.data.workerEvents.some((event) => event.id === pending.event.id));
  assert.ok(
    pendingHarness.data.workerEvidenceEntries.some(
      (evidence) => evidence.id === pending.evidence.id,
    ),
  );

  const deliveredHarness = notificationHarness();
  const delivered = await deliveredHarness.transact((draft) => appendProgressNotification(draft));
  const deliveryService = createWorkerNotificationService({
    mutateStore: deliveredHarness.mutateStore,
    transport: {
      async deliver() {
        return {
          deliveryReference: "provider-request-retained",
          metadata: { provider: "fake-packetchat", responseCode: 202 },
        };
      },
    },
    now: deliveredHarness.now,
  });
  await deliveryService.deliver({
    workspaceId: "workspace-1",
    outboxItemId: delivered.outboxItems[0]!.id,
  });
  const deliveredRetention = createWorkerRetentionService({
    mutateStore: deliveredHarness.mutateStore,
    now: () => new Date("2026-08-02T12:00:00.000Z"),
    id: () => "retention-delivered",
  });
  await deliveredRetention.cleanup({
    workspaceId: "workspace-1",
    policy: RETENTION_POLICY,
    maxItems: 100,
    maxDurationMs: 5_000,
  });
  assert.equal(
    deliveredHarness.data.workerEvents.some((event) => event.id === delivered.event.id),
    false,
  );
  assert.equal(
    deliveredHarness.data.workerEvidenceEntries.some(
      (evidence) => evidence.id === delivered.evidence.id,
    ),
    false,
  );
  assert.ok(
    deliveredHarness.data.workerEvents.some(
      (event) =>
        event.type === "worker.retention.summary_deleted" &&
        event.data?.contentDigest === delivered.event.eventDigest,
    ),
  );
  assert.doesNotThrow(() => validateWorkerPersistence(deliveredHarness.data));
});

function appendProgressNotification(
  data: PacketAgentData,
  overrides: {
    readonly maxAttempts?: number;
    readonly expiresAt?: string;
  } = {},
) {
  let nextId = data.workerNotificationDeliveries.length + data.jobs.length;
  return appendWorkerEventWithNotifications(data, {
    journal: {
      id: `event-progress-${data.workerEvents.length + 1}`,
      workspaceId: "workspace-1",
      type: "worker.checkpoint.persisted",
      source: "checkpoint",
      workerDefinitionId: "worker-1",
      workerVersionId: "worker-version-1",
      workerDeploymentId: "deployment-1",
      workerRunId: "run-1",
      actor: ACTOR,
      summary: `Worker progress omitted ${SECRET}.`,
      data: {
        checkpointId: "checkpoint-1",
        apiToken: SECRET,
      },
      knownSecretValues: [SECRET],
      occurredAt: START.toISOString(),
    },
    notification: {
      event: "progress",
      title: `Progress contains ${SECRET}`,
      data: {
        requiredAction: "none",
      },
      ...overrides,
    },
    id: (kind) => `${kind}-notification-${++nextId}`,
  });
}

function notificationHarness() {
  let data = createSeedStore();
  const content = makeWorkerVersionContent({
    notificationRoutes: [
      {
        id: "operations-chat",
        kind: "packetchat",
        reference: "channel:operations",
        events: ["progress", "terminal"],
      },
    ],
  });
  data.workerDefinitions.push(
    makeWorkerDefinition({
      status: "active",
      currentVersionId: "worker-version-1",
    }),
  );
  data.workerVersions.push(
    makeWorkerVersion({
      status: "validated",
      content,
    }),
  );
  data.workerDeployments.push(
    makeWorkerDeployment({
      status: "active",
    }),
  );
  data.workerRuns.push(makeWorkerRun({ status: "running" }));
  let currentTime = START;
  const mutateStore = async <T>(
    mutation: (draft: PacketAgentData) => T | Promise<T>,
  ): Promise<T> => {
    const draft = structuredClone(data);
    const result = await mutation(draft);
    data = draft;
    return result;
  };
  return {
    get data() {
      return data;
    },
    mutateStore,
    transact: mutateStore,
    now: () => currentTime,
    setNow(value: Date) {
      currentTime = value;
    },
  };
}

function snapshotCounts(data: PacketAgentData) {
  return {
    events: data.workerEvents.length,
    evidence: data.workerEvidenceEntries.length,
    outbox: data.workerNotificationDeliveries.length,
    jobs: data.jobs.length,
  };
}
