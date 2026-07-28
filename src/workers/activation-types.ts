import type {
  JsonObject,
  WorkerActorReference,
  WorkerTraceContext,
  WorkerTrigger,
} from "./types.js";

export const WORKER_ACTIVATION_SCHEMA_VERSION = "packetagent.worker-activation/v1" as const;
export const WORKER_ACTIVATION_INBOX_SCHEMA_VERSION =
  "packetagent.worker-activation-inbox/v1" as const;
export const WORKER_ACTIVATION_PAYLOAD_SCHEMA_VERSION =
  "packetagent.worker-activation-payload/v1" as const;

export type WorkerActivationSource = "manual" | "cron" | "webhook" | "alert" | "queue";

export type WorkerActivationPayloadClassification = "large" | "sensitive" | "large_and_sensitive";

export interface WorkerActivationPayloadReference {
  readonly reference: string;
  readonly digest: string;
  readonly byteLength: number;
  readonly classification: WorkerActivationPayloadClassification;
  readonly encrypted: true;
  readonly expiresAt: string;
}

export interface WorkerActivationInlineRetention {
  readonly mode: "inline";
  readonly policy: "worker_run_lifetime";
}

export interface WorkerActivationReferenceRetention {
  readonly mode: "encrypted_reference";
  readonly policy: "expire_at";
  readonly expiresAt: string;
}

export type WorkerActivationPayloadRetention =
  | WorkerActivationInlineRetention
  | WorkerActivationReferenceRetention;

export interface WorkerActivationEnvelope {
  readonly schemaVersion: typeof WORKER_ACTIVATION_SCHEMA_VERSION;
  readonly id: string;
  readonly source: WorkerActivationSource;
  readonly deliveryId: string;
  readonly occurredAt: string;
  readonly receivedAt: string;
  readonly actor: WorkerActorReference;
  readonly workspaceId: string;
  readonly workerDeploymentId: string;
  readonly workerVersionId: string;
  readonly triggerId: string;
  readonly triggerKind: WorkerTrigger["kind"];
  readonly payload?: JsonObject;
  readonly payloadReference?: WorkerActivationPayloadReference;
  readonly payloadRetention: WorkerActivationPayloadRetention;
  readonly trace: WorkerTraceContext;
}

export type WorkerActivationInboxDisposition = "accepted";

export interface WorkerActivationInboxRecord {
  readonly schemaVersion: typeof WORKER_ACTIVATION_INBOX_SCHEMA_VERSION;
  readonly id: string;
  readonly workspaceId: string;
  readonly workerDeploymentId: string;
  readonly workerVersionId: string;
  readonly triggerId: string;
  readonly source: WorkerActivationSource;
  readonly deliveryId: string;
  readonly requestDigest: string;
  readonly disposition: WorkerActivationInboxDisposition;
  readonly workerRunId: string;
  readonly executionJobId: string;
  readonly envelope: WorkerActivationEnvelope;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly duplicateCount: number;
}

export interface WorkerActivationPayloadRecord {
  readonly schemaVersion: typeof WORKER_ACTIVATION_PAYLOAD_SCHEMA_VERSION;
  readonly id: string;
  readonly reference: string;
  readonly workspaceId: string;
  readonly digest: string;
  readonly byteLength: number;
  readonly classification: WorkerActivationPayloadClassification;
  readonly ciphertext: string;
  readonly iv: string;
  readonly authTag: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface WorkerActivationPayloadMetadata extends Omit<
  WorkerActivationPayloadRecord,
  "ciphertext" | "iv" | "authTag"
> {
  readonly encrypted: true;
}

export interface WorkerActivationAdmissionResult {
  readonly disposition: "accepted" | "duplicate";
  readonly inbox: WorkerActivationInboxRecord;
  readonly runId: string;
  readonly executionJobId: string;
}

export function workerActivationDeliveryKey(
  input: Pick<
    WorkerActivationInboxRecord,
    "workspaceId" | "workerDeploymentId" | "triggerId" | "source" | "deliveryId"
  >,
): string {
  return [
    input.workspaceId,
    input.workerDeploymentId,
    input.triggerId,
    input.source,
    input.deliveryId,
  ].join("\u001f");
}
