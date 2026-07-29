import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { ToolDefinition } from "./types.js";

export type ToolCapabilityRisk = "low" | "medium" | "high";
export type ToolApprovalDecision = "launch" | "cancel";
export type ToolCapabilityApprovalDefinition = Pick<
  ToolDefinition,
  "name" | "description" | "inputSchema" | "side"
>;

export interface ToolCapabilityApprovalTool {
  name: string;
  description: string;
  side: ToolDefinition["side"];
  risk: ToolCapabilityRisk;
  riskSummary: string;
}

export interface ToolCapabilityApprovalRequest {
  required: true;
  workspaceId: string;
  agentId: string;
  triggerKind: string;
  tools: ToolCapabilityApprovalTool[];
  summary: string;
  approvalToken: string;
  expiresAt: string;
}

export interface ToolCapabilityApprovalInput {
  decision: ToolApprovalDecision;
  token: string;
  approvedTools: string[];
}

export interface BuildToolCapabilityApprovalRequestInput {
  workspaceId: string;
  userId?: string;
  agentId: string;
  triggerKind: string;
  tools?: ToolCapabilityApprovalDefinition[];
  toolDefinitions?: ToolCapabilityApprovalDefinition[];
  inputs?: unknown;
  now?: Date | number | string;
  secret?: string;
  expiresInMs?: number;
}

export interface VerifyToolCapabilityApprovalInput {
  workspaceId: string;
  userId?: string;
  agentId: string;
  triggerKind: string;
  tools?: ToolCapabilityApprovalDefinition[];
  toolDefinitions?: ToolCapabilityApprovalDefinition[];
  inputs?: unknown;
  now?: Date | number | string;
  secret?: string;
  decision?: ToolApprovalDecision;
  token?: string;
  approvedTools?: string[];
  approval?: ToolCapabilityApprovalInput;
  consume?: boolean;
}

export type ToolCapabilityApprovalVerificationContext = Omit<
  VerifyToolCapabilityApprovalInput,
  "decision" | "token" | "approvedTools" | "approval"
>;

export type ToolCapabilityApprovalVerification =
  | {
      ok: true;
      decision: "launch";
      approvedTools: string[];
      expiresAt: string;
      tools: ToolCapabilityApprovalTool[];
    }
  | {
      ok: false;
      error: string;
    };

interface ApprovalTokenPayload {
  v: 1;
  exp: number;
  jti: string;
  workspaceId: string;
  userId?: string;
  agentId: string;
  triggerKind: string;
  toolNames: string[];
  inputsHash: string;
}

interface RuntimeApprovalInput {
  decision: unknown;
  token: unknown;
  approvedTools: unknown;
}

const TOKEN_VERSION = 1;
export const DEFAULT_TOOL_APPROVAL_TTL_MS = 10 * 60 * 1000;

const DEV_TOOL_APPROVAL_SECRET = "packetagent-dev-tool-capability-approval-secret";
const consumedApprovalJtis = new Map<string, number>();
const EXTERNAL_SIDE_EFFECT_TOOLS = new Set([
  "slack_post_webhook",
  "github_api",
  "email_send",
  "sql_query",
]);

export function toolCapabilityRisk(
  tool: Pick<ToolCapabilityApprovalDefinition, "name" | "side">,
): ToolCapabilityRisk {
  if (tool.name === "shell_for_agent" || tool.side === "exec") return "high";
  if (tool.side === "write" || EXTERNAL_SIDE_EFFECT_TOOLS.has(tool.name)) return "medium";
  return "low";
}

export function requiresToolCapabilityApproval(tools: ToolCapabilityApprovalDefinition[]): boolean {
  return uniqueSortedToolNames(tools).length > 0;
}

export function toolCapabilityInputsHash(inputs: unknown): string {
  return createHash("sha256").update(stableStringify(inputs)).digest("hex");
}

