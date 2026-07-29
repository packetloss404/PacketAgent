import type { ProviderName } from "./types.js";

export type ModelPreset = "fast" | "smart" | "cheap" | "local";
export type ProviderLocality = "hosted" | "local" | "test";
export type ProviderTransport =
  | "anthropic-messages"
  | "openai-chat"
  | "openai-compatible"
  | "ollama-or-openai-compatible"
  | "deterministic";
export type StructuredOutputSupport = "native" | "conditional" | "none";
export type StructuredOutputTransport =
  | "response_format"
  | "output_config"
  | "vllm_structured_outputs"
  | "none";
export type ToolUseSupport = "native" | "conditional" | "deterministic";

export interface ProviderGenerationPolicy {
  fileWriteMode: "multi_file_per_turn" | "single_file_per_turn";
  iterationMode: "single_turn" | "multi_turn";
  malformedToolInputCorrectionAttempts: 1;
  structuredOutputFallback: "best_effort_json";
}

export interface ProviderCapabilities {
  streaming: boolean;
  toolUse: ToolUseSupport;
  structuredOutput: StructuredOutputSupport;
  structuredOutputTransport: StructuredOutputTransport;
  vaultKey: boolean;
  liveModelDiscovery: boolean;
}

export interface ProviderCatalogEntry {
  name: ProviderName;
  label: string;
  locality: ProviderLocality;
  transport: ProviderTransport;
  credentialEnv: readonly string[];
  configurationEnv: readonly string[];
  modelEnv: readonly string[];
  defaultModels: Readonly<Record<ModelPreset, string>>;
  capabilities: Readonly<ProviderCapabilities>;
  generation: Readonly<ProviderGenerationPolicy>;
}

const HOSTED_GENERATION_POLICY = {
  fileWriteMode: "multi_file_per_turn",
  iterationMode: "single_turn",
  malformedToolInputCorrectionAttempts: 1,
  structuredOutputFallback: "best_effort_json",
} as const satisfies ProviderGenerationPolicy;

const LOCAL_GENERATION_POLICY = {
  fileWriteMode: "single_file_per_turn",
  iterationMode: "multi_turn",
  malformedToolInputCorrectionAttempts: 1,
  structuredOutputFallback: "best_effort_json",
} as const satisfies ProviderGenerationPolicy;

const STUB_GENERATION_POLICY = {
  fileWriteMode: "single_file_per_turn",
  iterationMode: "single_turn",
  malformedToolInputCorrectionAttempts: 1,
  structuredOutputFallback: "best_effort_json",
} as const satisfies ProviderGenerationPolicy;

