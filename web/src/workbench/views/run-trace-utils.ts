import type { AgentRunTrace, AgentRunTraceSpan } from "@/lib/types";

export type TraceState = "ready" | "empty" | "legacy";

export interface TraceSpanRow {
  span: AgentRunTraceSpan;
  depth: number;
  durationMs: number | null;
}

export function getTraceState(trace: AgentRunTrace | null | undefined): TraceState {
  if (!trace) return "legacy";
  return normalizeTraceSpans(trace).length > 0 ? "ready" : "empty";
}

export function normalizeTraceSpans(trace: AgentRunTrace | null | undefined): AgentRunTraceSpan[] {
  return Array.isArray(trace?.spans) ? trace.spans.filter((span) => Boolean(span?.id)) : [];
}

export function flattenTraceSpans(
  trace: AgentRunTrace | null | undefined,
  nowMs = Date.now(),
): TraceSpanRow[] {
  const spans = normalizeTraceSpans(trace);
  const byId = new Map(spans.map((span) => [span.id, span]));
  return spans.map((span) => ({
    span,
    depth: spanDepth(span, byId),
    durationMs: resolveSpanDurationMs(span, nowMs),
  }));
}

export function resolveSpanDurationMs(span: AgentRunTraceSpan, nowMs = Date.now()): number | null {
  if (typeof span.durationMs === "number" && Number.isFinite(span.durationMs)) {
    return Math.max(0, span.durationMs);
  }
  if (!span.startedAt) return null;
  const start = new Date(span.startedAt).getTime();
  const endAt = span.endedAt ?? span.completedAt;
  const end = endAt ? new Date(endAt).getTime() : nowMs;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

export function traceStatusTone(
  status: string | null | undefined,
): "good" | "warn" | "danger" | "info" | "muted" {
  switch ((status ?? "").toLowerCase()) {
    case "success":
    case "ok":
      return "good";
    case "running":
    case "queued":
    case "info":
      return "info";
    case "timeout":
      return "warn";
    case "warn":
      return "warn";
    case "failed":
    case "error":
    case "canceled":
      return "danger";
    case "skipped":
      return "muted";
    default:
      return "muted";
  }
}

export function summarizeTrace(trace: AgentRunTrace | null | undefined) {
  const spans = normalizeTraceSpans(trace);
  const summary = trace?.summary;
  return {
    spans: summary?.spans ?? summary?.spanCount ?? spans.length,
    modelCalls:
      summary?.modelCalls ?? spans.filter((span) => span.kind === "model" || span.model).length,
    toolCalls:
      summary?.toolCalls ??
      summary?.toolCallCount ??
      spans.filter((span) => span.kind === "tool" || span.kind === "tool_call" || span.toolName)
        .length,
    costUsd: summary?.costUsd ?? sumKnownNumbers(spans.map((span) => span.costUsd)),
    durationMs: summary?.durationMs ?? trace?.durationMs ?? null,
  };
}

function spanDepth(span: AgentRunTraceSpan, byId: Map<string, AgentRunTraceSpan>): number {
  let depth = 0;
  let parentId = span.parentId ?? null;
  const seen = new Set<string>([span.id]);
  while (parentId && byId.has(parentId) && !seen.has(parentId)) {
    seen.add(parentId);
    depth += 1;
    parentId = byId.get(parentId)?.parentId ?? null;
  }
  return depth;
}

function sumKnownNumbers(values: Array<number | null | undefined>): number | null {
  let total = 0;
  let seen = false;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    total += value;
    seen = true;
  }
  return seen ? total : null;
}
