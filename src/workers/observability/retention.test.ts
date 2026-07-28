import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createSeedStore, type PacketAgentData } from "../../packetagent-store.js";
import {
  WORKER_ACTIVATION_INBOX_SCHEMA_VERSION,
  WORKER_ACTIVATION_PAYLOAD_SCHEMA_VERSION,
  WORKER_ACTIVATION_SCHEMA_VERSION,
} from "../activation-types.js";
import {
  WORKER_EFFECT_RECEIPT_SCHEMA_VERSION,
  type WorkerEffectReceipt,
  type WorkerEffectRetainedResultReference,
} from "../effect-types.js";
import {
  makeWorkerCheckpoint,
  makeWorkerDefinition,
  makeWorkerDeployment,
  makeWorkerRun,
  makeWorkerVersion,
} from "../__tests__/fixtures.js";
import { workerCheckpointStateDigest } from "../runtime/checkpoint.js";
import { appendWorkerJournalEntry } from "./journal.js";
import { WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION, type WorkerArtifactManifest } from "./types.js";
import { computeWorkerArtifactManifestDigest } from "./validation.js";
import {
  createWorkerRetentionService,
  type WorkerArtifactRetentionDeleteInput,
} from "./retention.js";
import {
  WORKER_RETENTION_POLICY_SCHEMA_VERSION,
  type WorkerRetentionPolicy,
} from "./retention-types.js";
import { canonicalWorkerJson } from "../validation.js";
import { validateWorkerActivationPersistence } from "../activation-repository.js";
import { createWorkerObservabilityRepository } from "./repository.js";
import { LEGACY_WORKER_EVENT_SCHEMA_VERSION } from "../persistence-types.js";
import { buildWorkerObservabilityRollups } from "./rollups.js";

const OLD = "2026-07-01T12:00:00.000Z";
const EXPIRES = "2026-07-08T12:00:00.000Z";
const NOW = "2026-07-27T12:00:00.000Z";
const TRACE = {
  traceId: "0123456789abcdef0123456789abcdef",
  spanId: "0123456789abcdef",
};
const ACTOR = { type: "system" as const, id: "retention-test" };
const POLICY: WorkerRetentionPolicy = {
  schemaVersion: WORKER_RETENTION_POLICY_SCHEMA_VERSION,
  metadataDays: 30,
  summaryDays: 1,
  promptDays: 1,
  toolPayloadDays: 1,
  artifactDays: 1,
};

test("journal and observability reads redact sensitive keys and known secret values twice", async () => {
  const data = canonicalData();
  const secret = "opaque-secret-value-42";
  const appended = appendWorkerJournalEntry(data, {
    id: "event-redaction",
    workspaceId: "alpha",
    type: "worker.tool.completed",
    source: "tool",
    workerDefinitionId: "definition-1",
    workerVersionId: "version-1",
    workerDeploymentId: "deployment-1",
    workerRunId: "run-1",
    actor: ACTOR,
    summary: `Tool returned ${secret}.`,
    data: {
      authorization: "Bearer abc.def.ghi",
      safeLookingField: `prefix ${secret} suffix`,
    },
    knownSecretValues: [secret],
    occurredAt: OLD,
  });

  assert.equal(JSON.stringify(appended).includes(secret), false);
  assert.equal(JSON.stringify(appended).includes("abc.def.ghi"), false);

  data.workerEvents.push({
    schemaVersion: LEGACY_WORKER_EVENT_SCHEMA_VERSION,
    id: "legacy-api-redaction",
    workspaceId: "alpha",
    sequence: 2,
    type: "worker.legacy",
    workerDefinitionId: "definition-1",
    actor: ACTOR,
    summary: `Legacy response ${secret}.`,
    data: { harmless: secret },
    occurredAt: OLD,
  });
  const repository = createWorkerObservabilityRepository({
    loadStore: () => data,
    knownSecretValues: () => [secret],
  });
  const events = await repository.listEvents("alpha");
  assert.equal(JSON.stringify(events).includes(secret), false);
});

