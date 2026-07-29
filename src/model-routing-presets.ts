import type { IntegrationReadinessSummary } from "./packetagent-services.js";
import type { ApiKeyProvider, ProviderKind, ProviderRecord } from "./packetagent-store.js";

export type ModelRoutingPresetId = "fast" | "smart" | "cheap" | "local";
export type ModelRoutingProviderKind = ProviderKind | "stub";
export type ModelRoutingChoiceSource = "workspace_provider" | "env_hint" | "fallback";

export interface ModelRoutingChoice {
  provider: ModelRoutingProviderKind;
  model: string;
  source: ModelRoutingChoiceSource;
  ready: boolean;
  blockers: string[];
  reason: string;
  providerId?: string;
  providerName?: string;
  envHints: string[];
}

export interface ModelRoutingPreset {
  id: ModelRoutingPresetId;
  label: string;
  goal: string;
  primary: ModelRoutingChoice;
  fallbacks: ModelRoutingChoice[];
}

export interface ModelRoutingPresetInput {
  workspaceId: string;
  providers: ProviderRecord[];
  readiness?: IntegrationReadinessSummary;
  env?: Record<string, string | undefined>;
}

export interface ModelRoutingPresetSurface {
  version: "phase-72-lane-4";
  presets: Record<ModelRoutingPresetId, ModelRoutingPreset>;
  totals: {
    presets: number;
    ready: number;
    needsSetup: number;
  };
}

type Candidate = ModelRoutingChoice & {
  provider: ProviderKind;
};

interface ProviderDefinition {
  provider: ProviderKind;
  defaultModel: string;
  keyEnv: string[];
  modelEnv: string[];
  requiredEnv: string[];
}

const PROVIDERS: Record<ProviderKind, ProviderDefinition> = {
  openai: {
    provider: "openai",
    defaultModel: "gpt-4o-mini",
    keyEnv: ["OPENAI_API_KEY"],
    modelEnv: ["OPENAI_MODEL", "PACKETAGENT_OPENAI_MODEL"],
    requiredEnv: ["OPENAI_API_KEY"],
  },
  anthropic: {
    provider: "anthropic",
    defaultModel: "claude-3-5-sonnet-latest",
    keyEnv: ["ANTHROPIC_API_KEY"],
    modelEnv: ["ANTHROPIC_MODEL", "PACKETAGENT_ANTHROPIC_MODEL"],
    requiredEnv: ["ANTHROPIC_API_KEY"],
  },
  minimax: {
    provider: "minimax",
    defaultModel: "abab6.5-chat",
    keyEnv: ["MINIMAX_API_KEY"],
    modelEnv: ["MINIMAX_MODEL", "PACKETAGENT_MINIMAX_MODEL"],
    requiredEnv: ["MINIMAX_API_KEY"],
  },
  azure_openai: {
    provider: "azure_openai",
    defaultModel: "gpt-4o-mini",
    keyEnv: ["AZURE_OPENAI_API_KEY"],
    modelEnv: ["AZURE_OPENAI_DEPLOYMENT", "AZURE_OPENAI_MODEL"],
    requiredEnv: ["AZURE_OPENAI_API_KEY"],
  },
  ollama: {
    provider: "ollama",
    defaultModel: "llama3.2",
    keyEnv: [],
    modelEnv: ["OLLAMA_MODEL", "PACKETAGENT_OLLAMA_MODEL"],
    requiredEnv: ["OLLAMA_BASE_URL"],
  },
  gemini: {
    provider: "gemini",
    defaultModel: "gemini-2.0-flash-exp",
    keyEnv: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
    modelEnv: ["GEMINI_MODEL", "PACKETAGENT_GEMINI_MODEL"],
    requiredEnv: ["GOOGLE_API_KEY"],
  },
  custom: {
    provider: "custom",
    defaultModel: "custom-chat",
    keyEnv: ["CUSTOM_PROVIDER_API_KEY"],
    modelEnv: ["CUSTOM_PROVIDER_MODEL", "PACKETAGENT_CUSTOM_PROVIDER_MODEL"],
    requiredEnv: ["CUSTOM_PROVIDER_BASE_URL"],
  },
};

