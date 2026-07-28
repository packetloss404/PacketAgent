import { createHash } from "node:crypto";
import {
  mutateStoreAsync as defaultMutateStore,
  type PacketAgentData,
} from "../packetagent-store.js";
import {
  WORKER_BUDGET_RESERVATION_SCHEMA_VERSION,
  assertValidWorkerBudgetReservationRecord,
  workerRollingBudgetLimitForKind,
  type WorkerBudgetReleaseReason,
  type WorkerBudgetReservationRecord,
  type WorkerRollingBudgetPort,
  type WorkerRollingBudgetReserveInput,
  type WorkerRollingBudgetReserveResult,
} from "./budget-types.js";
import type { WorkerRun } from "./types.js";

type MaybePromise<T> = T | Promise<T>;

export interface WorkerRollingBudgetServiceDependencies {
  readonly mutateStore?: <T>(
    mutator: (data: PacketAgentData) => MaybePromise<T>,
  ) => MaybePromise<T>;
  readonly now?: () => Date;
}

export class WorkerBudgetReservationError extends Error {
  readonly code:
    | "invalid_reservation"
    | "stale_fence"
    | "reservation_conflict"
    | "reservation_not_found";

  constructor(code: WorkerBudgetReservationError["code"], message: string) {
    super(message);
    this.name = "WorkerBudgetReservationError";
    this.code = code;
  }
}

export class WorkerRollingBudgetExceededError extends Error {
  readonly kind: "provider_cost_usd" | "billable_action";
  readonly scope: "workspace" | "deployment";

  constructor(
    kind: WorkerRollingBudgetExceededError["kind"],
    scope: WorkerRollingBudgetExceededError["scope"],
  ) {
    super(
      `Worker ${scope} rolling budget cannot reserve the requested ${kind === "provider_cost_usd" ? "provider cost" : "billable action"}.`,
    );
    this.name = "WorkerRollingBudgetExceededError";
    this.kind = kind;
    this.scope = scope;
  }
}

