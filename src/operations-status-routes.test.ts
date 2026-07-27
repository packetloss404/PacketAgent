import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { SESSION_COOKIE_NAME } from "./auth-utils.js";
import { operationsStatusRoutes } from "./operations-status-routes.js";
import { login } from "./packetagent-services.js";
import { mutateStore, resetStoreForTests } from "./packetagent-store.js";

function createApp() {
  const app = new Hono();
  app.route("/api/app/operations/status", operationsStatusRoutes);
  return app;
}

function authHeaders(cookieValue: string) {
  return { Cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` };
}

test("operations status route rejects unauthenticated requests", async () => {
  resetStoreForTests();
  const app = createApp();

  const response = await app.request("/api/app/operations/status");

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "authentication required" });
});

test("operations status route rejects members below admin role", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  mutateStore((data) => {
    const membership = data.memberships.find(
      (entry) => entry.workspaceId === "alpha" && entry.userId === "user_alpha",
    );
    assert.ok(membership);
    membership.role = "member";
  });
  const app = createApp();

  const response = await app.request("/api/app/operations/status", {
    headers: authHeaders(auth.cookieValue),
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "workspace role admin is required" });
});

test("operations status route returns the report shape for an admin-equivalent owner", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const app = createApp();

  const response = await app.request("/api/app/operations/status", {
    headers: authHeaders(auth.cookieValue),
  });

  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.ok(typeof body.generatedAt === "string");
  assert.ok(body.store && typeof body.store === "object");
  assert.ok(body.scheduler && typeof body.scheduler === "object");
  assert.ok(Array.isArray(body.jobs));
  assert.ok(Array.isArray(body.jobMetrics));
  assert.ok(body.jobMetricsSnapshots && typeof body.jobMetricsSnapshots === "object");
  const snapshots = body.jobMetricsSnapshots as Record<string, unknown>;
  assert.ok("total" in snapshots);
  assert.ok("lastCapturedAt" in snapshots);
  assert.equal(typeof snapshots.total, "number");
  assert.ok(snapshots.lastCapturedAt === null || typeof snapshots.lastCapturedAt === "string");
  assert.ok(body.accessLog && typeof body.accessLog === "object");
  assert.ok(body.runtime && typeof body.runtime === "object");
  const runtime = body.runtime as { nodeVersion?: unknown };
  assert.equal(runtime.nodeVersion, process.versions.node);
});

