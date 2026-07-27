import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Hono } from "hono";
import { appRoutes, resetAppRouteSecurityForTests } from "./app-routes.js";
import { SESSION_COOKIE_NAME } from "./auth-utils.js";
import { enforcePrivateAppMutationSecurity } from "./route-security.js";
import { PACKETAGENT_INVITATION_EMAIL_MODE_ENV, PACKETAGENT_INVITATION_EMAIL_RETRY_MAX_ATTEMPTS_ENV, PACKETAGENT_INVITATION_EMAIL_WEBHOOK_URL_ENV } from "./invitation-email.js";
import {
  listInvitationEmailDeliveryRecordsForTests,
  resetInvitationEmailDeliveryForTests,
  setInvitationEmailDeliveryAdapterForTests,
  setInvitationEmailFetchForTests,
} from "./invitation-email-delivery.js";
import { INVITATION_EMAIL_JOB_TYPE, login } from "./packetagent-services.js";
import { clearStoreCacheForTests, listInvitationEmailDeliveriesIndexed, loadStore, mutateStore, resetStoreForTests, type WorkspaceRole } from "./packetagent-store.js";

function createTestApp() {
  const app = new Hono();
  app.use("/api/app/*", enforcePrivateAppMutationSecurity);
  app.route("/api", appRoutes);
  return app;
}

