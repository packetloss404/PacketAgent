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

import { getDefaultRouter, type ProviderRouter } from "./router.js";
import { listApiKeysForWorkspaceAsync } from "../security/api-key-store.js";
import {
  DEFAULT_PROVIDER_NAMES,
  DEFAULT_PROVIDER_PRIORITY,
  PROVIDER_CATALOG,
  providerEnvHasCredentials,
  providerModel,
  type ModelPreset,
} from "./catalog.js";
import type { ProviderName } from "./types.js";

export type { ModelPreset } from "./catalog.js";

export interface ResolvedPreset {
  provider: ProviderName;
  model: string;
  /** True when the provider is local (no per-token cost). */
  local: boolean;
}

export interface ProviderReadinessEntry {
  provider: ProviderName;
  label: string;
  registered: boolean;
  ready: boolean;
  credentialSource: "environment" | "workspace_vault" | "local" | "none";
  defaultModels: (typeof PROVIDER_CATALOG)[ProviderName]["defaultModels"];
  capabilities: (typeof PROVIDER_CATALOG)[ProviderName]["capabilities"];
  generation: (typeof PROVIDER_CATALOG)[ProviderName]["generation"];
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
  /** Pure/test override for the providers with a usable workspace vault key. */
  vaultProviders?: Iterable<ProviderName>;
}

/**
 * Returns true when the provider has a process credential, a workspace vault
 * credential, or is a local provider that does not require a key.
 */
export function providerHasCredentials(
  provider: ProviderName,
  env: NodeJS.ProcessEnv = process.env,
  vaultProviders: Iterable<ProviderName> = [],
): boolean {
  if (new Set(vaultProviders).has(provider)) return true;
  return providerEnvHasCredentials(provider, env);
}

export async function vaultProviderNamesForWorkspace(workspaceId: string): Promise<ProviderName[]> {
  try {
    return [
      ...new Set(
        (await listApiKeysForWorkspaceAsync(workspaceId))
          .map((record) => record.provider as ProviderName)
          .filter((provider) => PROVIDER_CATALOG[provider]?.capabilities.vaultKey),
      ),
    ];
  } catch {
    return [];
  }
}

/**
 * Returns the list of providers that the resolver will consider, after
 * applying the optional `PACKETAGENT_PROVIDER_PRIORITY` override. Filters to
 * providers that are both registered on the router AND have credentials.
 */
export function availableProviders(opts: ResolvePresetOptions = {}): ProviderName[] {
  const router = opts.router ?? getDefaultRouter();
  const env = opts.env ?? process.env;
  const vaultProviders = effectiveVaultProviders(opts);
  const registered = new Set(router.registeredProviders());
  const out: ProviderName[] = [];
  for (const provider of registered) {
    if (providerHasCredentials(provider, env, vaultProviders)) out.push(provider);
  }
  return out;
}

export function providerReadinessSnapshot(
  opts: ResolvePresetOptions = {},
): ProviderReadinessEntry[] {
  const router = opts.router ?? getDefaultRouter();
  const env = opts.env ?? process.env;
  const vaultProviders = new Set(effectiveVaultProviders(opts));
  const registered = new Set(router.registeredProviders());
  return DEFAULT_PROVIDER_NAMES.map((provider) => {
    const entry = PROVIDER_CATALOG[provider];
    const credentialSource =
      entry.locality === "local"
        ? "local"
        : vaultProviders.has(provider)
          ? "workspace_vault"
          : providerEnvHasCredentials(provider, env)
            ? "environment"
            : "none";
    return {
      provider,
      label: entry.label,
      registered: registered.has(provider),
      ready: registered.has(provider) && credentialSource !== "none",
      credentialSource,
      defaultModels: entry.defaultModels,
      capabilities: entry.capabilities,
      generation: entry.generation,
    };
  });
}

function parsePriorityOverride(env: NodeJS.ProcessEnv): ProviderName[] | null {
  const raw = env.PACKETAGENT_PROVIDER_PRIORITY;
  if (!raw || raw.trim().length === 0) return null;
  const parts = raw
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const valid: ProviderName[] = [];
  for (const part of parts) {
    if (
      part === "anthropic" ||
      part === "openai" ||
      part === "minimax" ||
      part === "ollama" ||
      part === "gemini" ||
      part === "openrouter"
    ) {
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
  const vaultProviders = effectiveVaultProviders(options);
  const effectivePreset: ModelPreset = preset ?? "fast";

  // Explicit provider override short-circuits the priority walk.
  if (options.providerOverride) {
    const provider = options.providerOverride;
    if (!providerHasCredentials(provider, env, vaultProviders)) return null;
    const model =
      options.modelOverride && options.modelOverride.trim().length > 0
        ? options.modelOverride.trim()
        : providerModel(provider, effectivePreset);
    return { provider, model, local: PROVIDER_CATALOG[provider].locality === "local" };
  }

  const registered = new Set(router.registeredProviders());
  const override = parsePriorityOverride(env);
  const candidates = override ?? DEFAULT_PROVIDER_PRIORITY[effectivePreset];

  for (const provider of candidates) {
    if (!registered.has(provider)) continue;
    if (!providerHasCredentials(provider, env, vaultProviders)) continue;
    if (effectivePreset === "local" && PROVIDER_CATALOG[provider].locality !== "local") continue;
    const model =
      options.modelOverride && options.modelOverride.trim().length > 0
        ? options.modelOverride.trim()
        : providerModel(provider, effectivePreset);
    return { provider, model, local: PROVIDER_CATALOG[provider].locality === "local" };
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

function effectiveVaultProviders(options: ResolvePresetOptions): Iterable<ProviderName> {
  return options.vaultProviders ?? [];
}
