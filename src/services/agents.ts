import { createHash } from "node:crypto";
import {
  findAgentForWorkspaceIndexed,
  findAgentRunForWorkspaceIndexed,
  findAgentRunForWorkspaceIndexedAsync,
  deleteWorkspaceEnvVar,
  findAgent,
  findProvider,
  findWorkspaceEnvVar,
  listAgentRunsForAgentIndexed,
  listAgentRunsForWorkspaceIndexed,
  listAgentsForWorkspaceIndexed,
  listProvidersForWorkspaceIndexed,
  listReleaseConfirmationsForWorkspace,
  listWorkspaceEnvVars,
  loadStore,
  loadStoreAsync,
  mutateStore,
  mutateStoreAsync,
  recordActivity,
  type AgentInputField,
  type AgentInputFieldType,
  type AgentEvaluationSpec,
  type AgentMemoryEntry,
  type AgentPlaybookStep,
  type AgentRecord,
  type AgentRunLogEntry,
  type AgentRunRecord,
  type AgentRunStep,
  type AgentRunToolCall,
  type AgentStatus,
  type AgentTriggerKind,
  type ApiKeyProvider,
  type ProviderKind,
  type ProviderRecord,
  type WorkspaceEnvVarRecord,
  type WorkspaceEnvVarScope,
  type PacketAgentData,
  upsertActivationSignal,
  upsertAgent,
  upsertAgentRun,
  upsertProvider,
  upsertWorkspaceEnvVar,
} from "../packetagent-store";
import {
  deriveAgentRunTraceSpans as deriveStoredAgentRunTraceSpans,
  type AgentRunTraceSpan as StoredAgentRunTraceSpan,
  type AgentRunTraceSpanType as StoredAgentRunTraceSpanType,
} from "../agent-run-trace.js";
import { AGENT_TEMPLATES, findAgentTemplate } from "../agent-templates.js";
import { DEFAULT_PROVIDER_NAMES } from "../providers/bootstrap.js";
import { agentProviderRouteKey } from "../providers/router.js";
import { listDefaultToolSummaries } from "../tools/bootstrap.js";
import {
  buildWebhookTriggerReadiness,
  type WebhookTriggerReadiness,
} from "../webhook-readiness.js";
import { getDefaultToolRegistry } from "../tools/registry.js";
import type {
  ToolCapabilityApprovalInput,
  ToolCapabilityApprovalRequest,
} from "../tools/approval.js";
import type { ToolDefinition } from "../tools/types.js";
import { maintainScheduledAgentJobs } from "../jobs/store.js";
import {
  detectPhase71Integrations,
  type Phase71IntegrationMetadata,
} from "../app-builder-service.js";
import {
  isSensitiveKey,
  maskSecret as maskBearerSecret,
  redactSensitiveString,
  redactSensitiveValue,
} from "../security/redaction.js";
import { generateId, now } from "../auth-utils";
import {
  generateAgentTemplateViaLlm,
  type AgentTemplateFallbackReason,
  type AgentTemplateGenerationResult,
} from "../agent-builder/llm-template.js";
import {
  buildAgentBuilderProviderReadiness,
  resolveAgentBuilderProviderContext,
  type AgentBuilderProviderContext,
  type AgentBuilderProviderReadiness,
} from "../agent-builder/readiness.js";
import { buildAgentFirstRunEvaluation } from "../agent-builder/first-run-evaluation.js";
import {
  AGENT_WORKER_BUNDLE_MAX_BYTES,
  AGENT_WORKER_BUNDLE_SCHEMA_VERSION,
  AgentWorkerBundleSecretError,
  sealAgentWorkerBundle,
  verifyAgentWorkerBundle,
  type AgentWorkerBundle,
  type AgentWorkerBundlePublisherTrust,
} from "../agents/portable-bundle.js";
import { executeLegacyAgentCanonically } from "../agents/canonical-execution.js";
import { refreshLegacyAgentRunFromCanonical } from "../agents/canonical-run-compatibility.js";
import { reconcileLegacyAgentWorkers } from "../agents/canonical-reconciliation.js";
import { createWorkerControlService } from "../workers/control-service.js";
import {
  activationActivityId,
  activationSignalStableKey,
  type AuthenticatedContext,
  httpError,
  makeActivity,
  stringOrUndefined,
  upsertActivationActivity,
} from "./context.js";

export interface AgentDraftOptions {
  providerId?: string | null;
  model?: string | null;
  status?: AgentStatus;
}

export interface AgentBundleImportPreview {
  schemaVersion: typeof AGENT_WORKER_BUNDLE_SCHEMA_VERSION;
  bundleDigest: string;
  agent: {
    name: string;
    triggerKind: AgentTriggerKind;
    schedule?: string;
    toolCount: number;
    inputCount: number;
  };
  worker: {
    contentDigest: string;
    status: "draft";
  };
  publisher: {
    keyId: string;
    trust: AgentWorkerBundlePublisherTrust;
    signatureVerified: true;
    acknowledgementRequired: boolean;
  };
  readiness: {
    provider: {
      status: "resolved" | "needs_setup";
      hint?: {
        kind: ProviderKind;
        name: string;
      };
      providerId?: string;
      providerName?: string;
    };
    missingTools: string[];
  };
  importPolicy: {
    status: "paused";
    credentialsIncluded: false;
    webhookTokenIncluded: false;
    runHistoryIncluded: false;
    localIdsIncluded: false;
  };
}

export interface ImportAgentBundleInput {
  bundle: unknown;
  acknowledgeUntrustedPublisher?: boolean;
  idempotencyKey: string;
}

export interface AgentDraftInput extends AgentDraftOptions {
  prompt?: string;
  create?: boolean;
  approve?: boolean;
  runPreview?: boolean;
  sampleInputs?: Record<string, unknown>;
}

export interface AgentDraftPlanItem {
  title: string;
  detail: string;
  status: "todo" | "done";
}

export interface AgentDraft {
  prompt: string;
  integrationMetadata: Phase71IntegrationMetadata;
  agent: {
    name: string;
    description: string;
    instructions: string;
    providerId?: string;
    model?: string;
    tools: string[];
    enabledTools: string[];
    routeKey: string;
    schedule?: string;
    triggerKind: AgentTriggerKind;
    playbook: AgentPlaybookStep[];
    memory: AgentMemoryEntry[];
    evaluationSpec: AgentEvaluationSpec;
    status: AgentStatus;
    inputSchema: AgentInputField[];
  };
  plan: AgentDraftPlanItem[];
  assumptions: string[];
  readiness: {
    webhook: WebhookTriggerReadiness;
  };
}

export interface AgentDraftResult {
  draft: AgentDraft;
  created: boolean;
  agent?: ReturnType<typeof decorateAgentWithProvider>;
  firstRun?: ReturnType<typeof decorateRun>;
  sampleInputs?: Record<string, string | number | boolean>;
}

export interface AgentBuilderPromptInput {
  prompt?: string;
  preset?: import("../model-routing-presets.js").ModelRoutingPresetId;
  signal?: AbortSignal;
}

interface AgentBuilderWebhookTriggerReadiness extends WebhookTriggerReadiness {
  publishSteps: string[];
}

interface AgentBuilderScheduleTriggerReadiness {
  recommended: boolean;
  readyAfterSave: boolean;
  cron?: string;
  message: string;
  planDetail: string;
}

interface AgentBuilderDraftPlan {
  title: string;
  steps: Array<{ title: string; detail: string }>;
  acceptanceChecks: string[];
  openQuestions: string[];
}

export interface AgentBuilderDraft {
  prompt: string;
  intent: string;
  summary: string;
  authoring:
    | {
        source: "llm";
        provider: string;
        model: string;
        category: string;
      }
    | {
        source: "heuristic";
        fallbackReason: AgentTemplateFallbackReason;
      };
  integrationMetadata: Phase71IntegrationMetadata;
  agent: {
    name: string;
    description: string;
    instructions: string;
    providerId?: string;
    model?: string;
    tools: string[];
    enabledTools: string[];
    routeKey: string;
    triggerKind: AgentTriggerKind;
    schedule?: string;
    playbook: AgentPlaybookStep[];
    memory: AgentMemoryEntry[];
    evaluationSpec: AgentEvaluationSpec;
    status: AgentStatus;
    inputSchema: AgentInputField[];
  };
  sampleInputs: Record<string, string | number | boolean>;
  plan: AgentBuilderDraftPlan;
  readiness: {
    provider: AgentBuilderProviderReadiness;
    tools: {
      recommended: string[];
      available: string[];
      missing: string[];
      message: string;
    };
    webhook: AgentBuilderWebhookTriggerReadiness;
    schedule: AgentBuilderScheduleTriggerReadiness;
    firstRun: {
      canRun: boolean;
      blockers: string[];
      message: string;
    };
  };
}

export interface AgentBuilderApproveInput {
  prompt?: string;
  draft?: AgentBuilderDraft;
  runPreview?: boolean;
  sampleInputs?: Record<string, unknown>;
  status?: AgentStatus;
}

export interface AgentBuilderApproveResult {
  draft: AgentBuilderDraft;
  created: true;
  agent: ReturnType<typeof decorateAgentWithProvider>;
  firstRun?: ReturnType<typeof decorateRun>;
  firstRunApproval?: ToolCapabilityApprovalRequest;
  sampleInputs?: Record<string, string | number | boolean>;
}

export interface AgentBuilderDraftDependencies {
  readonly generateTemplate?: (
    input: Parameters<typeof generateAgentTemplateViaLlm>[0],
    options?: Parameters<typeof generateAgentTemplateViaLlm>[1],
  ) => Promise<AgentTemplateGenerationResult>;
  readonly resolveProviderContext?: (
    input: Parameters<typeof resolveAgentBuilderProviderContext>[0],
  ) => Promise<AgentBuilderProviderContext>;
}

export type AgentRunTraceSpanKind =
  | "run"
  | "input"
  | "step"
  | "tool"
  | "log"
  | "output"
  | "error"
  | string;
export type AgentRunTraceSpanStatus = StoredAgentRunTraceSpan["status"] | "unknown" | string;

export interface AgentRunTraceSpan {
  id: string;
  parentId?: string | null;
  name: string;
  kind?: AgentRunTraceSpanKind;
  status?: AgentRunTraceSpanStatus;
  startedAt?: string;
  endedAt?: string | null;
  durationMs?: number | null;
  model?: string;
  toolName?: string;
  costUsd?: number | null;
  input?: unknown;
  output?: unknown;
  error?: string;
  attributes?: Record<string, unknown>;
  events?: Array<{
    at?: string;
    name: string;
    level?: AgentRunLogEntry["level"] | "debug" | string;
    message?: string;
    attributes?: Record<string, unknown>;
  }>;
}

export interface AgentRunTraceDetail {
  id: string;
  runId: string;
  source: "legacy";
  generatedAt: string;
  summary: {
    spans: number;
    spanCount: number;
    modelCalls: number;
    toolCalls: number;
    stepCount: number;
    logCount: number;
    inputCount: number;
    errorCount: number;
    warningCount: number;
    costUsd: number | null;
    durationMs: number | null;
  };
  spans: AgentRunTraceSpan[];
}

export type AgentRunDetail = {
  run: ReturnType<typeof decorateRun>;
  trace: AgentRunTraceDetail;
  agentName?: string;
};

export function listAgents(context: AuthenticatedContext) {
  const providersById = new Map(
    listProvidersForWorkspaceIndexed(context.workspace.id).map((provider) => [
      provider.id,
      provider,
    ]),
  );
  return {
    agents: listAgentsForWorkspaceIndexed(context.workspace.id).map((agent) =>
      decorateAgentWithProvider(
        agent,
        agent.providerId ? (providersById.get(agent.providerId) ?? null) : null,
        { includeWebhookToken: false },
      ),
    ),
  };
}

export async function listAgentsAsync(context: AuthenticatedContext) {
  const data = await loadStoreAsync();
  const providersById = new Map(
    data.providers
      .filter((provider) => provider.workspaceId === context.workspace.id)
      .map((provider) => [provider.id, provider]),
  );
  return {
    agents: data.agents
      .filter((agent) => agent.workspaceId === context.workspace.id && agent.status !== "archived")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((agent) =>
        decorateAgentWithProvider(
          agent,
          agent.providerId ? (providersById.get(agent.providerId) ?? null) : null,
          { includeWebhookToken: false },
        ),
      ),
  };
}

export function getAgent(context: AuthenticatedContext, agentId: string) {
  const agent = findAgentForWorkspaceIndexed(context.workspace.id, agentId);
  if (!agent || agent.status === "archived") {
    throw httpError(404, "agent not found");
  }
  const provider = agent.providerId
    ? (listProvidersForWorkspaceIndexed(context.workspace.id).find(
        (entry) => entry.id === agent.providerId,
      ) ?? null)
    : null;

  return {
    agent: decorateAgentWithProvider(agent, provider),
    runs: listAgentRunsForAgentIndexed(context.workspace.id, agent.id, 20).map(decorateRun),
  };
}

export function generateAgentDraftFromPrompt(
  prompt: string,
  options: AgentDraftOptions = {},
): AgentDraft {
  const trimmed = String(prompt ?? "").trim();
  if (trimmed.length < 8) throw httpError(400, "prompt must be at least 8 characters");

  const sentences = splitPromptSentences(trimmed);
  const actionPhrases = extractAgentActions(sentences);
  const primaryAction = actionPhrases[0] ?? "automate workspace follow-up";
  const name = buildAgentName(primaryAction, trimmed);
  const triggerKind = inferPromptAgentTriggerKind(trimmed);
  const schedule = triggerKind === "schedule" ? inferPromptAgentSchedule(trimmed) : undefined;
  const inputSchema = buildAgentInputSchema(trimmed);
  const enabledTools = inferAgentTools(trimmed);
  const integrationMetadata = buildAgentPhase71IntegrationMetadata(trimmed);
  const playbook = applyAgentIntegrationPlaybookSteps(
    buildAgentPlaybook(sentences, actionPhrases, enabledTools),
    integrationMetadata,
  );
  const webhookReadiness = buildWebhookTriggerReadiness(triggerKind);

  return {
    prompt: trimmed,
    integrationMetadata,
    agent: {
      name,
      description: summarizePromptAgentDraft(sentences, name),
      instructions: applyAgentIntegrationInstructions(
        buildAgentInstructions(trimmed, actionPhrases, enabledTools),
        integrationMetadata,
      ),
      providerId: stringOrUndefined(options.providerId),
      model: stringOrUndefined(options.model),
      tools: enabledTools,
      enabledTools,
      routeKey: "agent.reasoning",
      schedule,
      triggerKind,
      playbook,
      memory: [
        {
          id: "memory-operating-intent",
          label: "Operating intent",
          content: redactSensitiveString(primaryAction).slice(0, 1_000),
        },
      ],
      evaluationSpec: {
        expectedOutput: `Complete the saved playbook for ${redactSensitiveString(primaryAction)} and return a non-empty result.`,
        requiredTools: enabledTools,
      },
      status:
        options.status && ["active", "paused", "archived"].includes(options.status)
          ? options.status
          : "paused",
      inputSchema,
    },
    plan: applyAgentIntegrationDraftPlan(
      buildAgentDraftPlan(triggerKind, enabledTools, inputSchema),
      integrationMetadata,
    ),
    assumptions: applyAgentIntegrationAssumptions(
      buildAgentDraftAssumptions(triggerKind, enabledTools, inputSchema),
      integrationMetadata,
    ),
    readiness: {
      webhook: webhookReadiness,
    },
  };
}

export async function generateAgentFromPromptAsync(
  context: AuthenticatedContext,
  input: AgentDraftInput,
): Promise<AgentDraftResult> {
  const draft = generateAgentDraftFromPrompt(input.prompt ?? "", {
    providerId: input.providerId,
    model: input.model,
    status: input.status,
  });
  const shouldCreate = Boolean(input.create ?? input.approve);
  if (!shouldCreate) return { draft, created: false };

  const created = await createAgentAsync(context, {
    ...draft.agent,
    status: input.status ?? "active",
  });
  if (!input.runPreview) {
    return { draft, created: true, agent: created.agent };
  }

  const sampleInputs = validateAgentInputs(
    created.agent.inputSchema ?? [],
    input.sampleInputs ?? buildAgentSampleInputs(created.agent.inputSchema ?? []),
  );
  const firstRun = await recordAgentPreviewRun(context, created.agent, sampleInputs);
  return { draft, created: true, agent: created.agent, firstRun, sampleInputs };
}

