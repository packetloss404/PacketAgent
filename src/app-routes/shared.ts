import type { Context } from "hono";
import { createHash } from "node:crypto";
import { assertPermission, type WorkspacePermission } from "../rbac.js";
import { findWorkspaceMembership, loadStoreAsync } from "../packetagent-store.js";
import { requireAuthenticatedContextAsync } from "../packetagent-services.js";
import { redactedErrorMessage } from "../security/redaction.js";
import type { ModelRoutingPresetId } from "../model-routing-presets.js";

export type AuthenticatedRouteContext = Awaited<ReturnType<typeof requireAuthenticatedContextAsync>>;

export async function requireWorkspacePermission(context: AuthenticatedRouteContext, permission: WorkspacePermission) {
  const membership = findWorkspaceMembership(await loadStoreAsync(), context.workspace.id, context.user.id);
  assertPermission(membership, permission);
}

export function httpRouteError(status: number, message: string) {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}

export function errorResponse(c: Context, error: unknown) {
  c.status(((error as Error & { status?: number }).status ?? 500) as any);
  return c.json({ error: redactedErrorMessage(error) });
}

export function stableAppId(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "generated-app";
}

export function stableHash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function configuredPositiveInteger(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function configuredNonNegativeInteger(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const CHAT_STEP_DELAY_MS = Number(process.env.PACKETAGENT_BUILDER_CHAT_STEP_MS ?? 120);

export async function emitStep(sse: { writeSSE: (event: { event: string; data: string }) => Promise<void> }, text: string) {
  await sse.writeSSE({ event: "step", data: JSON.stringify({ type: "step", text }) });
}

export async function emitProse(
  sse: { writeSSE: (event: { event: string; data: string }) => Promise<void> },
  text: string,
) {
  if (!text) return;
  await sse.writeSSE({ event: "prose", data: JSON.stringify({ type: "prose", text }) });
}

export function llmIsAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim().length > 0);
}

export function chatStreamDelay(): Promise<void> {
  if (CHAT_STEP_DELAY_MS <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, CHAT_STEP_DELAY_MS));
}

export function presetStepLabel(preset: ModelRoutingPresetId | undefined): string | null {
  if (!preset) return null;
  const labels: Record<ModelRoutingPresetId, string> = {
    fast: "Routing through the fast preset",
    smart: "Routing through the smart preset",
    cheap: "Routing through the cheap preset",
    local: "Routing through the local-first preset",
  };
  return labels[preset] ?? null;
}
