import { createHmac, timingSafeEqual } from "node:crypto";

export type GeneratedPreviewCapabilityScope = "read" | "interact";

export type GeneratedPreviewCapabilityClaims = {
  v: 1;
  appId: string;
  workspaceId: string;
  checkpointId: string;
  scope: GeneratedPreviewCapabilityScope;
  parentOrigin?: string;
  iat: number;
  exp: number;
};

export const PREVIEW_CAPABILITY_DEFAULT_TTL_SECONDS = 60 * 60;
export const PREVIEW_CAPABILITY_INTERACTIVE_TTL_SECONDS = 15 * 60;
export const PREVIEW_CAPABILITY_MAX_TTL_SECONDS = 24 * 60 * 60;
export const PREVIEW_CAPABILITY_INTERACTIVE_MAX_TTL_SECONDS = 60 * 60;

const PREVIEW_CAPABILITY_PREFIX = "pt1";
const PREVIEW_CAPABILITY_MAX_LENGTH = 4096;
const PREVIEW_CAPABILITY_CLOCK_SKEW_SECONDS = 5 * 60;
const PREVIEW_CAPABILITY_DEV_FALLBACK_SECRET =
  "packetagent-preview-token-dev-fallback-DO-NOT-USE-IN-PROD";
let previewCapabilityFallbackWarned = false;

export function mintGeneratedPreviewCapability(input: {
  appId: string;
  workspaceId: string;
  checkpointId: string;
  scope: GeneratedPreviewCapabilityScope;
  parentOrigin?: string;
  ttlSeconds?: number;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}): { token: string; claims: GeneratedPreviewCapabilityClaims } {
  const nowSec = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const maxTtl =
    input.scope === "interact"
      ? PREVIEW_CAPABILITY_INTERACTIVE_MAX_TTL_SECONDS
      : PREVIEW_CAPABILITY_MAX_TTL_SECONDS;
  const defaultTtl =
    input.scope === "interact"
      ? PREVIEW_CAPABILITY_INTERACTIVE_TTL_SECONDS
      : PREVIEW_CAPABILITY_DEFAULT_TTL_SECONDS;
  const ttlSeconds = positiveInteger(input.ttlSeconds)
    ? Math.min(input.ttlSeconds, maxTtl)
    : defaultTtl;
  const parentOrigin =
    input.scope === "interact"
      ? normalizeHttpOrigin(input.parentOrigin, "interactive preview parent origin")
      : undefined;
  const claims: GeneratedPreviewCapabilityClaims = {
    v: 1,
    appId: boundedIdentifier(input.appId, "app id"),
    workspaceId: boundedIdentifier(input.workspaceId, "workspace id"),
    checkpointId: boundedIdentifier(input.checkpointId, "checkpoint id"),
    scope: input.scope,
    ...(parentOrigin ? { parentOrigin } : {}),
    iat: nowSec,
    exp: nowSec + ttlSeconds,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = signPayload(payload, input.env ?? process.env);
  return { token: `${PREVIEW_CAPABILITY_PREFIX}.${payload}.${signature}`, claims };
}

export function verifyGeneratedPreviewCapability(
  token: string,
  routeAppId: string,
  options: { now?: Date; env?: NodeJS.ProcessEnv } = {},
): { ok: true; claims: GeneratedPreviewCapabilityClaims } | { ok: false } {
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > PREVIEW_CAPABILITY_MAX_LENGTH
  ) {
    return { ok: false };
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREVIEW_CAPABILITY_PREFIX) return { ok: false };
  const payload = parts[1] ?? "";
  const providedSignature = parts[2] ?? "";
  let expectedSignature: string;
  try {
    expectedSignature = signPayload(payload, options.env ?? process.env);
  } catch {
    return { ok: false };
  }
  if (!safeEqual(providedSignature, expectedSignature)) return { ok: false };

  let candidate: unknown;
  try {
    candidate = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false };
  }
  const claims = parseClaims(candidate);
  if (!claims || claims.appId !== routeAppId) return { ok: false };

  const nowSec = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const maxTtl =
    claims.scope === "interact"
      ? PREVIEW_CAPABILITY_INTERACTIVE_MAX_TTL_SECONDS
      : PREVIEW_CAPABILITY_MAX_TTL_SECONDS;
  if (
    claims.exp <= nowSec ||
    claims.iat > nowSec + PREVIEW_CAPABILITY_CLOCK_SKEW_SECONDS ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > maxTtl
  ) {
    return { ok: false };
  }
  return { ok: true, claims };
}

export function normalizeHttpOrigin(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute http(s) origin`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${label} must be an absolute http(s) origin`);
  }
  return parsed.origin;
}

function parseClaims(value: unknown): GeneratedPreviewCapabilityClaims | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const scope = candidate.scope;
  if (scope !== "read" && scope !== "interact") return null;
  const expectedKeys = new Set([
    "v",
    "appId",
    "workspaceId",
    "checkpointId",
    "scope",
    "iat",
    "exp",
    ...(scope === "interact" ? ["parentOrigin"] : []),
  ]);
  if (
    Object.keys(candidate).length !== expectedKeys.size ||
    Object.keys(candidate).some((key) => !expectedKeys.has(key)) ||
    candidate.v !== 1 ||
    !validIdentifier(candidate.appId) ||
    !validIdentifier(candidate.workspaceId) ||
    !validIdentifier(candidate.checkpointId) ||
    !Number.isSafeInteger(candidate.iat) ||
    !Number.isSafeInteger(candidate.exp)
  ) {
    return null;
  }
  let parentOrigin: string | undefined;
  if (scope === "interact") {
    try {
      parentOrigin = normalizeHttpOrigin(
        typeof candidate.parentOrigin === "string" ? candidate.parentOrigin : undefined,
        "interactive preview parent origin",
      );
    } catch {
      return null;
    }
  }
  return {
    v: 1,
    appId: candidate.appId,
    workspaceId: candidate.workspaceId,
    checkpointId: candidate.checkpointId,
    scope,
    ...(parentOrigin ? { parentOrigin } : {}),
    iat: candidate.iat as number,
    exp: candidate.exp as number,
  };
}

function previewCapabilitySecret(env: NodeJS.ProcessEnv): string {
  const fromPreview = (env.PACKETAGENT_PREVIEW_TOKEN_SECRET ?? "").trim();
  if (fromPreview) return fromPreview;
  const fromMaster = (env.PACKETAGENT_MASTER_KEY ?? env.MASTER_KEY ?? "").trim();
  if (fromMaster) return fromMaster;
  if (env.NODE_ENV === "production") {
    throw new Error(
      "preview capabilities are unavailable: set PACKETAGENT_PREVIEW_TOKEN_SECRET or PACKETAGENT_MASTER_KEY",
    );
  }
  if (!previewCapabilityFallbackWarned) {
    previewCapabilityFallbackWarned = true;
    console.warn(
      "[preview-capability] No PACKETAGENT_PREVIEW_TOKEN_SECRET or PACKETAGENT_MASTER_KEY set; using the development-only fallback. Configure a real secret before production.",
    );
  }
  return PREVIEW_CAPABILITY_DEV_FALLBACK_SECRET;
}

function signPayload(payload: string, env: NodeJS.ProcessEnv): string {
  return createHmac("sha256", previewCapabilitySecret(env)).update(payload).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  try {
    return timingSafeEqual(Buffer.from(left), Buffer.from(right));
  } catch {
    return false;
  }
}

function boundedIdentifier(value: string, label: string): string {
  if (!validIdentifier(value)) throw new Error(`${label} is invalid`);
  return value;
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 200 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value)
  );
}

function positiveInteger(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
