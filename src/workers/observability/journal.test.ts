import assert from "node:assert/strict";
import test from "node:test";
import { createSeedStore, type PacketAgentData } from "../../packetagent-store.js";
import {
  makeWorkerDefinition,
  makeWorkerDeployment,
  makeWorkerRun,
  makeWorkerVersion,
} from "../__tests__/fixtures.js";
import {
  LEGACY_WORKER_EVENT_SCHEMA_VERSION,
  type WorkerJournalAppendInput,
} from "../persistence-types.js";
import { validateWorkerPersistence } from "../repository.js";
import {
  appendWorkerJournalEntry,
  computeWorkerEvidenceDigest,
  computeWorkerEventDigest,
} from "./journal.js";
import { WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION, type WorkerArtifactManifest } from "./types.js";
import { computeWorkerArtifactManifestDigest } from "./validation.js";
import { createWorkerObservabilityRepository } from "./repository.js";

const NOW = "2026-07-27T18:00:00.000Z";
const ACTOR = {
  type: "system" as const,
  id: "packetagent.observability-test",
};
const TRACE = {
  traceId: "0123456789abcdef0123456789abcdef",
  spanId: "0123456789abcdef",
};

test("Worker journal assigns monotonic workspace, deployment, and run sequences", () => {
  const data = canonicalData();
  const deployment = appendWorkerJournalEntry(
    data,
    journalInput({
      id: "event-deployment",
      type: "worker.deployment.active",
      source: "lifecycle",
    }),
  );
  const activation = appendWorkerJournalEntry(
    data,
    journalInput({
      id: "event-activation",
      type: "worker.activation.accepted",
      source: "activation",
      workerRunId: "worker-run-1",
      trace: TRACE,
      correlation: {
        activationId: "activation-1",
        activationInboxId: "inbox-1",
        executionJobId: "job-1",
      },
      rawPayload: {
        state: "retained",
        reference: "payload:1",
        contentDigest: `sha256:${"a".repeat(64)}`,
        mediaType: "application/json",
        byteLength: 42,
        classification: "sensitive_reference",
        expiresAt: "2026-07-28T18:00:00.000Z",
      },
      dataClassification: "sensitive_reference",
    }),
  );
  const effect = appendWorkerJournalEntry(
    data,
    journalInput({
      id: "event-effect",
      type: "worker.effect.completed",
      source: "effect",
      workerRunId: "worker-run-1",
      trace: TRACE,
      correlation: {
        toolCallId: "call-1",
        effectReceiptId: "effect-1",
      },
    }),
  );

  assert.deepEqual(
    data.workerEvents.map((event) => event.sequence),
    [1, 2, 3],
  );
  assert.equal(deployment.event.deploymentSequence, 1);
  assert.equal(activation.event.deploymentSequence, 2);
  assert.equal(effect.event.deploymentSequence, 3);
  assert.equal(activation.event.runSequence, 1);
  assert.equal(effect.event.runSequence, 2);
  assert.equal(activation.evidence.sequence, activation.event.sequence);
  assert.equal(activation.evidence.traceId, TRACE.traceId);
  assert.deepEqual(
    activation.evidence.sourceReferences.map((reference) => reference.kind),
    ["worker_event", "activation_inbox", "execution_job"],
  );
  assert.equal(
    effect.evidence.sourceReferences.some(
      (reference) => reference.kind === "effect_receipt" && reference.id === "effect-1",
    ),
    true,
  );
  assert.doesNotThrow(() => validateWorkerPersistence(data));
});

test("Worker event and evidence digests detect envelope or summary tampering", () => {
  const data = canonicalData();
  const appended = appendWorkerJournalEntry(
    data,
    journalInput({
      id: "event-1",
      workerRunId: "worker-run-1",
      trace: TRACE,
      correlation: { checkpointId: "checkpoint-1" },
    }),
  );
  const { eventDigest: _eventDigest, ...unsignedEvent } = appended.event;
  const { evidenceDigest: _evidenceDigest, ...unsignedEvidence } = appended.evidence;
  assert.equal(appended.event.eventDigest, computeWorkerEventDigest(unsignedEvent));
  assert.equal(appended.evidence.evidenceDigest, computeWorkerEvidenceDigest(unsignedEvidence));

  data.workerEvents[0] = {
    ...appended.event,
    summary: "tampered after persistence",
  };
  assert.throws(() => validateWorkerPersistence(data), /digest does not match/);

  data.workerEvents[0] = appended.event;
  data.workerEvidenceEntries[0] = {
    ...appended.evidence,
    summary: "tampered after persistence",
  };
  assert.throws(() => validateWorkerPersistence(data), /digest does not match/);
});

