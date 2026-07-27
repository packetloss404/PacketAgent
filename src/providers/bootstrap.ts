import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { OpenRouterProvider } from "./openrouter.js";
import { MiniMaxProvider } from "./minimax.js";
import { OllamaProvider } from "./ollama.js";
import { GeminiProvider } from "./gemini.js";
import { getDefaultRouter, hasGeminiEnvKey } from "./router.js";
import { vaultApiKeyResolver } from "../security/api-key-store.js";
import type { ApiKeyProvider } from "../packetagent-store.js";
import type { ApiKeyResolver, ProviderName } from "./types.js";

let registered = false;

export const DEFAULT_PROVIDER_NAMES = [
  "anthropic",
  "openai",
  "openrouter",
  "minimax",
  "ollama",
  "gemini",
] as const satisfies readonly ProviderName[];

const VAULT_PROVIDERS: ReadonlySet<ProviderName> = new Set(["anthropic", "openai", "minimax", "ollama"]);

const adaptedResolver: ApiKeyResolver = (workspaceId: string, provider: ProviderName) => {
  if (provider === "stub") return Promise.resolve(null);
  // Gemini and OpenRouter aren't in the ApiKeyProvider vault enum yet; once
  // those vault keys are added, drop this guard and pass them through.
  if (!VAULT_PROVIDERS.has(provider)) return Promise.resolve(null);
  return vaultApiKeyResolver(workspaceId, provider as ApiKeyProvider);
};

/** Test-only: resets the module-level guard so registration can re-run. */
export function resetRegisteredProvidersForTests(): void {
  registered = false;
}

export function registerDefaultProviders(): void {
  if (registered) return;
  registered = true;
  const router = getDefaultRouter();
  router.register("anthropic", new AnthropicProvider({ apiKeyResolver: adaptedResolver }));
  router.register("openai", new OpenAIProvider({ apiKeyResolver: adaptedResolver }));
  router.register("minimax", new MiniMaxProvider({ apiKeyResolver: adaptedResolver }));
  router.register("ollama", new OllamaProvider());
  // Gemini is opt-in via env: only register when GOOGLE_API_KEY (or
  // GEMINI_API_KEY) is present.
  if (hasGeminiEnvKey()) {
    router.register("gemini", new GeminiProvider({ apiKeyResolver: adaptedResolver }));
  }
  // OpenRouter: only register when the env key is present.
  if (process.env.OPENROUTER_API_KEY) {
    router.register("openrouter", new OpenRouterProvider({ apiKeyResolver: adaptedResolver }));
  }
}
