import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createSeedStore, type JobRecord, type PacketAgentData } from "../packetagent-store.js";
import { compileWorkerCapabilityPolicy } from "./capabilities.js";
import {
  createWorkerControlService,
  type WorkerControlCommitPhase,
  type WorkerControlService,
} from "./control-service.js";
import { WorkerLifecycleError } from "./errors.js";
import { createWorkerRuntimeRepository } from "./runtime/repository.js";
import type { WorkerRunStatus } from "./types.js";
import {
  makeWorkerAttentionRequest,
  makeWorkerDefinition,
  makeWorkerDeployment,
  makeWorkerRun,
  makeWorkerVersion,
  makeWorkerVersionContent,
  TEST_LATER,
  TEST_NOW,
} from "./__tests__/fixtures.js";

const CONTROL_NOW = "2026-07-27T12:10:00.000Z";
const ACTOR = {
  type: "user",
  id: "operator-1",
  displayName: "Operator One",
} as const;

test("pause fences a live run and resume queues the same checkpointed budget", async () => {
  const harness = controlHarness({ runStatus: "running", includeExecutionJob: true });
  const before = harness.data.workerRuns[0];
  const paused = await harness.service.pauseRun({
    ...control("pause-1", before.revision),
    workerRunId: before.id,
  });

  assert.equal(paused.disposition, "applied");
  assert.equal(paused.command.status, "applied");
  assert.equal(paused.command.appliedRevision, 2);
  assert.equal(paused.run?.status, "paused");
  assert.equal(paused.run?.revision, 2);
  assert.equal(paused.run?.runtimeLease, undefined);
  assert.deepEqual(paused.run?.budgetUsage, before.budgetUsage);
  assert.equal(paused.run?.latestCheckpointId, before.latestCheckpointId);

  const runtime = createWorkerRuntimeRepository({
    loadStore: () => harness.data,
    mutateStore: harness.mutateStore,
  });
  const acquisition = await runtime.acquire({
    workspaceId: before.workspaceId,
    workerRunId: before.id,
    ownerId: "should-not-acquire",
    now: new Date(CONTROL_NOW),
  });
  assert.equal(acquisition.disposition, "paused");

  const replay = await harness.service.pauseRun({
    ...control("pause-1", before.revision),
    workerRunId: before.id,
  });
  assert.equal(replay.disposition, "replayed");
  assert.equal(harness.data.workerControlCommands.length, 1);

  await assert.rejects(
    harness.service.pauseRun({
      ...control("pause-1", 2),
      workerRunId: before.id,
    }),
    (error: unknown) =>
      error instanceof WorkerLifecycleError && error.code === "idempotency_mismatch",
  );

  const resumed = await harness.service.resumeRun({
    ...control("resume-1", 2),
    workerRunId: before.id,
  });
  assert.equal(resumed.disposition, "applied");
  assert.equal(resumed.run?.status, "queued");
  assert.equal(resumed.run?.revision, 3);
  assert.deepEqual(resumed.run?.budgetUsage, before.budgetUsage);
  assert.ok(resumed.executionJobId);
  assert.equal(
    harness.data.jobs.find((job) => job.id === resumed.executionJobId)?.payload.controlCommandId,
    resumed.command.id,
  );

  const resumeReplay = await harness.service.resumeRun({
    ...control("resume-1", 2),
    workerRunId: before.id,
  });
  assert.equal(resumeReplay.disposition, "replayed");
  assert.equal(resumeReplay.executionJobId, resumed.executionJobId);
  assert.equal(
    harness.data.jobs.filter((job) => job.payload.controlCommandId === resumed.command.id).length,
    1,
  );
});

