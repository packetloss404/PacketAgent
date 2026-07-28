import type { JsonObject, WorkerActorReference } from "../types.js";

export const PACKET_PRODUCT_WORKER_EVENT_SCHEMA_VERSION =
  "packetagent.packet-product-worker-event/v1" as const;
export const PACKET_PRODUCT_EVENT_PAGE_SCHEMA_VERSION =
  "packetagent.packet-product-event-page/v1" as const;
export const PACKET_PRODUCT_EVENT_ACKNOWLEDGEMENT_SCHEMA_VERSION =
  "packetagent.packet-product-event-acknowledgement/v1" as const;

export type PacketProductWorkerEventType =
  | "worker.deployed"
  | "worker.activated"
  | "worker.deployment.progress"
  | "worker.run.started"
  | "worker.run.progress"
  | "worker.run.checkpointed"
  | "worker.run.approval_required"
  | "worker.run.blocked"
  | "worker.run.completed"
  | "worker.run.failed"
  | "worker.run.budget_exhausted"
  | "worker.run.cancelled"
  | "worker.deployment.paused"
  | "worker.deployment.revoked";

export type PacketProductEventStreamKind = "deployment" | "run";

export interface PacketProductWorkerEvent {
  readonly schemaVersion: typeof PACKET_PRODUCT_WORKER_EVENT_SCHEMA_VERSION;
  readonly id: string;
  readonly type: PacketProductWorkerEventType;
  readonly workspaceSequence: number;
  readonly deploymentSequence?: number;
  readonly runSequence?: number;
  readonly occurredAt: string;
  readonly deploymentId: string;
  readonly workerVersion: {
    readonly id: string;
    readonly version: number;
    readonly contentDigest: string;
  };
  readonly runId?: string;
  readonly traceId?: string;
  readonly traceGap?: "source_trace_unavailable";
  readonly summary: string;
  readonly evidence: {
    readonly id?: string;
    readonly href: string;
    readonly available: boolean;
  };
  readonly source: {
    readonly eventId: string;
    readonly eventType: string;
    readonly eventDigest?: string;
  };
  readonly data?: JsonObject;
}

export interface PacketProductEventAcknowledgementRecord {
  readonly schemaVersion: typeof PACKET_PRODUCT_EVENT_ACKNOWLEDGEMENT_SCHEMA_VERSION;
  readonly id: string;
  readonly workspaceId: string;
  readonly credentialId: string;
  readonly packageDeploymentId: string;
  readonly workerDeploymentId: string;
  readonly streamKind: PacketProductEventStreamKind;
  readonly workerRunId?: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly eventId: string;
  readonly workspaceSequence: number;
  readonly effectiveEventId: string;
  readonly effectiveWorkspaceSequence: number;
  readonly expectedRevision: number;
  readonly disposition: "advanced" | "unchanged";
  readonly appliedRevision: number;
  readonly actor: WorkerActorReference & {
    readonly type: "packet_product";
    readonly product: "PacketADE";
  };
  readonly acknowledgedAt: string;
}

export interface PacketProductEventCursorState {
  readonly cursor?: string;
  readonly workspaceSequence: number;
  readonly revision: number;
  readonly etag: string;
}

export function assertValidPacketProductEventAcknowledgementRecord(
  record: PacketProductEventAcknowledgementRecord,
): void {
  if (
    record.schemaVersion !== PACKET_PRODUCT_EVENT_ACKNOWLEDGEMENT_SCHEMA_VERSION ||
    !nonEmpty(record.id) ||
    !nonEmpty(record.workspaceId) ||
    !nonEmpty(record.credentialId) ||
    !nonEmpty(record.packageDeploymentId) ||
    !nonEmpty(record.workerDeploymentId) ||
    !["deployment", "run"].includes(record.streamKind) ||
    (record.streamKind === "run") !== nonEmpty(record.workerRunId) ||
    !nonEmpty(record.idempotencyKey) ||
    !sha256(record.requestDigest) ||
    !nonEmpty(record.eventId) ||
    !positiveInteger(record.workspaceSequence) ||
    !nonEmpty(record.effectiveEventId) ||
    !positiveInteger(record.effectiveWorkspaceSequence) ||
    record.effectiveWorkspaceSequence < record.workspaceSequence ||
    !nonNegativeInteger(record.expectedRevision) ||
    !["advanced", "unchanged"].includes(record.disposition) ||
    !nonNegativeInteger(record.appliedRevision) ||
    (record.disposition === "advanced" &&
      (record.appliedRevision !== record.expectedRevision + 1 ||
        record.effectiveEventId !== record.eventId ||
        record.effectiveWorkspaceSequence !== record.workspaceSequence)) ||
    (record.disposition === "unchanged" && record.appliedRevision !== record.expectedRevision) ||
    record.actor.type !== "packet_product" ||
    record.actor.product !== "PacketADE" ||
    !nonEmpty(record.actor.id) ||
    !timestamp(record.acknowledgedAt)
  ) {
    throw new Error("Packet-product event acknowledgement record is invalid.");
  }
}

function nonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function sha256(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function timestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}