export function createWorkerRollingBudgetService(
  dependencies: WorkerRollingBudgetServiceDependencies = {},
): WorkerRollingBudgetPort {
  const mutateStore = dependencies.mutateStore ?? defaultMutateStore;
  const currentTime = dependencies.now ?? (() => new Date());

  return {
    async reserve(input) {
      validateReserveInput(input);
      return await mutateStore((data) => {
        reconcileAbandonedReservations(data, input.now);
        const run = requireLiveFencedRun(data, input);
        assertRunIdentity(run, input);

        const existing = data.workerBudgetReservations.find(
          (record) =>
            record.workspaceId === input.workspaceId &&
            record.reservationKey === input.reservationKey,
        );
        if (existing) {
          assertMatchingReservation(existing, input);
          if (existing.status !== "reserved") {
            throw new WorkerBudgetReservationError(
              "reservation_conflict",
              `Worker budget reservation ${existing.id} is already ${existing.status}.`,
            );
          }
          return { allowed: true, reservation: structuredClone(existing), reused: true };
        }

        const denial = evaluateLimits(data, input);
        if (denial) return denial;

        const timestamp = input.now.toISOString();
        const record: WorkerBudgetReservationRecord = {
          schemaVersion: WORKER_BUDGET_RESERVATION_SCHEMA_VERSION,
          id: budgetReservationId(input.workspaceId, input.reservationKey),
          workspaceId: input.workspaceId,
          workerDeploymentId: input.workerDeploymentId,
          workerRunId: input.workerRunId,
          workerVersionId: input.workerVersionId,
          fencingToken: input.fencingToken,
          reservationKey: input.reservationKey,
          kind: input.kind,
          status: "reserved",
          reservedAmount: input.amount,
          windowMs: input.policy.windowMs,
          workspaceLimit: workerRollingBudgetLimitForKind(input.policy.workspace, input.kind),
          deploymentLimit: workerRollingBudgetLimitForKind(input.policy.deployment, input.kind),
          reservedAt: timestamp,
          updatedAt: timestamp,
        };
        assertValidWorkerBudgetReservationRecord(record);
        data.workerBudgetReservations.push(record);
        return { allowed: true, reservation: structuredClone(record), reused: false };
      });
    },

    async settle(input) {
      validateSettlementInput(input.actualAmount, input.now);
      return await mutateStore((data) => {
        const record = requireReservation(data, input.workspaceId, input.reservationId);
        assertReservationOwner(record, input.workerRunId, input.fencingToken);
        if (record.status === "settled") {
          if (record.settledAmount !== input.actualAmount) {
            throw new WorkerBudgetReservationError(
              "reservation_conflict",
              `Worker budget reservation ${record.id} was settled with a different amount.`,
            );
          }
          return structuredClone(record);
        }
        if (record.status === "released") {
          throw new WorkerBudgetReservationError(
            "reservation_conflict",
            `Worker budget reservation ${record.id} has already been released.`,
          );
        }
        if (record.kind === "billable_action" && input.actualAmount !== 1) {
          throw new WorkerBudgetReservationError(
            "invalid_reservation",
            "Worker billable actions must settle exactly one action.",
          );
        }
        const timestamp = input.now.toISOString();
        const settled: WorkerBudgetReservationRecord = {
          ...record,
          status: "settled",
          settledAmount: input.actualAmount,
          settledAt: timestamp,
          updatedAt: timestamp,
        };
        assertValidWorkerBudgetReservationRecord(settled);
        replaceReservation(data, settled);
        return structuredClone(settled);
      });
    },

    async release(input) {
      validateTimestamp(input.now);
      return await mutateStore((data) => {
        const record = requireReservation(data, input.workspaceId, input.reservationId);
        assertReservationOwner(record, input.workerRunId, input.fencingToken);
        if (record.status === "released") return structuredClone(record);
        if (record.status === "settled") {
          throw new WorkerBudgetReservationError(
            "reservation_conflict",
            `Settled Worker budget reservation ${record.id} cannot be released.`,
          );
        }
        const released = releaseReservation(record, input.reason, input.now);
        replaceReservation(data, released);
        return structuredClone(released);
      });
    },

    async reconcile(now = currentTime()) {
      validateTimestamp(now);
      return await mutateStore((data) => {
        const releasedReservationIds = reconcileAbandonedReservations(data, now);
        return {
          inspected:
            data.workerBudgetReservations.filter((record) => record.status === "reserved").length +
            releasedReservationIds.length,
          releasedReservationIds,
        };
      });
    },
  };
}

function validateReserveInput(input: WorkerRollingBudgetReserveInput): void {
  validateTimestamp(input.now);
  if (
    !input.workspaceId ||
    !input.workerDeploymentId ||
    !input.workerRunId ||
    !input.workerVersionId ||
    !input.reservationKey ||
    !Number.isSafeInteger(input.fencingToken) ||
    input.fencingToken < 1 ||
    !Number.isFinite(input.amount) ||
    input.amount <= 0 ||
    !Number.isSafeInteger(input.policy.windowMs) ||
    input.policy.windowMs < 1
  ) {
    throw new WorkerBudgetReservationError(
      "invalid_reservation",
      "Worker rolling-budget reservation input is invalid.",
    );
  }
  for (const limit of [input.policy.workspace, input.policy.deployment]) {
    if (
      !Number.isFinite(limit.maxProviderCostUsd) ||
      limit.maxProviderCostUsd <= 0 ||
      !Number.isSafeInteger(limit.maxBillableActions) ||
      limit.maxBillableActions < 1
    ) {
      throw new WorkerBudgetReservationError(
        "invalid_reservation",
        "Worker rolling-budget policy is invalid.",
      );
    }
  }
  if (input.kind === "billable_action" && input.amount !== 1) {
    throw new WorkerBudgetReservationError(
      "invalid_reservation",
      "Worker billable-action reservations must reserve exactly one action.",
    );
  }
}

