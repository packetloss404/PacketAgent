import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  mutateStoreAsync as defaultMutateStore,
  type JobRecord,
  type PacketAgentData,
} from "../packetagent-store.js";
import { WorkerLifecycleError } from "./errors.js";
import {
  WORKER_APPROVAL_GRANT_SCHEMA_VERSION,
  WORKER_CONTROL_COMMAND_SCHEMA_VERSION,
  type WorkerApprovalGrant,
  type WorkerApprovalScope,
  type WorkerAttentionRequest,
  type WorkerControlCommand,
  type WorkerControlCommandKind,
} from "./control-types.js";
import { WORKER_EVENT_SCHEMA_VERSION, type WorkerEvent } from "./persistence-types.js";
import { validateWorkerPersistence } from "./repository.js";
import {
  assertWorkerDeploymentUpdate,
  assertWorkerRunUpdate,
  isTerminalWorkerRunStatus,
} from "./transitions.js";
import type { WorkerActorReference, WorkerDeployment, WorkerRun, WorkerVersion } from "./types.js";
import { canonicalWorkerJson } from "./validation.js";

type MaybePromise<T> = T | Promise<T>;

const CONTROL_SYSTEM_ACTOR = {
  type: "system" as const,
  id: "packetagent.worker-control",
  displayName: "PacketAgent Worker Control",
};

const RUN_CONTROL_KINDS = ["pause_run", "resume_run", "stop_run"] as const;
const ATTENTION_CONTROL_KINDS = ["approve_once", "approve_for_run", "reject_attention"] as const;
const REVOCABLE_DEPLOYMENT_STATUSES: ReadonlySet<WorkerDeployment["status"]> = new Set([
  "deployed",
  "active",
  "paused",
  "attention",
]);

export type WorkerControlCommitPhase =
  | "after_command_insert"
  | "after_target_update"
  | "after_event_append";

export interface WorkerControlServiceDependencies {
  readonly mutateStore?: <T>(
    mutator: (data: PacketAgentData) => MaybePromise<T>,
  ) => MaybePromise<T>;
  readonly now?: () => Date;
  readonly id?: (kind: "command" | "approval" | "event" | "job") => string;
  readonly nonce?: () => string;
  readonly onCommitPhase?: (phase: WorkerControlCommitPhase) => void;
}

export interface WorkerControlContext {
  readonly workspaceId: string;
  readonly actor: WorkerActorReference;
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
}

export interface WorkerRunControlInput extends WorkerControlContext {
  readonly workerRunId: string;
}

export interface WorkerDeploymentControlInput extends WorkerControlContext {
  readonly workerDeploymentId: string;
}

export interface WorkerAttentionControlInput extends WorkerControlContext {
  readonly attentionRequestId: string;
  readonly expiresAt?: string;
}

export interface WorkerControlResult {
  readonly disposition: "applied" | "rejected" | "replayed";
  readonly command: WorkerControlCommand;
  readonly run?: WorkerRun;
  readonly deployment?: WorkerDeployment;
  readonly attentionRequest?: WorkerAttentionRequest;
  readonly approvalGrant?: WorkerApprovalGrant;
  readonly approvalNonce?: string;
  readonly executionJobId?: string;
  readonly affectedRunIds?: readonly string[];
}

export interface WorkerControlService {
  pauseRun(input: WorkerRunControlInput): Promise<WorkerControlResult>;
  resumeRun(input: WorkerRunControlInput): Promise<WorkerControlResult>;
  stopRun(input: WorkerRunControlInput): Promise<WorkerControlResult>;
  revokeDeployment(input: WorkerDeploymentControlInput): Promise<WorkerControlResult>;
  approveOnce(input: WorkerAttentionControlInput): Promise<WorkerControlResult>;
  approveForRun(input: WorkerAttentionControlInput): Promise<WorkerControlResult>;
  rejectAttention(input: WorkerAttentionControlInput): Promise<WorkerControlResult>;
}

interface NormalizedControlRequest {
  readonly workspaceId: string;
  readonly actor: WorkerActorReference;
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  readonly kind: WorkerControlCommandKind;
  readonly targetId: string;
  readonly expiresAt?: string;
}