function authHeaders(cookieValue: string) {
  return { Cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` };
}

function cookieValue(response: Response) {
  const cookie = response.headers.get("set-cookie") ?? "";
  const match = cookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  assert.ok(match?.[1], "expected response to set a session cookie");
  return match[1];
}

function csrfCookieValue(response: Response) {
  const cookie = response.headers.get("set-cookie") ?? "";
  const match = cookie.match(/packetagent_csrf=([^;]+)/);
  assert.ok(match?.[1], "expected response to set a csrf cookie");
  return match[1];
}

function browserAuthHeaders(cookie: string, csrfToken: string) {
  return {
    Cookie: `${SESSION_COOKIE_NAME}=${cookie}; packetagent_csrf=${csrfToken}`,
    Origin: "http://localhost",
    Host: "localhost",
    "X-CSRF-Token": csrfToken,
  };
}

function setAlphaRole(role: WorkspaceRole) {
  mutateStore((data) => {
    const membership = data.memberships.find((entry) => entry.workspaceId === "alpha" && entry.userId === "user_alpha");
    assert.ok(membership, "expected alpha membership");
    membership.role = role;
  });
}

test("session route reports unauthenticated without a valid session cookie", async () => {
  resetStoreForTests();
  const app = createTestApp();

  const response = await app.request("/api/auth/session");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, { authenticated: false, user: null, workspace: null, onboarding: null });
});

test("register creates an authenticated session response and session cookie", async () => {
  resetStoreForTests();
  const app = createTestApp();

  const response = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "New.User@Example.com", password: "demo12345", displayName: "New User" }),
  });
  const body = await response.json() as { authenticated: boolean; user: { email: string }; workspace: { name: string } };

  assert.equal(response.status, 201);
  assert.equal(body.authenticated, true);
  assert.equal(body.user.email, "new.user@example.com");
  assert.equal(body.workspace.name, "New workspace");
  assert.match(response.headers.get("set-cookie") ?? "", new RegExp(`${SESSION_COOKIE_NAME}=`));
});

test("login rejects invalid credentials with route-level 401 response", async () => {
  resetStoreForTests();
  resetAppRouteSecurityForTests();
  const app = createTestApp();

  const response = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "alpha@packetagent.local", password: "wrong-password" }),
  });
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.deepEqual(body, { error: "invalid email or password" });
});

test("auth routes rate limit repeated local attempts", async () => {
  resetStoreForTests();
  resetAppRouteSecurityForTests();
  const app = createTestApp();

  for (let index = 0; index < 20; index += 1) {
    const response = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10" },
      body: JSON.stringify({ email: "not-an-email", password: "demo12345", displayName: "New User" }),
    });
    assert.equal(response.status, 400);
  }

  const limitedRegister = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10" },
    body: JSON.stringify({ email: "not-an-email", password: "demo12345", displayName: "New User" }),
  });
  assert.equal(limitedRegister.status, 429);
  assert.deepEqual(await limitedRegister.json(), { error: "too many requests" });
  assert.ok(limitedRegister.headers.get("retry-after"));

  for (let index = 0; index < 20; index += 1) {
    const response = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.11" },
      body: JSON.stringify({ email: "alpha@packetagent.local", password: "wrong-password" }),
    });
    assert.equal(response.status, 401);
  }

  const limitedLogin = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.11" },
    body: JSON.stringify({ email: "alpha@packetagent.local", password: "wrong-password" }),
  });
  assert.equal(limitedLogin.status, 429);
  assert.deepEqual(await limitedLogin.json(), { error: "too many requests" });
});

test("auth rate limit env overrides max attempts and window", async () => {
  const previousMaxAttempts = process.env.PACKETAGENT_AUTH_RATE_LIMIT_MAX_ATTEMPTS;
  const previousWindowMs = process.env.PACKETAGENT_AUTH_RATE_LIMIT_WINDOW_MS;
  try {
    process.env.PACKETAGENT_AUTH_RATE_LIMIT_MAX_ATTEMPTS = "2";
    process.env.PACKETAGENT_AUTH_RATE_LIMIT_WINDOW_MS = "2500";
    resetStoreForTests();
    resetAppRouteSecurityForTests();
    const app = createTestApp();
    const headers = { "content-type": "application/json" };

    const first = await app.request("/api/auth/login", {
      method: "POST",
      headers,
      body: JSON.stringify({ email: "alpha@packetagent.local", password: "wrong-password" }),
    });
    assert.equal(first.status, 401);
    const bucket = (loadStore().rateLimits ?? []).find((entry) => entry.id.startsWith("auth:login:"));
    assert.ok(bucket, "expected auth login rate limit bucket");
    assert.equal(new Date(bucket.resetAt).getTime() - new Date(bucket.updatedAt).getTime(), 2500);

    const second = await app.request("/api/auth/login", {
      method: "POST",
      headers,
      body: JSON.stringify({ email: "alpha@packetagent.local", password: "wrong-password" }),
    });
    assert.equal(second.status, 401);

    const limited = await app.request("/api/auth/login", {
      method: "POST",
      headers,
      body: JSON.stringify({ email: "alpha@packetagent.local", password: "wrong-password" }),
    });
    assert.equal(limited.status, 429);
  } finally {
    restoreEnv("PACKETAGENT_AUTH_RATE_LIMIT_MAX_ATTEMPTS", previousMaxAttempts);
    restoreEnv("PACKETAGENT_AUTH_RATE_LIMIT_WINDOW_MS", previousWindowMs);
  }
});

test("auth rate limit invalid env values fall back to defaults", async () => {
  const previousMaxAttempts = process.env.PACKETAGENT_AUTH_RATE_LIMIT_MAX_ATTEMPTS;
  const previousWindowMs = process.env.PACKETAGENT_AUTH_RATE_LIMIT_WINDOW_MS;
  try {
    process.env.PACKETAGENT_AUTH_RATE_LIMIT_MAX_ATTEMPTS = "0";
    process.env.PACKETAGENT_AUTH_RATE_LIMIT_WINDOW_MS = "not-a-number";
    resetStoreForTests();
    resetAppRouteSecurityForTests();
    const app = createTestApp();
    const headers = { "content-type": "application/json" };

    const first = await app.request("/api/auth/login", {
      method: "POST",
      headers,
      body: JSON.stringify({ email: "alpha@packetagent.local", password: "wrong-password" }),
    });
    assert.equal(first.status, 401);
    const bucket = (loadStore().rateLimits ?? []).find((entry) => entry.id.startsWith("auth:login:"));
    assert.ok(bucket, "expected auth login rate limit bucket");
    assert.equal(new Date(bucket.resetAt).getTime() - new Date(bucket.updatedAt).getTime(), 60_000);

    for (let index = 1; index < 20; index += 1) {
      const response = await app.request("/api/auth/login", {
        method: "POST",
        headers,
        body: JSON.stringify({ email: "alpha@packetagent.local", password: "wrong-password" }),
      });
      assert.equal(response.status, 401);
    }

    const limited = await app.request("/api/auth/login", {
      method: "POST",
      headers,
      body: JSON.stringify({ email: "alpha@packetagent.local", password: "wrong-password" }),
    });
    assert.equal(limited.status, 429);
  } finally {
    restoreEnv("PACKETAGENT_AUTH_RATE_LIMIT_MAX_ATTEMPTS", previousMaxAttempts);
    restoreEnv("PACKETAGENT_AUTH_RATE_LIMIT_WINDOW_MS", previousWindowMs);
  }
});

test("auth route rate limits persist across app instances and store reloads", { concurrency: false }, async () => {
  const previousStore = process.env.PACKETAGENT_STORE;
  const previousDbPath = process.env.PACKETAGENT_DB_PATH;
  const previousTrustProxy = process.env.PACKETAGENT_TRUST_PROXY;
  const previousSalt = process.env.PACKETAGENT_RATE_LIMIT_KEY_SALT;
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-rate-limit-"));

  try {
    process.env.PACKETAGENT_STORE = "sqlite";
    process.env.PACKETAGENT_DB_PATH = join(tempDir, "packetagent.sqlite");
    process.env.PACKETAGENT_TRUST_PROXY = "true";
    process.env.PACKETAGENT_RATE_LIMIT_KEY_SALT = "test-rate-limit-salt";
    resetStoreForTests();
    resetAppRouteSecurityForTests();
    const headers = { "content-type": "application/json", "x-forwarded-for": "203.0.113.12" };

    for (let index = 0; index < 20; index += 1) {
      const response = await createTestApp().request("/api/auth/login", {
        method: "POST",
        headers,
        body: JSON.stringify({ email: "alpha@packetagent.local", password: "wrong-password" }),
      });
      assert.equal(response.status, 401);
    }
    const buckets = loadStore().rateLimits ?? [];
    assert.equal(buckets.length, 1);
    assert.match(buckets[0]?.id ?? "", /^auth:login:sha256:[a-f0-9]{64}$/);
    assert.equal(buckets[0]?.id.includes("203.0.113.12"), false);
    assert.deepEqual(rateLimitSqliteSnapshot(process.env.PACKETAGENT_DB_PATH), {
      appRecordRateLimits: 0,
      buckets: 1,
      count: 20,
    });

    clearStoreCacheForTests();
    const app = createTestApp();

    const limited = await app.request("/api/auth/login", {
      method: "POST",
      headers,
      body: JSON.stringify({ email: "alpha@packetagent.local", password: "wrong-password" }),
    });
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: "too many requests" });
    assert.deepEqual(rateLimitSqliteSnapshot(process.env.PACKETAGENT_DB_PATH), {
      appRecordRateLimits: 0,
      buckets: 1,
      count: 21,
    });
  } finally {
    clearStoreCacheForTests();
    restoreEnv("PACKETAGENT_STORE", previousStore);
    restoreEnv("PACKETAGENT_DB_PATH", previousDbPath);
    restoreEnv("PACKETAGENT_TRUST_PROXY", previousTrustProxy);
    restoreEnv("PACKETAGENT_RATE_LIMIT_KEY_SALT", previousSalt);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function rateLimitSqliteSnapshot(dbPath: string | undefined) {
  assert.ok(dbPath, "expected PACKETAGENT_DB_PATH");
  const db = new DatabaseSync(dbPath);
  try {
    const appRecords = db.prepare("select count(*) as count from app_records where collection = 'rateLimits'").get() as { count: number };
    const buckets = db.prepare("select count(*) as buckets, coalesce(max(count), 0) as count from rate_limit_buckets").get() as { buckets: number; count: number };
    return { appRecordRateLimits: appRecords.count, buckets: buckets.buckets, count: buckets.count };
  } finally {
    db.close();
  }
}

test("rate limit client keys only trust forwarded headers when enabled", async () => {
  const previousTrustProxy = process.env.PACKETAGENT_TRUST_PROXY;
  const previousSalt = process.env.PACKETAGENT_RATE_LIMIT_KEY_SALT;
  try {
    process.env.PACKETAGENT_RATE_LIMIT_KEY_SALT = "test-rate-limit-salt";
    delete process.env.PACKETAGENT_TRUST_PROXY;
    resetStoreForTests();
    const app = createTestApp();

    for (let index = 0; index < 20; index += 1) {
      const response = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${index}` },
        body: JSON.stringify({ email: "alpha@packetagent.local", password: "wrong-password" }),
      });
      assert.equal(response.status, 401);
    }
    const untrustedLimited = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.200" },
      body: JSON.stringify({ email: "alpha@packetagent.local", password: "wrong-password" }),
    });
    assert.equal(untrustedLimited.status, 429);

    process.env.PACKETAGENT_TRUST_PROXY = "true";
    resetStoreForTests();
    for (let index = 0; index < 20; index += 1) {
      const response = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${index}` },
        body: JSON.stringify({ email: "alpha@packetagent.local", password: "wrong-password" }),
      });
      assert.equal(response.status, 401);
    }
    const trustedSeparateClient = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.200" },
      body: JSON.stringify({ email: "alpha@packetagent.local", password: "wrong-password" }),
    });
    assert.equal(trustedSeparateClient.status, 401);
    assert.equal((loadStore().rateLimits ?? []).some((entry) => entry.id.includes("203.0.113")), false);
  } finally {
    restoreEnv("PACKETAGENT_TRUST_PROXY", previousTrustProxy);
    restoreEnv("PACKETAGENT_RATE_LIMIT_KEY_SALT", previousSalt);
  }
});

test("distributed rate limiter receives hashed auth and invitation bucket checks", async () => {
  const previousUrl = process.env.PACKETAGENT_DISTRIBUTED_RATE_LIMIT_URL;
  const previousSecret = process.env.PACKETAGENT_DISTRIBUTED_RATE_LIMIT_SECRET;
  const previousTrustProxy = process.env.PACKETAGENT_TRUST_PROXY;
  const previousSalt = process.env.PACKETAGENT_RATE_LIMIT_KEY_SALT;
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  try {
    process.env.PACKETAGENT_DISTRIBUTED_RATE_LIMIT_URL = "https://limits.example/check";
    process.env.PACKETAGENT_DISTRIBUTED_RATE_LIMIT_SECRET = "shared-secret";
    process.env.PACKETAGENT_TRUST_PROXY = "true";
    process.env.PACKETAGENT_RATE_LIMIT_KEY_SALT = "test-rate-limit-salt";
    globalThis.fetch = async (input, init) => {
      const body = init?.body;
      const headers = init?.headers;
      if (typeof body !== "string") throw new Error("expected string request body");
      if (!(headers instanceof Headers)) throw new Error("expected Headers request headers");
      calls.push({
        url: String(input),
        headers,
        body: JSON.parse(body) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ allowed: true }), { status: 200, headers: { "content-type": "application/json" } });
    };
    resetStoreForTests();
    resetAppRouteSecurityForTests();
    const app = createTestApp();
    const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
    setAlphaRole("admin");

    const loginResponse = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.40" },
      body: JSON.stringify({ email: "alpha@packetagent.local", password: "wrong-password" }),
    });
    assert.equal(loginResponse.status, 401);

    const invitationResponse = await app.request("/api/app/invitations", {
      method: "POST",
      headers: { ...authHeaders(alpha.cookieValue), "content-type": "application/json", "x-forwarded-for": "203.0.113.41" },
      body: JSON.stringify({ email: "not-an-email", role: "member" }),
    });
    assert.equal(invitationResponse.status, 400);

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url, "https://limits.example/check");
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer shared-secret");
    assert.equal(calls[0]?.body.scope, "auth:login");
    assert.match(String(calls[0]?.body.bucketId), /^auth:login:sha256:[a-f0-9]{64}$/);
    assert.equal(String(calls[0]?.body.bucketId).includes("203.0.113.40"), false);
    assert.equal(calls[0]?.body.maxAttempts, 20);
    assert.equal(calls[0]?.body.windowMs, 60_000);
    assert.equal(calls[1]?.body.scope, "invitation:create");
    assert.match(String(calls[1]?.body.bucketId), /^invitation:create:sha256:[a-f0-9]{64}$/);
    assert.equal(String(calls[1]?.body.bucketId).includes("203.0.113.41"), false);
    assert.equal((loadStore().rateLimits ?? []).some((entry) => entry.id.startsWith("auth:login:")), true);
    assert.equal((loadStore().rateLimits ?? []).some((entry) => entry.id.startsWith("invitation:create:")), true);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv("PACKETAGENT_DISTRIBUTED_RATE_LIMIT_URL", previousUrl);
    restoreEnv("PACKETAGENT_DISTRIBUTED_RATE_LIMIT_SECRET", previousSecret);
    restoreEnv("PACKETAGENT_TRUST_PROXY", previousTrustProxy);
    restoreEnv("PACKETAGENT_RATE_LIMIT_KEY_SALT", previousSalt);
  }
});

test("distributed rate limiter blocks before local buckets and sets retry-after", async () => {
  const previousUrl = process.env.PACKETAGENT_DISTRIBUTED_RATE_LIMIT_URL;
  const previousFetch = globalThis.fetch;
  try {
    process.env.PACKETAGENT_DISTRIBUTED_RATE_LIMIT_URL = "https://limits.example/check";
    globalThis.fetch = async () => new Response(JSON.stringify({ limited: true }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "7" },
    });
    resetStoreForTests();
    resetAppRouteSecurityForTests();
    const app = createTestApp();

    const response = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alpha@packetagent.local", password: "wrong-password" }),
    });

    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "7");
    assert.deepEqual(await response.json(), { error: "too many requests" });
    assert.equal((loadStore().rateLimits ?? []).length, 0);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv("PACKETAGENT_DISTRIBUTED_RATE_LIMIT_URL", previousUrl);
  }
});

test("distributed rate limiter fails closed unless fail-open is enabled", async () => {
  const previousUrl = process.env.PACKETAGENT_DISTRIBUTED_RATE_LIMIT_URL;
  const previousFailOpen = process.env.PACKETAGENT_DISTRIBUTED_RATE_LIMIT_FAIL_OPEN;
  const previousMaxAttempts = process.env.PACKETAGENT_AUTH_RATE_LIMIT_MAX_ATTEMPTS;
  const previousFetch = globalThis.fetch;
  try {
    process.env.PACKETAGENT_DISTRIBUTED_RATE_LIMIT_URL = "https://limits.example/check";
    globalThis.fetch = async () => {
      throw new Error("limiter unavailable");
    };
    resetStoreForTests();
    resetAppRouteSecurityForTests();
    const closedResponse = await createTestApp().request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alpha@packetagent.local", password: "wrong-password" }),
    });
    assert.equal(closedResponse.status, 503);
    assert.deepEqual(await closedResponse.json(), { error: "rate limit service unavailable" });
    assert.equal((loadStore().rateLimits ?? []).length, 0);

    process.env.PACKETAGENT_DISTRIBUTED_RATE_LIMIT_FAIL_OPEN = "true";
    process.env.PACKETAGENT_AUTH_RATE_LIMIT_MAX_ATTEMPTS = "1";
    resetStoreForTests();
    const failOpenFirst = await createTestApp().request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alpha@packetagent.local", password: "wrong-password" }),
    });
    assert.equal(failOpenFirst.status, 401);
    const failOpenLimited = await createTestApp().request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alpha@packetagent.local", password: "wrong-password" }),
    });
    assert.equal(failOpenLimited.status, 429);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv("PACKETAGENT_DISTRIBUTED_RATE_LIMIT_URL", previousUrl);
    restoreEnv("PACKETAGENT_DISTRIBUTED_RATE_LIMIT_FAIL_OPEN", previousFailOpen);
    restoreEnv("PACKETAGENT_AUTH_RATE_LIMIT_MAX_ATTEMPTS", previousMaxAttempts);
  }
});

test("rate limit cleanup drops expired buckets and caps retained buckets", async () => {
  const previousMaxBuckets = process.env.PACKETAGENT_RATE_LIMIT_MAX_BUCKETS;
  try {
    process.env.PACKETAGENT_RATE_LIMIT_MAX_BUCKETS = "2";
    resetStoreForTests();
    mutateStore((data) => {
      data.rateLimits = [
        { id: "expired", count: 3, resetAt: new Date(Date.now() - 1_000).toISOString(), updatedAt: new Date(Date.now() - 1_000).toISOString() },
        { id: "old-active", count: 1, resetAt: new Date(Date.now() + 60_000).toISOString(), updatedAt: new Date(Date.now() - 500).toISOString() },
      ];
    });
    const app = createTestApp();

    await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "not-an-email", password: "demo12345", displayName: "New User" }),
    });
    await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alpha@packetagent.local", password: "wrong-password" }),
    });

    const buckets = loadStore().rateLimits ?? [];
    assert.equal(buckets.some((entry) => entry.id === "expired"), false);
    assert.equal(buckets.length, 2);
  } finally {
    restoreEnv("PACKETAGENT_RATE_LIMIT_MAX_BUCKETS", previousMaxBuckets);
  }
});

test("browser private mutations enforce same-origin and session-bound csrf", async () => {
  resetStoreForTests();
  const app = createTestApp();

  const loginResponse = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "alpha@packetagent.local", password: "demo12345" }),
  });
  const sessionCookie = cookieValue(loginResponse);
  const csrfToken = csrfCookieValue(loginResponse);

  const crossOrigin = await app.request("/api/app/profile", {
    method: "PATCH",
    headers: {
      ...browserAuthHeaders(sessionCookie, csrfToken),
      Origin: "https://evil.example",
      "content-type": "application/json",
    },
    body: JSON.stringify({ displayName: "Blocked", timezone: "UTC" }),
  });
  assert.equal(crossOrigin.status, 403);
  assert.deepEqual(await crossOrigin.json(), { error: "cross-origin requests are not allowed" });

  const missingCsrf = await app.request("/api/app/profile", {
    method: "PATCH",
    headers: {
      ...authHeaders(sessionCookie),
      Origin: "http://localhost",
      Host: "localhost",
      "content-type": "application/json",
    },
    body: JSON.stringify({ displayName: "Missing", timezone: "UTC" }),
  });
  assert.equal(missingCsrf.status, 403);
  assert.deepEqual(await missingCsrf.json(), { error: "invalid csrf token" });

  const invalidCsrf = await app.request("/api/app/profile", {
    method: "PATCH",
    headers: {
      Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}; packetagent_csrf=invalid`,
      Origin: "http://localhost",
      Host: "localhost",
      "X-CSRF-Token": "invalid",
      "content-type": "application/json",
    },
    body: JSON.stringify({ displayName: "Invalid", timezone: "UTC" }),
  });
  assert.equal(invalidCsrf.status, 403);
  assert.deepEqual(await invalidCsrf.json(), { error: "invalid csrf token" });

  const sameOrigin = await app.request("/api/app/profile", {
    method: "PATCH",
    headers: { ...browserAuthHeaders(sessionCookie, csrfToken), "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Same Origin", timezone: "UTC" }),
  });
  assert.equal(sameOrigin.status, 200);

  const apiClientCompatible = await app.request("/api/app/profile", {
    method: "PATCH",
    headers: { ...authHeaders(sessionCookie), "content-type": "application/json" },
    body: JSON.stringify({ displayName: "API Client", timezone: "UTC" }),
  });
  assert.equal(apiClientCompatible.status, 200);
});

