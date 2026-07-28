import assert from "node:assert/strict";
import test from "node:test";
import { createSeedStore, normalizeStore, type PacketAgentData } from "../../packetagent-store.js";
import { WorkerLifecycleError } from "../errors.js";
import { compileWorkerCapabilityPolicy } from "../capabilities.js";
import { validateWorkerPersistence } from "../repository.js";
import {
  makeWorkerApprovalGrant,
  makeWorkerAttentionRequest,
  makeWorkerControlCommand,
  makeWorkerDefinition,
  makeWorkerDeployment,
  makeWorkerNotificationDelivery,
  makeWorkerRun,
  makeWorkerVersion,
} from "./fixtures.js";

test("legacy stores normalize with every Worker persistence collection", () => {
  const normalized = normalizeStore({});

  assert.deepEqual(normalized.workerDefinitions, []);
  assert.deepEqual(normalized.workerVersions, []);
  assert.deepEqual(normalized.workerDeployments, []);
  assert.deepEqual(normalized.workerRuns, []);
  assert.deepEqual(normalized.workerCheckpoints, []);
  assert.deepEqual(normalized.workerAttentionRequests, []);
  assert.deepEqual(normalized.workerApprovalGrants, []);
  assert.deepEqual(normalized.workerControlCommands, []);
  assert.deepEqual(normalized.workerNotificationDeliveries, []);
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

test("Worker repository integrity rejects a compiled policy that drifts from its version", () => {
  const data = createSeedStore();
  const version = makeWorkerVersion({
    workspaceId: "alpha",
    status: "validated",
  });
  const compiled = compileWorkerCapabilityPolicy({
    workerVersionContentDigest: version.contentDigest,
    requestedCapabilities: version.content.tools,
    allowedCapabilityIds: version.content.policy.permissions.allowedCapabilityIds,
    credentialRefs: version.content.credentialRefs,
  });
  data.workerDefinitions.push(
    makeWorkerDefinition({
      workspaceId: "alpha",
      status: "active",
      currentVersionId: version.id,
    }),
  );
  data.workerVersions.push(version);
  data.workerDeployments.push(
    makeWorkerDeployment({
      workspaceId: "alpha",
      status: "active",
      capabilityGrants: compiled.grants,
      compiledPolicy: {
        ...compiled.policy,
        policyDigest: `sha256:${"0".repeat(64)}`,
      },
    }),
  );

  assertIntegrityFailure(data, /does not match the pinned WorkerVersion/);
});

test("Worker repository validates durable control bindings and replay identities", () => {
  const data = createSeedStore();
  const version = makeWorkerVersion({ workspaceId: "alpha" });
  data.workerDefinitions.push(makeWorkerDefinition({ workspaceId: "alpha" }));
  data.workerVersions.push(version);
  data.workerDeployments.push(makeWorkerDeployment({ workspaceId: "alpha" }));
  data.workerRuns.push(makeWorkerRun({ workspaceId: "alpha" }));
  const binding = {
    workspaceId: "alpha",
    workerVersionContentDigest: version.contentDigest,
  };
  data.workerAttentionRequests.push(
    makeWorkerAttentionRequest({
      ...binding,
      status: "approved",
      resolvedAt: "2026-07-27T12:01:00.000Z",
      resolvedBy: { type: "user", id: "operator-1" },
      resolutionCommandId: "control-command-1",
    }),
  );
  data.workerApprovalGrants.push(makeWorkerApprovalGrant(binding));
  data.workerControlCommands.push(
    makeWorkerControlCommand({
      ...binding,
      kind: "approve_once",
      status: "applied",
      attentionRequestId: "attention-1",
      capabilityId: "release-read",
      operationDigest: `sha256:${"e".repeat(64)}`,
      appliedAt: "2026-07-27T12:01:00.000Z",
      appliedRevision: 1,
      approvalGrantId: "approval-1",
      updatedAt: "2026-07-27T12:01:00.000Z",
    }),
  );
  data.workerNotificationDeliveries.push(makeWorkerNotificationDelivery(binding));

  assert.doesNotThrow(() => validateWorkerPersistence(data));

  data.workerApprovalGrants.push(
    makeWorkerApprovalGrant({
      ...binding,
      id: "approval-duplicate-nonce",
    }),
  );
  assertIntegrityFailure(data, /duplicate Worker persistence key/);
});

test("Worker repository rejects control records whose immutable version binding drifts", () => {
  const data = createSeedStore();
  const version = makeWorkerVersion({ workspaceId: "alpha" });
  data.workerDefinitions.push(makeWorkerDefinition({ workspaceId: "alpha" }));
  data.workerVersions.push(version);
  data.workerDeployments.push(makeWorkerDeployment({ workspaceId: "alpha" }));
  data.workerRuns.push(makeWorkerRun({ workspaceId: "alpha" }));
  data.workerAttentionRequests.push(
    makeWorkerAttentionRequest({
      workspaceId: "alpha",
      workerVersionContentDigest: `sha256:${"0".repeat(64)}`,
    }),
  );

  assertIntegrityFailure(data, /inconsistent run, deployment, or version/);
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