const PRESETS: Array<{
  id: ModelRoutingPresetId;
  label: string;
  goal: string;
  preference: ProviderKind[];
  envHints: string[];
}> = [
  {
    id: "fast",
    label: "Fast",
    goal: "Low-latency drafts, summaries, and interactive agent turns.",
    preference: ["openai", "gemini", "azure_openai", "minimax", "anthropic", "ollama", "custom"],
    envHints: ["PACKETAGENT_MODEL_PRESET_FAST", "PACKETAGENT_FAST_MODEL"],
  },
  {
    id: "smart",
    label: "Smart",
    goal: "Heavier reasoning, review, and planning work where quality matters most.",
    preference: ["anthropic", "gemini", "openai", "azure_openai", "minimax", "custom", "ollama"],
    envHints: ["PACKETAGENT_MODEL_PRESET_SMART", "PACKETAGENT_SMART_MODEL"],
  },
  {
    id: "cheap",
    label: "Cheap",
    goal: "High-volume background work with cost-aware hosted fallbacks.",
    preference: ["gemini", "openai", "minimax", "ollama", "azure_openai", "anthropic", "custom"],
    envHints: ["PACKETAGENT_MODEL_PRESET_CHEAP", "PACKETAGENT_CHEAP_MODEL"],
  },
  {
    id: "local",
    label: "Local",
    goal: "Private local development first, with hosted providers only as fallback.",
    preference: ["ollama", "openai", "anthropic", "gemini", "minimax", "azure_openai", "custom"],
    envHints: ["PACKETAGENT_MODEL_PRESET_LOCAL", "PACKETAGENT_LOCAL_MODEL"],
  },
];

const STUB_CHOICE: ModelRoutingChoice = {
  provider: "stub",
  model: "stub-small",
  source: "fallback",
  ready: true,
  blockers: [],
  reason:
    "No ready workspace or env-backed provider was available, so PacketAgent can use deterministic stub output.",
  envHints: [],
};

export function buildModelRoutingPresets(
  input: ModelRoutingPresetInput,
): ModelRoutingPresetSurface {
  const env = input.env ?? {};
  const candidates = buildCandidates(input, env);
  const presets = Object.fromEntries(
    PRESETS.map((preset) => [preset.id, buildPreset(preset, candidates, env)]),
  ) as Record<ModelRoutingPresetId, ModelRoutingPreset>;

  const ready = Object.values(presets).filter(
    (preset) => preset.primary.ready && preset.primary.provider !== "stub",
  ).length;
  return {
    version: "phase-72-lane-4",
    presets,
    totals: {
      presets: PRESETS.length,
      ready,
      needsSetup: PRESETS.length - ready,
    },
  };
}

function buildPreset(
  preset: (typeof PRESETS)[number],
  candidates: Candidate[],
  env: Record<string, string | undefined>,
): ModelRoutingPreset {
  const override = resolvePresetOverride(preset, candidates, env);
  const primary = override ?? choosePrimary(preset.preference, candidates);
  const fallbacks = fallbackChoices(preset.preference, candidates, primary);
  return {
    id: preset.id,
    label: preset.label,
    goal: preset.goal,
    primary,
    fallbacks,
  };
}

function choosePrimary(preference: ProviderKind[], candidates: Candidate[]): ModelRoutingChoice {
  return (
    firstByPreference(preference, candidates, true) ??
    firstByPreference(preference, candidates, false) ??
    STUB_CHOICE
  );
}

function fallbackChoices(
  preference: ProviderKind[],
  candidates: Candidate[],
  primary: ModelRoutingChoice,
): ModelRoutingChoice[] {
  const ready = byPreference(preference, candidates, true)
    .filter((candidate) => !sameChoice(candidate, primary))
    .slice(0, 3);
  return ready.length > 0 ? ready : primary.provider === "stub" ? [] : [STUB_CHOICE];
}

function firstByPreference(
  preference: ProviderKind[],
  candidates: Candidate[],
  ready: boolean,
): Candidate | null {
  return byPreference(preference, candidates, ready)[0] ?? null;
}

function byPreference(
  preference: ProviderKind[],
  candidates: Candidate[],
  ready: boolean,
): Candidate[] {
  return preference.flatMap((kind) =>
    candidates.filter((candidate) => candidate.provider === kind && candidate.ready === ready),
  );
}

