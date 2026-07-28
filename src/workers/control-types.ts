import type {
  WorkerActorReference,
  WorkerAttentionExpirationDisposition,
  WorkerNotificationRouteReference,
} from "./types.js";

export const WORKER_ATTENTION_REQUEST_SCHEMA_VERSION =
  "packetagent.worker-attention-request/v1" as const;
export const WORKER_APPROVAL_GRANT_SCHEMA_VERSION = "packetagent.worker-approval-grant/v1" as const;
export const WORKER_CONTROL_COMMAND_SCHEMA_VERSION =
  "packetagent.worker-control-command/v1" as const;
export const WORKER_NOTIFICATION_DELIVERY_SCHEMA_VERSION =
  "packetagent.worker-notification-delivery/v1" as const;

export interface WorkerControlRunBinding {
  readonly workspaceId: string;
  readonly workerDefinitionId: string;
  readonly workerDeploymentId: string;
  readonly workerRunId: string;
  readonly workerVersionId: string;
  readonly workerVersionContentDigest: string;
}

export type WorkerAttentionRequestStatus =
  | "open"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled";

export interface WorkerAttentionRequest extends WorkerControlRunBinding {
  readonly schemaVersion: typeof WORKER_ATTENTION_REQUEST_SCHEMA_VERSION;
  readonly id: string;
  readonly requestKey: string;
  readonly status: WorkerAttentionRequestStatus;
  readonly capabilityId: string;
  readonly operationDigest: string;
  readonly policyDigest: string;
  readonly expirationDisposition: WorkerAttentionExpirationDisposition;
  readonly requestedBy: WorkerActorReference;
  readonly requestedAt: string;
  readonly escalatesAt?: string;
  readonly expiresAt: string;
  readonly notificationRouteIds: readonly string[];
  readonly resolvedAt?: string;
  readonly resolvedBy?: WorkerActorReference;
  readonly resolutionCommandId?: string;
}

export type WorkerApprovalScope = "once" | "run";
export type WorkerApprovalGrantStatus = "active" | "consumed" | "revoked" | "expired";

export interface WorkerApprovalGrant extends WorkerControlRunBinding {
  readonly schemaVersion: typeof WORKER_APPROVAL_GRANT_SCHEMA_VERSION;
  readonly id: string;
  readonly attentionRequestId: string;
  readonly capabilityId: string;
  readonly operationDigest: string;
  readonly policyDigest: string;
  readonly scope: WorkerApprovalScope;
  readonly status: WorkerApprovalGrantStatus;
  readonly nonceDigest: string;
  readonly grantedBy: WorkerActorReference;
  readonly grantedAt: string;
  readonly expiresAt: string;
  readonly consumedAt?: string;
  readonly consumedByActionId?: string;
  readonly revokedAt?: string;
  readonly revokedBy?: WorkerActorReference;
  readonly expiredAt?: string;
}

export type WorkerControlCommandKind =
  | "pause_run"
  | "resume_run"
  | "stop_run"
  | "revoke_deployment"
  | "approve_once"
  | "approve_for_run"
  | "reject_attention";

export type WorkerControlCommandStatus = "pending" | "applied" | "rejected";

export interface WorkerControlCommand {
  readonly schemaVersion: typeof WORKER_CONTROL_COMMAND_SCHEMA_VERSION;
  readonly id: string;
  readonly workspaceId: string;
  readonly workerDefinitionId: string;
  readonly workerDeploymentId: string;
  readonly workerVersionId: string;
  readonly workerVersionContentDigest: string;
  readonly workerRunId?: string;
  readonly attentionRequestId?: string;
  readonly capabilityId?: string;
  readonly operationDigest?: string;
  readonly kind: WorkerControlCommandKind;
  readonly status: WorkerControlCommandStatus;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly actor: WorkerActorReference;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly appliedAt?: string;
  readonly appliedRevision?: number;
  readonly approvalGrantId?: string;
  readonly rejectedAt?: string;
  readonly rejectionCode?: string;
}

export type WorkerNotificationDeliveryStatus =
  | "queued"
  | "sending"
  | "delivered"
  | "failed"
  | "dead_letter";

