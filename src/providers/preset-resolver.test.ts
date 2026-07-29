import assert from "node:assert/strict";
import test from "node:test";
import { ProviderRouter } from "./router.js";
import {
  availableProviders,
  providerHasCredentials,
  providerReadinessSnapshot,
  resolvePresetToProviderModel,
} from "./preset-resolver.js";
import type {
  LLMProvider,
  ProviderCallOptions,
  ProviderCallResult,
  ProviderName,
  ProviderStreamChunk,
} from "./types.js";

test("credential readiness recognizes both Gemini env names", () => {
  assert.equal(providerHasCredentials("gemini", { GOOGLE_API_KEY: "google-key" }), true);
  assert.equal(providerHasCredentials("gemini", { GEMINI_API_KEY: "gemini-key" }), true);
  assert.equal(providerHasCredentials("gemini", {}), false);
});

test("vault-only Gemini and OpenRouter providers are available and routable", () => {
  const router = new ProviderRouter();
  router.register("gemini", fakeProvider("gemini"));
  router.register("openrouter", fakeProvider("openrouter"));
  const vaultProviders: ProviderName[] = ["gemini", "openrouter"];
  const options = { router, env: {}, vaultProviders };

  assert.deepEqual(availableProviders(options).sort(), ["gemini", "openrouter"]);
  assert.deepEqual(resolvePresetToProviderModel("cheap", options), {
    provider: "openrouter",
    model: "qwen/qwen3-coder",
    local: false,
  });
});

test("local preset never falls through to a hosted vault provider", () => {
  const router = new ProviderRouter();
  router.register("gemini", fakeProvider("gemini"));
  assert.equal(
    resolvePresetToProviderModel("local", {
      router,
      env: {},
      vaultProviders: ["gemini"],
    }),
    null,
  );
});

test("readiness snapshot reports capability and credential source without secret values", () => {
  const router = new ProviderRouter();
  router.register("gemini", fakeProvider("gemini"));
  router.register("openrouter", fakeProvider("openrouter"));
  const snapshot = providerReadinessSnapshot({
    router,
    env: { GEMINI_API_KEY: "do-not-expose" },
    vaultProviders: ["openrouter"],
  });

  const gemini = snapshot.find((entry) => entry.provider === "gemini");
  const openrouter = snapshot.find((entry) => entry.provider === "openrouter");
  assert.equal(gemini?.credentialSource, "environment");
  assert.equal(gemini?.capabilities.structuredOutput, "native");
  assert.equal(openrouter?.credentialSource, "workspace_vault");
  assert.equal(openrouter?.capabilities.structuredOutput, "conditional");
  assert.equal(JSON.stringify(snapshot).includes("do-not-expose"), false);
});

function fakeProvider(name: ProviderName): LLMProvider {
  return {
    name,
    async call(opts: ProviderCallOptions): Promise<ProviderCallResult> {
      return {
        content: "",
        finishReason: "stop",
        usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
        model: opts.model,
        providerName: name,
      };
    },
    async *stream(): AsyncIterable<ProviderStreamChunk> {
      yield {
        done: true,
        usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
      };
    },
    async models() {
      return [];
    },
  };
}
