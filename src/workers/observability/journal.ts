import { createHash } from "node:crypto";
import {
  LEGACY_WORKER_EVENT_SCHEMA_VERSION,
  WORKER_EVENT_SCHEMA_VERSION,
  type WorkerEvent,
  type WorkerEventCorrelation,
  type WorkerEventV2,
  type WorkerJournalAppendInput,
} from "../persistence-types.js";
import { canonicalWorkerJson } from "../validation.js";
import {
  WORKER_EVIDENCE_SCHEMA_VERSION,
  type WorkerEvidenceEntry,
  type WorkerEvidenceSourceReference,
} from "./types.js";

export interface WorkerJournalCollections {
  workerEvents: WorkerEvent[];
  workerEvidenceEntries: WorkerEvidenceEntry[];
}

export interface WorkerJournalAppendResult {
  readonly event: WorkerEventV2;
  readonly evidence: WorkerEvidenceEntry;
}

export function appendWorkerJournalEntry(
  data: WorkerJournalCollections,
  input: WorkerJournalAppendInput,
): WorkerJournalAppendResult {
  const sequence = nextWorkspaceSequence(data.workerEvents, input.workspaceId);
  const deploymentSequence = input.workerDeploymentId
    ? nextDeploymentSequence(data.workerEvents, input.workspaceId, input.workerDeploymentId)
    : undefined;
  const runSequence = input.workerRunId
    ? nextRunSequence(data.workerEvents, input.workspaceId, input.workerRunId)
    : undefined;
  const evidenceId = `evidence:${input.id}`;
  const dataDigest = digest(input.data ?? null);
  const eventWithoutDigest = {
    schemaVersion: WORKER_EVENT_SCHEMA_VERSION,
    id: input.id,
    workspaceId: input.workspaceId,
    sequence,
    type: input.type,
    source: input.source,
    workerDefinitionId: input.workerDefinitionId,
    ...(input.workerVersionId ? { workerVersionId: input.workerVersionId } : {}),
    ...(input.workerDeploymentId ? { workerDeploymentId: input.workerDeploymentId } : {}),
    ...(input.workerRunId ? { workerRunId: input.workerRunId } : {}),
    ...(deploymentSequence ? { deploymentSequence } : {}),
    ...(runSequence ? { runSequence } : {}),
    actor: input.actor,
    summary: input.summary,
    ...(input.data ? { data: input.data } : {}),
    ...(input.trace ? { trace: input.trace } : {}),
    ...(input.correlation && Object.keys(input.correlation).length > 0
      ? { correlation: input.correlation }
      : {}),
    evidenceId,
    dataClassification: input.dataClassification ?? "internal",
    dataDigest,
    occurredAt: input.occurredAt,
  } as const;
  const event: WorkerEventV2 = {
    ...eventWithoutDigest,
    eventDigest: digest(eventWithoutDigest),
  };
  const sourceReferences = evidenceSourceReferences(event);
  const evidenceWithoutDigest = {
    schemaVersion: WORKER_EVIDENCE_SCHEMA_VERSION,
    id: evidenceId,
    workspaceId: input.workspaceId,
    sequence,
    workerDefinitionId: input.workerDefinitionId,
    ...(input.workerVersionId ? { workerVersionId: input.workerVersionId } : {}),
    ...(input.workerDeploymentId ? { workerDeploymentId: input.workerDeploymentId } : {}),
    ...(input.workerRunId ? { workerRunId: input.workerRunId } : {}),
    sourceEventId: event.id,
    sourceEventDigest: event.eventDigest,
    sourceReferences,
    ...(input.trace?.traceId ? { traceId: input.trace.traceId } : {}),
    ...(input.trace?.spanId ? { spanId: input.trace.spanId } : {}),
    summary: input.summary,
    classification: input.dataClassification ?? "internal",
    ...(input.rawPayload ? { rawPayload: input.rawPayload } : {}),
    ...(input.artifactManifestIds && input.artifactManifestIds.length > 0
      ? { artifactManifestIds: [...input.artifactManifestIds] }
      : {}),
    createdAt: input.occurredAt,
  } as const;
  const evidence: WorkerEvidenceEntry = {
    ...evidenceWithoutDigest,
    evidenceDigest: digest(evidenceWithoutDigest),
  };
  data.workerEvents.push(event);
  data.workerEvidenceEntries.push(evidence);
  return { event, evidence };
}

export function computeWorkerEventDigest(event: Omit<WorkerEventV2, "eventDigest">): string {
  return digest(event);
}