function sameChoice(left: ModelRoutingChoice, right: ModelRoutingChoice): boolean {
  return (
    left.provider === right.provider &&
    left.providerId === right.providerId &&
    left.model === right.model &&
    left.source === right.source
  );
}

function resolvePresetOverride(
  preset: (typeof PRESETS)[number],
  candidates: Candidate[],
  env: Record<string, string | undefined>,
): ModelRoutingChoice | null {
  for (const envName of preset.envHints) {
    const parsed = parsePresetHint(env[envName], preset.preference[0]);
    if (!parsed) continue;
    const candidate =
      candidates.find((entry) => entry.provider === parsed.provider && entry.ready) ??
      candidates.find((entry) => entry.provider === parsed.provider);
    if (!candidate) continue;
    return {
      ...candidate,
      model: parsed.model,
      envHints: [...new Set([...candidate.envHints, envName])],
      reason: `${preset.label} uses the ${envName} model hint with the best matching ${candidate.provider} provider.`,
    };
  }
  return null;
}

function parsePresetHint(
  value: string | undefined,
  fallbackProvider: ProviderKind,
): { provider: ProviderKind; model: string } | null {
  const trimmed = safeModelName(value);
  if (!trimmed) return null;
  const [maybeProvider, ...modelParts] = trimmed.split(":");
  if (modelParts.length === 0) return { provider: fallbackProvider, model: trimmed };
  if (!isProviderKind(maybeProvider)) return { provider: fallbackProvider, model: trimmed };
  const model = safeModelName(modelParts.join(":"));
  return model ? { provider: maybeProvider, model } : null;
}

function buildCandidates(
  input: ModelRoutingPresetInput,
  env: Record<string, string | undefined>,
): Candidate[] {
  const providers = input.providers
    .filter((provider) => provider.workspaceId === input.workspaceId)
    .filter((provider) => isProviderKind(provider.kind))
    .sort((left, right) => left.name.localeCompare(right.name));
  const candidates = providers.map((provider) =>
    candidateFromProvider(provider, input.readiness, env),
  );
  const candidateKinds = new Set(candidates.map((candidate) => candidate.provider));

  for (const definition of Object.values(PROVIDERS)) {
    if (candidateKinds.has(definition.provider)) continue;
    const envCandidate = candidateFromEnv(definition, env, input.readiness);
    if (envCandidate) candidates.push(envCandidate);
  }

  return candidates;
}

function candidateFromProvider(
  provider: ProviderRecord,
  readiness: IntegrationReadinessSummary | undefined,
  env: Record<string, string | undefined>,
): Candidate {
  const definition = PROVIDERS[provider.kind];
  const envModel = firstEnvValue(env, definition.modelEnv);
  const ready = providerReady(provider, readiness, env);
  const blockers = ready ? [] : providerBlockers(provider, readiness, env);
  return {
    provider: provider.kind,
    providerId: provider.id,
    providerName: provider.name,
    model: safeModelName(provider.defaultModel) ?? envModel.value ?? definition.defaultModel,
    source: "workspace_provider",
    ready,
    blockers,
    reason: ready
      ? `${provider.name} is configured for this workspace.`
      : `${provider.name} is present but needs setup before live routing.`,
    envHints: envModel.name ? [envModel.name] : [],
  };
}

function candidateFromEnv(
  definition: ProviderDefinition,
  env: Record<string, string | undefined>,
  readiness: IntegrationReadinessSummary | undefined,
): Candidate | null {
  const hasAnyEnvHint = [
    ...definition.requiredEnv,
    ...definition.keyEnv,
    ...definition.modelEnv,
  ].some((name) => hasValue(env[name]));
  if (!hasAnyEnvHint) return null;

  const hasRequired = definition.requiredEnv.every((name) => hasValue(env[name]));
  const hasKey =
    definition.keyEnv.length === 0 || definition.keyEnv.some((name) => hasValue(env[name]));
  const hasUsableEnv = hasRequired && hasKey;
  const missingProvider = isApiKeyProvider(definition.provider)
    ? (readiness?.providers.missingProviderKinds.includes(definition.provider) ?? false)
    : false;
  if (!hasUsableEnv && missingProvider) return null;

  const model = firstEnvValue(env, definition.modelEnv);
  return {
    provider: definition.provider,
    model: model.value ?? definition.defaultModel,
    source: "env_hint",
    ready: hasUsableEnv,
    blockers: hasUsableEnv
      ? []
      : definition.requiredEnv
          .filter((name) => !hasValue(env[name]))
          .map((name) => `Set ${name} or add a workspace provider.`),
    reason: hasUsableEnv
      ? `${definition.provider} can be inferred from configured environment hints.`
      : `${definition.provider} has model hints but still needs runtime configuration.`,
    envHints: [
      ...definition.requiredEnv.filter((name) => hasValue(env[name])),
      ...definition.keyEnv.filter((name) => hasValue(env[name])),
      ...(model.name ? [model.name] : []),
    ],
  };
}

