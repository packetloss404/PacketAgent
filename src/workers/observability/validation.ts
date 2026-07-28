import {
  LEGACY_WORKER_EVENT_SCHEMA_VERSION,
  WORKER_EVENT_SCHEMA_VERSION,
  type WorkerEvent,
  type WorkerEventV2,
} from "../persistence-types.js";
import {
  WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION,
  WORKER_EVIDENCE_SCHEMA_VERSION,
  type WorkerArtifactManifest,
  type WorkerArtifactResourceDescriptor,
  type WorkerEvidenceEntry,
  type WorkerEvidencePayloadReference,
} from "./types.js";
import {
  computeWorkerEventDigest,
  computeWorkerEvidenceDigest,
  isWorkerEventV2,
} from "./journal.js";
import { createHash } from "node:crypto";
import { canonicalWorkerJson } from "../validation.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TRACE_ID = /^[a-f0-9]{32}$/;
const SPAN_ID = /^[a-f0-9]{16}$/;
const EVENT_SOURCES = new Set([
  "lifecycle",
  "activation",
  "queue",
  "supervisor",
  "provider",
  "tool",
  "effect",
  "approval",
  "checkpoint",
  "control",
  "recovery",
  "terminal",
]);
const CLASSIFICATIONS = new Set(["public_metadata", "internal", "sensitive_reference"]);

export function assertValidWorkerEvent(event: WorkerEvent): void {
  assertEventBase(event);
  if (event.schemaVersion === LEGACY_WORKER_EVENT_SCHEMA_VERSION) return;
  if (event.schemaVersion !== WORKER_EVENT_SCHEMA_VERSION) {
    throw new Error("Worker event schema version is unsupported.");
  }
  if (
    !EVENT_SOURCES.has(event.source) ||
    !event.evidenceId ||
    !CLASSIFICATIONS.has(event.dataClassification) ||
    !DIGEST.test(event.dataDigest) ||
    !DIGEST.test(event.eventDigest) ||
    (event.workerDeploymentId !== undefined &&
      (!Number.isSafeInteger(event.deploymentSequence) || event.deploymentSequence! <= 0)) ||
    (event.workerDeploymentId === undefined && event.deploymentSequence !== undefined) ||
    (event.workerRunId !== undefined &&
      (!Number.isSafeInteger(event.runSequence) || event.runSequence! <= 0)) ||
    (event.workerRunId === undefined && event.runSequence !== undefined) ||
    event.dataDigest !== digest(event.data ?? null)
  ) {
    throw new Error("Worker event v2 envelope is invalid.");
  }
  if (
    event.correlation &&
    Object.values(event.correlation).some((value) => typeof value !== "string" || !value)
  ) {
    throw new Error("Worker event correlation is invalid.");
  }
  assertTrace(event);
  const { eventDigest: _eventDigest, ...unsigned } = event;
  if (event.eventDigest !== computeWorkerEventDigest(unsigned)) {
    throw new Error(`Worker event ${event.id} digest does not match its envelope.`);
  }
}

export function assertValidWorkerEvidenceEntry(entry: WorkerEvidenceEntry): void {
  if (
    entry.schemaVersion !== WORKER_EVIDENCE_SCHEMA_VERSION ||
    !entry.id ||
    !entry.workspaceId ||
    !Number.isSafeInteger(entry.sequence) ||
    entry.sequence <= 0 ||
    !entry.workerDefinitionId ||
    !entry.sourceEventId ||
    !DIGEST.test(entry.sourceEventDigest) ||
    !entry.summary ||
    !CLASSIFICATIONS.has(entry.classification) ||
    !DIGEST.test(entry.evidenceDigest) ||
    !Number.isFinite(Date.parse(entry.createdAt)) ||
    entry.sourceReferences.length === 0
  ) {
    throw new Error("Worker evidence entry is invalid.");
  }
  if (entry.traceId && !validTraceId(entry.traceId)) {
    throw new Error("Worker evidence trace ID is invalid.");
  }
  if (entry.spanId && !validSpanId(entry.spanId)) {
    throw new Error("Worker evidence span ID is invalid.");
  }
  for (const source of entry.sourceReferences) {
    if (
      !source.kind ||
      !source.id ||
      (source.digest !== undefined && !DIGEST.test(source.digest))
    ) {
      throw new Error("Worker evidence source reference is invalid.");
    }
  }
  if (entry.rawPayload) assertPayloadReference(entry.rawPayload);
  const { evidenceDigest: _evidenceDigest, ...unsigned } = entry;
  if (entry.evidenceDigest !== computeWorkerEvidenceDigest(unsigned)) {
    throw new Error(`Worker evidence ${entry.id} digest does not match its content.`);
  }
}

