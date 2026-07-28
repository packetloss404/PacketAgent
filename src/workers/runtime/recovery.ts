import { randomUUID } from "node:crypto";
import {
  mutateStoreAsync as defaultMutateStore,
  type JobRecord,
  type PacketAgentData,
} from "../../packetagent-store.js";
import { redactedErrorMessage } from "../../security/redaction.js";
import { assertWorkerEffectResultDigest } from "../effects.js";
import type { WorkerRollingBudgetPort } from "../budget-types.js";
import { createWorkerRollingBudgetService } from "../rolling-budget.js";
import type { WorkerEventV2 } from "../persistence-types.js";
import { appendWorkerJournalEntry, workerEventCorrelation } from "../observability/journal.js";
import { assertWorkerRunUpdate } from "../transitions.js";
import type { WorkerCheckpoint, WorkerRun, WorkerVersion } from "../types.js";
import { restoreWorkerSupervisorState } from "./checkpoint.js";
import { latestValidWorkerCheckpoint } from "./repository.js";

type MaybePromise<T> = T | Promise<T>;

const WORKER_EXECUTION_JOB_TYPE = "worker.run";
const RECOVERY_ACTOR = {
  type: "system" as const,
  id: "packetagent.worker-recovery",
  displayName: "PacketAgent Worker Recovery",
};

export interface WorkerRecoveryDependencies {
  readonly mutateStore?: <T>(
    mutator: (data: PacketAgentData) => MaybePromise<T>,
  ) => MaybePromise<T>;
  readonly id?: (kind: "job" | "event") => string;
  readonly now?: () => Date;
  readonly budgets?: WorkerRollingBudgetPort;
}

export interface WorkerRecoveryResult {
  readonly inspected: number;
  readonly requeuedRunIds: readonly string[];
  readonly quarantinedRunIds: readonly string[];
  readonly unchangedRunIds: readonly string[];
}

export interface WorkerRecoveryCoordinator {
  recoverExpired(): Promise<WorkerRecoveryResult>;
}

export function createWorkerRecoveryCoordinator(
  dependencies: WorkerRecoveryDependencies = {},
): WorkerRecoveryCoordinator {
  const mutateStore = dependencies.mutateStore ?? defaultMutateStore;
  const id = dependencies.id ?? ((kind: "job" | "event") => `${kind}_${randomUUID()}`);
  const now = dependencies.now ?? (() => new Date());
  const budgets =
    dependencies.budgets ??
    createWorkerRollingBudgetService({
      mutateStore,
      now,
    });

  return {
    async recoverExpired() {
      const timestamp = now();
      const result = await mutateStore((data) => {
        const requeuedRunIds: string[] = [];
        const quarantinedRunIds: string[] = [];
        const unchangedRunIds: string[] = [];
        const candidates = data.workerRuns.filter((run) => run.status === "running");

        for (const run of candidates) {
          const executionJobs = workerExecutionJobs(data, run);
          const queuedJob = executionJobs.find((job) => job.status === "queued");
          const leaseIsLive =
            run.runtimeLease && Date.parse(run.runtimeLease.expiresAt) > timestamp.getTime();
          if (leaseIsLive || (!run.runtimeLease && queuedJob)) {
            unchangedRunIds.push(run.id);
            continue;
          }

          const unsafeReason = recoverySafetyIssue(data, run);
          if (unsafeReason) {
            quarantineRun(data, run, executionJobs, unsafeReason, timestamp, id("event"));
            quarantinedRunIds.push(run.id);
            continue;
          }

          releaseExpiredLease(data, run, timestamp);
          requeueExecutionJob(data, run, executionJobs, timestamp, id);
          const recovered = requireRun(data, run.workspaceId, run.id);
          appendRecoveryEvent(data, id("event"), recovered, {
            type: "worker.run.recovery_queued",
            summary: "Expired Worker execution was queued from its latest checkpoint.",
            data: {
              workerRunId: run.id,
              latestCheckpointId: recovered.latestCheckpointId ?? null,
              runRevision: recovered.revision,
            },
            occurredAt: timestamp.toISOString(),
          });
          requeuedRunIds.push(run.id);
        }

        return {
          inspected: candidates.length,
          requeuedRunIds,
          quarantinedRunIds,
          unchangedRunIds,
        };
      });
      await budgets.reconcile(timestamp);
      return result;
    },
  };
}

