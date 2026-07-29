import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { createHealthRoutes, healthRoutes } from "./health-routes.js";

function mountDefault(): Hono {
  const app = new Hono();
  app.route("/api/health", healthRoutes);
  return app;
}

function mountWith(loadStore: () => unknown): Hono {
  const app = new Hono();
  app.route("/api/health", createHealthRoutes({ loadStore }));
  return app;
}

test("GET /api/health/live returns 200 with status: live", async () => {
  const app = mountDefault();
  const res = await app.request("/api/health/live");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { status: "live" });
});

test("GET /api/health/ready returns 200 with status: ready when the real store loads", async () => {
  const app = mountDefault();
  const res = await app.request("/api/health/ready");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { status: "ready" });
});

test("GET /api/health/ready returns 503 with status: not_ready when loadStore throws", async () => {
  const app = mountWith(() => {
    throw new Error("simulated store failure");
  });
  const res = await app.request("/api/health/ready");
  assert.equal(res.status, 503);
  const body = (await res.json()) as { status: string; error: string };
  assert.equal(body.status, "not_ready");
  assert.equal(typeof body.error, "string");
  assert.ok(body.error.length > 0);
  assert.ok(body.error.includes("simulated store failure"));
});

test("GET /api/health/ready returns 503 when loadStore returns a non-object value", async () => {
  const app = mountWith(() => null);
  const res = await app.request("/api/health/ready");
  assert.equal(res.status, 503);
  const body = (await res.json()) as { status: string; error: string };
  assert.equal(body.status, "not_ready");
  assert.ok(body.error.includes("unexpected shape"));
});

test("GET /api/health/ready redacts secrets in the error message", async () => {
  const app = mountWith(() => {
    throw new Error("connection failed token=super-secret-value end");
  });
  const res = await app.request("/api/health/ready");
  assert.equal(res.status, 503);
  const body = (await res.json()) as { status: string; error: string };
  assert.equal(body.status, "not_ready");
  assert.equal(body.error.includes("super-secret-value"), false);
  assert.ok(body.error.includes("[redacted]"));
});
