import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { hashSessionSecret, SESSION_COOKIE_NAME, SESSION_TTL_MS } from "./auth-utils.js";
import { redactedErrorMessage } from "./security/redaction.js";

export const CSRF_COOKIE_NAME = "packetagent_csrf";
export const CSRF_HEADER_NAME = "x-csrf-token";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const enforcePrivateAppMutationSecurity: MiddlewareHandler = async (c, next) => {
  try {
    rejectCrossOriginPrivateMutationOrThrow(c);
  } catch (error) {
    return errorResponse(c, error);
  }
  await next();
};

export function rejectCrossOriginPrivateMutation(c: Context) {
  try {
    rejectCrossOriginPrivateMutationOrThrow(c);
    return null;
  } catch (error) {
    return errorResponse(c, error);
  }
}

export function rejectCrossOriginPrivateMutationOrThrow(c: Context) {
  if (SAFE_METHODS.has(c.req.method.toUpperCase())) return;

  const origin = c.req.header("origin");
  if (!origin) return;

  const host = originComparisonHost(c);
  try {
    if (new URL(origin).host !== host)
      throw httpRouteError(403, "cross-origin requests are not allowed");
  } catch {
    throw httpRouteError(403, "cross-origin requests are not allowed");
  }

  enforceBrowserCsrf(c);
}

export function applyCsrfCookie(c: Context, sessionCookie: string) {
  setCookie(c, CSRF_COOKIE_NAME, csrfTokenForSessionCookie(sessionCookie), {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearCsrfCookie(c: Context) {
  deleteCookie(c, CSRF_COOKIE_NAME, { path: "/" });
}

function enforceBrowserCsrf(c: Context) {
  const sessionCookie = getCookie(c, SESSION_COOKIE_NAME) ?? "";
  const csrfCookie = getCookie(c, CSRF_COOKIE_NAME) ?? "";
  const csrfHeader = c.req.header(CSRF_HEADER_NAME) ?? "";
  const expected = csrfTokenForSessionCookie(sessionCookie);

  if (!expected || csrfCookie !== expected || csrfHeader !== expected) {
    throw httpRouteError(403, "invalid csrf token");
  }
}

function csrfTokenForSessionCookie(sessionCookie: string) {
  return sessionCookie ? hashSessionSecret(`csrf:${sessionCookie}`) : "";
}

function originComparisonHost(c: Context) {
  if (trustedProxyEnabled())
    return c.req.header("x-forwarded-host") ?? c.req.header("host") ?? new URL(c.req.url).host;
  return c.req.header("host") ?? new URL(c.req.url).host;
}

function trustedProxyEnabled() {
  return ["1", "true", "yes"].includes(
    (process.env.PACKETAGENT_TRUST_PROXY ?? "").trim().toLowerCase(),
  );
}

function httpRouteError(status: number, message: string) {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}

function errorResponse(c: Context, error: unknown) {
  c.status(((error as Error & { status?: number }).status ?? 500) as ContentfulStatusCode);
  return c.json({ error: redactedErrorMessage(error) });
}