export async function getAgentAsync(context: AuthenticatedContext, agentId: string) {
  const data = await loadStoreAsync();
  const agent = data.agents.find(
    (entry) => entry.workspaceId === context.workspace.id && entry.id === agentId,
  );
  if (!agent || agent.status === "archived") {
    throw httpError(404, "agent not found");
  }
  const provider = agent.providerId
    ? (data.providers.find(
        (entry) => entry.workspaceId === context.workspace.id && entry.id === agent.providerId,
      ) ?? null)
    : null;

  return {
    agent: decorateAgentWithProvider(agent, provider),
    runs: data.agentRuns
      .filter((entry) => entry.workspaceId === context.workspace.id && entry.agentId === agent.id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 20)
      .map(decorateRun),
  };
}

export async function exportAgentBundleAsync(
  context: AuthenticatedContext,
  agentId: string,
): Promise<{ bundle: AgentWorkerBundle; fileName: string }> {
  const data = await loadStoreAsync();
  const agent = data.agents.find(
    (entry) =>
      entry.workspaceId === context.workspace.id &&
      entry.id === agentId &&
      entry.status !== "archived",
  );
  if (!agent) throw httpError(404, "agent not found");
  const provider = agent.providerId
    ? (data.providers.find(
        (entry) => entry.workspaceId === context.workspace.id && entry.id === agent.providerId,
      ) ?? null)
    : null;
  let bundle: AgentWorkerBundle;
  try {
    bundle = sealAgentWorkerBundle({ agent, provider });
  } catch (error) {
    if (error instanceof AgentWorkerBundleSecretError) {
      throw httpError(409, error.message);
    }
    throw error;
  }
  return {
    bundle,
    fileName: `${portableFileStem(agent.name)}.packetagent-agent.json`,
  };
}

export async function validateAgentBundleImportAsync(
  context: AuthenticatedContext,
  value: unknown,
): Promise<AgentBundleImportPreview> {
  assertAgentBundleBodyBound(value);
  const verification = verifyAgentWorkerBundle(value);
  if (!verification.ok) {
    throw httpError(
      400,
      `agent bundle verification failed: ${verification.issues
        .slice(0, 4)
        .map((entry) => `${entry.path} ${entry.message}`)
        .join("; ")}`,
    );
  }
  const data = await loadStoreAsync();
  const provider = resolvePortableAgentProvider(
    data.providers.filter((entry) => entry.workspaceId === context.workspace.id),
    verification.value.agent.providerHint,
  );
  const registeredTools = new Set(
    getDefaultToolRegistry()
      .list()
      .map((tool) => tool.name),
  );
  return {
    schemaVersion: verification.value.schemaVersion,
    bundleDigest: verification.value.integrity.digest,
    agent: {
      name: verification.value.agent.name,
      triggerKind: verification.value.agent.triggerKind,
      ...(verification.value.agent.schedule ? { schedule: verification.value.agent.schedule } : {}),
      toolCount: verification.value.agent.enabledTools.length,
      inputCount: verification.value.agent.inputSchema.length,
    },
    worker: {
      contentDigest: verification.value.worker.contentDigest,
      status: "draft",
    },
    publisher: {
      ...verification.publisher,
      acknowledgementRequired: verification.publisher.trust === "untrusted",
    },
    readiness: {
      provider: {
        status: provider ? "resolved" : "needs_setup",
        ...(verification.value.agent.providerHint
          ? {
              hint: {
                kind: verification.value.agent.providerHint.kind,
                name: verification.value.agent.providerHint.name,
              },
            }
          : {}),
        ...(provider ? { providerId: provider.id, providerName: provider.name } : {}),
      },
      missingTools: verification.value.agent.enabledTools.filter(
        (tool) => !registeredTools.has(tool),
      ),
    },
    importPolicy: {
      status: "paused",
      credentialsIncluded: false,
      webhookTokenIncluded: false,
      runHistoryIncluded: false,
      localIdsIncluded: false,
    },
  };
}

export async function importAgentBundleAsync(
  context: AuthenticatedContext,
  input: ImportAgentBundleInput,
) {
  const idempotencyKey = String(input.idempotencyKey ?? "").trim();
  if (!idempotencyKey) throw httpError(400, "Idempotency-Key header is required");
  if (idempotencyKey.length > 256) {
    throw httpError(400, "Idempotency-Key header must be at most 256 characters");
  }
  const preview = await validateAgentBundleImportAsync(context, input.bundle);
  const verification = verifyAgentWorkerBundle(input.bundle);
  if (!verification.ok) {
    throw httpError(400, "agent bundle verification failed");
  }
  if (
    verification.publisher.trust === "untrusted" &&
    input.acknowledgeUntrustedPublisher !== true
  ) {
    throw httpError(
      409,
      `publisher ${verification.publisher.keyId} is not configured as trusted; explicitly acknowledge this fingerprint to import`,
    );
  }

  const bundle = verification.value;
  const data = await loadStoreAsync();
  const provider = resolvePortableAgentProvider(
    data.providers.filter((entry) => entry.workspaceId === context.workspace.id),
    bundle.agent.providerHint,
  );
  const normalized = normalizeAgentInput({
    name: bundle.agent.name,
    description: bundle.agent.description,
    instructions: bundle.agent.instructions,
    providerId: provider?.id,
    model: bundle.agent.model,
    tools: [...bundle.agent.tools],
    enabledTools: [...bundle.agent.enabledTools],
    routeKey: bundle.agent.routeKey,
    schedule: bundle.agent.schedule,
    triggerKind: bundle.agent.triggerKind,
    playbook: bundle.agent.playbook.map((entry) => ({ ...entry })),
    memory: bundle.agent.memory.map((entry) => ({ ...entry })),
    evaluationSpec: {
      expectedOutput: bundle.agent.evaluationSpec.expectedOutput,
      requiredTools: [...bundle.agent.evaluationSpec.requiredTools],
    },
    status: "paused",
    inputSchema: bundle.agent.inputSchema.map((entry) => ({
      ...entry,
      ...(entry.options ? { options: [...entry.options] } : {}),
    })),
  });
  const receiptId = agentImportReceiptId(context.workspace.id, idempotencyKey);
  const timestamp = now();
  const result = await mutateStoreAsync((store) => {
    const existingReceipt = store.activities.find((entry) => entry.id === receiptId);
    if (existingReceipt) {
      if (existingReceipt.data.bundleDigest !== bundle.integrity.digest) {
        throw httpError(
          409,
          "Idempotency-Key was already used for a different Agent bundle import",
        );
      }
      const existingAgent = store.agents.find(
        (entry) =>
          entry.workspaceId === context.workspace.id &&
          entry.id === existingReceipt.data.agentId &&
          entry.status !== "archived",
      );
      if (!existingAgent) {
        throw httpError(409, "the prior Agent bundle import receipt no longer has a live Agent");
      }
      const existingProvider = existingAgent.providerId
        ? (store.providers.find(
            (entry) =>
              entry.workspaceId === context.workspace.id && entry.id === existingAgent.providerId,
          ) ?? null)
        : null;
      return {
        agent: decorateAgentWithProvider(existingAgent, existingProvider),
        replayed: true,
      };
    }

    validateProvider(store, context.workspace.id, normalized.providerId);
    const agent = upsertAgent(
      store,
      {
        workspaceId: context.workspace.id,
        name: normalized.name,
        description: normalized.description,
        instructions: normalized.instructions,
        providerId: normalized.providerId,
        model: normalized.model,
        tools: normalized.tools,
        enabledTools: normalized.enabledTools,
        routeKey: normalized.routeKey,
        schedule: normalized.schedule,
        triggerKind: normalized.triggerKind,
        playbook: normalized.playbook,
        memory: normalized.memory,
        evaluationSpec: normalized.evaluationSpec,
        status: "paused",
        inputSchema: normalized.inputSchema,
        createdByUserId: context.user.id,
      },
      timestamp,
    );
    recordActivity(
      store,
      makeActivity(
        context.workspace.id,
        "workspace",
        "agent.created",
        {
          type: "user",
          id: context.user.id,
          displayName: context.user.displayName,
        },
        { title: `Agent imported: ${agent.name}`, agentId: agent.id },
        timestamp,
      ),
    );
    recordActivity(
      store,
      makeActivity(
        context.workspace.id,
        "workspace",
        "agent.bundle_imported",
        {
          type: "user",
          id: context.user.id,
          displayName: context.user.displayName,
        },
        {
          title: `Signed Agent bundle imported: ${agent.name}`,
          agentId: agent.id,
          bundleDigest: bundle.integrity.digest,
          workerContentDigest: bundle.worker.contentDigest,
          publisherKeyId: verification.publisher.keyId,
          publisherTrust:
            verification.publisher.trust === "untrusted"
              ? "acknowledged"
              : verification.publisher.trust,
          status: "paused",
        },
        timestamp,
        receiptId,
      ),
      { dedupe: true },
    );
    return {
      agent: decorateAgentWithProvider(agent, provider),
      replayed: false,
    };
  });
  await reconcileLegacyAgentWorkers(result.agent.id);
  return {
    ...result,
    preview,
  };
}

export function createAgent(context: AuthenticatedContext, input: AgentInput) {
  const normalized = normalizeAgentInput(input);
  const timestamp = now();

  const result = mutateStore((data) => {
    validateProvider(data, context.workspace.id, normalized.providerId);

    const agent = upsertAgent(
      data,
      {
        workspaceId: context.workspace.id,
        name: normalized.name,
        description: normalized.description,
        instructions: normalized.instructions,
        providerId: normalized.providerId,
        model: normalized.model,
        tools: normalized.tools,
        enabledTools: normalized.enabledTools,
        routeKey: normalized.routeKey,
        schedule: normalized.schedule,
        triggerKind: normalized.triggerKind,
        playbook: normalized.playbook,
        memory: normalized.memory,
        evaluationSpec: normalized.evaluationSpec,
        status: normalized.status,
        templateId: normalized.templateId,
        inputSchema: normalized.inputSchema,
        createdByUserId: context.user.id,
      },
      timestamp,
    );

    recordActivity(
      data,
      makeActivity(
        context.workspace.id,
        "workspace",
        "agent.created",
        {
          type: "user",
          id: context.user.id,
          displayName: context.user.displayName,
        },
        { title: `Agent created: ${agent.name}`, agentId: agent.id },
        timestamp,
      ),
    );

    return { agent: decorateAgent(data, agent) };
  });
  maintainScheduledAgentJobs(result.agent.id);
  return result;
}

export async function createAgentAsync(context: AuthenticatedContext, input: AgentInput) {
  const normalized = normalizeAgentInput(input);
  const timestamp = now();

  const result = await mutateStoreAsync((data) => {
    validateProvider(data, context.workspace.id, normalized.providerId);

    const agent = upsertAgent(
      data,
      {
        workspaceId: context.workspace.id,
        name: normalized.name,
        description: normalized.description,
        instructions: normalized.instructions,
        providerId: normalized.providerId,
        model: normalized.model,
        tools: normalized.tools,
        enabledTools: normalized.enabledTools,
        routeKey: normalized.routeKey,
        schedule: normalized.schedule,
        triggerKind: normalized.triggerKind,
        playbook: normalized.playbook,
        memory: normalized.memory,
        evaluationSpec: normalized.evaluationSpec,
        status: normalized.status,
        templateId: normalized.templateId,
        inputSchema: normalized.inputSchema,
        createdByUserId: context.user.id,
      },
      timestamp,
    );

    recordActivity(
      data,
      makeActivity(
        context.workspace.id,
        "workspace",
        "agent.created",
        {
          type: "user",
          id: context.user.id,
          displayName: context.user.displayName,
        },
        { title: `Agent created: ${agent.name}`, agentId: agent.id },
        timestamp,
      ),
    );

    return { agent: decorateAgent(data, agent) };
  });
  await reconcileLegacyAgentWorkers(result.agent.id);
  return result;
}

export function updateAgent(
  context: AuthenticatedContext,
  agentId: string,
  input: Partial<AgentInput>,
) {
  const timestamp = now();

  const result = mutateStore((data) => {
    const existing = findAgent(data, agentId);
    if (
      !existing ||
      existing.workspaceId !== context.workspace.id ||
      existing.status === "archived"
    ) {
      throw httpError(404, "agent not found");
    }

    const normalized = normalizeAgentInput(mergeAgentUpdateInput(existing, input));
    validateProvider(data, context.workspace.id, normalized.providerId);

    const agent = upsertAgent(
      data,
      {
        ...existing,
        name: normalized.name,
        description: normalized.description,
        instructions: normalized.instructions,
        providerId: normalized.providerId,
        model: normalized.model,
        tools: normalized.tools,
        enabledTools: normalized.enabledTools,
        routeKey: normalized.routeKey,
        schedule: normalized.schedule,
        triggerKind: normalized.triggerKind,
        playbook: normalized.playbook,
        memory: normalized.memory,
        evaluationSpec: normalized.evaluationSpec,
        status: normalized.status,
        templateId: normalized.templateId ?? existing.templateId,
        inputSchema: normalized.inputSchema,
      },
      timestamp,
    );

    recordActivity(
      data,
      makeActivity(
        context.workspace.id,
        "workspace",
        "agent.updated",
        {
          type: "user",
          id: context.user.id,
          displayName: context.user.displayName,
        },
        { title: `Agent updated: ${agent.name}`, agentId: agent.id },
        timestamp,
      ),
    );

    return { agent: decorateAgent(data, agent) };
  });
  maintainScheduledAgentJobs(result.agent.id);
  return result;
}

export async function updateAgentAsync(
  context: AuthenticatedContext,
  agentId: string,
  input: Partial<AgentInput>,
) {
  const timestamp = now();

  const result = await mutateStoreAsync((data) => {
    const existing = findAgent(data, agentId);
    if (
      !existing ||
      existing.workspaceId !== context.workspace.id ||
      existing.status === "archived"
    ) {
      throw httpError(404, "agent not found");
    }

    const normalized = normalizeAgentInput(mergeAgentUpdateInput(existing, input));
    validateProvider(data, context.workspace.id, normalized.providerId);

    const agent = upsertAgent(
      data,
      {
        ...existing,
        name: normalized.name,
        description: normalized.description,
        instructions: normalized.instructions,
        providerId: normalized.providerId,
        model: normalized.model,
        tools: normalized.tools,
        enabledTools: normalized.enabledTools,
        routeKey: normalized.routeKey,
        schedule: normalized.schedule,
        triggerKind: normalized.triggerKind,
        playbook: normalized.playbook,
        memory: normalized.memory,
        evaluationSpec: normalized.evaluationSpec,
        status: normalized.status,
        templateId: normalized.templateId ?? existing.templateId,
        inputSchema: normalized.inputSchema,
      },
      timestamp,
    );

    recordActivity(
      data,
      makeActivity(
        context.workspace.id,
        "workspace",
        "agent.updated",
        {
          type: "user",
          id: context.user.id,
          displayName: context.user.displayName,
        },
        { title: `Agent updated: ${agent.name}`, agentId: agent.id },
        timestamp,
      ),
    );

    return { agent: decorateAgent(data, agent) };
  });
  await reconcileLegacyAgentWorkers(result.agent.id);
  return result;
}

export function archiveAgent(context: AuthenticatedContext, agentId: string) {
  const timestamp = now();

  const result = mutateStore((data) => {
    const existing = findAgent(data, agentId);
    if (
      !existing ||
      existing.workspaceId !== context.workspace.id ||
      existing.status === "archived"
    ) {
      throw httpError(404, "agent not found");
    }

    const agent = upsertAgent(
      data,
      {
        ...existing,
        status: "archived",
        archivedAt: timestamp,
      },
      timestamp,
    );

    recordActivity(
      data,
      makeActivity(
        context.workspace.id,
        "workspace",
        "agent.archived",
        {
          type: "user",
          id: context.user.id,
          displayName: context.user.displayName,
        },
        { title: `Agent archived: ${agent.name}`, agentId: agent.id },
        timestamp,
      ),
    );

    return { agent: decorateAgent(data, agent) };
  });
  maintainScheduledAgentJobs(result.agent.id);
  return result;
}

export async function archiveAgentAsync(context: AuthenticatedContext, agentId: string) {
  const timestamp = now();

  const result = await mutateStoreAsync((data) => {
    const existing = findAgent(data, agentId);
    if (
      !existing ||
      existing.workspaceId !== context.workspace.id ||
      existing.status === "archived"
    ) {
      throw httpError(404, "agent not found");
    }

    const agent = upsertAgent(
      data,
      {
        ...existing,
        status: "archived",
        archivedAt: timestamp,
      },
      timestamp,
    );

    recordActivity(
      data,
      makeActivity(
        context.workspace.id,
        "workspace",
        "agent.archived",
        {
          type: "user",
          id: context.user.id,
          displayName: context.user.displayName,
        },
        { title: `Agent archived: ${agent.name}`, agentId: agent.id },
        timestamp,
      ),
    );

    return { agent: decorateAgent(data, agent) };
  });
  await reconcileLegacyAgentWorkers(result.agent.id);
  return result;
}