function recoverySafetyIssue(data: PacketAgentData, run: WorkerRun): string | null {
  try {
    const version = data.workerVersions.find(
      (record) => record.workspaceId === run.workspaceId && record.id === run.workerVersionId,
    );
    const deployment = data.workerDeployments.find(
      (record) => record.workspaceId === run.workspaceId && record.id === run.workerDeploymentId,
    );
    if (!version || !deployment) {
      return "Pinned Worker version or deployment is missing.";
    }
    if (
      deployment.workerVersionId !== run.workerVersionId ||
      deployment.workerDefinitionId !== run.workerDefinitionId
    ) {
      return "Pinned Worker version and deployment no longer agree.";
    }
    const checkpoint = latestValidWorkerCheckpoint(data, run);
    if (checkpoint) {
      restoreCheckpoint(checkpoint, run, version);
      assertCheckpointEffects(data, checkpoint);
    } else if (run.latestCheckpointId) {
      return "The run points to a missing Worker checkpoint.";
    }
    const prepared = data.workerEffectReceipts.filter(
      (receipt) =>
        receipt.workspaceId === run.workspaceId &&
        receipt.workerRunId === run.id &&
        receipt.status === "prepared",
    );
    if (prepared.length > 1) {
      return "Multiple unresolved Worker effects make safe replay ambiguous.";
    }
    if (prepared[0]) {
      if (prepared[0].classification === "non_replayable_mutation") {
        return "A prepared non-replayable Worker effect has an uncertain outcome.";
      }
      if (!checkpoint) {
        return "A prepared Worker effect has no checkpointed action cursor.";
      }
      const memory = checkpoint.workingMemory as Record<string, unknown>;
      const pendingTools = Array.isArray(memory.pendingTools) ? memory.pendingTools : [];
      const pending = pendingTools[checkpoint.cursor.actionIndex] as
        | Record<string, unknown>
        | undefined;
      if (
        checkpoint.cursor.phase !== "act" ||
        checkpoint.cursor.iteration !== prepared[0].iteration ||
        pending?.id !== prepared[0].actionId ||
        pending?.name !== prepared[0].toolName
      ) {
        return "A prepared Worker effect does not match the checkpointed action cursor.";
      }
    }
    return null;
  } catch (error) {
    return redactedErrorMessage(error);
  }
}

function restoreCheckpoint(
  checkpoint: WorkerCheckpoint,
  run: WorkerRun,
  version: WorkerVersion,
): void {
  const retry = version.content.policy.retry;
  restoreWorkerSupervisorState(checkpoint, run.budgetUsage, {
    ...version.content.policy.budgets,
    maxConsecutiveFailures: Math.min(
      version.content.policy.budgets.maxConsecutiveFailures,
      retry.maxAttempts,
    ),
  });
}

function assertCheckpointEffects(data: PacketAgentData, checkpoint: WorkerCheckpoint): void {
  for (const receiptId of checkpoint.effectReceiptIds) {
    const receipt = data.workerEffectReceipts.find(
      (record) =>
        record.workspaceId === checkpoint.workspaceId &&
        record.workerRunId === checkpoint.workerRunId &&
        record.id === receiptId,
    );
    if (!receipt || receipt.status !== "completed") {
      throw new Error(
        `Checkpoint ${checkpoint.id} references an incomplete or missing effect receipt.`,
      );
    }
    assertWorkerEffectResultDigest(receipt);
  }
}

function releaseExpiredLease(data: PacketAgentData, run: WorkerRun, now: Date): void {
  const current = requireRun(data, run.workspaceId, run.id);
  if (!current.runtimeLease) return;
  const { runtimeLease: _expired, ...withoutLease } = current;
  const next: WorkerRun = {
    ...withoutLease,
    revision: current.revision + 1,
    updatedAt: now.toISOString(),
  };
  assertWorkerRunUpdate(current, next);
  replaceRun(data, next);
}

