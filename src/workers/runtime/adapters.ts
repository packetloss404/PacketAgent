import { recordedCall } from "../../providers/ledger.js";
import { getDefaultRouter, type ProviderRouter } from "../../providers/router.js";
import type { ProviderName, ProviderToolDef } from "../../providers/types.js";
import { executeTool } from "../../tools/executor.js";
import { getDefaultToolRegistry, type ToolRegistry } from "../../tools/registry.js";
import type { JsonObject, JsonValue } from "../types.js";
import type {
  WorkerClockPort,
  WorkerProviderPort,
  WorkerRuntimeProviderRequest,
  WorkerRuntimeToolDefinition,
  WorkerToolPort,
} from "./ports.js";

const PROVIDER_NAMES: ReadonlySet<string> = new Set([
  "anthropic",
  "openai",
  "openrouter",
  "minimax",
  "ollama",
  "gemini",
  "stub",
]);

export function createWorkerProviderPort(
  router: ProviderRouter = getDefaultRouter(),
): WorkerProviderPort {
  return {
    async call(request) {
      const route = resolveProviderRoute(router, request);
      if (route.provider !== "stub" && !router.has(route.provider)) {
        throw new Error(`provider "${route.provider}" is not registered for Worker execution`);
      }
      const tools: ProviderToolDef[] = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
      const result = await recordedCall(
        {
          workspaceId: request.workspaceId,
          routeKey: request.routeKey,
          provider: route.provider,
          model: route.model,
        },
        () =>
          router.call({
            workspaceId: request.workspaceId,
            routeKey: request.routeKey,
            provider: route.provider,
            model: route.model,
            messages: [
              { role: "system", content: request.systemPrompt },
              { role: "user", content: request.userPrompt },
            ],
            ...(tools.length > 0 ? { tools } : {}),
            maxTokens: 2048,
            signal: request.signal,
          }),
      );
      return {
        content: result.content,
        toolCalls: (result.toolCalls ?? []).map((call) => ({
          id: call.id,
          name: call.name,
          input: jsonObject(call.input),
        })),
        finishReason: result.finishReason,
        usage: result.usage,
        model: result.model,
        provider: result.providerName,
      };
    },
  };
}

export function createWorkerToolPort(
  registry: ToolRegistry = getDefaultToolRegistry(),
): WorkerToolPort {
  return {
    definitions(capabilities) {
      const definitions: WorkerRuntimeToolDefinition[] = [];
      const seen = new Set<string>();
      for (const capability of capabilities) {
        if (seen.has(capability.tool)) continue;
        seen.add(capability.tool);
        const tool = registry.get(capability.tool);
        if (!tool) continue;
        definitions.push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      }
      return definitions;
    },
    async execute(input) {
      if (input.capability.tool !== input.call.name || input.capability.approval !== "never") {
        const timestamp = new Date().toISOString();
        return {
          callId: input.call.id,
          toolName: input.call.name,
          status: "error",
          error: `tool "${input.call.name}" is not permitted for unattended Worker execution`,
          durationMs: 0,
          startedAt: timestamp,
          completedAt: timestamp,
        };
      }
      const tool = registry.get(input.call.name);
      if (!tool) {
        const timestamp = new Date().toISOString();
        return {
          callId: input.call.id,
          toolName: input.call.name,
          status: "error",
          error: `tool "${input.call.name}" is not registered`,
          durationMs: 0,
          startedAt: timestamp,
          completedAt: timestamp,
        };
      }
      const record = await executeTool({
        tool,
        input: { ...input.call.input },
        context: {
          workspaceId: input.workspaceId,
          userId: "packetagent.worker-supervisor",
          runId: input.workerRunId,
          signal: input.signal,
        },
      });
      const output = jsonValue(record.output);
      return {
        callId: input.call.id,
        toolName: record.toolName,
        status: record.status,
        ...(output !== undefined ? { output } : {}),
        ...(record.error ? { error: record.error } : {}),
        durationMs: record.durationMs,
        startedAt: record.startedAt,
        completedAt: record.completedAt,
      };
    },
  };
}

export function createSystemWorkerClock(): WorkerClockPort {
  return {
    now: () => new Date(),
    monotonicMs: () => performance.now(),
    sleep(ms, signal) {
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(abortError(signal));
          return;
        }
        const timer = setTimeout(
          () => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          },
          Math.max(0, ms),
        );
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(abortError(signal));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

function resolveProviderRoute(
  router: ProviderRouter,
  request: WorkerRuntimeProviderRequest,
): { provider: ProviderName; model: string } {
  const configured = router.resolve(request.routeKey);
  const provider = request.providerId ? providerName(request.providerId) : configured.provider;
  return {
    provider,
    model: request.model ?? configured.model,
  };
}

function providerName(value: string): ProviderName {
  if (!PROVIDER_NAMES.has(value)) {
    throw new Error(`Worker execution provider "${value}" is not supported.`);
  }
  return value as ProviderName;
}

function jsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return undefined;
    if (serialized.length > 8_000) return serialized.slice(0, 8_000);
    return JSON.parse(serialized) as JsonValue;
  } catch {
    return null;
  }
}

function jsonObject(value: Record<string, unknown>): JsonObject {
  const converted = jsonValue(value);
  return converted && typeof converted === "object" && !Array.isArray(converted)
    ? (converted as JsonObject)
    : {};
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(typeof signal.reason === "string" ? signal.reason : "aborted");
}
