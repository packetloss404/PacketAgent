import assert from "node:assert/strict";
import test from "node:test";
import { createSeedStore, type PacketAgentData } from "../packetagent-store.js";
import {
  makeWorkerDefinition,
  makeWorkerDeployment,
  makeWorkerRun,
  makeWorkerVersion,
  makeWorkerVersionContent,
} from "./__tests__/fixtures.js";
import {
  createWorkerAttentionDeadlineJobHandler,
  createWorkerAttentionService,
  WORKER_ATTENTION_DEADLINE_JOB_TYPE,
} from "./attention-service.js";
import { compileWorkerCapabilityPolicy } from "./capabilities.js";
import { createWorkerControlService } from "./control-service.js";
import { initialWorkerSupervisorState, reduceWorkerSupervisor } from "./runtime/reducer.js";
import { snapshotWorkerSupervisorState } from "./runtime/checkpoint.js";
import type {
  WorkerAttentionResolution,
  WorkerAttentionResolutionInput,
  WorkerRuntimeProviderResult,
} from "./runtime/ports.js";
import {
  createWorkerRuntimeRepository,
  type WorkerLeaseAcquisition,
} from "./runtime/repository.js";
import type { WorkerAttentionExpirationDisposition, WorkerVersionContent } from "./types.js";

const ACTOR = { type: "user" as const, id: "operator-1" };
const START = new Date("2026-07-27T12:00:00.000Z");
const OPERATION_DIGEST = `sha256:${"a".repeat(64)}`;

test("missing approval atomically checkpoints one attention request and its deadlines", async () => {
  const harness = await attentionHarness();
  const waiting = await harness.resolve();

  assert.equal(waiting.disposition, "waiting");
  if (waiting.disposition !== "waiting") return;
  assert.equal(waiting.run.status, "waiting_for_approval");
  assert.equal(waiting.run.runtimeLease, undefined);
  assert.equal(waiting.attention.status, "open");
  assert.equal(waiting.attention.policyDigest, harness.compiledPolicyDigest);
  assert.deepEqual(harness.data.workerCheckpoints[0]?.pendingApprovalIds, [waiting.attention.id]);
  assert.equal(
    harness.data.workerNotificationDeliveries.filter(
      (record) =>
        record.attentionRequestId === waiting.attention.id &&
        record.deliveryKey.endsWith(":requested"),
    ).length,
    1,
  );
  assert.deepEqual(
    harness.data.jobs
      .filter((job) => job.type === WORKER_ATTENTION_DEADLINE_JOB_TYPE)
      .map((job) => job.payload.kind)
      .sort(),
    ["escalate", "expire"],
  );
  assert.equal(
    harness.data.workerEvents.filter((event) => event.type === "worker.attention.requested").length,
    1,
  );
});

test("an exact one-time grant is replayable only for its original action", async () => {
  const harness = await attentionHarness();
  const waiting = await harness.resolve();
  assert.equal(waiting.disposition, "waiting");
  if (waiting.disposition !== "waiting") return;

  const approved = await harness.control.approveOnce({
    workspaceId: "workspace-1",
    attentionRequestId: waiting.attention.id,
    actor: ACTOR,
    idempotencyKey: "approve-once",
    expectedRevision: waiting.run.revision,
  });
  assert.equal(approved.disposition, "applied");
  const resumed = await harness.control.resumeRun({
    workspaceId: "workspace-1",
    workerRunId: waiting.run.id,
    actor: ACTOR,
    idempotencyKey: "resume-approved",
    expectedRevision: waiting.run.revision,
  });
  assert.equal(resumed.run?.status, "queued");

  const acquisition = await harness.acquire("approved-owner");
  const claimed = await harness.resolve(acquisition);
  assert.equal(claimed.disposition, "approved");
  if (claimed.disposition !== "approved") return;
  const replay = await harness.resolve(acquisition);
  assert.equal(replay.disposition, "approved");
  if (replay.disposition !== "approved") return;
  assert.equal(replay.approval.grantId, claimed.approval.grantId);
  assert.equal(harness.data.workerApprovalGrants[0]?.consumedByActionId, "call-approval");

  const nextAction = await harness.resolve(acquisition, "call-other");
  assert.equal(nextAction.disposition, "waiting");
  assert.equal(harness.data.workerAttentionRequests.length, 2);
});