test("logout removes the current session so subsequent session reads are anonymous", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });

  const logoutResponse = await app.request("/api/auth/logout", {
    method: "POST",
    headers: authHeaders(auth.cookieValue),
  });
  const sessionResponse = await app.request("/api/auth/session", {
    headers: authHeaders(auth.cookieValue),
  });
  const sessionBody = await sessionResponse.json();

  assert.equal(logoutResponse.status, 200);
  assert.deepEqual(sessionBody, { authenticated: false, user: null, workspace: null, onboarding: null });
});

test("workspace route requires auth, validates website, and returns the updated workspace", async () => {
  resetStoreForTests();
  const app = createTestApp();

  const unauthorized = await app.request("/api/app/workspace", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { error: "authentication required" });

  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const invalid = await app.request("/api/app/workspace", {
    method: "PATCH",
    headers: { ...authHeaders(auth.cookieValue), "content-type": "application/json" },
    body: JSON.stringify({ name: "Alpha Workspace", website: "not-a-url", automationGoal: "Automate triage" }),
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "website must be a valid URL" });

  const valid = await app.request("/api/app/workspace", {
    method: "PATCH",
    headers: { ...authHeaders(auth.cookieValue), "content-type": "application/json" },
    body: JSON.stringify({ name: "Alpha Ops", website: "https://alpha.example", automationGoal: "Automate triage" }),
  });
  const body = await valid.json() as { workspace: { name: string; slug: string; website: string; automationGoal: string } };

  assert.equal(valid.status, 200);
  assert.equal(body.workspace.name, "Alpha Ops");
  assert.equal(body.workspace.slug, "alpha-ops");
  assert.equal(body.workspace.website, "https://alpha.example");
  assert.equal(body.workspace.automationGoal, "Automate triage");
});

