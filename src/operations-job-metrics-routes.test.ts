import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { SESSION_COOKIE_NAME } from "./auth-utils.js";
import { operationsJobMetricsRoutes } from "./operations-job-metrics-routes.js";
import { login } from "./packetagent-services.js";
import { mutateStore, resetStoreForTests } from "./packetagent-store.js";

function createApp() {
  const app = new Hono();
  app.route("/api/app/operations/job-metrics", operationsJobMetricsRoutes);
  return app;
}

function authHeaders(cookieValue: string) {
  return { Cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` };
}

interface SeedSnapshot {
  id: string;
  capturedAt: string;
  type: string;
  totalRuns?: number;
  succeededRuns?: number;
  failedRuns?: number;
  canceledRuns?: number;
  lastRunStartedAt?: string | null;
  lastRunFinishedAt?: string | null;
  lastDurationMs?: number | null;
  averageDurationMs?: number | null;
  p95DurationMs?: number | null;
}

function seedSnapshots(snapshots: SeedSnapshot[]): void {
  mutateStore((data) => {
    const target = data as unknown as { jobMetricSnapshots?: SeedSnapshot[] };
    if (!Array.isArray(target.jobMetricSnapshots)) {
      target.jobMetricSnapshots = [];
    }
    for (const snapshot of snapshots) {
      target.jobMetricSnapshots.push({
        totalRuns: 0,
        succeededRuns: 0,
        failedRuns: 0,
        canceledRuns: 0,
        lastRunStartedAt: null,
        lastRunFinishedAt: null,
        lastDurationMs: null,
        averageDurationMs: null,
        p95DurationMs: null,
        ...snapshot,
      });
    }
  });
}

test("operations job-metrics history rejects unauthenticated requests", async () => {
  resetStoreForTests();
  const app = createApp();

  const response = await app.request("/api/app/operations/job-metrics/history");

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "authentication required" });
});

test("operations job-metrics history rejects members below admin role", async () => {
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

  const response = await app.request("/api/app/operations/job-metrics/history", {
    headers: authHeaders(auth.cookieValue),
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "workspace role admin is required" });
});

test("operations job-metrics history returns empty snapshots array when none exist", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const app = createApp();

  const response = await app.request("/api/app/operations/job-metrics/history", {
    headers: authHeaders(auth.cookieValue),
  });

  assert.equal(response.status, 200);
  const body = await response.json() as { snapshots: unknown[] };
  assert.ok(Array.isArray(body.snapshots));
  assert.equal(body.snapshots.length, 0);
});

test("operations job-metrics history returns snapshots ordered ascending by capturedAt", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  seedSnapshots([
    { id: "snap_2", capturedAt: "2026-04-20T10:00:00.000Z", type: "agent.run" },
    { id: "snap_1", capturedAt: "2026-04-19T10:00:00.000Z", type: "agent.run" },
    { id: "snap_3", capturedAt: "2026-04-21T10:00:00.000Z", type: "agent.run" },
  ]);
  const app = createApp();

  const response = await app.request("/api/app/operations/job-metrics/history", {
    headers: authHeaders(auth.cookieValue),
  });

  assert.equal(response.status, 200);
  const body = await response.json() as { snapshots: Array<{ id: string; capturedAt: string }> };
  assert.equal(body.snapshots.length, 3);
  const ordered = body.snapshots.map((entry) => entry.capturedAt);
  const sorted = [...ordered].sort();
  assert.deepEqual(ordered, sorted);
});

test("operations job-metrics history filters by type", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  seedSnapshots([
    { id: "snap_a", capturedAt: "2026-04-19T10:00:00.000Z", type: "agent.run" },
    { id: "snap_b", capturedAt: "2026-04-20T10:00:00.000Z", type: "foo" },
    { id: "snap_c", capturedAt: "2026-04-21T10:00:00.000Z", type: "foo" },
  ]);
  const app = createApp();

  const response = await app.request("/api/app/operations/job-metrics/history?type=foo", {
    headers: authHeaders(auth.cookieValue),
  });

  assert.equal(response.status, 200);
  const body = await response.json() as { snapshots: Array<{ id: string; type: string }> };
  assert.equal(body.snapshots.length, 2);
  for (const entry of body.snapshots) {
    assert.equal(entry.type, "foo");
  }
});

test("operations job-metrics history filters by since timestamp", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  seedSnapshots([
    { id: "snap_old", capturedAt: "2026-04-10T00:00:00.000Z", type: "agent.run" },
    { id: "snap_mid", capturedAt: "2026-04-20T00:00:00.000Z", type: "agent.run" },
    { id: "snap_new", capturedAt: "2026-04-25T00:00:00.000Z", type: "agent.run" },
  ]);
  const app = createApp();

  const response = await app.request(
    "/api/app/operations/job-metrics/history?since=2026-04-20T00:00:00.000Z",
    { headers: authHeaders(auth.cookieValue) },
  );

  assert.equal(response.status, 200);
  const body = await response.json() as { snapshots: Array<{ id: string; capturedAt: string }> };
  for (const entry of body.snapshots) {
    assert.ok(Date.parse(entry.capturedAt) >= Date.parse("2026-04-20T00:00:00.000Z"));
  }
  const ids = body.snapshots.map((entry) => entry.id);
  assert.ok(!ids.includes("snap_old"));
});

test("operations job-metrics history caps response with limit", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  seedSnapshots([
    { id: "snap_1", capturedAt: "2026-04-18T00:00:00.000Z", type: "agent.run" },
    { id: "snap_2", capturedAt: "2026-04-19T00:00:00.000Z", type: "agent.run" },
    { id: "snap_3", capturedAt: "2026-04-20T00:00:00.000Z", type: "agent.run" },
    { id: "snap_4", capturedAt: "2026-04-21T00:00:00.000Z", type: "agent.run" },
  ]);
  const app = createApp();

  const response = await app.request("/api/app/operations/job-metrics/history?limit=2", {
    headers: authHeaders(auth.cookieValue),
  });

  assert.equal(response.status, 200);
  const body = await response.json() as { snapshots: unknown[] };
  assert.equal(body.snapshots.length, 2);
});

test("operations job-metrics history rejects invalid since with 400", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const app = createApp();

  const response = await app.request(
    "/api/app/operations/job-metrics/history?since=not-a-date",
    { headers: authHeaders(auth.cookieValue) },
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid since" });
});
