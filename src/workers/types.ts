export const WORKER_CONTRACT_SCHEMA_VERSION = "packetagent.worker/v1" as const;

export type WorkerContractSchemaVersion = typeof WORKER_CONTRACT_SCHEMA_VERSION;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonArray = readonly JsonValue[];

export interface WorkerActorReference {
  readonly type: "user" | "system" | "packet_product";
  readonly id: string;
  readonly displayName?: string;
  readonly product?: "PacketADE" | "PacketAgent" | "PacketChat" | "PacketCode" | "PacketPhone";
}

export type WorkerSourceProduct =
  | "PacketADE"
  | "PacketAgent"
  | "PacketChat"
  | "PacketCode"
  | "PacketPhone";

export type WorkerSourceKind = "native" | "packetade" | "legacy_agent" | "legacy_workflow";

export interface WorkerSourceProvenance {
  readonly product: WorkerSourceProduct;
  readonly kind: WorkerSourceKind;
  readonly sourceId?: string;
  readonly flightId?: string;
  readonly projectId?: string;
  readonly conversationId?: string;
  readonly repository?: string;
  readonly revision?: string;
}

export type WorkerInputFieldType = "string" | "number" | "boolean" | "url" | "enum";

export interface WorkerInputField {
  readonly key: string;
  readonly label: string;
  readonly type: WorkerInputFieldType;
  readonly required: boolean;
  readonly description?: string;
  readonly options?: readonly string[];
  readonly defaultValue?: JsonPrimitive;
}

export interface WorkerInputSchema {
  readonly fields: readonly WorkerInputField[];
  readonly additionalProperties: boolean;
}

export interface WorkerExecutionTarget {
  readonly kind: "packetagent" | "sandbox" | "external";
  readonly reference?: string;
}

export interface WorkerExecutionProfile {
  readonly routeKey: string;
  readonly providerId?: string;
  readonly model?: string;
  readonly target: WorkerExecutionTarget;
}

export type WorkerCapabilityEffect = "read" | "write" | "execute";
export type WorkerCapabilityApproval = "never" | "always";

export interface WorkerToolCapability {
  readonly id: string;
  readonly tool: string;
  readonly verbs: readonly string[];
  readonly resources: readonly string[];
  readonly effect: WorkerCapabilityEffect;
  readonly approval: WorkerCapabilityApproval;
}

export interface WorkerBudgetPolicy {
  readonly maxElapsedMs: number;
  readonly maxIterations: number;
  readonly maxProviderCostUsd: number;
  readonly maxConsecutiveFailures: number;
  readonly maxToolCalls: number;
}

export interface WorkerRetryPolicy {
  readonly maxAttempts: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly backoffMultiplier: number;
}

export interface WorkerPermissionPolicy {
  readonly default: "deny";
  readonly allowedCapabilityIds: readonly string[];
}

export interface WorkerPolicy {
  readonly budgets: WorkerBudgetPolicy;
  readonly retry: WorkerRetryPolicy;
  readonly permissions: WorkerPermissionPolicy;
}

interface WorkerTriggerBase {
  readonly id: string;
  readonly enabled: boolean;
  readonly description?: string;
}

export interface ManualWorkerTrigger extends WorkerTriggerBase {
  readonly kind: "manual";
}

export interface CronWorkerTrigger extends WorkerTriggerBase {
  readonly kind: "cron";
  readonly expression: string;
  readonly timezone: string;
}

export interface WebhookWorkerTrigger extends WorkerTriggerBase {
  readonly kind: "webhook";
  readonly adapter: "http" | "email";
  readonly eventType: string;
  readonly webhookRef: string;
}

export interface QueueWorkerTrigger extends WorkerTriggerBase {
  readonly kind: "queue";
  readonly queueRef: string;
  readonly eventType: string;
}

export interface AlertWorkerTrigger extends WorkerTriggerBase {
  readonly kind: "alert";
  readonly alertRuleId: string;
}

export type WorkerTrigger =
  | ManualWorkerTrigger
  | CronWorkerTrigger
  | WebhookWorkerTrigger
  | QueueWorkerTrigger
  | AlertWorkerTrigger;

export type WorkerExitPredicate =
  | {
      readonly id: string;
      readonly kind: "objective_satisfied";
      readonly description: string;
    }
  | {
      readonly id: string;
      readonly kind: "output_matches";
      readonly description: string;
      readonly expression: string;
    }
  | {
      readonly id: string;
      readonly kind: "acceptance_checks_pass";
      readonly description: string;
    }
  | {
      readonly id: string;
      readonly kind: "manual_completion";
      readonly description: string;
    };

export interface WorkerNotificationRouteReference {
  readonly id: string;
  readonly kind: "packetagent" | "packetchat" | "packetphone" | "webhook" | "email";
  readonly reference: string;
  readonly events: readonly ("attention" | "terminal")[];
}

export type WorkerDefinitionStatus = "draft" | "active" | "retired";

