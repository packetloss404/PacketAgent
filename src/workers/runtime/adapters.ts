import { createHash } from "node:crypto";
import { recordedCall } from "../../providers/ledger.js";
import { getDefaultRouter, type ProviderRouter } from "../../providers/router.js";
import type { ProviderName, ProviderToolDef } from "../../providers/types.js";
import { executeTool, preflightWorkerToolPolicy } from "../../tools/executor.js";
import { getDefaultToolRegistry, type ToolRegistry } from "../../tools/registry.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../../tools/types.js";
import type { JsonObject, JsonValue } from "../types.js";
import {
  resolveWorkerRollingBudgetPolicy,
  type WorkerBudgetReservationRecord,
  type WorkerRollingBudgetPort,
} from "../budget-types.js";
import { createWorkerEffectCoordinator, type WorkerEffectCoordinator } from "../effects.js";
import { createWorkerCredentialService, type WorkerCredentialService } from "../credentials.js";
import { createWorkerNetworkClient, type WorkerNetworkPort } from "../network.js";
import { createWorkerSandboxPort, type WorkerSandboxPort } from "../sandbox-execution.js";
import {
  createWorkerRollingBudgetService,
  WorkerRollingBudgetExceededError,
} from "../rolling-budget.js";
import type {
  WorkerClockPort,
  WorkerProviderPort,
  WorkerRuntimeProviderRequest,
  WorkerRuntimeToolDefinition,
  WorkerRuntimeToolAuthorizationInput,
  WorkerRuntimeToolResult,
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
          recordId: request.providerCallId,
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
        providerCallId: request.providerCallId,
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
  effects: WorkerEffectCoordinator = createWorkerEffectCoordinator(),
  services: WorkerToolAdapterServices | undefined = createDefaultWorkerToolAdapterServices(),
  budgets: WorkerRollingBudgetPort = createWorkerRollingBudgetService(),
): WorkerToolPort {
  const runtimeServices = services ?? createDefaultWorkerToolAdapterServices();
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
    async authorize(input) {
      const tool = registry.get(input.call.name);
      if (!tool) {
        return {
          allowed: false,
          code: "capability_not_granted",
          tool: input.call.name,
          verb: "UNKNOWN",
          effect: "execute",
          operationDigest: `sha256:${createHash("sha256")
            .update(
              JSON.stringify({
                tool: input.call.name,
                verb: "UNKNOWN",
                effect: "execute",
                resources: [],
              }),
            )
            .digest("hex")}`,
          resourceCount: 0,
          resourceSchemes: [],
        };
      }
      const context = workerToolBaseContext(input, runtimeServices, async () => undefined);
      const preflight = preflightWorkerToolPolicy({
        tool,
        toolInput: { ...input.call.input },
        context: { ...context, signal: input.signal },
      });
      if (!preflight) {
        throw new Error("Worker tool authorization did not produce a policy decision.");
      }
      return preflight.decision;
    },
    async execute(input) {
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
      const descriptor = describeToolEffect(tool, input.call.input);
      const baseContext = workerToolBaseContext(input, runtimeServices, input.recordPolicyDecision);
      const preflightContext: ToolContext = { ...baseContext, signal: input.signal };
      const preflight = preflightWorkerToolPolicy({
        tool,
        toolInput: { ...input.call.input },
        context: preflightContext,
      });
      if (!preflight?.decision.allowed || !preflight.decision.capabilityId) {
        const denied = await executeTool({
          tool,
          input: { ...input.call.input },
          context: preflightContext,
        });
        return runtimeResultFromToolCallRecord(input.call.id, denied);
      }
      const authorizedContext: Omit<ToolContext, "signal"> = {
        ...baseContext,
        worker: {
          ...baseContext.worker!,
          capability: { id: preflight.decision.capabilityId },
          effect: {
            classification: descriptor.classification,
            operation: descriptor.operation,
            effect: preflight.operation!.effect,
          },
        },
      };
      let billableActionAttempted = false;
      const execute = async (effectKey?: string): Promise<WorkerRuntimeToolResult> => {
        billableActionAttempted = true;
        const record = await executeTool({
          tool,
          input: { ...input.call.input },
          context: {
            ...authorizedContext,
            ...(effectKey ? { effectKey } : {}),
            signal: input.signal,
          },
        });
        return runtimeResultFromToolCallRecord(input.call.id, record);
      };
      const reconcile = tool.effect?.reconcile
        ? async (effectKey: string) => {
            billableActionAttempted = true;
            const reconciled = await tool.effect!.reconcile!(
              { ...input.call.input },
              {
                ...authorizedContext,
                effectKey,
                signal: input.signal,
              },
            );
            if (reconciled.disposition !== "completed") return reconciled;
            return {
              disposition: "completed" as const,
              result: runtimeResultFromToolResult(input.call.id, tool.name, reconciled.result),
            };
          }
        : undefined;
      const reservation = descriptor.billableAction
        ? await reserveBillableAction(budgets, input)
        : undefined;
      try {
        const result = await effects.execute({
          workspaceId: input.workspaceId,
          workerRunId: input.workerRunId,
          workerVersionId: input.workerVersionId,
          workerDeploymentId: input.workerDeploymentId,
          fencingToken: input.fencingToken,
          iteration: input.iteration,
          capabilityId: preflight.decision.capabilityId,
          call: input.call,
          classification: descriptor.classification,
          operation: descriptor.operation,
          execute,
          ...(reconcile ? { reconcile } : {}),
        });
        if (reservation) {
          await finalizeBillableActionReservation(
            budgets,
            reservation,
            input,
            billableActionAttempted,
            budgetCompletionTime(input.reservedAt),
          );
        }
        return result;
      } catch (error) {
        if (reservation) {
          await finalizeBillableActionReservation(
            budgets,
            reservation,
            input,
            billableActionAttempted,
            budgetCompletionTime(input.reservedAt),
          );
        }
        throw error;
      }
    },
  };
}

