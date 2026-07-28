import type { ToolPolicyDecision } from "../../tools/types.js";
import type {
  JsonObject,
  JsonValue,
  WorkerActorReference,
  WorkerBudgetPolicy,
  WorkerBudgetUsage,
  WorkerCheckpoint,
  WorkerCheckpointCursor,
  WorkerCompiledCapability,
  WorkerCompiledPolicy,
  WorkerDefinition,
  WorkerDeployment,
  WorkerExitPredicate,
  WorkerRun,
  WorkerRunTerminalReason,
  WorkerSupervisorPhase,
  WorkerVersion,
} from "../types.js";

export interface WorkerRuntimeContext {
  readonly definition: WorkerDefinition;
  readonly version: WorkerVersion;
  readonly deployment: WorkerDeployment;
  readonly run: WorkerRun;
  readonly input: JsonObject;
  readonly checkpoint?: WorkerCheckpoint;
}

export interface WorkerRuntimeToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface WorkerRuntimeToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: JsonObject;
}

export interface WorkerRuntimeProviderUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly costUsd: number;
}

export interface WorkerRuntimeProviderResult {
  readonly content: string;
  readonly toolCalls: readonly WorkerRuntimeToolCall[];
  readonly finishReason: "stop" | "tool_use" | "length" | "error";
  readonly usage: WorkerRuntimeProviderUsage;
  readonly model: string;
  readonly provider: string;
}

export interface WorkerRuntimeProviderRequest {
  readonly workspaceId: string;
  readonly workerRunId: string;
  readonly routeKey: string;
  readonly providerId?: string;
  readonly model?: string;
  readonly phase: "plan" | "evaluate";
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly tools: readonly WorkerRuntimeToolDefinition[];
  readonly signal: AbortSignal;
}

export interface WorkerProviderPort {
  call(request: WorkerRuntimeProviderRequest): Promise<WorkerRuntimeProviderResult>;
}

export interface WorkerRuntimeToolResult {
  readonly callId: string;
  readonly toolName: string;
  readonly status: "ok" | "error" | "timeout";
  readonly output?: JsonValue;
  readonly error?: string;
  readonly artifactRefs?: readonly string[];
  readonly effectReceiptId?: string;
  readonly durationMs: number;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface WorkerToolPort {
  definitions(
    capabilities: readonly WorkerCompiledCapability[],
  ): readonly WorkerRuntimeToolDefinition[];
  execute(input: {
    readonly workspaceId: string;
    readonly workerDefinitionId: string;
    readonly workerRunId: string;
    readonly workerVersionId: string;
    readonly workerVersionContentDigest: string;
    readonly workerDeploymentId: string;
    readonly workerDeploymentRevision: number;
    readonly compiledPolicy?: WorkerCompiledPolicy;
    readonly budgetUsage: WorkerBudgetUsage;
    readonly actor: WorkerActorReference;
    readonly iteration: number;
    readonly fencingToken: number;
    readonly call: WorkerRuntimeToolCall;
    readonly recordPolicyDecision: (decision: ToolPolicyDecision) => Promise<void>;
    readonly signal: AbortSignal;
  }): Promise<WorkerRuntimeToolResult>;
}

export interface WorkerClockPort {
  now(): Date;
  monotonicMs(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export interface WorkerCheckpointWrite {
  readonly workspaceId: string;
  readonly workerRunId: string;
  readonly workerVersionId: string;
  readonly expectedRunRevision: number;
  readonly expectedCheckpointSequence: number;
  readonly fencingToken: number;
  readonly cursor: WorkerCheckpointCursor;
  readonly budgetUsage: WorkerBudgetUsage;
  readonly workingMemory: JsonObject;
  readonly completedActionIds: readonly string[];
  readonly pendingApprovalIds: readonly string[];
  readonly artifactRefs: readonly string[];
  readonly effectReceiptIds: readonly string[];
}

export interface WorkerCheckpointWriteResult {
  readonly checkpointId: string;
  readonly checkpointSequence: number;
  readonly runRevision: number;
}

export interface WorkerCheckpointPort {
  save(write: WorkerCheckpointWrite): Promise<WorkerCheckpointWriteResult>;
}

export interface WorkerRuntimeEvent {
  readonly type: string;
  readonly phase: WorkerSupervisorPhase;
  readonly cursor: WorkerCheckpointCursor;
  readonly summary: string;
  readonly data?: JsonObject;
}

export interface WorkerEventPort {
  append(input: {
    readonly context: WorkerRuntimeContext;
    readonly fencingToken: number;
    readonly event: WorkerRuntimeEvent;
  }): Promise<void>;
}

export interface WorkerLease {
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly acquiredAt: string;
  readonly renewedAt: string;
  readonly expiresAt: string;
}

export interface WorkerLeasePort {
  renew(input: {
    readonly workspaceId: string;
    readonly workerRunId: string;
    readonly lease: WorkerLease;
    readonly now: Date;
  }): Promise<WorkerLease | null>;
  release(input: {
    readonly workspaceId: string;
    readonly workerRunId: string;
    readonly lease: WorkerLease;
    readonly now: Date;
  }): Promise<void>;
}

export type WorkerCancellationState =
  | { readonly kind: "active" }
  | { readonly kind: "operator_cancelled" }
  | { readonly kind: "deployment_revoked" };

export interface WorkerCancellationPort {
  inspect(input: {
    readonly workspaceId: string;
    readonly workerRunId: string;
    readonly workerDeploymentId: string;
  }): Promise<WorkerCancellationState>;
}

export interface WorkerRunFinalization {
  readonly expectedRunRevision: number;
  readonly fencingToken: number;
  readonly status: "completed" | "failed" | "budget_exhausted" | "cancelled" | "quarantined";
  readonly terminalReason: WorkerRunTerminalReason;
  readonly budgetUsage: WorkerBudgetUsage;
  readonly output?: JsonValue;
  readonly error?: string;
}

export interface WorkerRunPort {
  finalize(input: {
    readonly context: WorkerRuntimeContext;
    readonly finalization: WorkerRunFinalization;
    readonly now: Date;
  }): Promise<WorkerRun>;
}

export interface WorkerSupervisorPorts {
  readonly provider: WorkerProviderPort;
  readonly tools: WorkerToolPort;
  readonly clock: WorkerClockPort;
  readonly checkpoints: WorkerCheckpointPort;
  readonly events: WorkerEventPort;
  readonly leases: WorkerLeasePort;
  readonly cancellation: WorkerCancellationPort;
  readonly runs: WorkerRunPort;
}

export interface WorkerEvaluationRecord {
  readonly predicateId: string;
  readonly predicateKind: WorkerExitPredicate["kind"];
  readonly testedAtIteration: number;
  readonly evidence: string;
  readonly matched: boolean;
}

export type WorkerSupervisorLimits = WorkerBudgetPolicy;
