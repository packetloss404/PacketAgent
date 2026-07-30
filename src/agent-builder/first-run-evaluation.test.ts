import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentFirstRunEvaluation } from "./first-run-evaluation.js";
import type { AgentRunRecord } from "../store/types.js";

test("first-run evaluation records expected and actual evidence without a judge model", () => {
  const evaluation = buildAgentFirstRunEvaluation({
    run: run({
      inputs: { source_url: "https://example.com/report" },
      output: "Briefing complete.",
      toolCalls: [
        {
          id: "call_1",
          toolName: "http_fetch",
          input: { url: "https://example.com/report" },
          output: { status: 200 },
          durationMs: 12,
          startedAt: "2026-07-29T12:00:00.000Z",
          completedAt: "2026-07-29T12:00:00.012Z",
          status: "ok",
        },
      ],
      modelUsed: "model-test",
    }),
    expectedInputs: { source_url: "https://example.com/report" },
    spec: {
      expectedOutput: "A concise evidence briefing.",
      requiredTools: ["http_fetch"],
    },
    evaluatedAt: "2026-07-29T12:00:01.000Z",
  });

  assert.equal(evaluation.status, "passed");
  assert.deepEqual(evaluation.expected.inputs, {
    source_url: "https://example.com/report",
  });
  assert.equal(evaluation.actual.output, "Briefing complete.");
  assert.deepEqual(evaluation.actual.toolCalls, [{ name: "http_fetch", status: "ok" }]);
  assert.equal(evaluation.actual.model, "model-test");
  assert.equal(
    evaluation.checks.every((check) => check.status === "passed"),
    true,
  );
  assert.match(evaluation.notes.join(" "), /does not fabricate a semantic score/i);
});

test("first-run evaluation fails closed on input drift, failed runs, empty output, and tools", () => {
  const evaluation = buildAgentFirstRunEvaluation({
    run: run({
      status: "failed",
      inputs: { ticket: "INC-2" },
      output: "",
      toolCalls: [],
    }),
    expectedInputs: { ticket: "INC-1" },
    spec: {
      expectedOutput: "A triage summary.",
      requiredTools: ["http_fetch", "email_send"],
    },
  });

  assert.equal(evaluation.status, "failed");
  assert.deepEqual(
    evaluation.checks.map((check) => [check.id, check.status]),
    [
      ["inputs", "failed"],
      ["run_status", "failed"],
      ["output", "failed"],
      ["tool_calls", "failed"],
    ],
  );
  assert.match(evaluation.notes.join(" "), /http_fetch, email_send/);
});

test("first-run evaluation redacts expected and actual values before persistence", () => {
  const secret = "sk-first-run-evaluation-secret";
  const evaluation = buildAgentFirstRunEvaluation({
    run: run({
      inputs: { api_key: secret },
      output: `authorization=${secret}`,
    }),
    expectedInputs: { api_key: secret },
    spec: {
      expectedOutput: `token=${secret}`,
      requiredTools: [],
    },
  });
  const serialized = JSON.stringify(evaluation);

  assert.equal(serialized.includes(secret), false);
  assert.match(serialized, /\[redacted\]/);
});

function run(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    id: "run_first",
    workspaceId: "workspace_alpha",
    agentId: "agent_first",
    title: "First run",
    status: "success",
    logs: [],
    createdAt: "2026-07-29T12:00:00.000Z",
    updatedAt: "2026-07-29T12:00:00.000Z",
    ...overrides,
  };
}
