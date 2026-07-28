import { isDeepStrictEqual } from "node:util";
import type {
  WorkerDefinition,
  WorkerDefinitionStatus,
  WorkerDeployment,
  WorkerDeploymentStatus,
  WorkerRun,
  WorkerRunStatus,
  WorkerVersion,
  WorkerVersionStatus,
} from "./types.js";
import {
  assertValidWorkerDefinition,
  assertValidWorkerDeployment,
  assertValidWorkerRun,
  assertValidWorkerVersion,
} from "./validation.js";

export type WorkerLifecycleRecord =
  | "WorkerDefinition"
  | "WorkerVersion"
  | "WorkerDeployment"
  | "WorkerRun";

export class WorkerTransitionError extends Error {
  readonly recordType: WorkerLifecycleRecord;
  readonly from: string;
  readonly to: string;
  readonly code: string;

  constructor(
    recordType: WorkerLifecycleRecord,
    from: string,
    to: string,
    code = "transition.invalid",
  ) {
    super(`${recordType} cannot transition from ${from} to ${to}`);
    this.name = "WorkerTransitionError";
    this.recordType = recordType;
    this.from = from;
    this.to = to;
    this.code = code;
  }
}

const DEFINITION_TRANSITIONS: Readonly<
  Record<WorkerDefinitionStatus, ReadonlySet<WorkerDefinitionStatus>>
> = {
  draft: new Set(["active", "retired"]),
  active: new Set(["retired"]),
  retired: new Set(),
};

const VERSION_TRANSITIONS: Readonly<Record<WorkerVersionStatus, ReadonlySet<WorkerVersionStatus>>> =
  {
    draft: new Set(["validated", "rejected", "retired"]),
    validated: new Set(["retired"]),
    rejected: new Set(),
    retired: new Set(),
  };

const DEPLOYMENT_TRANSITIONS: Readonly<
  Record<WorkerDeploymentStatus, ReadonlySet<WorkerDeploymentStatus>>
> = {
  draft: new Set(["validated", "rejected"]),
  validated: new Set(["deployed", "rejected"]),
  deployed: new Set(["active", "retired", "revoked"]),
  active: new Set(["paused", "attention", "retired", "revoked"]),
  paused: new Set(["active", "attention", "retired", "revoked"]),
  attention: new Set(["active", "paused", "retired", "revoked"]),
  retired: new Set(),
  rejected: new Set(),
  revoked: new Set(),
};

const RUN_TRANSITIONS: Readonly<Record<WorkerRunStatus, ReadonlySet<WorkerRunStatus>>> = {
  queued: new Set(["running", "paused", "cancelled"]),
  running: new Set([
    "waiting_for_approval",
    "paused",
    "completed",
    "failed",
    "budget_exhausted",
    "cancelled",
    "quarantined",
  ]),
  waiting_for_approval: new Set([
    "queued",
    "running",
    "paused",
    "failed",
    "cancelled",
    "quarantined",
  ]),
  paused: new Set(["queued", "running", "failed", "cancelled", "quarantined"]),
  completed: new Set(),
  failed: new Set(),
  budget_exhausted: new Set(),
  cancelled: new Set(),
  quarantined: new Set(),
};

export const TERMINAL_WORKER_DEPLOYMENT_STATUSES: ReadonlySet<WorkerDeploymentStatus> = new Set([
  "retired",
  "rejected",
  "revoked",
]);

export const TERMINAL_WORKER_RUN_STATUSES: ReadonlySet<WorkerRunStatus> = new Set([
  "completed",
  "failed",
  "budget_exhausted",
  "cancelled",
  "quarantined",
]);

function canTransition<T extends string>(
  map: Readonly<Record<T, ReadonlySet<T>>>,
  from: T,
  to: T,
): boolean {
  return from !== to && map[from].has(to);
}

function assertTransition<T extends string>(
  recordType: WorkerLifecycleRecord,
  map: Readonly<Record<T, ReadonlySet<T>>>,
  from: T,
  to: T,
): void {
  if (!canTransition(map, from, to)) throw new WorkerTransitionError(recordType, from, to);
}

export function canTransitionWorkerDefinition(
  from: WorkerDefinitionStatus,
  to: WorkerDefinitionStatus,
): boolean {
  return canTransition(DEFINITION_TRANSITIONS, from, to);
}

export function canTransitionWorkerVersion(
  from: WorkerVersionStatus,
  to: WorkerVersionStatus,
): boolean {
  return canTransition(VERSION_TRANSITIONS, from, to);
}

export function canTransitionWorkerDeployment(
  from: WorkerDeploymentStatus,
  to: WorkerDeploymentStatus,
): boolean {
  return canTransition(DEPLOYMENT_TRANSITIONS, from, to);
}

export function canTransitionWorkerRun(from: WorkerRunStatus, to: WorkerRunStatus): boolean {
  return canTransition(RUN_TRANSITIONS, from, to);
}

export function assertWorkerDefinitionTransition(
  from: WorkerDefinitionStatus,
  to: WorkerDefinitionStatus,
): void {
  assertTransition("WorkerDefinition", DEFINITION_TRANSITIONS, from, to);
}