export interface WorkerNotificationDeliveryReference extends WorkerControlRunBinding {
  readonly schemaVersion: typeof WORKER_NOTIFICATION_DELIVERY_SCHEMA_VERSION;
  readonly id: string;
  readonly deliveryKey: string;
  readonly event: "attention" | "terminal";
  readonly attentionRequestId?: string;
  readonly controlCommandId?: string;
  readonly notificationRouteId: string;
  readonly notificationRouteKind: WorkerNotificationRouteReference["kind"];
  readonly notificationRouteReference: string;
  readonly status: WorkerNotificationDeliveryStatus;
  readonly attemptCount: number;
  readonly scheduledAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deliveredAt?: string;
  readonly deliveryReference?: string;
  readonly lastFailureCode?: string;
}

export function assertValidWorkerAttentionRequest(record: WorkerAttentionRequest): void {
  assertRunBinding(record, "Worker attention request");
  assertBaseRecord(
    record.schemaVersion === WORKER_ATTENTION_REQUEST_SCHEMA_VERSION,
    record.id,
    "Worker attention request",
  );
  if (
    !isNonEmpty(record.requestKey) ||
    !["open", "approved", "rejected", "expired", "cancelled"].includes(record.status) ||
    !isNonEmpty(record.capabilityId) ||
    !isDigest(record.operationDigest) ||
    !isDigest(record.policyDigest) ||
    !["pause", "reject"].includes(record.expirationDisposition) ||
    !isActor(record.requestedBy) ||
    !isTimestamp(record.requestedAt) ||
    !isTimestamp(record.expiresAt) ||
    Date.parse(record.expiresAt) <= Date.parse(record.requestedAt) ||
    !isUniqueNonEmptyStrings(record.notificationRouteIds) ||
    (record.escalatesAt !== undefined &&
      (!isTimestamp(record.escalatesAt) ||
        Date.parse(record.escalatesAt) <= Date.parse(record.requestedAt) ||
        Date.parse(record.escalatesAt) > Date.parse(record.expiresAt)))
  ) {
    throw new Error("Worker attention request is invalid.");
  }
  if (
    record.status === "open" &&
    (record.resolvedAt !== undefined ||
      record.resolvedBy !== undefined ||
      record.resolutionCommandId !== undefined)
  ) {
    throw new Error("Worker attention request resolution fields do not match its status.");
  }
  if (
    record.status !== "open" &&
    (!isTimestamp(record.resolvedAt) ||
      Date.parse(record.resolvedAt) < Date.parse(record.requestedAt) ||
      !isActor(record.resolvedBy) ||
      (["approved", "rejected"].includes(record.status) &&
        !isNonEmpty(record.resolutionCommandId)) ||
      (["expired", "cancelled"].includes(record.status) &&
        record.resolutionCommandId !== undefined))
  ) {
    throw new Error("Worker attention request resolution fields do not match its status.");
  }
}

export function assertValidWorkerApprovalGrant(record: WorkerApprovalGrant): void {
  assertRunBinding(record, "Worker approval grant");
  assertBaseRecord(
    record.schemaVersion === WORKER_APPROVAL_GRANT_SCHEMA_VERSION,
    record.id,
    "Worker approval grant",
  );
  if (
    !isNonEmpty(record.attentionRequestId) ||
    !isNonEmpty(record.capabilityId) ||
    !isDigest(record.operationDigest) ||
    !isDigest(record.policyDigest) ||
    !["once", "run"].includes(record.scope) ||
    !["active", "consumed", "revoked", "expired"].includes(record.status) ||
    !isDigest(record.nonceDigest) ||
    !isActor(record.grantedBy) ||
    !isTimestamp(record.grantedAt) ||
    !isTimestamp(record.expiresAt) ||
    Date.parse(record.expiresAt) <= Date.parse(record.grantedAt)
  ) {
    throw new Error("Worker approval grant is invalid.");
  }
  if (
    record.status === "active" &&
    (record.consumedAt !== undefined ||
      record.consumedByActionId !== undefined ||
      record.revokedAt !== undefined ||
      record.revokedBy !== undefined ||
      record.expiredAt !== undefined)
  ) {
    throw new Error("Active Worker approval grant cannot contain terminal fields.");
  }
  if (
    record.status === "consumed" &&
    (record.scope !== "once" ||
      !isTimestamp(record.consumedAt) ||
      Date.parse(record.consumedAt) < Date.parse(record.grantedAt) ||
      !isNonEmpty(record.consumedByActionId) ||
      record.revokedAt !== undefined ||
      record.revokedBy !== undefined ||
      record.expiredAt !== undefined)
  ) {
    throw new Error("Consumed Worker approval grant requires one-time consumption fields.");
  }
  if (
    record.status === "revoked" &&
    (!isTimestamp(record.revokedAt) ||
      Date.parse(record.revokedAt) < Date.parse(record.grantedAt) ||
      !isActor(record.revokedBy) ||
      record.consumedAt !== undefined ||
      record.consumedByActionId !== undefined ||
      record.expiredAt !== undefined)
  ) {
    throw new Error("Revoked Worker approval grant requires revocation fields.");
  }
  if (
    record.status === "expired" &&
    (!isTimestamp(record.expiredAt) ||
      Date.parse(record.expiredAt) < Date.parse(record.expiresAt) ||
      record.consumedAt !== undefined ||
      record.consumedByActionId !== undefined ||
      record.revokedAt !== undefined ||
      record.revokedBy !== undefined)
  ) {
    throw new Error("Expired Worker approval grant requires a valid expiration timestamp.");
  }
}

