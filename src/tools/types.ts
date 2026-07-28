import type { WorkerToolEffectClassification } from "../workers/effect-types.js";
import type {
  WorkerActorReference,
  WorkerBudgetUsage,
  WorkerCapabilityEffect,
  WorkerCompiledPolicy,
} from "../workers/types.js";
import type { WorkerToolRuntimeServices } from "../workers/runtime-services.js";

export interface ToolContext {
  workspaceId: string;
  userId: string;
  runId?: string;
  agentId?: string;
  signal: AbortSignal;
  artifactDir?: string;
  effectKey?: string;
  worker?: WorkerToolContext;
}

export interface WorkerToolContext {
  readonly run: {
    readonly id: string;
  };
  readonly deployment: {
    readonly id: string;
    readonly revision: number;
    readonly compiledPolicy?: WorkerCompiledPolicy;
  };
  readonly version: {
    readonly id: string;
    readonly contentDigest: string;
    readonly declaredCredentialRefs: readonly string[];
  };
  readonly capability?: {
    readonly id: string;
  };
  readonly approval?: WorkerToolApprovalEvidence;
  readonly budget: WorkerBudgetUsage;
  readonly effect?: {
    readonly classification: WorkerToolEffectClassification;
    readonly operation: string;
    readonly effect: WorkerCapabilityEffect;
  };
  readonly actor: WorkerActorReference;
  readonly services?: WorkerToolRuntimeServices;
  readonly recordPolicyDecision: (decision: ToolPolicyDecision) => Promise<void>;
}

export interface WorkerToolApprovalEvidence {
  readonly grantId: string;
  readonly attentionRequestId: string;
  readonly actionId: string;
  readonly capabilityId: string;
  readonly operationDigest: string;
  readonly policyDigest: string;
  readonly scope: "once" | "run";
  readonly expiresAt: string;
}

export interface ToolAuthorizationDescriptor {
  readonly verb: string;
  readonly resources: readonly string[];
  readonly effect: WorkerCapabilityEffect;
}

export interface ToolPolicyDecision {
  readonly allowed: boolean;
  readonly code:
    | "allowed"
    | "approval_required"
    | "capability_not_granted"
    | "invalid_operation"
    | "missing_authorization_descriptor"
    | "missing_compiled_policy"
    | "stale_policy"
    | "tampered_policy";
  readonly tool: string;
  readonly verb: string;
  readonly effect: WorkerCapabilityEffect;
  readonly operationDigest: string;
  readonly resourceCount: number;
  readonly resourceSchemes: readonly string[];
  readonly policyDigest?: string;
  readonly capabilityId?: string;
  readonly approvalGrantId?: string;
  readonly attentionRequestId?: string;
}

export interface ToolResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  artifacts?: { path: string; bytes: number; kind: string }[];
}

export interface ToolDefinition<TInput = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  side: "read" | "write" | "exec";
  effect?: ToolEffectDefinition<TInput>;
  authorization?: ToolAuthorizationDefinition<TInput>;
  timeoutMs?: number;
  handle(input: TInput, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolEffectDescriptor {
  classification: WorkerToolEffectClassification;
  operation: string;
  billableAction?: boolean;
}

export type ToolEffectReconciliation =
  | { readonly disposition: "absent" }
  | { readonly disposition: "completed"; readonly result: ToolResult }
  | { readonly disposition: "uncertain"; readonly reason: string };

export interface ToolEffectDefinition<TInput = Record<string, unknown>> {
  describe(input: TInput): ToolEffectDescriptor;
  reconcile?(input: TInput, ctx: ToolContext): Promise<ToolEffectReconciliation>;
}

export interface ToolAuthorizationDefinition<TInput = Record<string, unknown>> {
  describe(input: TInput, ctx: ToolContext): ToolAuthorizationDescriptor;
}

export interface ToolCallRecord {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  output?: unknown;
  error?: string;
  artifacts?: { path: string; bytes: number; kind: string }[];
  durationMs: number;
  startedAt: string;
  completedAt: string;
  status: "ok" | "error" | "timeout";
}
