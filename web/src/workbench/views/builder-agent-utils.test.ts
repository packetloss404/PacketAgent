import assert from "node:assert/strict";
import test from "node:test";
import type { AgentBuilderDraft } from "@/lib/types";
import { agentAuthoringLabel } from "./builder-agent-utils";

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