export const PROVIDER_CATALOG = {
  anthropic: {
    name: "anthropic",
    label: "Anthropic",
    locality: "hosted",
    transport: "anthropic-messages",
    credentialEnv: ["ANTHROPIC_API_KEY"],
    configurationEnv: [],
    modelEnv: ["ANTHROPIC_MODEL", "PACKETAGENT_ANTHROPIC_MODEL"],
    defaultModels: {
      fast: "claude-sonnet-4-6",
      smart: "claude-opus-4-7",
      cheap: "claude-haiku-4-5-20251001",
      local: "claude-haiku-4-5-20251001",
    },
    capabilities: {
      streaming: true,
      toolUse: "native",
      structuredOutput: "native",
      structuredOutputTransport: "output_config",
      vaultKey: true,
      liveModelDiscovery: false,
    },
    generation: HOSTED_GENERATION_POLICY,
  },
  openai: {
    name: "openai",
    label: "OpenAI",
    locality: "hosted",
    transport: "openai-chat",
    credentialEnv: ["OPENAI_API_KEY"],
    configurationEnv: [],
    modelEnv: ["OPENAI_MODEL", "PACKETAGENT_OPENAI_MODEL"],
    defaultModels: {
      fast: "gpt-4o-mini",
      smart: "gpt-4o",
      cheap: "gpt-4o-mini",
      local: "gpt-4o-mini",
    },
    capabilities: {
      streaming: true,
      toolUse: "native",
      structuredOutput: "native",
      structuredOutputTransport: "response_format",
      vaultKey: true,
      liveModelDiscovery: false,
    },
    generation: HOSTED_GENERATION_POLICY,
  },
  openrouter: {
    name: "openrouter",
    label: "OpenRouter",
    locality: "hosted",
    transport: "openai-compatible",
    credentialEnv: ["OPENROUTER_API_KEY"],
    configurationEnv: [],
    modelEnv: ["OPENROUTER_MODEL", "PACKETAGENT_OPENROUTER_MODEL"],
    defaultModels: {
      fast: "anthropic/claude-haiku-4-5",
      smart: "anthropic/claude-sonnet-4-6",
      cheap: "qwen/qwen3-coder",
      local: "qwen/qwen3-coder",
    },
    capabilities: {
      streaming: true,
      toolUse: "conditional",
      structuredOutput: "conditional",
      structuredOutputTransport: "response_format",
      vaultKey: true,
      liveModelDiscovery: false,
    },
    generation: HOSTED_GENERATION_POLICY,
  },
  minimax: {
    name: "minimax",
    label: "MiniMax",
    locality: "hosted",
    transport: "openai-compatible",
    credentialEnv: ["MINIMAX_API_KEY"],
    configurationEnv: [],
    modelEnv: ["MINIMAX_MODEL", "PACKETAGENT_MINIMAX_MODEL"],
    defaultModels: {
      fast: "abab6.5-chat",
      smart: "abab6.5-chat",
      cheap: "abab6.5-chat",
      local: "abab6.5-chat",
    },
    capabilities: {
      streaming: true,
      toolUse: "native",
      structuredOutput: "none",
      structuredOutputTransport: "none",
      vaultKey: true,
      liveModelDiscovery: false,
    },
    generation: HOSTED_GENERATION_POLICY,
  },
  ollama: {
    name: "ollama",
    label: "Local LLM",
    locality: "local",
    transport: "ollama-or-openai-compatible",
    credentialEnv: [],
    configurationEnv: ["LOCAL_LLM_BASE_URL", "OLLAMA_BASE_URL"],
    modelEnv: ["LOCAL_LLM_MODEL", "OLLAMA_MODEL", "PACKETAGENT_OLLAMA_MODEL"],
    defaultModels: {
      fast: "llama3.2",
      smart: "qwen2.5-coder:32b",
      cheap: "qwen2.5-coder:7b",
      local: "qwen2.5-coder:32b",
    },
    capabilities: {
      streaming: true,
      toolUse: "conditional",
      structuredOutput: "conditional",
      structuredOutputTransport: "vllm_structured_outputs",
      vaultKey: false,
      liveModelDiscovery: true,
    },
    generation: LOCAL_GENERATION_POLICY,
  },
  gemini: {
    name: "gemini",
    label: "Google Gemini",
    locality: "hosted",
    transport: "openai-compatible",
    credentialEnv: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
    configurationEnv: [],
    modelEnv: ["GEMINI_MODEL", "PACKETAGENT_GEMINI_MODEL"],
    defaultModels: {
      fast: "gemini-2.5-flash",
      smart: "gemini-2.5-pro",
      cheap: "gemini-2.5-flash",
      local: "gemini-2.5-flash",
    },
    capabilities: {
      streaming: true,
      toolUse: "native",
      structuredOutput: "native",
      structuredOutputTransport: "response_format",
      vaultKey: true,
      liveModelDiscovery: false,
    },
    generation: HOSTED_GENERATION_POLICY,
  },
  stub: {
    name: "stub",
    label: "Deterministic stub",
    locality: "test",
    transport: "deterministic",
    credentialEnv: [],
    configurationEnv: [],
    modelEnv: [],
    defaultModels: {
      fast: "stub-small",
      smart: "stub-small",
      cheap: "stub-small",
      local: "stub-small",
    },
    capabilities: {
      streaming: true,
      toolUse: "deterministic",
      structuredOutput: "none",
      structuredOutputTransport: "none",
      vaultKey: false,
      liveModelDiscovery: false,
    },
    generation: STUB_GENERATION_POLICY,
  },
} as const satisfies Record<ProviderName, ProviderCatalogEntry>;

export const RUNTIME_PROVIDER_NAMES = Object.freeze(
  Object.keys(PROVIDER_CATALOG) as ProviderName[],
);

export const DEFAULT_PROVIDER_NAMES = Object.freeze(
  RUNTIME_PROVIDER_NAMES.filter((name) => name !== "stub"),
);

export const VAULT_PROVIDER_NAMES = Object.freeze(
  DEFAULT_PROVIDER_NAMES.filter((name) => PROVIDER_CATALOG[name].capabilities.vaultKey),
);

export const DEFAULT_PROVIDER_PRIORITY: Readonly<Record<ModelPreset, readonly ProviderName[]>> = {
  cheap: ["openrouter", "gemini", "openai", "minimax", "anthropic", "ollama"],
  fast: ["anthropic", "openai", "gemini", "openrouter", "minimax", "ollama"],
  smart: ["anthropic", "openai", "gemini", "openrouter", "minimax", "ollama"],
  local: ["ollama"],
};

export function providerCatalogEntry(name: ProviderName): ProviderCatalogEntry {
  return PROVIDER_CATALOG[name];
}

export function providerGenerationPolicy(name: ProviderName): ProviderGenerationPolicy {
  return PROVIDER_CATALOG[name].generation;
}

export function providerEnvHasCredentials(
  name: ProviderName,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const entry = PROVIDER_CATALOG[name];
  if (entry.locality === "local") return true;
  if (entry.locality === "test") return false;
  return entry.credentialEnv.some((envName) => String(env[envName] ?? "").trim().length > 0);
}

export function providerModel(name: ProviderName, preset: ModelPreset): string {
  return PROVIDER_CATALOG[name].defaultModels[preset];
}