export interface RunAgentInput {
  triggerKind?: string;
  inputs?: Record<string, unknown>;
  toolApproval?: RunAgentToolApprovalPayload | null;
  evaluation?: { kind: "first_run" } | null;
  idempotencyKey?: string;
}

export type RunAgentToolApprovalPayload = Partial<ToolCapabilityApprovalInput> & {
  approvalToken?: string;
  tools?: unknown;
};

export type RunAgentResult =
  | { run: ReturnType<typeof decorateRun> }
  | { approval: ToolCapabilityApprovalRequest };

export async function runAgent(
  context: AuthenticatedContext,
  agentId: string,
  input?: Omit<RunAgentInput, "toolApproval">,
): Promise<{ run: ReturnType<typeof decorateRun> }>;
export async function runAgent(
  context: AuthenticatedContext,
  agentId: string,
  input: RunAgentInput,
): Promise<RunAgentResult>;
export async function runAgent(
  context: AuthenticatedContext,
  agentId: string,
  input: RunAgentInput = {},
): Promise<RunAgentResult> {
  const timestamp = now();
  const requestedTriggerRaw = stringOrUndefined(input?.triggerKind);
  const triggerKind: AgentTriggerKind =
    requestedTriggerRaw && (TRIGGER_KINDS as string[]).includes(requestedTriggerRaw)
      ? (requestedTriggerRaw as AgentTriggerKind)
      : "manual";
  const rawInputs: Record<string, unknown> = input?.inputs ?? {};

  const data = await loadStoreAsync();
  const agent = findAgent(data, agentId);
  if (!agent || agent.workspaceId !== context.workspace.id || agent.status === "archived") {
    throw httpError(404, "agent not found");
  }
  const inputs = validateAgentInputs(agent.inputSchema ?? [], rawInputs);
  const enabledTools = agent.enabledTools ?? [];
  const firstRunExpectedInputs =
    input.evaluation?.kind === "first_run" ? agentExampleInputs(agent) : undefined;
  const requiresLaunchReview = enabledTools.length > 0 || firstRunExpectedInputs !== undefined;

  if (requiresLaunchReview) {
    if (getToolApprovalDecision(input.toolApproval) === "cancel") {
      const { run } = await recordCanceledAgentExecutionRun({
        context,
        agent,
        inputs,
        triggerKind,
        timestamp,
      });
      return finalizeAgentRun({
        context,
        agent,
        run,
        expectedInputs: firstRunExpectedInputs,
      });
    }

    const registeredEnabledTools = resolveRegisteredToolDefinitions(enabledTools);
    if (triggerKind === "manual" && registeredEnabledTools.length > 0) {
      const approvalInput = buildToolCapabilityApprovalContext({
        context,
        agent,
        inputs,
        triggerKind,
        tools: registeredEnabledTools,
      });
      const hasLaunchApproval = await hasValidToolLaunchApproval(input.toolApproval, approvalInput);
      if (!hasLaunchApproval) {
        return { approval: await buildAgentToolCapabilityApprovalRequest(approvalInput) };
      }
    }
    const registeredToolNames = new Set(
      registeredEnabledTools.map((definition) => definition.name),
    );
    const missingTools = enabledTools.filter((toolName) => !registeredToolNames.has(toolName));
    if (missingTools.length > 0) {
      const error = `Agent execution setup required: Enabled tools are not registered in the runtime: ${missingTools.join(", ")}.`;
      const { run } = await recordFailedAgentExecutionRun({
        context,
        agent,
        inputs,
        triggerKind,
        timestamp,
        runId: generateId(),
        logs: [{ at: timestamp, level: "error", message: error }],
        error,
      });
      return finalizeAgentRun({
        context,
        agent,
        run,
        expectedInputs: firstRunExpectedInputs,
      });
    }
  }

  const execution = await executeLegacyAgentCanonically({
    context,
    agent,
    inputs,
    triggerKind,
    idempotencyKey: input.idempotencyKey,
  });
  if (!execution.replayed) {
    await mutateStoreAsync((store) => {
      recordActivity(
        store,
        makeActivity(
          context.workspace.id,
          "workspace",
          "agent.run",
          {
            type: "user",
            id: context.user.id,
            displayName: context.user.displayName,
          },
          {
            title: execution.run.title,
            agentId: agent.id,
            runId: execution.run.id,
            workerRunId: execution.run.workerRunId,
            status: execution.run.status,
            triggerKind,
          },
          timestamp,
        ),
      );
    });
  }
  return finalizeAgentRun({
    context,
    agent,
    run: execution.run,
    expectedInputs: firstRunExpectedInputs,
  });
}

function agentExampleInputs(agent: AgentRecord): Record<string, string | number | boolean> {
  const raw = Object.fromEntries(
    (agent.inputSchema ?? []).flatMap((field) =>
      field.exampleValue === undefined ? [] : [[field.key, field.exampleValue]],
    ),
  );
  return validateAgentInputs(agent.inputSchema ?? [], raw);
}

async function finalizeAgentRun(input: {
  context: AuthenticatedContext;
  agent: AgentRecord;
  run: AgentRunRecord;
  expectedInputs?: Record<string, string | number | boolean>;
}): Promise<{ run: ReturnType<typeof decorateRun> }> {
  if (!input.expectedInputs) return { run: decorateRun(input.run) };
  const evaluation = buildAgentFirstRunEvaluation({
    run: input.run,
    expectedInputs: input.expectedInputs,
    spec: input.agent.evaluationSpec ?? {
      expectedOutput: "",
      requiredTools: [],
    },
  });
  const run = await mutateStoreAsync((store) => {
    const stored = store.agentRuns.find(
      (entry) => entry.id === input.run.id && entry.workspaceId === input.context.workspace.id,
    );
    if (!stored) throw httpError(404, "agent run not found after first-run evaluation");
    return upsertAgentRun(
      store,
      {
        ...stored,
        evaluation,
      },
      evaluation.evaluatedAt,
    );
  });
  return { run: decorateRun(run) };
}

type AgentToolCapabilityApprovalContext = {
  workspaceId: string;
  workspaceName: string;
  userId: string;
  agentId: string;
  agentName: string;
  triggerKind: AgentTriggerKind;
  inputs: Record<string, string | number | boolean>;
  tools: Array<Pick<ToolDefinition, "name" | "description" | "side" | "inputSchema">>;
};

function resolveRegisteredToolDefinitions(toolNames: string[]): ToolDefinition[] {
  const registry = getDefaultToolRegistry();
  const seen = new Set<string>();
  const tools: ToolDefinition[] = [];
  for (const toolName of toolNames) {
    if (seen.has(toolName)) continue;
    seen.add(toolName);
    const definition = registry.get(toolName);
    if (definition) tools.push(definition);
  }
  return tools;
}

function buildToolCapabilityApprovalContext(input: {
  context: AuthenticatedContext;
  agent: AgentRecord;
  inputs: Record<string, string | number | boolean>;
  triggerKind: AgentTriggerKind;
  tools: ToolDefinition[];
}): AgentToolCapabilityApprovalContext {
  return {
    workspaceId: input.context.workspace.id,
    workspaceName: input.context.workspace.name,
    userId: input.context.user.id,
    agentId: input.agent.id,
    agentName: input.agent.name,
    triggerKind: input.triggerKind,
    inputs: input.inputs,
    tools: input.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      side: tool.side,
      inputSchema: tool.inputSchema,
    })),
  };
}

async function buildAgentToolCapabilityApprovalRequest(
  input: AgentToolCapabilityApprovalContext,
): Promise<ToolCapabilityApprovalRequest> {
  const { buildToolCapabilityApprovalRequest } = await import("../tools/approval.js");
  return Promise.resolve(
    buildToolCapabilityApprovalRequest({
      workspaceId: input.workspaceId,
      userId: input.userId,
      agentId: input.agentId,
      triggerKind: input.triggerKind,
      tools: input.tools,
      inputs: input.inputs,
    }),
  );
}

async function hasValidToolLaunchApproval(
  toolApproval: RunAgentToolApprovalPayload | null | undefined,
  approvalInput: AgentToolCapabilityApprovalContext,
): Promise<boolean> {
  if (!toolApproval || getToolApprovalDecision(toolApproval) !== "launch") return false;
  try {
    const { verifyToolCapabilityApproval } = await import("../tools/approval.js");
    const result = await Promise.resolve(
      verifyToolCapabilityApproval(normalizeToolApprovalPayload(toolApproval), {
        workspaceId: approvalInput.workspaceId,
        userId: approvalInput.userId,
        agentId: approvalInput.agentId,
        triggerKind: approvalInput.triggerKind,
        tools: approvalInput.tools,
        inputs: approvalInput.inputs,
        consume: true,
      }),
    );
    return approvalVerificationPassed(result);
  } catch {
    return false;
  }
}

function normalizeToolApprovalPayload(
  toolApproval: RunAgentToolApprovalPayload,
): ToolCapabilityApprovalInput {
  const approval = toolApproval as RunAgentToolApprovalPayload & { approvalToken?: unknown };
  const token =
    typeof approval.token === "string"
      ? approval.token
      : typeof approval.approvalToken === "string"
        ? approval.approvalToken
        : "";
  const approvedTools = Array.isArray(approval.approvedTools)
    ? approval.approvedTools
    : Array.isArray(approval.tools)
      ? approval.tools
          .map((tool) =>
            typeof tool === "object" && tool !== null && "name" in tool
              ? String((tool as { name: unknown }).name)
              : "",
          )
          .filter(Boolean)
      : [];
  return {
    decision: approval.decision as ToolCapabilityApprovalInput["decision"],
    token,
    approvedTools,
  };
}

function getToolApprovalDecision(
  toolApproval: RunAgentToolApprovalPayload | null | undefined,
): string | undefined {
  if (!toolApproval || typeof toolApproval !== "object") return undefined;
  const decision = (toolApproval as { decision?: unknown }).decision;
  return typeof decision === "string" ? decision : undefined;
}

function approvalVerificationPassed(result: unknown): boolean {
  if (typeof result === "boolean") return result;
  if (!result || typeof result !== "object") return false;
  const verification = result as {
    ok?: unknown;
    valid?: unknown;
    approved?: unknown;
    verified?: unknown;
  };
  if (typeof verification.ok === "boolean") return verification.ok;
  if (typeof verification.valid === "boolean") return verification.valid;
  if (typeof verification.approved === "boolean") return verification.approved;
  if (typeof verification.verified === "boolean") return verification.verified;
  return false;
}

async function recordCanceledAgentExecutionRun(input: {
  context: AuthenticatedContext;
  agent: AgentRecord;
  inputs: Record<string, string | number | boolean>;
  triggerKind: AgentTriggerKind;
  timestamp: string;
}): Promise<{ run: AgentRunRecord }> {
  const completedAt = new Date().toISOString();
  const message = "Tool run was canceled before execution.";
  return mutateStoreAsync((store) => {
    const run = upsertAgentRun(
      store,
      {
        workspaceId: input.context.workspace.id,
        agentId: input.agent.id,
        title: `${input.agent.name} run canceled`,
        status: "canceled",
        triggerKind: input.triggerKind,
        startedAt: input.timestamp,
        completedAt,
        inputs: Object.keys(input.inputs).length ? input.inputs : undefined,
        transcript: [
          {
            id: generateId(),
            title: "Approve tool execution",
            status: "skipped",
            output: message,
            durationMs: 0,
            startedAt: input.timestamp,
          },
          ...(input.agent.playbook ?? []).map((step) => ({
            id: generateId(),
            title: step.title,
            status: "skipped" as const,
            output: message,
            durationMs: 0,
            startedAt: input.timestamp,
          })),
        ],
        error: message,
        logs: [{ at: input.timestamp, level: "warn", message }],
        toolCalls: [],
      },
      input.timestamp,
    );

    recordActivity(
      store,
      makeActivity(
        input.context.workspace.id,
        "workspace",
        "agent.run",
        {
          type: "user",
          id: input.context.user.id,
          displayName: input.context.user.displayName,
        },
        {
          title: run.title,
          agentId: input.agent.id,
          runId: run.id,
          status: run.status,
          triggerKind: input.triggerKind,
        },
        input.timestamp,
      ),
    );

    return { run };
  });
}

async function recordFailedAgentExecutionRun(input: {
  context: AuthenticatedContext;
  agent: AgentRecord;
  inputs: Record<string, string | number | boolean>;
  triggerKind: AgentTriggerKind;
  timestamp: string;
  runId: string;
  logs: AgentRunLogEntry[];
  error: string;
}): Promise<{ run: AgentRunRecord }> {
  const completedAt = new Date().toISOString();
  return mutateStoreAsync((store) => {
    const run = upsertAgentRun(
      store,
      {
        id: input.runId,
        workspaceId: input.context.workspace.id,
        agentId: input.agent.id,
        title: `${input.agent.name} setup required`,
        status: "failed",
        triggerKind: input.triggerKind,
        startedAt: input.timestamp,
        completedAt,
        inputs: Object.keys(input.inputs).length ? input.inputs : undefined,
        transcript: [
          {
            id: generateId(),
            title: "Resolve execution setup",
            status: "failed",
            output: input.error,
            durationMs: 0,
            startedAt: input.timestamp,
          },
          ...(input.agent.playbook ?? []).map((step) => ({
            id: generateId(),
            title: step.title,
            status: "skipped" as const,
            output: "Skipped because agent execution setup is incomplete.",
            durationMs: 0,
            startedAt: input.timestamp,
          })),
        ],
        error: input.error,
        logs: input.logs,
        toolCalls: [],
      },
      input.timestamp,
    );

    recordActivity(
      store,
      makeActivity(
        input.context.workspace.id,
        "workspace",
        "agent.run",
        {
          type: "user",
          id: input.context.user.id,
          displayName: input.context.user.displayName,
        },
        {
          title: run.title,
          agentId: input.agent.id,
          runId: run.id,
          status: run.status,
          triggerKind: input.triggerKind,
        },
        input.timestamp,
      ),
    );

    return { run };
  });
}

function buildDryRunTranscript(
  playbook: AgentPlaybookStep[],
  timestamp: string,
  label = "Dry run",
): AgentRunStep[] {
  if (playbook.length === 0) {
    return [
      {
        id: generateId(),
        title: "Plan instructions",
        status: "success",
        output: `${label} only: instructions were not sent to a model and no runtime tools were invoked.`,
        durationMs: 60,
        startedAt: timestamp,
      },
    ];
  }

  return playbook.map((step) => ({
    id: generateId(),
    title: step.title,
    status: "success",
    output: step.instruction
      ? `${label} only: would run "${step.instruction.slice(0, 160)}".`
      : `${label} only: step was planned but not executed.`,
    durationMs: 60,
    startedAt: timestamp,
  }));
}