test("bounded retention dry-runs, compacts terminal payloads, and records idempotent tombstones", async () => {
  let data = retentionData();
  const artifactDeletes: WorkerArtifactRetentionDeleteInput[] = [];
  let sequence = 0;
  let monotonic = 0;
  let mutationCalls = 0;
  const service = createWorkerRetentionService({
    loadStore: () => data,
    mutateStore: async (mutator) => {
      mutationCalls += 1;
      const draft = structuredClone(data);
      const result = await mutator(draft);
      data = draft;
      return result;
    },
    artifactPort: {
      async delete(input) {
        artifactDeletes.push(input);
        return "deleted";
      },
    },
    now: () => new Date(NOW),
    monotonicMs: () => monotonic++,
    id: () => `retention-event-${++sequence}`,
  });

  const before = structuredClone(data);
  const preview = await service.cleanup({
    workspaceId: "alpha",
    policy: POLICY,
    dryRun: true,
    maxItems: 2,
    maxDurationMs: 5_000,
  });
  assert.equal(preview.processed, 2);
  assert.equal(preview.deleted, 0);
  assert.equal(preview.hasMore, true);
  assert.deepEqual(data, before);
  assert.deepEqual(artifactDeletes, []);
  assert.equal(mutationCalls, 0);

  let failedArtifactData = retentionData();
  const failedArtifactService = createWorkerRetentionService({
    loadStore: () => failedArtifactData,
    mutateStore: async (mutator) => {
      const draft = structuredClone(failedArtifactData);
      const value = await mutator(draft);
      failedArtifactData = draft;
      return value;
    },
    artifactPort: {
      async delete() {
        throw new Error("injected artifact store failure");
      },
    },
    now: () => new Date(NOW),
    id: () => `failed-artifact-event-${++sequence}`,
  });
  const failedArtifactResult = await failedArtifactService.cleanup({
    workspaceId: "alpha",
    policy: {
      ...POLICY,
      metadataDays: 3_650,
      summaryDays: 3_650,
      promptDays: 3_650,
      toolPayloadDays: 3_650,
    },
    maxItems: 100,
    maxDurationMs: 5_000,
  });
  assert.equal(failedArtifactResult.categories.artifact.failed, 1);
  assert.equal(
    failedArtifactData.workerEvents.some((event) => event.data?.resourceKind === "artifact_bytes"),
    false,
  );

  const result = await service.cleanup({
    workspaceId: "alpha",
    policy: POLICY,
    maxItems: 100,
    maxDurationMs: 5_000,
  });
  assert.equal(result.dryRun, false);
  assert.equal(mutationCalls, 1);
  assert.ok(result.deleted >= 7);
  assert.equal(
    data.workerActivationPayloads.some((record) => record.workspaceId === "alpha"),
    false,
  );
  assert.equal(
    data.workerActivationPayloads.some((record) => record.workspaceId === "beta"),
    true,
  );
  const inlineRun = data.workerRuns.find((run) => run.id === "run-inline")!;
  assert.equal(inlineRun.input, undefined);
  assert.equal(inlineRun.output, undefined);
  assert.equal(inlineRun.error, undefined);
  assert.deepEqual(data.workerRuns.find((run) => run.id === "run-active")?.input, {
    note: "must-survive-for-resume",
  });
  const effectRun = data.workerRuns.find((run) => run.id === "run-1")!;
  assert.equal(effectRun.latestCheckpointId, undefined);
  assert.equal(
    data.workerCheckpoints.some((checkpoint) => checkpoint.workerRunId === effectRun.id),
    false,
  );
  assert.equal(data.workerEffectReceipts[0].result?.kind, "retention_tombstone");
  assert.equal(JSON.stringify(data).includes("tool-result-secret"), false);
  assert.equal(artifactDeletes.length, 1);
  assert.equal(
    data.workerEvents.some((event) => event.type === "worker.retention.summary_deleted"),
    true,
  );
  const checkpointTombstone = data.workerEvents.find(
    (event) => event.data?.resourceKind === "checkpoint_chain",
  );
  assert.deepEqual(checkpointTombstone?.data?.resourceIdDigests, [
    digest({ resourceId: "checkpoint-1" }),
  ]);
  assert.equal(
    "workerRunId" in checkpointTombstone! ? checkpointTombstone.workerRunId : undefined,
    "run-1",
  );
  assert.equal("source" in checkpointTombstone! && checkpointTombstone.source, "retention");
  assert.equal(
    Array.isArray(checkpointTombstone?.data?.resourceIdDigests) &&
      checkpointTombstone.data.resourceIdDigests.includes(digest({ resourceId: "checkpoint-1" })),
    true,
  );
  assert.deepEqual(
    buildWorkerObservabilityRollups(data, "alpha").runs.find(
      (rollup) => rollup.identity.workerRunId === "run-1",
    )?.sourceGaps,
    {
      total: 1,
      retentionDeleted: 1,
      unexplained: 0,
      byKind: { checkpoint: 1 },
    },
  );
  assert.equal(
    data.workerEvents.some(
      (event) =>
        "source" in event &&
        event.source === "retention" &&
        event.data?.resourceKind === "checkpoint_chain",
    ),
    true,
  );
  assert.doesNotThrow(() => validateWorkerActivationPersistence(data));

  await service.cleanup({
    workspaceId: "alpha",
    policy: POLICY,
    maxItems: 100,
    maxDurationMs: 5_000,
  });
  assert.equal(artifactDeletes.length, 1);
  assert.doesNotThrow(() => validateWorkerActivationPersistence(data));
});

