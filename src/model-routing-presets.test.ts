import assert from "node:assert/strict";
import test from "node:test";
import { buildModelRoutingPresets } from "./model-routing-presets";
import type { IntegrationReadinessSummary } from "./packetagent-services";
import type { ProviderKind, ProviderRecord } from "./packetagent-store";

const readiness: IntegrationReadinessSummary = {
  status: "ready",
  tools: {
    availableCount: 0,
    readCount: 0,
    writeCount: 0,
    execCount: 0,
    names: [],
    missingForGeneratedPlans: [],
  },
  providers: {
    configuredCount: 3,
    readyCount: 3,
    missingProviderKinds: [],
    missingApiKeys: [],
  },
  recommendedSetup: [],
};

test("model routing presets pick fast, smart, cheap, and local primaries with fallbacks", () => {
  const surface = buildModelRoutingPresets({
    workspaceId: "alpha",
    readiness,
    providers: [
      provider("openai", "OpenAI", "gpt-4.1-mini"),
      provider("anthropic", "Anthropic", "claude-3-5-sonnet-latest"),
      provider("ollama", "Local Ollama", "llama3.2", { baseUrl: "http://localhost:11434" }),
    ],
  });

  assert.equal(surface.version, "phase-72-lane-4");
  assert.equal(surface.presets.fast.primary.provider, "openai");
  assert.equal(surface.presets.fast.primary.model, "gpt-4.1-mini");
  assert.equal(surface.presets.smart.primary.provider, "anthropic");
  assert.equal(surface.presets.cheap.primary.provider, "openai");
  assert.equal(surface.presets.local.primary.provider, "ollama");
  assert.ok(surface.presets.smart.fallbacks.some((fallback) => fallback.provider === "openai"));
  assert.ok(surface.presets.local.fallbacks.every((fallback) => fallback.ready));
  assert.equal(surface.totals.ready, 4);
});

test("model routing presets use env model overrides without exposing env secrets", () => {
  const surface = buildModelRoutingPresets({
    workspaceId: "alpha",
    readiness,
    providers: [
      provider("openai", "OpenAI", "gpt-4.1-mini"),
      provider("anthropic", "Anthropic", "claude-3-5-sonnet-latest"),
    ],
    env: {
      PACKETAGENT_MODEL_PRESET_SMART: "openai:gpt-4.1",
      OPENAI_API_KEY: "sk-route-secret",
      ANTHROPIC_API_KEY: "anthropic-secret",
      CUSTOM_PROVIDER_BASE_URL: "https://user:secret@example.test/v1",
    },
  });

  assert.equal(surface.presets.smart.primary.provider, "openai");
  assert.equal(surface.presets.smart.primary.model, "gpt-4.1");
  assert.ok(surface.presets.smart.primary.envHints.includes("PACKETAGENT_MODEL_PRESET_SMART"));
  assert.equal(JSON.stringify(surface).includes("sk-route-secret"), false);
  assert.equal(JSON.stringify(surface).includes("anthropic-secret"), false);
  assert.equal(JSON.stringify(surface).includes("user:secret"), false);
});

test("model routing presets skip missing keys and fall back to deterministic stub when needed", () => {
  const surface = buildModelRoutingPresets({
    workspaceId: "alpha",
    readiness: {
      ...readiness,
      status: "needs_setup",
      providers: {
        configuredCount: 1,
        readyCount: 0,
        missingProviderKinds: ["anthropic", "minimax", "ollama"],
        missingApiKeys: [{ provider: "openai", providerName: "OpenAI" }],
      },
    },
    providers: [
      provider("openai", "OpenAI", "gpt-4.1-mini", { apiKeyConfigured: false, status: "missing_key" }),
    ],
  });

  assert.equal(surface.presets.fast.primary.provider, "openai");
  assert.equal(surface.presets.fast.primary.ready, false);
  assert.deepEqual(surface.presets.fast.fallbacks.map((fallback) => fallback.provider), ["stub"]);
  assert.equal(surface.presets.local.primary.provider, "openai");
  assert.equal(surface.presets.local.primary.ready, false);
  assert.ok(surface.presets.fast.primary.blockers.some((blocker) => blocker.includes("API key")));
});

test("model routing presets can infer local routing from env hints alone", () => {
  const surface = buildModelRoutingPresets({
    workspaceId: "alpha",
    readiness: {
      ...readiness,
      status: "needs_setup",
      providers: {
        configuredCount: 0,
        readyCount: 0,
        missingProviderKinds: ["openai", "anthropic", "minimax"],
        missingApiKeys: [],
      },
    },
    providers: [],
    env: {
      OLLAMA_BASE_URL: "http://localhost:11434",
      OLLAMA_MODEL: "llama3.1",
    },
  });

  assert.equal(surface.presets.local.primary.provider, "ollama");
  assert.equal(surface.presets.local.primary.model, "llama3.1");
  assert.equal(surface.presets.local.primary.source, "env_hint");
  assert.deepEqual(surface.presets.local.primary.envHints.sort(), ["OLLAMA_BASE_URL", "OLLAMA_MODEL"]);
});

function provider(
  kind: ProviderKind,
  name: string,
  defaultModel: string,
  overrides: Partial<ProviderRecord> = {},
): ProviderRecord {
  return {
    id: `provider_alpha_${kind}`,
    workspaceId: "alpha",
    name,
    kind,
    defaultModel,
    apiKeyConfigured: true,
    status: "connected",
    createdAt: "2026-05-03T00:00:00.000Z",
    updatedAt: "2026-05-03T00:00:00.000Z",
    ...overrides,
  };
}