test("workspace settings require admin or owner membership", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });

  for (const role of ["viewer", "member"] as const) {
    setAlphaRole(role);
    const denied = await app.request("/api/app/workspace", {
      method: "PATCH",
      headers: { ...authHeaders(auth.cookieValue), "content-type": "application/json" },
      body: JSON.stringify({ name: "Alpha Ops", website: "https://alpha.example", automationGoal: "Automate triage" }),
    });

    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: "workspace role admin is required" });
  }

  setAlphaRole("admin");
  const allowed = await app.request("/api/app/workspace", {
    method: "PATCH",
    headers: { ...authHeaders(auth.cookieValue), "content-type": "application/json" },
    body: JSON.stringify({ name: "Alpha Admin Ops", website: "https://alpha.example", automationGoal: "Automate triage" }),
  });
  const body = await allowed.json() as { workspace: { name: string } };

  assert.equal(allowed.status, 200);
  assert.equal(body.workspace.name, "Alpha Admin Ops");
});

test("viewer memberships can read shared app state and update their own profile", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  setAlphaRole("viewer");

  for (const path of ["/api/auth/session", "/api/app/bootstrap", "/api/app/activation", "/api/app/activity", "/api/app/onboarding"] as const) {
    const response = await app.request(path, { headers: authHeaders(auth.cookieValue) });
    assert.equal(response.status, 200, `${path} should allow viewer reads`);
  }

  const profile = await app.request("/api/app/profile", {
    method: "PATCH",
    headers: { ...authHeaders(auth.cookieValue), "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Alpha Viewer", timezone: "America/New_York" }),
  });
  const body = await profile.json() as { profile: { displayName: string; timezone: string } };

  assert.equal(profile.status, 200);
  assert.equal(body.profile.displayName, "Alpha Viewer");
  assert.equal(body.profile.timezone, "America/New_York");
});