function canonicalData(): PacketAgentData {
  const data = createSeedStore();
  data.workerDefinitions.push(
    makeWorkerDefinition({
      id: "definition-1",
      workspaceId: "alpha",
      status: "active",
      currentVersionId: "version-1",
    }),
  );
  data.workerVersions.push(
    makeWorkerVersion({
      id: "version-1",
      workspaceId: "alpha",
      workerDefinitionId: "definition-1",
      status: "validated",
    }),
  );
  data.workerDeployments.push(
    makeWorkerDeployment({
      id: "deployment-1",
      workspaceId: "alpha",
      workerDefinitionId: "definition-1",
      workerVersionId: "version-1",
      status: "active",
    }),
  );
  data.workerRuns.push(
    makeWorkerRun({
      id: "run-1",
      workspaceId: "alpha",
      workerDefinitionId: "definition-1",
      workerVersionId: "version-1",
      workerDeploymentId: "deployment-1",
      status: "completed",
      createdAt: OLD,
      startedAt: OLD,
      updatedAt: OLD,
      completedAt: OLD,
    }),
  );
  data.workerRuns.push(
    makeWorkerRun({
      id: "run-active",
      workspaceId: "alpha",
      workerDefinitionId: "definition-1",
      workerVersionId: "version-1",
      workerDeploymentId: "deployment-1",
      status: "queued",
      input: { note: "must-survive-for-resume" },
      createdAt: OLD,
      updatedAt: OLD,
    }),
  );
  return data;
}

function retentionData(): PacketAgentData {
  const data = canonicalData();
  data.workerRuns[0] = {
    ...data.workerRuns[0],
    input: undefined,
    inputReference: "worker-activation-payload:payload-1",
    latestCheckpointId: "checkpoint-1",
  };
  data.workerRuns.push(
    makeWorkerRun({
      id: "run-inline",
      workspaceId: "alpha",
      workerDefinitionId: "definition-1",
      workerVersionId: "version-1",
      workerDeploymentId: "deployment-1",
      status: "completed",
      input: { note: "prompt-secret" },
      output: { note: "run-output-secret" },
      error: "run-error-secret",
      createdAt: OLD,
      startedAt: OLD,
      updatedAt: OLD,
      completedAt: OLD,
    }),
  );

  const checkpointContent = makeWorkerCheckpoint({
    id: "checkpoint-1",
    workspaceId: "alpha",
    workerRunId: "run-1",
    workerVersionId: "version-1",
    workingMemory: {
      pendingTools: [{ id: "call-1", name: "http_fetch", input: { value: "tool-input-secret" } }],
      toolResults: [{ output: "tool-result-secret" }],
    },
    createdAt: OLD,
  });
  const { stateDigest: _stateDigest, ...unsignedCheckpoint } = checkpointContent;
  data.workerCheckpoints.push({
    ...unsignedCheckpoint,
    stateDigest: workerCheckpointStateDigest(unsignedCheckpoint),
  });

  const resultContent: Omit<WorkerEffectRetainedResultReference, "digest"> = {
    kind: "inline_redacted",
    status: "ok",
    output: { value: "tool-result-secret" },
    artifactRefs: ["artifact:report"],
    durationMs: 25,
    startedAt: OLD,
    completedAt: OLD,
  };
  const effect: WorkerEffectReceipt = {
    schemaVersion: WORKER_EFFECT_RECEIPT_SCHEMA_VERSION,
    id: "effect-1",
    workspaceId: "alpha",
    workerRunId: "run-1",
    workerVersionId: "version-1",
    workerDeploymentId: "deployment-1",
    effectKey: `sha256:${"a".repeat(64)}`,
    iteration: 0,
    actionId: "call-1",
    capabilityId: "release-read",
    toolName: "http_fetch",
    operation: "GET https://example.test",
    inputDigest: `sha256:${"b".repeat(64)}`,
    classification: "idempotent_mutation",
    status: "completed",
    preparedAt: OLD,
    completedAt: OLD,
    result: {
      ...resultContent,
      digest: digest(resultContent),
    },
  };
  data.workerEffectReceipts.push(effect);

  const artifactSource = appendWorkerJournalEntry(data, {
    id: "event-artifact-source",
    workspaceId: "alpha",
    type: "worker.tool.completed",
    source: "tool",
    workerDefinitionId: "definition-1",
    workerVersionId: "version-1",
    workerDeploymentId: "deployment-1",
    workerRunId: "run-1",
    actor: ACTOR,
    summary: "Artifact created.",
    correlation: { checkpointId: "checkpoint-1" },
    occurredAt: OLD,
  });
  appendWorkerJournalEntry(data, {
    id: "event-expired-summary",
    workspaceId: "alpha",
    type: "worker.phase.completed",
    source: "supervisor",
    workerDefinitionId: "definition-1",
    workerVersionId: "version-1",
    workerDeploymentId: "deployment-1",
    workerRunId: "run-inline",
    actor: ACTOR,
    summary: "Expired event summary.",
    data: { detail: "expired-event-payload" },
    occurredAt: OLD,
  });
  data.workerArtifactManifests.push(artifactManifest(artifactSource.evidence.id));
  addActivationPayload(data);
  data.workerActivationPayloads.push({
    schemaVersion: WORKER_ACTIVATION_PAYLOAD_SCHEMA_VERSION,
    id: "payload-beta",
    reference: "worker-activation-payload:payload-beta",
    workspaceId: "beta",
    digest: `sha256:${"f".repeat(64)}`,
    byteLength: 10,
    classification: "sensitive",
    ciphertext: "beta-ciphertext",
    iv: "beta-iv",
    authTag: "beta-auth-tag",
    createdAt: OLD,
    expiresAt: EXPIRES,
  });
  validateWorkerActivationPersistence(data);
  return data;
}

