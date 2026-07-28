import assert from "node:assert/strict";
import test from "node:test";
import { createSeedStore, normalizeStore, type PacketAgentData } from "../../packetagent-store.js";
import { WorkerLifecycleError } from "../errors.js";
import { validateWorkerPersistence } from "../repository.js";
import { makeWorkerDefinition, makeWorkerDeployment, makeWorkerVersion } from "./fixtures.js";

test("legacy stores normalize with every Worker persistence collection", () => {
  const normalized = normalizeStore({});

  assert.deepEqual(normalized.workerDefinitions, []);
  assert.deepEqual(normalized.workerVersions, []);
  assert.deepEqual(normalized.workerDeployments, []);
  assert.deepEqual(normalized.workerRuns, []);
  assert.deepEqual(normalized.workerCheckpoints, []);
  assert.deepEqual(normalized.workerDeploymentRollouts, []);
  assert.deepEqual(normalized.workerCommandReceipts, []);
  assert.deepEqual(normalized.workerEvents, []);
});

test("Worker repository integrity rejects orphaned records", () => {
  const data = createSeedStore();
  data.workerVersions.push(
    makeWorkerVersion({
      workspaceId: "alpha",
      workerDefinitionId: "missing-definition",
    }),
  );

  assertIntegrityFailure(data, /references a missing definition/);
});

test("Worker repository integrity rejects multiple active deployments", () => {
  const data = createSeedStore();
  data.workerDefinitions.push(
    makeWorkerDefinition({
      workspaceId: "alpha",
      status: "active",
      currentVersionId: "worker-version-1",
    }),
  );
  data.workerVersions.push(
    makeWorkerVersion({
      workspaceId: "alpha",
      status: "validated",
    }),
  );
  data.workerDeployments.push(
    makeWorkerDeployment({
      workspaceId: "alpha",
      id: "deployment-1",
      status: "active",
    }),
    makeWorkerDeployment({
      workspaceId: "alpha",
      id: "deployment-2",
      status: "active",
    }),
  );

  assertIntegrityFailure(data, /more than one active deployment/);
});

function assertIntegrityFailure(data: PacketAgentData, message: RegExp): void {
  assert.throws(
    () => validateWorkerPersistence(data),
    (error: unknown) =>
      error instanceof WorkerLifecycleError &&
      error.code === "integrity" &&
      message.test(error.message),
  );
}
