import type { AgentRecord, ProviderRecord } from "../packetagent-store.js";
import { agentProviderRouteKey } from "../providers/router.js";
import {
  approvalBoundWorkerToolCapabilities,
  compileWorkerCapabilityPolicy,
} from "../workers/capabilities.js";
import { LEGACY_PROJECTION_POLICY, projectLegacyAgentToWorker } from "../workers/projections.js";
import type {
  WorkerReadModelProjection,
  WorkerTrigger,
  WorkerVersionContent,
} from "../workers/types.js";
import {
  assertValidWorkerVersion,
  computeWorkerVersionContentDigest,
} from "../workers/validation.js";

const EXECUTABLE_PROVIDER_KINDS = new Set([
  "anthropic",
  "openai",
  "openrouter",
  "minimax",
  "ollama",
  "gemini",
]);

export function projectLegacyAgentToExecutableWorker(
  agent: AgentRecord,
  provider: ProviderRecord | null,
): WorkerReadModelProjection {
  const draft = projectLegacyAgentToWorker(agent);
  const tools = approvalBoundWorkerToolCapabilities(
    agent.enabledTools ?? [],
    `legacy-agent:${agent.id}`,
  );
  const routeKey = executionRouteKey(agent, provider);
  const providerName =
    provider && EXECUTABLE_PROVIDER_KINDS.has(provider.kind)
      ? provider.kind
      : !provider && tools.length === 0
        ? "stub"
        : undefined;
  const content: WorkerVersionContent = {
    ...draft.version.content,
    instructions: executionInstructions(agent, draft.version.content.instructions),
    execution: {
      routeKey,
      ...(providerName ? { providerId: providerName } : {}),
      ...(agent.model ? { model: agent.model } : {}),
      target: { kind: "packetagent" },
    },
    tools,
    triggers: executableTriggers(agent, draft.version.content.triggers[0]),
    policy: {
      budgets: { ...LEGACY_PROJECTION_POLICY.budgets },
      retry: { ...LEGACY_PROJECTION_POLICY.retry },
      permissions: {
        default: "deny",
        allowedCapabilityIds: tools.map((tool) => tool.id),
      },
      attention: { ...LEGACY_PROJECTION_POLICY.attention },
    },
  };
  const version = {
    ...draft.version,
    content,
    contentDigest: computeWorkerVersionContentDigest(content),
  };
  assertValidWorkerVersion(version);
  compileWorkerCapabilityPolicy({
    workerVersionContentDigest: version.contentDigest,
    requestedCapabilities: content.tools,
    allowedCapabilityIds: content.policy.permissions.allowedCapabilityIds,
    credentialRefs: content.credentialRefs,
  });
  return {
    definition: draft.definition,
    version,
    warnings: draft.warnings.filter(
      (warning) => warning.code !== "projection.coarse_tool_capabilities",
    ),
  };
}

function executionRouteKey(agent: AgentRecord, provider: ProviderRecord | null): string {
  const saved = agent.routeKey?.trim();
  if (saved) return saved;
  if (provider && EXECUTABLE_PROVIDER_KINDS.has(provider.kind)) {
    return agentProviderRouteKey(provider.kind as Parameters<typeof agentProviderRouteKey>[0]);
  }
  return "agent.reasoning";
}

function executionInstructions(agent: AgentRecord, projected: string): string {
  if (!agent.memory?.length) return projected;
  return [
    projected,
    "",
    "Legacy memory (operator-authored, non-secret context):",
    ...agent.memory.map((entry) => `- ${entry.label}: ${entry.content}`),
  ].join("\n");
}

function executableTriggers(
  agent: AgentRecord,
  projected: WorkerTrigger,
): readonly WorkerTrigger[] {
  const manual: WorkerTrigger = {
    id: "legacy-trigger-manual",
    kind: "manual",
    enabled: true,
    description: "Compatibility trigger for the legacy Agent run API.",
  };
  if (projected.kind === "manual") return [manual];
  return [
    manual,
    {
      ...projected,
      id:
        projected.kind === "cron"
          ? "legacy-trigger-schedule"
          : agent.triggerKind === "email"
            ? "legacy-trigger-email"
            : "legacy-trigger-webhook",
      enabled: agent.status === "active",
    },
  ];
}
