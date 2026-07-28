import type { WorkerToolEffectClassification } from "../workers/effect-types.js";

export interface ToolContext {
  workspaceId: string;
  userId: string;
  runId?: string;
  agentId?: string;
  signal: AbortSignal;
  artifactDir?: string;
  effectKey?: string;
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
  timeoutMs?: number;
  handle(input: TInput, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolEffectDescriptor {
  classification: WorkerToolEffectClassification;
  operation: string;
}

export type ToolEffectReconciliation =
  | { readonly disposition: "absent" }
  | { readonly disposition: "completed"; readonly result: ToolResult }
  | { readonly disposition: "uncertain"; readonly reason: string };

export interface ToolEffectDefinition<TInput = Record<string, unknown>> {
  describe(input: TInput): ToolEffectDescriptor;
  reconcile?(
    input: TInput,
    ctx: ToolContext,
  ): Promise<ToolEffectReconciliation>;
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
