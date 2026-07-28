import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "hono";
import { createSeedStore, type PacketAgentData } from "./packetagent-store.js";
import {
  createWorkerObservabilityRoutes,
  type WorkerObservabilityRoutesDependencies,
} from "./worker-observability-routes.js";
import type {
  AuthorizedWorkerOperatorContext,
  WorkerOperatorPermission,
} from "./worker-operator-routes.js";
import {
  makeWorkerDefinition,
  makeWorkerDeployment,
  makeWorkerRun,
  makeWorkerVersion,
} from "./workers/__tests__/fixtures.js";
import { LEGACY_WORKER_EVENT_SCHEMA_VERSION } from "./workers/persistence-types.js";
import { createWorkerOperationsReadModel } from "./workers/observability/read-model.js";

test("Worker observability routes enforce inspect permission and stable filters", async () => {
  const harness = routeHarness();
  const response = await harness.routes.request("/runs?status=running&limit=1");
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    runs: Array<{ id: string; definition: { name: string } }>;
    page: { hasMore: boolean };
  };
  assert.deepEqual(body.runs, []);
  assert.equal(body.page.hasMore, false);
  assert.deepEqual(harness.permissions, ["inspect"]);

  const invalid = await harness.routes.request("/runs?status=unknown");
  assert.equal(invalid.status, 400);
  assert.equal(harness.permissions.at(-1), "inspect");
});

test("Worker event SSE resumes after Last-Event-ID and closes at a bounded deadline", async () => {
  const harness = routeHarness({
    now: incrementingClock(),
    wait: () => undefined,
    streamDurationMs: 4,
    streamPollIntervalMs: 1,
    streamEventLimit: 10,
  });
  const response = await harness.routes.request("/events/stream?workerRunId=run-1", {
    headers: { "Last-Event-ID": "1" },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const body = await response.text();

  assert.doesNotMatch(body, /id: 1(?:\r?\n)/);
  assert.match(body, /id: 2(?:\r?\n)/);
  assert.match(body, /event: worker\.event/);
  assert.match(body, /event: worker\.stream\.closed/);
  assert.match(body, /"afterSequence":2/);
});

test("Worker event cursors cannot be reused across route workspaces", async () => {
  const harness = routeHarness();
  const first = await harness.routes.request("/events?limit=1");
  const cursor = ((await first.json()) as { page: { nextCursor?: string } }).page.nextCursor;
  assert.ok(cursor);

  harness.workspaceId = "workspace-2";
  const crossed = await harness.routes.request(`/events?limit=1&cursor=${cursor}`);
  assert.equal(crossed.status, 400);
  assert.match(JSON.stringify(await crossed.json()), /cursor is invalid/i);
});

test("health, detail, evidence, and artifact routes return server-side read models", async () => {
  const harness = routeHarness();
  const healthResponse = await harness.routes.request("/health");
  const detailResponse = await harness.routes.request("/runs/run-1/detail");
  const evidenceResponse = await harness.routes.request("/evidence?workerRunId=run-1");
  const artifactResponse = await harness.routes.request("/artifacts?workerRunId=run-1");

  assert.equal(healthResponse.status, 200);
  assert.equal(detailResponse.status, 200);
  assert.equal(evidenceResponse.status, 200);
  assert.equal(artifactResponse.status, 200);
  const health = (await healthResponse.json()) as {
    health: { schemaVersion: string; totals: { runs: number } };
  };
  const detail = (await detailResponse.json()) as {
    detail: { run: { id: string; definition: { name: string } } };
  };
  const evidence = (await evidenceResponse.json()) as {
    evidence: unknown[];
    page: { hasMore: boolean };
  };
  const artifacts = (await artifactResponse.json()) as {
    artifacts: unknown[];
    page: { hasMore: boolean };
  };
  assert.deepEqual(
    {
      schemaVersion: health.health.schemaVersion,
      runs: health.health.totals.runs,
      runId: detail.detail.run.id,
      name: detail.detail.run.definition.name,
      evidence: evidence.evidence.length,
      evidenceHasMore: evidence.page.hasMore,
      artifacts: artifacts.artifacts.length,
      artifactsHaveMore: artifacts.page.hasMore,
    },
    {
      schemaVersion: "packetagent.worker-operations-read-model/v1",
      runs: 1,
      runId: "run-1",
      name: "Release watcher",
      evidence: 0,
      evidenceHasMore: false,
      artifacts: 0,
      artifactsHaveMore: false,
    },
  );
  assert.deepEqual(harness.permissions, ["inspect", "inspect", "inspect", "inspect"]);
});

interface RouteHarness {
  readonly routes: ReturnType<typeof createWorkerObservabilityRoutes>;
  readonly permissions: WorkerOperatorPermission[];
  workspaceId: string;
}

function routeHarness(
  overrides: Pick<
    WorkerObservabilityRoutesDependencies,
    "now" | "wait" | "streamDurationMs" | "streamPollIntervalMs" | "streamEventLimit"
  > = {},
): RouteHarness {
  const data = routeData();
  const permissions: WorkerOperatorPermission[] = [];
  const harness = {
    workspaceId: "workspace-1",
    permissions,
  };
  const authorize = async (
    _context: Context,
    permission: WorkerOperatorPermission,
  ): Promise<AuthorizedWorkerOperatorContext> => {
    permissions.push(permission);
    return {
      workspaceId: harness.workspaceId,
      actor: { type: "user", id: "operator-1" },
    };
  };
  return Object.assign(harness, {
    routes: createWorkerObservabilityRoutes({
      readModel: createWorkerOperationsReadModel({ loadStore: () => data }),
      authorize,
      ...overrides,
    }),
  });
}

function routeData(): PacketAgentData {
  const data = createSeedStore();
  data.workerDefinitions.push(makeWorkerDefinition());
  data.workerVersions.push(makeWorkerVersion());
  data.workerDeployments.push(makeWorkerDeployment());
  data.workerRuns.push(makeWorkerRun());
  data.workerEvents.push(
    {
      schemaVersion: LEGACY_WORKER_EVENT_SCHEMA_VERSION,
      id: "event-1",
      workspaceId: "workspace-1",
      sequence: 1,
      type: "worker.run.queued",
      workerDefinitionId: "worker-1",
      workerVersionId: "worker-version-1",
      workerDeploymentId: "deployment-1",
      actor: { type: "system", id: "packetagent.route-test" },
      summary: "Worker run queued.",
      data: { workerRunId: "run-1" },
      occurredAt: "2026-07-27T12:00:00.000Z",
    },
    {
      schemaVersion: LEGACY_WORKER_EVENT_SCHEMA_VERSION,
      id: "event-2",
      workspaceId: "workspace-1",
      sequence: 2,
      type: "worker.run.started",
      workerDefinitionId: "worker-1",
      workerVersionId: "worker-version-1",
      workerDeploymentId: "deployment-1",
      actor: { type: "system", id: "packetagent.route-test" },
      summary: "Worker run started.",
      data: { workerRunId: "run-1" },
      occurredAt: "2026-07-27T12:01:00.000Z",
    },
  );
  return data;
}

function incrementingClock(): () => number {
  let value = 0;
  return () => value++;
}