function requeueExecutionJob(
  data: PacketAgentData,
  run: WorkerRun,
  jobs: readonly JobRecord[],
  now: Date,
  id: (kind: "job" | "event") => string,
): void {
  const job = jobs.find((record) => record.status === "running") ?? jobs[0];
  if (job) {
    job.status = "queued";
    job.attempts = Math.max(0, job.attempts - 1);
    job.scheduledAt = now.toISOString();
    job.updatedAt = now.toISOString();
    delete job.startedAt;
    delete job.completedAt;
    delete job.error;
    delete job.result;
    return;
  }
  data.jobs.push({
    id: id("job"),
    workspaceId: run.workspaceId,
    type: WORKER_EXECUTION_JOB_TYPE,
    payload: {
      workerRunId: run.id,
      workerDeploymentId: run.workerDeploymentId,
      workerVersionId: run.workerVersionId,
    },
    status: "queued",
    attempts: 0,
    maxAttempts: 3,
    scheduledAt: now.toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
}

function quarantineRun(
  data: PacketAgentData,
  run: WorkerRun,
  jobs: readonly JobRecord[],
  reason: string,
  now: Date,
  eventId: string,
): void {
  const current = requireRun(data, run.workspaceId, run.id);
  const { runtimeLease: _expired, ...withoutLease } = current;
  const safeReason = redactedErrorMessage(reason);
  const next: WorkerRun = {
    ...withoutLease,
    status: "quarantined",
    revision: current.revision + 1,
    terminalReason: "unsafe_replay",
    error: safeReason,
    updatedAt: now.toISOString(),
    completedAt: now.toISOString(),
  };
  assertWorkerRunUpdate(current, next);
  replaceRun(data, next);
  for (const job of jobs) {
    if (job.status === "success" || job.status === "canceled") continue;
    job.status = "failed";
    job.error = safeReason;
    job.completedAt = now.toISOString();
    job.updatedAt = now.toISOString();
    delete job.startedAt;
  }
  appendRecoveryEvent(data, eventId, next, {
    type: "worker.run.quarantined",
    summary: "Worker recovery stopped because safe replay could not be proven.",
    data: {
      workerRunId: next.id,
      terminalReason: "unsafe_replay",
      runRevision: next.revision,
    },
    occurredAt: now.toISOString(),
  });
}

function workerExecutionJobs(data: PacketAgentData, run: WorkerRun): JobRecord[] {
  return data.jobs
    .filter(
      (job) =>
        job.workspaceId === run.workspaceId &&
        job.type === WORKER_EXECUTION_JOB_TYPE &&
        job.payload.workerRunId === run.id,
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function requireRun(data: PacketAgentData, workspaceId: string, workerRunId: string): WorkerRun {
  const run = data.workerRuns.find(
    (record) => record.workspaceId === workspaceId && record.id === workerRunId,
  );
  if (!run) throw new Error(`WorkerRun ${workerRunId} was not found.`);
  return run;
}

function replaceRun(data: PacketAgentData, run: WorkerRun): void {
  const index = data.workerRuns.findIndex(
    (record) => record.workspaceId === run.workspaceId && record.id === run.id,
  );
  if (index < 0) throw new Error(`WorkerRun ${run.id} was not found.`);
  data.workerRuns[index] = run;
}

function appendRecoveryEvent(
  data: PacketAgentData,
  eventId: string,
  run: WorkerRun,
  input: Pick<WorkerEventV2, "type" | "summary" | "data" | "occurredAt">,
): void {
  appendWorkerJournalEntry(data, {
    id: eventId,
    workspaceId: run.workspaceId,
    type: input.type,
    source: "recovery",
    workerDefinitionId: run.workerDefinitionId,
    workerVersionId: run.workerVersionId,
    workerDeploymentId: run.workerDeploymentId,
    workerRunId: run.id,
    actor: RECOVERY_ACTOR,
    summary: input.summary,
    ...(input.data ? { data: input.data } : {}),
    ...(run.trace ? { trace: run.trace } : {}),
    correlation: workerEventCorrelation(input.data),
    occurredAt: input.occurredAt,
  });
}
