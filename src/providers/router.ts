import type {
  LLMProvider,
  ProviderCallOptions,
  ProviderCallResult,
  ProviderName,
  ProviderStreamChunk,
} from "./types.js";
import { StubProvider } from "./stub.js";
import { readGeminiEnvKey } from "./gemini.js";
import {
  providerGenerationPolicy,
  providerModel,
  type ProviderGenerationPolicy,
} from "./catalog.js";

export interface ProviderRoute {
  provider: ProviderName;
  model: string;
}

export const DEFAULT_ROUTES: Record<string, ProviderRoute> = {
  "workflow.draft": { provider: "anthropic", model: providerModel("anthropic", "smart") },
  "workflow.brief_rewrite": {
    provider: "anthropic",
    model: providerModel("anthropic", "fast"),
  },
  "workflow.plan_mode": { provider: "anthropic", model: providerModel("anthropic", "smart") },
  "agent.summary": { provider: "openai", model: providerModel("openai", "fast") },
  "agent.reasoning": { provider: "anthropic", model: providerModel("anthropic", "smart") },
  "code.generation": { provider: "minimax", model: providerModel("minimax", "smart") },
  "local.dev": { provider: "ollama", model: providerModel("ollama", "fast") },
  // Gemini BYOK presets — used when the caller selects `provider: "gemini"` or
  // when the user only has GOOGLE_API_KEY / GEMINI_API_KEY configured.
  "gemini.cheap": { provider: "gemini", model: providerModel("gemini", "cheap") },
  "gemini.fast": { provider: "gemini", model: providerModel("gemini", "fast") },
  "gemini.smart": { provider: "gemini", model: providerModel("gemini", "smart") },
  // OpenRouter presets: when a user only has an OPENROUTER_API_KEY they still
  // get usable defaults for the cheap/fast/smart tiers via OpenRouter's proxy.
  "byok.openrouter.cheap": {
    provider: "openrouter",
    model: providerModel("openrouter", "cheap"),
  },
  "byok.openrouter.fast": {
    provider: "openrouter",
    model: providerModel("openrouter", "fast"),
  },
  "byok.openrouter.smart": {
    provider: "openrouter",
    model: providerModel("openrouter", "smart"),
  },
};

/**
 * True when the running process has a Gemini API key in env (either name).
 * Bootstrap uses this to decide whether to register the provider eagerly.
 */
export function hasGeminiEnvKey(): boolean {
  return readGeminiEnvKey() !== undefined;
}

const FALLBACK_ROUTE: ProviderRoute = { provider: "stub", model: "stub-small" };

export class ProviderRouter {
  private routes: Map<string, ProviderRoute>;
  private providers: Map<ProviderName, LLMProvider>;

  constructor(routes: Record<string, ProviderRoute> = DEFAULT_ROUTES) {
    this.routes = new Map(Object.entries(routes));
    this.providers = new Map();
    this.providers.set("stub", new StubProvider());
  }

  register(name: ProviderName, instance: LLMProvider): void {
    this.providers.set(name, instance);
  }

  setRoute(routeKey: string, route: ProviderRoute): void {
    this.routes.set(routeKey, route);
  }

  resolve(routeKey: string): ProviderRoute {
    return this.routes.get(routeKey) ?? FALLBACK_ROUTE;
  }

  private select(
    routeKey: string,
    modelOverride?: string,
    providerOverride?: ProviderName,
  ): { provider: LLMProvider; route: ProviderRoute } {
    const baseRoute = this.resolve(routeKey);
    const route = providerOverride ? { ...baseRoute, provider: providerOverride } : baseRoute;
    let provider = this.providers.get(route.provider);
    if (!provider) {
      console.warn(
        `[provider-router] no provider registered for "${route.provider}" (route "${routeKey}"), falling back to stub`,
      );
      provider = this.providers.get("stub")!;
    }
    return {
      provider,
      route: {
        provider: provider.name,
        model: modelOverride && modelOverride.length > 0 ? modelOverride : route.model,
      },
    };
  }

  async call(
    opts: Omit<ProviderCallOptions, "model"> & { model?: string; provider?: ProviderName },
  ): Promise<ProviderCallResult> {
    const { provider, route } = this.select(opts.routeKey, opts.model, opts.provider);
    return provider.call({ ...opts, model: route.model });
  }

  stream(
    opts: Omit<ProviderCallOptions, "model"> & { model?: string; provider?: ProviderName },
  ): AsyncIterable<ProviderStreamChunk> {
    const { provider, route } = this.select(opts.routeKey, opts.model, opts.provider);
    return provider.stream({ ...opts, model: route.model });
  }

  has(name: ProviderName): boolean {
    return (
      this.providers.get(name) !== undefined &&
      (name === "stub" || this.providers.get(name) !== this.providers.get("stub"))
    );
  }

  /**
   * Returns the set of provider names currently registered (excluding the
   * always-present "stub" fallback). Useful for resolvers that need to know
   * which providers are even candidates before checking env credentials.
   */
  registeredProviders(): ProviderName[] {
    const out: ProviderName[] = [];
    for (const name of this.providers.keys()) {
      if (name !== "stub") out.push(name);
    }
    return out;
  }

  /**
   * Returns the live `LLMProvider` instance for `name`, or `undefined` if it
   * isn't registered. Callers that need to drive a provider directly (e.g.
   * after the preset resolver picked one) use this to grab the instance the
   * router would otherwise dispatch to.
   */
  get(name: ProviderName): LLMProvider | undefined {
    return this.providers.get(name);
  }

  policy(name: ProviderName): ProviderGenerationPolicy {
    return providerGenerationPolicy(name);
  }
}

let defaultRouter: ProviderRouter | null = null;

export function getDefaultRouter(): ProviderRouter {
  if (!defaultRouter) defaultRouter = new ProviderRouter();
  return defaultRouter;
}

export function setDefaultRouter(router: ProviderRouter): void {
  defaultRouter = router;
}

export function resetDefaultRouterForTests(): void {
  defaultRouter = null;
}
