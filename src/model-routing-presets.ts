import type { IntegrationReadinessSummary } from "./packetagent-services.js";
import type { ApiKeyProvider, ProviderKind, ProviderRecord } from "./packetagent-store.js";
import {
  DEFAULT_PROVIDER_NAMES,
  DEFAULT_PROVIDER_PRIORITY,
  PROVIDER_CATALOG,
  providerModel,
} from "./providers/catalog.js";

export type ModelRoutingPresetId = "fast" | "smart" | "cheap" | "local";
export type ModelRoutingProviderKind = ProviderKind | "stub";
export type ModelRoutingChoiceSource =
  | "workspace_provider"
  | "workspace_vault"
  | "env_hint"
  | "fallback";

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
  vaultProviders?: ApiKeyProvider[];
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
  requiredAnyEnv?: string[];
}

const RUNTIME_PROVIDERS = Object.fromEntries(
  DEFAULT_PROVIDER_NAMES.map((provider) => {
    const entry = PROVIDER_CATALOG[provider];
    return [
      provider,
      {
        provider,
        defaultModel: providerModel(provider, "fast"),
        keyEnv: [...entry.credentialEnv],
        modelEnv: [...entry.modelEnv],
        requiredEnv: [],
        ...(entry.configurationEnv.length > 0
          ? { requiredAnyEnv: [...entry.configurationEnv] }
          : {}),
      } satisfies ProviderDefinition,
    ];
  }),
) as unknown as Record<(typeof DEFAULT_PROVIDER_NAMES)[number], ProviderDefinition>;

const PROVIDERS: Record<ProviderKind, ProviderDefinition> = {
  ...RUNTIME_PROVIDERS,
  azure_openai: {
    provider: "azure_openai",
    defaultModel: "gpt-4o-mini",
    keyEnv: ["AZURE_OPENAI_API_KEY"],
    modelEnv: ["AZURE_OPENAI_DEPLOYMENT", "AZURE_OPENAI_MODEL"],
    requiredEnv: ["AZURE_OPENAI_API_KEY"],
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
    preference: [...DEFAULT_PROVIDER_PRIORITY.fast, "azure_openai", "custom"] as ProviderKind[],
    envHints: ["PACKETAGENT_MODEL_PRESET_FAST", "PACKETAGENT_FAST_MODEL"],
  },
  {
    id: "smart",
    label: "Smart",
    goal: "Heavier reasoning, review, and planning work where quality matters most.",
    preference: [...DEFAULT_PROVIDER_PRIORITY.smart, "azure_openai", "custom"] as ProviderKind[],
    envHints: ["PACKETAGENT_MODEL_PRESET_SMART", "PACKETAGENT_SMART_MODEL"],
  },
  {
    id: "cheap",
    label: "Cheap",
    goal: "High-volume background work with cost-aware hosted fallbacks.",
    preference: [...DEFAULT_PROVIDER_PRIORITY.cheap, "azure_openai", "custom"] as ProviderKind[],
    envHints: ["PACKETAGENT_MODEL_PRESET_CHEAP", "PACKETAGENT_CHEAP_MODEL"],
  },
  {
    id: "local",
    label: "Local",
    goal: "Private local development first, with hosted providers only as fallback.",
    preference: [
      ...DEFAULT_PROVIDER_PRIORITY.local,
      ...DEFAULT_PROVIDER_PRIORITY.fast.filter((provider) => provider !== "ollama"),
      "azure_openai",
      "custom",
    ] as ProviderKind[],
    envHints: ["PACKETAGENT_MODEL_PRESET_LOCAL", "PACKETAGENT_LOCAL_MODEL"],
  },
];

const STUB_CHOICE: ModelRoutingChoice = {
  provider: "stub",
  model: providerModel("stub", "fast"),
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
  const presetCandidates = candidates.map((candidate) => candidateForPreset(candidate, preset.id));
  const override = resolvePresetOverride(preset, presetCandidates, env);
  const primary = override ?? choosePrimary(preset.preference, presetCandidates);
  const fallbacks = fallbackChoices(preset.preference, presetCandidates, primary);
  return {
    id: preset.id,
    label: preset.label,
    goal: preset.goal,
    primary,
    fallbacks,
  };
}