export interface WorkerToolAdapterServices {
  readonly credentials: WorkerCredentialService;
  readonly network: WorkerNetworkPort;
  readonly sandbox: WorkerSandboxPort;
}

function workerToolBaseContext(
  input: WorkerRuntimeToolAuthorizationInput | Parameters<WorkerToolPort["execute"]>[0],
  services: WorkerToolAdapterServices,
  recordPolicyDecision: NonNullable<ToolContext["worker"]>["recordPolicyDecision"],
): Omit<ToolContext, "signal"> {
  const approvalTime = "reservedAt" in input ? input.reservedAt : input.authorizedAt;
  const approval =
    input.approval?.actionId === input.call.id &&
    Date.parse(input.approval.expiresAt) > approvalTime.getTime()
      ? input.approval
      : undefined;
  return {
    workspaceId: input.workspaceId,
    userId: "packetagent.worker-supervisor",
    runId: input.workerRunId,
    agentId: input.workerDefinitionId,
    worker: {
      run: { id: input.workerRunId },
      deployment: {
        id: input.workerDeploymentId,
        revision: input.workerDeploymentRevision,
        ...(input.compiledPolicy ? { compiledPolicy: input.compiledPolicy } : {}),
      },
      version: {
        id: input.workerVersionId,
        contentDigest: input.workerVersionContentDigest,
        declaredCredentialRefs: input.declaredCredentialRefs,
      },
      ...(approval ? { approval } : {}),
      budget: input.budgetUsage,
      actor: input.actor,
      services: {
        credentials: {
          use(reference, expectedKinds, consumer) {
            return services.credentials.use(
              {
                workspaceId: input.workspaceId,
                reference,
                declaredCredentialRefs: input.declaredCredentialRefs,
                expectedKinds,
              },
              consumer,
            );
          },
        },
        network: services.network,
        sandbox: services.sandbox,
      },
      recordPolicyDecision,
    },
  };
}

