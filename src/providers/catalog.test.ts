import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PROVIDER_NAMES,
  PROVIDER_CATALOG,
  RUNTIME_PROVIDER_NAMES,
  VAULT_PROVIDER_NAMES,
  providerGenerationPolicy,
  providerModel,
} from "./catalog.js";
import { ProviderRouter } from "./router.js";
import type {
  LLMProvider,
  ProviderCallOptions,
  ProviderCallResult,
  ProviderName,
  ProviderStreamChunk,
} from "./types.js";

const EXPECTED_PROVIDERS: ProviderName[] = [
  "anthropic",
  "openai",
  "openrouter",
  "minimax",
  "ollama",
  "gemini",
  "stub",
];

test("provider catalog has exactly one policy contract for every runtime provider", () => {
  assert.deepEqual([...RUNTIME_PROVIDER_NAMES].sort(), [...EXPECTED_PROVIDERS].sort());
  assert.deepEqual(Object.keys(PROVIDER_CATALOG).sort(), [...EXPECTED_PROVIDERS].sort());

  for (const provider of EXPECTED_PROVIDERS) {
    const entry = PROVIDER_CATALOG[provider];
    assert.equal(entry.name, provider);
    assert.equal(entry.capabilities.streaming, true);
    assert.equal(entry.generation.malformedToolInputCorrectionAttempts, 1);
    assert.equal(entry.generation.structuredOutputFallback, "best_effort_json");
    assert.equal(providerGenerationPolicy(provider), entry.generation);
    assert.ok(providerModel(provider, "fast").length > 0);
    assert.ok(providerModel(provider, "smart").length > 0);
    assert.ok(providerModel(provider, "cheap").length > 0);
    assert.ok(providerModel(provider, "local").length > 0);
  }
});

test("hosted providers use multi-file generation and all support workspace vault keys", () => {
  const hosted = DEFAULT_PROVIDER_NAMES.filter(
    (provider) => PROVIDER_CATALOG[provider].locality === "hosted",
  );
  assert.deepEqual([...VAULT_PROVIDER_NAMES].sort(), [...hosted].sort());

  for (const provider of hosted) {
    const entry = PROVIDER_CATALOG[provider];
    assert.equal(entry.capabilities.vaultKey, true);
    assert.equal(entry.generation.fileWriteMode, "multi_file_per_turn");
    assert.equal(entry.generation.iterationMode, "single_turn");
    assert.ok(entry.credentialEnv.length > 0);
  }
});

test("local generation is explicitly bounded to single-file multi-turn work", () => {
  const local = PROVIDER_CATALOG.ollama;
  assert.equal(local.locality, "local");
  assert.equal(local.generation.fileWriteMode, "single_file_per_turn");
  assert.equal(local.generation.iterationMode, "multi_turn");
  assert.equal(local.capabilities.structuredOutput, "conditional");
  assert.equal(local.capabilities.structuredOutputTransport, "vllm_structured_outputs");
});

test("router exposes the canonical policy for registered and fallback providers", () => {
  const router = new ProviderRouter();
  router.register("openai", fakeProvider("openai"));
  assert.equal(router.policy("openai"), PROVIDER_CATALOG.openai.generation);
  assert.equal(router.policy("stub"), PROVIDER_CATALOG.stub.generation);
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
