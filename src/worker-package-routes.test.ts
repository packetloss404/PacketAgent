import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createSeedStore, type PacketAgentData } from "./packetagent-store.js";
import { createWorkerPackageRoutes } from "./worker-package-routes.js";
import { createWorkerActivationRepository } from "./workers/activation-repository.js";
import { createWorkerActivationService } from "./workers/activation.js";
import { createWorkerControlService } from "./workers/control-service.js";
import { createWorkerOperationsReadModel } from "./workers/observability/read-model.js";
import { createPacketProductDeploymentService } from "./workers/package/deployment.js";
import { createPacketProductTrustService } from "./workers/package/trust.js";
import type { WorkerPackage } from "./workers/package/types.js";
import { sealWorkerPackage } from "./workers/package/validation.js";
import { createWorkerRepository } from "./workers/repository.js";
import { createWorkerLifecycleService } from "./workers/service.js";

const FIXTURE_URL = new URL(
  "./workers/package/fixtures/worker-package-v1.valid.json",
  import.meta.url,
);
const TEST_SECRET = "r".repeat(43);

test("Packet-product routes validate without lifecycle writes and return field-addressed errors", async () => {
  const harness = await createHarness();
  const validationBody = packageBody(harness.v1);
  validationBody.capabilityGrants[0]!.approval = "always";
  const response = await requestJson(
    harness.routes,
    "POST",
    "/worker-packages/validate",
    validationBody,
    harness.v1.idempotencyKey,
    harness.token,
  );
  const result = (await response.json()) as {
    dryRun: boolean;
    receipt: { id: string };
    binding?: unknown;
    capabilities: {
      locallyAccepted: string[];
      grants: Array<{ resources: string[] }>;
    };
    requiredLocalApprovals: Array<{ capabilityId: string; approval: string }>;
    resultingIds: { receiptId: string; workerDeploymentId?: string };
  };

  assert.equal(response.status, 200);
  assert.equal(result.dryRun, true);
  assert.equal(result.binding, undefined);
  assert.deepEqual(result.capabilities.locallyAccepted, ["release-read"]);
  assert.deepEqual(result.capabilities.grants[0]!.resources, [
    "https://releases.example.test/stable",
  ]);
  assert.deepEqual(result.requiredLocalApprovals, [
    { capabilityId: "release-read", approval: "always" },
  ]);
  assert.equal(result.resultingIds.receiptId, result.receipt.id);
  assert.equal(result.resultingIds.workerDeploymentId, undefined);
  assert.equal(harness.data.workerPackageReceipts.length, 1);
  assert.equal(harness.data.workerDefinitions.length, 0);
  assert.equal(harness.data.workerDeployments.length, 0);

  const missingWorkspace = await harness.routes.request("/worker-packages/validate", {
    method: "POST",
    headers: {
      authorization: `Bearer ${harness.token}`,
      "content-type": "application/json",
      "idempotency-key": harness.v1.idempotencyKey,
    },
    body: JSON.stringify(packageBody(harness.v1)),
  });
  const missingBody = (await missingWorkspace.json()) as {
    code: string;
    issues: Array<{ path: string; code: string }>;
  };
  assert.equal(missingWorkspace.status, 400);
  assert.equal(missingBody.code, "invalid_input");
  assert.equal(missingBody.issues[0]!.path, "$.headers.PacketAgent-Workspace-Id");

  const unauthorized = await requestJson(
    harness.routes,
    "POST",
    "/worker-packages/validate",
    packageBody(harness.v1),
    harness.v1.idempotencyKey,
    "not-a-token",
  );
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get("www-authenticate") ?? "", /^Bearer /);
});