test("activation route reflects normalized durable activation signals", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const registration = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "signals@example.com", password: "demo12345", displayName: "Signals User" }),
  });
  const authCookie = cookieValue(registration);
  const registered = await registration.json() as { workspace: { id: string } };

  mutateStore((data) => {
    data.activationSignals.push(
      {
        id: "signal_registered_retry",
        workspaceId: registered.workspace.id,
        kind: "retry",
        source: "agent_run",
        sourceId: "run_registered_failed",
        createdAt: "2026-04-22T10:00:00.000Z",
        updatedAt: "2026-04-22T10:00:00.000Z",
      },
      {
        id: "signal_registered_scope",
        workspaceId: registered.workspace.id,
        kind: "scope_change",
        source: "workflow",
        sourceId: "brief_registered_v2",
        createdAt: "2026-04-22T11:00:00.000Z",
        updatedAt: "2026-04-22T11:00:00.000Z",
      },
    );
  });

  const response = await app.request("/api/app/activation", { headers: authHeaders(authCookie) });
  const body = await response.json() as { activation: { status: { risk: { reasons: string[] } } } };

  assert.equal(response.status, 200);
  assert.ok(body.activation.status.risk.reasons.includes("Work required retries."));
  assert.ok(body.activation.status.risk.reasons.includes("Scope changed during execution."));
});

test("onboarding completion requires member or above membership", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });

  setAlphaRole("viewer");
  const denied = await app.request("/api/app/onboarding/steps/create_workspace_profile/complete", {
    method: "POST",
    headers: authHeaders(auth.cookieValue),
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "workspace role member is required" });

  setAlphaRole("member");
  const allowed = await app.request("/api/app/onboarding/steps/create_workspace_profile/complete", {
    method: "POST",
    headers: authHeaders(auth.cookieValue),
  });
  const body = await allowed.json() as { onboarding: { completedSteps: string[] } };

  assert.equal(allowed.status, 200);
  assert.ok(body.onboarding.completedSteps.includes("create_workspace_profile"));
});

test("onboarding routes expose current state and reject unknown completion steps", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const registration = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "onboarding@example.com", password: "demo12345", displayName: "Onboarding User" }),
  });
  const authCookie = cookieValue(registration);

  const current = await app.request("/api/app/onboarding", { headers: authHeaders(authCookie) });
  const currentBody = await current.json() as { onboarding: { status: string; currentStep: string; completedSteps: string[] } };
  assert.equal(current.status, 200);
  assert.equal(currentBody.onboarding.status, "not_started");
  assert.equal(currentBody.onboarding.currentStep, "create_workspace_profile");
  assert.deepEqual(currentBody.onboarding.completedSteps, []);

  const invalid = await app.request("/api/app/onboarding/steps/not-a-step/complete", {
    method: "POST",
    headers: authHeaders(authCookie),
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "unknown onboarding step" });

  const completed = await app.request("/api/app/onboarding/steps/create_workspace_profile/complete", {
    method: "POST",
    headers: authHeaders(authCookie),
  });
  const completedBody = await completed.json() as { onboarding: { status: string; currentStep: string; completedSteps: string[] } };

  assert.equal(completed.status, 200);
  assert.equal(completedBody.onboarding.status, "in_progress");
  assert.equal(completedBody.onboarding.currentStep, "define_requirements");
  assert.deepEqual(completedBody.onboarding.completedSteps, ["create_workspace_profile"]);
});

test("member and invitation routes enforce workspace management permissions", async () => {
  resetStoreForTests();
  resetAppRouteSecurityForTests();
  const app = createTestApp();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });

  setAlphaRole("viewer");
  const list = await app.request("/api/app/members", { headers: authHeaders(auth.cookieValue) });
  assert.equal(list.status, 200);
  assert.ok((await list.json() as { members: unknown[] }).members.length > 0);

  for (const role of ["viewer", "member"] as const) {
    setAlphaRole(role);
    const denied = await app.request("/api/app/invitations", {
      method: "POST",
      headers: { ...authHeaders(auth.cookieValue), "content-type": "application/json" },
      body: JSON.stringify({ email: "beta@packetagent.local", role: "member" }),
    });

    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: "workspace role admin is required" });
  }
});

test("private mutating app routes reject cross-origin browser requests", async () => {
  resetStoreForTests();
  resetAppRouteSecurityForTests();
  const app = createTestApp();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });

  const rejected = await app.request("/api/app/workspace", {
    method: "PATCH",
    headers: {
      ...authHeaders(auth.cookieValue),
      "content-type": "application/json",
      host: "localhost",
      origin: "https://evil.example",
    },
    body: JSON.stringify({ name: "Blocked", website: "", automationGoal: "" }),
  });

  assert.equal(rejected.status, 403);
  assert.deepEqual(await rejected.json(), { error: "cross-origin requests are not allowed" });
});

test("member listing exposes invitation previews without full tokens", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  setAlphaRole("admin");

  const created = await app.request("/api/app/invitations", {
    method: "POST",
    headers: { ...authHeaders(auth.cookieValue), "content-type": "application/json" },
    body: JSON.stringify({ email: "beta@packetagent.local", role: "member" }),
  });
  assert.equal(created.status, 201);

  const adminList = await app.request("/api/app/members", { headers: authHeaders(auth.cookieValue) });
  const adminBody = await adminList.json() as { invitations: Array<{ token?: string; tokenPreview?: string }> };
  assert.equal(adminBody.invitations[0]?.token, undefined);
  assert.ok(adminBody.invitations[0]?.tokenPreview);

  setAlphaRole("viewer");
  const viewerList = await app.request("/api/app/members", { headers: authHeaders(auth.cookieValue) });
  const viewerBody = await viewerList.json() as { invitations: Array<{ token?: string; tokenPreview?: string }> };
  assert.equal(viewerList.status, 200);
  assert.equal(viewerBody.invitations[0]?.token, undefined);
  assert.ok(viewerBody.invitations[0]?.tokenPreview);
});

test("admins can invite an existing user and that user can accept", async () => {
  resetStoreForTests();
  resetAppRouteSecurityForTests();
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const beta = login({ email: "beta@packetagent.local", password: "demo12345" });
  setAlphaRole("admin");

  const created = await app.request("/api/app/invitations", {
    method: "POST",
    headers: { ...authHeaders(alpha.cookieValue), "content-type": "application/json" },
    body: JSON.stringify({ email: "Beta@PacketAgent.Local", role: "member" }),
  });
  const createdBody = await created.json() as { invitation: { token: string; email: string; role: string; status: string } };

  assert.equal(created.status, 201);
  assert.equal(createdBody.invitation.email, "beta@packetagent.local");
  assert.equal(createdBody.invitation.role, "member");
  assert.equal(createdBody.invitation.status, "pending");
  assert.ok(createdBody.invitation.token);

  const accepted = await app.request(`/api/app/invitations/${createdBody.invitation.token}/accept`, {
    method: "POST",
    headers: authHeaders(beta.cookieValue),
  });
  const acceptedBody = await accepted.json() as { membership: { userId: string; role: string }; invitation: { status: string } };

  assert.equal(accepted.status, 200);
  assert.equal(acceptedBody.membership.userId, "user_beta");
  assert.equal(acceptedBody.membership.role, "member");
  assert.equal(acceptedBody.invitation.status, "accepted");
  assert.equal(loadStore().memberships.some((entry) => entry.workspaceId === "alpha" && entry.userId === "user_beta"), true);
});