export function assertWorkerVersionTransition(
  from: WorkerVersionStatus,
  to: WorkerVersionStatus,
): void {
  assertTransition("WorkerVersion", VERSION_TRANSITIONS, from, to);
}

export function assertWorkerDeploymentTransition(
  from: WorkerDeploymentStatus,
  to: WorkerDeploymentStatus,
): void {
  assertTransition("WorkerDeployment", DEPLOYMENT_TRANSITIONS, from, to);
}

export function assertWorkerRunTransition(from: WorkerRunStatus, to: WorkerRunStatus): void {
  assertTransition("WorkerRun", RUN_TRANSITIONS, from, to);
}

export function isTerminalWorkerDeploymentStatus(status: WorkerDeploymentStatus): boolean {
  return TERMINAL_WORKER_DEPLOYMENT_STATUSES.has(status);
}

export function isTerminalWorkerRunStatus(status: WorkerRunStatus): boolean {
  return TERMINAL_WORKER_RUN_STATUSES.has(status);
}

function assertImmutableField<T extends object, K extends keyof T>(
  recordType: WorkerLifecycleRecord,
  previous: T,
  next: T,
  key: K,
): void {
  if (!isDeepStrictEqual(previous[key], next[key])) {
    throw new WorkerTransitionError(
      recordType,
      String(previous[key]),
      String(next[key]),
      `immutable.${String(key)}`,
    );
  }
}

export function assertWorkerDefinitionUpdate(
  previous: WorkerDefinition,
  next: WorkerDefinition,
): void {
  assertValidWorkerDefinition(previous);
  assertValidWorkerDefinition(next);
  for (const key of ["schemaVersion", "id", "workspaceId", "createdBy", "createdAt"] as const) {
    assertImmutableField("WorkerDefinition", previous, next, key);
  }
  if (previous.status !== next.status)
    assertWorkerDefinitionTransition(previous.status, next.status);
}

export interface WorkerVersionUpdateContext {
  readonly deploymentBound?: boolean;
}

export function assertWorkerVersionUpdate(
  previous: WorkerVersion,
  next: WorkerVersion,
  context: WorkerVersionUpdateContext = {},
): void {
  assertValidWorkerVersion(previous);
  assertValidWorkerVersion(next);
  for (const key of [
    "schemaVersion",
    "id",
    "workspaceId",
    "workerDefinitionId",
    "version",
    "source",
    "createdBy",
    "createdAt",
  ] as const) {
    assertImmutableField("WorkerVersion", previous, next, key);
  }
  if (previous.status !== next.status) assertWorkerVersionTransition(previous.status, next.status);

  const contentChanged =
    previous.contentDigest !== next.contentDigest ||
    !isDeepStrictEqual(previous.content, next.content);
  if (contentChanged && (previous.status !== "draft" || context.deploymentBound)) {
    throw new WorkerTransitionError(
      "WorkerVersion",
      previous.status,
      next.status,
      context.deploymentBound
        ? "version.deployed_content_immutable"
        : "version.validated_content_immutable",
    );
  }
}

export function assertWorkerVersionDeployable(version: WorkerVersion): void {
  assertValidWorkerVersion(version);
  if (version.status !== "validated") {
    throw new WorkerTransitionError(
      "WorkerVersion",
      version.status,
      "deployed",
      "version.not_validated",
    );
  }
}

export function assertWorkerDeploymentUpdate(
  previous: WorkerDeployment,
  next: WorkerDeployment,
): void {
  assertValidWorkerDeployment(previous);
  assertValidWorkerDeployment(next);
  for (const key of [
    "schemaVersion",
    "id",
    "workspaceId",
    "workerDefinitionId",
    "workerVersionId",
    "capabilityGrants",
    "compiledPolicy",
    "createdBy",
    "createdAt",
  ] as const) {
    assertImmutableField("WorkerDeployment", previous, next, key);
  }
  if (next.revision !== previous.revision + 1) {
    throw new WorkerTransitionError(
      "WorkerDeployment",
      String(previous.revision),
      String(next.revision),
      "deployment.revision",
    );
  }
  if (previous.status !== next.status)
    assertWorkerDeploymentTransition(previous.status, next.status);
}

export function assertWorkerRunUpdate(previous: WorkerRun, next: WorkerRun): void {
  assertValidWorkerRun(previous);
  assertValidWorkerRun(next);
  for (const key of [
    "schemaVersion",
    "id",
    "workspaceId",
    "workerDefinitionId",
    "workerVersionId",
    "workerDeploymentId",
    "triggerId",
    "triggerKind",
    "attempt",
    "createdAt",
  ] as const) {
    assertImmutableField("WorkerRun", previous, next, key);
  }
  if (next.revision !== previous.revision + 1) {
    throw new WorkerTransitionError("WorkerRun", previous.status, next.status, "run.revision");
  }
  if (next.runtimeFence < previous.runtimeFence) {
    throw new WorkerTransitionError(
      "WorkerRun",
      previous.status,
      next.status,
      "run.runtime_fence",
    );
  }
  if (previous.status !== next.status) assertWorkerRunTransition(previous.status, next.status);
}