export async function generateAgentBuilderDraftAsync(
  context: AuthenticatedContext,
  input: AgentBuilderPromptInput,
  dependencies: AgentBuilderDraftDependencies = {},
): Promise<AgentBuilderDraft> {
  const prompt = String(input.prompt ?? "").trim();
  if (prompt.length < 12) throw httpError(400, "prompt must be at least 12 characters");
  if (prompt.length > 2_000) throw httpError(400, "prompt must be 2000 characters or fewer");

  const data = await loadStoreAsync();
  const providers = data.providers
    .filter(
      (provider) => provider.workspaceId === context.workspace.id && provider.status !== "disabled",
    )
    .sort(
      (left, right) =>
        Number(right.status === "connected") - Number(left.status === "connected") ||
        left.name.localeCompare(right.name),
    );
  const registeredTools = getDefaultToolRegistry()
    .list()
    .map((tool) => tool.name);
  const availableTools = (
    registeredTools.length > 0
      ? registeredTools
      : listDefaultToolSummaries().map((tool) => tool.name)
  ).sort();
  const intent = inferAgentBuilderIntent(prompt);
  const heuristicRecommendedTools = recommendAgentTools(intent, prompt, availableTools);
  const heuristicInputSchema = buildAgentBuilderInputSchema(intent, prompt);
  const integrationMetadata = buildAgentPhase71IntegrationMetadata(prompt);
  const triggerKind = inferAgentTriggerKind(intent, prompt);
  const schedule = triggerKind === "schedule" ? inferAgentSchedule(prompt) : undefined;
  const webhookReadiness = buildAgentBuilderWebhookReadiness(triggerKind);
  const scheduleReadiness = buildAgentBuilderScheduleReadiness(triggerKind, schedule);
  const providerContext = await (
    dependencies.resolveProviderContext ?? resolveAgentBuilderProviderContext
  )({
    workspaceId: context.workspace.id,
    preset: input.preset,
  });
  const generated = await (dependencies.generateTemplate ?? generateAgentTemplateViaLlm)(
    {
      prompt,
      workspaceId: context.workspace.id,
      preset: input.preset,
      allowedTools: availableTools,
      recommendedTools: heuristicRecommendedTools,
      triggerKind,
      schedule,
    },
    {
      ...(providerContext.selected?.instance
        ? { provider: providerContext.selected.instance }
        : {}),
      ...(providerContext.selected?.model ? { model: providerContext.selected.model } : {}),
      vaultProviders: providerContext.vaultProviders,
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
  const authoredTemplate = generated.source === "llm" ? generated.template : undefined;
  const recommendedTools = [
    ...new Set([...heuristicRecommendedTools, ...(authoredTemplate?.tools ?? [])]),
  ];
  const inputSchema =
    authoredTemplate && authoredTemplate.inputSchema.length > 0
      ? authoredTemplate.inputSchema.map((field) => ({
          ...field,
          ...(field.options ? { options: [...field.options] } : {}),
        }))
      : heuristicInputSchema;
  const sampleInputs = buildAgentSampleInputs(inputSchema);
  const name = authoredTemplate?.name ?? buildAgentBuilderName(prompt, intent);
  const playbook = applyAgentIntegrationPlaybookSteps(
    authoredTemplate
      ? authoredTemplate.playbook.map((step) => ({ ...step }))
      : buildAgentBuilderPlaybook(intent, prompt),
    integrationMetadata,
  );
  const providerReadiness = buildAgentBuilderProviderReadiness(providerContext, {
    requiresToolUse: recommendedTools.length > 0,
    authoringUsesLlm: generated.source === "llm",
  });
  const selectedProvider = providerContext.selected
    ? (providers.find(
        (provider) =>
          provider.kind === providerContext.selected?.provider &&
          isProviderReadyForAgentRuns(data, context.workspace.id, provider),
      ) ?? null)
    : null;
  const missingTools = recommendedTools.filter((tool) => !availableTools.includes(tool));
  const enabledRuntimeTools = recommendedTools.filter((tool) => availableTools.includes(tool));
  const blockers = [
    ...providerReadiness.blockers,
    ...(missingTools.length > 0
      ? [`Remove or implement missing tools: ${missingTools.join(", ")}.`]
      : []),
  ];
  const acceptanceChecks = [
    "Agent draft is saved with generated instructions, input schema, tools, and trigger.",
    "Missing provider or tool setup is visible before first run.",
    ...(authoredTemplate?.acceptanceChecks ?? []),
    ...integrationMetadata.requested.map(
      (integration) =>
        `${integration.label} flow references ${integration.envVars.join(", ")} and remains draft-safe until setup is complete.`,
    ),
    "First test run records output, logs, transcript, tool calls, and a deterministic evaluation.",
  ];

  return {
    prompt,
    intent,
    summary: authoredTemplate?.summary ?? `${name} will ${summarizeAgentPrompt(prompt)}`,
    authoring:
      generated.source === "llm"
        ? {
            source: "llm",
            provider: generated.provider,
            model: generated.model,
            category: generated.template.category,
          }
        : {
            source: "heuristic",
            fallbackReason: generated.fallbackReason,
          },
    integrationMetadata,
    agent: {
      name,
      description: authoredTemplate?.description ?? summarizeAgentPrompt(prompt),
      instructions: applyAgentIntegrationInstructions(
        authoredTemplate?.instructions ?? buildAgentBuilderInstructions(prompt, intent),
        integrationMetadata,
      ),
      providerId: selectedProvider?.id,
      model: providerContext.selected?.model,
      tools: recommendedTools,
      enabledTools: enabledRuntimeTools,
      routeKey: providerContext.selected
        ? agentProviderRouteKey(providerContext.selected.provider)
        : "agent.reasoning",
      triggerKind,
      schedule,
      playbook,
      memory: buildAgentBuilderMemory(intent, acceptanceChecks),
      evaluationSpec: {
        expectedOutput: acceptanceChecks.join(" ").slice(0, 1_200),
        requiredTools: enabledRuntimeTools,
      },
      status: "active",
      inputSchema,
    },
    sampleInputs,
    plan: {
      title: `Build ${name}`,
      steps: [
        {
          title: "Capture the job",
          detail:
            "Turn the prompt into clear agent instructions, typed inputs, and a first-run sample.",
        },
        {
          title: "Wire useful tools",
          detail:
            recommendedTools.length > 0
              ? `Enable ${recommendedTools.join(", ")} for the first run.`
              : "Keep the first draft tool-light until an integration is selected.",
        },
        ...buildAgentBuilderIntegrationPlanSteps(integrationMetadata),
        {
          title: "Choose the trigger",
          detail:
            triggerKind === "schedule"
              ? scheduleReadiness.planDetail
              : triggerKind === "webhook"
                ? webhookReadiness.planDetail
                : "Start with manual runs while the draft is validated.",
        },
        ...(triggerKind === "webhook"
          ? [{ title: "Prepare webhook publish readiness", detail: webhookReadiness.message }]
          : []),
        {
          title: "Run once",
          detail:
            "Save the draft, run it with sample inputs, then inspect transcript, tool calls, and output.",
        },
      ],
      acceptanceChecks,
      openQuestions:
        authoredTemplate && authoredTemplate.openQuestions.length > 0
          ? [...authoredTemplate.openQuestions]
          : buildAgentBuilderOpenQuestions(intent, prompt),
    },
    readiness: {
      provider: {
        ...providerReadiness,
        ...(selectedProvider
          ? {
              selectedProviderId: selectedProvider.id,
            }
          : {}),
      },
      tools: {
        recommended: recommendedTools,
        available: recommendedTools.filter((tool) => availableTools.includes(tool)),
        missing: missingTools,
        message:
          missingTools.length === 0
            ? "Recommended tools are available in this workspace runtime."
            : `Some requested tools are not registered yet: ${missingTools.join(", ")}.`,
      },
      webhook: webhookReadiness,
      schedule: scheduleReadiness,
      firstRun: {
        canRun: blockers.length === 0,
        blockers,
        message:
          blockers.length === 0
            ? "Ready to save and run with the generated sample inputs."
            : "The draft can be saved now, but resolve setup blockers before expecting real execution.",
      },
    },
  };
}

export async function approveAgentBuilderDraftAsync(
  context: AuthenticatedContext,
  input: AgentBuilderApproveInput,
  dependencies: AgentBuilderDraftDependencies = {},
): Promise<AgentBuilderApproveResult> {
  const generatedDraft =
    input.draft ??
    (await generateAgentBuilderDraftAsync(context, { prompt: input.prompt }, dependencies));
  const sampleInputs = validateAgentInputs(
    generatedDraft.agent.inputSchema ?? [],
    input.sampleInputs ?? generatedDraft.sampleInputs ?? {},
  );
  const draft: AgentBuilderDraft = {
    ...generatedDraft,
    sampleInputs,
    agent: {
      ...generatedDraft.agent,
      inputSchema: generatedDraft.agent.inputSchema.map((field) => ({
        ...field,
        ...(field.key in sampleInputs
          ? { exampleValue: formatInputValue(sampleInputs[field.key]) }
          : {}),
      })),
    },
  };
  const created = await createAgentAsync(context, {
    ...draft.agent,
    status: input.status ?? draft.agent.status ?? "active",
  });

  if (!input.runPreview) {
    return { draft, created: true, agent: created.agent, sampleInputs };
  }
  if (!draft.readiness.firstRun.canRun) {
    return { draft, created: true, agent: created.agent, sampleInputs };
  }

  const firstRunResult = await runAgent(context, created.agent.id, {
    triggerKind: "manual",
    inputs: sampleInputs,
    toolApproval: null,
    evaluation: { kind: "first_run" },
  });
  if ("approval" in firstRunResult) {
    return {
      draft,
      created: true,
      agent: created.agent,
      firstRunApproval: firstRunResult.approval,
      sampleInputs,
    };
  }
  return {
    draft,
    created: true,
    agent: created.agent,
    firstRun: firstRunResult.run,
    sampleInputs,
  };
}

async function recordAgentPreviewRun(
  context: AuthenticatedContext,
  agent: Pick<AgentRecord, "id" | "name" | "playbook">,
  inputs: Record<string, string | number | boolean>,
) {
  const timestamp = now();
  return mutateStoreAsync((store) => {
    const liveAgent = findAgent(store, agent.id);
    if (
      !liveAgent ||
      liveAgent.workspaceId !== context.workspace.id ||
      liveAgent.status === "archived"
    ) {
      throw httpError(404, "agent not found");
    }

    const run = upsertAgentRun(
      store,
      {
        workspaceId: context.workspace.id,
        agentId: liveAgent.id,
        title: `${liveAgent.name} preview dry run recorded`,
        status: "success",
        triggerKind: "manual",
        transcript: buildDryRunTranscript(liveAgent.playbook ?? [], timestamp, "Preview dry run"),
        startedAt: timestamp,
        completedAt: timestamp,
        inputs: Object.keys(inputs).length ? inputs : undefined,
        output: buildDryRunOutput(liveAgent.name, inputs, "Preview dry run"),
        logs: [
          {
            at: timestamp,
            level: "info",
            message: `Preview dry run started for ${liveAgent.name}.`,
          },
          {
            at: timestamp,
            level: "info",
            message: "Sample inputs generated for first-run visibility.",
          },
          {
            at: timestamp,
            level: "info",
            message: "Preview run recorded locally without invoking tools or a model.",
          },
        ],
      },
      timestamp,
    );

    recordActivity(
      store,
      makeActivity(
        context.workspace.id,
        "workspace",
        "agent.run.preview",
        {
          type: "user",
          id: context.user.id,
          displayName: context.user.displayName,
        },
        {
          title: run.title,
          agentId: liveAgent.id,
          runId: run.id,
          status: run.status,
          triggerKind: run.triggerKind,
        },
        timestamp,
      ),
    );

    return decorateRun(run);
  });
}

function buildAgentPhase71IntegrationMetadata(prompt: string): Phase71IntegrationMetadata {
  const requested = detectPhase71Integrations(prompt);
  return {
    requested,
    setupGuidance: requested.flatMap((integration) => integration.setupGuidance),
  };
}

function applyAgentIntegrationInstructions(
  instructions: string,
  metadata: Phase71IntegrationMetadata,
): string {
  if (metadata.requested.length === 0) return instructions;
  return [
    instructions,
    "",
    "Phase 71 integration setup:",
    ...metadata.requested.map(
      (integration) =>
        `- ${integration.label}: reference ${integration.envVars.join(", ")} and keep unrelated features draft-safe if setup is missing.`,
    ),
  ].join("\n");
}

function applyAgentIntegrationPlaybookSteps(
  playbook: AgentPlaybookStep[],
  metadata: Phase71IntegrationMetadata,
): AgentPlaybookStep[] {
  if (metadata.requested.length === 0) return playbook;
  const integrationSteps = metadata.requested.map(
    (integration): AgentPlaybookStep => ({
      id: `integration-${integration.id}`,
      title: `Prepare ${integration.label}`,
      instruction: `${integration.flows.join(" ")} Required setup references: ${integration.envVars.join(", ")}.`,
    }),
  );
  return [playbook[0], ...integrationSteps, ...playbook.slice(1)].filter(Boolean);
}

function applyAgentIntegrationDraftPlan(
  plan: AgentDraftPlanItem[],
  metadata: Phase71IntegrationMetadata,
): AgentDraftPlanItem[] {
  if (metadata.requested.length === 0) return plan;
  return [
    ...plan,
    ...metadata.requested.map(
      (integration): AgentDraftPlanItem => ({
        title: `Configure ${integration.label}`,
        detail: `${integration.setupGuidance.join(" ")} Generated flow: ${integration.flows[0]}`,
        status: "todo",
      }),
    ),
  ];
}

function applyAgentIntegrationAssumptions(
  assumptions: string[],
  metadata: Phase71IntegrationMetadata,
): string[] {
  if (metadata.requested.length === 0) return assumptions;
  return [
    ...assumptions,
    ...metadata.requested.map(
      (integration) =>
        `${integration.label} can be drafted before setup; live calls require ${integration.envVars.join(", ")}.`,
    ),
  ];
}

function buildAgentBuilderIntegrationPlanSteps(
  metadata: Phase71IntegrationMetadata,
): Array<{ title: string; detail: string }> {
  return metadata.requested.map((integration) => ({
    title: `Prepare ${integration.label}`,
    detail: `${integration.flows[0]} Setup references: ${integration.envVars.join(", ")}.`,
  }));
}

function inferAgentBuilderIntent(prompt: string): string {
  const lower = prompt.toLowerCase();
  if (/\b(support|ticket|inbox|customer|reply)\b/.test(lower)) return "support";
  if (/\b(lead|sales|crm|enrich|prospect)\b/.test(lower)) return "lead_enrichment";
  if (/\b(release|audit|validation|evidence)\b/.test(lower)) return "release";
  if (/\b(research|summarize|web|url|scrape|competitor)\b/.test(lower)) return "research";
  if (/\b(report|brief|digest|daily|weekly|summary)\b/.test(lower)) return "reporting";
  if (/\b(slack|discord|webhook|notify|message)\b/.test(lower)) return "notification";
  return "custom";
}

function inferAgentTriggerKind(intent: string, prompt: string): AgentTriggerKind {
  const lower = prompt.toLowerCase();
  if (/\b(webhook|incoming|when.*received|on event|external trigger)\b/.test(lower))
    return "webhook";
  if (/\b(daily|weekly|hourly|every|schedule|morning|nightly|cron)\b/.test(lower))
    return "schedule";
  if (/\b(email|inbox|mailbox)\b/.test(lower) && intent === "support") return "email";
  return "manual";
}

function inferAgentSchedule(prompt: string): string {
  const lower = prompt.toLowerCase();
  if (/\bweekly|friday\b/.test(lower)) return "0 16 * * 5";
  if (/\bhourly\b/.test(lower)) return "0 * * * *";
  if (/\bevery 15|quarter-hour|inbox\b/.test(lower)) return "*/15 * * * *";
  if (/\bnightly|overnight\b/.test(lower)) return "0 2 * * *";
  return "0 8 * * 1-5";
}

function recommendAgentTools(intent: string, prompt: string, availableTools: string[]): string[] {
  const lower = prompt.toLowerCase();
  const desired = new Set<string>();
  if (
    ["research", "lead_enrichment"].includes(intent) ||
    /\b(url|website|web|scrape|research|fetch)\b/.test(lower)
  )
    desired.add("http_fetch");
  if (/\b(slack|notify|notification|message|webhook)\b/.test(lower))
    desired.add("slack_post_webhook");
  if (/\b(github|pull request|pull requests|\bpr\b|\bprs\b|issue|issues|comment)\b/.test(lower))
    desired.add("github_api");
  if (/\b(email|mail|inbox|reply|send)\b/.test(lower)) desired.add("email_send");
  if (/\b(sql|sqlite|database|table|query)\b/.test(lower)) desired.add("sql_query");
  if (/\b(shell|command|script|terminal|npm|git)\b/.test(lower)) desired.add("shell_for_agent");
  if (
    ["reporting", "release"].includes(intent) ||
    /\b(workflow|requirement|plan|blocker|release)\b/.test(lower)
  ) {
    desired.add("read_workflow_brief");
    desired.add("list_requirements");
    desired.add("list_plan_items");
    desired.add("list_blockers");
  }
  if (/\b(blocker|risk|incident|escalat|urgent)\b/.test(lower)) desired.add("list_blockers");
  if (/\b(agent|run|runs)\b/.test(lower)) {
    desired.add("list_agents");
    desired.add("list_recent_runs");
  }
  if (/\b(create task|open blocker|log note|write|update)\b/.test(lower)) desired.add("log_note");
  if (/\b(browser|click|page|form)\b/.test(lower)) {
    for (const tool of availableTools.filter((name) => name.startsWith("browser_")))
      desired.add(tool);
  }
  return [...desired].slice(0, 8);
}

function buildAgentBuilderInputSchema(intent: string, prompt: string): AgentInputField[] {
  const lower = prompt.toLowerCase();
  if (intent === "support") {
    return [
      {
        key: "mailbox",
        label: "Mailbox",
        type: "string",
        required: true,
        description: "Inbox, label, or queue to review.",
        defaultValue: "support",
      },
      {
        key: "urgency_threshold",
        label: "Urgency threshold",
        type: "enum",
        required: true,
        options: ["low", "medium", "high"],
        defaultValue: "medium",
      },
    ];
  }
  if (intent === "lead_enrichment") {
    return [
      {
        key: "lead_source",
        label: "Lead source",
        type: "string",
        required: true,
        description: "CRM view, CSV name, or inbound source.",
        defaultValue: "new leads",
      },
      { key: "company_website", label: "Company website", type: "url", required: false },
    ];
  }
  if (intent === "release") {
    return [
      {
        key: "release_label",
        label: "Release label",
        type: "string",
        required: true,
        defaultValue: "next release",
      },
      { key: "evidence_url", label: "Evidence URL", type: "url", required: false },
    ];
  }
  if (intent === "research" || /\burl|website\b/.test(lower)) {
    return [
      { key: "source_url", label: "Source URL", type: "url", required: true },
      {
        key: "depth",
        label: "Depth",
        type: "enum",
        required: false,
        options: ["quick", "deep"],
        defaultValue: "quick",
      },
    ];
  }
  if (intent === "reporting") {
    return [
      {
        key: "lookback_hours",
        label: "Lookback hours",
        type: "number",
        required: true,
        defaultValue: "24",
      },
      {
        key: "audience",
        label: "Audience",
        type: "enum",
        required: false,
        options: ["internal", "customer"],
        defaultValue: "internal",
      },
    ];
  }
  return [
    {
      key: "task",
      label: "Task",
      type: "string",
      required: true,
      description: "The work item this agent should complete.",
      defaultValue: truncateSentence(prompt, 80),
    },
  ];
}

function buildAgentBuilderWebhookReadiness(
  triggerKind: AgentTriggerKind,
): AgentBuilderWebhookTriggerReadiness {
  const readiness = buildWebhookTriggerReadiness(triggerKind);
  return {
    ...readiness,
    publishSteps: readiness.recommended
      ? [
          "Save the agent",
          "Create or rotate the webhook token",
          "Send a test payload",
          "Rotate the token before sharing broadly",
        ]
      : [],
  };
}

function buildAgentBuilderScheduleReadiness(
  triggerKind: AgentTriggerKind,
  schedule?: string,
): AgentBuilderScheduleTriggerReadiness {
  const recommended = triggerKind === "schedule";
  const cronLabel = schedule ?? "the generated cron schedule";
  return {
    recommended,
    readyAfterSave: recommended && Boolean(schedule),
    ...(schedule ? { cron: schedule } : {}),
    message: recommended
      ? `Save the agent with ${cronLabel}; confirm provider and tool setup before activating scheduled execution.`
      : "Schedule setup is optional for this draft.",
    planDetail: recommended
      ? `Run on ${cronLabel}; verify the cron cadence before activating scheduled execution.`
      : "No schedule is required unless the draft changes to recurring automation.",
  };
}

function buildAgentBuilderName(prompt: string, intent: string): string {
  const quoted = prompt.match(/"([^"]{3,50})"/)?.[1];
  if (quoted) return truncateSentence(`${quoted} agent`, 80);
  if (intent === "lead_enrichment") return "Lead enrichment agent";
  if (intent === "support") return "Support triage agent";
  if (intent === "research") return "Research agent";
  if (intent === "reporting") return "Report writer agent";
  if (intent === "release") return "Release audit agent";
  if (intent === "notification") return "Notification agent";
  return "Workspace agent";
}

function buildAgentBuilderInstructions(prompt: string, intent: string): string {
  return [
    `User request: ${prompt}`,
    "",
    `You are a ${intent.replace(/_/g, " ")} workspace agent. Complete the request with clear, auditable steps.`,
    "Before taking action, identify the input, expected output, and any missing setup.",
    "Use enabled tools when they help. If a provider, credential, or integration is missing, explain the blocker.",
    "Return a concise final answer with completed work, follow-up items, and risks.",
  ].join("\n");
}

function buildAgentBuilderMemory(
  intent: string,
  acceptanceChecks: readonly string[],
): AgentMemoryEntry[] {
  return [
    {
      id: "memory-operating-intent",
      label: "Operating intent",
      content: redactSensitiveString(intent).slice(0, 1_000),
    },
    {
      id: "memory-success-context",
      label: "Success context",
      content: redactSensitiveString(acceptanceChecks.join("\n")).slice(0, 1_000),
    },
  ];
}

function buildAgentBuilderPlaybook(intent: string, prompt: string): AgentPlaybookStep[] {
  return [
    {
      id: "understand",
      title: "Understand request",
      instruction: `Restate the goal from this prompt: ${truncateSentence(prompt, 180)}`,
    },
    {
      id: "collect",
      title: "Collect context",
      instruction: "Use inputs and enabled tools to gather the minimum context needed.",
    },
    {
      id: "produce",
      title: "Produce output",
      instruction:
        intent === "notification"
          ? "Draft and prepare the message or notification."
          : "Create the requested summary, action, or recommendation.",
    },
    {
      id: "report",
      title: "Report result",
      instruction: "Return what changed, what was found, and what still needs setup or approval.",
    },
  ];
}

function buildAgentBuilderOpenQuestions(intent: string, prompt: string): string[] {
  const questions: string[] = [];
  if (!/\b(slack|email|webhook|browser|url|database|crm|github)\b/i.test(prompt)) {
    questions.push("Which external system should this agent connect to first?");
  }
  if (inferAgentTriggerKind(intent, prompt) === "manual") {
    questions.push("Should this run manually, on a schedule, or from a webhook?");
  }
  if (!/\b(success|done|metric|alert|notify)\b/i.test(prompt)) {
    questions.push("What should count as a successful run?");
  }
  return questions.slice(0, 3);
}

function summarizeAgentPrompt(prompt: string): string {
  const summary = truncateSentence(prompt.replace(/\s+/g, " "), 140);
  return summary.endsWith(".") ? summary : `${summary}.`;
}

function truncateSentence(value: string, max: number): string {
  const clean = value.trim().replace(/\s+/g, " ");
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function splitPromptSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\r?\n+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function summarizePromptAgentDraft(sentences: string[], fallbackName: string): string {
  const summary = sentences[0] ?? `${fallbackName} generated from prompt.`;
  return summary.length > 180 ? `${summary.slice(0, 177).trim()}...` : summary;
}

function extractAgentActions(sentences: string[]): string[] {
  const verbs = [
    "monitor",
    "summarize",
    "draft",
    "review",
    "route",
    "triage",
    "notify",
    "send",
    "track",
    "collect",
    "capture",
    "validate",
    "research",
    "report",
    "analyze",
    "sync",
    "escalate",
    "respond",
    "create",
    "open",
    "update",
    "publish",
    "schedule",
  ];
  const actions: string[] = [];
  const seen = new Set<string>();
  for (const sentence of sentences) {
    for (const verb of verbs) {
      const match = sentence.match(new RegExp(`\\b${verb}\\b\\s+([^.;\\n]{2,80})`, "i"));
      if (!match) continue;
      const phrase = `${verb} ${match[1]}`.replace(/\s+/g, " ").trim();
      const key = phrase.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        actions.push(phrase);
      }
    }
  }
  if (actions.length === 0)
    actions.push(sentences[0]?.slice(0, 80) ?? "automate workspace follow-up");
  return actions.slice(0, 5);
}

function buildAgentName(primaryAction: string, prompt: string): string {
  const topic = primaryAction
    .replace(
      /^(monitor|summarize|draft|review|route|triage|notify|send|track|collect|capture|validate|research|report|analyze|sync|escalate|respond|create|open|update|publish|schedule)\s+/i,
      "",
    )
    .replace(/\b(every|daily|weekly|hourly|when|with|for|to|and|then)\b.*$/i, "")
    .replace(/[^a-z0-9\s-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const fallback = /\bsupport|ticket|inbox|customer/i.test(prompt) ? "Support Triage" : "Workflow";
  const base = titleCase(topic || fallback);
  const name = `${base} Agent`;
  return name.length <= 80 ? name : `${name.slice(0, 74).trim()} Agent`;
}

function inferPromptAgentTriggerKind(prompt: string): AgentTriggerKind {
  if (/\b(webhook|incoming request|payload|event)\b/i.test(prompt)) return "webhook";
  if (/\b(email|inbox|mailbox)\b/i.test(prompt)) return "email";
  if (
    /\b(schedule|scheduled|daily|weekly|hourly|every\s+\d+|each morning|each day)\b/i.test(prompt)
  )
    return "schedule";
  return "manual";
}

function inferPromptAgentSchedule(prompt: string): string {
  if (/\bhourly|every hour\b/i.test(prompt)) return "0 * * * *";
  if (/\bweekly|each week\b/i.test(prompt)) return "0 9 * * 1";
  if (/\bnightly|overnight\b/i.test(prompt)) return "0 2 * * *";
  return "0 9 * * *";
}

function buildAgentInputSchema(prompt: string): AgentInputField[] {
  const fields: AgentInputField[] = [];
  if (/\b(url|website|page|site|http)\b/i.test(prompt)) {
    fields.push({
      key: "target_url",
      label: "Target URL",
      type: "url",
      required: true,
      description: "Page or endpoint the agent should inspect.",
    });
  }
  if (/\b(email|inbox|mailbox)\b/i.test(prompt)) {
    fields.push({
      key: "mailbox",
      label: "Mailbox",
      type: "string",
      required: false,
      description: "Mailbox, queue, or label to inspect.",
    });
  }
  if (/\b(ticket|issue|case|incident)\b/i.test(prompt)) {
    fields.push({
      key: "ticket_id",
      label: "Ticket ID",
      type: "string",
      required: false,
      description: "Optional ticket, issue, or case identifier.",
    });
  }
  if (/\b(customer|account|client)\b/i.test(prompt)) {
    fields.push({
      key: "account_name",
      label: "Account",
      type: "string",
      required: false,
      description: "Customer, client, or account name.",
    });
  }
  if (/\brelease|evidence\b/i.test(prompt)) {
    fields.push({
      key: "release_label",
      label: "Release label",
      type: "string",
      required: true,
      defaultValue: "next release",
    });
  }
  if (/\bevidence url|evidence urls|url\b/i.test(prompt)) {
    fields.push({ key: "evidence_url", label: "Evidence URL", type: "url", required: false });
  }
  return fields.slice(0, 6);
}

function inferAgentTools(prompt: string): string[] {
  const tools = new Set<string>(["read_workflow_brief", "list_requirements", "list_plan_items"]);
  if (/\b(run|runs|failure|failed|status|monitor|recent)\b/i.test(prompt))
    tools.add("list_recent_runs");
  if (/\b(blocker|question|risk|escalat|urgent|incident)\b/i.test(prompt))
    tools.add("list_blockers");
  if (
    /\b(create|open|update|write|log|blocker|question|plan item|follow-up|follow up)\b/i.test(
      prompt,
    )
  )
    tools.add("create_blocker");
  if (/\b(note|log|summary|summarize|report)\b/i.test(prompt)) tools.add("log_note");
  if (/\b(url|website|page|site|http|research|fetch)\b/i.test(prompt)) tools.add("http_fetch");
  if (/\b(slack|notify|notification|message|webhook)\b/i.test(prompt))
    tools.add("slack_post_webhook");
  if (/\b(github|pull request|pull requests|\bpr\b|\bprs\b|issue|issues|comment)\b/i.test(prompt))
    tools.add("github_api");
  if (/\b(email|mail|inbox|reply|send)\b/i.test(prompt)) tools.add("email_send");
  if (/\b(sql|sqlite|database|table|query)\b/i.test(prompt)) tools.add("sql_query");
  if (/\b(shell|command|script|terminal|npm|git)\b/i.test(prompt)) tools.add("shell_for_agent");
  if (/\b(browser|click|form|screenshot|page|website)\b/i.test(prompt)) {
    tools.add("browser_goto");
    tools.add("browser_extract");
    tools.add("browser_screenshot");
  }
  return Array.from(tools).slice(0, 12);
}

function buildAgentPlaybook(
  sentences: string[],
  actions: string[],
  enabledTools: string[],
): AgentPlaybookStep[] {
  const steps = [
    {
      title: "Read workspace context",
      instruction:
        "Review the workspace brief, accepted requirements, current plan items, and recent activity before taking action.",
    },
    ...actions.slice(0, 3).map((action) => ({
      title: titleCase(action).slice(0, 120),
      instruction:
        matchingSentence(sentences, action) || `Complete this requested action: ${action}.`,
    })),
    {
      title: "Record outcome",
      instruction: enabledTools.includes("log_note")
        ? "Write a concise note with the result, any unresolved risks, and recommended next action."
        : "Return a concise result with unresolved risks and recommended next action.",
    },
  ];
  return steps.slice(0, 6).map((step, index) => ({ id: `draft_step_${index + 1}`, ...step }));
}

function buildAgentInstructions(prompt: string, actions: string[], enabledTools: string[]): string {
  const actionList = actions
    .map((action, index) => `${index + 1}. ${titleCase(action)}`)
    .join("\n");
  const toolList = enabledTools.length ? enabledTools.join(", ") : "no tools";
  return [
    "You are a PacketAgent workspace agent generated from an operator prompt.",
    "Turn the prompt into reliable, auditable work and keep outputs concise.",
    "",
    `Original prompt: ${prompt}`,
    "",
    "Primary actions:",
    actionList,
    "",
    `Use these enabled tools when useful: ${toolList}.`,
    "Before making changes, inspect relevant workspace context. After each run, summarize what changed, what remains uncertain, and the next recommended step.",
  ].join("\n");
}

function buildAgentDraftPlan(
  triggerKind: AgentTriggerKind,
  enabledTools: string[],
  inputSchema: AgentInputField[],
): AgentDraftPlanItem[] {
  const webhookReadiness = buildWebhookTriggerReadiness(triggerKind);
  return [
    {
      title: "Review generated agent instructions",
      detail:
        "Confirm the generated name, instructions, and playbook match the operational intent.",
      status: "todo",
    },
    ...(inputSchema.length > 0
      ? [
          {
            title: "Confirm run inputs",
            detail: `Check generated inputs: ${inputSchema.map((field) => field.key).join(", ")}.`,
            status: "todo" as const,
          },
        ]
      : []),
    {
      title: "Configure runtime access",
      detail:
        enabledTools.length > 0
          ? `Verify enabled tools are appropriate: ${enabledTools.join(", ")}.`
          : "No tools were inferred.",
      status: "todo",
    },
    ...(triggerKind === "webhook"
      ? [
          {
            title: "Prepare webhook trigger readiness",
            detail: webhookReadiness.planDetail,
            status: "todo" as const,
          },
        ]
      : []),
    {
      title: triggerKind === "schedule" ? "Verify schedule" : "Run a manual smoke test",
      detail:
        triggerKind === "schedule"
          ? "Confirm the cron schedule before activating the agent."
          : "Run once manually and inspect the transcript.",
      status: "todo",
    },
  ];
}

function buildAgentDraftAssumptions(
  triggerKind: AgentTriggerKind,
  enabledTools: string[],
  inputSchema: AgentInputField[],
): string[] {
  const assumptions = [
    `Trigger inferred as ${triggerKind}.`,
    "Generated agents start paused unless they are explicitly created from the approval flow.",
  ];
  if (enabledTools.length > 0)
    assumptions.push(
      "Tool selection is heuristic and should be reviewed before enabling production runs.",
    );
  if (inputSchema.length === 0)
    assumptions.push("No required runtime inputs were inferred from the prompt.");
  if (triggerKind === "webhook")
    assumptions.push(
      "Webhook-triggered drafts need a saved agent and generated token before external events can reach the public trigger route.",
    );
  return assumptions;
}

function matchingSentence(sentences: string[], action: string): string {
  const verb = action.split(/\s+/)[0] ?? "";
  return (
    sentences.find((sentence) => new RegExp(`\\b${escapeRegex(verb)}\\b`, "i").test(sentence)) ?? ""
  );
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sampleInputValue(field: AgentInputField): string | number | boolean {
  if (field.type === "number") return Number(field.defaultValue ?? 24);
  if (field.type === "boolean") return field.defaultValue === "false" ? false : true;
  if (field.type === "url") return field.defaultValue || "https://example.com";
  if (field.type === "enum") return field.defaultValue || field.options?.[0] || "";
  return field.defaultValue || field.label.toLowerCase();
}

export function buildAgentSampleInputs(
  schema: AgentInputField[],
): Record<string, string | number | boolean> {
  return Object.fromEntries(schema.map((field) => [field.key, sampleInputValue(field)]));
}

export function listAgentTemplates() {
  return { templates: AGENT_TEMPLATES };
}

export type IntegrationReadinessSummary = {
  status: "ready" | "needs_setup";
  tools: {
    availableCount: number;
    readCount: number;
    writeCount: number;
    execCount: number;
    names: string[];
    missingForGeneratedPlans: string[];
  };
  providers: {
    configuredCount: number;
    readyCount: number;
    missingProviderKinds: ApiKeyProvider[];
    missingApiKeys: Array<{ provider: ApiKeyProvider; providerName: string }>;
  };
  recommendedSetup: string[];
};

const DEFAULT_WORKSPACE_PROVIDER_KINDS = [...DEFAULT_PROVIDER_NAMES] as ApiKeyProvider[];

export function getIntegrationReadiness(
  context: AuthenticatedContext,
): IntegrationReadinessSummary {
  return buildIntegrationReadinessSummary(loadStore(), context.workspace.id);
}

export async function getIntegrationReadinessAsync(
  context: AuthenticatedContext,
): Promise<IntegrationReadinessSummary> {
  return buildIntegrationReadinessSummary(await loadStoreAsync(), context.workspace.id);
}

export function createAgentFromTemplate(
  context: AuthenticatedContext,
  templateId: string,
  overrides: { name?: string; providerId?: string; model?: string } = {},
) {
  const template = findAgentTemplate(templateId);
  if (!template) throw httpError(404, "agent template not found");

  return createAgent(context, {
    name: overrides.name?.trim() || template.name,
    description: template.description,
    instructions: template.instructions,
    providerId: overrides.providerId,
    model: overrides.model,
    tools: template.tools,
    schedule: template.schedule,
    status: "active",
    templateId: template.id,
    inputSchema: template.inputSchema,
  });
}

export async function createAgentFromTemplateAsync(
  context: AuthenticatedContext,
  templateId: string,
  overrides: { name?: string; providerId?: string; model?: string } = {},
) {
  const template = findAgentTemplate(templateId);
  if (!template) throw httpError(404, "agent template not found");

  return createAgentAsync(context, {
    name: overrides.name?.trim() || template.name,
    description: template.description,
    instructions: template.instructions,
    providerId: overrides.providerId,
    model: overrides.model,
    tools: template.tools,
    schedule: template.schedule,
    status: "active",
    templateId: template.id,
    inputSchema: template.inputSchema,
  });
}

export function listProviders(context: AuthenticatedContext) {
  return { providers: listProvidersForWorkspaceIndexed(context.workspace.id) };
}

export async function listProvidersAsync(context: AuthenticatedContext) {
  const data = await loadStoreAsync();
  return {
    providers: data.providers
      .filter((entry) => entry.workspaceId === context.workspace.id)
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export function createProvider(context: AuthenticatedContext, input: ProviderInput) {
  const normalized = normalizeProviderInput(input);
  const timestamp = now();

  return mutateStore((data) => {
    const provider = upsertProvider(
      data,
      {
        workspaceId: context.workspace.id,
        ...normalized,
      },
      timestamp,
    );

    recordActivity(
      data,
      makeActivity(
        context.workspace.id,
        "workspace",
        "provider.created",
        {
          type: "user",
          id: context.user.id,
          displayName: context.user.displayName,
        },
        { title: `Provider connected: ${provider.name}`, providerId: provider.id },
        timestamp,
      ),
    );

    return { provider };
  });
}

export async function createProviderAsync(context: AuthenticatedContext, input: ProviderInput) {
  const normalized = normalizeProviderInput(input);
  const timestamp = now();

  return mutateStoreAsync((data) => {
    const provider = upsertProvider(
      data,
      {
        workspaceId: context.workspace.id,
        ...normalized,
      },
      timestamp,
    );

    recordActivity(
      data,
      makeActivity(
        context.workspace.id,
        "workspace",
        "provider.created",
        {
          type: "user",
          id: context.user.id,
          displayName: context.user.displayName,
        },
        { title: `Provider connected: ${provider.name}`, providerId: provider.id },
        timestamp,
      ),
    );

    return { provider };
  });
}

export function updateProvider(
  context: AuthenticatedContext,
  providerId: string,
  input: Partial<ProviderInput>,
) {
  const timestamp = now();

  return mutateStore((data) => {
    const existing = findProvider(data, providerId);
    if (!existing || existing.workspaceId !== context.workspace.id) {
      throw httpError(404, "provider not found");
    }

    const normalized = normalizeProviderInput({ ...existing, ...input });
    const provider = upsertProvider(
      data,
      {
        ...existing,
        ...normalized,
      },
      timestamp,
    );

    recordActivity(
      data,
      makeActivity(
        context.workspace.id,
        "workspace",
        "provider.updated",
        {
          type: "user",
          id: context.user.id,
          displayName: context.user.displayName,
        },
        { title: `Provider updated: ${provider.name}`, providerId: provider.id },
        timestamp,
      ),
    );

    return { provider };
  });
}

export async function updateProviderAsync(
  context: AuthenticatedContext,
  providerId: string,
  input: Partial<ProviderInput>,
) {
  const timestamp = now();

  return mutateStoreAsync((data) => {
    const existing = findProvider(data, providerId);
    if (!existing || existing.workspaceId !== context.workspace.id) {
      throw httpError(404, "provider not found");
    }

    const normalized = normalizeProviderInput({ ...existing, ...input });
    const provider = upsertProvider(
      data,
      {
        ...existing,
        ...normalized,
      },
      timestamp,
    );

    recordActivity(
      data,
      makeActivity(
        context.workspace.id,
        "workspace",
        "provider.updated",
        {
          type: "user",
          id: context.user.id,
          displayName: context.user.displayName,
        },
        { title: `Provider updated: ${provider.name}`, providerId: provider.id },
        timestamp,
      ),
    );

    return { provider };
  });
}

export function listAgentRuns(context: AuthenticatedContext) {
  return { runs: listAgentRunsForWorkspaceIndexed(context.workspace.id, 50).map(decorateRun) };
}

export async function listAgentRunsAsync(context: AuthenticatedContext) {
  const data = await loadStoreAsync();
  return {
    runs: data.agentRuns
      .filter((entry) => entry.workspaceId === context.workspace.id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 50)
      .map(decorateRun),
  };
}

export function getAgentRunDetail(context: AuthenticatedContext, runId: string): AgentRunDetail {
  const run = findAgentRunForWorkspaceIndexed(context.workspace.id, runId);
  if (!run) {
    throw httpError(404, "agent run not found");
  }
  const data = loadStore();
  return buildAgentRunDetail(run, findRunAgentName(data, context.workspace.id, run));
}

export async function getAgentRunDetailAsync(
  context: AuthenticatedContext,
  runId: string,
): Promise<AgentRunDetail> {
  const run = await findAgentRunForWorkspaceIndexedAsync(context.workspace.id, runId);
  if (!run) {
    throw httpError(404, "agent run not found");
  }
  const data = await loadStoreAsync();
  return buildAgentRunDetail(run, findRunAgentName(data, context.workspace.id, run));
}

function buildAgentRunDetail(run: AgentRunRecord, agentName?: string): AgentRunDetail {
  const decorated = decorateRun(run);
  return {
    run: decorated,
    trace: deriveAgentRunTrace(decorated),
    ...(agentName ? { agentName } : {}),
  };
}

function findRunAgentName(
  data: PacketAgentData,
  workspaceId: string,
  run: AgentRunRecord,
): string | undefined {
  if (!run.agentId) return undefined;
  const agent = findAgent(data, run.agentId);
  return agent && agent.workspaceId === workspaceId ? agent.name : undefined;
}

export function cancelAgentRun(context: AuthenticatedContext, runId: string) {
  const timestamp = now();
  const run = findAgentRunForWorkspaceIndexed(context.workspace.id, runId);
  if (!run) {
    throw httpError(404, "agent run not found");
  }
  if (run.status !== "queued" && run.status !== "running") {
    throw httpError(409, "only queued or running runs can be canceled");
  }
  return mutateStore((data) => {
    const updated = upsertAgentRun(
      data,
      {
        ...run,
        status: "canceled",
        completedAt: timestamp,
        error: run.error ?? "Canceled by operator.",
      },
      timestamp,
    );

    recordActivity(
      data,
      makeActivity(
        context.workspace.id,
        "workspace",
        "agent.run_canceled",
        {
          type: "user",
          id: context.user.id,
          displayName: context.user.displayName,
        },
        { title: `Run canceled: ${updated.title}`, agentId: updated.agentId, runId: updated.id },
        timestamp,
      ),
    );

    return { run: decorateRun(updated) };
  });
}

export async function cancelAgentRunAsync(context: AuthenticatedContext, runId: string) {
  const timestamp = now();
  const snapshot = await loadStoreAsync();
  const compatibilityRun = snapshot.agentRuns.find(
    (entry) => entry.workspaceId === context.workspace.id && entry.id === runId,
  );
  if (compatibilityRun?.workerRunId) {
    if (compatibilityRun.status !== "queued" && compatibilityRun.status !== "running") {
      throw httpError(409, "only queued or running runs can be canceled");
    }
    const workerRun = snapshot.workerRuns.find(
      (entry) =>
        entry.workspaceId === context.workspace.id && entry.id === compatibilityRun.workerRunId,
    );
    if (!workerRun) {
      throw httpError(409, "canonical Worker run is missing");
    }
    await createWorkerControlService().stopRun({
      workspaceId: context.workspace.id,
      actor: {
        type: "user",
        id: context.user.id,
        displayName: context.user.displayName,
      },
      idempotencyKey: `legacy-agent-run:cancel:${compatibilityRun.id}:${workerRun.revision}`,
      expectedRevision: workerRun.revision,
      workerRunId: workerRun.id,
    });
    const updated = await refreshLegacyAgentRunFromCanonical(context.workspace.id, workerRun.id);
    if (!updated) throw httpError(409, "canonical Worker run compatibility refresh failed");
    await mutateStoreAsync((data) => {
      recordActivity(
        data,
        makeActivity(
          context.workspace.id,
          "workspace",
          "agent.run_canceled",
          {
            type: "user",
            id: context.user.id,
            displayName: context.user.displayName,
          },
          {
            title: `Run canceled: ${updated.title}`,
            agentId: updated.agentId,
            runId: updated.id,
            workerRunId: updated.workerRunId,
          },
          timestamp,
        ),
      );
    });
    return { run: decorateRun(updated) };
  }
  return mutateStoreAsync((data) => {
    const run = data.agentRuns.find(
      (entry) => entry.workspaceId === context.workspace.id && entry.id === runId,
    );
    if (!run) {
      throw httpError(404, "agent run not found");
    }
    if (run.status !== "queued" && run.status !== "running") {
      throw httpError(409, "only queued or running runs can be canceled");
    }
    const updated = upsertAgentRun(
      data,
      {
        ...run,
        status: "canceled",
        completedAt: timestamp,
        error: run.error ?? "Canceled by operator.",
      },
      timestamp,
    );

    recordActivity(
      data,
      makeActivity(
        context.workspace.id,
        "workspace",
        "agent.run_canceled",
        {
          type: "user",
          id: context.user.id,
          displayName: context.user.displayName,
        },
        { title: `Run canceled: ${updated.title}`, agentId: updated.agentId, runId: updated.id },
        timestamp,
      ),
    );

    return { run: decorateRun(updated) };
  });
}

export function recordRunAsPlaybook(context: AuthenticatedContext, runId: string) {
  return mutateStore((data) => {
    const run = data.agentRuns.find(
      (r) => r.id === runId && r.workspaceId === context.workspace.id,
    );
    if (!run) throw httpError(404, "agent run not found");
    if (!run.agentId) throw httpError(400, "this run is not linked to an agent");
    const agent = findAgent(data, run.agentId);
    if (!agent || agent.workspaceId !== context.workspace.id)
      throw httpError(404, "agent not found");
    if (!run.toolCalls || run.toolCalls.length === 0)
      throw httpError(400, "run has no tool calls to record");
    const playbook: AgentPlaybookStep[] = run.toolCalls.map((call, index) => ({
      id: generateId(),
      title: `${index + 1}. ${call.toolName}`,
      instruction: `Call ${call.toolName} with: ${formatRedactedPlaybookToolInput(call.input)}`,
    }));
    agent.playbook = playbook.slice(0, 20);
    agent.updatedAt = now();
    return { agent: decorateAgent(data, agent) };
  });
}

export async function recordRunAsPlaybookAsync(context: AuthenticatedContext, runId: string) {
  return mutateStoreAsync((data) => {
    const run = data.agentRuns.find(
      (r) => r.id === runId && r.workspaceId === context.workspace.id,
    );
    if (!run) throw httpError(404, "agent run not found");
    if (!run.agentId) throw httpError(400, "this run is not linked to an agent");
    const agent = findAgent(data, run.agentId);
    if (!agent || agent.workspaceId !== context.workspace.id)
      throw httpError(404, "agent not found");
    if (!run.toolCalls || run.toolCalls.length === 0)
      throw httpError(400, "run has no tool calls to record");
    const playbook: AgentPlaybookStep[] = run.toolCalls.map((call, index) => ({
      id: generateId(),
      title: `${index + 1}. ${call.toolName}`,
      instruction: `Call ${call.toolName} with: ${formatRedactedPlaybookToolInput(call.input)}`,
    }));
    agent.playbook = playbook.slice(0, 20);
    agent.updatedAt = now();
    return { agent: decorateAgent(data, agent) };
  });
}

export async function retryAgentRun(context: AuthenticatedContext, runId: string) {
  const data = await loadStoreAsync();
  const previous = data.agentRuns.find(
    (entry) => entry.workspaceId === context.workspace.id && entry.id === runId,
  );
  if (!previous) {
    throw httpError(404, "agent run not found");
  }
  if (!previous.agentId) {
    throw httpError(400, "this run is not linked to an agent and cannot be retried");
  }
  const agent = data.agents.find(
    (entry) => entry.id === previous.agentId && entry.workspaceId === context.workspace.id,
  );
  if (agent?.enabledTools && agent.enabledTools.length > 0) {
    throw httpError(
      409,
      "tool-enabled runs require a fresh launch approval from the agent editor before retrying",
    );
  }
  const timestamp = now();
  await mutateStoreAsync((store) => {
    const existingSignal = store.activationSignals.find(
      (entry) =>
        entry.workspaceId === context.workspace.id &&
        entry.kind === "retry" &&
        entry.sourceId === previous.id,
    );
    const stableKey =
      existingSignal?.stableKey ??
      activationSignalStableKey(context.workspace.id, "retry", "agent_run", previous.id);
    const signal = upsertActivationSignal(
      store,
      {
        id: existingSignal?.id,
        workspaceId: context.workspace.id,
        kind: "retry",
        source: "agent_run",
        origin: "user_entered",
        sourceId: previous.id,
        stableKey,
        data: {
          origin: "user_action",
          observedBy: "service",
          previousRunId: previous.id,
          agentId: previous.agentId,
        },
      },
      timestamp,
    );
    upsertActivationActivity(
      store,
      makeActivity(
        context.workspace.id,
        "activation",
        "agent.run.retry",
        {
          type: "user",
          id: context.user.id,
          displayName: context.user.displayName,
        },
        {
          title: `Run retried: ${previous.title}`,
          activationSignalKind: "retry",
          activationSignalId: signal.id,
          sourceId: previous.id,
          previousRunId: previous.id,
          agentId: previous.agentId,
          origin: "user_action",
          observedBy: "service",
        },
        timestamp,
        activationActivityId(context.workspace.id, "agent.run.retry", signal.id),
      ),
    );
  });
  return runAgent(context, previous.agentId);
}

function formatRedactedPlaybookToolInput(input: unknown): string {
  const serialized = JSON.stringify(redactSensitiveValue(input));
  return (serialized ?? "null").slice(0, 380);
}

export function listWorkspaceEnvVarsForUser(context: AuthenticatedContext) {
  const data = loadStore();
  return { envVars: listWorkspaceEnvVars(data, context.workspace.id).map(maskEnvVar) };
}

export async function listWorkspaceEnvVarsForUserAsync(context: AuthenticatedContext) {
  const data = await loadStoreAsync();
  return { envVars: listWorkspaceEnvVars(data, context.workspace.id).map(maskEnvVar) };
}

export function createWorkspaceEnvVar(context: AuthenticatedContext, input: WorkspaceEnvVarInput) {
  const normalized = normalizeEnvVarInput(input);
  const timestamp = now();

  return mutateStore((data) => {
    const conflict = listWorkspaceEnvVars(data, context.workspace.id).find(
      (entry) => entry.key === normalized.key,
    );
    if (conflict) throw httpError(409, `env var ${normalized.key} already exists`);

    const created = upsertWorkspaceEnvVar(
      data,
      {
        workspaceId: context.workspace.id,
        key: normalized.key,
        value: normalized.value,
        scope: normalized.scope,
        secret: normalized.secret,
        description: normalized.description,
        createdByUserId: context.user.id,
      },
      timestamp,
    );

    recordActivity(
      data,
      makeActivity(
        context.workspace.id,
        "workspace",
        "env_var.created",
        {
          type: "user",
          id: context.user.id,
          displayName: context.user.displayName,
        },
        {
          title: `Env var added: ${created.key}`,
          envVarId: created.id,
          scope: created.scope,
          secret: created.secret,
        },
        timestamp,
      ),
    );

    return { envVar: maskEnvVar(created) };
  });
}

export async function createWorkspaceEnvVarAsync(
  context: AuthenticatedContext,
  input: WorkspaceEnvVarInput,
) {
  const normalized = normalizeEnvVarInput(input);
  const timestamp = now();

  return mutateStoreAsync((data) => {
    const conflict = listWorkspaceEnvVars(data, context.workspace.id).find(
      (entry) => entry.key === normalized.key,
    );
    if (conflict) throw httpError(409, `env var ${normalized.key} already exists`);

    const created = upsertWorkspaceEnvVar(
      data,
      {
        workspaceId: context.workspace.id,
        key: normalized.key,
        value: normalized.value,
        scope: normalized.scope,
        secret: normalized.secret,
        description: normalized.description,
        createdByUserId: context.user.id,
      },
      timestamp,
    );

    recordActivity(
      data,
      makeActivity(
        context.workspace.id,
        "workspace",
        "env_var.created",
        {
          type: "user",
          id: context.user.id,
          displayName: context.user.displayName,
        },
        {
          title: `Env var added: ${created.key}`,
          envVarId: created.id,
          scope: created.scope,
          secret: created.secret,
        },
        timestamp,
      ),
    );

    return { envVar: maskEnvVar(created) };
  });
}

export function updateWorkspaceEnvVar(
  context: AuthenticatedContext,
  envVarId: string,
  input: Partial<WorkspaceEnvVarInput>,
) {
  const timestamp = now();

  return mutateStore((data) => {
    const existing = findWorkspaceEnvVar(data, envVarId);
    if (!existing || existing.workspaceId !== context.workspace.id) {
      throw httpError(404, "env var not found");
    }

    const merged = normalizeEnvVarInput({
      key: input.key ?? existing.key,
      value: input.value ?? existing.value,
      scope: input.scope ?? existing.scope,
      secret: input.secret ?? existing.secret,
      description: input.description ?? existing.description,
    });

    if (merged.key !== existing.key) {
      const conflict = listWorkspaceEnvVars(data, context.workspace.id).find(
        (entry) => entry.key === merged.key && entry.id !== existing.id,
      );
      if (conflict) throw httpError(409, `env var ${merged.key} already exists`);
    }

    const updated = upsertWorkspaceEnvVar(
      data,
      {
        ...existing,
        key: merged.key,
        value: merged.value,
        scope: merged.scope,
        secret: merged.secret,
        description: merged.description,
      },
      timestamp,
    );

    recordActivity(
      data,
      makeActivity(
        context.workspace.id,
        "workspace",
        "env_var.updated",
        {
          type: "user",
          id: context.user.id,
          displayName: context.user.displayName,
        },
        { title: `Env var updated: ${updated.key}`, envVarId: updated.id },
        timestamp,
      ),
    );

    return { envVar: maskEnvVar(updated) };
  });
}

export async function updateWorkspaceEnvVarAsync(
  context: AuthenticatedContext,
  envVarId: string,
  input: Partial<WorkspaceEnvVarInput>,
) {
  const timestamp = now();

  return mutateStoreAsync((data) => {
    const existing = findWorkspaceEnvVar(data, envVarId);
    if (!existing || existing.workspaceId !== context.workspace.id) {
      throw httpError(404, "env var not found");
    }

    const merged = normalizeEnvVarInput({
      key: input.key ?? existing.key,
      value: input.value ?? existing.value,
      scope: input.scope ?? existing.scope,
      secret: input.secret ?? existing.secret,
      description: input.description ?? existing.description,
    });

    if (merged.key !== existing.key) {
      const conflict = listWorkspaceEnvVars(data, context.workspace.id).find(
        (entry) => entry.key === merged.key && entry.id !== existing.id,
      );
      if (conflict) throw httpError(409, `env var ${merged.key} already exists`);
    }

    const updated = upsertWorkspaceEnvVar(
      data,
      {
        ...existing,
        key: merged.key,
        value: merged.value,
        scope: merged.scope,
        secret: merged.secret,
        description: merged.description,
      },
      timestamp,
    );

    recordActivity(
      data,
      makeActivity(
        context.workspace.id,
        "workspace",
        "env_var.updated",
        {
          type: "user",
          id: context.user.id,
          displayName: context.user.displayName,
        },
        { title: `Env var updated: ${updated.key}`, envVarId: updated.id },
        timestamp,
      ),
    );

    return { envVar: maskEnvVar(updated) };
  });
}

export function deleteWorkspaceEnvVarById(context: AuthenticatedContext, envVarId: string) {
  const timestamp = now();
  return mutateStore((data) => {
    const existing = findWorkspaceEnvVar(data, envVarId);
    if (!existing || existing.workspaceId !== context.workspace.id) {
      throw httpError(404, "env var not found");
    }
    deleteWorkspaceEnvVar(data, envVarId);
    recordActivity(
      data,
      makeActivity(
        context.workspace.id,
        "workspace",
        "env_var.deleted",
        {
          type: "user",
          id: context.user.id,
          displayName: context.user.displayName,
        },
        { title: `Env var removed: ${existing.key}`, envVarId: existing.id },
        timestamp,
      ),
    );
    return { ok: true };
  });
}

export async function deleteWorkspaceEnvVarByIdAsync(
  context: AuthenticatedContext,
  envVarId: string,
) {
  const timestamp = now();
  return mutateStoreAsync((data) => {
    const existing = findWorkspaceEnvVar(data, envVarId);
    if (!existing || existing.workspaceId !== context.workspace.id) {
      throw httpError(404, "env var not found");
    }
    deleteWorkspaceEnvVar(data, envVarId);
    recordActivity(
      data,
      makeActivity(
        context.workspace.id,
        "workspace",
        "env_var.deleted",
        {
          type: "user",
          id: context.user.id,
          displayName: context.user.displayName,
        },
        { title: `Env var removed: ${existing.key}`, envVarId: existing.id },
        timestamp,
      ),
    );
    return { ok: true };
  });
}

export function listReleaseHistory(context: AuthenticatedContext) {
  const data = loadStore();
  return listReleaseHistoryFromData(data, context.workspace.id);
}

export async function listReleaseHistoryAsync(context: AuthenticatedContext) {
  const data = await loadStoreAsync();
  return listReleaseHistoryFromData(data, context.workspace.id);
}

function listReleaseHistoryFromData(data: PacketAgentData, workspaceId: string) {
  const releases = listReleaseConfirmationsForWorkspace(data, workspaceId).sort((left, right) =>
    (right.confirmedAt ?? right.updatedAt).localeCompare(left.confirmedAt ?? left.updatedAt),
  );

  const evidence = data.validationEvidence.filter((entry) => entry.workspaceId === workspaceId);
  const concerns = data.workflowConcerns.filter((entry) => entry.workspaceId === workspaceId);

  const passedEvidence = evidence.filter((entry) => entry.status === "passed").length;
  const failedEvidence = evidence.filter((entry) => entry.status === "failed").length;
  const pendingEvidence = evidence.filter(
    (entry) => !entry.status || entry.status === "pending",
  ).length;
  const openBlockers = concerns.filter(
    (entry) => entry.kind === "blocker" && entry.status === "open",
  ).length;
  const openQuestions = concerns.filter(
    (entry) => entry.kind === "open_question" && entry.status === "open",
  ).length;

  return {
    releases: releases.map((entry) => ({
      id: entry.id ?? entry.workspaceId,
      workspaceId: entry.workspaceId,
      versionLabel: entry.versionLabel ?? "release",
      status: entry.status ?? (entry.confirmed ? "confirmed" : "pending"),
      confirmed: Boolean(entry.confirmed || entry.status === "confirmed"),
      summary: entry.summary ?? entry.releaseNotes ?? "",
      confirmedBy: entry.confirmedBy ?? "",
      confirmedAt: entry.confirmedAt ?? null,
      validationEvidenceIds: entry.validationEvidenceIds ?? [],
      updatedAt: entry.updatedAt,
    })),
    preflight: {
      passedEvidence,
      failedEvidence,
      pendingEvidence,
      openBlockers,
      openQuestions,
      ready: failedEvidence === 0 && openBlockers === 0 && passedEvidence > 0,
    },
  };
}

type WorkspaceEnvVarInput = {
  key?: string;
  value?: string;
  scope?: WorkspaceEnvVarScope;
  secret?: boolean;
  description?: string;
};

const ENV_VAR_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,254}$/;

function normalizeEnvVarInput(input: WorkspaceEnvVarInput) {
  const key = String(input.key ?? "")
    .trim()
    .toUpperCase();
  if (!ENV_VAR_KEY_PATTERN.test(key)) {
    throw httpError(400, "key must start with a letter and contain only A-Z, 0-9, and underscores");
  }
  const value = String(input.value ?? "");
  if (value.length > 5000) throw httpError(400, "value must be 5000 characters or fewer");
  const scope: WorkspaceEnvVarScope =
    input.scope === "build" || input.scope === "runtime" ? input.scope : "all";
  const secret = Boolean(input.secret);
  const description = stringOrUndefined(input.description);
  return { key, value, scope, secret, description };
}

function maskEnvVar(record: WorkspaceEnvVarRecord) {
  const shouldMask = record.secret || isSensitiveKey(record.key);
  return {
    ...record,
    value: shouldMask ? maskSecret(record.value) : record.value,
    valuePreview: shouldMask ? maskSecret(record.value) : null,
    valueLength: record.value.length,
  };
}

function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 4) return "•".repeat(value.length);
  return `${"•".repeat(Math.max(value.length - 4, 4))}${value.slice(-4)}`;
}

type DecoratedAgentRun = AgentRunDetail["run"];

function deriveAgentRunTrace(run: DecoratedAgentRun): AgentRunTraceDetail {
  const storedSpans = deriveStoredAgentRunTraceSpans(run);
  const spans = storedSpans.map(toAgentRunTraceSpan);
  const costUsd =
    typeof run.costUsd === "number"
      ? run.costUsd
      : sumNullableNumbers(storedSpans.map((span) => span.costUsd));
  return {
    id: `${run.id}:trace`,
    runId: run.id,
    source: "legacy",
    generatedAt: now(),
    summary: {
      spans: spans.length,
      spanCount: spans.length,
      modelCalls: run.modelUsed || storedSpans.some((span) => span.modelUsed) ? 1 : 0,
      toolCalls: storedSpans.filter((span) => span.type === "tool_call").length,
      stepCount: storedSpans.filter((span) => span.type === "step").length,
      logCount: storedSpans.filter((span) => span.type === "log").length,
      inputCount: Object.keys(run.inputs ?? {}).length,
      errorCount: storedSpans.filter(isStoredErrorTraceSpan).length,
      warningCount: spans.filter((span) => span.status === "warn").length,
      costUsd,
      durationMs: run.durationMs,
    },
    spans,
  };
}

function toAgentRunTraceSpan(span: StoredAgentRunTraceSpan): AgentRunTraceSpan {
  return omitUndefined({
    id: span.id,
    name: span.title,
    kind: traceKindFromStoredType(span.type),
    status: span.status,
    startedAt: span.startedAt ?? undefined,
    endedAt: span.completedAt,
    durationMs: span.durationMs,
    model: span.modelUsed ?? undefined,
    toolName: span.toolName ?? undefined,
    costUsd: span.costUsd,
    input: span.input === null ? undefined : span.input,
    output: span.output === null ? undefined : span.output,
    error: span.error ?? undefined,
    attributes: omitUndefined({
      sequence: span.sequence,
      spanType: span.type,
      summary: span.summary ?? undefined,
    }),
  });
}

function traceKindFromStoredType(type: StoredAgentRunTraceSpanType): AgentRunTraceSpanKind {
  return type === "tool_call" ? "tool" : type;
}

function isStoredErrorTraceSpan(span: StoredAgentRunTraceSpan): boolean {
  return (
    span.type === "error" ||
    span.status === "failed" ||
    span.status === "error" ||
    span.status === "timeout"
  );
}

function sumNullableNumbers(values: Array<number | null | undefined>): number | null {
  let total = 0;
  let seen = false;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    total += value;
    seen = true;
  }
  return seen ? total : null;
}

function omitUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

function decorateRun(run: AgentRunRecord) {
  const start = run.startedAt ? Date.parse(run.startedAt) : NaN;
  const end = run.completedAt ? Date.parse(run.completedAt) : NaN;
  const durationMs =
    Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
  return {
    ...run,
    transcript: run.transcript?.map((step) => ({
      ...step,
      output: redactSensitiveString(step.output),
    })),
    inputs: run.inputs ? (redactSensitiveValue(run.inputs) as AgentRunRecord["inputs"]) : undefined,
    output: run.output ? redactSensitiveString(run.output) : undefined,
    error: run.error ? redactSensitiveString(run.error) : undefined,
    logs: run.logs.map((entry) => ({ ...entry, message: redactSensitiveString(entry.message) })),
    toolCalls: run.toolCalls?.map((call) => ({
      ...call,
      input: redactSensitiveValue(call.input) as AgentRunToolCall["input"],
      output: redactSensitiveValue(call.output),
      error: call.error ? redactSensitiveString(call.error) : undefined,
    })),
    evaluation: run.evaluation
      ? (redactSensitiveValue(run.evaluation) as AgentRunRecord["evaluation"])
      : undefined,
    durationMs,
    canCancel: run.status === "queued" || run.status === "running",
    canRetry:
      Boolean(run.agentId) &&
      (run.status === "failed" || run.status === "canceled" || run.status === "success"),
  };
}

type AgentInput = {
  name?: string;
  description?: string;
  instructions?: string;
  providerId?: string | null;
  model?: string | null;
  tools?: string[] | string;
  enabledTools?: string[] | null;
  routeKey?: string | null;
  schedule?: string | null;
  triggerKind?: AgentTriggerKind | string | null;
  playbook?: Array<Partial<AgentPlaybookStep>> | null;
  memory?: Array<Partial<AgentMemoryEntry>> | null;
  evaluationSpec?: Partial<AgentEvaluationSpec> | null;
  status?: AgentStatus;
  templateId?: string | null;
  inputSchema?: AgentInputField[];
};

const TRIGGER_KINDS: AgentTriggerKind[] = ["manual", "schedule", "webhook", "email"];

function assertAgentBundleBodyBound(value: unknown): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw httpError(400, "agent bundle must be valid JSON");
  }
  if (Buffer.byteLength(encoded, "utf8") > AGENT_WORKER_BUNDLE_MAX_BYTES) {
    throw httpError(
      413,
      `agent bundle exceeds the ${AGENT_WORKER_BUNDLE_MAX_BYTES}-byte import limit`,
    );
  }
}