export function assertValidWorkerControlCommand(record: WorkerControlCommand): void {
  assertBaseRecord(
    record.schemaVersion === WORKER_CONTROL_COMMAND_SCHEMA_VERSION,
    record.id,
    "Worker control command",
  );
  if (
    !isNonEmpty(record.workspaceId) ||
    !isNonEmpty(record.workerDefinitionId) ||
    !isNonEmpty(record.workerDeploymentId) ||
    !isNonEmpty(record.workerVersionId) ||
    !isDigest(record.workerVersionContentDigest) ||
    ![
      "pause_run",
      "resume_run",
      "stop_run",
      "revoke_deployment",
      "approve_once",
      "approve_for_run",
      "reject_attention",
    ].includes(record.kind) ||
    !["pending", "applied", "rejected"].includes(record.status) ||
    !Number.isSafeInteger(record.expectedRevision) ||
    record.expectedRevision < 1 ||
    !isNonEmpty(record.idempotencyKey) ||
    !isDigest(record.requestDigest) ||
    !isActor(record.actor) ||
    !isTimestamp(record.createdAt) ||
    !isTimestamp(record.updatedAt) ||
    Date.parse(record.updatedAt) < Date.parse(record.createdAt)
  ) {
    throw new Error("Worker control command is invalid.");
  }
  const runCommand = ["pause_run", "resume_run", "stop_run"].includes(record.kind);
  const attentionCommand = ["approve_once", "approve_for_run", "reject_attention"].includes(
    record.kind,
  );
  if (
    (runCommand &&
      (!isNonEmpty(record.workerRunId) ||
        record.attentionRequestId !== undefined ||
        record.capabilityId !== undefined ||
        record.operationDigest !== undefined)) ||
    (record.kind === "revoke_deployment" &&
      (record.workerRunId !== undefined ||
        record.attentionRequestId !== undefined ||
        record.capabilityId !== undefined ||
        record.operationDigest !== undefined)) ||
    (attentionCommand &&
      (!isNonEmpty(record.workerRunId) ||
        !isNonEmpty(record.attentionRequestId) ||
        !isNonEmpty(record.capabilityId) ||
        !isDigest(record.operationDigest)))
  ) {
    throw new Error("Worker control command target does not match its kind.");
  }
  if (
    record.status === "pending" &&
    (record.appliedAt !== undefined ||
      record.appliedRevision !== undefined ||
      record.approvalGrantId !== undefined ||
      record.rejectedAt !== undefined ||
      record.rejectionCode !== undefined)
  ) {
    throw new Error("Pending Worker control command cannot contain terminal fields.");
  }
  if (
    record.status === "applied" &&
    (!isTimestamp(record.appliedAt) ||
      Date.parse(record.appliedAt) < Date.parse(record.createdAt) ||
      !Number.isSafeInteger(record.appliedRevision) ||
      record.appliedRevision! < record.expectedRevision ||
      record.rejectedAt !== undefined ||
      record.rejectionCode !== undefined ||
      (["approve_once", "approve_for_run"].includes(record.kind) &&
        !isNonEmpty(record.approvalGrantId)) ||
      (!["approve_once", "approve_for_run"].includes(record.kind) &&
        record.approvalGrantId !== undefined))
  ) {
    throw new Error("Applied Worker control command requires application fields.");
  }
  if (
    record.status === "rejected" &&
    (!isTimestamp(record.rejectedAt) ||
      Date.parse(record.rejectedAt) < Date.parse(record.createdAt) ||
      !isNonEmpty(record.rejectionCode) ||
      record.appliedAt !== undefined ||
      record.appliedRevision !== undefined ||
      record.approvalGrantId !== undefined)
  ) {
    throw new Error("Rejected Worker control command requires rejection fields.");
  }
}