test("PacketADE deploy, activate, inspect, list, pause, resume, update, rollback, and revoke use canonical services", async () => {
  const harness = await createHarness();
  const deployedResponse = await requestJson(
    harness.routes,
    "POST",
    "/worker-deployments",
    packageBody(harness.v1),
    harness.v1.idempotencyKey,
    harness.token,
  );
  const deployed = (await deployedResponse.json()) as DeploymentResponse;
  assert.equal(deployedResponse.status, 201);
  assert.equal(deployed.dryRun, false);
  assert.equal(deployed.deployment.status, "deployed");
  assert.equal(deployed.deployment.revision, 3);
  assert.equal(deployed.binding.operation, "deploy");
  assert.equal(deployed.resultingIds.workerDefinitionId, deployed.definition.id);
  assert.equal(deployed.resultingIds.workerVersionId, deployed.version.id);
  assert.equal(deployed.resultingIds.workerDeploymentId, deployed.deployment.id);
  assert.deepEqual(
    deployed.deployment.capabilityGrants,
    deployed.receipt.capabilityDecision.grants,
  );
  assert.equal(harness.data.workerPackageDeployments.length, 1);

  const inspect = await harness.routes.request(`/worker-deployments/${deployed.deployment.id}`, {
    headers: readHeaders(harness.token),
  });
  assert.equal(inspect.status, 200);
  assert.equal(
    ((await inspect.json()) as DeploymentResponse).deployment.id,
    deployed.deployment.id,
  );

  const activatedResponse = await requestJson(
    harness.routes,
    "POST",
    `/worker-deployments/${deployed.deployment.id}/activate`,
    {
      expectedRevision: deployed.deployment.revision,
      input: { release_id: "release-42" },
    },
    "activate-v1",
    harness.token,
  );
  const activated = (await activatedResponse.json()) as DeploymentResponse;
  assert.equal(activatedResponse.status, 202);
  assert.equal(activated.deployment.status, "active");
  assert.equal(activated.activation.disposition, "accepted");
  assert.equal(activated.resultingIds.workerRunId, activated.activation.runId);
  assert.equal(harness.data.workerRuns.length, 1);
  assert.equal(harness.data.jobs.filter((job) => job.type === "worker.run").length, 1);

  const activationReplay = await requestJson(
    harness.routes,
    "POST",
    `/worker-deployments/${deployed.deployment.id}/activate`,
    {
      expectedRevision: deployed.deployment.revision,
      input: { release_id: "release-42" },
    },
    "activate-v1",
    harness.token,
  );
  assert.equal(activationReplay.status, 202);
  assert.equal(
    ((await activationReplay.json()) as DeploymentResponse).activation.runId,
    activated.activation.runId,
  );
  assert.equal(harness.data.workerRuns.length, 1);

  const runs = await harness.routes.request(
    `/worker-deployments/${deployed.deployment.id}/runs?limit=10`,
    {
      headers: readHeaders(harness.token),
    },
  );
  assert.equal(runs.status, 200);
  assert.equal(((await runs.json()) as { runs: unknown[] }).runs.length, 1);

  const paused = await controlRequest(
    harness,
    deployed.deployment.id,
    "pause",
    activated.deployment.revision,
    "pause-v1",
  );
  assert.equal(paused.deployment.status, "paused");
  const resumed = await controlRequest(
    harness,
    deployed.deployment.id,
    "resume",
    paused.deployment.revision,
    "resume-v1",
  );
  assert.equal(resumed.deployment.status, "active");

  const v2 = packageVersion(harness.v1, 2, "Report a bounded readiness decision with v2 evidence.");
  const updatedResponse = await requestJson(
    harness.routes,
    "PUT",
    `/worker-deployments/${deployed.deployment.id}`,
    {
      ...packageBody(v2),
      expectedRevision: resumed.deployment.revision,
      statusReason: "PacketADE v2 rollout.",
    },
    v2.idempotencyKey,
    harness.token,
  );
  const updated = (await updatedResponse.json()) as DeploymentResponse;
  assert.equal(updatedResponse.status, 200);
  assert.equal(updated.binding.operation, "update");
  assert.equal(updated.rollout.kind, "update");
  assert.equal(updated.previousDeployment.status, "retired");
  assert.equal(updated.deployment.status, "active");
  assert.notEqual(updated.deployment.id, deployed.deployment.id);
  assert.equal(updated.version.version, 2);
  assert.deepEqual(updated.deployment.capabilityGrants, updated.receipt.capabilityDecision.grants);

  const rollbackResponse = await requestJson(
    harness.routes,
    "POST",
    `/worker-deployments/${updated.deployment.id}/rollback`,
    {
      expectedRevision: updated.deployment.revision,
      targetPackageVersion: 1,
      statusReason: "Rollback to accepted v1.",
    },
    "rollback-v1",
    harness.token,
  );
  const rolledBack = (await rollbackResponse.json()) as DeploymentResponse;
  assert.equal(rollbackResponse.status, 200);
  assert.equal(rolledBack.binding.operation, "rollback");
  assert.equal(rolledBack.rollout.kind, "rollback");
  assert.equal(rolledBack.version.version, 1);
  assert.equal(rolledBack.deployment.status, "active");
  assert.deepEqual(
    rolledBack.deployment.capabilityGrants,
    rolledBack.receipt.capabilityDecision.grants,
  );

  const revokeResponse = await requestJson(
    harness.routes,
    "POST",
    `/worker-deployments/${rolledBack.deployment.id}/revoke`,
    { expectedRevision: rolledBack.deployment.revision },
    "revoke-v1",
    harness.token,
  );
  const revoked = (await revokeResponse.json()) as {
    binding: { workerDeploymentId: string };
    control: {
      disposition: string;
      deployment: { status: string };
      affectedRunIds: string[];
    };
  };
  assert.equal(revokeResponse.status, 200);
  assert.equal(revoked.binding.workerDeploymentId, rolledBack.deployment.id);
  assert.equal(revoked.control.disposition, "applied");
  assert.equal(revoked.control.deployment.status, "revoked");
  assert.deepEqual(revoked.control.affectedRunIds, []);
});