test("pausing a queued run cancels its queued execution job before resume replaces it", async () => {
  const harness = controlHarness({ runStatus: "queued", includeExecutionJob: true });
  harness.data.jobs.push({
    ...makeExecutionJob(makeBoundRun("run-1", "queued")),
    id: "job-other-workspace",
    workspaceId: "other-workspace",
  });
  const paused = await harness.service.pauseRun({
    ...control("pause-queued", 1),
    workerRunId: "run-1",
  });

  assert.equal(paused.run?.status, "paused");
  assert.equal(paused.run?.startedAt, CONTROL_NOW);
  const originalJob = harness.data.jobs.find((job) => job.id === "job-run-1");
  assert.equal(originalJob?.status, "canceled");
  assert.equal(originalJob?.cancelRequested, true);
  assert.equal(harness.data.jobs.find((job) => job.id === "job-other-workspace")?.status, "queued");

  const resumed = await harness.service.resumeRun({
    ...control("resume-queued", 2),
    workerRunId: "run-1",
  });
  assert.equal(resumed.run?.status, "queued");
  assert.equal(
    harness.data.jobs.filter(
      (job) =>
        job.workspaceId === "workspace-1" &&
        job.type === "worker.run" &&
        job.payload.workerRunId === "run-1" &&
        job.status === "queued",
    ).length,
    1,
  );
});

test("concurrent stop commands make one terminal transition and durably reject stale revision", async () => {
  const harness = controlHarness({ runStatus: "running", includeExecutionJob: true });
  const results = await Promise.all([
    harness.service.stopRun({
      ...control("stop-a", 1),
      workerRunId: "run-1",
    }),
    harness.service.stopRun({
      ...control("stop-b", 1),
      workerRunId: "run-1",
    }),
  ]);

  assert.deepEqual(results.map((result) => result.disposition).sort(), ["applied", "rejected"]);
  assert.equal(
    results.find((result) => result.disposition === "rejected")?.command.rejectionCode,
    "revision_conflict",
  );
  assert.equal(harness.data.workerRuns[0].status, "cancelled");
  assert.equal(harness.data.workerRuns[0].terminalReason, "operator_cancelled");
  assert.equal(harness.data.workerRuns[0].revision, 2);
  assert.equal(harness.data.workerRuns[0].runtimeLease, undefined);
  assert.equal(harness.data.jobs.find((job) => job.id === "job-run-1")?.cancelRequested, true);
  assert.equal(harness.data.workerControlCommands.length, 2);
  assert.equal(
    harness.data.workerEvents.filter((event) => event.type.startsWith("worker.control.stop_run"))
      .length,
    2,
  );
});

test("deployment revoke blocks future execution and terminalizes every nonterminal run", async () => {
  const harness = controlHarness({ runStatus: "running", includeExecutionJob: true });
  harness.addRun("run-2", "queued", true);
  harness.addRun("run-complete", "completed", false);

  const revoked = await harness.service.revokeDeployment({
    ...control("revoke-1", 1),
    workerDeploymentId: "deployment-1",
  });

  assert.equal(revoked.disposition, "applied");
  assert.equal(revoked.deployment?.status, "revoked");
  assert.equal(revoked.deployment?.revision, 2);
  assert.deepEqual(revoked.affectedRunIds?.slice().sort(), ["run-1", "run-2"]);
  assert.deepEqual(
    harness.data.workerRuns
      .filter((run) => run.id !== "run-complete")
      .map((run) => `${run.id}:${run.status}:${run.terminalReason}`)
      .sort(),
    ["run-1:cancelled:deployment_revoked", "run-2:cancelled:deployment_revoked"],
  );
  assert.equal(
    harness.data.workerRuns.find((run) => run.id === "run-complete")?.status,
    "completed",
  );

  const runtime = createWorkerRuntimeRepository({
    loadStore: () => harness.data,
    mutateStore: harness.mutateStore,
  });
  const acquisition = await runtime.acquire({
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    ownerId: "after-revoke",
    now: new Date(CONTROL_NOW),
  });
  assert.equal(acquisition.disposition, "terminal");
  if (acquisition.disposition === "terminal") {
    assert.equal(acquisition.run.terminalReason, "deployment_revoked");
  }
});

