import { isSensitiveKey, maskSecret, redactSensitiveString } from "./security/redaction.js";
import type {
  AgentRunLogLevel,
  AgentRunRecord,
  AgentRunStatus,
  AgentRunStepStatus,
  AgentRunToolCall,
} from "./packetagent-store.js";

const REDACTED = "[redacted]";
const CIRCULAR = "[circular]";

export type AgentRunTraceSpanType =
  | "run"
  | "input"
  | "step"
  | "tool_call"
  | "log"
  | "output"
  | "error";
export type AgentRunTraceSpanStatus =
  | AgentRunStatus
  | AgentRunStepStatus
  | AgentRunToolCall["status"]
  | AgentRunLogLevel;

export interface AgentRunTraceSpan {
  id: string;
  runId: string;
  sequence: number;
  type: AgentRunTraceSpanType;
  title: string;
  status: AgentRunTraceSpanStatus;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  summary: string | null;
  input: unknown | null;
  output: unknown | null;
  error: string | null;
  toolName: string | null;
  modelUsed: string | null;
  costUsd: number | null;
}

export interface AgentRunTraceDerivationOptions {
  maxStringLength?: number;
  maxPayloadLength?: number;
  maxArrayItems?: number;
  maxObjectKeys?: number;
  maxDepth?: number;
  maxSummaryLength?: number;
}

interface TraceLimits {
  maxStringLength: number;
  maxPayloadLength: number;
  maxArrayItems: number;
  maxObjectKeys: number;
  maxDepth: number;
  maxSummaryLength: number;
}

interface DraftTraceSpan extends AgentRunTraceSpan {
  orderAtMs: number;
  orderGroup: number;
  orderIndex: number;
}

type DraftTraceSpanInput = Pick<
  AgentRunTraceSpan,
  "id" | "runId" | "type" | "title" | "status" | "startedAt" | "completedAt" | "durationMs"
> &
  Partial<
    Pick<
      AgentRunTraceSpan,
      "summary" | "input" | "output" | "error" | "toolName" | "modelUsed" | "costUsd"
    >
  > & {
    orderAt?: string | null;
    orderGroup: number;
    orderIndex: number;
  };

const DEFAULT_TRACE_LIMITS: TraceLimits = {
  maxStringLength: 2_000,
  maxPayloadLength: 8_000,
  maxArrayItems: 40,
  maxObjectKeys: 80,
  maxDepth: 6,
  maxSummaryLength: 240,
};

