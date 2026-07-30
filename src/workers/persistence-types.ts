import type {
  JsonObject,
  WorkerActorReference,
  WorkerCheckpoint,
  WorkerDefinition,
  WorkerDeployment,
  WorkerRun,
  WorkerTraceContext,
  WorkerVersion,
} from "./types.js";
import type { WorkerEffectReceipt } from "./effect-types.js";
import type {
  WorkerArtifactManifest,
  WorkerEvidenceEntry,
  WorkerEvidencePayloadReference,
  WorkerEvidenceRedactionClassification,
} from "./observability/types.js";

export const WORKER_COMMAND_SCHEMA_VERSION = "packetagent.worker-command/v1" as const;
export const LEGACY_WORKER_EVENT_SCHEMA_VERSION = "packetagent.worker-event/v1" as const;
export const WORKER_EVENT_SCHEMA_VERSION = "packetagent.worker-event/v2" as const;
export const WORKER_ROLLOUT_SCHEMA_VERSION = "packetagent.worker-rollout/v1" as const;

export type WorkerLifecycleOperation =
  | "definition.create"
  | "definition.update"
  | "version.create"
  | "version.update_draft"
  | "version.validate"
  | "version.reject"
  | "deployment.create"
  | "deployment.validate"
  | "deployment.deploy"
  | "deployment.activate"
  | "deployment.pause"
  | "deployment.resume"
  | "deployment.retire"
  | "deployment.update"
  | "deployment.rollback"
  | "definition.retire";

export type WorkerDeploymentRolloutKind = "update" | "rollback";

export interface WorkerDeploymentRollout {
  readonly schemaVersion: typeof WORKER_ROLLOUT_SCHEMA_VERSION;
  readonly id: string;
  readonly workspaceId: string;
  readonly workerDefinitionId: string;
  readonly fromDeploymentId: string;
  readonly toDeploymentId: string;
  readonly kind: WorkerDeploymentRolloutKind;
  readonly createdBy: WorkerActorReference;
  readonly createdAt: string;
}

export interface WorkerLifecycleCommandResponse {
  readonly definition?: WorkerDefinition;
  readonly version?: WorkerVersion;
  readonly deployment?: WorkerDeployment;
  readonly previousDeployment?: WorkerDeployment;
  readonly rollout?: WorkerDeploymentRollout;
}

export interface WorkerLifecycleCommandReceipt {
  readonly schemaVersion: typeof WORKER_COMMAND_SCHEMA_VERSION;
  readonly id: string;
  readonly workspaceId: string;
  readonly idempotencyKey: string;
  readonly operation: WorkerLifecycleOperation;
  readonly targetId?: string;
  readonly requestDigest: string;
  readonly response: WorkerLifecycleCommandResponse;
  readonly actor: WorkerActorReference;
  readonly createdAt: string;
}

export type WorkerEventSource =
  | "lifecycle"
  | "activation"
  | "queue"
  | "supervisor"
  | "provider"
  | "tool"
  | "effect"
  | "approval"
  | "checkpoint"
  | "control"
  | "recovery"
  | "retention"
  | "terminal";

export interface WorkerEventCorrelation {
  readonly activationId?: string;
  readonly activationInboxId?: string;
  readonly executionJobId?: string;
  readonly providerCallId?: string;
  readonly toolCallId?: string;
  readonly effectReceiptId?: string;
  readonly checkpointId?: string;
  readonly attentionRequestId?: string;
  readonly approvalGrantId?: string;
  readonly controlCommandId?: string;
}

interface WorkerEventBase {
  readonly id: string;
  readonly workspaceId: string;
  readonly sequence: number;
  readonly type: string;
  readonly workerDefinitionId: string;
  readonly workerVersionId?: string;
  readonly workerDeploymentId?: string;
  readonly workerRunId?: string;
  readonly actor: WorkerActorReference;
  readonly summary: string;
  readonly data?: JsonObject;
  readonly occurredAt: string;
}

export interface LegacyWorkerEvent extends Omit<WorkerEventBase, "workerRunId"> {
  readonly schemaVersion: typeof LEGACY_WORKER_EVENT_SCHEMA_VERSION;
}

export interface WorkerEventV2 extends WorkerEventBase {
  readonly schemaVersion: typeof WORKER_EVENT_SCHEMA_VERSION;
  readonly source: WorkerEventSource;
  readonly deploymentSequence?: number;
  readonly runSequence?: number;
  readonly trace?: WorkerTraceContext;
  readonly correlation?: WorkerEventCorrelation;
  readonly evidenceId: string;
  readonly dataClassification: WorkerEvidenceRedactionClassification;
  readonly dataDigest: string;
  readonly eventDigest: string;
}

export type WorkerEvent = LegacyWorkerEvent | WorkerEventV2;

export interface WorkerJournalAppendInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly type: string;
  readonly source: WorkerEventSource;
  readonly workerDefinitionId: string;
  readonly workerVersionId?: string;
  readonly workerDeploymentId?: string;
  readonly workerRunId?: string;
  readonly actor: WorkerActorReference;
  readonly summary: string;
  readonly data?: JsonObject;
  readonly trace?: WorkerTraceContext;
  readonly correlation?: WorkerEventCorrelation;
  readonly dataClassification?: WorkerEvidenceRedactionClassification;
  readonly rawPayload?: WorkerEvidencePayloadReference;
  readonly artifactManifestIds?: readonly string[];
  /**
   * Ephemeral values used only to sanitize the journal input. They are never
   * persisted in the event or evidence envelope.
   */
  readonly knownSecretValues?: readonly (string | null | undefined)[];
  readonly occurredAt: string;
}

export interface WorkerPersistenceCollections {
  readonly workerDefinitions: readonly WorkerDefinition[];
  readonly workerVersions: readonly WorkerVersion[];
  readonly workerDeployments: readonly WorkerDeployment[];
  readonly workerRuns: readonly WorkerRun[];
  readonly workerCheckpoints: readonly WorkerCheckpoint[];
  readonly workerEffectReceipts: readonly WorkerEffectReceipt[];
  readonly packetProductCredentials: readonly import("./package/trust-types.js").PacketProductCredentialRecord[];
  readonly workerPackageReceipts: readonly import("./package/trust-types.js").WorkerPackageReceipt[];
  readonly workerPackageDeployments: readonly import("./package/trust-types.js").WorkerPackageDeploymentRecord[];
  readonly packetProductEventAcknowledgements: readonly import("./package/event-types.js").PacketProductEventAcknowledgementRecord[];
  readonly workerBudgetReservations: readonly import("./budget-types.js").WorkerBudgetReservationRecord[];
  readonly workerAttentionRequests: readonly import("./control-types.js").WorkerAttentionRequest[];
  readonly workerApprovalGrants: readonly import("./control-types.js").WorkerApprovalGrant[];
  readonly workerControlCommands: readonly import("./control-types.js").WorkerControlCommand[];
  readonly workerNotificationDeliveries: readonly import("./control-types.js").WorkerNotificationDeliveryReference[];
  readonly workerDeploymentRollouts: readonly WorkerDeploymentRollout[];
  readonly workerCommandReceipts: readonly WorkerLifecycleCommandReceipt[];
  readonly workerEvents: readonly WorkerEvent[];
  readonly workerEvidenceEntries: readonly WorkerEvidenceEntry[];
  readonly workerArtifactManifests: readonly WorkerArtifactManifest[];
}
