import assert from "node:assert/strict";
import test from "node:test";
import type { AgentBuilderDraft } from "@/lib/types";
import {
  agentAuthoringLabel,
  firstRunEvaluationTone,
  providerCapabilityReadinessTone,
  providerCapabilitySummary,
  providerCredentialLabel,
  sampleInputsForDraft,
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
  } as unknown as AgentBuilderDraft;

  assert.equal(providerCredentialLabel(draft), "key: workspace vault");
  assert.equal(
    providerCapabilitySummary(draft),
    "tool use conditional; structured output conditional; streaming supported",
  );
  assert.equal(providerCapabilityReadinessTone(draft), "warn");
});

test("builder sample input examples preserve typed values without mutating the draft", () => {
  const draft = {
    sampleInputs: {
      release_label: "2026.07",
      retry_count: 2,
      notify_owner: false,
    },
  } as unknown as AgentBuilderDraft;

  const inputs = sampleInputsForDraft(draft);
  inputs.retry_count = 3;

  assert.deepEqual(inputs, {
    release_label: "2026.07",
    retry_count: 3,
    notify_owner: false,
  });
  assert.equal(draft.sampleInputs.retry_count, 2);
});

test("first-run evaluation tone follows persisted structural evidence", () => {
  assert.equal(firstRunEvaluationTone(undefined), "muted");
  assert.equal(
    firstRunEvaluationTone({
      evaluation: { status: "passed" },
    } as never),
    "good",
  );
  assert.equal(
    firstRunEvaluationTone({
      evaluation: { status: "failed" },
    } as never),
    "danger",
  );
});