test("observability repository returns ordered workspace-scoped stream pages", async () => {
  const data = canonicalData();
  appendWorkerJournalEntry(
    data,
    journalInput({
      id: "event-1",
      workerRunId: "worker-run-1",
      trace: TRACE,
    }),
  );
  appendWorkerJournalEntry(
    data,
    journalInput({
      id: "event-2",
      type: "worker.tool.completed",
      source: "tool",
      workerRunId: "worker-run-1",
      trace: TRACE,
      correlation: { toolCallId: "call-2" },
    }),
  );
  const repository = createWorkerObservabilityRepository({
    loadStore: () => data,
  });

  const events = await repository.listEvents("alpha", {
    workerRunId: "worker-run-1",
    afterSequence: 1,
  });
  const evidence = await repository.listEvidence("alpha", {
    workerDeploymentId: "worker-deployment-1",
  });
  assert.deepEqual(
    events.map((event) => event.id),
    ["event-2"],
  );
  assert.deepEqual(
    evidence.map((entry) => entry.sequence),
    [1, 2],
  );
  assert.deepEqual(await repository.listEvents("workspace-2"), []);
});

test("artifact manifests bind content, provenance, and source evidence", () => {
  const data = canonicalData();
  const { evidence } = appendWorkerJournalEntry(
    data,
    journalInput({
      id: "event-artifact",
      type: "worker.tool.completed",
      source: "tool",
      workerRunId: "worker-run-1",
      trace: TRACE,
      correlation: { toolCallId: "call-artifact" },
    }),
  );
  const unsigned = {
    schemaVersion: WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION,
    id: "artifact-manifest-1",
    workspaceId: "alpha",
    workerDefinitionId: "worker-definition-1",
    workerVersionId: "worker-version-1",
    workerDeploymentId: "worker-deployment-1",
    workerRunId: "worker-run-1",
    artifact: {
      reference: "artifact:report-1",
      name: "release-report.json",
      mediaType: "application/json",
      byteLength: 128,
      contentDigest: `sha256:${"b".repeat(64)}`,
    },
    classification: "internal" as const,
    provenance: {
      producerKind: "worker_tool" as const,
      producerId: "call-artifact",
      sourceEvidenceIds: [evidence.id],
      materials: [
        {
          reference: "artifact:input-1",
          mediaType: "application/json",
          byteLength: 64,
          contentDigest: `sha256:${"c".repeat(64)}`,
        },
      ],
    },
    createdAt: NOW,
  };
  const manifest: WorkerArtifactManifest = {
    ...unsigned,
    manifestDigest: computeWorkerArtifactManifestDigest(unsigned),
  };
  data.workerArtifactManifests.push(manifest);

  assert.doesNotThrow(() => validateWorkerPersistence(data));
  data.workerArtifactManifests[0] = {
    ...manifest,
    artifact: { ...manifest.artifact, byteLength: 129 },
  };
  assert.throws(() => validateWorkerPersistence(data), /digest does not match/);
});

test("legacy v1 Worker events remain readable without fabricated evidence", () => {
  const data = canonicalData();
  data.workerEvents.push({
    schemaVersion: LEGACY_WORKER_EVENT_SCHEMA_VERSION,
    id: "legacy-event-1",
    workspaceId: "alpha",
    sequence: 1,
    type: "worker.deployment.active",
    workerDefinitionId: "worker-definition-1",
    workerVersionId: "worker-version-1",
    workerDeploymentId: "worker-deployment-1",
    actor: ACTOR,
    summary: "Legacy deployment event.",
    occurredAt: NOW,
  });

  assert.doesNotThrow(() => validateWorkerPersistence(data));
  assert.deepEqual(data.workerEvidenceEntries, []);
});

test("v2 events reject all-zero W3C trace identifiers", () => {
  const data = canonicalData();
  appendWorkerJournalEntry(
    data,
    journalInput({
      id: "event-zero-trace",
      workerRunId: "worker-run-1",
      trace: {
        traceId: "0".repeat(32),
        spanId: "0".repeat(16),
      },
    }),
  );

  assert.throws(() => validateWorkerPersistence(data), /trace (ID|context) is invalid/);
});

function canonicalData(): PacketAgentData {
  const data = createSeedStore();
  data.workerDefinitions.push(
    makeWorkerDefinition({ id: "worker-definition-1", workspaceId: "alpha" }),
  );
  data.workerVersions.push(
    makeWorkerVersion({
      workspaceId: "alpha",
      workerDefinitionId: "worker-definition-1",
    }),
  );
  data.workerDeployments.push(
    makeWorkerDeployment({
      id: "worker-deployment-1",
      workspaceId: "alpha",
      workerDefinitionId: "worker-definition-1",
    }),
  );
  data.workerRuns.push(
    makeWorkerRun({
      id: "worker-run-1",
      workspaceId: "alpha",
      workerDefinitionId: "worker-definition-1",
      workerDeploymentId: "worker-deployment-1",
    }),
  );
  return data;
}

function journalInput(overrides: Partial<WorkerJournalAppendInput> = {}): WorkerJournalAppendInput {
  return {
    id: "event-default",
    workspaceId: "alpha",
    type: "worker.checkpoint.persisted",
    source: "checkpoint",
    workerDefinitionId: "worker-definition-1",
    workerVersionId: "worker-version-1",
    workerDeploymentId: "worker-deployment-1",
    actor: ACTOR,
    summary: "Worker evidence recorded.",
    data: { checkpointId: "checkpoint-1" },
    occurredAt: NOW,
    ...overrides,
  };
}