test("approve once resolves exactly one operation and exposes the nonce only on first apply", async () => {
  const harness = controlHarness({
    runStatus: "waiting_for_approval",
    includeAttention: true,
  });
  const approved = await harness.service.approveOnce({
    ...control("approve-once", 1),
    attentionRequestId: "attention-1",
    expiresAt: "2026-07-27T12:30:00.000Z",
  });

  assert.equal(approved.disposition, "applied");
  assert.equal(approved.attentionRequest?.status, "approved");
  assert.equal(approved.approvalGrant?.scope, "once");
  assert.equal(approved.approvalGrant?.status, "active");
  assert.equal(approved.approvalGrant?.expiresAt, "2026-07-27T12:30:00.000Z");
  assert.equal(approved.approvalNonce, "approval-secret-1");
  assert.equal(
    approved.approvalGrant?.nonceDigest,
    `sha256:${createHash("sha256").update("approval-secret-1").digest("hex")}`,
  );
  assert.equal(JSON.stringify(harness.data).includes("approval-secret-1"), false);

  const replay = await harness.service.approveOnce({
    ...control("approve-once", 1),
    attentionRequestId: "attention-1",
    expiresAt: "2026-07-27T12:30:00.000Z",
  });
  assert.equal(replay.disposition, "replayed");
  assert.equal(replay.approvalNonce, undefined);
  assert.equal(harness.data.workerApprovalGrants.length, 1);

  const losingReject = await harness.service.rejectAttention({
    ...control("reject-after-approve", 1),
    attentionRequestId: "attention-1",
  });
  assert.equal(losingReject.disposition, "rejected");
  assert.equal(losingReject.command.rejectionCode, "attention_not_open");
});

test("approve for run and reject attention preserve scope and actor-bound resolution", async () => {
  const approvalHarness = controlHarness({
    runStatus: "paused",
    includeAttention: true,
  });
  const blockedResume = await approvalHarness.service.resumeRun({
    ...control("resume-before-approval", 1),
    workerRunId: "run-1",
  });
  assert.equal(blockedResume.disposition, "rejected");
  assert.equal(blockedResume.command.rejectionCode, "run_attention_pending");

  const approved = await approvalHarness.service.approveForRun({
    ...control("approve-run", 1),
    attentionRequestId: "attention-1",
  });
  assert.equal(approved.approvalGrant?.scope, "run");
  assert.deepEqual(approved.attentionRequest?.resolvedBy, ACTOR);
  const resumed = await approvalHarness.service.resumeRun({
    ...control("resume-after-approval", 1),
    workerRunId: "run-1",
  });
  assert.equal(resumed.disposition, "applied");
  assert.equal(resumed.run?.status, "queued");

  const rejectionHarness = controlHarness({
    runStatus: "waiting_for_approval",
    includeAttention: true,
  });
  const rejected = await rejectionHarness.service.rejectAttention({
    ...control("reject-1", 1),
    attentionRequestId: "attention-1",
  });
  assert.equal(rejected.disposition, "applied");
  assert.equal(rejected.attentionRequest?.status, "rejected");
  assert.deepEqual(rejected.attentionRequest?.resolvedBy, ACTOR);
  assert.equal(rejected.run?.status, "failed");
  assert.equal(rejected.run?.terminalReason, "approval_rejected");
  assert.equal(rejectionHarness.data.workerApprovalGrants.length, 0);
});

test("expired attention and invalid grant windows fail closed as durable rejected commands", async () => {
  const expired = controlHarness({
    runStatus: "waiting_for_approval",
    includeAttention: true,
    now: "2026-07-27T13:00:00.000Z",
  });
  const expiredResult = await expired.service.approveOnce({
    ...control("approve-expired", 1),
    attentionRequestId: "attention-1",
  });
  assert.equal(expiredResult.disposition, "rejected");
  assert.equal(expiredResult.command.rejectionCode, "attention_expired");
  assert.equal(expiredResult.attentionRequest?.status, "expired");
  assert.equal(expired.data.workerApprovalGrants.length, 0);

  const invalidWindow = controlHarness({
    runStatus: "waiting_for_approval",
    includeAttention: true,
  });
  const invalidResult = await invalidWindow.service.approveForRun({
    ...control("approve-window", 1),
    attentionRequestId: "attention-1",
    expiresAt: "2026-07-27T14:00:00.000Z",
  });
  assert.equal(invalidResult.disposition, "rejected");
  assert.equal(invalidResult.command.rejectionCode, "approval_expiry_invalid");
  assert.equal(invalidWindow.data.workerAttentionRequests[0].status, "open");
});