interface ResolvedControlTarget {
  readonly definitionId: string;
  readonly deployment: WorkerDeployment;
  readonly version: WorkerVersion;
  readonly run?: WorkerRun;
  readonly attention?: WorkerAttentionRequest;
}

interface ApplyResult {
  readonly command: WorkerControlCommand;
  readonly approvalNonce?: string;
  readonly affectedRunIds?: readonly string[];
}

export function createWorkerControlService(
  dependencies: WorkerControlServiceDependencies = {},
): WorkerControlService {
  const mutateStore = dependencies.mutateStore ?? defaultMutateStore;
  const now = dependencies.now ?? (() => new Date());
  const id =
    dependencies.id ??
    ((kind: "command" | "approval" | "event" | "job") => `${kind}_${randomUUID()}`);
  const nonce = dependencies.nonce ?? (() => randomBytes(32).toString("base64url"));
  const onCommitPhase = dependencies.onCommitPhase ?? (() => undefined);

  const execute = async (request: NormalizedControlRequest): Promise<WorkerControlResult> => {
    assertControlRequest(request);
    return await mutateStore((data) => {
      validateWorkerPersistence(data);
      const requestDigest = workerControlRequestDigest(request);
      const existing = data.workerControlCommands.find(
        (record) =>
          record.workspaceId === request.workspaceId &&
          record.idempotencyKey === request.idempotencyKey,
      );
      if (existing) {
        if (existing.requestDigest !== requestDigest) {
          throw new WorkerLifecycleError(
            "idempotency_mismatch",
            "Worker control idempotency key was reused with a different request.",
          );
        }
        return controlResult(data, existing, "replayed");
      }

      const target = resolveControlTarget(data, request);
      const timestamp = now().toISOString();
      const pending = makePendingCommand(id("command"), request, requestDigest, target, timestamp);
      data.workerControlCommands.push(pending);
      onCommitPhase("after_command_insert");

      const applied = applyControlCommand({
        data,
        request,
        target,
        pending,
        timestamp,
        id,
        nonce,
      });
      onCommitPhase("after_target_update");
      appendControlEvent(data, id("event"), applied.command, applied.affectedRunIds);
      onCommitPhase("after_event_append");
      validateWorkerPersistence(data);
      return controlResult(
        data,
        applied.command,
        applied.command.status === "applied" ? "applied" : "rejected",
        applied,
      );
    });
  };

  return {
    pauseRun(input) {
      return execute(runRequest("pause_run", input));
    },
    resumeRun(input) {
      return execute(runRequest("resume_run", input));
    },
    stopRun(input) {
      return execute(runRequest("stop_run", input));
    },
    revokeDeployment(input) {
      return execute({
        ...input,
        kind: "revoke_deployment",
        targetId: input.workerDeploymentId,
      });
    },
    approveOnce(input) {
      return execute(attentionRequest("approve_once", input));
    },
    approveForRun(input) {
      return execute(attentionRequest("approve_for_run", input));
    },
    rejectAttention(input) {
      return execute(attentionRequest("reject_attention", input));
    },
  };
}

export function workerControlRequestDigest(request: NormalizedControlRequest): string {
  return digest({
    workspaceId: request.workspaceId,
    kind: request.kind,
    targetId: request.targetId,
    expectedRevision: request.expectedRevision,
    actor: request.actor,
    expiresAt: request.expiresAt ?? null,
  });
}

function runRequest(
  kind: (typeof RUN_CONTROL_KINDS)[number],
  input: WorkerRunControlInput,
): NormalizedControlRequest {
  return {
    ...input,
    kind,
    targetId: input.workerRunId,
  };
}

function attentionRequest(
  kind: (typeof ATTENTION_CONTROL_KINDS)[number],
  input: WorkerAttentionControlInput,
): NormalizedControlRequest {
  return {
    ...input,
    kind,
    targetId: input.attentionRequestId,
  };
}

function assertControlRequest(request: NormalizedControlRequest): void {
  if (
    !request.workspaceId ||
    !request.targetId ||
    !request.idempotencyKey ||
    !Number.isSafeInteger(request.expectedRevision) ||
    request.expectedRevision < 1
  ) {
    throw new WorkerLifecycleError(
      "invalid_input",
      "Worker control requires a workspace, target, idempotency key, and positive expected revision.",
    );
  }
  if (request.expiresAt !== undefined && !isCanonicalTimestamp(request.expiresAt)) {
    throw new WorkerLifecycleError(
      "invalid_input",
      "Worker approval expiry must be a canonical timestamp.",
    );
  }
}

