import { createHash, randomUUID } from "node:crypto";
import {
  mutateStoreAsync as defaultMutateStore,
  type JobRecord,
  type PacketAgentData,
} from "../packetagent-store.js";
import type { WorkerToolApprovalEvidence } from "../tools/types.js";
import {
  WORKER_APPROVAL_GRANT_SCHEMA_VERSION,
  WORKER_ATTENTION_REQUEST_SCHEMA_VERSION,
  WORKER_NOTIFICATION_DELIVERY_SCHEMA_VERSION,
  type WorkerApprovalGrant,
  type WorkerAttentionRequest,
  type WorkerNotificationDeliveryReference,
} from "./control-types.js";
import { WorkerLifecycleError } from "./errors.js";
import { WORKER_EVENT_SCHEMA_VERSION, type WorkerEvent } from "./persistence-types.js";
import { validateWorkerPersistence } from "./repository.js";
import { assertWorkerRunUpdate, isTerminalWorkerRunStatus } from "./transitions.js";
import {
  WORKER_CONTRACT_SCHEMA_VERSION,
  type WorkerCheckpoint,
  type WorkerRemainingBudget,
  type WorkerRun,
  type WorkerVersion,
} from "./types.js";
import { canonicalWorkerJson } from "./validation.js";
import { remainingWorkerBudget, workerCheckpointStateDigest } from "./runtime/checkpoint.js";
import type {
  WorkerAttentionPort,
  WorkerAttentionResolution,
  WorkerAttentionResolutionInput,
} from "./runtime/ports.js";

type MaybePromise<T> = T | Promise<T>;

export const WORKER_ATTENTION_DEADLINE_JOB_TYPE = "worker.attention.deadline" as const;

const ATTENTION_SYSTEM_ACTOR = {
  type: "system" as const,
  id: "packetagent.worker-attention",
  displayName: "PacketAgent Worker Attention",
};

export type WorkerAttentionDeadlineKind = "escalate" | "expire";
type WorkerAttentionIdKind = "attention" | "checkpoint" | "delivery" | "event" | "job";
type WorkerAttentionIdFactory = (kind: WorkerAttentionIdKind) => string;

export interface WorkerAttentionServiceDependencies {
  readonly mutateStore?: <T>(
    mutator: (data: PacketAgentData) => MaybePromise<T>,
  ) => MaybePromise<T>;
  readonly now?: () => Date;
  readonly id?: WorkerAttentionIdFactory;
}

export interface WorkerAttentionDeadlineResult {
  readonly attention: WorkerAttentionRequest;
  readonly run: WorkerRun;
  readonly queuedDeliveryIds: readonly string[];
}

export interface WorkerAttentionService extends WorkerAttentionPort {
  processDeadline(input: {
    readonly workspaceId: string;
    readonly attentionRequestId: string;
    readonly kind: WorkerAttentionDeadlineKind;
    readonly now?: Date;
  }): Promise<WorkerAttentionDeadlineResult>;
}

