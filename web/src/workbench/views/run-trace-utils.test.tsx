import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRunTrace } from "@/lib/types";
import {
  flattenTraceSpans,
  getTraceState,
  resolveSpanDurationMs,
  summarizeTrace,
  traceStatusTone,
} from "./run-trace-utils";

test("trace state separates legacy runs, empty traces, and populated traces", () => {
  assert.equal(getTraceState(null), "legacy");
  assert.equal(getTraceState({ spans: [] }), "empty");
  assert.equal(getTraceState({ spans: [{ id: "root", name: "Run" }] }), "ready");
});

test("flattenTraceSpans preserves backend order and derives parent depth", () => {
  const trace: AgentRunTrace = {
    spans: [
      { id: "root", name: "Run" },
      { id: "model", parentId: "root", name: "Model call", kind: "model" },
      { id: "tool", parentId: "model", name: "Fetch", kind: "tool" },
      { id: "orphan", parentId: "missing", name: "Detached" },
    ],
  };

  const rows = flattenTraceSpans(trace, Date.parse("2026-05-27T12:00:00Z"));
  assert.deepEqual(
    rows.map((row) => row.span.id),
    ["root", "model", "tool", "orphan"],
  );
  assert.deepEqual(
    rows.map((row) => row.depth),
    [0, 1, 2, 0],
  );
});

test("resolveSpanDurationMs prefers explicit duration and falls back to timestamps", () => {
  assert.equal(resolveSpanDurationMs({ id: "a", name: "A", durationMs: 42 }), 42);
  assert.equal(
    resolveSpanDurationMs({
      id: "b",
      name: "B",
      startedAt: "2026-05-27T12:00:00Z",
      endedAt: "2026-05-27T12:00:01.500Z",
    }),
    1500,
  );
  assert.equal(
    resolveSpanDurationMs(
      {
        id: "c",
        name: "C",
        startedAt: "2026-05-27T12:00:00Z",
      },
      Date.parse("2026-05-27T12:00:02Z"),
    ),
    2000,
  );
});

test("summarizeTrace uses summary fields when present and otherwise derives counts", () => {
  const derived = summarizeTrace({
    spans: [
      { id: "m", name: "Model", kind: "model", costUsd: 0.01 },
      { id: "t", name: "Tool", toolName: "http.fetch", costUsd: 0.02 },
    ],
  });
  assert.equal(derived.spans, 2);
  assert.equal(derived.modelCalls, 1);
  assert.equal(derived.toolCalls, 1);
  assert.ok(derived.costUsd !== null && Math.abs(derived.costUsd - 0.03) < 0.000001);
  assert.equal(derived.durationMs, null);

  assert.equal(summarizeTrace({ summary: { spans: 9, costUsd: 0.5 }, spans: [] }).spans, 9);
});

test("traceStatusTone maps common span states to workbench tones", () => {
  assert.equal(traceStatusTone("ok"), "good");
  assert.equal(traceStatusTone("queued"), "info");
  assert.equal(traceStatusTone("timeout"), "warn");
  assert.equal(traceStatusTone("failed"), "danger");
  assert.equal(traceStatusTone("skipped"), "muted");
});