export function computeWorkerEvidenceDigest(
  evidence: Omit<WorkerEvidenceEntry, "evidenceDigest">,
): string {
  return digest(evidence);
}

export function isWorkerEventV2(event: WorkerEvent): event is WorkerEventV2 {
  return event.schemaVersion === WORKER_EVENT_SCHEMA_VERSION;
}

function nextWorkspaceSequence(events: readonly WorkerEvent[], workspaceId: string): number {
  return (
    events
      .filter((event) => event.workspaceId === workspaceId)
      .reduce((maximum, event) => Math.max(maximum, event.sequence), 0) + 1
  );
}

function nextDeploymentSequence(
  events: readonly WorkerEvent[],
  workspaceId: string,
  workerDeploymentId: string,
): number {
  return nextStreamSequence(
    events.filter(
      (event) =>
        event.workspaceId === workspaceId && event.workerDeploymentId === workerDeploymentId,
    ),
    "deployment",
  );
}

function nextRunSequence(
  events: readonly WorkerEvent[],
  workspaceId: string,
  workerRunId: string,
): number {
  return nextStreamSequence(
    events.filter(
      (event) =>
        event.workspaceId === workspaceId &&
        (isWorkerEventV2(event)
          ? event.workerRunId === workerRunId
          : event.data?.workerRunId === workerRunId),
    ),
    "run",
  );
}

function nextStreamSequence(events: readonly WorkerEvent[], stream: "deployment" | "run"): number {
  return (
    events.reduce((maximum, event) => {
      if (event.schemaVersion === LEGACY_WORKER_EVENT_SCHEMA_VERSION) {
        return Math.max(maximum, event.sequence);
      }
      const sequence = stream === "deployment" ? event.deploymentSequence : event.runSequence;
      return Math.max(maximum, sequence ?? 0);
    }, 0) + 1
  );
}

function evidenceSourceReferences(event: WorkerEventV2): WorkerEvidenceSourceReference[] {
  const references: WorkerEvidenceSourceReference[] = [
    {
      kind: "worker_event",
      id: event.id,
      digest: event.eventDigest,
    },
  ];
  const correlation = event.correlation;
  if (!correlation) return references;
  pushReference(references, "activation_inbox", correlation.activationInboxId);
  pushReference(references, "execution_job", correlation.executionJobId);
  pushReference(references, "provider_call", correlation.providerCallId);
  pushReference(references, "tool_call", correlation.toolCallId);
  pushReference(references, "effect_receipt", correlation.effectReceiptId);
  pushReference(references, "checkpoint", correlation.checkpointId);
  pushReference(references, "attention_request", correlation.attentionRequestId);
  pushReference(references, "approval_grant", correlation.approvalGrantId);
  pushReference(references, "control_command", correlation.controlCommandId);
  return references;
}

function pushReference(
  references: WorkerEvidenceSourceReference[],
  kind: WorkerEvidenceSourceReference["kind"],
  id: string | undefined,
): void {
  if (id) references.push({ kind, id });
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalWorkerJson(value)).digest("hex")}`;
}

export function workerEventCorrelation(
  data: Record<string, unknown> | undefined,
): WorkerEventCorrelation | undefined {
  if (!data) return undefined;
  const correlation: WorkerEventCorrelation = {
    ...stringField(data, "activationId"),
    ...stringField(data, "activationInboxId"),
    ...stringField(data, "executionJobId"),
    ...stringField(data, "providerCallId"),
    ...renamedStringField(data, "callId", "toolCallId"),
    ...stringField(data, "effectReceiptId"),
    ...stringField(data, "checkpointId"),
    ...stringField(data, "attentionRequestId"),
    ...stringField(data, "approvalGrantId"),
    ...stringField(data, "controlCommandId"),
  };
  return Object.keys(correlation).length > 0 ? correlation : undefined;
}

function stringField<TName extends keyof WorkerEventCorrelation>(
  data: Record<string, unknown>,
  name: TName,
): Pick<WorkerEventCorrelation, TName> | Record<never, never> {
  const value = data[name];
  return typeof value === "string" && value
    ? ({ [name]: value } as Pick<WorkerEventCorrelation, TName>)
    : {};
}

function renamedStringField<TName extends keyof WorkerEventCorrelation>(
  data: Record<string, unknown>,
  sourceName: string,
  targetName: TName,
): Pick<WorkerEventCorrelation, TName> | Record<never, never> {
  const value = data[sourceName];
  return typeof value === "string" && value
    ? ({ [targetName]: value } as Pick<WorkerEventCorrelation, TName>)
    : {};
}
