import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { SESSION_COOKIE_NAME } from "./auth-utils.js";
import { operationsAlertsRoutes } from "./operations-alerts-routes.js";
import { login } from "./packetagent-services.js";
import { mutateStore, resetStoreForTests } from "./packetagent-store.js";

function createApp() {
  const app = new Hono();
  app.route("/api/app/operations/alerts", operationsAlertsRoutes);
  return app;
}

function authHeaders(cookieValue: string) {
  return { Cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` };
}

interface SeedAlert {
  id: string;
  observedAt: string;
  severity?: "info" | "warning" | "critical";
  ruleId?: string;
  title?: string;
  detail?: string;
  delivered?: boolean;
  context?: Record<string, unknown>;
}

function seedAlerts(alerts: SeedAlert[]): void {
  mutateStore((data) => {
    const target = data as unknown as { alertEvents?: Array<Record<string, unknown>> };
    if (!Array.isArray(target.alertEvents)) {
      target.alertEvents = [];
    }
    for (const alert of alerts) {
      target.alertEvents.push({
        ruleId: "subsystem-degraded",
        severity: "warning",
        title: "Title",
        detail: "Detail",
        delivered: true,
        context: {},
        ...alert,
      });
    }
  });
}

test("operations alerts rejects unauthenticated requests", async () => {
  resetStoreForTests();
  const app = createApp();

  const response = await app.request("/api/app/operations/alerts");

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "authentication required" });
});

test("operations alerts rejects members below admin role", async () => {
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

  const response = await app.request("/api/app/operations/alerts", {
    headers: authHeaders(auth.cookieValue),
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "workspace role admin is required" });
});

test("operations alerts returns empty array when none exist", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const app = createApp();

  const response = await app.request("/api/app/operations/alerts", {
    headers: authHeaders(auth.cookieValue),
  });

  assert.equal(response.status, 200);
  const body = await response.json() as { alerts: unknown[] };
  assert.ok(Array.isArray(body.alerts));
  assert.equal(body.alerts.length, 0);
});

test("operations alerts returns alerts ordered descending by observedAt", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  seedAlerts([
    { id: "a_1", observedAt: "2026-04-19T10:00:00.000Z" },
    { id: "a_2", observedAt: "2026-04-21T10:00:00.000Z" },
    { id: "a_3", observedAt: "2026-04-20T10:00:00.000Z" },
  ]);
  const app = createApp();

  const response = await app.request("/api/app/operations/alerts", {
    headers: authHeaders(auth.cookieValue),
  });

  assert.equal(response.status, 200);
  const body = await response.json() as { alerts: Array<{ id: string; observedAt: string }> };
  assert.equal(body.alerts.length, 3);
  assert.deepEqual(body.alerts.map((entry) => entry.id), ["a_2", "a_3", "a_1"]);
});

test("operations alerts filters by severity", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  seedAlerts([
    { id: "a_warn", severity: "warning", observedAt: "2026-04-19T10:00:00.000Z" },
    { id: "a_crit", severity: "critical", observedAt: "2026-04-20T10:00:00.000Z" },
  ]);
  const app = createApp();

  const response = await app.request("/api/app/operations/alerts?severity=critical", {
    headers: authHeaders(auth.cookieValue),
  });

  assert.equal(response.status, 200);
  const body = await response.json() as { alerts: Array<{ id: string; severity: string }> };
  assert.equal(body.alerts.length, 1);
  assert.equal(body.alerts[0].id, "a_crit");
});

test("operations alerts rejects invalid severity with 400", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const app = createApp();

  const response = await app.request("/api/app/operations/alerts?severity=banana", {
    headers: authHeaders(auth.cookieValue),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid severity" });
});

test("operations alerts rejects invalid since with 400", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const app = createApp();

  const response = await app.request("/api/app/operations/alerts?since=not-a-date", {
    headers: authHeaders(auth.cookieValue),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid since" });
});

test("operations alerts rejects invalid until with 400", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const app = createApp();

  const response = await app.request("/api/app/operations/alerts?until=junk", {
    headers: authHeaders(auth.cookieValue),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid until" });
});

test("operations alerts caps response with limit", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  seedAlerts([
    { id: "a_1", observedAt: "2026-04-18T00:00:00.000Z" },
    { id: "a_2", observedAt: "2026-04-19T00:00:00.000Z" },
    { id: "a_3", observedAt: "2026-04-20T00:00:00.000Z" },
    { id: "a_4", observedAt: "2026-04-21T00:00:00.000Z" },
  ]);
  const app = createApp();

  const response = await app.request("/api/app/operations/alerts?limit=2", {
    headers: authHeaders(auth.cookieValue),
  });

  assert.equal(response.status, 200);
  const body = await response.json() as { alerts: unknown[] };
  assert.equal(body.alerts.length, 2);
});
