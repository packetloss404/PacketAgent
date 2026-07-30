import type { ModelRoutingPresetId } from "../model-routing-presets.js";
import { registerDefaultProviders } from "../providers/bootstrap.js";
import type { ProviderCapabilities } from "../providers/catalog.js";
import {
  providerReadinessSnapshot,
  resolvePresetToProviderModel,
  vaultProviderNamesForWorkspace,
  type ResolvePresetOptions,
} from "../providers/preset-resolver.js";
import { getDefaultRouter, type ProviderRouter } from "../providers/router.js";
import type { LLMProvider, ProviderName } from "../providers/types.js";

export type AgentBuilderCredentialSource = "environment" | "workspace_vault" | "local" | "none";
export type AgentBuilderCredentialStatus = "ready" | "not_required" | "missing";
export type AgentBuilderCapabilityStatus =
  | "ready"
  | "conditional"
  | "best_effort"
  | "missing"
  | "not_required";

export interface AgentBuilderProviderContext {
  readonly preset: ModelRoutingPresetId;
  readonly vaultProviders: readonly ProviderName[];
  readonly selected?: {
    readonly provider: Exclude<ProviderName, "stub">;
    readonly label: string;
    readonly model: string;
    readonly local: boolean;
    readonly registered: boolean;
    readonly credentialSource: AgentBuilderCredentialSource;
    readonly capabilities: ProviderCapabilities;
    readonly instance?: LLMProvider;
  };
}

export interface AgentBuilderProviderReadiness {
  readonly configured: boolean;
  readonly preset: ModelRoutingPresetId;
  readonly selectedProviderId?: string;
  readonly selectedProviderKind?: Exclude<ProviderName, "stub">;
  readonly selectedProviderName?: string;
  readonly selectedModel?: string;
  readonly registered: boolean;
  readonly credentialSource: AgentBuilderCredentialSource;
  readonly credentialStatus: AgentBuilderCredentialStatus;
  readonly modelAvailability: "configured_unverified" | "missing";
  readonly capabilities: {
    readonly streaming: {
      readonly supported: boolean;
      readonly status: "ready" | "missing";
    };
    readonly toolUse: {
      readonly required: boolean;
      readonly support: ProviderCapabilities["toolUse"] | "none";
      readonly status: AgentBuilderCapabilityStatus;
    };
    readonly structuredOutput: {
      readonly requiredForAuthoring: boolean;
      readonly support: ProviderCapabilities["structuredOutput"] | "none";
      readonly status: AgentBuilderCapabilityStatus;
    };
  };
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly message: string;
}

export interface ResolveAgentBuilderProviderContextInput {
  readonly workspaceId: string;
  readonly preset?: ModelRoutingPresetId;
  readonly router?: ProviderRouter;
  readonly env?: NodeJS.ProcessEnv;
  readonly vaultProviders?: Iterable<ProviderName>;
}

export async function resolveAgentBuilderProviderContext(
  input: ResolveAgentBuilderProviderContextInput,
): Promise<AgentBuilderProviderContext> {
  const preset = input.preset ?? "fast";
  if (!input.router) registerDefaultProviders();
  const router = input.router ?? getDefaultRouter();
  const vaultProviders = [
    ...new Set(input.vaultProviders ?? (await vaultProviderNamesForWorkspace(input.workspaceId))),
  ];
  const options: ResolvePresetOptions = {
    router,
    env: input.env,
    vaultProviders,
  };
  const resolved = resolvePresetToProviderModel(preset, options);
  if (!resolved || resolved.provider === "stub") {
    return { preset, vaultProviders };
  }
  const entry = providerReadinessSnapshot(options).find(
    (candidate) => candidate.provider === resolved.provider,
  );
  if (!entry) return { preset, vaultProviders };
  return {
    preset,
    vaultProviders,
    selected: {
      provider: resolved.provider,
      label: entry.label,
      model: resolved.model,
      local: resolved.local,
      registered: entry.registered,
      credentialSource: entry.credentialSource,
      capabilities: entry.capabilities,
      ...(router.get(resolved.provider) ? { instance: router.get(resolved.provider) } : {}),
    },
  };
}