test("Packet-product controls reject unbound, cross-workspace, and stale targets", async () => {
  const harness = await createHarness();
  const unbound = await requestJson(
    harness.routes,
    "POST",
    "/worker-deployments/not-bound/pause",
    { expectedRevision: 1 },
    "unbound",
    harness.token,
  );
  assert.equal(unbound.status, 404);

  const crossWorkspace = await harness.routes.request("/worker-deployments/not-bound", {
    headers: {
      ...readHeaders(harness.token),
      "packetagent-workspace-id": "beta",
    },
  });
  assert.equal(crossWorkspace.status, 401);

  const deployedResponse = await requestJson(
    harness.routes,
    "POST",
    "/worker-deployments",
    packageBody(harness.v1),
    harness.v1.idempotencyKey,
    harness.token,
  );
  const deployed = (await deployedResponse.json()) as DeploymentResponse;
  const stale = await controlResponse(
    harness,
    deployed.deployment.id,
    "pause",
    deployed.deployment.revision - 1,
    "stale",
  );
  assert.equal(stale.status, 409);
  assert.equal(((await stale.json()) as { code: string }).code, "conflict");
});

test("Packet-product route rate limits expose Retry-After without leaking bearer values", async () => {
  const harness = await createHarness({ maxAttempts: 1 });
  const response = await requestJson(
    harness.routes,
    "POST",
    "/worker-deployments",
    packageBody(harness.v1),
    harness.v1.idempotencyKey,
    harness.token,
  );

  assert.equal(response.status, 429);
  assert.ok(response.headers.get("retry-after"));
  assert.equal(harness.data.workerPackageReceipts.length, 1);
  assert.equal(harness.data.workerDefinitions.length, 0);
  assert.equal(JSON.stringify(harness.data).includes(harness.token), false);
  assert.equal(JSON.stringify(harness.data).includes(TEST_SECRET), false);
});

interface DeploymentResponse {
  readonly dryRun: boolean;
  readonly receipt: {
    readonly capabilityDecision: {
      readonly grants: unknown[];
    };
  };
  readonly binding: {
    readonly operation: "deploy" | "update" | "rollback";
  };
  readonly definition: { readonly id: string };
  readonly version: { readonly id: string; readonly version: number };
  readonly deployment: {
    readonly id: string;
    readonly status: string;
    readonly revision: number;
    readonly capabilityGrants: unknown[];
  };
  readonly previousDeployment: {
    readonly id: string;
    readonly status: string;
  };
  readonly rollout: { readonly kind: "update" | "rollback" };
  readonly activation: {
    readonly disposition: string;
    readonly runId: string;
  };
  readonly resultingIds: {
    readonly workerDefinitionId: string;
    readonly workerVersionId: string;
    readonly workerDeploymentId: string;
    readonly workerRunId?: string;
  };
}

