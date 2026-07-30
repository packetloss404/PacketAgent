import assert from "node:assert/strict";
import test from "node:test";
import type { AgentBuilderDraft } from "@/lib/types";
import {
  agentAuthoringLabel,
  providerCapabilityReadinessTone,
  providerCapabilitySummary,
  providerCredentialLabel,
} from "./builder-agent-utils";

test("agent authoring labels distinguish LLM output from deterministic fallback", () => {
  assert.equal(
    agentAuthoringLabel({
      authoring: {
        source: "llm",
        provider: "anthropic",
        model: "claude-test",
        category: "operations",
      },
    } as AgentBuilderDraft),
    "LLM-authored with anthropic / claude-test",
  );
  assert.equal(
    agentAuthoringLabel({
      authoring: {
        source: "heuristic",
        fallbackReason: "provider_unavailable",
      },
    } as AgentBuilderDraft),
    "Deterministic fallback",
  );
});

test("agent provider readiness labels expose key source and conditional capabilities", () => {
  const draft = {
    readiness: {
      provider: {
        configured: true,
        credentialSource: "workspace_vault",
        capabilities: {
          streaming: { supported: true, status: "ready" },
          toolUse: { required: true, support: "conditional", status: "conditional" },
          structuredOutput: {
            requiredForAuthoring: true,
            support: "conditional",
            status: "conditional",
          },
        },
      },
    },
  } as AgentBuilderDraft;

  assert.equal(providerCredentialLabel(draft), "key: workspace vault");
  assert.equal(
    providerCapabilitySummary(draft),
    "tool use conditional; structured output conditional; streaming supported",
  );
  assert.equal(providerCapabilityReadinessTone(draft), "warn");
});
