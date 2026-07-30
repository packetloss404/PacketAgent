import assert from "node:assert/strict";
import test from "node:test";
import { deriveAgentRunTraceSpans } from "./agent-run-trace.js";
import type { AgentRunRecord } from "./packetagent-store.js";

function makeRun(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    id: "run_1",
    workspaceId: "ws_1",
    title: "Agent run",
    status: "success",
    logs: [],
    createdAt: "2026-05-27T12:00:00.000Z",
    updatedAt: "2026-05-27T12:00:05.000Z",
    ...overrides,
  };
}

test("deriveAgentRunTraceSpans orders successful run context, transcript, logs, and output", () => {
  const run = makeRun({
    title: "Daily brief",
    triggerKind: "manual",
    startedAt: "2026-05-27T12:00:00.000Z",
    completedAt: "2026-05-27T12:00:05.000Z",
    inputs: { customer: "Acme", apiKey: "sk-secret-1234" },
    transcript: [
      {
        id: "step_a",
        title: "Read signals",
        status: "success",
        output: "Read 4 events.",
        durationMs: 1_000,
        startedAt: "2026-05-27T12:00:01.000Z",
      },
      {
        id: "step_b",
        title: "Write summary",
        status: "success",
        output: "Summary drafted.",
        durationMs: 500,
        startedAt: "2026-05-27T12:00:03.000Z",
      },
    ],
    logs: [{ at: "2026-05-27T12:00:02.000Z", level: "info", message: "Model responded." }],
    output: "Done.",
    modelUsed: "gpt-4.1-mini",
    costUsd: 0.0123,
  });

  const spans = deriveAgentRunTraceSpans(run);

  assert.deepEqual(
    spans.map((span) => `${span.sequence}:${span.type}:${span.title}`),
    [
      "1:run:Daily brief",
      "2:input:Inputs",
      "3:step:Read signals",
      "4:log:INFO log",
      "5:step:Write summary",
      "6:output:Output",
    ],
  );
  assert.equal(spans[0]?.durationMs, 5_000);
  assert.equal(spans[0]?.modelUsed, "gpt-4.1-mini");
  assert.equal(spans[0]?.costUsd, 0.0123);
  assert.match(spans[0]?.summary ?? "", /Trigger: manual/);
  assert.deepEqual(spans[1]?.input, { customer: "Acme", apiKey: "[redacted]:1234" });
  assert.equal(spans[2]?.completedAt, "2026-05-27T12:00:02.000Z");
  assert.equal(spans[5]?.output, "Done.");
});

test("deriveAgentRunTraceSpans redacts failed run errors and transcript output", () => {
  const run = makeRun({
    id: "run_failed",
    title: "Import customers",
    status: "failed",
    startedAt: "2026-05-27T12:10:00.000Z",
    completedAt: "2026-05-27T12:10:04.000Z",
    transcript: [
      {
        id: "step_failed",
        title: "Call CRM",
        status: "failed",
        output: "CRM rejected token=super-secret-token.",
        durationMs: 300,
        startedAt: "2026-05-27T12:10:01.000Z",
      },
    ],
    logs: [
      {
        at: "2026-05-27T12:10:03.000Z",
        level: "error",
        message: "Bearer provider-secret-1234 failed.",
      },
    ],
    error: "Request failed with token=super-secret-token.",
  });

  const spans = deriveAgentRunTraceSpans(run);
  const step = spans.find((span) => span.type === "step");
  const log = spans.find((span) => span.type === "log");
  const error = spans.find((span) => span.type === "error");

  assert.equal(spans[0]?.status, "failed");
  assert.equal(step?.output, "CRM rejected token=[redacted]");
  assert.equal(log?.output, "Bearer [redacted] failed.");
  assert.equal(error?.status, "failed");
  assert.equal(error?.error, "Request failed with token=[redacted]");
});

test("deriveAgentRunTraceSpans keeps canceled runs and skipped steps distinct", () => {
  const run = makeRun({
    id: "run_canceled",
    status: "canceled",
    triggerKind: "webhook",
    startedAt: "2026-05-27T13:00:00.000Z",
    completedAt: "2026-05-27T13:00:00.000Z",
    inputs: { event: "lead.created" },
    transcript: [
      {
        id: "approve",
        title: "Approve tool execution",
        status: "skipped",
        output: "Tool run was canceled before execution.",
        durationMs: 0,
        startedAt: "2026-05-27T13:00:00.000Z",
      },
    ],
    logs: [{ at: "2026-05-27T13:00:00.000Z", level: "warn", message: "Canceled by user." }],
    error: "Tool run was canceled before execution.",
  });

  const spans = deriveAgentRunTraceSpans(run);

  assert.deepEqual(
    spans.map((span) => span.type),
    ["run", "input", "step", "log", "error"],
  );
  assert.equal(spans[0]?.status, "canceled");
  assert.equal(spans.find((span) => span.type === "step")?.status, "skipped");
  assert.equal(spans.find((span) => span.type === "log")?.status, "warn");
  assert.equal(spans.find((span) => span.type === "error")?.status, "canceled");
});

