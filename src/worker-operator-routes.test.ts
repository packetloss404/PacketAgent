import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "hono";
import { createSeedStore, type PacketAgentData } from "./packetagent-store.js";
import {
  createWorkerOperatorRoutes,
  type AuthorizedWorkerOperatorContext,
  type WorkerOperatorPermission,
} from "./worker-operator-routes.js";
import { compileWorkerCapabilityPolicy } from "./workers/capabilities.js";
import { createWorkerControlService } from "./workers/control-service.js";
import { LEGACY_WORKER_EVENT_SCHEMA_VERSION } from "./workers/persistence-types.js";
import type { WorkerRunStatus } from "./workers/types.js";
import {
  makeWorkerAttentionRequest,
  makeWorkerCheckpoint,
  makeWorkerDefinition,
  makeWorkerDeployment,
  makeWorkerRun,
  makeWorkerVersion,
  makeWorkerVersionContent,
  TEST_LATER,
  TEST_NOW,
} from "./workers/__tests__/fixtures.js";

const CONTROL_NOW = "2026-07-27T12:10:00.000Z";

test("operator inspection returns a workspace-scoped redacted control view", async () => {
  const harness = createHarness({
    status: "waiting_for_approval",
    attention: true,
    permissions: ["inspect"],
  });

  const response = await harness.routes.request("/runs/run-1");
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    run: {
      status: string;
      revision: number;
      attention: Array<{
        operation: {
          tool: string;
          verb: string;
          effect: string;
          resourceCount: number;
          resourceSchemes: string[];
        };
      }>;
    };
  };
  assert.equal(body.run.status, "waiting_for_approval");
  assert.equal(body.run.revision, 1);
  assert.deepEqual(body.run.attention[0]?.operation, {
    tool: "http_fetch",
    verb: "GET",
    effect: "read",
    resourceCount: 1,
    resourceSchemes: ["https"],
  });
  assert.equal(harness.permissions.at(-1), "inspect");

  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("release-42"), false);
  assert.equal(serialized.includes("0123456789abcdef0123456789abcdef"), false);
  assert.equal(serialized.includes("attention-request-key"), false);
  assert.equal(serialized.includes(harness.policyDigest), false);

  harness.workspaceId = "workspace-2";
  const hidden = await harness.routes.request("/runs/run-1");
  assert.equal(hidden.status, 404);
  assert.equal(((await hidden.json()) as { code: string }).code, "not_found");
});

test("operator routes authorize inspection, run control, deployment control, and approval separately", async () => {
  const harness = createHarness({
    status: "waiting_for_approval",
    attention: true,
    permissions: ["inspect"],
  });

  const inspected = await harness.routes.request("/attention?status=open");
  assert.equal(inspected.status, 200);
  assert.equal(((await inspected.json()) as { attention: unknown[] }).attention.length, 1);

  for (const [path, permission] of [
    ["/runs/run-1/pause", "control_run"],
    ["/deployments/deployment-1/revoke", "control_deployment"],
    ["/attention/attention-1/approve-once", "approve"],
  ] as const) {
    const response = await postControl(harness.routes, path, 1, `denied-${permission}`);
    assert.equal(response.status, 403);
    assert.equal(harness.permissions.at(-1), permission);
  }
  const deniedBeforeParsing = await harness.routes.request("/runs/run-1/stop", {
    method: "POST",
    body: "not-json",
  });
  assert.equal(deniedBeforeParsing.status, 403);
  assert.equal(harness.permissions.at(-1), "control_run");
  assert.equal(harness.data.workerControlCommands.length, 0);
});

test("run control routes preserve atomic revisions, replay, and concise responses", async () => {
  const harness = createHarness({
    status: "running",
    permissions: ["control_run"],
  });

  const paused = await postControl(harness.routes, "/runs/run-1/pause", 1, "route-pause");
  assert.equal(paused.status, 200);
  const pausedBody = (await paused.json()) as {
    disposition: string;
    run: { status: string; revision: number };
  };
  assert.equal(pausedBody.disposition, "applied");
  assert.deepEqual(
    { status: pausedBody.run.status, revision: pausedBody.run.revision },
    { status: "paused", revision: 2 },
  );

  const replay = await postControl(harness.routes, "/runs/run-1/pause", 1, "route-pause");
  assert.equal(replay.status, 200);
  assert.equal(((await replay.json()) as { disposition: string }).disposition, "replayed");
  assert.equal(harness.data.workerControlCommands.length, 1);

  const resumed = await postControl(harness.routes, "/runs/run-1/resume", 2, "route-resume");
  assert.equal(resumed.status, 200);
  assert.equal(((await resumed.json()) as { run: { status: string } }).run.status, "queued");

  const stopped = await postControl(harness.routes, "/runs/run-1/stop", 3, "route-stop");
  assert.equal(stopped.status, 200);
  const stoppedText = await stopped.text();
  const stoppedBody = JSON.parse(stoppedText) as {
    run: { status: string; terminalReason: string };
  };
  assert.deepEqual(
    {
      status: stoppedBody.run.status,
      terminalReason: stoppedBody.run.terminalReason,
    },
    { status: "cancelled", terminalReason: "operator_cancelled" },
  );
  for (const forbidden of [
    "requestDigest",
    "idempotencyKey",
    "runtimeFence",
    "runtimeLease",
    "input",
    "output",
    "error",
  ]) {
    assert.equal(stoppedText.includes(forbidden), false);
  }
});