async function createHarness(options: { readonly maxAttempts?: number } = {}) {
  const data = createSeedStore();
  let mutationChain: Promise<unknown> = Promise.resolve();
  const mutateStore = <T>(mutation: (store: PacketAgentData) => T | Promise<T>) => {
    const result = mutationChain.then(() => mutation(data));
    mutationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  let tick = 0;
  let generatedId = 0;
  const nowDate = () => new Date(Date.UTC(2026, 6, 28, 20, 0, tick++));
  const nowString = () => nowDate().toISOString();
  const repository = createWorkerRepository({
    loadStore: () => data,
    mutateStore,
  });
  const lifecycle = createWorkerLifecycleService({
    repository,
    now: nowDate,
    id: (kind) => `${kind}_package_route_${++generatedId}`,
  });
  const activationRepository = createWorkerActivationRepository({
    loadStore: () => data,
    mutateStore,
  });
  const activation = createWorkerActivationService({
    repository: activationRepository,
    now: nowDate,
    id: (kind) => `${kind}_package_route_${++generatedId}`,
  });
  const control = createWorkerControlService({
    mutateStore,
    now: nowDate,
    id: (kind) => `${kind}_package_route_${++generatedId}`,
  });
  const trust = createPacketProductTrustService({
    loadStore: () => data,
    mutateStore,
    now: nowString,
    generateSecret: () => TEST_SECRET,
    generateId: (kind) => `${kind}_package_route_${++generatedId}`,
    ...(options.maxAttempts === undefined
      ? {}
      : {
          writeRateLimit: {
            maxAttempts: options.maxAttempts,
            windowMs: 60_000,
            maxBuckets: 10,
          },
        }),
  });
  const issued = await trust.issueCredential({
    workspaceId: "alpha",
    subjectId: "packetade:route-test",
    allowedOperations: [
      "package.validate",
      "package.deploy",
      "package.update",
      "deployment.activate",
      "deployment.inspect",
      "deployment.list_runs",
      "deployment.pause",
      "deployment.resume",
      "deployment.rollback",
      "deployment.revoke",
    ],
    createdBy: { type: "user", id: "user_alpha" },
  });
  const service = createPacketProductDeploymentService({
    trust,
    lifecycle,
    activation,
    control,
    readModel: createWorkerOperationsReadModel({ loadStore: () => data }),
    loadStore: () => data,
    mutateStore,
    now: nowString,
  });
  const v1 = JSON.parse(await readFile(FIXTURE_URL, "utf8")) as WorkerPackage;
  return {
    data,
    token: issued.token,
    v1,
    routes: createWorkerPackageRoutes({ service }),
  };
}

function packageBody(workerPackage: WorkerPackage) {
  return {
    workerPackage,
    acceptedCapabilityIds: ["release-read"],
    capabilityGrants: [
      {
        capabilityId: "release-read",
        verbs: ["GET"],
        resources: ["https://releases.example.test/stable"],
        approval: "never",
      },
    ],
  };
}

function packageVersion(
  workerPackage: WorkerPackage,
  packageVersionNumber: number,
  instructions: string,
): WorkerPackage {
  const { integrity: _integrity, ...subject } = workerPackage;
  return sealWorkerPackage({
    ...subject,
    packageVersion: packageVersionNumber,
    idempotencyKey: `${workerPackage.packageId}:v${packageVersionNumber}`,
    worker: {
      ...workerPackage.worker,
      content: {
        ...workerPackage.worker.content,
        instructions,
      },
    },
  });
}

function readHeaders(token: string) {
  return {
    authorization: `Bearer ${token}`,
    "packetagent-workspace-id": "alpha",
  };
}

function requestJson(
  routes: ReturnType<typeof createWorkerPackageRoutes>,
  method: "POST" | "PUT",
  path: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
  token: string,
) {
  return Promise.resolve(
    routes.request(path, {
      method,
      headers: {
        ...readHeaders(token),
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
    }),
  );
}

async function controlRequest(
  harness: Awaited<ReturnType<typeof createHarness>>,
  deploymentId: string,
  operation: "pause" | "resume",
  expectedRevision: number,
  idempotencyKey: string,
): Promise<DeploymentResponse> {
  const response = await controlResponse(
    harness,
    deploymentId,
    operation,
    expectedRevision,
    idempotencyKey,
  );
  assert.equal(response.status, 200);
  return (await response.json()) as DeploymentResponse;
}

function controlResponse(
  harness: Awaited<ReturnType<typeof createHarness>>,
  deploymentId: string,
  operation: "pause" | "resume",
  expectedRevision: number,
  idempotencyKey: string,
) {
  return requestJson(
    harness.routes,
    "POST",
    `/worker-deployments/${deploymentId}/${operation}`,
    { expectedRevision },
    idempotencyKey,
    harness.token,
  );
}