function candidateForPreset(candidate: Candidate, preset: ModelRoutingPresetId): Candidate {
  if (candidate.source === "workspace_provider") return candidate;
  const definition = PROVIDERS[candidate.provider];
  if (definition.modelEnv.some((name) => candidate.envHints.includes(name))) return candidate;
  if (!(candidate.provider in PROVIDER_CATALOG)) return candidate;
  return {
    ...candidate,
    model: providerModel(candidate.provider as keyof typeof PROVIDER_CATALOG, preset),
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
  const vaultProviders = new Set(input.vaultProviders ?? []);

  for (const definition of Object.values(PROVIDERS)) {
    if (candidateKinds.has(definition.provider)) continue;
    const envCandidate = candidateFromConfiguration(
      definition,
      env,
      input.readiness,
      vaultProviders,
    );
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

function candidateFromConfiguration(
  definition: ProviderDefinition,
  env: Record<string, string | undefined>,
  readiness: IntegrationReadinessSummary | undefined,
  vaultProviders: ReadonlySet<ApiKeyProvider>,
): Candidate | null {
  const hasVaultKey =
    isApiKeyProvider(definition.provider) && vaultProviders.has(definition.provider);
  const hasAnyEnvHint = [
    ...definition.requiredEnv,
    ...(definition.requiredAnyEnv ?? []),
    ...definition.keyEnv,
    ...definition.modelEnv,
  ].some((name) => hasValue(env[name]));
  if (!hasAnyEnvHint && !hasVaultKey) return null;

  const hasRequired =
    definition.requiredEnv.every((name) => hasValue(env[name])) &&
    (!definition.requiredAnyEnv ||
      definition.requiredAnyEnv.length === 0 ||
      definition.requiredAnyEnv.some((name) => hasValue(env[name])));
  const hasKey =
    definition.keyEnv.length === 0 ||
    definition.keyEnv.some((name) => hasValue(env[name])) ||
    hasVaultKey;
  const hasUsableEnv = hasRequired && hasKey;
  const missingProvider = isApiKeyProvider(definition.provider)
    ? (readiness?.providers.missingProviderKinds.includes(definition.provider) ?? false)
    : false;
  if (!hasUsableEnv && missingProvider) return null;

  const model = firstEnvValue(env, definition.modelEnv);
  return {
    provider: definition.provider,
    model: model.value ?? definition.defaultModel,
    source: hasVaultKey ? "workspace_vault" : "env_hint",
    ready: hasUsableEnv,
    blockers: hasUsableEnv
      ? []
      : definition.requiredEnv
          .filter((name) => !hasValue(env[name]))
          .map((name) => `Set ${name} or add a workspace provider.`)
          .concat(
            definition.requiredAnyEnv &&
              !definition.requiredAnyEnv.some((name) => hasValue(env[name]))
              ? [`Set one of ${definition.requiredAnyEnv.join(", ")} or add a workspace provider.`]
              : [],
          ),
    reason: hasUsableEnv
      ? hasVaultKey
        ? `${definition.provider} can use an encrypted workspace vault key.`
        : `${definition.provider} can be inferred from configured environment hints.`
      : `${definition.provider} has model hints but still needs runtime configuration.`,
    envHints: [
      ...definition.requiredEnv.filter((name) => hasValue(env[name])),
      ...(definition.requiredAnyEnv ?? []).filter((name) => hasValue(env[name])),
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
    return hasValue(env.LOCAL_LLM_BASE_URL) || hasValue(env.OLLAMA_BASE_URL) || provider.baseUrl
      ? []
      : ["Set LOCAL_LLM_BASE_URL, OLLAMA_BASE_URL, or add a local LLM base URL."];
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
    value === "openrouter" ||
    value === "custom"
  );
}

function isApiKeyProvider(value: ProviderKind): value is ProviderKind & ApiKeyProvider {
  return (
    value === "openai" ||
    value === "anthropic" ||
    value === "minimax" ||
    value === "ollama" ||
    value === "gemini" ||
    value === "openrouter"
  );
}
