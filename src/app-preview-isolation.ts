import { createHash } from "node:crypto";
import type { Context } from "hono";

export const PREVIEW_APP_ORIGIN_ENV = "PACKETAGENT_APP_ORIGIN";
export const PREVIEW_ORIGIN_ENV = "PACKETAGENT_PREVIEW_ORIGIN";

const DEFAULT_API_PORT = 8484;
const PREVIEW_SURFACE_PATH =
  /^\/api\/app\/generated-apps\/[^/]+\/(?:preview(?:\/|$)|preview-session$|api(?:\/|$))/;
const PREVIEW_PRIMARY_PATH =
  /^\/api\/app\/generated-apps\/[^/]+\/(?:preview-token$|runtime\/health$)/;

export class PreviewIsolationConfigurationError extends Error {
  readonly code = "PACKETAGENT_PREVIEW_ISOLATION_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "PreviewIsolationConfigurationError";
  }
}

export function resolvePacketAgentPreviewOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const configured = clean(env[PREVIEW_ORIGIN_ENV]);
  if (configured) return parseHttpOrigin(configured, PREVIEW_ORIGIN_ENV);
  if (env.NODE_ENV === "production") {
    throw new PreviewIsolationConfigurationError(`${PREVIEW_ORIGIN_ENV} is required in production`);
  }
  const port = positivePort(env.PORT) ?? DEFAULT_API_PORT;
  return `http://127.0.0.2:${port}`;
}

export function resolvePacketAgentAppOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = clean(env[PREVIEW_APP_ORIGIN_ENV]);
  if (configured) return parseHttpOrigin(configured, PREVIEW_APP_ORIGIN_ENV);
  if (env.NODE_ENV === "production") {
    throw new PreviewIsolationConfigurationError(
      `${PREVIEW_APP_ORIGIN_ENV} is required in production`,
    );
  }
  return null;
}

export function assertPreviewIsolationConfigured(env: NodeJS.ProcessEnv = process.env): {
  appOrigin: string | null;
  previewOrigin: string;
} {
  const previewOrigin = resolvePacketAgentPreviewOrigin(env);
  const appOrigin = resolvePacketAgentAppOrigin(env);
  const preview = new URL(previewOrigin);
  const app = appOrigin ? new URL(appOrigin) : null;
  if (
    env.NODE_ENV === "production" &&
    (preview.protocol !== "https:" || app?.protocol !== "https:")
  ) {
    throw new PreviewIsolationConfigurationError(
      `${PREVIEW_APP_ORIGIN_ENV} and ${PREVIEW_ORIGIN_ENV} must use HTTPS in production`,
    );
  }
  if (preview.protocol === "http:" && !isLoopbackHostname(preview.hostname)) {
    throw new PreviewIsolationConfigurationError(
      `${PREVIEW_ORIGIN_ENV} may use HTTP only on a loopback hostname`,
    );
  }
  if (app) {
    if (app.hostname.toLowerCase() === preview.hostname.toLowerCase()) {
      throw new PreviewIsolationConfigurationError(
        `${PREVIEW_ORIGIN_ENV} must use a different hostname than ${PREVIEW_APP_ORIGIN_ENV}; cookies are not isolated by port`,
      );
    }
  }
  return { appOrigin, previewOrigin };
}

export function isPacketAgentPreviewOriginRequest(
  c: Context,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  let previewHost: string;
  try {
    previewHost = new URL(resolvePacketAgentPreviewOrigin(env)).host.toLowerCase();
  } catch {
    return false;
  }
  return requestHost(c, env).toLowerCase() === previewHost;
}

export function isGeneratedPreviewSurfacePath(path: string): boolean {
  return PREVIEW_SURFACE_PATH.test(path);
}

export function isGeneratedPreviewPrimaryPath(path: string): boolean {
  return PREVIEW_PRIMARY_PATH.test(path);
}

export function generatedPreviewCookieName(appId: string): string {
  const suffix = createHash("sha256").update(appId).digest("hex").slice(0, 20);
  return `packetagent_preview_${suffix}`;
}

export function generatedPreviewCookiePath(appId: string): string {
  return `/api/app/generated-apps/${encodeURIComponent(appId)}/`;
}

export function generatedPreviewBootstrapUrl(
  previewOrigin: string,
  appId: string,
  token: string,
): string {
  const url = new URL(
    `${generatedPreviewCookiePath(appId)}preview/`,
    `${parseHttpOrigin(previewOrigin, PREVIEW_ORIGIN_ENV)}/`,
  );
  url.hash = `token=${encodeURIComponent(token)}`;
  return url.toString();
}

export function requestOrigin(c: Context, env: NodeJS.ProcessEnv = process.env): string {
  const forwardedProto = trustedProxyEnabled(env)
    ? clean(c.req.header("x-forwarded-proto"))?.split(",")[0]?.trim()
    : null;
  const protocol = forwardedProto || new URL(c.req.url).protocol.replace(/:$/, "");
  return `${protocol}://${requestHost(c, env)}`;
}

function requestHost(c: Context, env: NodeJS.ProcessEnv): string {
  const forwarded = trustedProxyEnabled(env)
    ? clean(c.req.header("x-forwarded-host"))?.split(",")[0]?.trim()
    : null;
  return forwarded || clean(c.req.header("host")) || new URL(c.req.url).host;
}

function trustedProxyEnabled(env: NodeJS.ProcessEnv) {
  return ["1", "true", "yes"].includes(clean(env.PACKETAGENT_TRUST_PROXY).toLowerCase());
}

function parseHttpOrigin(value: string, envName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PreviewIsolationConfigurationError(`${envName} must be an absolute http(s) origin`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new PreviewIsolationConfigurationError(
      `${envName} must be an absolute http(s) origin without credentials, path, query, or fragment`,
    );
  }
  return parsed.origin;
}

function positivePort(value: string | undefined): number | null {
  const parsed = Number.parseInt(clean(value), 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : null;
}

function clean(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  return Boolean(
    match &&
    match.slice(1).every((part) => {
      const value = Number(part);
      return Number.isInteger(value) && value >= 0 && value <= 255;
    }),
  );
}
