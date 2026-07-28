import assert from "node:assert/strict";
import test from "node:test";
import { createSeedStore, type PacketAgentData } from "../../packetagent-store.js";
import { LEGACY_WORKER_EVENT_SCHEMA_VERSION } from "../persistence-types.js";
import {
  makeWorkerCheckpoint,
  makeWorkerDefinition,
  makeWorkerDeployment,
  makeWorkerRun,
  makeWorkerVersion,
} from "../__tests__/fixtures.js";
import { createWorkerOperationsReadModel } from "./read-model.js";

const SECRET = "read-model-secret-value";

test("Worker run pages are stable, filter-bound, and workspace-scoped", async () => {
  const data = operationsData();
  const readModel = createWorkerOperationsReadModel({ loadStore: () => data });

  const first = await readModel.listRuns("alpha", { limit: 2 });
  assert.deepEqual(
    first.runs.map((run) => run.id),
    ["run-3", "run-2"],
  );
  assert.equal(first.page.hasMore, true);
  assert.ok(first.page.nextCursor);

  const second = await readModel.listRuns("alpha", {
    limit: 2,
    cursor: first.page.nextCursor,
  });
  assert.deepEqual(
    second.runs.map((run) => run.id),
    ["run-1"],
  );
  assert.equal(second.page.hasMore, false);

  await assert.rejects(
    readModel.listRuns("alpha", {
      status: "running",
      limit: 2,
      cursor: first.page.nextCursor,
    }),
    /cursor is invalid for this workspace and filter set/i,
  );
  await assert.rejects(
    readModel.listRuns("bravo", {
      limit: 2,
      cursor: first.page.nextCursor,
    }),
    /cursor is invalid for this workspace and filter set/i,
  );

  const otherWorkspace = await readModel.listRuns("bravo");
  assert.deepEqual(
    otherWorkspace.runs.map((run) => run.id),
    ["run-bravo"],
  );
});

test("Worker detail answers identity, budget, checkpoint, attention, and evidence from one read", async () => {
  const data = operationsData();
  const run = data.workerRuns.find((record) => record.id === "run-3")!;
  data.workerRuns[data.workerRuns.indexOf(run)] = {
    ...run,
    status: "running",
    revision: 3,
    latestCheckpointId: "checkpoint-3",
    budgetUsage: {
      elapsedMs: 10_000,
      iterations: 2,
      providerCostUsd: 0.125,
      consecutiveFailures: 0,
      toolCalls: 3,
    },
    startedAt: "2026-07-27T12:03:00.000Z",
    updatedAt: "2026-07-27T12:04:00.000Z",
  };
  data.workerCheckpoints.push(
    makeWorkerCheckpoint({
      id: "checkpoint-3",
      workspaceId: "alpha",
      workerRunId: "run-3",
      workerVersionId: "version-alpha",
      sequence: 2,
      cursor: { phase: "evaluate", iteration: 2, actionIndex: 1 },
      workingMemory: { private: SECRET },
      createdAt: "2026-07-27T12:04:00.000Z",
    }),
  );
  data.workerEvents.push({
    schemaVersion: LEGACY_WORKER_EVENT_SCHEMA_VERSION,
    id: "event-alpha-secret",
    workspaceId: "alpha",
    sequence: 1,
    type: "worker.phase.completed",
    workerDefinitionId: "definition-alpha",
    workerVersionId: "version-alpha",
    workerDeploymentId: "deployment-alpha",
    actor: { type: "system", id: "packetagent.read-model-test" },
    summary: `Completed observation for ${SECRET}.`,
    data: { workerRunId: "run-3", message: SECRET },
    occurredAt: "2026-07-27T12:04:00.000Z",
  });

  let reads = 0;
  const readModel = createWorkerOperationsReadModel({
    loadStore: () => {
      reads += 1;
      return data;
    },
    knownSecretValues: () => [SECRET],
  });
  const detail = await readModel.getRun("alpha", "run-3");

  assert.equal(reads, 1);
  assert.equal(detail.run.definition.name, "Worker alpha");
  assert.equal(detail.run.version.version, 1);
  assert.equal(detail.run.deployment.id, "deployment-alpha");
  assert.equal(detail.run.budget.usage.iterations, 2);
  assert.equal(detail.run.latestCheckpoint?.cursor.phase, "evaluate");
  assert.equal(detail.run.controls.canPause, true);
  assert.equal(detail.events.items.length, 1);
  assert.doesNotMatch(JSON.stringify(detail), new RegExp(SECRET));
  assert.match(detail.events.items[0]!.summary, /\[redacted\]/i);
});

test("Worker health is derived from the same rollups and never crosses workspaces", async () => {
  const data = operationsData();
  const run = data.workerRuns.find((record) => record.id === "run-2")!;
  data.workerRuns[data.workerRuns.indexOf(run)] = {
    ...run,
    status: "waiting_for_approval",
    revision: 2,
    startedAt: run.createdAt,
    updatedAt: "2026-07-27T12:04:00.000Z",
  };
  const readModel = createWorkerOperationsReadModel({ loadStore: () => data });

  const alpha = await readModel.health("alpha");
  const bravo = await readModel.health("bravo");

  assert.equal(alpha.state, "attention");
  assert.equal(alpha.totals.runs, 3);
  assert.equal(alpha.totals.activeRuns, 3);
  assert.equal(alpha.runStatusCounts.waiting_for_approval, 1);
  assert.equal(bravo.totals.runs, 1);
  assert.equal(bravo.computedThroughSequence, 0);
});

function operationsData(): PacketAgentData {
  const data = createSeedStore();
  addWorkerScope(data, "alpha", ["run-1", "run-2", "run-3"]);
  addWorkerScope(data, "bravo", ["run-bravo"]);
  return data;
}

function addWorkerScope(
  data: PacketAgentData,
  workspaceId: string,
  runIds: readonly string[],
): void {
  const definitionId = `definition-${workspaceId}`;
  const versionId = `version-${workspaceId}`;
  const deploymentId = `deployment-${workspaceId}`;
  data.workerDefinitions.push(
    makeWorkerDefinition({
      id: definitionId,
      workspaceId,
      name: `Worker ${workspaceId}`,
    }),
  );
  data.workerVersions.push(
    makeWorkerVersion({
      id: versionId,
      workspaceId,
      workerDefinitionId: definitionId,
    }),
  );
  data.workerDeployments.push(
    makeWorkerDeployment({
      id: deploymentId,
      workspaceId,
      workerDefinitionId: definitionId,
      workerVersionId: versionId,
    }),
  );
  runIds.forEach((id, index) => {
    const minute = String(index + 1).padStart(2, "0");
    data.workerRuns.push(
      makeWorkerRun({
        id,
        workspaceId,
        workerDefinitionId: definitionId,
        workerVersionId: versionId,
        workerDeploymentId: deploymentId,
        createdAt: `2026-07-27T12:${minute}:00.000Z`,
        updatedAt: `2026-07-27T12:${minute}:00.000Z`,
      }),
    );
  });
}
