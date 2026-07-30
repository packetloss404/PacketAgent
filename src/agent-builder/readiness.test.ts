import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAgentBuilderProviderReadiness,
  resolveAgentBuilderProviderContext,
} from "./readiness.js";
import { agentProviderRouteKey, ProviderRouter } from "../providers/router.js";
import type {
  LLMProvider,
  ProviderCallOptions,
  ProviderCallResult,
  ProviderName,
  ProviderStreamChunk,
} from "../providers/types.js";

test("agent readiness binds a vault provider, exact preset model, and conditional capabilities", async () => {
  const router = new ProviderRouter();
  router.register("openrouter", fakeProvider("openrouter"));
  const context = await resolveAgentBuilderProviderContext({
    workspaceId: "alpha",
    preset: "smart",
    router,
    env: {},
    vaultProviders: ["openrouter"],
  });
  const readiness = buildAgentBuilderProviderReadiness(context, {
    requiresToolUse: true,
    authoringUsesLlm: true,
  });

  assert.equal(context.selected?.provider, "openrouter");
  assert.equal(context.selected?.model, "anthropic/claude-sonnet-4-6");
  assert.equal(readiness.configured, true);
  assert.equal(readiness.credentialSource, "workspace_vault");
  assert.equal(readiness.credentialStatus, "ready");
  assert.equal(readiness.modelAvailability, "configured_unverified");
  assert.equal(readiness.capabilities.toolUse.status, "conditional");
  assert.equal(readiness.capabilities.structuredOutput.status, "conditional");
  assert.match(readiness.warnings.join(" "), /live availability has not been verified/i);
});

test("agent readiness distinguishes keyless local configuration from live model verification", async () => {
  const router = new ProviderRouter();
  router.register("ollama", fakeProvider("ollama"));
  const context = await resolveAgentBuilderProviderContext({
    workspaceId: "alpha",
    preset: "local",
    router,
    env: {},
    vaultProviders: [],
  });
  const readiness = buildAgentBuilderProviderReadiness(context, {
    requiresToolUse: false,
    authoringUsesLlm: false,
  });

  assert.equal(readiness.selectedProviderKind, "ollama");
  assert.equal(readiness.credentialSource, "local");
  assert.equal(readiness.credentialStatus, "not_required");
  assert.equal(readiness.modelAvailability, "configured_unverified");
  assert.equal(readiness.capabilities.toolUse.status, "not_required");
  assert.equal(readiness.blockers.length, 0);
});

test("agent readiness blocks an unresolved preset and provider routes survive restart", async () => {
  const router = new ProviderRouter();
  const context = await resolveAgentBuilderProviderContext({
    workspaceId: "alpha",
    preset: "smart",
    router,
    env: {},
    vaultProviders: [],
  });
  const readiness = buildAgentBuilderProviderReadiness(context, {
    requiresToolUse: true,
    authoringUsesLlm: false,
  });

  assert.equal(readiness.configured, false);
  assert.equal(readiness.credentialStatus, "missing");
  assert.equal(readiness.modelAvailability, "missing");
  assert.equal(readiness.capabilities.toolUse.status, "missing");
  assert.match(readiness.blockers[0] ?? "", /No registered provider/);
  assert.deepEqual(new ProviderRouter().resolve(agentProviderRouteKey("openai")), {
    provider: "openai",
    model: "gpt-4o",
  });
});

function fakeProvider(name: ProviderName): LLMProvider {
  return {
    name,
    async call(options: ProviderCallOptions): Promise<ProviderCallResult> {
      return {
        content: "{}",
        finishReason: "stop",
        usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
        providerName: name,
        model: options.model,
      };
    },
    async *stream(): AsyncIterable<ProviderStreamChunk> {
      yield { done: true };
    },
    async models() {
      return [];
    },
  };
}