export function buildAgentBuilderProviderReadiness(
  context: AgentBuilderProviderContext,
  input: { readonly requiresToolUse: boolean; readonly authoringUsesLlm: boolean },
): AgentBuilderProviderReadiness {
  const selected = context.selected;
  if (!selected) {
    const blocker = `No registered provider with a usable key or local configuration resolved for the ${context.preset} preset.`;
    return {
      configured: false,
      preset: context.preset,
      registered: false,
      credentialSource: "none",
      credentialStatus: "missing",
      modelAvailability: "missing",
      capabilities: {
        streaming: { supported: false, status: "missing" },
        toolUse: {
          required: input.requiresToolUse,
          support: "none",
          status: input.requiresToolUse ? "missing" : "not_required",
        },
        structuredOutput: {
          requiredForAuthoring: input.authoringUsesLlm,
          support: "none",
          status: input.authoringUsesLlm ? "best_effort" : "not_required",
        },
      },
      blockers: [blocker],
      warnings: [],
      message: blocker,
    };
  }

  const credentialStatus: AgentBuilderCredentialStatus =
    selected.credentialSource === "local" ? "not_required" : "ready";
  const toolUseStatus: AgentBuilderCapabilityStatus = !input.requiresToolUse
    ? "not_required"
    : selected.capabilities.toolUse === "conditional"
      ? "conditional"
      : "ready";
  const structuredOutputStatus: AgentBuilderCapabilityStatus = !input.authoringUsesLlm
    ? "not_required"
    : selected.capabilities.structuredOutput === "none"
      ? "best_effort"
      : selected.capabilities.structuredOutput === "conditional"
        ? "conditional"
        : "ready";
  const blockers = [
    ...(!selected.registered
      ? [`Provider ${selected.label} is not registered in this runtime.`]
      : []),
    ...(selected.credentialSource === "none"
      ? [`Provider ${selected.label} has no usable environment or workspace-vault key.`]
      : []),
  ];
  const warnings = [
    `Model ${selected.model} is configured but live availability has not been verified yet.`,
    ...(toolUseStatus === "conditional"
      ? [
          `Tool use is model-dependent for ${selected.label}; verify it in the first-run evaluation.`,
        ]
      : []),
    ...(structuredOutputStatus === "conditional"
      ? [
          `Structured output is model-dependent for ${selected.label}; PacketAgent still applies local semantic validation.`,
        ]
      : []),
    ...(structuredOutputStatus === "best_effort"
      ? [
          `${selected.label} uses bounded best-effort JSON for authoring; PacketAgent still applies local semantic validation.`,
        ]
      : []),
  ];
  return {
    configured: blockers.length === 0,
    preset: context.preset,
    selectedProviderKind: selected.provider,
    selectedProviderName: selected.label,
    selectedModel: selected.model,
    registered: selected.registered,
    credentialSource: selected.credentialSource,
    credentialStatus,
    modelAvailability: "configured_unverified",
    capabilities: {
      streaming: {
        supported: selected.capabilities.streaming,
        status: selected.capabilities.streaming ? "ready" : "missing",
      },
      toolUse: {
        required: input.requiresToolUse,
        support: selected.capabilities.toolUse,
        status: toolUseStatus,
      },
      structuredOutput: {
        requiredForAuthoring: input.authoringUsesLlm,
        support: selected.capabilities.structuredOutput,
        status: structuredOutputStatus,
      },
    },
    blockers,
    warnings,
    message:
      blockers.length === 0
        ? `${selected.label} and ${selected.model} are configured through ${credentialSourceLabel(selected.credentialSource)}. Live model availability is not verified until evaluation.`
        : blockers.join(" "),
  };
}

function credentialSourceLabel(source: AgentBuilderCredentialSource): string {
  if (source === "workspace_vault") return "the workspace vault";
  if (source === "environment") return "the process environment";
  if (source === "local") return "a keyless local provider";
  return "no credential source";
}
