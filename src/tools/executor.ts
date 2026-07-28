import { randomUUID } from "node:crypto";
import {
  evaluateWorkerToolPolicy,
  type WorkerToolPolicyEvaluation,
} from "../workers/policy-enforcement.js";
import type { WorkerCapabilityEffect } from "../workers/types.js";
import { authorizeRegisteredWorkerToolExecution } from "./execution-guard.js";
import type { ToolCallRecord, ToolContext, ToolDefinition, ToolEffectDescriptor } from "./types.js";

export interface ExecuteToolParams {
  tool: ToolDefinition;
  input: Record<string, unknown>;
  context: Omit<ToolContext, "signal"> & { signal?: AbortSignal };
}

export function preflightWorkerToolPolicy(input: {
  readonly tool: ToolDefinition;
  readonly toolInput: Record<string, unknown>;
  readonly context: ToolContext;
}): WorkerToolPolicyEvaluation | undefined {
  if (!input.context.worker) return undefined;
  const fallbackEffect = toolCapabilityEffect(input.tool);
  if (!input.tool.authorization) {
    return evaluateWorkerToolPolicy({
      tool: input.tool.name,
      worker: input.context.worker,
      fallbackEffect,
    });
  }
  try {
    const authorization = input.tool.authorization.describe(input.toolInput, input.context);
    const describedEffect = describeToolEffect(input.tool, input.toolInput);
    const expectedEffect =
      describedEffect.classification === "read_only"
        ? "read"
        : input.tool.side === "exec"
          ? "execute"
          : "write";
    return evaluateWorkerToolPolicy({
      tool: input.tool.name,
      descriptor:
        authorization.effect === expectedEffect
          ? authorization
          : { ...authorization, effect: expectedEffect },
      worker: input.context.worker,
      fallbackEffect,
    });
  } catch {
    return evaluateWorkerToolPolicy({
      tool: input.tool.name,
      descriptor: {
        verb: "UNKNOWN",
        resources: [],
        effect: fallbackEffect,
      },
      worker: input.context.worker,
      fallbackEffect,
    });
  }
}

export async function executeTool({
  tool,
  input,
  context,
}: ExecuteToolParams): Promise<ToolCallRecord> {
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const internalCtrl = new AbortController();
  if (context.signal) {
    if (context.signal.aborted) internalCtrl.abort();
    else context.signal.addEventListener("abort", () => internalCtrl.abort(), { once: true });
  }

  const timeoutMs = tool.timeoutMs ?? 30_000;
  const timer = setTimeout(() => internalCtrl.abort(), timeoutMs);

  let ctx: ToolContext = { ...context, signal: internalCtrl.signal };

  try {
    const policy = preflightWorkerToolPolicy({ tool, toolInput: input, context: ctx });
    if (policy) {
      await ctx.worker!.recordPolicyDecision(policy.decision);
      if (!policy.decision.allowed || !policy.decision.capabilityId || !policy.operation) {
        return {
          id,
          toolName: tool.name,
          input,
          error: `Worker policy denied tool "${tool.name}" (${policy.decision.code}).`,
          durationMs: Date.now() - t0,
          startedAt,
          completedAt: new Date().toISOString(),
          status: "error",
        };
      }
      const effect = describeToolEffect(tool, input);
      ctx = {
        ...ctx,
        worker: {
          ...ctx.worker!,
          capability: { id: policy.decision.capabilityId },
          effect: {
            classification: effect.classification,
            operation: effect.operation,
            effect: policy.operation.effect,
          },
        },
      };
      authorizeRegisteredWorkerToolExecution(ctx, tool.name);
    }
    const result = await tool.handle(input, ctx);
    return {
      id,
      toolName: tool.name,
      input,
      output: result.output,
      ...(result.error ? { error: result.error } : {}),
      ...(result.artifacts ? { artifacts: result.artifacts } : {}),
      durationMs: Date.now() - t0,
      startedAt,
      completedAt: new Date().toISOString(),
      status: result.ok ? "ok" : "error",
    };
  } catch (error) {
    const aborted = internalCtrl.signal.aborted;
    return {
      id,
      toolName: tool.name,
      input,
      error: aborted
        ? `tool "${tool.name}" timed out after ${timeoutMs}ms`
        : (error as Error).message,
      durationMs: Date.now() - t0,
      startedAt,
      completedAt: new Date().toISOString(),
      status: aborted ? "timeout" : "error",
    };
  } finally {
    clearTimeout(timer);
  }
}

function describeToolEffect(
  tool: ToolDefinition,
  input: Record<string, unknown>,
): ToolEffectDescriptor {
  return (
    tool.effect?.describe(input) ?? {
      classification: tool.side === "read" ? "read_only" : "non_replayable_mutation",
      operation: tool.name,
    }
  );
}

function toolCapabilityEffect(tool: ToolDefinition): WorkerCapabilityEffect {
  if (tool.side === "read") return "read";
  if (tool.side === "exec") return "execute";
  return "write";
}