test("approval routes expose a nonce only on first apply and resume the exact waiting run", async () => {
  const harness = createHarness({
    status: "waiting_for_approval",
    attention: true,
    permissions: ["approve", "control_run"],
  });

  const approved = await postControl(
    harness.routes,
    "/attention/attention-1/approve-once",
    1,
    "route-approve",
    { expiresAt: "2026-07-27T12:50:00.000Z" },
  );
  assert.equal(approved.status, 200);
  assert.equal(approved.headers.get("cache-control"), "no-store");
  assert.equal(approved.headers.get("pragma"), "no-cache");
  const approvedBody = (await approved.json()) as {
    disposition: string;
    approvalNonce: string;
    approval: { status: string; scope: string };
    attention: { status: string };
  };
  assert.equal(approvedBody.disposition, "applied");
  assert.equal(approvedBody.approvalNonce, "operator-route-nonce-1");
  assert.deepEqual(approvedBody.approval, {
    id: "approval-operator-route-2",
    attentionRequestId: "attention-1",
    scope: "once",
    status: "active",
    grantedAt: CONTROL_NOW,
    expiresAt: "2026-07-27T12:50:00.000Z",
  });
  assert.equal(approvedBody.attention.status, "approved");
  assert.equal(JSON.stringify(approvedBody).includes("nonceDigest"), false);

  const replay = await postControl(
    harness.routes,
    "/attention/attention-1/approve-once",
    1,
    "route-approve",
    { expiresAt: "2026-07-27T12:50:00.000Z" },
  );
  assert.equal(replay.status, 200);
  const replayBody = (await replay.json()) as Record<string, unknown>;
  assert.equal(replayBody.disposition, "replayed");
  assert.equal("approvalNonce" in replayBody, false);

  const resumed = await postControl(
    harness.routes,
    "/runs/run-1/resume",
    1,
    "route-approved-resume",
  );
  assert.equal(resumed.status, 200);
  assert.equal(((await resumed.json()) as { run: { status: string } }).run.status, "queued");
});

test("operator mutations require exact JSON fields and an idempotency key", async () => {
  const harness = createHarness({
    status: "running",
    permissions: ["control_run"],
  });
  const unexpected = await postControl(harness.routes, "/runs/run-1/pause", 1, "route-unexpected", {
    status: "paused",
  });
  assert.equal(unexpected.status, 400);
  assert.equal(((await unexpected.json()) as { code: string }).code, "invalid_input");

  const missingKey = await harness.routes.request("/runs/run-1/pause", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: 1 }),
  });
  assert.equal(missingKey.status, 400);
  assert.equal(harness.data.workerControlCommands.length, 0);
});

test("rejected controls return conflict state and deployment revoke stops active work", async () => {
  const terminal = createHarness({
    status: "completed",
    permissions: ["control_run"],
  });
  const rejected = await postControl(terminal.routes, "/runs/run-1/stop", 1, "route-terminal-stop");
  assert.equal(rejected.status, 409);
  const rejectedBody = (await rejected.json()) as {
    disposition: string;
    command: { status: string; rejectionCode: string };
  };
  assert.equal(rejectedBody.disposition, "rejected");
  assert.deepEqual(
    {
      status: rejectedBody.command.status,
      rejectionCode: rejectedBody.command.rejectionCode,
    },
    { status: "rejected", rejectionCode: "run_already_terminal" },
  );

  const active = createHarness({
    status: "running",
    permissions: ["control_deployment"],
  });
  const revoked = await postControl(
    active.routes,
    "/deployments/deployment-1/revoke",
    1,
    "route-revoke",
  );
  assert.equal(revoked.status, 200);
  const revokedBody = (await revoked.json()) as {
    deployment: { status: string; revision: number };
    affectedRunIds: string[];
  };
  assert.deepEqual(
    {
      status: revokedBody.deployment.status,
      revision: revokedBody.deployment.revision,
      affectedRunIds: revokedBody.affectedRunIds,
    },
    { status: "revoked", revision: 2, affectedRunIds: ["run-1"] },
  );
  assert.equal(active.data.workerRuns[0]?.terminalReason, "deployment_revoked");
});

interface HarnessOptions {
  readonly status: WorkerRunStatus;
  readonly attention?: boolean;
  readonly permissions: readonly WorkerOperatorPermission[];
}

interface OperatorHarness {
  readonly routes: ReturnType<typeof createWorkerOperatorRoutes>;
  readonly permissions: WorkerOperatorPermission[];
  readonly policyDigest: string;
  workspaceId: string;
  readonly data: PacketAgentData;
}