function resolveControlTarget(
  data: PacketAgentData,
  request: NormalizedControlRequest,
): ResolvedControlTarget {
  if (RUN_CONTROL_KINDS.includes(request.kind as (typeof RUN_CONTROL_KINDS)[number])) {
    const run = requireRun(data, request.workspaceId, request.targetId);
    return resolveRunTarget(data, run);
  }
  if (request.kind === "revoke_deployment") {
    const deployment = requireDeployment(data, request.workspaceId, request.targetId);
    return {
      definitionId: deployment.workerDefinitionId,
      deployment,
      version: requireVersion(data, request.workspaceId, deployment.workerVersionId),
    };
  }
  const attention = data.workerAttentionRequests.find(
    (record) => record.workspaceId === request.workspaceId && record.id === request.targetId,
  );
  if (!attention) {
    throw new WorkerLifecycleError(
      "not_found",
      `Worker attention request ${request.targetId} was not found.`,
    );
  }
  const run = requireRun(data, request.workspaceId, attention.workerRunId);
  return {
    ...resolveRunTarget(data, run),
    attention,
  };
}

function resolveRunTarget(data: PacketAgentData, run: WorkerRun): ResolvedControlTarget {
  const deployment = requireDeployment(data, run.workspaceId, run.workerDeploymentId);
  const version = requireVersion(data, run.workspaceId, run.workerVersionId);
  if (
    deployment.workerDefinitionId !== run.workerDefinitionId ||
    deployment.workerVersionId !== run.workerVersionId ||
    version.workerDefinitionId !== run.workerDefinitionId
  ) {
    throw new WorkerLifecycleError(
      "integrity",
      `WorkerRun ${run.id} has inconsistent control bindings.`,
    );
  }
  return {
    definitionId: run.workerDefinitionId,
    deployment,
    version,
    run,
  };
}

