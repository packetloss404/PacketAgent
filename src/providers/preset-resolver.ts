// =============================================================================
// Preset resolver
// =============================================================================
//
// The Builder UI exposes four user-facing presets (`fast`, `smart`, `cheap`,
// `local`). The actual provider+model that should serve each preset depends on
// which API keys the operator has configured. This module resolves a preset to
// a concrete `(provider, model)` pair so callers can drive the router without
// hard-coding Anthropic.
//
// Priority order (default):
//   1. Local providers (`ollama`) when the `local` preset is requested OR when
//      we have nothing better. Local is always free, so it's the fallback for
//      `cheap` if no hosted cost-aware provider is configured.
//   2. For `cheap`: OpenRouter → Gemini → OpenAI(mini) → Anthropic(haiku) →
//      Ollama.
//   3. For `fast` / `smart`: Anthropic → OpenAI → Gemini → OpenRouter → Ollama.
//
// Operators can override the order with `PACKETAGENT_PROVIDER_PRIORITY`, a
// comma-separated list of provider names, e.g.
//   PACKETAGENT_PROVIDER_PRIORITY=ollama,openrouter,anthropic
// The override applies to every preset; the first provider in the list that
// has a configured key (env or vault) wins.
//
// If no provider matches, `resolvePresetToProviderModel` returns `null` and
// callers fall back to their template-only path.
// =============================================================================

import type { ProviderName } from "./types.js";
import { getDefaultRouter, type ProviderRouter } from "./router.js";

export type ModelPreset = "fast" | "smart" | "cheap" | "local";

export interface ResolvedPreset {
  provider: ProviderName;
  model: string;
  /** True when the provider is local (no per-token cost). */
  local: boolean;
}

export interface ResolvePresetOptions {
  /** Override the default router instance (used by tests). */
  router?: ProviderRouter;
  /** Override env. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Explicit model override (bypasses preset table). */
  modelOverride?: string;
  /** Forces a specific provider regardless of preset/priority. */
  providerOverride?: ProviderName;
}

// Per-preset model picks for each provider. When a provider doesn't have a
// natural match for a preset (e.g. Ollama has no "smart" model out of the box)
// we still return its default so the preset stays functional.
const PRESET_MODELS: Record<ProviderName, Record<ModelPreset, string>> = {
  anthropic: {
    fast: "claude-sonnet-4-6",
    smart: "claude-opus-4-7",
    cheap: "claude-haiku-4-5-20251001",
    local: "claude-haiku-4-5-20251001",
  },
  openai: {
    fast: "gpt-4o-mini",
    smart: "gpt-4o",
    cheap: "gpt-4o-mini",
    local: "gpt-4o-mini",
  },
  minimax: {
    fast: "abab6.5-chat",
    smart: "abab6.5-chat",
    cheap: "abab6.5-chat",
    local: "abab6.5-chat",
  },
  // Ollama / generic-local defaults. These names assume a local Ollama tag
  // catalog; when pointing at vLLM / LM Studio / llama.cpp the model name
  // probably doesn't match what's loaded — set LOCAL_LLM_MODEL to override
  // every local call to a single specific model.
  ollama: {
    fast: "llama3.2",
    smart: "qwen2.5-coder:32b",
    cheap: "qwen2.5-coder:7b",
    local: "qwen2.5-coder:32b",
  },
  gemini: {
    fast: "gemini-2.5-flash",
    smart: "gemini-2.5-pro",
    cheap: "gemini-2.5-flash",
    local: "gemini-2.5-flash",
  },
  openrouter: {
    // OpenRouter is a marketplace; default to a cheap-but-capable pick.
    fast: "google/gemini-2.5-flash",
    smart: "anthropic/claude-sonnet-4",
    cheap: "google/gemini-2.5-flash",
    local: "google/gemini-2.5-flash",
  },
  stub: { fast: "stub-small", smart: "stub-small", cheap: "stub-small", local: "stub-small" },
};

// Default priority lists per preset. The resolver walks each list and picks the
// first provider that (a) is registered and (b) has a configured key.
const DEFAULT_PRIORITY: Record<ModelPreset, ProviderName[]> = {
  cheap: ["openrouter", "gemini", "openai", "anthropic", "ollama"],
  fast: ["anthropic", "openai", "gemini", "openrouter", "ollama"],
  smart: ["anthropic", "openai", "gemini", "openrouter", "ollama"],
  local: ["ollama"],
};

const LOCAL_PROVIDERS: ReadonlySet<ProviderName> = new Set(["ollama"]);

