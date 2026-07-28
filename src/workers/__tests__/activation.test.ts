import assert from "node:assert/strict";
import test from "node:test";
import { createSeedStore, type PacketAgentData } from "../../packetagent-store.js";
import {
  createWorkerActivationService,
  validateWorkerInput,
  workerTraceFromTraceparent,
  type WorkerActivationCommitPhase,
} from "../activation.js";
import { createWorkerActivationRepository } from "../activation-repository.js";
import { WorkerLifecycleError } from "../errors.js";
import {
  makeWorkerDefinition,
  makeWorkerDeployment,
  makeWorkerVersion,
  makeWorkerVersionContent,
  TEST_NOW,
} from "./fixtures.js";

const ACTOR = { type: "user", id: "user-alpha" } as const;
const TRACE = {
  traceId: "0123456789abcdef0123456789abcdef",
  spanId: "0123456789abcdef",
} as const;

test("activation admission atomically creates one inbox, queued run, event, and job", async () => {
  const harness = makeHarness();
  const result = await harness.service.admit(admission());

  assert.equal(result.disposition, "accepted");
  assert.equal(harness.data.workerActivationInboxes.length, 1);
  assert.equal(harness.data.workerRuns.length, 1);
  assert.equal(harness.data.jobs.filter((job) => job.type === "worker.run").length, 1);
  assert.equal(
    harness.data.workerEvents.filter((event) => event.type === "worker.activation.accepted").length,
    1,
  );
  assert.equal(result.inbox.workerRunId, result.runId);
  assert.equal(result.inbox.executionJobId, result.executionJobId);
  assert.equal(result.inbox.envelope.workerVersionId, "worker-version-1");
  assert.deepEqual(result.inbox.envelope.payload, { release_id: "release-42" });
  assert.equal(result.inbox.envelope.payloadRetention.mode, "inline");
  assert.equal(harness.data.workerRuns[0].status, "queued");
  assert.equal(harness.data.jobs.at(-1)?.payload.workerRunId, result.runId);
});

test("exact delivery replay returns the first run while a changed payload conflicts", async () => {
  const harness = makeHarness();
  const first = await harness.service.admit(admission());
  const duplicate = await harness.service.admit(admission());

  assert.equal(duplicate.disposition, "duplicate");
  assert.equal(duplicate.runId, first.runId);
  assert.equal(duplicate.executionJobId, first.executionJobId);
  assert.equal(duplicate.inbox.duplicateCount, 1);
  assert.equal(harness.data.workerRuns.length, 1);
  assert.equal(harness.data.workerActivationInboxes.length, 1);

  await assert.rejects(
    harness.service.admit(admission({ payload: { release_id: "changed" } })),
    (error: unknown) =>
      error instanceof WorkerLifecycleError && error.code === "idempotency_mismatch",
  );
  assert.equal(harness.data.workerRuns.length, 1);
});

test("distinct delivery IDs create distinct occurrences", async () => {
  const harness = makeHarness();
  const first = await harness.service.admit(admission({ deliveryId: "delivery-1" }));
  const second = await harness.service.admit(admission({ deliveryId: "delivery-2" }));

  assert.notEqual(first.runId, second.runId);
  assert.equal(harness.data.workerRuns.length, 2);
  assert.equal(harness.data.workerActivationInboxes.length, 2);
});

test("activation admission and inbox reads remain workspace scoped", async () => {
  const harness = makeHarness();
  await assert.rejects(
    harness.service.admit(admission({ workspaceId: "beta" })),
    (error: unknown) => error instanceof WorkerLifecycleError && error.code === "not_found",
  );
  assertNoActivationWrites(harness.data);

  await harness.service.admit(admission());
  assert.equal((await harness.service.listInboxes("alpha")).length, 1);
  assert.equal((await harness.service.listInboxes("beta")).length, 0);
});

test("input schema validation happens before any activation record is committed", async () => {
  const harness = makeHarness();
  await assert.rejects(
    harness.service.admit(admission({ payload: {} })),
    (error: unknown) => error instanceof WorkerLifecycleError && error.code === "invalid_input",
  );
  assertNoActivationWrites(harness.data);

  assert.deepEqual(
    validateWorkerInput(
      {
        fields: [
          {
            key: "mode",
            label: "Mode",
            type: "enum",
            required: false,
            options: ["safe", "fast"],
            defaultValue: "safe",
          },
        ],
        additionalProperties: false,
      },
      {},
    ),
    { mode: "safe" },
  );
});

test("inactive deployments, disabled triggers, and source mismatches are rejected", async () => {
  const inactive = makeHarness({ deploymentStatus: "paused" });
  await assert.rejects(
    inactive.service.admit(admission()),
    (error: unknown) =>
      error instanceof WorkerLifecycleError && error.code === "invalid_transition",
  );

  const disabled = makeHarness({ manualEnabled: false });
  await assert.rejects(
    disabled.service.admit(admission()),
    (error: unknown) =>
      error instanceof WorkerLifecycleError && error.code === "invalid_transition",
  );

  const mismatch = makeHarness();
  await assert.rejects(
    mismatch.service.admit(admission({ source: "queue" })),
    (error: unknown) => error instanceof WorkerLifecycleError && error.code === "invalid_input",
  );
});