function createHarness(options: HarnessOptions): OperatorHarness {
  let data = createStore(options);
  let mutationTail: Promise<void> = Promise.resolve();
  let nextId = 0;
  let nextNonce = 0;
  const mutateStore = async <T>(
    mutator: (draft: PacketAgentData) => T | Promise<T>,
  ): Promise<T> => {
    const previous = mutationTail;
    let release!: () => void;
    mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const draft = structuredClone(data);
      const result = await mutator(draft);
      data = draft;
      return result;
    } finally {
      release();
    }
  };
  const control = createWorkerControlService({
    mutateStore,
    now: () => new Date(CONTROL_NOW),
    id: (kind) => `${kind}-operator-route-${++nextId}`,
    nonce: () => `operator-route-nonce-${++nextNonce}`,
  });
  const allowed = new Set(options.permissions);
  const permissions: WorkerOperatorPermission[] = [];
  const harness = {
    workspaceId: "workspace-1",
    permissions,
    get data() {
      return data;
    },
    policyDigest: data.workerDeployments[0]!.compiledPolicy!.policyDigest,
  };
  const authorize = async (
    _context: Context,
    permission: WorkerOperatorPermission,
  ): Promise<AuthorizedWorkerOperatorContext> => {
    permissions.push(permission);
    if (!allowed.has(permission)) {
      throw Object.assign(new Error(`Worker operator permission ${permission} is required.`), {
        status: 403,
      });
    }
    return {
      workspaceId: harness.workspaceId,
      actor: {
        type: "user",
        id: "operator-route",
        displayName: "Route Operator",
      },
    };
  };
  return Object.assign(harness, {
    routes: createWorkerOperatorRoutes({
      control,
      loadStore: () => data,
      authorize,
    }),
  });
}

function createStore(options: HarnessOptions): PacketAgentData {
  const data = createSeedStore();
  const baseContent = makeWorkerVersionContent();
  const content = makeWorkerVersionContent({
    tools: baseContent.tools.map((capability) => ({
      ...capability,
      approval: "always" as const,
    })),
  });
  const version = makeWorkerVersion({
    status: "validated",
    content,
    validatedAt: TEST_LATER,
  });
  const compilation = compileWorkerCapabilityPolicy({
    workerVersionContentDigest: version.contentDigest,
    requestedCapabilities: version.content.tools,
    allowedCapabilityIds: version.content.policy.permissions.allowedCapabilityIds,
    credentialRefs: version.content.credentialRefs,
  });
  data.workerDefinitions.push(
    makeWorkerDefinition({
      status: "active",
      currentVersionId: version.id,
      updatedAt: TEST_LATER,
    }),
  );
  data.workerVersions.push(version);
  data.workerDeployments.push(
    makeWorkerDeployment({
      status: "active",
      capabilityGrants: compilation.grants,
      compiledPolicy: compilation.policy,
      updatedAt: TEST_LATER,
      activatedAt: TEST_LATER,
    }),
  );
  const run = makeWorkerRun({
    status: options.status,
    ...(options.attention
      ? {
          latestCheckpointId: "checkpoint-1",
        }
      : {}),
  });
  data.workerRuns.push(run);
  if (options.attention) {
    const attention = makeWorkerAttentionRequest({
      requestKey: "attention-request-key",
      workerVersionContentDigest: version.contentDigest,
      policyDigest: compilation.policy.policyDigest,
    });
    data.workerAttentionRequests.push(attention);
    data.workerCheckpoints.push(
      makeWorkerCheckpoint({
        pendingApprovalIds: [attention.id],
        cursor: {
          phase: "act",
          iteration: 1,
          actionIndex: 0,
        },
      }),
    );
    data.workerEvents.push({
      schemaVersion: LEGACY_WORKER_EVENT_SCHEMA_VERSION,
      id: "event-policy-denied",
      workspaceId: "workspace-1",
      sequence: 1,
      type: "worker.policy.denied",
      workerDefinitionId: "worker-1",
      workerVersionId: "worker-version-1",
      workerDeploymentId: "deployment-1",
      actor: { type: "system", id: "packetagent.worker-supervisor" },
      summary: "Worker policy requires approval.",
      data: {
        workerRunId: "run-1",
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
      occurredAt: TEST_NOW,
    });
    data.workerEvents.push({
      schemaVersion: LEGACY_WORKER_EVENT_SCHEMA_VERSION,
      id: "event-attention-requested",
      workspaceId: "workspace-1",
      sequence: 2,
      type: "worker.attention.requested",
      workerDefinitionId: "worker-1",
      workerVersionId: "worker-version-1",
      workerDeploymentId: "deployment-1",
      actor: { type: "system", id: "packetagent.worker-supervisor" },
      summary: "Worker execution is waiting for operation approval.",
      data: {
        workerRunId: "run-1",
        operationDigest: attention.operationDigest,
        policyDigest: attention.policyDigest,
        capabilityId: attention.capabilityId,
      },
      occurredAt: TEST_NOW,
    });
  }
  return data;
}

function postControl(
  routes: ReturnType<typeof createWorkerOperatorRoutes>,
  path: string,
  expectedRevision: number,
  idempotencyKey: string,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return Promise.resolve(
    routes.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({ expectedRevision, ...extra }),
    }),
  );
}