test("invitation create, accept, and resend routes are rate limited", async () => {
  const previousTrustProxy = process.env.PACKETAGENT_TRUST_PROXY;
  try {
    process.env.PACKETAGENT_TRUST_PROXY = "true";
    resetStoreForTests();
    resetAppRouteSecurityForTests();
    const app = createTestApp();
    const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
    const beta = login({ email: "beta@packetagent.local", password: "demo12345" });
    setAlphaRole("admin");

  for (let index = 0; index < 20; index += 1) {
    const response = await app.request("/api/app/invitations", {
      method: "POST",
      headers: { ...authHeaders(alpha.cookieValue), "content-type": "application/json", "x-forwarded-for": "203.0.113.20" },
      body: JSON.stringify({ email: "not-an-email", role: "member" }),
    });
    assert.equal(response.status, 400);
  }
  const createLimited = await app.request("/api/app/invitations", {
    method: "POST",
    headers: { ...authHeaders(alpha.cookieValue), "content-type": "application/json", "x-forwarded-for": "203.0.113.20" },
    body: JSON.stringify({ email: "not-an-email", role: "member" }),
  });
  assert.equal(createLimited.status, 429);

  const created = await app.request("/api/app/invitations", {
    method: "POST",
    headers: { ...authHeaders(alpha.cookieValue), "content-type": "application/json", "x-forwarded-for": "203.0.113.21" },
    body: JSON.stringify({ email: "beta@packetagent.local", role: "member" }),
  });
  const createdBody = await created.json() as { invitation: { id: string; token: string } };

  for (let index = 0; index < 20; index += 1) {
    const response = await app.request(`/api/app/invitations/${createdBody.invitation.id}/resend`, {
      method: "POST",
      headers: { ...authHeaders(alpha.cookieValue), "x-forwarded-for": "203.0.113.22" },
    });
    assert.equal(response.status, 200);
  }
  const resendLimited = await app.request(`/api/app/invitations/${createdBody.invitation.id}/resend`, {
    method: "POST",
    headers: { ...authHeaders(alpha.cookieValue), "x-forwarded-for": "203.0.113.22" },
  });
  assert.equal(resendLimited.status, 429);

  for (let index = 0; index < 20; index += 1) {
    const response = await app.request("/api/app/invitations/missing-token/accept", {
      method: "POST",
      headers: { ...authHeaders(beta.cookieValue), "x-forwarded-for": "203.0.113.23" },
    });
    assert.equal(response.status, 404);
  }
  const acceptLimited = await app.request("/api/app/invitations/missing-token/accept", {
    method: "POST",
    headers: { ...authHeaders(beta.cookieValue), "x-forwarded-for": "203.0.113.23" },
  });
    assert.equal(acceptLimited.status, 429);
  } finally {
    restoreEnv("PACKETAGENT_TRUST_PROXY", previousTrustProxy);
  }
});

test("invitation rate limit env overrides max attempts and window", async () => {
  const previousMaxAttempts = process.env.PACKETAGENT_INVITATION_RATE_LIMIT_MAX_ATTEMPTS;
  const previousWindowMs = process.env.PACKETAGENT_INVITATION_RATE_LIMIT_WINDOW_MS;
  try {
    process.env.PACKETAGENT_INVITATION_RATE_LIMIT_MAX_ATTEMPTS = "1";
    process.env.PACKETAGENT_INVITATION_RATE_LIMIT_WINDOW_MS = "3456";
    resetStoreForTests();
    resetAppRouteSecurityForTests();
    const app = createTestApp();
    const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
    setAlphaRole("admin");
    const headers = { ...authHeaders(alpha.cookieValue), "content-type": "application/json" };

    const first = await app.request("/api/app/invitations", {
      method: "POST",
      headers,
      body: JSON.stringify({ email: "not-an-email", role: "member" }),
    });
    assert.equal(first.status, 400);
    const bucket = (loadStore().rateLimits ?? []).find((entry) => entry.id.startsWith("invitation:create:"));
    assert.ok(bucket, "expected invitation create rate limit bucket");
    assert.equal(new Date(bucket.resetAt).getTime() - new Date(bucket.updatedAt).getTime(), 3456);

    const limited = await app.request("/api/app/invitations", {
      method: "POST",
      headers,
      body: JSON.stringify({ email: "not-an-email", role: "member" }),
    });
    assert.equal(limited.status, 429);
  } finally {
    restoreEnv("PACKETAGENT_INVITATION_RATE_LIMIT_MAX_ATTEMPTS", previousMaxAttempts);
    restoreEnv("PACKETAGENT_INVITATION_RATE_LIMIT_WINDOW_MS", previousWindowMs);
  }
});

test("invitation rate limit invalid env values fall back to defaults", async () => {
  const previousMaxAttempts = process.env.PACKETAGENT_INVITATION_RATE_LIMIT_MAX_ATTEMPTS;
  const previousWindowMs = process.env.PACKETAGENT_INVITATION_RATE_LIMIT_WINDOW_MS;
  try {
    process.env.PACKETAGENT_INVITATION_RATE_LIMIT_MAX_ATTEMPTS = "-1";
    process.env.PACKETAGENT_INVITATION_RATE_LIMIT_WINDOW_MS = "";
    resetStoreForTests();
    resetAppRouteSecurityForTests();
    const app = createTestApp();
    const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
    setAlphaRole("admin");
    const headers = { ...authHeaders(alpha.cookieValue), "content-type": "application/json" };

    const first = await app.request("/api/app/invitations", {
      method: "POST",
      headers,
      body: JSON.stringify({ email: "not-an-email", role: "member" }),
    });
    assert.equal(first.status, 400);
    const bucket = (loadStore().rateLimits ?? []).find((entry) => entry.id.startsWith("invitation:create:"));
    assert.ok(bucket, "expected invitation create rate limit bucket");
    assert.equal(new Date(bucket.resetAt).getTime() - new Date(bucket.updatedAt).getTime(), 60_000);

    for (let index = 1; index < 20; index += 1) {
      const response = await app.request("/api/app/invitations", {
        method: "POST",
        headers,
        body: JSON.stringify({ email: "not-an-email", role: "member" }),
      });
      assert.equal(response.status, 400);
    }

    const limited = await app.request("/api/app/invitations", {
      method: "POST",
      headers,
      body: JSON.stringify({ email: "not-an-email", role: "member" }),
    });
    assert.equal(limited.status, 429);
  } finally {
    restoreEnv("PACKETAGENT_INVITATION_RATE_LIMIT_MAX_ATTEMPTS", previousMaxAttempts);
    restoreEnv("PACKETAGENT_INVITATION_RATE_LIMIT_WINDOW_MS", previousWindowMs);
  }
});