test("sensitive and large payloads are encrypted behind expiring references", async () => {
  const harness = makeHarness({
    additionalProperties: true,
    maxInlinePayloadBytes: 32,
  });
  const secret = "raw-secret-that-must-not-appear";
  const result = await harness.service.admit(
    admission({
      payload: {
        release_id: "release-42",
        api_key: secret,
        details: "x".repeat(80),
      },
    }),
  );

  assert.equal(result.inbox.envelope.payload, undefined);
  assert.equal(result.inbox.envelope.payloadReference?.classification, "large_and_sensitive");
  assert.equal(result.inbox.envelope.payloadRetention.mode, "encrypted_reference");
  assert.equal(harness.data.workerActivationPayloads.length, 1);
  assert.equal(JSON.stringify(harness.data).includes(secret), false);
  assert.deepEqual(
    await harness.service.resolvePayload(
      "alpha",
      result.inbox.envelope.payloadReference!.reference,
    ),
    {
      api_key: secret,
      details: "x".repeat(80),
      release_id: "release-42",
    },
  );
});

test("expired encrypted payloads become unreadable and are pruned without losing inbox audit", async () => {
  let current = new Date(TEST_NOW);
  const harness = makeHarness({
    additionalProperties: true,
    now: () => current,
  });
  const result = await harness.service.admit(
    admission({
      payload: {
        release_id: "release-42",
        api_key: "retention-secret",
      },
    }),
  );
  const reference = result.inbox.envelope.payloadReference!.reference;
  current = new Date("2026-08-04T12:00:00.000Z");

  await assert.rejects(
    harness.service.resolvePayload("alpha", reference),
    (error: unknown) => error instanceof WorkerLifecycleError && error.code === "not_found",
  );
  assert.equal(await harness.service.pruneExpiredPayloads("alpha"), 1);
  assert.equal(harness.data.workerActivationPayloads.length, 0);
  assert.equal(harness.data.workerActivationInboxes.length, 1);
});

for (const phase of [
  "before_inbox_reservation",
  "after_inbox_reservation",
  "before_run_creation",
  "after_run_creation",
  "before_event_append",
  "after_event_append",
  "before_job_enqueue",
  "after_job_enqueue",
] as const satisfies readonly WorkerActivationCommitPhase[]) {
  test(`crash at ${phase} rolls the whole activation transaction back`, async () => {
    const harness = makeHarness({ crashAt: phase });
    await assert.rejects(harness.service.admit(admission()), /injected crash/);
    assertNoActivationWrites(harness.data);
  });
}

test("traceparent parsing preserves valid W3C context and rejects malformed input", () => {
  assert.deepEqual(
    workerTraceFromTraceparent(
      "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      "vendor=value",
    ),
    {
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
      traceState: "vendor=value",
    },
  );
  assert.throws(
    () => workerTraceFromTraceparent("00-00000000000000000000000000000000-0123456789abcdef-01"),
    /valid W3C trace context/,
  );
});

interface HarnessOptions {
  readonly deploymentStatus?: "active" | "paused";
  readonly manualEnabled?: boolean;
  readonly additionalProperties?: boolean;
  readonly maxInlinePayloadBytes?: number;
  readonly crashAt?: WorkerActivationCommitPhase;
  readonly now?: () => Date;
}

function makeHarness(options: HarnessOptions = {}) {
  let data = activeWorkerData(options);
  const repository = createWorkerActivationRepository({
    loadStore: () => data,
    mutateStore: async <T>(mutator: (store: PacketAgentData) => T | Promise<T>): Promise<T> => {
      const draft = structuredClone(data);
      const result = await mutator(draft);
      data = draft;
      return result;
    },
  });
  let sequence = 0;
  const encrypted = new Map<string, string>();
  const service = createWorkerActivationService({
    repository,
    now: options.now ?? (() => new Date(TEST_NOW)),
    id: (kind) => `${kind}-${++sequence}`,
    maxInlinePayloadBytes: options.maxInlinePayloadBytes,
    encrypt: (plaintext) => {
      const key = `cipher-${encrypted.size + 1}`;
      encrypted.set(key, plaintext);
      return { ciphertext: key, iv: "test-iv", authTag: "test-tag" };
    },
    decrypt: (record) => {
      const plaintext = encrypted.get(record.ciphertext);
      if (plaintext === undefined) throw new Error("missing ciphertext");
      return plaintext;
    },
    onCommitPhase: (phase) => {
      if (phase === options.crashAt) throw new Error("injected crash");
    },
  });
  return {
    get data() {
      return data;
    },
    service,
  };
}

function activeWorkerData(options: HarnessOptions): PacketAgentData {
  const data = createSeedStore();
  const content = makeWorkerVersionContent({
    inputSchema: {
      fields: [
        {
          key: "release_id",
          label: "Release ID",
          type: "string",
          required: true,
        },
      ],
      additionalProperties: options.additionalProperties ?? false,
    },
    triggers: [
      {
        id: "manual",
        kind: "manual",
        enabled: options.manualEnabled ?? true,
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
  data.workerDeployments.push(
    makeWorkerDeployment({
      workspaceId: "alpha",
      status: options.deploymentStatus ?? "active",
    }),
  );
  return data;
}

function admission(
  overrides: Partial<Parameters<ReturnType<typeof createWorkerActivationService>["admit"]>[0]> = {},
) {
  return {
    workspaceId: "alpha",
    workerDeploymentId: "deployment-1",
    triggerId: "manual",
    source: "manual" as const,
    deliveryId: "delivery-1",
    occurredAt: TEST_NOW,
    actor: ACTOR,
    payload: { release_id: "release-42" },
    trace: TRACE,
    ...overrides,
  };
}

function assertNoActivationWrites(data: PacketAgentData): void {
  assert.equal(data.workerActivationInboxes.length, 0);
  assert.equal(data.workerActivationPayloads.length, 0);
  assert.equal(data.workerRuns.length, 0);
  assert.equal(data.jobs.filter((job) => job.type === "worker.run").length, 0);
  assert.equal(
    data.workerEvents.filter((event) => event.type === "worker.activation.accepted").length,
    0,
  );
}