function createDefaultWorkerToolAdapterServices(): WorkerToolAdapterServices {
  return {
    credentials: createWorkerCredentialService(),
    network: createWorkerNetworkClient(),
    sandbox: createWorkerSandboxPort(),
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

function describeToolEffect(
  tool: ToolDefinition,
  input: JsonObject,
): {
  classification:
    | "read_only"
    | "idempotent_mutation"
    | "reconcilable_mutation"
    | "non_replayable_mutation";
  operation: string;
  billableAction?: boolean;
} {
  const described = tool.effect?.describe({ ...input });
  if (described) return described;
  return {
    classification: tool.side === "read" ? "read_only" : "non_replayable_mutation",
    operation: tool.name,
  };
}

async function reserveBillableAction(
  budgets: WorkerRollingBudgetPort,
  input: Parameters<WorkerToolPort["execute"]>[0],
): Promise<WorkerBudgetReservationRecord> {
  const result = await budgets.reserve({
    workspaceId: input.workspaceId,
    workerDeploymentId: input.workerDeploymentId,
    workerRunId: input.workerRunId,
    workerVersionId: input.workerVersionId,
    fencingToken: input.fencingToken,
    reservationKey: [
      input.workerRunId,
      input.fencingToken,
      "tool",
      input.iteration,
      input.call.id,
      input.budgetUsage.consecutiveFailures,
    ].join(":"),
    kind: "billable_action",
    amount: 1,
    policy: resolveWorkerRollingBudgetPolicy(input.budgetPolicy),
    now: input.reservedAt,
  });
  if (!result.allowed) {
    throw new WorkerRollingBudgetExceededError(
      "billable_action",
      result.code === "workspace_limit" ? "workspace" : "deployment",
    );
  }
  return result.reservation;
}

async function finalizeBillableActionReservation(
  budgets: WorkerRollingBudgetPort,
  reservation: WorkerBudgetReservationRecord,
  input: Parameters<WorkerToolPort["execute"]>[0],
  attempted: boolean,
  now: Date,
): Promise<void> {
  if (attempted) {
    await budgets.settle({
      workspaceId: input.workspaceId,
      workerRunId: input.workerRunId,
      fencingToken: input.fencingToken,
      reservationId: reservation.id,
      actualAmount: 1,
      now,
    });
    return;
  }
  await budgets.release({
    workspaceId: input.workspaceId,
    workerRunId: input.workerRunId,
    fencingToken: input.fencingToken,
    reservationId: reservation.id,
    reason: "call_not_attempted",
    now,
  });
}

function budgetCompletionTime(reservedAt: Date): Date {
  return new Date(Math.max(Date.now(), reservedAt.getTime()));
}

function runtimeResultFromToolResult(
  callId: string,
  toolName: string,
  result: ToolResult,
): WorkerRuntimeToolResult {
  const timestamp = new Date().toISOString();
  const output = jsonValue(result.output);
  return {
    callId,
    toolName,
    status: result.ok ? "ok" : "error",
    ...(output !== undefined ? { output } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.artifacts
      ? { artifactRefs: result.artifacts.map((artifact) => artifact.path) }
      : {}),
    durationMs: 0,
    startedAt: timestamp,
    completedAt: timestamp,
  };
}

function runtimeResultFromToolCallRecord(
  callId: string,
  record: Awaited<ReturnType<typeof executeTool>>,
): WorkerRuntimeToolResult {
  const output = jsonValue(record.output);
  return {
    callId,
    toolName: record.toolName,
    status: record.status,
    ...(output !== undefined ? { output } : {}),
    ...(record.error ? { error: record.error } : {}),
    ...(record.artifacts
      ? { artifactRefs: record.artifacts.map((artifact) => artifact.path) }
      : {}),
    durationMs: record.durationMs,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
  };
}