test("admins can resend invitations by rotating token and expiry", async () => {
  resetStoreForTests();
  resetAppRouteSecurityForTests();
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const beta = login({ email: "beta@packetagent.local", password: "demo12345" });
  setAlphaRole("admin");

  const created = await app.request("/api/app/invitations", {
    method: "POST",
    headers: { ...authHeaders(alpha.cookieValue), "content-type": "application/json" },
    body: JSON.stringify({ email: "beta@packetagent.local", role: "member" }),
  });
  const createdBody = await created.json() as { invitation: { id: string; token: string; expiresAt: string } };

  mutateStore((data) => {
    const invitation = data.workspaceInvitations.find((entry) => entry.id === createdBody.invitation.id);
    assert.ok(invitation, "expected invitation");
    invitation.expiresAt = "2000-01-01T00:00:00.000Z";
  });

  const resent = await app.request(`/api/app/invitations/${createdBody.invitation.id}/resend`, {
    method: "POST",
    headers: authHeaders(alpha.cookieValue),
  });
  const resentBody = await resent.json() as { invitation: { token: string; expiresAt: string; status: string } };

  assert.equal(resent.status, 200);
  assert.notEqual(resentBody.invitation.token, createdBody.invitation.token);
  assert.equal(resentBody.invitation.status, "pending");
  assert.ok(new Date(resentBody.invitation.expiresAt).getTime() > Date.now());

  const oldToken = await app.request(`/api/app/invitations/${createdBody.invitation.token}/accept`, {
    method: "POST",
    headers: authHeaders(beta.cookieValue),
  });
  assert.equal(oldToken.status, 404);

  const accepted = await app.request(`/api/app/invitations/${resentBody.invitation.token}/accept`, {
    method: "POST",
    headers: authHeaders(beta.cookieValue),
  });
  assert.equal(accepted.status, 200);
});

test("invitation create and resend record email deliveries", async () => {
  resetStoreForTests();
  resetAppRouteSecurityForTests();
  resetInvitationEmailDeliveryForTests();
  delete process.env[PACKETAGENT_INVITATION_EMAIL_MODE_ENV];
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  setAlphaRole("admin");

  const created = await app.request("/api/app/invitations", {
    method: "POST",
    headers: { ...authHeaders(alpha.cookieValue), "content-type": "application/json" },
    body: JSON.stringify({ email: "Delivery@Test.Example", role: "member" }),
  });
  const createdBody = await created.json() as { invitation: { id: string; token: string }; emailDelivery: { status: string; action: string } };

  assert.equal(created.status, 201);
  assert.equal(createdBody.emailDelivery.status, "sent");
  assert.equal(createdBody.emailDelivery.action, "create");
  let deliveries = listInvitationEmailDeliveryRecordsForTests();
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].email, "delivery@test.example");
  assert.equal(deliveries[0].token, createdBody.invitation.token);
  assert.equal(deliveries[0].status, "sent");
  assert.equal(listInvitationEmailDeliveriesIndexed("alpha", createdBody.invitation.id).length, 1);

  const resent = await app.request(`/api/app/invitations/${createdBody.invitation.id}/resend`, {
    method: "POST",
    headers: authHeaders(alpha.cookieValue),
  });
  const resentBody = await resent.json() as { invitation: { token: string }; emailDelivery: { status: string; action: string } };

  assert.equal(resent.status, 200);
  assert.equal(resentBody.emailDelivery.status, "sent");
  assert.equal(resentBody.emailDelivery.action, "resend");
  deliveries = listInvitationEmailDeliveryRecordsForTests();
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[1].token, resentBody.invitation.token);
  assert.notEqual(deliveries[1].token, createdBody.invitation.token);
  assert.equal(listInvitationEmailDeliveriesIndexed("alpha", createdBody.invitation.id).length, 2);
});

test("invitation delivery failures are recorded without rolling back invitation state", async () => {
  resetStoreForTests();
  resetAppRouteSecurityForTests();
  resetInvitationEmailDeliveryForTests();
  delete process.env[PACKETAGENT_INVITATION_EMAIL_MODE_ENV];
  setInvitationEmailDeliveryAdapterForTests(() => {
    throw new Error("smtp unavailable");
  });
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  setAlphaRole("admin");

  const created = await app.request("/api/app/invitations", {
    method: "POST",
    headers: { ...authHeaders(alpha.cookieValue), "content-type": "application/json" },
    body: JSON.stringify({ email: "failure@test.example", role: "member" }),
  });
  const createdBody = await created.json() as { invitation: { id: string; status: string }; emailDelivery: { status: string; error: string | null } };

  assert.equal(created.status, 201);
  assert.equal(createdBody.invitation.status, "pending");
  assert.equal(createdBody.emailDelivery.status, "failed");
  assert.equal(createdBody.emailDelivery.error, "smtp unavailable");
  assert.ok(loadStore().workspaceInvitations.some((entry) => entry.id === createdBody.invitation.id && !entry.revokedAt && !entry.acceptedAt));
  assert.equal(listInvitationEmailDeliveryRecordsForTests()[0]?.status, "failed");
  assert.equal(listInvitationEmailDeliveriesIndexed("alpha", createdBody.invitation.id)[0]?.status, "failed");
  assert.ok(loadStore().activities.some((entry) => entry.event === "workspace.invitation_email_delivery" && entry.data.status === "failed"));
});

test("webhook invitation delivery failures enqueue retry jobs without tokens", async () => {
  const previousMode = process.env[PACKETAGENT_INVITATION_EMAIL_MODE_ENV];
  const previousUrl = process.env[PACKETAGENT_INVITATION_EMAIL_WEBHOOK_URL_ENV];
  const previousMaxAttempts = process.env[PACKETAGENT_INVITATION_EMAIL_RETRY_MAX_ATTEMPTS_ENV];
  try {
    process.env[PACKETAGENT_INVITATION_EMAIL_MODE_ENV] = "webhook";
    process.env[PACKETAGENT_INVITATION_EMAIL_WEBHOOK_URL_ENV] = "https://email.example/invitations";
    process.env[PACKETAGENT_INVITATION_EMAIL_RETRY_MAX_ATTEMPTS_ENV] = "2";
    resetStoreForTests();
    resetAppRouteSecurityForTests();
    resetInvitationEmailDeliveryForTests();
    setInvitationEmailFetchForTests(async () => {
      throw new Error("provider unavailable");
    });
    const app = createTestApp();
    const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
    setAlphaRole("admin");

    const created = await app.request("/api/app/invitations", {
      method: "POST",
      headers: { ...authHeaders(alpha.cookieValue), "content-type": "application/json" },
      body: JSON.stringify({ email: "retry@test.example", role: "member" }),
    });
    const createdBody = await created.json() as { invitation: { id: string }; emailDelivery: { status: string; retryJobId: string | null } };

    assert.equal(created.status, 201);
    assert.equal(createdBody.emailDelivery.status, "failed");
    assert.ok(createdBody.emailDelivery.retryJobId, "expected retry job id");
    const job = loadStore().jobs.find((entry) => entry.id === createdBody.emailDelivery.retryJobId);
    assert.ok(job, "expected retry job");
    assert.equal(job.type, INVITATION_EMAIL_JOB_TYPE);
    assert.equal(job.status, "queued");
    assert.equal(job.maxAttempts, 2);
    assert.deepEqual(job.payload, {
      invitationId: createdBody.invitation.id,
      action: "create",
      requestedByUserId: "user_alpha",
    });
    assert.equal(JSON.stringify(job.payload).includes("token"), false);
    assert.equal(JSON.stringify(job.payload).includes("retry@test.example"), false);
    assert.ok(loadStore().activities.some((entry) => entry.data.retryJobId === job.id));
  } finally {
    resetInvitationEmailDeliveryForTests();
    restoreEnv(PACKETAGENT_INVITATION_EMAIL_MODE_ENV, previousMode);
    restoreEnv(PACKETAGENT_INVITATION_EMAIL_WEBHOOK_URL_ENV, previousUrl);
    restoreEnv(PACKETAGENT_INVITATION_EMAIL_RETRY_MAX_ATTEMPTS_ENV, previousMaxAttempts);
  }
});