export function buildToolCapabilityApprovalRequest(
  input: BuildToolCapabilityApprovalRequestInput,
): ToolCapabilityApprovalRequest {
  const tools = resolveTools(input);
  const nowMs = toTimeMs(input.now);
  const expiresAtMs = nowMs + (input.expiresInMs ?? DEFAULT_TOOL_APPROVAL_TTL_MS);
  const toolNames = uniqueSortedToolNames(tools);
  const payload: ApprovalTokenPayload = {
    v: TOKEN_VERSION,
    exp: expiresAtMs,
    jti: randomUUID(),
    workspaceId: input.workspaceId,
    ...(input.userId ? { userId: input.userId } : {}),
    agentId: input.agentId,
    triggerKind: input.triggerKind,
    toolNames,
    inputsHash: toolCapabilityInputsHash(input.inputs),
  };

  const approvalTools = tools.map((tool) => approvalToolSummary(tool));
  return {
    required: true,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    triggerKind: input.triggerKind,
    tools: approvalTools,
    summary: buildApprovalSummary(approvalTools),
    approvalToken: signPayload(payload, resolveSecret(input.secret)),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

export function verifyToolCapabilityApproval(
  input: VerifyToolCapabilityApprovalInput,
): ToolCapabilityApprovalVerification;
export function verifyToolCapabilityApproval(
  approval: ToolCapabilityApprovalInput | null | undefined,
  input: ToolCapabilityApprovalVerificationContext,
): ToolCapabilityApprovalVerification;
export function verifyToolCapabilityApproval(
  inputOrApproval:
    | VerifyToolCapabilityApprovalInput
    | ToolCapabilityApprovalInput
    | null
    | undefined,
  context?: ToolCapabilityApprovalVerificationContext,
): ToolCapabilityApprovalVerification {
  const input = resolveVerificationInput(inputOrApproval, context);
  if (!input)
    return { ok: false, error: "Tool capability approval verification context is required." };

  const approval = resolveApprovalInput(input);
  if (!approval) return { ok: false, error: "Tool capability approval payload is required." };
  if (approval.decision === "cancel")
    return { ok: false, error: "Tool capability approval was canceled." };
  if (approval.decision !== "launch")
    return { ok: false, error: "Tool capability approval decision is invalid." };

  const secret = resolveSecret(input.secret);
  const payload = verifyToken(approval.token, secret);
  if (!payload) return { ok: false, error: "Tool capability approval token is invalid." };

  const nowMs = toTimeMs(input.now);
  if (payload.exp < nowMs)
    return { ok: false, error: "Tool capability approval token has expired." };
  if (payload.workspaceId !== input.workspaceId)
    return { ok: false, error: "Tool capability approval workspace does not match." };
  if (payload.userId && input.userId && payload.userId !== input.userId) {
    return { ok: false, error: "Tool capability approval user does not match." };
  }
  if (payload.agentId !== input.agentId)
    return { ok: false, error: "Tool capability approval agent does not match." };
  if (payload.triggerKind !== input.triggerKind)
    return { ok: false, error: "Tool capability approval trigger does not match." };

  const tools = resolveTools(input);
  const toolNames = uniqueSortedToolNames(tools);
  if (!sameStringArray(payload.toolNames, toolNames)) {
    return { ok: false, error: "Tool capability approval tools do not match the enabled tools." };
  }

  const inputsHash = toolCapabilityInputsHash(input.inputs);
  if (payload.inputsHash !== inputsHash) {
    return { ok: false, error: "Tool capability approval inputs do not match." };
  }

  const approvedTools = normalizeApprovedTools(approval.approvedTools);
  if (!approvedTools || !sameStringArray(approvedTools, toolNames)) {
    return {
      ok: false,
      error: "approvedTools must include every enabled tool and no unknown tools.",
    };
  }

  if (input.consume === true) {
    pruneConsumedApprovalJtis(nowMs);
    if (consumedApprovalJtis.has(payload.jti)) {
      return { ok: false, error: "Tool capability approval token has already been used." };
    }
    consumedApprovalJtis.set(payload.jti, payload.exp);
  }

  return {
    ok: true,
    decision: "launch",
    approvedTools,
    expiresAt: new Date(payload.exp).toISOString(),
    tools: tools.map((tool) => approvalToolSummary(tool)),
  };
}

function approvalToolSummary(tool: ToolCapabilityApprovalDefinition): ToolCapabilityApprovalTool {
  const risk = toolCapabilityRisk(tool);
  return {
    name: tool.name,
    description: tool.description,
    side: tool.side,
    risk,
    riskSummary: riskSummary(tool, risk),
  };
}

function riskSummary(tool: ToolCapabilityApprovalDefinition, risk: ToolCapabilityRisk): string {
  if (risk === "high") return `${tool.name} can execute commands or high-impact operations.`;
  if (risk === "medium") return `${tool.name} can make changes or call external side-effect APIs.`;
  return `${tool.name} is read-only.`;
}

function buildApprovalSummary(tools: ToolCapabilityApprovalTool[]): string {
  if (tools.length === 0) return "Approval required for no enabled tools.";
  const counts = {
    high: tools.filter((tool) => tool.risk === "high").length,
    medium: tools.filter((tool) => tool.risk === "medium").length,
    low: tools.filter((tool) => tool.risk === "low").length,
  };
  const riskCounts = (["high", "medium", "low"] as const)
    .filter((risk) => counts[risk] > 0)
    .map((risk) => `${counts[risk]} ${risk}`)
    .join(", ");
  const names = tools.map((tool) => `${tool.name} (${tool.risk})`).join(", ");
  return `Approval required for ${tools.length} enabled tool${tools.length === 1 ? "" : "s"}: ${names}. Risk summary: ${riskCounts}.`;
}

function resolveTools(input: {
  tools?: ToolCapabilityApprovalDefinition[];
  toolDefinitions?: ToolCapabilityApprovalDefinition[];
}): ToolCapabilityApprovalDefinition[] {
  return input.tools ?? input.toolDefinitions ?? [];
}

function resolveVerificationInput(
  inputOrApproval:
    | VerifyToolCapabilityApprovalInput
    | ToolCapabilityApprovalInput
    | null
    | undefined,
  context?: ToolCapabilityApprovalVerificationContext,
): VerifyToolCapabilityApprovalInput | undefined {
  if (context)
    return {
      ...context,
      approval: (inputOrApproval ?? undefined) as ToolCapabilityApprovalInput | undefined,
    };
  if (!inputOrApproval || typeof inputOrApproval !== "object") return undefined;
  if (!("workspaceId" in inputOrApproval)) return undefined;
  return inputOrApproval as VerifyToolCapabilityApprovalInput;
}

function resolveApprovalInput(
  input: VerifyToolCapabilityApprovalInput,
): RuntimeApprovalInput | undefined {
  if (input.approval) return input.approval;
  if (
    input.decision !== undefined ||
    input.token !== undefined ||
    input.approvedTools !== undefined
  ) {
    return {
      decision: input.decision,
      token: input.token,
      approvedTools: input.approvedTools,
    };
  }
  return undefined;
}

function uniqueSortedToolNames(tools: ToolCapabilityApprovalDefinition[]): string[] {
  return [...new Set(tools.map((tool) => tool.name))].sort();
}

function normalizeApprovedTools(approvedTools: unknown): string[] | undefined {
  if (!Array.isArray(approvedTools) || !approvedTools.every((tool) => typeof tool === "string"))
    return undefined;
  return [...new Set(approvedTools)].sort();
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function toTimeMs(value: Date | number | string | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") return new Date(value).getTime();
  return Date.now();
}

function resolveSecret(secret?: string): string {
  return (
    firstNonEmpty(
      secret,
      process.env.PACKETAGENT_TOOL_APPROVAL_SECRET,
      process.env.PACKETAGENT_MASTER_KEY,
    ) ?? DEV_TOOL_APPROVAL_SECRET
  );
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.length > 0);
}

function signPayload(payload: ApprovalTokenPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${signBody(body, secret)}`;
}

function verifyToken(token: unknown, secret: string): ApprovalTokenPayload | undefined {
  if (typeof token !== "string") return undefined;
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) return undefined;
  const expected = signBody(body, secret);
  if (!constantTimeEqual(signature, expected)) return undefined;

  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
    if (!isApprovalTokenPayload(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function signBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function isApprovalTokenPayload(value: unknown): value is ApprovalTokenPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  return (
    payload.v === TOKEN_VERSION &&
    typeof payload.exp === "number" &&
    Number.isFinite(payload.exp) &&
    typeof payload.jti === "string" &&
    typeof payload.workspaceId === "string" &&
    (payload.userId === undefined || typeof payload.userId === "string") &&
    typeof payload.agentId === "string" &&
    typeof payload.triggerKind === "string" &&
    Array.isArray(payload.toolNames) &&
    payload.toolNames.every((tool) => typeof tool === "string") &&
    typeof payload.inputsHash === "string"
  );
}

function pruneConsumedApprovalJtis(nowMs: number): void {
  for (const [jti, expiresAtMs] of consumedApprovalJtis) {
    if (expiresAtMs < nowMs) consumedApprovalJtis.delete(jti);
  }
}

function stableStringify(value: unknown): string {
  return stringifyStable(value, new WeakSet<object>());
}

function stringifyStable(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return "null";
  if (value === undefined) return '{"$undefined":true}';
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "bigint") return `{"$bigint":${JSON.stringify(value.toString())}}`;
  if (typeof value === "symbol" || typeof value === "function") return `{"$${typeof value}":true}`;

  if (value instanceof Date) return `{"$date":${JSON.stringify(value.toISOString())}}`;
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Cannot hash circular approval inputs.");
    seen.add(value);
    const serialized = `[${value.map((item) => stringifyStable(item, seen)).join(",")}]`;
    seen.delete(value);
    return serialized;
  }

  if (seen.has(value)) throw new TypeError("Cannot hash circular approval inputs.");
  seen.add(value);
  const record = value as Record<string, unknown>;
  const serialized = `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stringifyStable(record[key], seen)}`)
    .join(",")}}`;
  seen.delete(value);
  return serialized;
}