export function deriveAgentRunTraceSpans(
  run: AgentRunRecord,
  options: AgentRunTraceDerivationOptions = {},
): AgentRunTraceSpan[] {
  const limits = normalizeLimits(options);
  const spans: DraftTraceSpan[] = [];
  const runStartedAt = run.startedAt ?? run.createdAt ?? null;
  const runCompletedAt = run.completedAt ?? null;
  const runDurationMs = durationBetween(runStartedAt, runCompletedAt);
  const outputAt = run.completedAt ?? run.updatedAt ?? runStartedAt;
  const modelUsed = run.modelUsed ? sanitizeTitle(run.modelUsed, limits) : null;
  const costUsd = finiteNumber(run.costUsd);

  spans.push(
    makeDraftSpan({
      id: `${run.id}:run`,
      runId: run.id,
      type: "run",
      title: sanitizeTitle(run.title || "Agent run", limits),
      status: run.status,
      startedAt: runStartedAt,
      completedAt: runCompletedAt,
      durationMs: runDurationMs,
      summary: runSummary(run, modelUsed, costUsd, limits),
      modelUsed,
      costUsd,
      orderAt: runStartedAt,
      orderGroup: 0,
      orderIndex: 0,
    }),
  );

  if (run.inputs && Object.keys(run.inputs).length > 0) {
    spans.push(
      makeDraftSpan({
        id: `${run.id}:input`,
        runId: run.id,
        type: "input",
        title: "Inputs",
        status: run.status === "queued" || run.status === "running" ? run.status : "success",
        startedAt: runStartedAt,
        completedAt: runStartedAt,
        durationMs: null,
        summary: summarizePayload(run.inputs, limits),
        input: sanitizePayload(run.inputs, limits),
        orderAt: runStartedAt,
        orderGroup: 10,
        orderIndex: 0,
      }),
    );
  }

  for (const [index, step] of (run.transcript ?? []).entries()) {
    const startedAt = step.startedAt ?? runStartedAt;
    const durationMs = nonNegativeNumber(step.durationMs);
    const completedAt =
      startedAt && durationMs !== null ? addMilliseconds(startedAt, durationMs) : null;
    spans.push(
      makeDraftSpan({
        id: `${run.id}:step:${step.id || index}`,
        runId: run.id,
        type: "step",
        title: sanitizeTitle(step.title || `Step ${index + 1}`, limits),
        status: step.status,
        startedAt,
        completedAt,
        durationMs,
        summary: step.output ? summarizeText(step.output, limits) : null,
        output: step.output ? sanitizeText(step.output, limits) : null,
        orderAt: startedAt,
        orderGroup: 20,
        orderIndex: index,
      }),
    );
  }

  for (const [index, call] of (run.toolCalls ?? []).entries()) {
    const durationMs =
      nonNegativeNumber(call.durationMs) ?? durationBetween(call.startedAt, call.completedAt);
    const output = call.output === undefined ? null : sanitizePayload(call.output, limits);
    const error = call.error ? sanitizeText(call.error, limits) : null;
    spans.push(
      makeDraftSpan({
        id: `${run.id}:tool:${call.id || index}`,
        runId: run.id,
        type: "tool_call",
        title: sanitizeTitle(call.toolName || `Tool call ${index + 1}`, limits),
        status: call.status,
        startedAt: call.startedAt ?? null,
        completedAt: call.completedAt ?? null,
        durationMs,
        summary:
          error ??
          (call.output === undefined
            ? summarizePayload(call.input, limits)
            : summarizePayload(call.output, limits)),
        input: sanitizePayload(call.input, limits),
        output,
        error,
        toolName: call.toolName ? sanitizeTitle(call.toolName, limits) : null,
        orderAt: call.startedAt,
        orderGroup: 30,
        orderIndex: index,
      }),
    );
  }

  for (const [index, log] of (run.logs ?? []).entries()) {
    const message = sanitizeText(log.message, limits);
    spans.push(
      makeDraftSpan({
        id: `${run.id}:log:${index}`,
        runId: run.id,
        type: "log",
        title: `${log.level.toUpperCase()} log`,
        status: log.level,
        startedAt: log.at ?? null,
        completedAt: log.at ?? null,
        durationMs: null,
        summary: summarizeText(log.message, limits),
        output: message,
        orderAt: log.at,
        orderGroup: 40,
        orderIndex: index,
      }),
    );
  }

  if (run.output) {
    spans.push(
      makeDraftSpan({
        id: `${run.id}:output`,
        runId: run.id,
        type: "output",
        title: "Output",
        status: run.status,
        startedAt: outputAt ?? null,
        completedAt: outputAt ?? null,
        durationMs: null,
        summary: summarizeText(run.output, limits),
        output: sanitizeText(run.output, limits),
        modelUsed,
        costUsd,
        orderAt: outputAt,
        orderGroup: 90,
        orderIndex: 0,
      }),
    );
  }

  if (run.error) {
    spans.push(
      makeDraftSpan({
        id: `${run.id}:error`,
        runId: run.id,
        type: "error",
        title: run.status === "canceled" ? "Canceled" : "Error",
        status: run.status === "canceled" ? "canceled" : "failed",
        startedAt: outputAt ?? null,
        completedAt: outputAt ?? null,
        durationMs: null,
        summary: summarizeText(run.error, limits),
        error: sanitizeText(run.error, limits),
        orderAt: outputAt,
        orderGroup: 95,
        orderIndex: 0,
      }),
    );
  }

  return spans
    .sort(compareDraftSpans)
    .map(
      (
        { orderAtMs: _orderAtMs, orderGroup: _orderGroup, orderIndex: _orderIndex, ...span },
        index,
      ) => ({
        ...span,
        sequence: index + 1,
      }),
    );
}

export function sanitizeAgentRunTraceText(
  value: string,
  options: AgentRunTraceDerivationOptions = {},
): string {
  return sanitizeText(value, normalizeLimits(options));
}

export function sanitizeAgentRunTracePayload(
  value: unknown,
  options: AgentRunTraceDerivationOptions = {},
): unknown {
  return sanitizePayload(value, normalizeLimits(options));
}

function makeDraftSpan(input: DraftTraceSpanInput): DraftTraceSpan {
  return {
    id: input.id,
    runId: input.runId,
    sequence: 0,
    type: input.type,
    title: input.title,
    status: input.status,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: input.durationMs,
    summary: input.summary ?? null,
    input: input.input ?? null,
    output: input.output ?? null,
    error: input.error ?? null,
    toolName: input.toolName ?? null,
    modelUsed: input.modelUsed ?? null,
    costUsd: input.costUsd ?? null,
    orderAtMs: toMillis(input.orderAt) ?? Number.MAX_SAFE_INTEGER,
    orderGroup: input.orderGroup,
    orderIndex: input.orderIndex,
  };
}