export function createWorkerAttentionService(
  dependencies: WorkerAttentionServiceDependencies = {},
): WorkerAttentionService {
  const mutateStore = dependencies.mutateStore ?? defaultMutateStore;
  const now = dependencies.now ?? (() => new Date());
  const id = dependencies.id ?? ((kind: WorkerAttentionIdKind) => `${kind}_${randomUUID()}`);

  return {
    async resolve(input) {
      assertApprovalDecision(input);
      return await mutateStore((data) => {
        validateWorkerPersistence(data);
        const timestamp = input.requestedAt.toISOString();
        const run = requireFencedRun(data, input, input.requestedAt);
        const version = requireVersion(data, run);
        const deployment = data.workerDeployments.find(
          (record) =>
            record.workspaceId === run.workspaceId && record.id === run.workerDeploymentId,
        );
        if (
          !deployment?.compiledPolicy ||
          deployment.compiledPolicy.policyDigest !== input.policyDecision.policyDigest ||
          deployment.compiledPolicy.workerVersionContentDigest !== version.contentDigest
        ) {
          throw new WorkerLifecycleError(
            "conflict",
            "Worker approval decision no longer matches the deployed policy.",
          );
        }
        if (
          !deployment.compiledPolicy.capabilities.some(
            (capability) =>
              capability.capabilityId === input.policyDecision.capabilityId &&
              capability.tool === input.policyDecision.tool &&
              capability.verb === input.policyDecision.verb &&
              capability.effect === input.policyDecision.effect &&
              capability.approval === "always",
          )
        ) {
          throw new WorkerLifecycleError(
            "conflict",
            "Worker approval decision is not required by the deployed capability.",
          );
        }

        const reusable = findReusableRunGrant(data, input, timestamp);
        if (reusable) {
          validateWorkerPersistence(data);
          return {
            disposition: "approved" as const,
            approval: approvalEvidence(reusable, input.actionId),
          };
        }

        const requestKey = attentionRequestKey(input);
        const existing = data.workerAttentionRequests.find(
          (record) => record.workspaceId === run.workspaceId && record.requestKey === requestKey,
        );
        if (existing) {
          assertAttentionDecisionBinding(existing, input);
          const approval = claimAttentionGrant(data, existing, input.actionId, timestamp);
          if (approval) {
            validateWorkerPersistence(data);
            return {
              disposition: "approved" as const,
              approval,
            };
          }
          if (
            existing.status === "open" &&
            Date.parse(existing.expiresAt) > input.requestedAt.getTime()
          ) {
            const waiting = persistWaitingRun(data, input, existing, version, id);
            validateWorkerPersistence(data);
            return waiting;
          }
          const halted = haltForResolvedAttention(data, run, existing, timestamp, id("event"));
          validateWorkerPersistence(data);
          return halted;
        }

        const attention = makeAttentionRequest(
          id("attention"),
          requestKey,
          input,
          version,
          timestamp,
        );
        data.workerAttentionRequests.push(attention);
        queueAttentionDeliveries(data, attention, version, "requested", timestamp, id);
        queueDeadlineJobs(data, attention, version, timestamp, id);
        const waiting = persistWaitingRun(data, input, attention, version, id);
        validateWorkerPersistence(data);
        return waiting;
      });
    },

    async processDeadline(input) {
      return await mutateStore((data) => {
        validateWorkerPersistence(data);
        const timestamp = (input.now ?? now()).toISOString();
        const attention = requireAttention(data, input.workspaceId, input.attentionRequestId);
        const run = requireRun(data, attention.workspaceId, attention.workerRunId);
        const version = requireVersion(data, run);
        const queuedDeliveryIds: string[] = [];

        if (input.kind === "escalate") {
          if (
            attention.status === "open" &&
            attention.escalatesAt &&
            Date.parse(timestamp) >= Date.parse(attention.escalatesAt)
          ) {
            queuedDeliveryIds.push(
              ...queueAttentionDeliveries(data, attention, version, "escalated", timestamp, id),
            );
            if (queuedDeliveryIds.length > 0) {
              appendAttentionEvent(
                data,
                id("event"),
                run,
                "worker.attention.escalated",
                "Worker approval attention reached its escalation deadline.",
                attention,
                timestamp,
                { queuedDeliveryIds },
              );
            }
          }
          validateWorkerPersistence(data);
          return clone({ attention, run, queuedDeliveryIds });
        }

        if (Date.parse(timestamp) < Date.parse(attention.expiresAt)) {
          return clone({ attention, run, queuedDeliveryIds });
        }

        const expiredAttention =
          attention.status === "open"
            ? {
                ...attention,
                status: "expired" as const,
                resolvedAt: timestamp,
                resolvedBy: ATTENTION_SYSTEM_ACTOR,
              }
            : attention;
        if (expiredAttention !== attention) {
          replaceAttention(data, expiredAttention);
        }
        const expiredGrantCount = expireApprovalGrants(
          data,
          attention.workspaceId,
          attention.id,
          timestamp,
        );

        let nextRun = run;
        if (
          !isTerminalWorkerRunStatus(run.status) &&
          latestCheckpoint(data, run)?.pendingApprovalIds.includes(attention.id)
        ) {
          nextRun = expireWaitingRun(run, attention, timestamp);
          replaceRun(data, nextRun);
          cancelExecutionJobs(data, run, timestamp);
        }
        if (expiredAttention === attention && expiredGrantCount === 0 && nextRun === run) {
          return clone({ attention, run, queuedDeliveryIds });
        }
        appendAttentionEvent(
          data,
          id("event"),
          nextRun,
          "worker.attention.expired",
          "Worker approval attention expired without authorization.",
          expiredAttention,
          timestamp,
          {
            expirationDisposition: attention.expirationDisposition,
            runStatus: nextRun.status,
          },
        );
        validateWorkerPersistence(data);
        return clone({
          attention: expiredAttention,
          run: nextRun,
          queuedDeliveryIds,
        });
      });
    },
  };
}

