import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { OpenRouterProvider } from "./openrouter.js";
import { MiniMaxProvider } from "./minimax.js";
import { OllamaProvider } from "./ollama.js";
import { GeminiProvider } from "./gemini.js";
import { getDefaultRouter } from "./router.js";
import { vaultApiKeyResolver } from "../security/api-key-store.js";
import type { ApiKeyProvider } from "../packetagent-store.js";
import { VAULT_PROVIDER_NAMES } from "./catalog.js";
import type { ApiKeyResolver, ProviderName } from "./types.js";

let registered = false;

export { DEFAULT_PROVIDER_NAMES } from "./catalog.js";

const VAULT_PROVIDERS: ReadonlySet<ProviderName> = new Set(VAULT_PROVIDER_NAMES);

const adaptedResolver: ApiKeyResolver = (workspaceId: string, provider: ProviderName) => {
  if (provider === "stub") return Promise.resolve(null);
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
  // Registration is credential-agnostic. Each request resolves its workspace
  // vault key first and then falls back to the process environment.
  router.register("gemini", new GeminiProvider({ apiKeyResolver: adaptedResolver }));
  router.register("openrouter", new OpenRouterProvider({ apiKeyResolver: adaptedResolver }));
}
