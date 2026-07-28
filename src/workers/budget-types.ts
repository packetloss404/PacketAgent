import type { WorkerBudgetPolicy } from "./types.js";

export const WORKER_BUDGET_RESERVATION_SCHEMA_VERSION =
  "packetagent.worker-budget-reservation/v1" as const;

export const DEFAULT_WORKER_ROLLING_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_WORKER_ROLLING_BUDGET_MULTIPLIER = 100;

export type WorkerBudgetReservationKind = "provider_cost_usd" | "billable_action";
export type WorkerBudgetReservationStatus = "reserved" | "settled" | "released";
export type WorkerBudgetReleaseReason =
  | "call_failed_before_result"
  | "call_not_attempted"
  | "run_terminal"
  | "lease_expired"
  | "lease_replaced"
  | "run_missing";

export interface WorkerRollingBudgetLimit {
  readonly maxProviderCostUsd: number;
  readonly maxBillableActions: number;
}

export interface WorkerRollingBudgetPolicy {
  readonly windowMs: number;
  readonly workspace: WorkerRollingBudgetLimit;
  readonly deployment: WorkerRollingBudgetLimit;
}

export interface WorkerBudgetReservationRecord {
  readonly schemaVersion: typeof WORKER_BUDGET_RESERVATION_SCHEMA_VERSION;
  readonly id: string;
  readonly workspaceId: string;
  readonly workerDeploymentId: string;
  readonly workerRunId: string;
  readonly workerVersionId: string;
  readonly fencingToken: number;
  readonly reservationKey: string;
  readonly kind: WorkerBudgetReservationKind;
  readonly status: WorkerBudgetReservationStatus;
  readonly reservedAmount: number;
  readonly settledAmount?: number;
  readonly windowMs: number;
  readonly workspaceLimit: number;
  readonly deploymentLimit: number;
  readonly reservedAt: string;
  readonly settledAt?: string;
  readonly releasedAt?: string;
  readonly releaseReason?: WorkerBudgetReleaseReason;
  readonly updatedAt: string;
}

export interface WorkerRollingBudgetReservationIdentity {
  readonly workspaceId: string;
  readonly workerDeploymentId: string;
  readonly workerRunId: string;
  readonly workerVersionId: string;
  readonly fencingToken: number;
  readonly reservationKey: string;
}

export interface WorkerRollingBudgetReserveInput extends WorkerRollingBudgetReservationIdentity {
  readonly kind: WorkerBudgetReservationKind;
  readonly amount: number;
  readonly policy: WorkerRollingBudgetPolicy;
  readonly now: Date;
}

export type WorkerRollingBudgetReserveResult =
  | {
      readonly allowed: true;
      readonly reservation: WorkerBudgetReservationRecord;
      readonly reused: boolean;
    }
  | {
      readonly allowed: false;
      readonly code: "workspace_limit" | "deployment_limit";
      readonly kind: WorkerBudgetReservationKind;
      readonly requestedAmount: number;
      readonly reservedAndSettledAmount: number;
      readonly limit: number;
    };

export interface WorkerRollingBudgetSettleInput {
  readonly workspaceId: string;
  readonly workerRunId: string;
  readonly fencingToken: number;
  readonly reservationId: string;
  readonly actualAmount: number;
  readonly now: Date;
}

export interface WorkerRollingBudgetReleaseInput {
  readonly workspaceId: string;
  readonly workerRunId: string;
  readonly fencingToken: number;
  readonly reservationId: string;
  readonly reason: Extract<
    WorkerBudgetReleaseReason,
    "call_failed_before_result" | "call_not_attempted"
  >;
  readonly now: Date;
}

export interface WorkerRollingBudgetReconciliationResult {
  readonly inspected: number;
  readonly releasedReservationIds: readonly string[];
}

export interface WorkerRollingBudgetPort {
  reserve(input: WorkerRollingBudgetReserveInput): Promise<WorkerRollingBudgetReserveResult>;
  settle(input: WorkerRollingBudgetSettleInput): Promise<WorkerBudgetReservationRecord>;
  release(input: WorkerRollingBudgetReleaseInput): Promise<WorkerBudgetReservationRecord>;
  reconcile(now?: Date): Promise<WorkerRollingBudgetReconciliationResult>;
}