function resolvePortableAgentProvider(
  providers: readonly ProviderRecord[],
  hint: AgentWorkerBundle["agent"]["providerHint"],
): ProviderRecord | null {
  if (!hint) return null;
  const candidates = providers
    .filter((provider) => provider.kind === hint.kind)
    .sort((left, right) => {
      const leftName = left.name === hint.name ? 0 : 1;
      const rightName = right.name === hint.name ? 0 : 1;
      if (leftName !== rightName) return leftName - rightName;
      const leftReady = left.status === "connected" ? 0 : 1;
      const rightReady = right.status === "connected" ? 0 : 1;
      if (leftReady !== rightReady) return leftReady - rightReady;
      return left.id.localeCompare(right.id);
    });
  if (candidates[0]?.name === hint.name) return candidates[0];
  return candidates.length === 1 ? candidates[0] : null;
}

function agentImportReceiptId(workspaceId: string, idempotencyKey: string): string {
  return `agent_import_${createHash("sha256")
    .update(`${workspaceId}\0${idempotencyKey}`)
    .digest("hex")}`;
}

function portableFileStem(name: string): string {
  const stem = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return stem || "agent";
}

type ProviderInput = {
  name?: string;
  kind?: ProviderKind;
  defaultModel?: string;
  baseUrl?: string | null;
  apiKeyConfigured?: boolean;
  status?: "connected" | "missing_key" | "disabled";
};

