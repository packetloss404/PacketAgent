import type {
  JsonObject,
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
export const WORKER_NOTIFICATION_ENVELOPE_SCHEMA_VERSION =
  "packetagent.worker-notification-envelope/v1" as const;
export const WORKER_NOTIFICATION_OUTBOX_SCHEMA_VERSION =
  "packetagent.worker-notification-outbox/v1" as const;

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

export type WorkerRemoteControlRole = "viewer" | "member" | "admin" | "owner";

export interface WorkerRemoteControlAuthorization {
  readonly source: "packetphone";
  readonly audience: "PacketPhone";
  readonly actorRole: WorkerRemoteControlRole;
  readonly tokenIdDigest: string;
  readonly nonceDigest: string;
}

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
  readonly remoteControl?: WorkerRemoteControlAuthorization;
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
  | "dead_letter"
  | "expired";

export type WorkerNotificationEvent = "attention" | "progress" | "terminal";

export interface LegacyWorkerNotificationDeliveryReference extends WorkerControlRunBinding {
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

export interface WorkerNotificationEnvelope extends WorkerControlRunBinding {
  readonly schemaVersion: typeof WORKER_NOTIFICATION_ENVELOPE_SCHEMA_VERSION;
  readonly id: string;
  readonly specversion: "1.0";
  readonly source: string;
  readonly type:
    | "com.packetagent.worker.attention.v1"
    | "com.packetagent.worker.progress.v1"
    | "com.packetagent.worker.terminal.v1";
  readonly subject: string;
  readonly time: string;
  readonly event: WorkerNotificationEvent;
  readonly sourceEventId: string;
  readonly sourceEventDigest: string;
  readonly evidenceId: string;
  readonly threadKey: string;
  readonly title: string;
  readonly summary: string;
  readonly data: JsonObject;
}

export interface WorkerNotificationDeliveryMetadata {
  readonly provider: string;
  readonly responseCode?: number;
  readonly latencyMs?: number;
}

export interface WorkerNotificationOutboxItem extends WorkerControlRunBinding {
  readonly schemaVersion: typeof WORKER_NOTIFICATION_OUTBOX_SCHEMA_VERSION;
  readonly id: string;
  readonly deliveryKey: string;
  readonly idempotencyKey: string;
  readonly event: WorkerNotificationEvent;
  readonly attentionRequestId?: string;
  readonly controlCommandId?: string;
  readonly sourceEventId: string;
  readonly sourceEventDigest: string;
  readonly notificationRouteId: string;
  readonly notificationRouteKind: WorkerNotificationRouteReference["kind"];
  readonly notificationRouteReference: string;
  readonly envelope: WorkerNotificationEnvelope;
  readonly status: WorkerNotificationDeliveryStatus;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly scheduledAt: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastAttemptAt?: string;
  readonly deliveredAt?: string;
  readonly deliveryReference?: string;
  readonly deliveryMetadata?: WorkerNotificationDeliveryMetadata;
  readonly lastFailureCode?: string;
}

export type WorkerNotificationDeliveryReference =
  | LegacyWorkerNotificationDeliveryReference
  | WorkerNotificationOutboxItem;

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
    !isValidRemoteAuthorization(record.remoteControl, record.actor) ||
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
  if (record.schemaVersion === WORKER_NOTIFICATION_OUTBOX_SCHEMA_VERSION) {
    assertValidWorkerNotificationOutboxItem(record);
    return;
  }
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

export function assertValidWorkerNotificationEnvelope(record: WorkerNotificationEnvelope): void {
  assertRunBinding(record, "Worker notification envelope");
  assertBaseRecord(
    record.schemaVersion === WORKER_NOTIFICATION_ENVELOPE_SCHEMA_VERSION,
    record.id,
    "Worker notification envelope",
  );
  const expectedType = {
    attention: "com.packetagent.worker.attention.v1",
    progress: "com.packetagent.worker.progress.v1",
    terminal: "com.packetagent.worker.terminal.v1",
  }[record.event];
  if (
    record.specversion !== "1.0" ||
    !isSafeSource(record.source) ||
    record.type !== expectedType ||
    !isNonEmpty(record.subject) ||
    !isTimestamp(record.time) ||
    !isNonEmpty(record.sourceEventId) ||
    !isDigest(record.sourceEventDigest) ||
    !isNonEmpty(record.evidenceId) ||
    !isNonEmpty(record.threadKey) ||
    !isBoundedText(record.title, 240) ||
    !isBoundedText(record.summary, 2_000) ||
    !isJsonObject(record.data)
  ) {
    throw new Error("Worker notification envelope is invalid.");
  }
}

export function assertValidWorkerNotificationOutboxItem(
  record: WorkerNotificationOutboxItem,
): void {
  assertRunBinding(record, "Worker notification outbox item");
  assertBaseRecord(
    record.schemaVersion === WORKER_NOTIFICATION_OUTBOX_SCHEMA_VERSION,
    record.id,
    "Worker notification outbox item",
  );
  assertValidWorkerNotificationEnvelope(record.envelope);
  if (
    !isNonEmpty(record.deliveryKey) ||
    !isNonEmpty(record.idempotencyKey) ||
    !["attention", "progress", "terminal"].includes(record.event) ||
    (record.event === "attention" && !isNonEmpty(record.attentionRequestId)) ||
    !isNonEmpty(record.sourceEventId) ||
    !isDigest(record.sourceEventDigest) ||
    !isNonEmpty(record.notificationRouteId) ||
    !["packetagent", "packetchat", "packetphone", "webhook", "email"].includes(
      record.notificationRouteKind,
    ) ||
    !isSafeRouteReference(record.notificationRouteReference) ||
    !["queued", "sending", "delivered", "failed", "dead_letter", "expired"].includes(
      record.status,
    ) ||
    !Number.isSafeInteger(record.attemptCount) ||
    record.attemptCount < 0 ||
    !Number.isSafeInteger(record.maxAttempts) ||
    record.maxAttempts < 1 ||
    record.attemptCount > record.maxAttempts ||
    !isTimestamp(record.scheduledAt) ||
    !isTimestamp(record.expiresAt) ||
    !isTimestamp(record.createdAt) ||
    !isTimestamp(record.updatedAt) ||
    Date.parse(record.expiresAt) <= Date.parse(record.createdAt) ||
    Date.parse(record.updatedAt) < Date.parse(record.createdAt) ||
    record.sourceEventId !== record.envelope.sourceEventId ||
    record.sourceEventDigest !== record.envelope.sourceEventDigest ||
    record.event !== record.envelope.event ||
    !hasSameRunBinding(record, record.envelope)
  ) {
    throw new Error("Worker notification outbox item is invalid.");
  }
  const attempted = record.attemptCount > 0;
  if (
    attempted !== (record.lastAttemptAt !== undefined) ||
    (record.lastAttemptAt !== undefined &&
      (!isTimestamp(record.lastAttemptAt) ||
        Date.parse(record.lastAttemptAt) < Date.parse(record.createdAt)))
  ) {
    throw new Error("Worker notification outbox attempt state is invalid.");
  }
  if (
    record.status === "queued" &&
    (record.attemptCount !== 0 ||
      record.deliveredAt !== undefined ||
      record.deliveryReference !== undefined ||
      record.deliveryMetadata !== undefined ||
      record.lastFailureCode !== undefined)
  ) {
    throw new Error("Queued Worker notification outbox item has terminal delivery fields.");
  }
  if (
    record.status === "sending" &&
    (!attempted ||
      record.deliveredAt !== undefined ||
      record.deliveryReference !== undefined ||
      record.deliveryMetadata !== undefined)
  ) {
    throw new Error("Sending Worker notification outbox item has invalid delivery state.");
  }
  if (
    record.status === "delivered" &&
    (!isTimestamp(record.deliveredAt) ||
      Date.parse(record.deliveredAt) < Date.parse(record.createdAt) ||
      !isNonEmpty(record.deliveryReference) ||
      !isValidDeliveryMetadata(record.deliveryMetadata) ||
      record.lastFailureCode !== undefined)
  ) {
    throw new Error("Delivered Worker notification outbox item requires delivery evidence.");
  }
  if (
    record.status !== "delivered" &&
    (record.deliveredAt !== undefined ||
      record.deliveryReference !== undefined ||
      record.deliveryMetadata !== undefined)
  ) {
    throw new Error(
      "Undelivered Worker notification outbox item cannot contain delivery evidence.",
    );
  }
  if (
    ["failed", "dead_letter"].includes(record.status) &&
    (!isNonEmpty(record.lastFailureCode) || !attempted)
  ) {
    throw new Error("Failed Worker notification outbox item requires a bounded failure.");
  }
  if (
    record.status === "expired" &&
    (record.lastFailureCode !== "expired" ||
      Date.parse(record.updatedAt) < Date.parse(record.expiresAt))
  ) {
    throw new Error("Expired Worker notification outbox item requires expiry evidence.");
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

function isBoundedText(value: unknown, maximumLength: number): value is string {
  return isNonEmpty(value) && value.length <= maximumLength;
}

function isSafeSource(value: unknown): value is string {
  return (
    isBoundedText(value, 512) &&
    (value.startsWith("urn:packetagent:") || value.startsWith("/packetagent/"))
  );
}

function isSafeRouteReference(value: unknown): value is string {
  return (
    isBoundedText(value, 512) &&
    !value.includes("://") &&
    !/[?&](?:token|access_token|api[_-]?key|secret)=/i.test(value) &&
    !/\b(?:bearer|authorization|password|secret)\b/i.test(value)
  );
}

function hasSameRunBinding(left: WorkerControlRunBinding, right: WorkerControlRunBinding): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.workerDefinitionId === right.workerDefinitionId &&
    left.workerDeploymentId === right.workerDeploymentId &&
    left.workerRunId === right.workerRunId &&
    left.workerVersionId === right.workerVersionId &&
    left.workerVersionContentDigest === right.workerVersionContentDigest
  );
}

function isValidDeliveryMetadata(value: WorkerNotificationDeliveryMetadata | undefined): boolean {
  return (
    value !== undefined &&
    isBoundedText(value.provider, 100) &&
    (value.responseCode === undefined ||
      (Number.isSafeInteger(value.responseCode) &&
        value.responseCode >= 100 &&
        value.responseCode <= 599)) &&
    (value.latencyMs === undefined ||
      (Number.isSafeInteger(value.latencyMs) && value.latencyMs >= 0))
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return isJsonValue(value, 0) && !Array.isArray(value) && value !== null;
}

function isJsonValue(value: unknown, depth: number): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, depth + 1));
  if (!value || typeof value !== "object") return false;
  return Object.values(value).every(
    (entry) => entry !== undefined && isJsonValue(entry, depth + 1),
  );
}

function isActor(value: unknown): value is WorkerActorReference {
  if (!value || typeof value !== "object") return false;
  const actor = value as Partial<WorkerActorReference>;
  return ["user", "system", "packet_product"].includes(actor.type ?? "") && isNonEmpty(actor.id);
}

function isValidRemoteAuthorization(
  value: WorkerRemoteControlAuthorization | undefined,
  actor: WorkerActorReference,
): boolean {
  if (value === undefined) return true;
  return (
    value.source === "packetphone" &&
    value.audience === "PacketPhone" &&
    ["viewer", "member", "admin", "owner"].includes(value.actorRole) &&
    isDigest(value.tokenIdDigest) &&
    isDigest(value.nonceDigest) &&
    actor.type === "packet_product" &&
    actor.product === "PacketPhone"
  );
}

function isUniqueNonEmptyStrings(values: readonly string[]): boolean {
  return (
    Array.isArray(values) && values.every(isNonEmpty) && new Set(values).size === values.length
  );
}