test("a run-scoped grant is reusable only for the same version, policy, and operation", async () => {
  const harness = await attentionHarness();
  const waiting = await harness.resolve();
  assert.equal(waiting.disposition, "waiting");
  if (waiting.disposition !== "waiting") return;
  await harness.control.approveForRun({
    workspaceId: "workspace-1",
    attentionRequestId: waiting.attention.id,
    actor: ACTOR,
    idempotencyKey: "approve-run",
    expectedRevision: waiting.run.revision,
  });
  await harness.control.resumeRun({
    workspaceId: "workspace-1",
    workerRunId: waiting.run.id,
    actor: ACTOR,
    idempotencyKey: "resume-run-grant",
    expectedRevision: waiting.run.revision,
  });
  const acquisition = await harness.acquire("run-grant-owner");

  const first = await harness.resolve(acquisition);
  const second = await harness.resolve(acquisition, "call-other");
  assert.equal(first.disposition, "approved");
  assert.equal(second.disposition, "approved");
  if (first.disposition !== "approved" || second.disposition !== "approved") {
    return;
  }
  assert.equal(first.approval.grantId, second.approval.grantId);
  assert.equal(harness.data.workerApprovalGrants[0]?.status, "active");
  assert.equal(harness.data.workerAttentionRequests.length, 1);
});

for (const disposition of [
  "pause",
  "reject",
] satisfies readonly WorkerAttentionExpirationDisposition[]) {
  test(`escalation is deduplicated and ${disposition} expiration fails closed`, async () => {
    const harness = await attentionHarness(disposition);
    const waiting = await harness.resolve();
    assert.equal(waiting.disposition, "waiting");
    if (waiting.disposition !== "waiting") return;

    const escalatesAt = new Date(waiting.attention.escalatesAt!);
    const first = await harness.attention.processDeadline({
      workspaceId: "workspace-1",
      attentionRequestId: waiting.attention.id,
      kind: "escalate",
      now: escalatesAt,
    });
    const second = await harness.attention.processDeadline({
      workspaceId: "workspace-1",
      attentionRequestId: waiting.attention.id,
      kind: "escalate",
      now: escalatesAt,
    });
    assert.equal(first.queuedDeliveryIds.length, 1);
    assert.equal(second.queuedDeliveryIds.length, 0);
    assert.equal(
      harness.data.workerNotificationDeliveries.filter((record) =>
        record.deliveryKey.endsWith(":escalated"),
      ).length,
      1,
    );

    const expired = await harness.attention.processDeadline({
      workspaceId: "workspace-1",
      attentionRequestId: waiting.attention.id,
      kind: "expire",
      now: new Date(waiting.attention.expiresAt),
    });
    assert.equal(expired.attention.status, "expired");
    assert.equal(expired.run.status, disposition === "pause" ? "paused" : "failed");
    assert.equal(
      expired.run.terminalReason,
      disposition === "reject" ? "approval_expired" : undefined,
    );
  });
}

test("the deadline job handler rejects malformed jobs and applies a valid deadline", async () => {
  const harness = await attentionHarness();
  const waiting = await harness.resolve();
  assert.equal(waiting.disposition, "waiting");
  if (waiting.disposition !== "waiting") return;
  const handler = createWorkerAttentionDeadlineJobHandler(harness.attention);
  const job = harness.data.jobs.find(
    (record) =>
      record.type === WORKER_ATTENTION_DEADLINE_JOB_TYPE && record.payload.kind === "escalate",
  );
  assert.ok(job);
  harness.setNow(new Date(waiting.attention.escalatesAt!));
  const result = await handler.handle(job);
  assert.equal(result.queuedDeliveryIds.length, 1);
  await assert.rejects(
    () =>
      handler.handle({
        ...job,
        payload: { ...job.payload, kind: "approve" },
      }),
    /invalid kind/,
  );
});

interface AttentionHarness {
  readonly data: PacketAgentData;
  readonly attention: ReturnType<typeof createWorkerAttentionService>;
  readonly control: ReturnType<typeof createWorkerControlService>;
  readonly compiledPolicyDigest: string;
  acquire(ownerId: string): Promise<Extract<WorkerLeaseAcquisition, { disposition: "acquired" }>>;
  resolve(
    acquisition?: Extract<WorkerLeaseAcquisition, { disposition: "acquired" }>,
    actionId?: string,
  ): Promise<WorkerAttentionResolution>;
  setNow(value: Date): void;
}