export interface WorkerDefinition {
  readonly schemaVersion: WorkerContractSchemaVersion;
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly description: string;
  readonly status: WorkerDefinitionStatus;
  readonly currentVersionId?: string;
  readonly createdBy: WorkerActorReference;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkerVersionContent {
  readonly objective: string;
  readonly instructions: string;
  readonly inputSchema: WorkerInputSchema;
  readonly execution: WorkerExecutionProfile;
  readonly tools: readonly WorkerToolCapability[];
  readonly credentialRefs: readonly string[];
  readonly triggers: readonly WorkerTrigger[];
  readonly policy: WorkerPolicy;
  readonly exitPredicates: readonly WorkerExitPredicate[];
  readonly acceptanceCommands: readonly string[];
  readonly notificationRoutes: readonly WorkerNotificationRouteReference[];
}

export type WorkerVersionStatus = "draft" | "validated" | "rejected" | "retired";

export interface WorkerVersion {
  readonly schemaVersion: WorkerContractSchemaVersion;
  readonly id: string;
  readonly workspaceId: string;
  readonly workerDefinitionId: string;
  readonly version: number;
  readonly status: WorkerVersionStatus;
  readonly content: WorkerVersionContent;
  readonly contentDigest: string;
  readonly source: WorkerSourceProvenance;
  readonly createdBy: WorkerActorReference;
  readonly createdAt: string;
  readonly validatedAt?: string;
  readonly rejectedAt?: string;
  readonly retiredAt?: string;
}

export type WorkerDeploymentStatus =
  | "draft"
  | "validated"
  | "deployed"
  | "active"
  | "paused"
  | "attention"
  | "retired"
  | "rejected"
  | "revoked";

export interface WorkerDeployment {
  readonly schemaVersion: WorkerContractSchemaVersion;
  readonly id: string;
  readonly workspaceId: string;
  readonly workerDefinitionId: string;
  readonly workerVersionId: string;
  readonly status: WorkerDeploymentStatus;
  readonly revision: number;
  readonly statusReason?: string;
  readonly createdBy: WorkerActorReference;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly validatedAt?: string;
  readonly deployedAt?: string;
  readonly activatedAt?: string;
  readonly pausedAt?: string;
  readonly attentionAt?: string;
  readonly retiredAt?: string;
  readonly rejectedAt?: string;
  readonly revokedAt?: string;
}

export type WorkerRunStatus =
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "paused"
  | "completed"
  | "failed"
  | "budget_exhausted"
  | "cancelled"
  | "quarantined";

export type WorkerRunTerminalReason =
  | "objective_satisfied"
  | "exit_predicate_matched"
  | "failure_limit"
  | "unhandled_error"
  | "elapsed_time"
  | "iteration_limit"
  | "provider_cost"
  | "tool_call_limit"
  | "operator_cancelled"
  | "deployment_revoked"
  | "lease_lost"
  | "unsafe_replay";

export interface WorkerBudgetUsage {
  readonly elapsedMs: number;
  readonly iterations: number;
  readonly providerCostUsd: number;
  readonly consecutiveFailures: number;
  readonly toolCalls: number;
}

export interface WorkerTraceContext {
  readonly traceId: string;
  readonly spanId?: string;
  readonly traceState?: string;
}

export interface WorkerRuntimeLease {
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly acquiredAt: string;
  readonly renewedAt: string;
  readonly expiresAt: string;
}

export interface WorkerRun {
  readonly schemaVersion: WorkerContractSchemaVersion;
  readonly id: string;
  readonly workspaceId: string;
  readonly workerDefinitionId: string;
  readonly workerVersionId: string;
  readonly workerDeploymentId: string;
  readonly triggerId: string;
  readonly triggerKind: WorkerTrigger["kind"];
  readonly status: WorkerRunStatus;
  readonly attempt: number;
  readonly revision: number;
  readonly runtimeFence: number;
  readonly input?: JsonObject;
  readonly inputReference?: string;
  readonly output?: JsonValue;
  readonly error?: string;
  readonly budgetUsage: WorkerBudgetUsage;
  readonly terminalReason?: WorkerRunTerminalReason;
  readonly latestCheckpointId?: string;
  readonly runtimeLease?: WorkerRuntimeLease;
  readonly trace?: WorkerTraceContext;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export type WorkerSupervisorPhase =
  | "plan"
  | "act"
  | "evaluate"
  | "checkpoint"
  | "decide"
  | "attention";

export interface WorkerCheckpointCursor {
  readonly phase: WorkerSupervisorPhase;
  readonly iteration: number;
  readonly actionIndex: number;
}

export interface WorkerRemainingBudget {
  readonly elapsedMs: number;
  readonly iterations: number;
  readonly providerCostUsd: number;
  readonly consecutiveFailures: number;
  readonly toolCalls: number;
}

export interface WorkerCheckpoint {
  readonly schemaVersion: WorkerContractSchemaVersion;
  readonly id: string;
  readonly workspaceId: string;
  readonly workerRunId: string;
  readonly workerVersionId: string;
  readonly sequence: number;
  readonly previousCheckpointId?: string;
  readonly cursor: WorkerCheckpointCursor;
  readonly workingMemory: JsonObject;
  readonly completedActionIds: readonly string[];
  readonly pendingApprovalIds: readonly string[];
  readonly artifactRefs: readonly string[];
  readonly effectReceiptIds: readonly string[];
  readonly remainingBudget: WorkerRemainingBudget;
  readonly trace?: WorkerTraceContext;
  readonly createdAt: string;
  readonly stateDigest: string;
}

export interface WorkerProjectionWarning {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface WorkerReadModelProjection {
  readonly definition: WorkerDefinition;
  readonly version: WorkerVersion;
  readonly warnings: readonly WorkerProjectionWarning[];
}