export function createWorkerAttentionDeadlineJobHandler(
  service: WorkerAttentionService = createWorkerAttentionService(),
): {
  handle(job: JobRecord): Promise<WorkerAttentionDeadlineResult>;
} {
  return {
    async handle(job) {
      if (job.type !== WORKER_ATTENTION_DEADLINE_JOB_TYPE) {
        throw new Error(`Unsupported Worker attention job type ${job.type}.`);
      }
      const attentionRequestId = requiredPayloadString(job, "attentionRequestId");
      const kind = requiredPayloadString(job, "kind");
      if (kind !== "escalate" && kind !== "expire") {
        throw new Error("Worker attention deadline job has an invalid kind.");
      }
      return await service.processDeadline({
        workspaceId: job.workspaceId,
        attentionRequestId,
        kind,
      });
    },
  };
}

function assertApprovalDecision(input: WorkerAttentionResolutionInput): void {
  const decision = input.policyDecision;
  if (
    decision.allowed ||
    decision.code !== "approval_required" ||
    !decision.capabilityId ||
    !decision.policyDigest ||
    !/^sha256:[a-f0-9]{64}$/.test(decision.operationDigest) ||
    !/^sha256:[a-f0-9]{64}$/.test(decision.policyDigest) ||
    !input.actionId
  ) {
    throw new WorkerLifecycleError(
      "invalid_input",
      "Worker attention requires a complete approval-required policy decision.",
    );
  }
}

function requireFencedRun(
  data: PacketAgentData,
  input: WorkerAttentionResolutionInput,
  timestamp: Date,
): WorkerRun {
  const run = requireRun(data, input.workspaceId, input.workerRunId);
  if (
    run.status !== "running" ||
    run.revision !== input.expectedRunRevision ||
    run.workerVersionId !== input.workerVersionId ||
    run.workerVersionId !== input.context.version.id ||
    run.workerDeploymentId !== input.context.deployment.id ||
    run.workerDefinitionId !== input.context.definition.id ||
    !run.runtimeLease ||
    run.runtimeLease.fencingToken !== input.fencingToken ||
    Date.parse(run.runtimeLease.expiresAt) <= timestamp.getTime()
  ) {
    throw new WorkerLifecycleError(
      "conflict",
      "Worker attention request lost its run revision or execution fence.",
    );
  }
  return run;
}

function requireRun(data: PacketAgentData, workspaceId: string, workerRunId: string): WorkerRun {
  const run = data.workerRuns.find(
    (record) => record.workspaceId === workspaceId && record.id === workerRunId,
  );
  if (!run) {
    throw new WorkerLifecycleError("not_found", `WorkerRun ${workerRunId} was not found.`);
  }
  return run;
}

function requireVersion(data: PacketAgentData, run: WorkerRun): WorkerVersion {
  const version = data.workerVersions.find(
    (record) => record.workspaceId === run.workspaceId && record.id === run.workerVersionId,
  );
  if (!version) {
    throw new WorkerLifecycleError(
      "integrity",
      `WorkerVersion ${run.workerVersionId} was not found.`,
    );
  }
  return version;
}