export function assertValidWorkerArtifactManifest(manifest: WorkerArtifactManifest): void {
  if (
    manifest.schemaVersion !== WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION ||
    !manifest.id ||
    !manifest.workspaceId ||
    !manifest.workerDefinitionId ||
    !manifest.workerVersionId ||
    !manifest.workerDeploymentId ||
    !manifest.workerRunId ||
    !CLASSIFICATIONS.has(manifest.classification) ||
    !manifest.provenance.producerKind ||
    !manifest.provenance.producerId ||
    !DIGEST.test(manifest.manifestDigest) ||
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    (manifest.expiresAt !== undefined && !Number.isFinite(Date.parse(manifest.expiresAt)))
  ) {
    throw new Error("Worker artifact manifest is invalid.");
  }
  assertResourceDescriptor(manifest.artifact);
  manifest.provenance.materials.forEach(assertResourceDescriptor);
  if (manifest.provenance.sourceEvidenceIds.some((id) => !id)) {
    throw new Error("Worker artifact provenance contains an invalid evidence reference.");
  }
  const { manifestDigest: _manifestDigest, ...unsigned } = manifest;
  if (manifest.manifestDigest !== computeWorkerArtifactManifestDigest(unsigned)) {
    throw new Error(`Worker artifact manifest ${manifest.id} digest does not match its content.`);
  }
}

export function computeWorkerArtifactManifestDigest(
  manifest: Omit<WorkerArtifactManifest, "manifestDigest">,
): string {
  return digest(manifest);
}

function assertEventBase(event: WorkerEvent): void {
  if (
    !event.id ||
    !event.workspaceId ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence <= 0 ||
    !event.type ||
    !event.workerDefinitionId ||
    !event.actor?.type ||
    !event.actor.id ||
    !event.summary ||
    !Number.isFinite(Date.parse(event.occurredAt))
  ) {
    throw new Error("Worker event is invalid.");
  }
}

function assertTrace(event: WorkerEventV2): void {
  if (!event.trace) return;
  if (
    !validTraceId(event.trace.traceId) ||
    (event.trace.spanId && !validSpanId(event.trace.spanId))
  ) {
    throw new Error("Worker event trace context is invalid.");
  }
}

function assertPayloadReference(reference: WorkerEvidencePayloadReference): void {
  if (
    reference.state !== "retained" ||
    !reference.reference ||
    !DIGEST.test(reference.contentDigest) ||
    !reference.mediaType ||
    !Number.isSafeInteger(reference.byteLength) ||
    reference.byteLength < 0 ||
    !CLASSIFICATIONS.has(reference.classification) ||
    (reference.expiresAt !== undefined && !Number.isFinite(Date.parse(reference.expiresAt)))
  ) {
    throw new Error("Worker evidence payload reference is invalid.");
  }
}

function assertResourceDescriptor(descriptor: WorkerArtifactResourceDescriptor): void {
  if (
    !descriptor.reference ||
    !descriptor.mediaType ||
    !Number.isSafeInteger(descriptor.byteLength) ||
    descriptor.byteLength < 0 ||
    !DIGEST.test(descriptor.contentDigest)
  ) {
    throw new Error("Worker artifact resource descriptor is invalid.");
  }
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalWorkerJson(value)).digest("hex")}`;
}

function validTraceId(value: string): boolean {
  return TRACE_ID.test(value) && value !== "0".repeat(32);
}

function validSpanId(value: string): boolean {
  return SPAN_ID.test(value) && value !== "0".repeat(16);
}
