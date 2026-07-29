import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createHash } from "node:crypto";
import { mutateStoreAsync, upsertRateLimit } from "../packetagent-store.js";
import {
  configuredNonNegativeInteger,
  configuredPositiveInteger,
  httpRouteError,
} from "./shared.js";

export const AUTH_RATE_LIMIT = {
  maxAttempts: 20,
  windowMs: 60_000,
  maxAttemptsEnv: "PACKETAGENT_AUTH_RATE_LIMIT_MAX_ATTEMPTS",
  windowMsEnv: "PACKETAGENT_AUTH_RATE_LIMIT_WINDOW_MS",
};
export const INVITATION_RATE_LIMIT = {
  maxAttempts: 20,
  windowMs: 60_000,
  maxAttemptsEnv: "PACKETAGENT_INVITATION_RATE_LIMIT_MAX_ATTEMPTS",
  windowMsEnv: "PACKETAGENT_INVITATION_RATE_LIMIT_WINDOW_MS",
};
const RATE_LIMIT_MAX_BUCKETS = 5_000;

export async function enforceRateLimit(
  c: Context,
  scope: string,
  options: { maxAttempts: number; windowMs: number; maxAttemptsEnv: string; windowMsEnv: string },
  identifier?: string | null,
) {
  const timestamp = Date.now();
  const input = {
    bucketId: `${scope}:${hashedClientKey(clientKey(c, identifier))}`,
    scope,
    maxAttempts: configuredPositiveInteger(options.maxAttemptsEnv, options.maxAttempts),
    windowMs: configuredPositiveInteger(options.windowMsEnv, options.windowMs),
    timestamp,
    maxBuckets: configuredPositiveInteger(
      "PACKETAGENT_RATE_LIMIT_MAX_BUCKETS",
      RATE_LIMIT_MAX_BUCKETS,
    ),
  };

  applyRateLimitDecision(c, timestamp, await distributedRateLimitUpsert(input));
  applyRateLimitDecision(
    c,
    timestamp,
    await mutateStoreAsync((data) => upsertRateLimit(data, input)),
  );
}

async function distributedRateLimitUpsert(input: {
  bucketId: string;
  scope: string;
  maxAttempts: number;
  windowMs: number;
  timestamp: number;
}) {
  const url = (process.env.PACKETAGENT_DISTRIBUTED_RATE_LIMIT_URL ?? "").trim();
  if (!url) return null;

  try {
    const headers = new Headers({
      accept: "application/json",
      "content-type": "application/json",
    });
    const secret = (process.env.PACKETAGENT_DISTRIBUTED_RATE_LIMIT_SECRET ?? "").trim();
    if (secret) headers.set("authorization", `Bearer ${secret}`);

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        bucketId: input.bucketId,
        scope: input.scope,
        maxAttempts: input.maxAttempts,
        windowMs: input.windowMs,
        timestamp: new Date(input.timestamp).toISOString(),
      }),
      signal: AbortSignal.timeout(
        configuredPositiveInteger("PACKETAGENT_DISTRIBUTED_RATE_LIMIT_TIMEOUT_MS", 750),
      ),
    });
    const payload = await readJsonObject(response);
    if (response.status === 429)
      return limitedUntilFromDistributedResponse(input, response, payload);
    if (!response.ok) throw new Error(`distributed rate limiter returned ${response.status}`);
    if (payload?.limited === true || payload?.allowed === false)
      return limitedUntilFromDistributedResponse(input, response, payload);
    return null;
  } catch {
    if (distributedRateLimitFailOpen()) return null;
    throw httpRouteError(503, "rate limit service unavailable");
  }
}

function applyRateLimitDecision(c: Context, timestamp: number, limitedUntil: number | null) {
  if (limitedUntil !== null) {
    const retryAfterSeconds = Math.max(1, Math.ceil((limitedUntil - timestamp) / 1000));
    c.header("Retry-After", String(retryAfterSeconds));
    throw httpRouteError(429, "too many requests");
  }
}

