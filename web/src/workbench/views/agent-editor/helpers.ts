import type {
  AgentInputField,
  AgentPlaybookStep,
  AgentRunRecord,
  RunAgentResponse,
  ToolCapabilityApprovalRequest,
  ToolCapabilityApprovalTool,
  ToolCapabilityRisk,
} from "@/lib/types";

export type RunInputPayload = Record<string, string | number | boolean>;
export type RunAgentResult = RunAgentResponse;

export interface PendingRunApproval {
  approval: ToolCapabilityApprovalRequest;
  inputs: RunInputPayload;
  triggerKind: ToolCapabilityApprovalRequest["triggerKind"];
  evaluation?: { kind: "first_run" };
}

export function fieldValue(form: FormData, key: string): string {
  return String(form.get(key) || "").trim();
}

export function lines(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function seedRunInputs(schema: AgentInputField[]): Record<string, string> {
  const next: Record<string, string> = {};
  for (const field of schema) {
    if (field.exampleValue !== undefined) next[field.key] = field.exampleValue;
    else if (field.defaultValue !== undefined) next[field.key] = field.defaultValue;
    else if (field.type === "boolean") next[field.key] = "false";
    else next[field.key] = "";
  }
  return next;
}

export function buildRunInputPayload(
  schema: AgentInputField[],
  values: Record<string, string>,
): RunInputPayload {
  const payload: RunInputPayload = {};
  for (const field of schema) {
    const raw = values[field.key];
    if (raw === undefined || raw === "") continue;
    if (field.type === "number") {
      const numberValue = Number(raw);
      if (Number.isFinite(numberValue)) payload[field.key] = numberValue;
    } else if (field.type === "boolean") {
      payload[field.key] = raw === "true";
    } else {
      payload[field.key] = raw;
    }
  }
  return payload;
}

export function missingPlaybookTitleIndexes(steps: AgentPlaybookStep[]): number[] {
  return steps.flatMap((step, index) => (step.title.trim().length > 0 ? [] : [index]));
}

export function formatStepNumber(index: number): string {
  return String(index + 1).padStart(2, "0");
}

export function formatStepList(indexes: number[]): string {
  const labels = indexes.slice(0, 4).map(formatStepNumber);
  if (indexes.length <= labels.length) return labels.join(", ");
  return `${labels.join(", ")} +${indexes.length - labels.length} more`;
}

export function isApprovalResult(
  result: RunAgentResult | null | undefined,
): result is Extract<RunAgentResult, { approval: ToolCapabilityApprovalRequest }> {
  return Boolean(result && typeof result === "object" && "approval" in result && result.approval);
}

export function runFromAgentResult(
  result: RunAgentResult | null | undefined,
): AgentRunRecord | null {
  if (!result || typeof result !== "object" || "approval" in result) return null;
  return result.run;
}

export function riskForApprovalTool(tool: ToolCapabilityApprovalTool): ToolCapabilityRisk {
  if (tool.risk === "low" || tool.risk === "medium" || tool.risk === "high") return tool.risk;
  if (tool.side === "exec") return "high";
  if (tool.side === "write") return "medium";
  return "low";
}

export function riskPillClass(risk: ToolCapabilityRisk): "danger" | "warn" | "good" {
  if (risk === "high") return "danger";
  if (risk === "medium") return "warn";
  return "good";
}

export function formatApprovalExpiry(expiresAt: string): string {
  const time = Date.parse(expiresAt);
  if (!Number.isFinite(time)) return expiresAt;
  return new Date(time).toLocaleString();
}

export function safeStringify(value: unknown, max = 4000): string {
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized.length > max ? serialized.slice(0, max) + "\n…[truncated]" : serialized;
  } catch {
    return String(value);
  }
}