async function attentionHarness(
  onExpiration: WorkerAttentionExpirationDisposition = "pause",
): Promise<AttentionHarness> {
  let data = createSeedStore();
  let now = START;
  let nextId = 0;
  let mutationTail = Promise.resolve();
  const content = approvalContent(onExpiration);
  const version = makeWorkerVersion({
    status: "validated",
    content,
    createdAt: now.toISOString(),
    validatedAt: now.toISOString(),
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
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }),
  );
  data.workerVersions.push(version);
  data.workerDeployments.push(
    makeWorkerDeployment({
      status: "active",
      capabilityGrants: compilation.grants,
      compiledPolicy: compilation.policy,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      activatedAt: now.toISOString(),
    }),
  );
  data.workerRuns.push(
    makeWorkerRun({
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }),
  );
  const store = {
    loadStore: () => data,
    mutateStore: async <T>(mutation: (draft: PacketAgentData) => T | Promise<T>): Promise<T> => {
      const previous = mutationTail;
      let release!: () => void;
      mutationTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        const draft = structuredClone(data);
        const result = await mutation(draft);
        data = draft;
        return result;
      } finally {
        release();
      }
    },
  };
  const id = (
    kind: "attention" | "approval" | "checkpoint" | "command" | "delivery" | "event" | "job",
  ): string => `${kind}-${++nextId}`;
  const runtime = createWorkerRuntimeRepository({
    ...store,
    now: () => now,
    id: (kind) => id(kind),
    leaseDurationMs: 60_000,
  });
  const attention = createWorkerAttentionService({
    mutateStore: store.mutateStore,
    now: () => now,
    id: (kind) => id(kind),
  });
  const control = createWorkerControlService({
    mutateStore: store.mutateStore,
    now: () => now,
    id: (kind) => id(kind),
    nonce: () => "approval-nonce",
  });
  let acquisition = await acquire("first-owner");

  async function acquire(
    ownerId: string,
  ): Promise<Extract<WorkerLeaseAcquisition, { disposition: "acquired" }>> {
    const result = await runtime.acquire({
      workspaceId: "workspace-1",
      workerRunId: "run-1",
      ownerId,
      now,
    });
    assert.equal(result.disposition, "acquired");
    if (result.disposition !== "acquired") {
      throw new Error("Attention test failed to acquire its run.");
    }
    return result;
  }

  async function resolve(selected = acquisition, actionId = "call-approval") {
    acquisition = selected;
    const checkpoint = selected.context.checkpoint;
    return await attention.resolve(
      attentionInput(
        selected,
        actionId,
        checkpoint?.sequence ?? -1,
        compilation.policy.policyDigest,
        now,
      ),
    );
  }

  return {
    get data() {
      return data;
    },
    attention,
    control,
    compiledPolicyDigest: compilation.policy.policyDigest,
    acquire,
    resolve,
    setNow(value) {
      now = value;
    },
  };
}

function approvalContent(onExpiration: WorkerAttentionExpirationDisposition): WorkerVersionContent {
  const base = makeWorkerVersionContent();
  return makeWorkerVersionContent({
    tools: base.tools.map((capability) => ({
      ...capability,
      approval: "always" as const,
    })),
    policy: {
      ...base.policy,
      attention: {
        approvalTimeoutMs: 30 * 60_000,
        escalationAfterMs: 10 * 60_000,
        onExpiration,
      },
    },
  });
}

function attentionInput(
  acquisition: Extract<WorkerLeaseAcquisition, { disposition: "acquired" }>,
  actionId: string,
  expectedCheckpointSequence: number,
  policyDigest: string,
  now: Date,
): WorkerAttentionResolutionInput {
  let state = initialWorkerSupervisorState(
    acquisition.context.run.budgetUsage,
    acquisition.context.version.content.policy.budgets,
  );
  state = reduceWorkerSupervisor(state, { type: "iteration.begin" });
  state = reduceWorkerSupervisor(state, {
    type: "provider.plan_succeeded",
    result: providerResult(actionId),
  });
  return {
    context: acquisition.context,
    workspaceId: acquisition.context.run.workspaceId,
    workerRunId: acquisition.context.run.id,
    workerVersionId: acquisition.context.run.workerVersionId,
    expectedRunRevision: acquisition.context.run.revision,
    expectedCheckpointSequence,
    fencingToken: acquisition.lease.fencingToken,
    cursor: state.cursor,
    budgetUsage: state.usage,
    workingMemory: snapshotWorkerSupervisorState(state),
    completedActionIds: state.completedActionIds,
    pendingApprovalIds: acquisition.context.checkpoint?.pendingApprovalIds ?? [],
    artifactRefs: state.artifactRefs,
    effectReceiptIds: state.effectReceiptIds,
    actionId,
    policyDecision: {
      allowed: false,
      code: "approval_required",
      tool: "http_fetch",
      verb: "GET",
      effect: "read",
      operationDigest: OPERATION_DIGEST,
      resourceCount: 1,
      resourceSchemes: ["https"],
      policyDigest,
      capabilityId: "release-read",
    },
    requestedAt: now,
  };
}

function providerResult(actionId: string): WorkerRuntimeProviderResult {
  return {
    content: "approval candidate",
    toolCalls: [
      {
        id: actionId,
        name: "http_fetch",
        input: { url: "https://releases.example.test/latest" },
      },
    ],
    finishReason: "tool_use",
    usage: {
      promptTokens: 1,
      completionTokens: 1,
      costUsd: 0.01,
    },
    model: "test-model",
    provider: "test-provider",
  };
}