export function resolveWorkerRollingBudgetPolicy(
  budgets: WorkerBudgetPolicy,
): WorkerRollingBudgetPolicy {
  if (budgets.rolling) return budgets.rolling;
  return {
    windowMs: DEFAULT_WORKER_ROLLING_BUDGET_WINDOW_MS,
    workspace: {
      maxProviderCostUsd: finiteProduct(
        budgets.maxProviderCostUsd,
        DEFAULT_WORKER_ROLLING_BUDGET_MULTIPLIER,
      ),
      maxBillableActions: safeIntegerProduct(
        budgets.maxToolCalls,
        DEFAULT_WORKER_ROLLING_BUDGET_MULTIPLIER,
      ),
    },
    deployment: {
      maxProviderCostUsd: finiteProduct(
        budgets.maxProviderCostUsd,
        DEFAULT_WORKER_ROLLING_BUDGET_MULTIPLIER,
      ),
      maxBillableActions: safeIntegerProduct(
        budgets.maxToolCalls,
        DEFAULT_WORKER_ROLLING_BUDGET_MULTIPLIER,
      ),
    },
  };
}

function finiteProduct(value: number, multiplier: number): number {
  const product = value * multiplier;
  return Number.isFinite(product) ? product : Number.MAX_VALUE;
}

function safeIntegerProduct(value: number, multiplier: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value * multiplier));
}

export function workerRollingBudgetLimitForKind(
  limit: WorkerRollingBudgetLimit,
  kind: WorkerBudgetReservationKind,
): number {
  return kind === "provider_cost_usd" ? limit.maxProviderCostUsd : limit.maxBillableActions;
}

export function assertValidWorkerBudgetReservationRecord(
  record: WorkerBudgetReservationRecord,
): void {
  if (
    record.schemaVersion !== WORKER_BUDGET_RESERVATION_SCHEMA_VERSION ||
    !record.id ||
    !record.workspaceId ||
    !record.workerDeploymentId ||
    !record.workerRunId ||
    !record.workerVersionId ||
    !record.reservationKey ||
    !Number.isSafeInteger(record.fencingToken) ||
    record.fencingToken < 1 ||
    !["provider_cost_usd", "billable_action"].includes(record.kind) ||
    !["reserved", "settled", "released"].includes(record.status) ||
    !isPositiveFinite(record.reservedAmount) ||
    !Number.isSafeInteger(record.windowMs) ||
    record.windowMs < 1 ||
    !isPositiveFinite(record.workspaceLimit) ||
    !isPositiveFinite(record.deploymentLimit) ||
    !isCanonicalTimestamp(record.reservedAt) ||
    !isCanonicalTimestamp(record.updatedAt)
  ) {
    throw new Error("Worker budget reservation is invalid.");
  }
  if (Date.parse(record.updatedAt) < Date.parse(record.reservedAt)) {
    throw new Error("Worker budget reservation timestamps are not monotonic.");
  }
  if (record.kind === "billable_action" && record.reservedAmount !== 1) {
    throw new Error("Worker billable-action reservations must reserve exactly one action.");
  }
  if (
    record.status === "reserved" &&
    (record.settledAmount !== undefined ||
      record.settledAt !== undefined ||
      record.releasedAt !== undefined ||
      record.releaseReason !== undefined)
  ) {
    throw new Error("Reserved Worker budget entries cannot contain terminal fields.");
  }
  if (
    record.status === "settled" &&
    (!isNonNegativeFinite(record.settledAmount) ||
      !isCanonicalTimestamp(record.settledAt) ||
      Date.parse(record.settledAt) < Date.parse(record.reservedAt) ||
      record.releasedAt !== undefined ||
      record.releaseReason !== undefined)
  ) {
    throw new Error("Settled Worker budget entries require a valid settlement.");
  }
  if (
    record.status === "released" &&
    (record.settledAmount !== undefined ||
      record.settledAt !== undefined ||
      !isCanonicalTimestamp(record.releasedAt) ||
      Date.parse(record.releasedAt) < Date.parse(record.reservedAt) ||
      !record.releaseReason)
  ) {
    throw new Error("Released Worker budget entries require a release reason.");
  }
  if (record.kind === "billable_action" && record.settledAmount !== undefined) {
    if (record.settledAmount !== 1) {
      throw new Error("Settled Worker billable-action reservations must charge one action.");
    }
  }
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isCanonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