async function readJsonObject(response: Response): Promise<Record<string, unknown> | null> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function limitedUntilFromDistributedResponse(
  input: { windowMs: number; timestamp: number },
  response: Response,
  payload: Record<string, unknown> | null,
) {
  const retryAfter = retryAfterLimitedUntil(response.headers.get("retry-after"), input.timestamp);
  if (retryAfter !== null) return retryAfter;

  if (
    typeof payload?.retryAfterSeconds === "number" &&
    Number.isFinite(payload.retryAfterSeconds)
  ) {
    return input.timestamp + Math.max(0, payload.retryAfterSeconds) * 1000;
  }

  const resetAt = payload?.resetAt;
  if (typeof resetAt === "string") {
    const resetAtTimestamp = Date.parse(resetAt);
    if (Number.isFinite(resetAtTimestamp)) return resetAtTimestamp;
  }
  if (typeof resetAt === "number" && Number.isFinite(resetAt)) {
    return resetAt < 10_000_000_000 ? resetAt * 1000 : resetAt;
  }

  return input.timestamp + input.windowMs;
}

function retryAfterLimitedUntil(headerValue: string | null, timestamp: number) {
  if (!headerValue) return null;
  const seconds = Number.parseInt(headerValue, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return timestamp + seconds * 1000;
  const retryAt = Date.parse(headerValue);
  return Number.isFinite(retryAt) ? retryAt : null;
}

function distributedRateLimitFailOpen() {
  return ["1", "true", "yes"].includes(
    (process.env.PACKETAGENT_DISTRIBUTED_RATE_LIMIT_FAIL_OPEN ?? "").trim().toLowerCase(),
  );
}

// Derive the rate-limit client identity.
//
// Security notes:
//   * When a proxy IS trusted, `x-forwarded-for` is "client, proxy1, proxy2"
//     (left-to-right, original client first). The left-most entry is fully
//     attacker-controlled (a client can send any XFF it likes), so taking it
//     blindly lets an attacker rotate the header to dodge the limiter. We walk
//     the list RIGHT-TO-LEFT and skip a configurable number of trusted proxy
//     hops (PACKETAGENT_TRUSTED_PROXY_HOPS) to land on the real client IP. With no
//     hop count configured we take the right-most entry (the address our own
//     trusted edge proxy observed), which the client cannot forge.
//   * When a proxy is NOT trusted, XFF is untrustworthy entirely, so we use the
//     real peer/socket address from the connection. Falling back to a single
//     constant ("local") would put every caller in one shared bucket, letting a
//     single client lock everyone out (DoS).
function clientNetworkIdentity(c: Context): string {
  if (trustedProxyEnabled()) {
    const forwarded = c.req.header("x-forwarded-for");
    if (forwarded) {
      const entries = forwarded
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (entries.length > 0) {
        const hops = configuredNonNegativeInteger("PACKETAGENT_TRUSTED_PROXY_HOPS", -1);
        if (hops >= 0) {
          // Skip `hops` trusted proxies counting from the right; clamp into range.
          const index = Math.max(0, entries.length - 1 - hops);
          return entries[index]!;
        }
        // No hop count configured: trust the right-most (closest trusted) entry.
        return entries[entries.length - 1]!;
      }
    }
    const realIp = c.req.header("x-real-ip")?.trim();
    if (realIp) return realIp;
  }

  const socketAddress = socketRemoteAddress(c);
  if (socketAddress) return socketAddress;

  // No socket address available (e.g. in-process test requests). Fall back to
  // a per-request-shape hint rather than a single global constant so unrelated
  // callers aren't all collapsed into one shared bucket.
  return `unknown:${c.req.header("user-agent")?.trim() || "noua"}`;
}

function socketRemoteAddress(c: Context): string | null {
  try {
    const address = getConnInfo(c)?.remote?.address;
    return address ? address.trim() || null : null;
  } catch {
    return null;
  }
}

function clientKey(c: Context, identifier?: string | null) {
  const network = clientNetworkIdentity(c);
  const normalizedId = identifier?.trim().toLowerCase();
  return normalizedId ? `${network}|${normalizedId}` : network;
}

function hashedClientKey(clientIdentity: string) {
  const salt = process.env.PACKETAGENT_RATE_LIMIT_KEY_SALT ?? "packetagent-rate-limit";
  return `sha256:${createHash("sha256").update(`${salt}:${clientIdentity}`).digest("hex")}`;
}

function trustedProxyEnabled() {
  return ["1", "true", "yes"].includes(
    (process.env.PACKETAGENT_TRUST_PROXY ?? "").trim().toLowerCase(),
  );
}