function requireAttention(
  data: PacketAgentData,
  workspaceId: string,
  attentionRequestId: string,
): WorkerAttentionRequest {
  const attention = data.workerAttentionRequests.find(
    (record) => record.workspaceId === workspaceId && record.id === attentionRequestId,
  );
  if (!attention) {
    throw new WorkerLifecycleError(
      "not_found",
      `WorkerAttentionRequest ${attentionRequestId} was not found.`,
    );
  }
  return attention;
}

function attentionRequestKey(input: WorkerAttentionResolutionInput): string {
  return digest({
    workspaceId: input.workspaceId,
    workerRunId: input.workerRunId,
    workerVersionId: input.workerVersionId,
    workerVersionContentDigest: input.context.version.contentDigest,
    workerDeploymentId: input.context.deployment.id,
    actionId: input.actionId,
    capabilityId: input.policyDecision.capabilityId,
    operationDigest: input.policyDecision.operationDigest,
    policyDigest: input.policyDecision.policyDigest,
  });
}

function makeAttentionRequest(
  attentionId: string,
  requestKey: string,
  input: WorkerAttentionResolutionInput,
  version: WorkerVersion,
  timestamp: string,
): WorkerAttentionRequest {
  const policy = version.content.policy.attention;
  const requestedAtMs = Date.parse(timestamp);
  const notificationRouteIds = version.content.notificationRoutes
    .filter((route) => route.events.includes("attention"))
    .map((route) => route.id);
  return {
    schemaVersion: WORKER_ATTENTION_REQUEST_SCHEMA_VERSION,
    id: attentionId,
    requestKey,
    workspaceId: input.workspaceId,
    workerDefinitionId: input.context.definition.id,
    workerDeploymentId: input.context.deployment.id,
    workerRunId: input.workerRunId,
    workerVersionId: input.workerVersionId,
    workerVersionContentDigest: version.contentDigest,
    status: "open",
    capabilityId: input.policyDecision.capabilityId!,
    operationDigest: input.policyDecision.operationDigest,
    policyDigest: input.policyDecision.policyDigest!,
    expirationDisposition: policy.onExpiration,
    requestedBy: ATTENTION_SYSTEM_ACTOR,
    requestedAt: timestamp,
    ...(policy.escalationAfterMs !== undefined
      ? {
          escalatesAt: new Date(requestedAtMs + policy.escalationAfterMs).toISOString(),
        }
      : {}),
    expiresAt: new Date(requestedAtMs + policy.approvalTimeoutMs).toISOString(),
    notificationRouteIds,
  };
}

function findReusableRunGrant(
  data: PacketAgentData,
  input: WorkerAttentionResolutionInput,
  timestamp: string,
): WorkerApprovalGrant | undefined {
  const matching = data.workerApprovalGrants
    .filter(
      (grant) =>
        grant.workspaceId === input.workspaceId &&
        grant.workerRunId === input.workerRunId &&
        grant.workerVersionId === input.workerVersionId &&
        grant.workerVersionContentDigest === input.context.version.contentDigest &&
        grant.workerDeploymentId === input.context.deployment.id &&
        grant.capabilityId === input.policyDecision.capabilityId &&
        grant.operationDigest === input.policyDecision.operationDigest &&
        grant.policyDigest === input.policyDecision.policyDigest &&
        grant.scope === "run",
    )
    .sort((left, right) => left.grantedAt.localeCompare(right.grantedAt));
  for (const grant of matching) {
    if (grant.status === "active" && Date.parse(grant.expiresAt) > Date.parse(timestamp)) {
      return grant;
    }
    if (grant.status === "active" && Date.parse(grant.expiresAt) <= Date.parse(timestamp)) {
      replaceGrant(data, {
        ...grant,
        status: "expired",
        expiredAt: timestamp,
      });
    }
  }
  return undefined;
}