function decorateAgent(
  data: ReturnType<typeof loadStore>,
  agent: AgentRecord,
  opts: { includeWebhookToken?: boolean } = {},
) {
  const provider = agent.providerId ? findProvider(data, agent.providerId) : null;
  return decorateAgentWithProvider(agent, provider, opts);
}

function decorateAgentWithProvider(
  agent: AgentRecord,
  provider: ProviderRecord | null,
  opts: { includeWebhookToken?: boolean } = {},
) {
  const responseAgent = opts.includeWebhookToken
    ? {
        ...agent,
        webhookTokenPreview: agent.webhookToken ? maskBearerSecret(agent.webhookToken) : undefined,
        hasWebhookToken: Boolean(agent.webhookToken),
      }
    : {
        ...agent,
        webhookToken: undefined,
        webhookTokenPreview: agent.webhookToken ? maskBearerSecret(agent.webhookToken) : undefined,
        hasWebhookToken: Boolean(agent.webhookToken),
      };
  return {
    ...responseAgent,
    provider: provider
      ? {
          id: provider.id,
          name: provider.name,
          kind: provider.kind,
          defaultModel: provider.defaultModel,
          status: provider.status,
          apiKeyConfigured: provider.apiKeyConfigured,
        }
      : null,
  };
}

function normalizeAgentInput(
  input: AgentInput,
): Required<
  Pick<AgentRecord, "name" | "description" | "instructions" | "tools" | "status" | "inputSchema">
