import { recordedCall } from "../providers/ledger.js";
import { getDefaultRouter } from "../providers/router.js";
import type {
  ProviderCallResult,
  ProviderMessage,
  ProviderName,
  ProviderToolDef,
} from "../providers/types.js";
import { getDefaultToolRegistry } from "./registry.js";
import { executeTool } from "./executor.js";
import type { ToolCallRecord, ToolDefinition } from "./types.js";

export interface AgentLoopInput {
  workspaceId: string;
  userId: string;
  runId?: string;
  agentId?: string;
  routeKey: string;
  providerName?: ProviderName;
  model?: string;
  systemPrompt: string;
  userPrompt: string;
  toolNames?: string[];
  maxTurns?: number;
  signal?: AbortSignal;
}

export interface AgentLoopResult {
  finalContent: string;
  toolCalls: ToolCallRecord[];
  modelUsed: string;
  costUsd: number;
  turnsUsed: number;
  finishReason: ProviderCallResult["finishReason"] | "max_turns";
}

const MAX_TURNS_DEFAULT = 8;

function toolDefForProvider(tool: ToolDefinition): ProviderToolDef {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const registry = getDefaultToolRegistry();
  const tools = (input.toolNames ?? registry.list().map((t) => t.name))
    .map((name) => registry.get(name))
    .filter((t): t is ToolDefinition => Boolean(t));
  const toolDefs = tools.map(toolDefForProvider);
  const router = getDefaultRouter();
  const route =
    input.providerName && input.model
      ? { provider: input.providerName, model: input.model }
      : { ...router.resolve(input.routeKey), ...(input.model ? { model: input.model } : {}) };
  if (route.provider !== "stub" && !router.has(route.provider)) {
    throw new Error(`provider "${route.provider}" is not registered for agent execution`);
  }
  const maxTurns = Math.max(1, Math.min(input.maxTurns ?? MAX_TURNS_DEFAULT, 16));

  const messages: ProviderMessage[] = [
    { role: "system", content: input.systemPrompt },
    { role: "user", content: input.userPrompt },
  ];

  const toolCalls: ToolCallRecord[] = [];
  let totalCost = 0;
  let modelUsed = route.model;
  let finishReason: AgentLoopResult["finishReason"] = "stop";
  let turnsUsed = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    turnsUsed = turn + 1;
    if (input.signal?.aborted) {
      finishReason = "error";
      break;
    }

    const callResult = await recordedCall(
      {
        workspaceId: input.workspaceId,
        routeKey: input.routeKey,
        provider: route.provider,
        model: route.model,
      },
      () =>
        router.call({
          workspaceId: input.workspaceId,
          routeKey: input.routeKey,
          provider: route.provider,
          messages,
          ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
          model: route.model,
          ...(input.signal ? { signal: input.signal } : {}),
          maxTokens: 2048,
        }),
    );

    modelUsed = callResult.model;
    totalCost += callResult.usage.costUsd;
    finishReason = callResult.finishReason;

    if (callResult.content) {
      messages.push({ role: "assistant", content: callResult.content });
    }

    if (
      callResult.finishReason !== "tool_use" ||
      !callResult.toolCalls ||
      callResult.toolCalls.length === 0
    ) {
      return {
        finalContent: callResult.content,
        toolCalls,
        modelUsed,
        costUsd: totalCost,
        turnsUsed,
        finishReason,
      };
    }

    for (const toolCall of callResult.toolCalls) {
      const definition = registry.get(toolCall.name);
      if (!definition) {
        const synthetic: ToolCallRecord = {
          id: toolCall.id,
          toolName: toolCall.name,
          input: toolCall.input,
          error: `tool "${toolCall.name}" is not registered`,
          durationMs: 0,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          status: "error",
        };
        toolCalls.push(synthetic);
        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: JSON.stringify({ error: synthetic.error }),
        });
        continue;
      }
      const record = await executeTool({
        tool: definition,
        input: toolCall.input,
        context: {
          workspaceId: input.workspaceId,
          userId: input.userId,
          ...(input.runId ? { runId: input.runId } : {}),
          ...(input.agentId ? { agentId: input.agentId } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        },
      });
      toolCalls.push({ ...record, id: toolCall.id });
      const payload =
        record.status === "ok"
          ? { result: record.output }
          : { error: record.error, output: record.output };
      messages.push({
        role: "tool",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: JSON.stringify(payload).slice(0, 8_000),
      });
    }
  }

  return {
    finalContent: "",
    toolCalls,
    modelUsed,
    costUsd: totalCost,
    turnsUsed,
    finishReason: finishReason === "tool_use" ? "max_turns" : finishReason,
  };
}