function validateSettlementInput(amount: number, now: Date): void {
  validateTimestamp(now);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new WorkerBudgetReservationError(
      "invalid_reservation",
      "Worker budget settlement amount must be finite and non-negative.",
    );
  }
}

function validateTimestamp(value: Date): void {
  if (!Number.isFinite(value.getTime())) {
    throw new WorkerBudgetReservationError(
      "invalid_reservation",
      "Worker budget operation requires a valid timestamp.",
    );
  }
}

function requireLiveFencedRun(
  data: PacketAgentData,
  input: Pick<
    WorkerRollingBudgetReserveInput,
    "workspaceId" | "workerRunId" | "fencingToken" | "now"
  >,
): WorkerRun {
  const run = data.workerRuns.find(
    (record) => record.workspaceId === input.workspaceId && record.id === input.workerRunId,
  );
  if (
    !run ||
    run.status !== "running" ||
    !run.runtimeLease ||
    run.runtimeLease.fencingToken !== input.fencingToken ||
    Date.parse(run.runtimeLease.expiresAt) <= input.now.getTime()
  ) {
    throw new WorkerBudgetReservationError(
      "stale_fence",
      "Worker rolling-budget reservation requires the live fenced run lease.",
    );
  }
  return run;
}

function assertRunIdentity(run: WorkerRun, input: WorkerRollingBudgetReserveInput): void {
  if (
    run.workerDeploymentId !== input.workerDeploymentId ||
    run.workerVersionId !== input.workerVersionId
  ) {
    throw new WorkerBudgetReservationError(
      "invalid_reservation",
      "Worker rolling-budget reservation does not match the version-pinned run.",
    );
  }
}

function evaluateLimits(
  data: PacketAgentData,
  input: WorkerRollingBudgetReserveInput,
): Extract<WorkerRollingBudgetReserveResult, { readonly allowed: false }> | null {
  const cutoff = input.now.getTime() - input.policy.windowMs;
  const workspaceLimit = workerRollingBudgetLimitForKind(input.policy.workspace, input.kind);
  const deploymentLimit = workerRollingBudgetLimitForKind(input.policy.deployment, input.kind);
  const relevant = data.workerBudgetReservations.filter(
    (record) =>
      record.workspaceId === input.workspaceId &&
      record.kind === input.kind &&
      chargedInWindow(record, cutoff),
  );
  const workspaceUsage = sumCharges(relevant);
  if (workspaceUsage + input.amount > workspaceLimit) {
    return {
      allowed: false,
      code: "workspace_limit",
      kind: input.kind,
      requestedAmount: input.amount,
      reservedAndSettledAmount: workspaceUsage,
      limit: workspaceLimit,
    };
  }
  const deploymentUsage = sumCharges(
    relevant.filter((record) => record.workerDeploymentId === input.workerDeploymentId),
  );
  if (deploymentUsage + input.amount > deploymentLimit) {
    return {
      allowed: false,
      code: "deployment_limit",
      kind: input.kind,
      requestedAmount: input.amount,
      reservedAndSettledAmount: deploymentUsage,
      limit: deploymentLimit,
    };
  }
  return null;
}

function chargedInWindow(record: WorkerBudgetReservationRecord, cutoff: number): boolean {
  if (record.status === "reserved") return true;
  return (
    record.status === "settled" &&
    record.settledAt !== undefined &&
    Date.parse(record.settledAt) >= cutoff
  );
}

function sumCharges(records: readonly WorkerBudgetReservationRecord[]): number {
  return records.reduce(
    (total, record) =>
      total + (record.status === "settled" ? (record.settledAmount ?? 0) : record.reservedAmount),
    0,
  );
}

