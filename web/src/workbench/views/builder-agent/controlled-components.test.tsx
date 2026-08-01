import assert from "node:assert/strict";
import test from "node:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentBuilderDraft } from "@/lib/types";
import { AgentConfiguration, SampleInputs } from "./configuration";
import { DraftPlan, DraftSummary, ReadinessGrid } from "./draft-review";
import { ApproveCard, FirstRunPanel } from "./first-run";

const draft: AgentBuilderDraft = {
  prompt: "Build a release coordinator",
  intent: "release operations",
  summary: "Coordinates release checks and reports status.",
  authoring: {
    source: "llm",
    provider: "anthropic",
    model: "claude-test",
    category: "operations",
  },
  agent: {
    name: "Release coordinator",
    description: "Coordinates a bounded release checklist.",
    instructions: "Inspect the release and report blockers.",
    triggerKind: "manual",
    tools: ["http_fetch"],
    inputSchema: [
      {
        key: "release_url",
        label: "Release URL",
        type: "url",
        required: true,
        description: "HTTPS release URL",
        exampleValue: "https://example.test/releases/42",
      },
    ],
    memory: [],
    evaluationSpec: {
      expectedOutput: "A bounded release status with blockers.",
      requiredTools: ["http_fetch"],
    },
  },
  sampleInputs: { release_url: "https://example.test/releases/42" },
  plan: {
    title: "Coordinate the release",
    steps: [{ title: "Inspect", detail: "Read the release status." }],
    acceptanceChecks: ["Reports blockers"],
    openQuestions: [],
  },
  readiness: {
    provider: {
      configured: true,
      preset: "smart",
      selectedProviderId: "provider_anthropic",
      selectedProviderKind: "anthropic",
      selectedProviderName: "Anthropic",
      selectedModel: "claude-test",
      registered: true,
      credentialSource: "workspace_vault",
      credentialStatus: "ready",
      modelAvailability: "configured_unverified",
      capabilities: {
        streaming: { supported: true, status: "ready" },
        toolUse: { required: true, support: "native", status: "ready" },
        structuredOutput: {
          requiredForAuthoring: true,
          support: "native",
          status: "ready",
        },
      },
      blockers: [],
      warnings: ["Live model verification is pending."],
      message: "Provider is configured.",
    },
    tools: {
      recommended: ["http_fetch"],
      available: ["http_fetch"],
      missing: [],
      message: "Tools are ready.",
    },
    webhook: {
      recommended: false,
      readyAfterSave: false,
      message: "Manual trigger selected.",
      planDetail: "No webhook required.",
      publishSteps: [],
    },
    firstRun: { canRun: true, blockers: [], message: "Ready after save." },
  },
};

test("Agent Builder review surfaces preserve authoring and readiness truth", () => {
  const html = renderToStaticMarkup(
    createElement(
      Fragment,
      null,
      createElement(DraftSummary, { draft, savedAgent: null }),
      createElement(ReadinessGrid, { draft }),
      createElement(DraftPlan, { draft }),
    ),
  );

  assert.match(html, /Release coordinator/);
  assert.match(html, /LLM-authored/);
  assert.match(html, /Provider/);
  assert.match(html, /workspace vault/);
  assert.match(html, /Coordinate the release/);
  assert.match(html, /Reports blockers/);
});

test("Agent Builder configuration and approval remain controlled by props", () => {
  const html = renderToStaticMarkup(
    createElement(
      Fragment,
      null,
      createElement(AgentConfiguration, {
        draft,
        editable: true,
        onMemoryChange: () => {},
        onExpectedOutputChange: () => {},
      }),
      createElement(SampleInputs, {
        draft,
        editable: true,
        sampleInputs: draft.sampleInputs,
        issues: [{ key: "release_url", message: "Release URL must be reachable." }],
        onUpdate: () => {},
      }),
      createElement(ApproveCard, {
        draft,
        working: false,
        savedAgent: null,
        runPreview: true,
        sampleInputIssues: [],
        onRunPreviewChange: () => {},
        onApprove: () => {},
        onOpenAgent: () => {},
      }),
      createElement(FirstRunPanel, {
        run: null,
        agent: null,
        approval: null,
        running: false,
        onLaunch: () => {},
        onCancel: () => {},
      }),
    ),
  );

  assert.match(html, /Agent configuration/);
  assert.match(html, /First-run expected output/);
  assert.match(html, /Release URL must be reachable/);
  assert.match(html, /Approve, save &amp; run/);
  assert.match(html, /Save the draft to run a preview/);
});
