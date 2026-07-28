import {
  WORKER_BUDGET_RESERVATION_SCHEMA_VERSION,
  workerRollingBudgetLimitForKind,
  type WorkerBudgetReservationRecord,
  type WorkerRollingBudgetPort,
} from "../budget-types.js";

export function createPermissiveWorkerBudgetPort(): WorkerRollingBudgetPort {
  const records = new Map<string, WorkerBudgetReservationRecord>();
  let sequence = 0;
  return {
    async reserve(input) {
      const existing = [...records.values()].find(
        (record) =>
          record.workspaceId === input.workspaceId &&
          record.reservationKey === input.reservationKey,
      );
      if (existing?.status === "reserved") {
        return { allowed: true, reservation: existing, reused: true };
      }
      sequence += 1;
      const timestamp = input.now.toISOString();
      const reservation: WorkerBudgetReservationRecord = {
        schemaVersion: WORKER_BUDGET_RESERVATION_SCHEMA_VERSION,
        id: `test-budget-${sequence}`,
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
      records.set(reservation.id, reservation);
      return { allowed: true, reservation, reused: false };
    },
    async settle(input) {
      const record = requireRecord(records, input.reservationId);
      const timestamp = input.now.toISOString();
      const settled: WorkerBudgetReservationRecord = {
        ...record,
        status: "settled",
        settledAmount: input.actualAmount,
        settledAt: timestamp,
        updatedAt: timestamp,
      };
      records.set(settled.id, settled);
      return settled;
    },
    async release(input) {
      const record = requireRecord(records, input.reservationId);
      const timestamp = input.now.toISOString();
      const released: WorkerBudgetReservationRecord = {
        ...record,
        status: "released",
        releasedAt: timestamp,
        releaseReason: input.reason,
        updatedAt: timestamp,
      };
      records.set(released.id, released);
      return released;
    },
    async reconcile() {
      return { inspected: 0, releasedReservationIds: [] };
    },
  };
}

function requireRecord(
  records: ReadonlyMap<string, WorkerBudgetReservationRecord>,
  id: string,
): WorkerBudgetReservationRecord {
  const record = records.get(id);
  if (!record) throw new Error(`Test Worker budget reservation ${id} was not found.`);
  return record;
}