> &
  Pick<
    AgentRecord,
    | "providerId"
    | "model"
    | "schedule"
    | "triggerKind"
    | "playbook"
    | "memory"
    | "evaluationSpec"
    | "templateId"
    | "enabledTools"
    | "routeKey"
  > {
  const name = String(input.name ?? "").trim();
  if (name.length < 2) throw httpError(400, "agent name must be at least 2 characters");
  if (name.length > 80) throw httpError(400, "agent name must be 80 characters or fewer");

  const instructions = String(input.instructions ?? "").trim();
  if (instructions.length < 10) throw httpError(400, "instructions must be at least 10 characters");

  const description = String(input.description ?? "").trim();
  const tools = Array.isArray(input.tools)
    ? input.tools
    : String(input.tools ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
  const status =
    input.status && ["active", "paused", "archived"].includes(input.status)
      ? input.status
      : "active";
  const inputSchema = normalizeInputSchema(input.inputSchema);

  const triggerKindRaw = stringOrUndefined(input.triggerKind);
  const triggerKind: AgentTriggerKind | undefined =
    triggerKindRaw && (TRIGGER_KINDS as string[]).includes(triggerKindRaw)
      ? (triggerKindRaw as AgentTriggerKind)
      : undefined;

  const playbook = normalizePlaybook(input.playbook ?? undefined);

  const enabledTools = Array.isArray(input.enabledTools)
    ? input.enabledTools
        .map((t) => String(t).trim())
        .filter(Boolean)
        .slice(0, 24)
    : undefined;
  const memory = normalizeAgentMemory(input.memory ?? undefined);
  const evaluationSpec = normalizeAgentEvaluationSpec(input.evaluationSpec, enabledTools ?? []);

  return {
    name,
    description,
    instructions,
    providerId: stringOrUndefined(input.providerId),
    model: stringOrUndefined(input.model),
    tools: tools.slice(0, 12),
    enabledTools,
    routeKey: stringOrUndefined(input.routeKey),
    schedule: stringOrUndefined(input.schedule),
    triggerKind,
    playbook,
    memory,
    evaluationSpec,
    status,
    templateId: stringOrUndefined(input.templateId),
    inputSchema,
  };
}

function mergeAgentUpdateInput(existing: AgentRecord, input: AgentInput): AgentInput {
  const merged: AgentInput = { ...existing, ...input };
  if (input.enabledTools !== undefined && input.evaluationSpec === undefined) {
    const enabledTools = new Set(
      (Array.isArray(input.enabledTools) ? input.enabledTools : [])
        .map((tool) => String(tool).trim())
        .filter(Boolean),
    );
    merged.evaluationSpec = {
      expectedOutput: existing.evaluationSpec?.expectedOutput ?? "",
      requiredTools: (existing.evaluationSpec?.requiredTools ?? []).filter((tool) =>
        enabledTools.has(tool),
      ),
    };
  }
  return merged;
}

function normalizeAgentMemory(
  input: Array<Partial<AgentMemoryEntry>> | undefined,
): AgentMemoryEntry[] {
  if (!input || !Array.isArray(input)) return [];
  return input.slice(0, 12).flatMap((entry) => {
    const label = String(entry?.label ?? "")
      .trim()
      .slice(0, 80);
    const content = String(entry?.content ?? "")
      .trim()
      .slice(0, 1_000);
    if (!label && !content) return [];
    if (!label || !content)
      throw httpError(400, "agent memory entries require a label and content");
    if (isSensitiveKey(label) || redactSensitiveString(content) !== content) {
      throw httpError(
        400,
        "agent memory must contain non-secret context; use a credential reference for secrets",
      );
    }
    return [{ id: stringOrUndefined(entry?.id) ?? generateId(), label, content }];
  });
}

function normalizeAgentEvaluationSpec(
  input: Partial<AgentEvaluationSpec> | null | undefined,
  enabledTools: string[],
): AgentEvaluationSpec {
  const expectedOutput = String(input?.expectedOutput ?? "")
    .trim()
    .slice(0, 1_200);
  if (redactSensitiveString(expectedOutput) !== expectedOutput) {
    throw httpError(400, "agent evaluation expectations must not contain secret-like assignments");
  }
  const requiredTools = Array.from(
    new Set(
      (Array.isArray(input?.requiredTools) ? input.requiredTools : enabledTools)
        .map((tool) => String(tool).trim())
        .filter(Boolean)
        .slice(0, 24),
    ),
  );
  const undeclared = requiredTools.filter((tool) => !enabledTools.includes(tool));
  if (undeclared.length > 0) {
    throw httpError(400, `evaluation tools must be enabled on the agent: ${undeclared.join(", ")}`);
  }
  return { expectedOutput, requiredTools };
}

function normalizePlaybook(
  input: Array<Partial<AgentPlaybookStep>> | undefined,
): AgentPlaybookStep[] | undefined {
  if (!input) return undefined;
  if (!Array.isArray(input)) return [];
  const cleaned: AgentPlaybookStep[] = [];
  for (const entry of input.slice(0, 20)) {
    const title = String(entry?.title ?? "").trim();
    if (!title) continue;
    const instruction = String(entry?.instruction ?? "").trim();
    cleaned.push({
      id: stringOrUndefined(entry?.id) ?? generateId(),
      title: title.slice(0, 120),
      instruction: instruction.slice(0, 600),
    });
  }
  return cleaned;
}

const FIELD_TYPES: AgentInputFieldType[] = ["string", "number", "boolean", "url", "enum"];

function normalizeInputSchema(raw: unknown): AgentInputField[] {
  if (!Array.isArray(raw)) return [];
  const seenKeys = new Set<string>();
  const fields: AgentInputField[] = [];

  for (const candidate of raw.slice(0, 12)) {
    if (!candidate || typeof candidate !== "object") continue;
    const item = candidate as Record<string, unknown>;
    const key = String(item.key ?? "").trim();
    if (!/^[a-z0-9_]{1,40}$/i.test(key)) {
      throw httpError(
        400,
        "input field keys must be 1-40 chars of letters, numbers, or underscores",
      );
    }
    if (seenKeys.has(key)) throw httpError(400, `duplicate input field key: ${key}`);
    seenKeys.add(key);

    const type = FIELD_TYPES.includes(item.type as AgentInputFieldType)
      ? (item.type as AgentInputFieldType)
      : "string";
    const label = String(item.label ?? "").trim() || key;
    const description = stringOrUndefined(item.description);
    const required = Boolean(item.required);
    const defaultValue = stringOrUndefined(item.defaultValue);
    const exampleValue = stringOrUndefined(item.exampleValue);
    if (exampleValue && exampleValue.length > 1_000) {
      throw httpError(400, `input example "${key}" must be 1000 characters or fewer`);
    }
    let options: string[] | undefined;
    if (type === "enum") {
      options = Array.isArray(item.options)
        ? item.options
            .map((entry) => String(entry).trim())
            .filter(Boolean)
            .slice(0, 16)
        : [];
      if (!options.length) throw httpError(400, `enum field "${key}" requires at least one option`);
    }

    if (exampleValue !== undefined) {
      if (isSensitiveKey(key) || redactSensitiveString(exampleValue) !== exampleValue) {
        throw httpError(
          400,
          `input example "${key}" must not contain a secret; use a credential reference at run time`,
        );
      }
      coerceInputValue(
        { key, label, type, required, description, options, defaultValue },
        exampleValue,
      );
    }

    fields.push({
      key,
      label,
      type,
      required,
      description,
      options,
      defaultValue,
      exampleValue,
    });
  }

  return fields;
}

function validateAgentInputs(
  schema: AgentInputField[],
  raw: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const inputs: Record<string, string | number | boolean> = {};

  for (const field of schema) {
    const provided = raw[field.key];
    const hasValue = provided !== undefined && provided !== null && String(provided).length > 0;

    if (!hasValue) {
      if (field.defaultValue !== undefined && field.defaultValue !== "") {
        inputs[field.key] = coerceInputValue(field, field.defaultValue);
        continue;
      }
      if (field.required) throw httpError(400, `input ${field.key} is required`);
      continue;
    }

    inputs[field.key] = coerceInputValue(field, provided);
  }

  return inputs;
}

function coerceInputValue(field: AgentInputField, value: unknown): string | number | boolean {
  switch (field.type) {
    case "number": {
      const next = Number(value);
      if (!Number.isFinite(next)) throw httpError(400, `input ${field.key} must be a number`);
      return next;
    }
    case "boolean": {
      if (typeof value === "boolean") return value;
      const text = String(value).trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(text)) return true;
      if (["false", "0", "no", "off", ""].includes(text)) return false;
      throw httpError(400, `input ${field.key} must be a boolean`);
    }
    case "url": {
      const text = String(value).trim();
      try {
        const url = new URL(text);
        if (!["http:", "https:"].includes(url.protocol)) throw new Error("scheme");
      } catch {
        throw httpError(400, `input ${field.key} must be a valid http(s) URL`);
      }
      return text;
    }
    case "enum": {
      const text = String(value).trim();
      if (!field.options?.includes(text)) {
        throw httpError(
          400,
          `input ${field.key} must be one of: ${(field.options ?? []).join(", ")}`,
        );
      }
      return text;
    }
    default:
      return String(value);
  }
}

