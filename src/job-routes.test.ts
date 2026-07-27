import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { SESSION_COOKIE_NAME } from "./auth-utils";
import { appRoutes } from "./app-routes";
import { jobRoutes } from "./job-routes";
import { enqueueJob, findJob } from "./jobs/store";
import { enforcePrivateAppMutationSecurity } from "./route-security";
import { login } from "./packetagent-services";
import { mutateStore, resetStoreForTests } from "./packetagent-store";

function createTestApp() {
  const app = new Hono();
  app.use("/api/app/*", enforcePrivateAppMutationSecurity);
  app.route("/api", appRoutes);
  app.route("/api/app/jobs", jobRoutes);
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

test("job mutations use central browser csrf and same-origin guard", async () => {
  resetStoreForTests();
  const app = createTestApp();

  const loginResponse = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "alpha@packetagent.local", password: "demo12345" }),
  });
  const sessionCookie = cookieValue(loginResponse);
  const csrfToken = csrfCookieValue(loginResponse);

  const crossOrigin = await app.request("/api/app/jobs", {
    method: "POST",
    headers: {
      ...browserAuthHeaders(sessionCookie, csrfToken),
      Origin: "https://evil.example",
      "content-type": "application/json",
    },
    body: JSON.stringify({ type: "test.cross-origin" }),
  });
  assert.equal(crossOrigin.status, 403);
  assert.deepEqual(await crossOrigin.json(), { error: "cross-origin requests are not allowed" });

  const missingCsrf = await app.request("/api/app/jobs", {
    method: "POST",
    headers: {
      ...authHeaders(sessionCookie),
      Origin: "http://localhost",
      Host: "localhost",
      "content-type": "application/json",
    },
    body: JSON.stringify({ type: "test.missing-csrf" }),
  });
  assert.equal(missingCsrf.status, 403);
  assert.deepEqual(await missingCsrf.json(), { error: "invalid csrf token" });

  const invalidCsrf = await app.request("/api/app/jobs", {
    method: "POST",
    headers: {
      Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}; packetagent_csrf=invalid`,
      Origin: "http://localhost",
      Host: "localhost",
      "X-CSRF-Token": "invalid",
      "content-type": "application/json",
    },
    body: JSON.stringify({ type: "test.invalid-csrf" }),
  });
  assert.equal(invalidCsrf.status, 403);
  assert.deepEqual(await invalidCsrf.json(), { error: "invalid csrf token" });

  const sameOrigin = await app.request("/api/app/jobs", {
    method: "POST",
    headers: { ...browserAuthHeaders(sessionCookie, csrfToken), "content-type": "application/json" },
    body: JSON.stringify({ type: "test.same-origin" }),
  });
  assert.equal(sameOrigin.status, 201);

  const apiClientCompatible = await app.request("/api/app/jobs", {
    method: "POST",
    headers: { ...authHeaders(sessionCookie), "content-type": "application/json" },
    body: JSON.stringify({ type: "test.api-client" }),
  });
  assert.equal(apiClientCompatible.status, 201);
});

test("job mutation origin checks only trust forwarded host when proxy trust is enabled", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const previousTrustProxy = process.env.PACKETAGENT_TRUST_PROXY;

  try {
    const loginResponse = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alpha@packetagent.local", password: "demo12345" }),
    });
    const sessionCookie = cookieValue(loginResponse);

    delete process.env.PACKETAGENT_TRUST_PROXY;
    const spoofedForwardedHost = await app.request("/api/app/jobs", {
      method: "POST",
      headers: {
        ...authHeaders(sessionCookie),
        Origin: "https://public.example",
        Host: "internal.example",
        "X-Forwarded-Host": "public.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "test.forwarded-host-disabled" }),
    });
    assert.equal(spoofedForwardedHost.status, 403);
    assert.deepEqual(await spoofedForwardedHost.json(), { error: "cross-origin requests are not allowed" });

    process.env.PACKETAGENT_TRUST_PROXY = "true";
    const trustedForwardedHost = await app.request("/api/app/jobs", {
      method: "POST",
      headers: {
        ...authHeaders(sessionCookie),
        Origin: "https://public.example",
        Host: "internal.example",
        "X-Forwarded-Host": "public.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "test.forwarded-host-enabled" }),
    });
    assert.equal(trustedForwardedHost.status, 403);
    assert.deepEqual(await trustedForwardedHost.json(), { error: "invalid csrf token" });
  } finally {
    if (previousTrustProxy === undefined) delete process.env.PACKETAGENT_TRUST_PROXY;
    else process.env.PACKETAGENT_TRUST_PROXY = previousTrustProxy;
  }
});

test("job detail does not expose jobs from another workspace", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const betaJob = enqueueJob({ workspaceId: "beta", type: "test.cross-workspace" });

  const response = await app.request(`/api/app/jobs/${betaJob.id}`, {
    headers: authHeaders(alpha.cookieValue),
  });
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.deepEqual(body, { error: "not found" });
});

test("job cancel does not cancel jobs from another workspace", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const betaJob = enqueueJob({ workspaceId: "beta", type: "test.cross-workspace" });

  const response = await app.request(`/api/app/jobs/${betaJob.id}/cancel`, {
    method: "POST",
    headers: authHeaders(alpha.cookieValue),
  });
  const body = await response.json();
  const fresh = findJob(betaJob.id);

  assert.equal(response.status, 404);
  assert.deepEqual(body, { error: "not found" });
  assert.equal(fresh?.status, "queued");
  assert.equal(fresh?.cancelRequested, undefined);
});

test("job creation rejects invalid scheduling fields", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const cases = [
    [{ type: "test.invalid", scheduledAt: "not-a-date" }, "scheduledAt must be a valid date"],
    [{ type: "test.invalid", cron: "not cron" }, "cron must be a valid 5-field expression"],
    [{ type: "test.invalid", maxAttempts: 0 }, "maxAttempts must be a positive integer"],
  ] as const;

  for (const [payload, message] of cases) {
    const response = await app.request("/api/app/jobs", {
      method: "POST",
      headers: { ...authHeaders(alpha.cookieValue), "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: message });
  }
});

test("job list filters to the authenticated workspace with status and limit", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  enqueueJob({ workspaceId: "alpha", type: "test.oldest" });
  enqueueJob({ workspaceId: "beta", type: "test.beta" });
  const newestAlpha = enqueueJob({ workspaceId: "alpha", type: "test.newest" });

  const response = await app.request("/api/app/jobs?status=queued&limit=1", {
    headers: authHeaders(alpha.cookieValue),
  });
  const body = await response.json() as { jobs: { id: string; workspaceId: string; status: string; type: string }[] };

  assert.equal(response.status, 200);
  assert.deepEqual(body.jobs.map((job) => job.id), [newestAlpha.id]);
  assert.equal(body.jobs[0]?.workspaceId, "alpha");
  assert.equal(body.jobs[0]?.status, "queued");
});

test("job route responses redact sensitive payloads, results, and errors", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const secret = "whk_job_route_secret";
  const job = enqueueJob({
    workspaceId: "alpha",
    type: "test.redaction",
    payload: {
      webhookToken: secret,
      callbackUrl: `https://packetagent.local/api/public/webhooks/agents/${secret}`,
      nested: { authorization: "Bearer provider-secret-1234" },
    },
  });
  mutateStore((data) => {
    const stored = data.jobs.find((entry) => entry.id === job.id);
    assert.ok(stored);
    stored.result = { shareUrl: "https://packetagent.local/share/share-secret-1234" };
    stored.error = `failed token=${secret} Authorization=provider-secret-1234`;
  });

  const detailResponse = await app.request(`/api/app/jobs/${job.id}`, {
    headers: authHeaders(alpha.cookieValue),
  });
  const detailBody = await detailResponse.json();
  const serialized = JSON.stringify(detailBody);

  assert.equal(detailResponse.status, 200);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("provider-secret-1234"), false);
  assert.equal(serialized.includes("share-secret-1234"), false);
  assert.equal(serialized.includes("[redacted]"), true);
});