test("deriveAgentRunTraceSpans redacts and bounds tool-call payloads", () => {
  const run = makeRun({
    id: "run_tool",
    startedAt: "2026-05-27T14:00:00.000Z",
    completedAt: "2026-05-27T14:00:03.000Z",
    toolCalls: [
      {
        id: "call_search",
        toolName: "search",
        input: { query: "packetagent", password: "topsecret1234", nested: { token: "abc1234567" } },
        output: { body: `Found ${"x".repeat(80)}` },
        durationMs: 250,
        startedAt: "2026-05-27T14:00:01.000Z",
        completedAt: "2026-05-27T14:00:01.250Z",
        status: "ok",
      },
      {
        id: "call_email",
        toolName: "email.send",
        input: { to: "ops@example.com" },
        error: "Provider rejected access_token=email-secret-9999.",
        durationMs: 120,
        startedAt: "2026-05-27T14:00:02.000Z",
        completedAt: "2026-05-27T14:00:02.120Z",
        status: "error",
      },
    ],
  });

  const spans = deriveAgentRunTraceSpans(run, { maxStringLength: 80, maxPayloadLength: 400 });
  const calls = spans.filter((span) => span.type === "tool_call");

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.toolName, "search");
  assert.deepEqual(calls[0]?.input, {
    query: "packetagent",
    password: "[redacted]:1234",
    nested: { token: "[redacted]:4567" },
  });
  assert.match(JSON.stringify(calls[0]?.output), /\[truncated \d+ char\(s\)\]/);
  assert.equal(calls[1]?.status, "error");
  assert.equal(calls[1]?.error, "Provider rejected access_token=[redacted]");
});

test("deriveAgentRunTraceSpans handles legacy empty runs", () => {
  const run = {
    id: "run_legacy",
    workspaceId: "ws_1",
    title: "Legacy run",
    status: "success",
    createdAt: "2026-05-27T15:00:00.000Z",
    updatedAt: "2026-05-27T15:00:01.000Z",
  } as AgentRunRecord;

  const spans = deriveAgentRunTraceSpans(run);

  assert.equal(spans.length, 1);
  assert.deepEqual(spans[0], {
    id: "run_legacy:run",
    runId: "run_legacy",
    sequence: 1,
    type: "run",
    title: "Legacy run",
    status: "success",
    startedAt: "2026-05-27T15:00:00.000Z",
    completedAt: null,
    durationMs: null,
    summary: "Status: success",
    input: null,
    output: null,
    error: null,
    toolName: null,
    modelUsed: null,
    costUsd: null,
  });
});

test("deriveAgentRunTraceSpans exposes first-run evaluation evidence", () => {
  const run = makeRun({
    id: "run_evaluation",
    completedAt: "2026-05-27T16:00:01.000Z",
    evaluation: {
      schemaVersion: "packetagent.agent-first-run-evaluation/v1",
      kind: "first_run",
      status: "passed",
      expected: {
        inputs: { release_label: "2026.05" },
        output: "A concise blocker summary.",
        toolCalls: ["http_fetch"],
      },
      actual: {
        inputs: { release_label: "2026.05" },
        output: "No blocker found.",
        toolCalls: [{ name: "http_fetch", status: "ok" }],
        runStatus: "success",
        model: "gpt-evaluation-test",
      },
      checks: [
        {
          id: "inputs",
          label: "Expected input example",
          status: "passed",
          note: "The run used the saved input example.",
        },
      ],
      notes: ["Expected output remains operator-review context."],
      evaluatedAt: "2026-05-27T16:00:02.000Z",
    },
  });

  const evaluation = deriveAgentRunTraceSpans(run).find((span) => span.type === "evaluation");

  assert.equal(evaluation?.status, "success");
  assert.equal(evaluation?.summary, "1/1 deterministic checks passed.");
  assert.equal(evaluation?.modelUsed, "gpt-evaluation-test");
  assert.deepEqual(evaluation?.input, {
    inputs: { release_label: "2026.05" },
    output: "A concise blocker summary.",
    toolCalls: ["http_fetch"],
  });
  assert.match(JSON.stringify(evaluation?.output), /No blocker found/);
});
