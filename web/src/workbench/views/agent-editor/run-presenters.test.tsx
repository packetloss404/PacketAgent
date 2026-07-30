import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentRunRecord, AgentRunStep } from "@/lib/types";
import { safeStringify } from "./helpers";
import { FirstRunEvaluationPanel, RunTranscript, ToolCallTimeline } from "./run-presenters";

test("Agent run presenters distinguish empty and populated transcripts", () => {
  assert.match(renderToStaticMarkup(<RunTranscript steps={[]} />), /no transcript captured/);
  const steps = [
    {
      id: "step-1",
      title: "Collect inputs",
      status: "success",
      durationMs: 42,
      output: "Ready",
    },
  ] as AgentRunStep[];
  const rendered = renderToStaticMarkup(<RunTranscript steps={steps} />);
  assert.match(rendered, />OK</);
  assert.match(rendered, /Collect inputs/);
  assert.match(rendered, /Ready/);
});

test("Agent run presenters retain evaluation and tool evidence labels", () => {
  const run = {
    evaluation: {
      status: "passed",
      checks: [{ id: "output", status: "passed", label: "Output", note: "Captured." }],
      expected: { output: "Expected" },
      actual: { output: "Actual" },
      notes: ["Deterministic evidence."],
    },
  } as AgentRunRecord;
  const evaluation = renderToStaticMarkup(<FirstRunEvaluationPanel run={run} />);
  assert.match(evaluation, /FIRST-RUN EVALUATION/);
  assert.match(evaluation, /Expected/);
  assert.match(evaluation, /Actual/);

  const timeline = renderToStaticMarkup(
    <ToolCallTimeline
      calls={
        [
          {
            id: "call-1",
            toolName: "http_fetch",
            status: "ok",
            durationMs: 12,
            input: { url: "https://example.com" },
          },
        ] as never
      }
    />,
  );
  assert.match(timeline, /http_fetch/);
  assert.match(timeline, />OK</);
});

test("Agent tool evidence serialization is bounded and failure-safe", () => {
  assert.match(safeStringify({ token: "value" }, 8), /truncated/);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(safeStringify(circular), "[object Object]");
});
