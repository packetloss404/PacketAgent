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
import { LEGACY_WORKER_EVENT_SCHEMA_VERSION } from "./workers/persistence-types.js";
import type { PacketProductOperation } from "./workers/package/trust-types.js";
import type { WorkerPackage } from "./workers/package/types.js";
import { createWorkerRepository } from "./workers/repository.js";
import { createWorkerLifecycleService } from "./workers/service.js";
import { makeWorkerAttentionRequest } from "./workers/__tests__/fixtures.js";

const FIXTURE_URL = new URL(
  "./workers/package/fixtures/worker-package-v1.valid.json",
  import.meta.url,
);
const TEST_SECRET = "s".repeat(43);
const ATTENTION_EXPIRES_AT = "2026-07-29T20:00:00.000Z";

test("attention list projects the operator view for receipt-bound deployments only", async () => {
  const harness = await createHarness();

  const listed = await harness.routes.request(
    `/worker-deployments/${harness.deploymentId}/attention?status=open`,
    { headers: readHeaders(harness.token) },
  );
  assert.equal(listed.status, 200);
  const listedText = await listed.text();
  const listedBody = JSON.parse(listedText) as {
    attention: Array<{
      id: string;
      workerDeploymentId: string;
      workerRunId: string;
      status: string;
      runRevision: number;
      operation: {
        tool: string;
        verb: string;
        effect: string;
        resourceCount: number;
        resourceSchemes: string[];
      };
    }>;
  };
  assert.equal(listedBody.attention.length, 1);
  assert.equal(listedBody.attention[0]!.id, "attention-1");
  assert.equal(listedBody.attention[0]!.workerDeploymentId, harness.deploymentId);
  assert.equal(listedBody.attention[0]!.workerRunId, harness.runId);
  assert.equal(listedBody.attention[0]!.status, "open");
  assert.equal(listedBody.attention[0]!.runRevision, harness.runRevision);
  assert.deepEqual(listedBody.attention[0]!.operation, {
    tool: "http_fetch",
    verb: "GET",
    effect: "read",
    resourceCount: 1,
    resourceSchemes: ["https"],
  });
  assert.equal(listedText.includes("attention-request-key"), false);
  assert.equal(listedText.includes(harness.policyDigest), false);

  const resolvedOnly = await harness.routes.request(
    `/worker-deployments/${harness.deploymentId}/attention?status=approved`,
    { headers: readHeaders(harness.token) },
  );
  assert.equal(resolvedOnly.status, 200);
  assert.equal(((await resolvedOnly.json()) as { attention: unknown[] }).attention.length, 0);

  const badStatus = await harness.routes.request(
    `/worker-deployments/${harness.deploymentId}/attention?status=weird`,
    { headers: readHeaders(harness.token) },
  );
  assert.equal(badStatus.status, 400);

  const unbound = await harness.routes.request(
    "/worker-deployments/not-a-bound-deployment/attention",
    { headers: readHeaders(harness.token) },
  );
  assert.equal(unbound.status, 404);
  assert.equal(((await unbound.json()) as { code: string }).code, "not_found");
});

test("attention routes authorize attention.list and attention.respond separately", async () => {
  const harness = await createHarness();
  const listOnlyToken = await harness.issueToken(["attention.list"]);
  const respondOnlyToken = await harness.issueToken(["attention.respond"]);

  const listed = await harness.routes.request(
    `/worker-deployments/${harness.deploymentId}/attention`,
    { headers: readHeaders(listOnlyToken) },
  );
  assert.equal(listed.status, 200);

  const deniedRespond = await respond(harness, "attention-1", "approve_once", 1, "denied-1", {
    token: listOnlyToken,
  });
  assert.equal(deniedRespond.status, 403);
  assert.equal(((await deniedRespond.json()) as { code: string }).code, "forbidden");

  const deniedList = await harness.routes.request(
    `/worker-deployments/${harness.deploymentId}/attention`,
    { headers: readHeaders(respondOnlyToken) },
  );
  assert.equal(deniedList.status, 403);
  assert.equal(harness.data.workerControlCommands.length, harness.baselineCommandCount);
});

