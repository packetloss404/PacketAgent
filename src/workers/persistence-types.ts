import type {
  JsonObject,
  WorkerActorReference,
  WorkerCheckpoint,
  WorkerDefinition,
  WorkerDeployment,
  WorkerRun,
  WorkerVersion,
} from "./types.js";
import type { WorkerEffectReceipt } from "./effect-types.js";

export const WORKER_COMMAND_SCHEMA_VERSION = "packetagent.worker-command/v1" as const;
export const WORKER_EVENT_SCHEMA_VERSION = "packetagent.worker-event/v1" as const;
export const WORKER_ROLLOUT_SCHEMA_VERSION = "packetagent.worker-rollout/v1" as const;

export type WorkerLifecycleOperation =
  | "definition.create"
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

export interface WorkerEvent {
  readonly schemaVersion: typeof WORKER_EVENT_SCHEMA_VERSION;
  readonly id: string;
  readonly workspaceId: string;
  readonly sequence: number;
  readonly type: string;
  readonly workerDefinitionId: string;
  readonly workerVersionId?: string;
  readonly workerDeploymentId?: string;
  readonly actor: WorkerActorReference;
  readonly summary: string;
  readonly data?: JsonObject;
  readonly occurredAt: string;
}

export interface WorkerPersistenceCollections {
  readonly workerDefinitions: readonly WorkerDefinition[];
  readonly workerVersions: readonly WorkerVersion[];
  readonly workerDeployments: readonly WorkerDeployment[];
  readonly workerRuns: readonly WorkerRun[];
  readonly workerCheckpoints: readonly WorkerCheckpoint[];
  readonly workerEffectReceipts: readonly WorkerEffectReceipt[];
  readonly workerDeploymentRollouts: readonly WorkerDeploymentRollout[];
  readonly workerCommandReceipts: readonly WorkerLifecycleCommandReceipt[];
  readonly workerEvents: readonly WorkerEvent[];
}