function addActivationPayload(data: PacketAgentData): void {
  const digestValue = `sha256:${"d".repeat(64)}`;
  data.workerActivationPayloads.push({
    schemaVersion: WORKER_ACTIVATION_PAYLOAD_SCHEMA_VERSION,
    id: "payload-1",
    reference: "worker-activation-payload:payload-1",
    workspaceId: "alpha",
    digest: digestValue,
    byteLength: 32,
    classification: "sensitive",
    ciphertext: "ciphertext-secret",
    iv: "iv-value",
    authTag: "auth-tag-value",
    createdAt: OLD,
    expiresAt: EXPIRES,
  });
  data.jobs.push({
    id: "job-1",
    workspaceId: "alpha",
    type: "worker.run",
    payload: {
      workerRunId: "run-1",
      workerDeploymentId: "deployment-1",
      workerVersionId: "version-1",
      activationInboxId: "inbox-1",
    },
    status: "success",
    attempts: 1,
    maxAttempts: 2,
    scheduledAt: OLD,
    startedAt: OLD,
    completedAt: OLD,
    createdAt: OLD,
    updatedAt: OLD,
  });
  data.workerActivationInboxes.push({
    schemaVersion: WORKER_ACTIVATION_INBOX_SCHEMA_VERSION,
    id: "inbox-1",
    workspaceId: "alpha",
    workerDeploymentId: "deployment-1",
    workerVersionId: "version-1",
    triggerId: "manual",
    source: "manual",
    deliveryId: "delivery-1",
    requestDigest: `sha256:${"e".repeat(64)}`,
    disposition: "accepted",
    workerRunId: "run-1",
    executionJobId: "job-1",
    envelope: {
      schemaVersion: WORKER_ACTIVATION_SCHEMA_VERSION,
      id: "activation-1",
      source: "manual",
      deliveryId: "delivery-1",
      occurredAt: OLD,
      receivedAt: OLD,
      actor: ACTOR,
      workspaceId: "alpha",
      workerDeploymentId: "deployment-1",
      workerVersionId: "version-1",
      triggerId: "manual",
      triggerKind: "manual",
      payloadReference: {
        reference: "worker-activation-payload:payload-1",
        digest: digestValue,
        byteLength: 32,
        classification: "sensitive",
        encrypted: true,
        expiresAt: EXPIRES,
      },
      payloadRetention: {
        mode: "encrypted_reference",
        policy: "expire_at",
        expiresAt: EXPIRES,
      },
      trace: TRACE,
    },
    firstSeenAt: OLD,
    lastSeenAt: OLD,
    duplicateCount: 0,
  });
}

function artifactManifest(sourceEvidenceId: string): WorkerArtifactManifest {
  const unsigned = {
    schemaVersion: WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION,
    id: "artifact-1",
    workspaceId: "alpha",
    workerDefinitionId: "definition-1",
    workerVersionId: "version-1",
    workerDeploymentId: "deployment-1",
    workerRunId: "run-1",
    artifact: {
      reference: "artifact:report",
      mediaType: "application/json",
      byteLength: 128,
      contentDigest: `sha256:${"c".repeat(64)}`,
    },
    classification: "internal" as const,
    provenance: {
      producerKind: "worker_tool" as const,
      producerId: "call-1",
      sourceEvidenceIds: [sourceEvidenceId],
      materials: [],
    },
    createdAt: OLD,
  };
  return {
    ...unsigned,
    manifestDigest: computeWorkerArtifactManifestDigest(unsigned),
  };
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalWorkerJson(value)).digest("hex")}`;
}