test("a commit-phase failure rolls back command, target, job, and event together", async () => {
  const harness = controlHarness({
    runStatus: "running",
    failAt: "after_target_update",
  });

  await assert.rejects(
    harness.service.pauseRun({
      ...control("pause-rollback", 1),
      workerRunId: "run-1",
    }),
    /injected control commit failure/,
  );
  assert.equal(harness.data.workerRuns[0].status, "running");
  assert.equal(harness.data.workerRuns[0].revision, 1);
  assert.equal(harness.data.workerControlCommands.length, 0);
  assert.equal(harness.data.workerEvents.length, 0);
});

interface ControlHarnessOptions {
  readonly runStatus: WorkerRunStatus;
  readonly includeAttention?: boolean;
  readonly includeExecutionJob?: boolean;
  readonly now?: string;
  readonly failAt?: WorkerControlCommitPhase;
}

function controlHarness(options: ControlHarnessOptions) {
  let data = createControlStore(options);
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
  const service = createWorkerControlService({
    mutateStore,
    now: () => new Date(options.now ?? CONTROL_NOW),
    id: (kind) => `${kind}-control-${++nextId}`,
    nonce: () => `approval-secret-${++nextNonce}`,
    onCommitPhase: (phase) => {
      if (phase === options.failAt) throw new Error("injected control commit failure");
    },
  });

  return {
    service,
    mutateStore,
    get data() {
      return data;
    },
    addRun(id: string, status: WorkerRunStatus, includeJob: boolean) {
      const run = makeBoundRun(id, status);
      data.workerRuns.push(run);
      if (includeJob) data.jobs.push(makeExecutionJob(run));
    },
  };
}

function createControlStore(options: ControlHarnessOptions): PacketAgentData {
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
  const run = makeBoundRun("run-1", options.runStatus);
  data.workerRuns.push(run);
  if (options.includeExecutionJob) data.jobs.push(makeExecutionJob(run));
  if (options.includeAttention) {
    data.workerAttentionRequests.push(
      makeWorkerAttentionRequest({
        workerVersionContentDigest: version.contentDigest,
        policyDigest: compilation.policy.policyDigest,
      }),
    );
  }
  return data;
}

function makeBoundRun(id: string, status: WorkerRunStatus) {
  const running = status === "running";
  return makeWorkerRun({
    id,
    status,
    ...(running
      ? {
          runtimeFence: 1,
          runtimeLease: {
            ownerId: "test-supervisor",
            fencingToken: 1,
            acquiredAt: TEST_NOW,
            renewedAt: TEST_NOW,
            expiresAt: "2026-07-27T12:30:00.000Z",
          },
        }
      : {}),
  });
}

function makeExecutionJob(run: ReturnType<typeof makeWorkerRun>): JobRecord {
  const running = run.status === "running";
  return {
    id: `job-${run.id}`,
    workspaceId: run.workspaceId,
    type: "worker.run",
    payload: {
      workerRunId: run.id,
      workerDeploymentId: run.workerDeploymentId,
      workerVersionId: run.workerVersionId,
    },
    status: running ? "running" : "queued",
    attempts: running ? 1 : 0,
    maxAttempts: 2,
    scheduledAt: TEST_NOW,
    ...(running ? { startedAt: TEST_NOW } : {}),
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
  };
}

function control(idempotencyKey: string, expectedRevision: number) {
  return {
    workspaceId: "workspace-1",
    actor: ACTOR,
    idempotencyKey,
    expectedRevision,
  };
}
