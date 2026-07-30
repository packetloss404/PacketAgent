import {
  buildAgentBuilderProviderReadiness,
  resolveAgentBuilderProviderContext,
} from "./agent-builder/readiness.js";
import { agentProviderRouteKey, ProviderRouter } from "./providers/router.js";
import type {
  LLMProvider,
  ProviderCallOptions,
  ProviderCallResult,
  ProviderName,
  ProviderStreamChunk,
} from "./providers/types.js";

const verifierSecret = "agent-readiness-verifier-secret";
const hostedRouter = new ProviderRouter();
hostedRouter.register("openrouter", fakeProvider("openrouter"));
const hostedContext = await resolveAgentBuilderProviderContext({
  workspaceId: "agent-readiness-verifier",
  preset: "smart",
  router: hostedRouter,
  env: {},
  vaultProviders: ["openrouter"],
});
const hostedReadiness = buildAgentBuilderProviderReadiness(hostedContext, {
  requiresToolUse: true,
  authoringUsesLlm: true,
});

const localRouter = new ProviderRouter();
localRouter.register("ollama", fakeProvider("ollama"));
const localContext = await resolveAgentBuilderProviderContext({
  workspaceId: "agent-readiness-verifier",
  preset: "local",
  router: localRouter,
  env: {},
  vaultProviders: [],
});
const localReadiness = buildAgentBuilderProviderReadiness(localContext, {
  requiresToolUse: false,
  authoringUsesLlm: false,
});

const missingContext = await resolveAgentBuilderProviderContext({
  workspaceId: "agent-readiness-verifier",
  preset: "smart",
  router: new ProviderRouter(),
  env: { OPENAI_API_KEY: verifierSecret },
  vaultProviders: [],
});
const missingReadiness = buildAgentBuilderProviderReadiness(missingContext, {
  requiresToolUse: true,
  authoringUsesLlm: false,
});

const persistedRoute = new ProviderRouter().resolve(agentProviderRouteKey("openrouter"));
const assertions = {
  exactPresetResolution:
    hostedContext.preset === "smart" &&
    hostedReadiness.selectedProviderKind === "openrouter" &&
    hostedReadiness.selectedModel === "anthropic/claude-sonnet-4-6",
  keySourceMetadataOnly:
    hostedReadiness.credentialSource === "workspace_vault" &&
    hostedReadiness.credentialStatus === "ready",
  conditionalCapabilitiesVisible:
    hostedReadiness.capabilities.toolUse.status === "conditional" &&
    hostedReadiness.capabilities.structuredOutput.status === "conditional",
  modelTruthfulBeforeProbe:
    hostedReadiness.modelAvailability === "configured_unverified" &&
    hostedReadiness.warnings.some((warning) => warning.includes("not been verified")),
  localKeylessIsNotModelVerification:
    localReadiness.credentialStatus === "not_required" &&
    localReadiness.modelAvailability === "configured_unverified",
  unresolvedRuntimeBlocks:
    !missingReadiness.configured &&
    missingReadiness.blockers.length === 1 &&
    missingReadiness.selectedProviderKind === undefined,
  persistedProviderRoute:
    persistedRoute.provider === "openrouter" &&
    persistedRoute.model === "anthropic/claude-sonnet-4-6",
};
const result = {
  ok: Object.values(assertions).every(Boolean),
  assertions,
  hosted: hostedReadiness,
  local: localReadiness,
  missing: missingReadiness,
  persistedRoute,
};
const serialized = JSON.stringify(result, null, 2);
check(!serialized.includes(verifierSecret), "Agent readiness verifier output exposed a key.");
process.stdout.write(`${serialized}\n`);
if (!result.ok) process.exitCode = 1;

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

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