function compareDraftSpans(left: DraftTraceSpan, right: DraftTraceSpan): number {
  return (
    left.orderAtMs - right.orderAtMs ||
    left.orderGroup - right.orderGroup ||
    left.orderIndex - right.orderIndex ||
    left.id.localeCompare(right.id)
  );
}

function runSummary(
  run: AgentRunRecord,
  modelUsed: string | null,
  costUsd: number | null,
  limits: TraceLimits,
): string {
  const parts = [`Status: ${run.status}`];
  if (run.triggerKind) parts.push(`Trigger: ${run.triggerKind}`);
  if (modelUsed) parts.push(`Model: ${modelUsed}`);
  if (costUsd !== null) parts.push(`Cost: $${costUsd.toFixed(4)}`);
  return summarizeText(parts.join(". "), limits);
}

function normalizeLimits(options: AgentRunTraceDerivationOptions): TraceLimits {
  return {
    maxStringLength: positiveInteger(options.maxStringLength, DEFAULT_TRACE_LIMITS.maxStringLength),
    maxPayloadLength: positiveInteger(
      options.maxPayloadLength,
      DEFAULT_TRACE_LIMITS.maxPayloadLength,
    ),
    maxArrayItems: positiveInteger(options.maxArrayItems, DEFAULT_TRACE_LIMITS.maxArrayItems),
    maxObjectKeys: positiveInteger(options.maxObjectKeys, DEFAULT_TRACE_LIMITS.maxObjectKeys),
    maxDepth: positiveInteger(options.maxDepth, DEFAULT_TRACE_LIMITS.maxDepth),
    maxSummaryLength: positiveInteger(
      options.maxSummaryLength,
      DEFAULT_TRACE_LIMITS.maxSummaryLength,
    ),
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function sanitizePayload(value: unknown, limits: TraceLimits): unknown {
  const sanitized = sanitizePayloadValue(value, limits, 0, new WeakSet<object>());
  const serialized = stringifyPayload(sanitized);
  return serialized.length > limits.maxPayloadLength
    ? boundString(serialized, limits.maxPayloadLength)
    : sanitized;
}

function sanitizePayloadValue(
  value: unknown,
  limits: TraceLimits,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") return sanitizeText(value, limits);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean" || value === null) return value;
  if (value === undefined) return null;
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function")
    return String(value);
  if (typeof value !== "object") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return CIRCULAR;
  if (depth >= limits.maxDepth) return "[truncated: depth]";

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value
        .slice(0, limits.maxArrayItems)
        .map((entry) => sanitizePayloadValue(entry, limits, depth + 1, seen));
      const omitted = value.length - items.length;
      if (omitted > 0) items.push(`[truncated: ${omitted} more item(s)]`);
      return items;
    }

    const output: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, entry] of entries.slice(0, limits.maxObjectKeys)) {
      output[key] = isSensitiveKey(key)
        ? redactSensitiveEntry(entry)
        : sanitizePayloadValue(entry, limits, depth + 1, seen);
    }
    const omitted = entries.length - Object.keys(output).length;
    if (omitted > 0) output.__truncated__ = `${omitted} more key(s)`;
    return output;
  } finally {
    seen.delete(value);
  }
}

function redactSensitiveEntry(value: unknown): unknown {
  return typeof value === "string" ? maskSecret(value) : REDACTED;
}

function sanitizeText(value: string, limits: TraceLimits): string {
  return boundString(redactSensitiveString(value), limits.maxStringLength);
}

function sanitizeTitle(value: string, limits: TraceLimits): string {
  return (
    boundString(redactSensitiveString(value), Math.min(160, limits.maxStringLength)).trim() ||
    "Untitled"
  );
}

function summarizePayload(value: unknown, limits: TraceLimits): string {
  const sanitized = sanitizePayload(value, limits);
  return summarizeText(
    typeof sanitized === "string" ? sanitized : stringifyPayload(sanitized),
    limits,
  );
}

function summarizeText(value: string, limits: TraceLimits): string {
  return boundString(
    redactSensitiveString(value).replace(/\s+/g, " ").trim(),
    limits.maxSummaryLength,
  );
}

function boundString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const omitted = value.length - maxLength;
  return `${value.slice(0, maxLength)}\n[truncated ${omitted} char(s)]`;
}

function stringifyPayload(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function addMilliseconds(value: string, durationMs: number): string | null {
  const millis = toMillis(value);
  if (millis === null) return null;
  return new Date(millis + durationMs).toISOString();
}

function durationBetween(
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
): number | null {
  const start = toMillis(startedAt);
  const end = toMillis(completedAt);
  if (start === null || end === null || end < start) return null;
  return end - start;
}

function toMillis(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