test("respond applies once with a one-time nonce and replays without it", async () => {
  const harness = await createHarness();

  const approved = await respond(
    harness,
    "attention-1",
    "approve_once",
    harness.runRevision,
    "respond-1",
  );
  assert.equal(approved.status, 200);
  assert.equal(approved.headers.get("cache-control"), "no-store");
  assert.equal(approved.headers.get("pragma"), "no-cache");
  const approvedText = await approved.text();
  const approvedBody = JSON.parse(approvedText) as {
    disposition: string;
    approvalNonce: string;
    approval: { attentionRequestId: string; scope: string; status: string };
    attention: { status: string };
  };
  assert.equal(approvedBody.disposition, "applied");
  assert.equal(approvedBody.approvalNonce, "packet-attention-nonce-1");
  assert.equal(approvedBody.approval.attentionRequestId, "attention-1");
  assert.equal(approvedBody.approval.scope, "once");
  assert.equal(approvedBody.approval.status, "active");
  assert.equal(approvedBody.attention.status, "approved");
  assert.equal(approvedText.includes("nonceDigest"), false);

  const replay = await respond(
    harness,
    "attention-1",
    "approve_once",
    harness.runRevision,
    "respond-1",
  );
  assert.equal(replay.status, 200);
  const replayBody = (await replay.json()) as Record<string, unknown>;
  assert.equal(replayBody.disposition, "replayed");
  assert.equal("approvalNonce" in replayBody, false);
  assert.equal(harness.data.workerControlCommands.length, harness.baselineCommandCount + 1);

  const mismatched = await respond(
    harness,
    "attention-1",
    "reject",
    harness.runRevision,
    "respond-1",
  );
  assert.equal(mismatched.status, 409);
  assert.equal(((await mismatched.json()) as { code: string }).code, "idempotency_mismatch");
});

test("stale expected revisions reject with conflict state instead of applying", async () => {
  const harness = await createHarness();
  const stale = await respond(
    harness,
    "attention-1",
    "approve_for_run",
    harness.runRevision + 5,
    "respond-stale",
  );
  assert.equal(stale.status, 409);
  const staleBody = (await stale.json()) as {
    disposition: string;
    command: { status: string; rejectionCode: string };
  };
  assert.equal(staleBody.disposition, "rejected");
  assert.deepEqual(
    { status: staleBody.command.status, rejectionCode: staleBody.command.rejectionCode },
    { status: "rejected", rejectionCode: "revision_conflict" },
  );
  assert.equal(
    harness.data.workerAttentionRequests.find((record) => record.id === "attention-1")?.status,
    "open",
  );
});

test("cross-workspace, unbound, and malformed responses fail closed", async () => {
  const harness = await createHarness();

  const crossWorkspace = await harness.routes.request("/worker-attention/attention-1/respond", {
    method: "POST",
    headers: {
      authorization: `Bearer ${harness.token}`,
      "packetagent-workspace-id": "beta",
      "content-type": "application/json",
      "idempotency-key": "cross-workspace",
    },
    body: JSON.stringify({ decision: "approve_once", expectedRevision: harness.runRevision }),
  });
  assert.equal(crossWorkspace.status, 401);

  const missing = await respond(
    harness,
    "attention-missing",
    "reject",
    harness.runRevision,
    "missing-1",
  );
  assert.equal(missing.status, 404);

  const missingKey = await harness.routes.request("/worker-attention/attention-1/respond", {
    method: "POST",
    headers: {
      ...readHeaders(harness.token),
      "content-type": "application/json",
    },
    body: JSON.stringify({ decision: "approve_once", expectedRevision: harness.runRevision }),
  });
  assert.equal(missingKey.status, 400);

  const badDecision = await respond(
    harness,
    "attention-1",
    "escalate",
    harness.runRevision,
    "bad-decision",
  );
  assert.equal(badDecision.status, 400);

  // Deployment loses its packet-product binding: both routes fail closed.
  harness.data.workerPackageDeployments.splice(0, harness.data.workerPackageDeployments.length);
  const unboundList = await harness.routes.request(
    `/worker-deployments/${harness.deploymentId}/attention`,
    { headers: readHeaders(harness.token) },
  );
  assert.equal(unboundList.status, 404);
  const unboundRespond = await respond(
    harness,
    "attention-1",
    "approve_once",
    harness.runRevision,
    "unbound-1",
  );
  assert.equal(unboundRespond.status, 404);
  assert.equal(((await unboundRespond.json()) as { code: string }).code, "not_found");
  assert.equal(harness.data.workerControlCommands.length, harness.baselineCommandCount);
});