export function assertValidWorkerNotificationDeliveryReference(
  record: WorkerNotificationDeliveryReference,
): void {
  assertRunBinding(record, "Worker notification delivery");
  assertBaseRecord(
    record.schemaVersion === WORKER_NOTIFICATION_DELIVERY_SCHEMA_VERSION,
    record.id,
    "Worker notification delivery",
  );
  if (
    !isNonEmpty(record.deliveryKey) ||
    !["attention", "terminal"].includes(record.event) ||
    (record.event === "attention" && !isNonEmpty(record.attentionRequestId)) ||
    !isNonEmpty(record.notificationRouteId) ||
    !["packetagent", "packetchat", "packetphone", "webhook", "email"].includes(
      record.notificationRouteKind,
    ) ||
    !isNonEmpty(record.notificationRouteReference) ||
    !["queued", "sending", "delivered", "failed", "dead_letter"].includes(record.status) ||
    !Number.isSafeInteger(record.attemptCount) ||
    record.attemptCount < 0 ||
    !isTimestamp(record.scheduledAt) ||
    !isTimestamp(record.createdAt) ||
    !isTimestamp(record.updatedAt) ||
    Date.parse(record.updatedAt) < Date.parse(record.createdAt)
  ) {
    throw new Error("Worker notification delivery reference is invalid.");
  }
  if (
    record.status === "delivered" &&
    (!isTimestamp(record.deliveredAt) ||
      Date.parse(record.deliveredAt) < Date.parse(record.createdAt) ||
      !isNonEmpty(record.deliveryReference) ||
      record.lastFailureCode !== undefined)
  ) {
    throw new Error("Delivered Worker notification requires a delivery reference.");
  }
  if (
    record.status !== "delivered" &&
    (record.deliveredAt !== undefined || record.deliveryReference !== undefined)
  ) {
    throw new Error("Undelivered Worker notification cannot contain delivery fields.");
  }
  if (
    ["failed", "dead_letter"].includes(record.status) &&
    (!isNonEmpty(record.lastFailureCode) || record.attemptCount < 1)
  ) {
    throw new Error("Failed Worker notification requires a failure.");
  }
}

function assertRunBinding(record: WorkerControlRunBinding, label: string): void {
  if (
    !isNonEmpty(record.workspaceId) ||
    !isNonEmpty(record.workerDefinitionId) ||
    !isNonEmpty(record.workerDeploymentId) ||
    !isNonEmpty(record.workerRunId) ||
    !isNonEmpty(record.workerVersionId) ||
    !isDigest(record.workerVersionContentDigest)
  ) {
    throw new Error(`${label} has an invalid Worker binding.`);
  }
}

function assertBaseRecord(schemaMatches: boolean, id: string, label: string): void {
  if (!schemaMatches || !isNonEmpty(id)) throw new Error(`${label} is invalid.`);
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isActor(value: unknown): value is WorkerActorReference {
  if (!value || typeof value !== "object") return false;
  const actor = value as Partial<WorkerActorReference>;
  return ["user", "system", "packet_product"].includes(actor.type ?? "") && isNonEmpty(actor.id);
}

function isUniqueNonEmptyStrings(values: readonly string[]): boolean {
  return (
    Array.isArray(values) && values.every(isNonEmpty) && new Set(values).size === values.length
  );
}