test("job management requires an admin role but job reads allow viewers", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const alphaJob = enqueueJob({ workspaceId: "alpha", type: "test.viewer" });
  mutateStore((data) => {
    const membership = data.memberships.find((entry) => entry.workspaceId === "alpha" && entry.userId === "user_alpha");
    assert.ok(membership);
    membership.role = "viewer";
  });

  const listResponse = await app.request("/api/app/jobs", {
    headers: authHeaders(alpha.cookieValue),
  });
  const detailResponse = await app.request(`/api/app/jobs/${alphaJob.id}`, {
    headers: authHeaders(alpha.cookieValue),
  });
  const createResponse = await app.request("/api/app/jobs", {
    method: "POST",
    headers: { ...authHeaders(alpha.cookieValue), "content-type": "application/json" },
    body: JSON.stringify({ type: "test.denied" }),
  });
  const cancelResponse = await app.request(`/api/app/jobs/${alphaJob.id}/cancel`, {
    method: "POST",
    headers: authHeaders(alpha.cookieValue),
  });

  assert.equal(listResponse.status, 200);
  assert.equal(detailResponse.status, 200);
  assert.equal(createResponse.status, 403);
  assert.deepEqual(await createResponse.json(), { error: "workspace role admin is required" });
  assert.equal(cancelResponse.status, 403);
  assert.deepEqual(await cancelResponse.json(), { error: "workspace role admin is required" });
});

test("job creation stores optional scheduling fields in the authenticated workspace", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });

  const response = await app.request("/api/app/jobs", {
    method: "POST",
    headers: { ...authHeaders(alpha.cookieValue), "content-type": "application/json" },
    body: JSON.stringify({
      type: "test.scheduled",
      payload: { source: "route-test" },
      scheduledAt: "2026-01-01T00:00:00.000Z",
      cron: "0 9 * * 1",
      maxAttempts: 5,
    }),
  });
  const body = await response.json() as { job: { workspaceId: string; type: string; payload: unknown; scheduledAt: string; cron: string; maxAttempts: number } };

  assert.equal(response.status, 201);
  assert.equal(body.job.workspaceId, "alpha");
  assert.equal(body.job.type, "test.scheduled");
  assert.deepEqual(body.job.payload, { source: "route-test" });
  assert.equal(body.job.scheduledAt, "2026-01-01T00:00:00.000Z");
  assert.equal(body.job.cron, "0 9 * * 1");
  assert.equal(body.job.maxAttempts, 5);
});

test("job creation rejects agent runs outside the authenticated workspace", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });

  const response = await app.request("/api/app/jobs", {
    method: "POST",
    headers: { ...authHeaders(alpha.cookieValue), "content-type": "application/json" },
    body: JSON.stringify({
      type: "agent.run",
      payload: { agentId: "agent_beta_dependency_watch", triggerKind: "schedule" },
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.deepEqual(body, { error: "agent.run payload.agentId must reference an agent in this workspace" });
});