function claimAttentionGrant(
  data: PacketAgentData,
  attention: WorkerAttentionRequest,
  actionId: string,
  timestamp: string,
): WorkerToolApprovalEvidence | undefined {
  if (attention.status !== "approved") return undefined;
  const grants = data.workerApprovalGrants.filter(
    (grant) =>
      grant.workspaceId === attention.workspaceId &&
      grant.attentionRequestId === attention.id &&
      grant.capabilityId === attention.capabilityId &&
      grant.operationDigest === attention.operationDigest &&
      grant.policyDigest === attention.policyDigest,
  );
  for (const grant of grants) {
    if (
      grant.status === "consumed" &&
      grant.scope === "once" &&
      grant.consumedByActionId === actionId
    ) {
      return approvalEvidence(grant, actionId);
    }
    if (grant.status !== "active") continue;
    if (Date.parse(grant.expiresAt) <= Date.parse(timestamp)) {
      replaceGrant(data, {
        ...grant,
        status: "expired",
        expiredAt: timestamp,
      });
      continue;
    }
    if (grant.scope === "once") {
      const consumed: WorkerApprovalGrant = {
        ...grant,
        status: "consumed",
        consumedAt: timestamp,
        consumedByActionId: actionId,
      };
      replaceGrant(data, consumed);
      return approvalEvidence(consumed, actionId);
    }
    return approvalEvidence(grant, actionId);
  }
  return undefined;
}

function approvalEvidence(
  grant: WorkerApprovalGrant,
  actionId: string,
): WorkerToolApprovalEvidence {
  return {
    grantId: grant.id,
    attentionRequestId: grant.attentionRequestId,
    actionId,
    capabilityId: grant.capabilityId,
    operationDigest: grant.operationDigest,
    policyDigest: grant.policyDigest,
    scope: grant.scope,
    expiresAt: grant.expiresAt,
  };
}

function assertAttentionDecisionBinding(
  attention: WorkerAttentionRequest,
  input: WorkerAttentionResolutionInput,
): void {
  if (
    attention.workerDefinitionId !== input.context.definition.id ||
    attention.workerDeploymentId !== input.context.deployment.id ||
    attention.workerRunId !== input.workerRunId ||
    attention.workerVersionId !== input.workerVersionId ||
    attention.workerVersionContentDigest !== input.context.version.contentDigest ||
    attention.capabilityId !== input.policyDecision.capabilityId ||
    attention.operationDigest !== input.policyDecision.operationDigest ||
    attention.policyDigest !== input.policyDecision.policyDigest
  ) {
    throw new WorkerLifecycleError(
      "integrity",
      "Worker attention request does not match the pending operation.",
    );
  }
}