function formatInputValue(value: string | number | boolean): string {
  if (typeof value === "string" && value.length > 80) return `${value.slice(0, 77)}...`;
  return String(value);
}

function buildDryRunOutput(
  agentName: string,
  inputs: Record<string, string | number | boolean>,
  label = "Dry run",
): string {
  const inputSummary =
    Object.keys(inputs).length === 0
      ? "no inputs"
      : Object.entries(inputs)
          .map(([key, value]) => `${key}=${formatInputValue(value)}`)
          .join(", ");
  return `${label} only: ${agentName} did not call a model, external provider, or runtime tools. Planned inputs: ${inputSummary}.`;
}

function validateProvider(
  data: ReturnType<typeof loadStore>,
  workspaceId: string,
  providerId?: string,
) {
  if (!providerId) return;
  const provider = findProvider(data, providerId);
  if (!provider || provider.workspaceId !== workspaceId) {
    throw httpError(400, "provider does not exist in this workspace");
  }
}

function isProviderReadyForAgentRuns(
  data: PacketAgentData,
  workspaceId: string,
  provider: ProviderRecord,
): boolean {
  if (provider.status === "disabled") return false;
  const apiKeyProvider = apiKeyProviderForKind(provider.kind);
  if (!apiKeyProvider || provider.kind === "ollama") return true;
  return (
    provider.apiKeyConfigured ||
    data.apiKeys.some((key) => key.workspaceId === workspaceId && key.provider === apiKeyProvider)
  );
}

function buildIntegrationReadinessSummary(
  data: PacketAgentData,
  workspaceId: string,
): IntegrationReadinessSummary {
  const tools = listDefaultToolSummaries();
  const toolNames = [...new Set(tools.map((tool) => tool.name))].sort();
  const generatedPlanTools = [
    ...new Set(AGENT_TEMPLATES.flatMap((template) => template.tools)),
  ].sort();
  const missingForGeneratedPlans = generatedPlanTools.filter((tool) => !toolNames.includes(tool));

  const providers = data.providers.filter((provider) => provider.workspaceId === workspaceId);
  const apiKeys = new Set(
    data.apiKeys.filter((key) => key.workspaceId === workspaceId).map((key) => key.provider),
  );
  const providerKinds = new Set(providers.map((provider) => provider.kind));

  const providerReadiness = providers.map((provider) => {
    const apiKeyProvider = apiKeyProviderForKind(provider.kind);
    const requiresApiKey = Boolean(apiKeyProvider && provider.kind !== "ollama");
    const hasVaultKey = apiKeyProvider ? apiKeys.has(apiKeyProvider) : false;
    const apiKeyReady = !requiresApiKey || provider.apiKeyConfigured || hasVaultKey;
    return {
      provider,
      apiKeyProvider,
      ready: provider.status !== "disabled" && apiKeyReady,
      apiKeyReady,
      requiresApiKey,
    };
  });

  const missingProviderKinds = DEFAULT_WORKSPACE_PROVIDER_KINDS.filter(
    (kind) => !providerKinds.has(kind as ProviderKind),
  );
  const missingApiKeys = providerReadiness
    .filter(
      (entry) =>
        entry.apiKeyProvider &&
        entry.requiresApiKey &&
        !entry.apiKeyReady &&
        entry.provider.status !== "disabled",
    )
    .map((entry) => ({
      provider: entry.apiKeyProvider as ApiKeyProvider,
      providerName: entry.provider.name,
    }));

  const recommendedSetup: string[] = [];
  if (providers.length === 0) {
    recommendedSetup.push("Add a workspace provider so generated agents have a model target.");
  }
  if (missingProviderKinds.length > 0) {
    recommendedSetup.push(
      `Add provider records for ${missingProviderKinds.join(", ")} if generated plans should target them.`,
    );
  }
  if (missingApiKeys.length > 0) {
    recommendedSetup.push(
      `Store vault keys or mark external key readiness for ${missingApiKeys.map((entry) => entry.providerName).join(", ")}.`,
    );
  }
  if (missingForGeneratedPlans.length > 0) {
    recommendedSetup.push(
      `Back generated plan tools with runtime adapters or replace labels: ${missingForGeneratedPlans.slice(0, 8).join(", ")}.`,
    );
  }
  if (recommendedSetup.length === 0) {
    recommendedSetup.push(
      "Generated agent plans have provider, API key, and runtime tool coverage.",
    );
  }

  const readyCount = providerReadiness.filter((entry) => entry.ready).length;
  const status =
    readyCount > 0 && missingApiKeys.length === 0 && missingForGeneratedPlans.length === 0
      ? "ready"
      : "needs_setup";

  return {
    status,
    tools: {
      availableCount: toolNames.length,
      readCount: tools.filter((tool) => tool.side === "read").length,
      writeCount: tools.filter((tool) => tool.side === "write").length,
      execCount: tools.filter((tool) => tool.side === "exec").length,
      names: toolNames,
      missingForGeneratedPlans,
    },
    providers: {
      configuredCount: providers.length,
      readyCount,
      missingProviderKinds,
      missingApiKeys,
    },
    recommendedSetup,
  };
}

function apiKeyProviderForKind(kind: ProviderKind): ApiKeyProvider | null {
  return (DEFAULT_WORKSPACE_PROVIDER_KINDS as ProviderKind[]).includes(kind)
    ? (kind as ApiKeyProvider)
    : null;
}

function normalizeProviderInput(input: ProviderInput) {
  const name = String(input.name ?? "").trim();
  if (name.length < 2) throw httpError(400, "provider name must be at least 2 characters");
  const defaultModel = String(input.defaultModel ?? "").trim();
  if (defaultModel.length < 2) throw httpError(400, "default model is required");
  const kind =
    input.kind &&
    [
      "openai",
      "anthropic",
      "minimax",
      "azure_openai",
      "ollama",
      "gemini",
      "openrouter",
      "custom",
    ].includes(input.kind)
      ? input.kind
      : "custom";
  const apiKeyConfigured = Boolean(input.apiKeyConfigured);
  const status =
    input.status && ["connected", "missing_key", "disabled"].includes(input.status)
      ? input.status
      : apiKeyConfigured || kind === "ollama"
        ? "connected"
        : "missing_key";

  return {
    name,
    kind,
    defaultModel,
    baseUrl: stringOrUndefined(input.baseUrl),
    apiKeyConfigured,
    status,
  };
}