function makePendingCommand(
  commandId: string,
  request: NormalizedControlRequest,
  requestDigest: string,
  target: ResolvedControlTarget,
  timestamp: string,
): WorkerControlCommand {
  const runCommand = RUN_CONTROL_KINDS.includes(request.kind as (typeof RUN_CONTROL_KINDS)[number]);
  const attentionCommand = ATTENTION_CONTROL_KINDS.includes(
    request.kind as (typeof ATTENTION_CONTROL_KINDS)[number],
  );
  return {
    schemaVersion: WORKER_CONTROL_COMMAND_SCHEMA_VERSION,
    id: commandId,
    workspaceId: request.workspaceId,
    workerDefinitionId: target.definitionId,
    workerDeploymentId: target.deployment.id,
    workerVersionId: target.version.id,
    workerVersionContentDigest: target.version.contentDigest,
    ...(runCommand || attentionCommand ? { workerRunId: target.run!.id } : {}),
    ...(attentionCommand
      ? {
          attentionRequestId: target.attention!.id,
          capabilityId: target.attention!.capabilityId,
          operationDigest: target.attention!.operationDigest,
        }
      : {}),
    kind: request.kind,
    status: "pending",
    expectedRevision: request.expectedRevision,
    idempotencyKey: request.idempotencyKey,
    requestDigest,
    actor: request.actor,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function applyControlCommand(input: {
  data: PacketAgentData;
  request: NormalizedControlRequest;
  target: ResolvedControlTarget;
  pending: WorkerControlCommand;
  timestamp: string;
  id: (kind: "command" | "approval" | "event" | "job") => string;
  nonce: () => string;
}): ApplyResult {
  if (input.request.kind === "pause_run") return applyPause(input);
  if (input.request.kind === "resume_run") return applyResume(input);
  if (input.request.kind === "stop_run") return applyStop(input);
  if (input.request.kind === "revoke_deployment") return applyRevoke(input);
  if (input.request.kind === "reject_attention") return applyAttentionRejection(input);
  return applyApproval(input, input.request.kind === "approve_once" ? "once" : "run");
}

function applyPause(input: {
  data: PacketAgentData;
  request: NormalizedControlRequest;
  target: ResolvedControlTarget;
  pending: WorkerControlCommand;
  timestamp: string;
}): ApplyResult {
  const run = input.target.run!;
  const conflict = runRevisionConflict(input.pending, run);
  if (conflict) return reject(input.data, input.pending, input.timestamp, conflict);
  if (!["queued", "running", "waiting_for_approval"].includes(run.status)) {
    return reject(input.data, input.pending, input.timestamp, "run_not_pausable");
  }
  const { runtimeLease: _lease, ...withoutLease } = run;
  const next: WorkerRun = {
    ...withoutLease,
    status: "paused",
    revision: run.revision + 1,
    updatedAt: input.timestamp,
    ...(run.startedAt ? {} : { startedAt: input.timestamp }),
  };
  assertWorkerRunUpdate(run, next);
  replaceRun(input.data, next);
  cancelExecutionJobs(input.data, run.workspaceId, [run.id], input.timestamp, false);
  const command = apply(input.data, input.pending, input.timestamp, next.revision);
  return { command, affectedRunIds: [run.id] };
}

function applyResume(input: {
  data: PacketAgentData;
  request: NormalizedControlRequest;
  target: ResolvedControlTarget;
  pending: WorkerControlCommand;
  timestamp: string;
  id: (kind: "command" | "approval" | "event" | "job") => string;
}): ApplyResult {
  const run = input.target.run!;
  const conflict = runRevisionConflict(input.pending, run);
  if (conflict) return reject(input.data, input.pending, input.timestamp, conflict);
  if (run.status !== "paused" && run.status !== "waiting_for_approval") {
    return reject(input.data, input.pending, input.timestamp, "run_not_paused");
  }
  if (input.target.deployment.status !== "active") {
    return reject(input.data, input.pending, input.timestamp, "deployment_not_active");
  }
  if (
    input.data.workerAttentionRequests.some(
      (record) =>
        record.workspaceId === run.workspaceId &&
        record.workerRunId === run.id &&
        record.status === "open",
    )
  ) {
    return reject(input.data, input.pending, input.timestamp, "run_attention_pending");
  }
  if (
    run.status === "waiting_for_approval" &&
    !hasResumableApproval(input.data, input.target, run, input.timestamp)
  ) {
    return reject(input.data, input.pending, input.timestamp, "approval_not_resumable");
  }
  const next: WorkerRun = {
    ...run,
    status: "queued",
    revision: run.revision + 1,
    updatedAt: input.timestamp,
  };
  assertWorkerRunUpdate(run, next);
  replaceRun(input.data, next);
  const job = makeExecutionJob(
    input.id("job"),
    input.pending.id,
    next,
    input.target.version,
    input.timestamp,
  );
  if (input.data.jobs.some((record) => record.id === job.id)) {
    throw new WorkerLifecycleError("conflict", `Job ${job.id} already exists.`);
  }
  input.data.jobs.push(job);
  const command = apply(input.data, input.pending, input.timestamp, next.revision);
  return { command, affectedRunIds: [run.id] };
}

function applyStop(input: {
  data: PacketAgentData;
  request: NormalizedControlRequest;
  target: ResolvedControlTarget;
  pending: WorkerControlCommand;
  timestamp: string;
}): ApplyResult {
  const run = input.target.run!;
  const conflict = runRevisionConflict(input.pending, run);
  if (conflict) return reject(input.data, input.pending, input.timestamp, conflict);
  if (isTerminalWorkerRunStatus(run.status)) {
    return reject(input.data, input.pending, input.timestamp, "run_already_terminal");
  }
  const next = terminalizeRun(run, "operator_cancelled", input.timestamp);
  replaceRun(input.data, next);
  cancelExecutionJobs(input.data, run.workspaceId, [run.id], input.timestamp, true);
  const command = apply(input.data, input.pending, input.timestamp, next.revision);
  return { command, affectedRunIds: [run.id] };
}

function applyRevoke(input: {
  data: PacketAgentData;
  request: NormalizedControlRequest;
  target: ResolvedControlTarget;
  pending: WorkerControlCommand;
  timestamp: string;
}): ApplyResult {
  const deployment = input.target.deployment;
  if (deployment.revision !== input.pending.expectedRevision) {
    return reject(input.data, input.pending, input.timestamp, "revision_conflict");
  }
  if (!REVOCABLE_DEPLOYMENT_STATUSES.has(deployment.status)) {
    return reject(input.data, input.pending, input.timestamp, "deployment_not_revocable");
  }
  const nextDeployment: WorkerDeployment = {
    ...deployment,
    status: "revoked",
    revision: deployment.revision + 1,
    statusReason: `Revoked by Worker control command ${input.pending.id}.`,
    revokedAt: input.timestamp,
    updatedAt: input.timestamp,
  };
  assertWorkerDeploymentUpdate(deployment, nextDeployment);
  replaceDeployment(input.data, nextDeployment);

  const affectedRunIds: string[] = [];
  for (const run of input.data.workerRuns.filter(
    (record) =>
      record.workspaceId === deployment.workspaceId &&
      record.workerDeploymentId === deployment.id &&
      !isTerminalWorkerRunStatus(record.status),
  )) {
    replaceRun(input.data, terminalizeRun(run, "deployment_revoked", input.timestamp));
    affectedRunIds.push(run.id);
  }
  cancelExecutionJobs(input.data, deployment.workspaceId, affectedRunIds, input.timestamp, true);
  const command = apply(input.data, input.pending, input.timestamp, nextDeployment.revision);
  return { command, affectedRunIds };
}

function applyApproval(
  input: {
    data: PacketAgentData;
    request: NormalizedControlRequest;
    target: ResolvedControlTarget;
    pending: WorkerControlCommand;
    timestamp: string;
    id: (kind: "command" | "approval" | "event" | "job") => string;
    nonce: () => string;
  },
  scope: WorkerApprovalScope,
): ApplyResult {
  const attention = input.target.attention!;
  const run = input.target.run!;
  const rejection = attentionCommandRejection(input, attention, run);
  if (rejection) return reject(input.data, input.pending, input.timestamp, rejection);
  if (
    !input.target.deployment.compiledPolicy ||
    input.target.deployment.compiledPolicy.policyDigest !== attention.policyDigest ||
    input.target.deployment.compiledPolicy.workerVersionContentDigest !==
      attention.workerVersionContentDigest
  ) {
    return reject(input.data, input.pending, input.timestamp, "attention_policy_mismatch");
  }

  const expiresAt = input.request.expiresAt ?? attention.expiresAt;
  if (
    Date.parse(expiresAt) <= Date.parse(input.timestamp) ||
    Date.parse(expiresAt) > Date.parse(attention.expiresAt)
  ) {
    return reject(input.data, input.pending, input.timestamp, "approval_expiry_invalid");
  }

  const approvalNonce = input.nonce();
  if (!approvalNonce) {
    throw new WorkerLifecycleError("invalid_input", "Worker approval nonce cannot be empty.");
  }
  const grant: WorkerApprovalGrant = {
    schemaVersion: WORKER_APPROVAL_GRANT_SCHEMA_VERSION,
    id: input.id("approval"),
    attentionRequestId: attention.id,
    workspaceId: attention.workspaceId,
    workerDefinitionId: attention.workerDefinitionId,
    workerDeploymentId: attention.workerDeploymentId,
    workerRunId: attention.workerRunId,
    workerVersionId: attention.workerVersionId,
    workerVersionContentDigest: attention.workerVersionContentDigest,
    capabilityId: attention.capabilityId,
    operationDigest: attention.operationDigest,
    policyDigest: attention.policyDigest,
    scope,
    status: "active",
    nonceDigest: digestString(approvalNonce),
    grantedBy: input.pending.actor,
    grantedAt: input.timestamp,
    expiresAt,
  };
  input.data.workerApprovalGrants.push(grant);
  replaceAttention(input.data, {
    ...attention,
    status: "approved",
    resolvedAt: input.timestamp,
    resolvedBy: input.pending.actor,
    resolutionCommandId: input.pending.id,
  });
  const command = apply(input.data, input.pending, input.timestamp, run.revision, grant.id);
  return { command, approvalNonce, affectedRunIds: [run.id] };
}

function applyAttentionRejection(input: {
  data: PacketAgentData;
  request: NormalizedControlRequest;
  target: ResolvedControlTarget;
  pending: WorkerControlCommand;
  timestamp: string;
}): ApplyResult {
  const attention = input.target.attention!;
  const run = input.target.run!;
  const rejection = attentionCommandRejection(input, attention, run);
  if (rejection) return reject(input.data, input.pending, input.timestamp, rejection);
  replaceAttention(input.data, {
    ...attention,
    status: "rejected",
    resolvedAt: input.timestamp,
    resolvedBy: input.pending.actor,
    resolutionCommandId: input.pending.id,
  });
  const nextRun = rejectApprovalRun(run, input.timestamp);
  replaceRun(input.data, nextRun);
  cancelExecutionJobs(input.data, run.workspaceId, [run.id], input.timestamp, true);
  const command = apply(input.data, input.pending, input.timestamp, nextRun.revision);
  return { command, affectedRunIds: [run.id] };
}

function attentionCommandRejection(
  input: {
    data: PacketAgentData;
    pending: WorkerControlCommand;
    timestamp: string;
  },
  attention: WorkerAttentionRequest,
  run: WorkerRun,
): string | null {
  if (run.revision !== input.pending.expectedRevision) return "revision_conflict";
  if (attention.status !== "open") return "attention_not_open";
  if (Date.parse(attention.expiresAt) <= Date.parse(input.timestamp)) {
    replaceAttention(input.data, {
      ...attention,
      status: "expired",
      resolvedAt: input.timestamp,
      resolvedBy: CONTROL_SYSTEM_ACTOR,
    });
    return "attention_expired";
  }
  if (!["waiting_for_approval", "paused"].includes(run.status)) {
    return "run_not_waiting_for_approval";
  }
  return null;
}

function runRevisionConflict(command: WorkerControlCommand, run: WorkerRun): string | null {
  return run.revision === command.expectedRevision ? null : "revision_conflict";
}

function hasResumableApproval(
  data: PacketAgentData,
  target: ResolvedControlTarget,
  run: WorkerRun,
  timestamp: string,
): boolean {
  const checkpoint = run.latestCheckpointId
    ? data.workerCheckpoints.find(
        (record) =>
          record.workspaceId === run.workspaceId &&
          record.workerRunId === run.id &&
          record.id === run.latestCheckpointId,
      )
    : undefined;
  if (
    !checkpoint ||
    !target.deployment.compiledPolicy ||
    target.deployment.compiledPolicy.workerVersionContentDigest !== target.version.contentDigest
  ) {
    return false;
  }
  return checkpoint.pendingApprovalIds.some((attentionRequestId) => {
    const attention = data.workerAttentionRequests.find(
      (record) =>
        record.workspaceId === run.workspaceId &&
        record.id === attentionRequestId &&
        record.workerRunId === run.id &&
        record.workerVersionId === run.workerVersionId &&
        record.workerVersionContentDigest === target.version.contentDigest &&
        record.workerDeploymentId === run.workerDeploymentId &&
        record.status === "approved" &&
        record.policyDigest === target.deployment.compiledPolicy!.policyDigest,
    );
    if (!attention) return false;
    return data.workerApprovalGrants.some(
      (grant) =>
        grant.workspaceId === run.workspaceId &&
        grant.attentionRequestId === attention.id &&
        grant.workerRunId === run.id &&
        grant.workerVersionId === run.workerVersionId &&
        grant.workerVersionContentDigest === target.version.contentDigest &&
        grant.workerDeploymentId === run.workerDeploymentId &&
        grant.capabilityId === attention.capabilityId &&
        grant.operationDigest === attention.operationDigest &&
        grant.policyDigest === attention.policyDigest &&
        ["active", "consumed"].includes(grant.status) &&
        Date.parse(grant.expiresAt) > Date.parse(timestamp),
    );
  });
}

function apply(
  data: PacketAgentData,
  pending: WorkerControlCommand,
  timestamp: string,
  appliedRevision: number,
  approvalGrantId?: string,
): WorkerControlCommand {
  const command: WorkerControlCommand = {
    ...pending,
    status: "applied",
    updatedAt: timestamp,
    appliedAt: timestamp,
    appliedRevision,
    ...(approvalGrantId ? { approvalGrantId } : {}),
  };
  replaceCommand(data, command);
  return command;
}

function reject(
  data: PacketAgentData,
  pending: WorkerControlCommand,
  timestamp: string,
  rejectionCode: string,
): ApplyResult {
  const command: WorkerControlCommand = {
    ...pending,
    status: "rejected",
    updatedAt: timestamp,
    rejectedAt: timestamp,
    rejectionCode,
  };
  replaceCommand(data, command);
  return { command };
}

function terminalizeRun(
  run: WorkerRun,
  terminalReason: "operator_cancelled" | "deployment_revoked",
  timestamp: string,
): WorkerRun {
  const { runtimeLease: _lease, ...withoutLease } = run;
  const next: WorkerRun = {
    ...withoutLease,
    status: "cancelled",
    revision: run.revision + 1,
    terminalReason,
    updatedAt: timestamp,
    completedAt: timestamp,
    ...(run.startedAt ? {} : { startedAt: timestamp }),
  };
  assertWorkerRunUpdate(run, next);
  return next;
}

function rejectApprovalRun(run: WorkerRun, timestamp: string): WorkerRun {
  const { runtimeLease: _lease, ...withoutLease } = run;
  const next: WorkerRun = {
    ...withoutLease,
    status: "failed",
    revision: run.revision + 1,
    terminalReason: "approval_rejected",
    error: "Worker operation approval was rejected.",
    updatedAt: timestamp,
    completedAt: timestamp,
    ...(run.startedAt ? {} : { startedAt: timestamp }),
  };
  assertWorkerRunUpdate(run, next);
  return next;
}

function cancelExecutionJobs(
  data: PacketAgentData,
  workspaceId: string,
  workerRunIds: readonly string[],
  timestamp: string,
  requestRunningCancellation: boolean,
): string[] {
  const runIds = new Set(workerRunIds);
  const affected: string[] = [];
  for (let index = 0; index < data.jobs.length; index += 1) {
    const job = data.jobs[index];
    if (
      job.workspaceId !== workspaceId ||
      job.type !== "worker.run" ||
      typeof job.payload.workerRunId !== "string" ||
      !runIds.has(job.payload.workerRunId)
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
      affected.push(job.id);
    } else if (requestRunningCancellation && job.status === "running") {
      data.jobs[index] = {
        ...job,
        cancelRequested: true,
        updatedAt: timestamp,
      };
      affected.push(job.id);
    }
  }
  return affected;
}

function makeExecutionJob(
  jobId: string,
  commandId: string,
  run: WorkerRun,
  version: WorkerVersion,
  timestamp: string,
): JobRecord {
  return {
    id: jobId,
    workspaceId: run.workspaceId,
    type: "worker.run",
    payload: {
      workerRunId: run.id,
      workerDeploymentId: run.workerDeploymentId,
      workerVersionId: run.workerVersionId,
      controlCommandId: commandId,
    },
    status: "queued",
    attempts: 0,
    maxAttempts: Math.max(1, version.content.policy.retry.maxAttempts),
    scheduledAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function appendControlEvent(
  data: PacketAgentData,
  eventId: string,
  command: WorkerControlCommand,
  affectedRunIds: readonly string[] = [],
): void {
  const event: WorkerEvent = {
    schemaVersion: WORKER_EVENT_SCHEMA_VERSION,
    id: eventId,
    workspaceId: command.workspaceId,
    sequence:
      data.workerEvents
        .filter((record) => record.workspaceId === command.workspaceId)
        .reduce((maximum, record) => Math.max(maximum, record.sequence), 0) + 1,
    type: `worker.control.${command.kind}.${command.status}`,
    workerDefinitionId: command.workerDefinitionId,
    workerVersionId: command.workerVersionId,
    workerDeploymentId: command.workerDeploymentId,
    actor: command.actor,
    summary:
      command.status === "applied"
        ? `Worker control ${command.kind} applied.`
        : `Worker control ${command.kind} rejected.`,
    data: {
      controlCommandId: command.id,
      kind: command.kind,
      status: command.status,
      expectedRevision: command.expectedRevision,
      ...(command.appliedRevision !== undefined
        ? { appliedRevision: command.appliedRevision }
        : {}),
      ...(command.rejectionCode ? { rejectionCode: command.rejectionCode } : {}),
      ...(command.workerRunId ? { workerRunId: command.workerRunId } : {}),
      ...(command.attentionRequestId ? { attentionRequestId: command.attentionRequestId } : {}),
      ...(affectedRunIds.length > 0 ? { affectedRunIds: [...affectedRunIds] } : {}),
    },
    occurredAt: command.updatedAt,
  };
  data.workerEvents.push(event);
}

function controlResult(
  data: PacketAgentData,
  command: WorkerControlCommand,
  disposition: WorkerControlResult["disposition"],
  applied: Pick<ApplyResult, "approvalNonce" | "affectedRunIds"> = {},
): WorkerControlResult {
  const run = command.workerRunId
    ? data.workerRuns.find(
        (record) => record.workspaceId === command.workspaceId && record.id === command.workerRunId,
      )
    : undefined;
  const deployment = data.workerDeployments.find(
    (record) =>
      record.workspaceId === command.workspaceId && record.id === command.workerDeploymentId,
  );
  const attention = command.attentionRequestId
    ? data.workerAttentionRequests.find(
        (record) =>
          record.workspaceId === command.workspaceId && record.id === command.attentionRequestId,
      )
    : undefined;
  const approvalGrant = command.approvalGrantId
    ? data.workerApprovalGrants.find(
        (record) =>
          record.workspaceId === command.workspaceId && record.id === command.approvalGrantId,
      )
    : undefined;
  const executionJob = data.jobs.find(
    (record) =>
      record.workspaceId === command.workspaceId &&
      record.type === "worker.run" &&
      record.payload.controlCommandId === command.id,
  );
  return clone({
    disposition,
    command,
    ...(run ? { run } : {}),
    ...(deployment ? { deployment } : {}),
    ...(attention ? { attentionRequest: attention } : {}),
    ...(approvalGrant ? { approvalGrant } : {}),
    ...(applied.approvalNonce ? { approvalNonce: applied.approvalNonce } : {}),
    ...(executionJob ? { executionJobId: executionJob.id } : {}),
    ...(applied.affectedRunIds ? { affectedRunIds: applied.affectedRunIds } : {}),
  });
}

function requireRun(data: PacketAgentData, workspaceId: string, id: string): WorkerRun {
  const run = data.workerRuns.find(
    (record) => record.workspaceId === workspaceId && record.id === id,
  );
  if (!run) throw new WorkerLifecycleError("not_found", `WorkerRun ${id} was not found.`);
  return run;
}

function requireDeployment(
  data: PacketAgentData,
  workspaceId: string,
  id: string,
): WorkerDeployment {
  const deployment = data.workerDeployments.find(
    (record) => record.workspaceId === workspaceId && record.id === id,
  );
  if (!deployment) {
    throw new WorkerLifecycleError("not_found", `WorkerDeployment ${id} was not found.`);
  }
  return deployment;
}

function requireVersion(data: PacketAgentData, workspaceId: string, id: string): WorkerVersion {
  const version = data.workerVersions.find(
    (record) => record.workspaceId === workspaceId && record.id === id,
  );
  if (!version) {
    throw new WorkerLifecycleError("integrity", `WorkerVersion ${id} was not found.`);
  }
  return version;
}

function replaceRun(data: PacketAgentData, next: WorkerRun): void {
  replaceWorkspaceRecord(data.workerRuns, next, "WorkerRun");
}

function replaceDeployment(data: PacketAgentData, next: WorkerDeployment): void {
  replaceWorkspaceRecord(data.workerDeployments, next, "WorkerDeployment");
}

function replaceAttention(data: PacketAgentData, next: WorkerAttentionRequest): void {
  replaceWorkspaceRecord(data.workerAttentionRequests, next, "WorkerAttentionRequest");
}

function replaceCommand(data: PacketAgentData, next: WorkerControlCommand): void {
  replaceWorkspaceRecord(data.workerControlCommands, next, "WorkerControlCommand");
}

function replaceWorkspaceRecord<T extends { readonly id: string; readonly workspaceId: string }>(
  records: T[],
  next: T,
  label: string,
): void {
  const index = records.findIndex(
    (record) => record.workspaceId === next.workspaceId && record.id === next.id,
  );
  if (index < 0) {
    throw new WorkerLifecycleError("integrity", `${label} ${next.id} was not found.`);
  }
  records[index] = next;
}

function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function digest(value: unknown): string {
  return digestString(canonicalWorkerJson(value));
}

function digestString(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