function persistWaitingRun(
  data: PacketAgentData,
  input: WorkerAttentionResolutionInput,
  attention: WorkerAttentionRequest,
  version: WorkerVersion,
  id: WorkerAttentionIdFactory,
): Extract<WorkerAttentionResolution, { disposition: "waiting" }> {
  const run = requireRun(data, input.workspaceId, input.workerRunId);
  const previous = latestCheckpoint(data, run);
  const currentSequence = previous?.sequence ?? -1;
  if (currentSequence !== input.expectedCheckpointSequence) {
    throw new WorkerLifecycleError(
      "conflict",
      `Worker checkpoint sequence changed from expected ${input.expectedCheckpointSequence} to ${currentSequence}.`,
    );
  }
  const timestamp = input.requestedAt.toISOString();
  const pendingApprovalIds = [...new Set([...input.pendingApprovalIds, attention.id])];
  const remainingBudget = remainingWorkerBudget(
    {
      ...version.content.policy.budgets,
      maxConsecutiveFailures: Math.min(
        version.content.policy.budgets.maxConsecutiveFailures,
        version.content.policy.retry.maxAttempts,
      ),
    },
    input.budgetUsage,
  );
  if (previous) {
    assertRemainingBudgetDidNotIncrease(previous.remainingBudget, remainingBudget);
  }
  const checkpointContent: Omit<WorkerCheckpoint, "stateDigest"> = {
    schemaVersion: WORKER_CONTRACT_SCHEMA_VERSION,
    id: id("checkpoint"),
    workspaceId: input.workspaceId,
    workerRunId: input.workerRunId,
    workerVersionId: input.workerVersionId,
    sequence: currentSequence + 1,
    ...(previous ? { previousCheckpointId: previous.id } : {}),
    cursor: input.cursor,
    workingMemory: input.workingMemory,
    completedActionIds: [...input.completedActionIds],
    pendingApprovalIds,
    artifactRefs: [...input.artifactRefs],
    effectReceiptIds: [...input.effectReceiptIds],
    remainingBudget,
    ...(run.trace ? { trace: run.trace } : {}),
    createdAt: timestamp,
  };
  const checkpoint: WorkerCheckpoint = {
    ...checkpointContent,
    stateDigest: workerCheckpointStateDigest(checkpointContent),
  };
  const { runtimeLease: _released, ...withoutLease } = run;
  const nextRun: WorkerRun = {
    ...withoutLease,
    status: "waiting_for_approval",
    revision: run.revision + 1,
    latestCheckpointId: checkpoint.id,
    budgetUsage: input.budgetUsage,
    updatedAt: timestamp,
  };
  assertWorkerRunUpdate(run, nextRun);
  data.workerCheckpoints.push(checkpoint);
  replaceRun(data, nextRun);
  appendAttentionEvent(
    data,
    id("event"),
    nextRun,
    "worker.attention.requested",
    "Worker execution is waiting for operation approval.",
    attention,
    timestamp,
    {
      checkpointId: checkpoint.id,
      checkpointSequence: checkpoint.sequence,
      capabilityId: attention.capabilityId,
      operationDigest: attention.operationDigest,
      policyDigest: attention.policyDigest,
    },
  );
  return {
    disposition: "waiting",
    attention: clone(attention),
    run: clone(nextRun),
    checkpointId: checkpoint.id,
    checkpointSequence: checkpoint.sequence,
    runRevision: nextRun.revision,
  };
}

function haltForResolvedAttention(
  data: PacketAgentData,
  run: WorkerRun,
  attention: WorkerAttentionRequest,
  timestamp: string,
  eventId: string,
): Extract<WorkerAttentionResolution, { disposition: "halted" }> {
  let resolvedAttention = attention;
  if (attention.status === "open" && Date.parse(attention.expiresAt) <= Date.parse(timestamp)) {
    resolvedAttention = {
      ...attention,
      status: "expired",
      resolvedAt: timestamp,
      resolvedBy: ATTENTION_SYSTEM_ACTOR,
    };
    replaceAttention(data, resolvedAttention);
  }
  const nextRun =
    resolvedAttention.status === "rejected"
      ? rejectRun(run, "approval_rejected", timestamp)
      : expireWaitingRun(run, resolvedAttention, timestamp);
  if (nextRun !== run) {
    replaceRun(data, nextRun);
    cancelExecutionJobs(data, run, timestamp);
  }
  appendAttentionEvent(
    data,
    eventId,
    nextRun,
    "worker.attention.halted",
    "Worker execution stopped because approval was unavailable.",
    resolvedAttention,
    timestamp,
    {
      attentionStatus: resolvedAttention.status,
      runStatus: nextRun.status,
    },
  );
  return {
    disposition: "halted",
    attention: clone(resolvedAttention),
    run: clone(nextRun),
  };
}

function expireWaitingRun(
  run: WorkerRun,
  attention: WorkerAttentionRequest,
  timestamp: string,
): WorkerRun {
  if (isTerminalWorkerRunStatus(run.status)) return run;
  if (attention.expirationDisposition === "reject") {
    return rejectRun(run, "approval_expired", timestamp);
  }
  const { runtimeLease: _released, ...withoutLease } = run;
  const next: WorkerRun = {
    ...withoutLease,
    status: "paused",
    revision: run.revision + 1,
    updatedAt: timestamp,
  };
  assertWorkerRunUpdate(run, next);
  return next;
}