test("revoked credentials fail closed for both attention routes", async () => {
  const harness = await createHarness();
  await harness.trust.revokeCredential({
    workspaceId: "alpha",
    credentialId: harness.credentialId,
    revokedBy: { type: "user", id: "user_alpha" },
  });

  const listed = await harness.routes.request(
    `/worker-deployments/${harness.deploymentId}/attention`,
    { headers: readHeaders(harness.token) },
  );
  assert.equal(listed.status, 401);

  const responded = await respond(
    harness,
    "attention-1",
    "approve_once",
    harness.runRevision,
    "revoked-1",
  );
  assert.equal(responded.status, 401);
  assert.equal(harness.data.workerControlCommands.length, harness.baselineCommandCount);
});

async function createHarness() {
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
  let nextNonce = 0;
  const nowDate = () => new Date(Date.UTC(2026, 6, 28, 20, 0, tick++));
  const nowString = () => nowDate().toISOString();
  const repository = createWorkerRepository({
    loadStore: () => data,
    mutateStore,
  });
  const lifecycle = createWorkerLifecycleService({
    repository,
    now: nowDate,
    id: (kind) => `${kind}_pkattn_${++generatedId}`,
  });
  const activationRepository = createWorkerActivationRepository({
    loadStore: () => data,
    mutateStore,
  });
  const activation = createWorkerActivationService({
    repository: activationRepository,
    now: nowDate,
    id: (kind) => `${kind}_pkattn_${++generatedId}`,
  });
  const control = createWorkerControlService({
    mutateStore,
    now: nowDate,
    id: (kind) => `${kind}_pkattn_${++generatedId}`,
    nonce: () => `packet-attention-nonce-${++nextNonce}`,
  });
  const trust = createPacketProductTrustService({
    loadStore: () => data,
    mutateStore,
    now: nowString,
    generateSecret: () => TEST_SECRET,
    generateId: (kind) => `${kind}_pkattn_${++generatedId}`,
  });
  const issueToken = async (operations: readonly PacketProductOperation[]) => {
    const issued = await trust.issueCredential({
      workspaceId: "alpha",
      subjectId: `packetade:attention-${operations.join("+")}`,
      allowedOperations: [...operations],
      createdBy: { type: "user", id: "user_alpha" },
    });
    return issued.token;
  };
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
  const routes = createWorkerPackageRoutes({
    service,
    trust,
    control,
    loadStore: () => data,
  });

  const setup = await trust.issueCredential({
    workspaceId: "alpha",
    subjectId: "packetade:attention-setup",
    allowedOperations: [
      "package.validate",
      "package.deploy",
      "deployment.activate",
    ],
    createdBy: { type: "user", id: "user_alpha" },
  });
  const v1 = JSON.parse(await readFile(FIXTURE_URL, "utf8")) as WorkerPackage;
  const deployed = await service.deployPackage({
    authorization: `Bearer ${setup.token}`,
    workspaceId: "alpha",
    idempotencyKey: v1.idempotencyKey,
    workerPackage: v1,
    acceptedCapabilityIds: ["release-read"],
    capabilityGrants: [
      {
        capabilityId: "release-read",
        verbs: ["GET"],
        resources: ["https://releases.example.test/stable"],
        approval: "always",
      },
    ],
  });
  const deployment = deployed.deployment!;
  const activated = await service.activate({
    authorization: `Bearer ${setup.token}`,
    workspaceId: "alpha",
    workerDeploymentId: deployment.id,
    idempotencyKey: "attention-setup-activate",
    expectedRevision: deployment.revision,
    startRun: true,
    input: { release_id: "release-42" },
  });
  const runId = activated.activation!.runId!;

  // Pause the queued run so attention responses find it in an approvable state.
  const paused = await control.pauseRun({
    workspaceId: "alpha",
    actor: { type: "packet_product", id: "packetade:attention-setup", product: "PacketADE" },
    idempotencyKey: "attention-setup-pause",
    expectedRevision: 1,
    workerRunId: runId,
  });
  const runRevision = paused.run!.revision;

  const activeDeployment = data.workerDeployments.find(
    (record) => record.workspaceId === "alpha" && record.id === deployment.id,
  )!;
  const version = data.workerVersions.find(
    (record) => record.workspaceId === "alpha" && record.id === activeDeployment.workerVersionId,
  )!;
  const policyDigest = activeDeployment.compiledPolicy!.policyDigest;
  const attention = makeWorkerAttentionRequest({
    id: "attention-1",
    requestKey: `${runId}:iteration-1:action-1`,
    workspaceId: "alpha",
    workerDefinitionId: activeDeployment.workerDefinitionId,
    workerDeploymentId: activeDeployment.id,
    workerRunId: runId,
    workerVersionId: version.id,
    workerVersionContentDigest: version.contentDigest,
    policyDigest,
    capabilityId: "release-read",
    requestedAt: nowString(),
    escalatesAt: "2026-07-28T21:00:00.000Z",
    expiresAt: ATTENTION_EXPIRES_AT,
  });
  data.workerAttentionRequests.push(attention);
  const nextSequence =
    Math.max(
      0,
      ...data.workerEvents
        .filter((event) => event.workspaceId === "alpha")
        .map((event) => event.sequence),
    ) + 1;
  data.workerEvents.push({
    schemaVersion: LEGACY_WORKER_EVENT_SCHEMA_VERSION,
    id: "event-attention-policy-denied",
    workspaceId: "alpha",
    sequence: nextSequence,
    type: "worker.policy.denied",
    workerDefinitionId: activeDeployment.workerDefinitionId,
    workerVersionId: version.id,
    workerDeploymentId: activeDeployment.id,
    actor: { type: "system", id: "packetagent.worker-supervisor" },
    summary: "Worker policy requires approval.",
    data: {
      workerRunId: runId,
      decision: "deny",
      code: "approval_required",
      tool: "http_fetch",
      verb: "GET",
      effect: "read",
      operationDigest: attention.operationDigest,
      policyDigest: attention.policyDigest,
      capabilityId: attention.capabilityId,
      resourceCount: 1,
      resourceSchemes: ["https"],
    },
    occurredAt: nowString(),
  });

  const routeCredential = await trust.issueCredential({
    workspaceId: "alpha",
    subjectId: "packetade:attention-test",
    allowedOperations: ["attention.list", "attention.respond"],
    createdBy: { type: "user", id: "user_alpha" },
  });

  return {
    data,
    routes,
    trust,
    issueToken,
    token: routeCredential.token,
    credentialId: routeCredential.credential.id,
    deploymentId: deployment.id,
    runId,
    runRevision,
    policyDigest,
    baselineCommandCount: data.workerControlCommands.length,
  };
}

function readHeaders(token: string) {
  return {
    authorization: `Bearer ${token}`,
    "packetagent-workspace-id": "alpha",
  };
}

function respond(
  harness: Awaited<ReturnType<typeof createHarness>>,
  attentionRequestId: string,
  decision: string,
  expectedRevision: number,
  idempotencyKey: string,
  options: { readonly token?: string } = {},
): Promise<Response> {
  return Promise.resolve(
    harness.routes.request(`/worker-attention/${attentionRequestId}/respond`, {
      method: "POST",
      headers: {
        ...readHeaders(options.token ?? harness.token),
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({ decision, expectedRevision }),
    }),
  );
}