function assertMatchingReservation(
  record: WorkerBudgetReservationRecord,
  input: WorkerRollingBudgetReserveInput,
): void {
  if (
    record.workerDeploymentId !== input.workerDeploymentId ||
    record.workerRunId !== input.workerRunId ||
    record.workerVersionId !== input.workerVersionId ||
    record.fencingToken !== input.fencingToken ||
    record.kind !== input.kind ||
    record.reservedAmount !== input.amount ||
    record.windowMs !== input.policy.windowMs ||
    record.workspaceLimit !== workerRollingBudgetLimitForKind(input.policy.workspace, input.kind) ||
    record.deploymentLimit !== workerRollingBudgetLimitForKind(input.policy.deployment, input.kind)
  ) {
    throw new WorkerBudgetReservationError(
      "reservation_conflict",
      "Worker rolling-budget idempotency key was reused with different input.",
    );
  }
}

function requireReservation(
  data: PacketAgentData,
  workspaceId: string,
  reservationId: string,
): WorkerBudgetReservationRecord {
  const record = data.workerBudgetReservations.find(
    (entry) => entry.workspaceId === workspaceId && entry.id === reservationId,
  );
  if (!record) {
    throw new WorkerBudgetReservationError(
      "reservation_not_found",
      `Worker budget reservation ${reservationId} was not found.`,
    );
  }
  return record;
}

function assertReservationOwner(
  record: WorkerBudgetReservationRecord,
  workerRunId: string,
  fencingToken: number,
): void {
  if (record.workerRunId !== workerRunId || record.fencingToken !== fencingToken) {
    throw new WorkerBudgetReservationError(
      "stale_fence",
      "Worker budget reservation is owned by a different run fence.",
    );
  }
}

function reconcileAbandonedReservations(data: PacketAgentData, now: Date): string[] {
  const releasedReservationIds: string[] = [];
  for (const record of data.workerBudgetReservations) {
    if (record.status !== "reserved") continue;
    const reason = abandonmentReason(data, record, now);
    if (!reason) continue;
    const released = releaseReservation(record, reason, now);
    replaceReservation(data, released);
    releasedReservationIds.push(record.id);
  }
  return releasedReservationIds;
}

function abandonmentReason(
  data: PacketAgentData,
  record: WorkerBudgetReservationRecord,
  now: Date,
): Exclude<WorkerBudgetReleaseReason, "call_failed_before_result" | "call_not_attempted"> | null {
  const run = data.workerRuns.find(
    (entry) => entry.workspaceId === record.workspaceId && entry.id === record.workerRunId,
  );
  if (!run) return "run_missing";
  if (
    ["completed", "failed", "budget_exhausted", "cancelled", "quarantined"].includes(run.status)
  ) {
    return "run_terminal";
  }
  if (!run.runtimeLease || Date.parse(run.runtimeLease.expiresAt) <= now.getTime()) {
    return "lease_expired";
  }
  if (run.runtimeLease.fencingToken !== record.fencingToken) return "lease_replaced";
  return null;
}

function releaseReservation(
  record: WorkerBudgetReservationRecord,
  reason: WorkerBudgetReleaseReason,
  now: Date,
): WorkerBudgetReservationRecord {
  const timestamp = now.toISOString();
  const released: WorkerBudgetReservationRecord = {
    ...record,
    status: "released",
    releasedAt: timestamp,
    releaseReason: reason,
    updatedAt: timestamp,
  };
  assertValidWorkerBudgetReservationRecord(released);
  return released;
}

function replaceReservation(data: PacketAgentData, record: WorkerBudgetReservationRecord): void {
  const index = data.workerBudgetReservations.findIndex(
    (entry) => entry.workspaceId === record.workspaceId && entry.id === record.id,
  );
  if (index < 0) {
    throw new WorkerBudgetReservationError(
      "reservation_not_found",
      `Worker budget reservation ${record.id} was not found.`,
    );
  }
  data.workerBudgetReservations[index] = record;
}

function budgetReservationId(workspaceId: string, reservationKey: string): string {
  const digest = createHash("sha256").update(`${workspaceId}\0${reservationKey}`).digest("hex");
  return `worker-budget-${digest.slice(0, 40)}`;
}