function rejectRun(
  run: WorkerRun,
  reason: "approval_rejected" | "approval_expired",
  timestamp: string,
): WorkerRun {
  if (isTerminalWorkerRunStatus(run.status)) return run;
  const { runtimeLease: _released, ...withoutLease } = run;
  const next: WorkerRun = {
    ...withoutLease,
    status: "failed",
    revision: run.revision + 1,
    terminalReason: reason,
    error:
      reason === "approval_rejected"
        ? "Worker operation approval was rejected."
        : "Worker operation approval expired.",
    updatedAt: timestamp,
    completedAt: timestamp,
  };
  assertWorkerRunUpdate(run, next);
  return next;
}

function queueAttentionDeliveries(
  data: PacketAgentData,
  attention: WorkerAttentionRequest,
  version: WorkerVersion,
  stage: "requested" | "escalated",
  timestamp: string,
  id: WorkerAttentionIdFactory,
): string[] {
  const queued: string[] = [];
  for (const routeId of attention.notificationRouteIds) {
    const route = version.content.notificationRoutes.find((record) => record.id === routeId);
    if (!route || !route.events.includes("attention")) continue;
    const deliveryKey = `${attention.id}:${route.id}:${stage}`;
    if (
      data.workerNotificationDeliveries.some(
        (record) =>
          record.workspaceId === attention.workspaceId && record.deliveryKey === deliveryKey,
      )
    ) {
      continue;
    }
    const delivery: WorkerNotificationDeliveryReference = {
      schemaVersion: WORKER_NOTIFICATION_DELIVERY_SCHEMA_VERSION,
      id: id("delivery"),
      deliveryKey,
      workspaceId: attention.workspaceId,
      workerDefinitionId: attention.workerDefinitionId,
      workerDeploymentId: attention.workerDeploymentId,
      workerRunId: attention.workerRunId,
      workerVersionId: attention.workerVersionId,
      workerVersionContentDigest: attention.workerVersionContentDigest,
      event: "attention",
      attentionRequestId: attention.id,
      notificationRouteId: route.id,
      notificationRouteKind: route.kind,
      notificationRouteReference: route.reference,
      status: "queued",
      attemptCount: 0,
      scheduledAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    data.workerNotificationDeliveries.push(delivery);
    queued.push(delivery.id);
  }
  return queued;
}

function queueDeadlineJobs(
  data: PacketAgentData,
  attention: WorkerAttentionRequest,
  version: WorkerVersion,
  timestamp: string,
  id: WorkerAttentionIdFactory,
): void {
  if (attention.escalatesAt) {
    data.jobs.push(
      makeDeadlineJob(id("job"), attention, version, "escalate", attention.escalatesAt, timestamp),
    );
  }
  data.jobs.push(
    makeDeadlineJob(id("job"), attention, version, "expire", attention.expiresAt, timestamp),
  );
}

function makeDeadlineJob(
  jobId: string,
  attention: WorkerAttentionRequest,
  version: WorkerVersion,
  kind: WorkerAttentionDeadlineKind,
  scheduledAt: string,
  timestamp: string,
): JobRecord {
  return {
    id: jobId,
    workspaceId: attention.workspaceId,
    type: WORKER_ATTENTION_DEADLINE_JOB_TYPE,
    payload: {
      attentionRequestId: attention.id,
      workerRunId: attention.workerRunId,
      kind,
    },
    status: "queued",
    attempts: 0,
    maxAttempts: Math.max(1, version.content.policy.retry.maxAttempts),
    scheduledAt,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function expireApprovalGrants(
  data: PacketAgentData,
  workspaceId: string,
  attentionRequestId: string,
  timestamp: string,
): number {
  let expired = 0;
  for (const grant of data.workerApprovalGrants.filter(
    (record) =>
      record.workspaceId === workspaceId &&
      record.attentionRequestId === attentionRequestId &&
      record.status === "active" &&
      Date.parse(record.expiresAt) <= Date.parse(timestamp),
  )) {
    replaceGrant(data, {
      ...grant,
      status: "expired",
      expiredAt: timestamp,
    });
    expired += 1;
  }
  return expired;
}

function latestCheckpoint(data: PacketAgentData, run: WorkerRun): WorkerCheckpoint | undefined {
  if (!run.latestCheckpointId) return undefined;
  return data.workerCheckpoints.find(
    (record) =>
      record.workspaceId === run.workspaceId &&
      record.workerRunId === run.id &&
      record.id === run.latestCheckpointId,
  );
}

function assertRemainingBudgetDidNotIncrease(
  previous: WorkerRemainingBudget,
  next: WorkerRemainingBudget,
): void {
  for (const key of Object.keys(previous) as Array<keyof WorkerRemainingBudget>) {
    if (next[key] > previous[key] + Number.EPSILON) {
      throw new WorkerLifecycleError(
        "conflict",
        `Worker checkpoint remaining ${key} cannot increase.`,
      );
    }
  }
}

function cancelExecutionJobs(data: PacketAgentData, run: WorkerRun, timestamp: string): void {
  for (let index = 0; index < data.jobs.length; index += 1) {
    const job = data.jobs[index]!;
    if (
      job.workspaceId !== run.workspaceId ||
      job.type !== "worker.run" ||
      job.payload.workerRunId !== run.id
    ) {
      continue;
    }
    if (job.status === "queued") {
      data.jobs[index] = {
        ...job,
        status: "canceled",
        cancelRequested: true,
        completedAt: timestamp,
        updatedAt: timestamp,
      };
    } else if (job.status === "running") {
      data.jobs[index] = {
        ...job,
        cancelRequested: true,
        updatedAt: timestamp,
      };
    }
  }
}

function appendAttentionEvent(
  data: PacketAgentData,
  eventId: string,
  run: WorkerRun,
  type: string,
  summary: string,
  attention: WorkerAttentionRequest,
  occurredAt: string,
  eventData: Record<string, unknown>,
): void {
  const event: WorkerEvent = {
    schemaVersion: WORKER_EVENT_SCHEMA_VERSION,
    id: eventId,
    workspaceId: run.workspaceId,
    sequence:
      data.workerEvents
        .filter((record) => record.workspaceId === run.workspaceId)
        .reduce((maximum, record) => Math.max(maximum, record.sequence), 0) + 1,
    type,
    workerDefinitionId: run.workerDefinitionId,
    workerVersionId: run.workerVersionId,
    workerDeploymentId: run.workerDeploymentId,
    actor: ATTENTION_SYSTEM_ACTOR,
    summary,
    data: {
      workerRunId: run.id,
      attentionRequestId: attention.id,
      ...eventData,
    },
    occurredAt,
  };
  data.workerEvents.push(event);
}

function replaceRun(data: PacketAgentData, next: WorkerRun): void {
  const index = data.workerRuns.findIndex(
    (record) => record.workspaceId === next.workspaceId && record.id === next.id,
  );
  if (index < 0) {
    throw new WorkerLifecycleError("integrity", `WorkerRun ${next.id} disappeared.`);
  }
  data.workerRuns[index] = next;
}

function replaceAttention(data: PacketAgentData, next: WorkerAttentionRequest): void {
  const index = data.workerAttentionRequests.findIndex(
    (record) => record.workspaceId === next.workspaceId && record.id === next.id,
  );
  if (index < 0) {
    throw new WorkerLifecycleError("integrity", `WorkerAttentionRequest ${next.id} disappeared.`);
  }
  data.workerAttentionRequests[index] = next;
}

function replaceGrant(data: PacketAgentData, next: WorkerApprovalGrant): void {
  if (next.schemaVersion !== WORKER_APPROVAL_GRANT_SCHEMA_VERSION) {
    throw new WorkerLifecycleError(
      "integrity",
      "Worker approval grant schema changed during consumption.",
    );
  }
  const index = data.workerApprovalGrants.findIndex(
    (record) => record.workspaceId === next.workspaceId && record.id === next.id,
  );
  if (index < 0) {
    throw new WorkerLifecycleError("integrity", `WorkerApprovalGrant ${next.id} disappeared.`);
  }
  data.workerApprovalGrants[index] = next;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalWorkerJson(value)).digest("hex")}`;
}

function requiredPayloadString(job: JobRecord, key: string): string {
  const value = job.payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Worker attention deadline job is missing ${key}.`);
  }
  return value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
