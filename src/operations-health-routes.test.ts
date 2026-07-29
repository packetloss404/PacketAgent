import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { SESSION_COOKIE_NAME } from "./auth-utils.js";
import { getOperationsHealth, type OperationsHealthReport } from "./operations-health.js";
import { operationsHealthRoutes } from "./operations-health-routes.js";
import { login } from "./packetagent-services.js";
import { mutateStore, resetStoreForTests } from "./packetagent-store.js";

function createApp() {
  const app = new Hono();
  app.route("/api/app/operations/health", operationsHealthRoutes);
  return app;
}

function authHeaders(cookieValue: string) {
  return { Cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` };
}

function findSubsystem(report: OperationsHealthReport, name: string) {
  const subsystem = report.subsystems.find((entry) => entry.name === name);
  assert.ok(subsystem, `expected subsystem ${name} to be present`);
  return subsystem;
}

test("operations health route rejects unauthenticated requests", async () => {
  resetStoreForTests();
  const app = createApp();

  const response = await app.request("/api/app/operations/health");

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "authentication required" });
});

test("operations health route rejects members below admin role", async () => {
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

  const response = await app.request("/api/app/operations/health", {
    headers: authHeaders(auth.cookieValue),
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "workspace role admin is required" });
});

test("operations health route returns the report shape for an admin-equivalent owner", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const app = createApp();

  const response = await app.request("/api/app/operations/health", {
    headers: authHeaders(auth.cookieValue),
  });

  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.ok(typeof body.generatedAt === "string");
  assert.ok(typeof body.overall === "string");
  assert.ok(Array.isArray(body.subsystems));
  const subsystems = body.subsystems as Array<Record<string, unknown>>;
  assert.ok(subsystems.length > 0);
  for (const subsystem of subsystems) {
    assert.ok(typeof subsystem.name === "string");
    assert.ok(typeof subsystem.status === "string");
    assert.ok(typeof subsystem.detail === "string");
    assert.ok(typeof subsystem.checkedAt === "string");
  }
  assert.ok(subsystems.some((subsystem) => subsystem.name === "store"));
  assert.ok(subsystems.some((subsystem) => subsystem.name === "scheduler"));
  assert.ok(subsystems.some((subsystem) => subsystem.name === "accessLog"));
  assert.ok(subsystems.some((subsystem) => subsystem.name === "sandbox"));
});
