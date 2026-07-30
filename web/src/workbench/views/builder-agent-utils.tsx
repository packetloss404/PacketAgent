import type { AgentBuilderDraft, AgentInputField, AgentRunRecord } from "@/lib/types";

export type AgentBuilderSampleInputs = Record<string, string | number | boolean>;
export type AgentBuilderSampleInputIssue = {
  key: string;
  message: string;
};
export type ReadinessTone = "good" | "warn" | "danger" | "muted";

export function agentAuthoringLabel(draft: AgentBuilderDraft): string {
  return draft.authoring.source === "llm"
    ? `LLM-authored with ${draft.authoring.provider} / ${draft.authoring.model}`
    : "Deterministic fallback";
}

export function sampleInputsForDraft(draft: AgentBuilderDraft): AgentBuilderSampleInputs {
  return { ...draft.sampleInputs };
}

export function coerceSampleValue(
  field: AgentInputField | undefined,
  value: string | boolean,
): string | number | boolean {
  if (!field) return value;
  if (field.type === "boolean") return Boolean(value);
  if (field.type === "number") {
    const text = String(value);
    if (text.trim() === "") return "";
    const numberValue = Number(text);
    return Number.isFinite(numberValue) ? numberValue : text;
  }
  return String(value);
}

export function sampleInputIssuesForDraft(
  draft: AgentBuilderDraft,
  sampleInputs: AgentBuilderSampleInputs,
): AgentBuilderSampleInputIssue[] {
  const issues: AgentBuilderSampleInputIssue[] = [];
  for (const field of draft.agent.inputSchema ?? []) {
    const value = sampleInputs[field.key];
    const label = field.label || field.key;
    const text = value === undefined || value === null ? "" : String(value);
    const hasTextValue = text.trim().length > 0;

    if (field.required && !hasTextValue) {
      issues.push({ key: field.key, message: `${label} is required.` });
      continue;
    }
    if (!hasTextValue) continue;

    if (field.type === "number" && !Number.isFinite(Number(value))) {
      issues.push({ key: field.key, message: `${label} must be a number.` });
      continue;
    }
    if (field.type === "url" && !isHttpUrl(text)) {
      issues.push({ key: field.key, message: `${label} must be a valid http(s) URL.` });
      continue;
    }
    if (field.type === "enum" && !(field.options ?? []).includes(text)) {
      issues.push({ key: field.key, message: `${label} must match one of the available options.` });
    }
  }
  return issues;
}

export function inputValueForField(value: string | number | boolean | undefined): string {
  if (value === undefined) return "";
  return String(value);
}

export function draftToolNames(draft: AgentBuilderDraft): string[] {
  const tools = draft.agent.enabledTools?.length
    ? draft.agent.enabledTools
    : draft.agent.tools?.length
      ? draft.agent.tools
      : draft.readiness.tools.recommended;
  return uniqueStrings(tools);
}

export function providerReadinessTone(draft: AgentBuilderDraft): ReadinessTone {
  return draft.readiness.provider.configured ? "good" : "warn";
}

export function toolReadinessTone(draft: AgentBuilderDraft): ReadinessTone {
  if (draft.readiness.tools.missing.length > 0) return "warn";
  if (draftToolNames(draft).length > 0) return "good";
  return "muted";
}

export function firstRunReadinessTone(draft: AgentBuilderDraft): ReadinessTone {
  if (draft.readiness.firstRun.canRun) return "good";
  return draft.readiness.firstRun.blockers.length > 0 ? "warn" : "muted";
}

export function runStatusTone(run: AgentRunRecord | undefined): ReadinessTone {
  if (!run) return "muted";
  if (run.status === "success") return "good";
  if (run.status === "failed" || run.status === "canceled") return "danger";
  if (run.status === "running" || run.status === "queued") return "warn";
  return "muted";
}

export function agentEditorPath(agentId: string | undefined): string {
  return agentId ? `/agents/${agentId}` : "/agents";
}

export function formatSampleValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value === null || value === undefined) return "";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object") return safeJson(value);
  return String(value);
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function uniqueStrings(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
}