test("revoked and accepted invitations do not send email on resend failures", async () => {
  resetStoreForTests();
  resetAppRouteSecurityForTests();
  resetInvitationEmailDeliveryForTests();
  delete process.env[PACKETAGENT_INVITATION_EMAIL_MODE_ENV];
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const beta = login({ email: "beta@packetagent.local", password: "demo12345" });
  setAlphaRole("admin");

  const revokedCreate = await app.request("/api/app/invitations", {
    method: "POST",
    headers: { ...authHeaders(alpha.cookieValue), "content-type": "application/json" },
    body: JSON.stringify({ email: "revoked@test.example", role: "member" }),
  });
  const revokedBody = await revokedCreate.json() as { invitation: { id: string } };
  assert.equal(listInvitationEmailDeliveriesIndexed("alpha").length, 1);

  const revoked = await app.request(`/api/app/invitations/${revokedBody.invitation.id}/revoke`, {
    method: "POST",
    headers: authHeaders(alpha.cookieValue),
  });
  assert.equal(revoked.status, 200);
  const revokedResend = await app.request(`/api/app/invitations/${revokedBody.invitation.id}/resend`, {
    method: "POST",
    headers: authHeaders(alpha.cookieValue),
  });
  assert.equal(revokedResend.status, 400);
  assert.deepEqual(await revokedResend.json(), { error: "invitation has been revoked" });
  assert.equal(listInvitationEmailDeliveriesIndexed("alpha").length, 1);

  const acceptedCreate = await app.request("/api/app/invitations", {
    method: "POST",
    headers: { ...authHeaders(alpha.cookieValue), "content-type": "application/json" },
    body: JSON.stringify({ email: "beta@packetagent.local", role: "member" }),
  });
  const acceptedBody = await acceptedCreate.json() as { invitation: { id: string; token: string } };
  assert.equal(listInvitationEmailDeliveriesIndexed("alpha").length, 2);

  const accepted = await app.request(`/api/app/invitations/${acceptedBody.invitation.token}/accept`, {
    method: "POST",
    headers: authHeaders(beta.cookieValue),
  });
  assert.equal(accepted.status, 200);
  const acceptedResend = await app.request(`/api/app/invitations/${acceptedBody.invitation.id}/resend`, {
    method: "POST",
    headers: authHeaders(alpha.cookieValue),
  });
  assert.equal(acceptedResend.status, 400);
  assert.deepEqual(await acceptedResend.json(), { error: "invitation has already been accepted" });
  assert.equal(listInvitationEmailDeliveriesIndexed("alpha").length, 2);
});

test("invitation revoke and resend enforce workspace roles", async () => {
  resetStoreForTests();
  resetAppRouteSecurityForTests();
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  setAlphaRole("admin");

  const created = await app.request("/api/app/invitations", {
    method: "POST",
    headers: { ...authHeaders(alpha.cookieValue), "content-type": "application/json" },
    body: JSON.stringify({ email: "beta@packetagent.local", role: "member" }),
  });
  const createdBody = await created.json() as { invitation: { id: string; token: string } };

  setAlphaRole("member");
  const deniedResend = await app.request(`/api/app/invitations/${createdBody.invitation.id}/resend`, {
    method: "POST",
    headers: authHeaders(alpha.cookieValue),
  });
  assert.equal(deniedResend.status, 403);
  assert.deepEqual(await deniedResend.json(), { error: "workspace role admin is required" });

  setAlphaRole("viewer");
  const deniedRevoke = await app.request(`/api/app/invitations/${createdBody.invitation.id}/revoke`, {
    method: "POST",
    headers: authHeaders(alpha.cookieValue),
  });
  assert.equal(deniedRevoke.status, 403);
  assert.deepEqual(await deniedRevoke.json(), { error: "workspace role admin is required" });

  setAlphaRole("admin");
  const revoked = await app.request(`/api/app/invitations/${createdBody.invitation.id}/revoke`, {
    method: "POST",
    headers: authHeaders(alpha.cookieValue),
  });
  const revokedBody = await revoked.json() as { invitation: { status: string; revokedAt: string | null } };
  assert.equal(revoked.status, 200);
  assert.equal(revokedBody.invitation.status, "revoked");
  assert.ok(revokedBody.invitation.revokedAt);

  const accepted = await app.request(`/api/app/invitations/${createdBody.invitation.token}/accept`, {
    method: "POST",
    headers: authHeaders(login({ email: "beta@packetagent.local", password: "demo12345" }).cookieValue),
  });
  assert.equal(accepted.status, 400);
  assert.deepEqual(await accepted.json(), { error: "invitation has been revoked" });
});

test("member role updates and removals protect owner-only operations", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });

  mutateStore((data) => {
    data.memberships.push({ workspaceId: "alpha", userId: "user_beta", role: "member", joinedAt: new Date().toISOString() });
  });
  setAlphaRole("admin");

  const promotedToOwner = await app.request("/api/app/members/user_beta", {
    method: "PATCH",
    headers: { ...authHeaders(alpha.cookieValue), "content-type": "application/json" },
    body: JSON.stringify({ role: "owner" }),
  });
  assert.equal(promotedToOwner.status, 403);
  assert.deepEqual(await promotedToOwner.json(), { error: "workspace role owner is required" });

  const updated = await app.request("/api/app/members/user_beta", {
    method: "PATCH",
    headers: { ...authHeaders(alpha.cookieValue), "content-type": "application/json" },
    body: JSON.stringify({ role: "viewer" }),
  });
  const updatedBody = await updated.json() as { member: { role: string } };
  assert.equal(updated.status, 200);
  assert.equal(updatedBody.member.role, "viewer");

  setAlphaRole("owner");
  const demoteLastOwner = await app.request("/api/app/members/user_alpha", {
    method: "PATCH",
    headers: { ...authHeaders(alpha.cookieValue), "content-type": "application/json" },
    body: JSON.stringify({ role: "admin" }),
  });
  assert.equal(demoteLastOwner.status, 400);
  assert.deepEqual(await demoteLastOwner.json(), { error: "workspace must keep at least one owner" });

  const removed = await app.request("/api/app/members/user_beta", {
    method: "DELETE",
    headers: authHeaders(alpha.cookieValue),
  });
  assert.equal(removed.status, 200);
  assert.equal(loadStore().memberships.some((entry) => entry.workspaceId === "alpha" && entry.userId === "user_beta"), false);
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