function envKeyName(provider: ProviderName): string | null {
  switch (provider) {
    case "anthropic": return "ANTHROPIC_API_KEY";
    case "openai": return "OPENAI_API_KEY";
    case "minimax": return "MINIMAX_API_KEY";
    case "gemini": return "GEMINI_API_KEY";
    case "openrouter": return "OPENROUTER_API_KEY";
    case "ollama": return null; // local; no key required
    case "stub": return null;
  }
}

/**
 * Returns true when the given provider is "usable" — either it has an env key,
 * or it is a local provider that doesn't require one.
 *
 * Note: this is an env-only check. Vault-only keys (per-workspace) are not
 * detected here; the resolver is meant to give callers a server-wide signal
 * about what is configured, not what a specific workspace can use.
 */
export function providerHasCredentials(provider: ProviderName, env: NodeJS.ProcessEnv = process.env): boolean {
  if (provider === "ollama") return true; // assume reachable; ollama provider degrades gracefully
  const key = envKeyName(provider);
  if (!key) return false;
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Returns the list of providers that the resolver will consider, after
 * applying the optional `PACKETAGENT_PROVIDER_PRIORITY` override. Filters to
 * providers that are both registered on the router AND have credentials.
 */
export function availableProviders(opts: ResolvePresetOptions = {}): ProviderName[] {
  const router = opts.router ?? getDefaultRouter();
  const env = opts.env ?? process.env;
  const registered = new Set(router.registeredProviders());
  const out: ProviderName[] = [];
  for (const provider of registered) {
    if (providerHasCredentials(provider, env)) out.push(provider);
  }
  return out;
}

function parsePriorityOverride(env: NodeJS.ProcessEnv): ProviderName[] | null {
  const raw = env.PACKETAGENT_PROVIDER_PRIORITY;
  if (!raw || raw.trim().length === 0) return null;
  const parts = raw.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
  const valid: ProviderName[] = [];
  for (const part of parts) {
    if (part === "anthropic" || part === "openai" || part === "minimax" || part === "ollama" || part === "gemini" || part === "openrouter") {
      valid.push(part);
    }
  }
  return valid.length > 0 ? valid : null;
}

/**
 * Resolves a user-facing preset to a concrete (provider, model). Returns
 * `null` when nothing is configured for the preset (callers should fall back
 * to their template path).
 *
 * The `local` preset is strict: it ONLY returns a local provider (Ollama,
 * vLLM…). If no local provider is configured, returns `null` instead of
 * silently routing to a hosted provider.
 */
export function resolvePresetToProviderModel(
  preset: ModelPreset | undefined,
  options: ResolvePresetOptions = {},
): ResolvedPreset | null {
  const env = options.env ?? process.env;
  const router = options.router ?? getDefaultRouter();
  const effectivePreset: ModelPreset = preset ?? "fast";

  // Explicit provider override short-circuits the priority walk.
  if (options.providerOverride) {
    const provider = options.providerOverride;
    if (!providerHasCredentials(provider, env)) return null;
    const model = options.modelOverride && options.modelOverride.trim().length > 0
      ? options.modelOverride.trim()
      : PRESET_MODELS[provider][effectivePreset];
    return { provider, model, local: LOCAL_PROVIDERS.has(provider) };
  }

  const registered = new Set(router.registeredProviders());
  const override = parsePriorityOverride(env);
  const candidates = override ?? DEFAULT_PRIORITY[effectivePreset];

  for (const provider of candidates) {
    if (!registered.has(provider)) continue;
    if (!providerHasCredentials(provider, env)) continue;
    if (effectivePreset === "local" && !LOCAL_PROVIDERS.has(provider)) continue;
    const model = options.modelOverride && options.modelOverride.trim().length > 0
      ? options.modelOverride.trim()
      : PRESET_MODELS[provider][effectivePreset];
    return { provider, model, local: LOCAL_PROVIDERS.has(provider) };
  }

  return null;
}

/**
 * Computes a snapshot of how every preset currently resolves. Used by the
 * `/api/app/builder/providers/status` endpoint to render the UI chip labels.
 * Safe to expose to the client: no secrets are included.
 */
export function snapshotPresetResolutions(
  options: ResolvePresetOptions = {},
): Record<ModelPreset, ResolvedPreset | null> {
  return {
    fast: resolvePresetToProviderModel("fast", options),
    smart: resolvePresetToProviderModel("smart", options),
    cheap: resolvePresetToProviderModel("cheap", options),
    local: resolvePresetToProviderModel("local", options),
  };
}