function providerReady(
  provider: ProviderRecord,
  readiness: IntegrationReadinessSummary | undefined,
  env: Record<string, string | undefined>,
): boolean {
  if (provider.status === "disabled") return false;
  if (provider.kind === "ollama")
    return (
      provider.status === "connected" || Boolean(provider.baseUrl) || hasValue(env.OLLAMA_BASE_URL)
    );
  if (provider.kind === "custom")
    return (
      provider.status === "connected" &&
      (Boolean(provider.baseUrl) || hasValue(env.CUSTOM_PROVIDER_BASE_URL))
    );
  if (provider.kind === "azure_openai")
    return (
      provider.status === "connected" &&
      (provider.apiKeyConfigured || hasValue(env.AZURE_OPENAI_API_KEY))
    );
  const missingApiKey =
    readiness?.providers.missingApiKeys.some((entry) => entry.provider === provider.kind) ?? false;
  return (
    provider.status === "connected" &&
    (provider.apiKeyConfigured ||
      !missingApiKey ||
      PROVIDERS[provider.kind].keyEnv.some((name) => hasValue(env[name])))
  );
}

function providerBlockers(
  provider: ProviderRecord,
  readiness: IntegrationReadinessSummary | undefined,
  env: Record<string, string | undefined>,
): string[] {
  if (provider.status === "disabled") return [`Enable ${provider.name}.`];
  if (provider.kind === "ollama")
    return hasValue(env.OLLAMA_BASE_URL) || provider.baseUrl
      ? []
      : ["Set OLLAMA_BASE_URL or add an Ollama base URL."];
  if (provider.kind === "custom")
    return hasValue(env.CUSTOM_PROVIDER_BASE_URL) || provider.baseUrl
      ? []
      : ["Set CUSTOM_PROVIDER_BASE_URL or add a custom provider base URL."];
  const keyEnv = PROVIDERS[provider.kind].keyEnv;
  const missingApiKey =
    readiness?.providers.missingApiKeys.some((entry) => entry.provider === provider.kind) ??
    !provider.apiKeyConfigured;
  return missingApiKey && !keyEnv.some((name) => hasValue(env[name]))
    ? [`Store or confirm the ${provider.name} API key.`]
    : [`Mark ${provider.name} connected when credentials are ready.`];
}

function firstEnvValue(
  env: Record<string, string | undefined>,
  names: string[],
): { name?: string; value?: string } {
  for (const name of names) {
    const value = safeModelName(env[name]);
    if (value) return { name, value };
  }
  return {};
}

function safeModelName(value: string | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || trimmed.length > 120 || /[\r\n]/.test(trimmed)) return null;
  return trimmed;
}

function hasValue(value: string | undefined): boolean {
  return String(value ?? "").trim().length > 0;
}

function isProviderKind(value: string): value is ProviderKind {
  return (
    value === "openai" ||
    value === "anthropic" ||
    value === "minimax" ||
    value === "azure_openai" ||
    value === "ollama" ||
    value === "gemini" ||
    value === "custom"
  );
}

function isApiKeyProvider(value: ProviderKind): value is ProviderKind & ApiKeyProvider {
  // Narrows to ApiKeyProvider values that are also valid ProviderKinds. Note
  // "openrouter" is an ApiKeyProvider but not a ProviderKind (no workspace
  // provider record kind yet), so it's intentionally excluded here.
  return (
    value === "openai" ||
    value === "anthropic" ||
    value === "minimax" ||
    value === "ollama" ||
    value === "gemini"
  );
}
