import assert from "node:assert/strict";
import test from "node:test";
import { createSeedStore, type PacketAgentData } from "../packetagent-store.js";
import type {
  WorkerBudgetReservationKind,
  WorkerRollingBudgetPolicy,
  WorkerRollingBudgetReserveInput,
} from "./budget-types.js";
import {
  createWorkerRollingBudgetService,
  WorkerBudgetReservationError,
} from "./rolling-budget.js";
import {
  makeWorkerDefinition,
  makeWorkerDeployment,
  makeWorkerRun,
  makeWorkerVersion,
} from "./__tests__/fixtures.js";

const NOW = new Date("2026-07-27T12:00:00.000Z");
const POLICY: WorkerRollingBudgetPolicy = {
  windowMs: 60_000,
  workspace: {
    maxProviderCostUsd: 1,
    maxBillableActions: 2,
  },
  deployment: {
    maxProviderCostUsd: 1,
    maxBillableActions: 2,
  },
};

test("concurrent reservations contend atomically on workspace and deployment ceilings", async () => {
  const harness = budgetHarness();
  const [first, second] = await Promise.all([
    harness.service.reserve(
      reserveInput({
        workerRunId: "run-1",
        reservationKey: "provider-a",
        amount: 0.75,
      }),
    ),
    harness.service.reserve(
      reserveInput({
        workerRunId: "run-2",
        reservationKey: "provider-b",
        amount: 0.75,
      }),
    ),
  ]);

  assert.equal([first.allowed, second.allowed].filter(Boolean).length, 1);
  const denial = first.allowed ? second : first;
  assert.equal(denial.allowed, false);
  if (denial.allowed) return;
  assert.equal(denial.code, "workspace_limit");
  assert.equal(harness.data.workerBudgetReservations.length, 1);
});

test("deployment ceilings are enforced independently below the workspace ceiling", async () => {
  const harness = budgetHarness();
  const policy: WorkerRollingBudgetPolicy = {
    ...POLICY,
    workspace: { ...POLICY.workspace, maxProviderCostUsd: 2 },
  };
  const first = await harness.service.reserve(
    reserveInput({
      workerRunId: "run-1",
      reservationKey: "deployment-first",
      amount: 0.75,
      policy,
    }),
  );
  const second = await harness.service.reserve(
    reserveInput({
      workerRunId: "run-2",
      reservationKey: "deployment-second",
      amount: 0.5,
      policy,
    }),
  );

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  if (second.allowed) return;
  assert.equal(second.code, "deployment_limit");
});

test("workspace ceilings aggregate reservations across deployments", async () => {
  const harness = budgetHarness();
  const first = await harness.service.reserve(
    reserveInput({
      workerRunId: "run-1",
      reservationKey: "workspace-first",
      amount: 0.75,
    }),
  );
  const second = await harness.service.reserve(
    reserveInput({
      workerRunId: "run-3",
      workerDeploymentId: "deployment-2",
      reservationKey: "workspace-second",
      amount: 0.5,
    }),
  );

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  if (second.allowed) return;
  assert.equal(second.code, "workspace_limit");
});

test("settlement releases unused hold capacity and remains idempotent", async () => {
  const harness = budgetHarness();
  const reserved = await harness.service.reserve(
    reserveInput({
      workerRunId: "run-1",
      reservationKey: "provider-first",
      amount: 1,
    }),
  );
  assert.equal(reserved.allowed, true);
  if (!reserved.allowed) return;

  const settled = await harness.service.settle({
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    fencingToken: 1,
    reservationId: reserved.reservation.id,
    actualAmount: 0.2,
    now: new Date(NOW.getTime() + 1_000),
  });
  const repeated = await harness.service.settle({
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    fencingToken: 1,
    reservationId: reserved.reservation.id,
    actualAmount: 0.2,
    now: new Date(NOW.getTime() + 2_000),
  });
  assert.equal(settled.status, "settled");
  assert.equal(repeated.settledAmount, 0.2);

  const second = await harness.service.reserve(
    reserveInput({
      workerRunId: "run-2",
      reservationKey: "provider-second",
      amount: 0.8,
      now: new Date(NOW.getTime() + 2_000),
    }),
  );
  assert.equal(second.allowed, true);
});

test("reservation and release retries do not double reserve or double credit", async () => {
  const harness = budgetHarness();
  const input = reserveInput({
    workerRunId: "run-1",
    reservationKey: "billable-retry",
    kind: "billable_action",
    amount: 1,
  });
  const first = await harness.service.reserve(input);
  const repeated = await harness.service.reserve(input);
  assert.equal(first.allowed, true);
  assert.equal(repeated.allowed, true);
  if (!first.allowed || !repeated.allowed) return;
  assert.equal(repeated.reused, true);
  assert.equal(first.reservation.id, repeated.reservation.id);

  const releaseInput = {
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    fencingToken: 1,
    reservationId: first.reservation.id,
    reason: "call_not_attempted" as const,
    now: new Date(NOW.getTime() + 1_000),
  };
  const released = await harness.service.release(releaseInput);
  const releasedAgain = await harness.service.release(releaseInput);
  assert.equal(released.status, "released");
  assert.equal(releasedAgain.status, "released");

  await assert.rejects(
    harness.service.reserve(input),
    (error) =>
      error instanceof WorkerBudgetReservationError && error.code === "reservation_conflict",
  );
  const replacement = await harness.service.reserve({
    ...input,
    reservationKey: "billable-replacement",
    now: new Date(NOW.getTime() + 2_000),
  });
  assert.equal(replacement.allowed, true);
});

test("lease expiry reconciliation releases abandoned holds exactly once", async () => {
  const harness = budgetHarness();
  const reserved = await harness.service.reserve(
    reserveInput({
      workerRunId: "run-1",
      reservationKey: "abandoned-provider",
      amount: 1,
    }),
  );
  assert.equal(reserved.allowed, true);
  if (!reserved.allowed) return;

  const run = harness.data.workerRuns.find((record) => record.id === "run-1");
  assert.ok(run?.runtimeLease);
  if (!run?.runtimeLease) return;
  const runIndex = harness.data.workerRuns.findIndex((record) => record.id === run.id);
  harness.data.workerRuns[runIndex] = {
    ...run,
    runtimeLease: {
      ...run.runtimeLease,
      renewedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 500).toISOString(),
    },
  };

  const first = await harness.service.reconcile(new Date(NOW.getTime() + 1_000));
  const second = await harness.service.reconcile(new Date(NOW.getTime() + 2_000));
  assert.deepEqual(first.releasedReservationIds, [reserved.reservation.id]);
  assert.deepEqual(second.releasedReservationIds, []);
  assert.equal(harness.data.workerBudgetReservations[0].releaseReason, "lease_expired");

  const replacement = await harness.service.reserve(
    reserveInput({
      workerRunId: "run-2",
      reservationKey: "replacement-provider",
      amount: 1,
      now: new Date(NOW.getTime() + 2_000),
    }),
  );
  assert.equal(replacement.allowed, true);
});

test("settled charges fall out of the configured rolling window", async () => {
  const harness = budgetHarness();
  const reserved = await harness.service.reserve(
    reserveInput({
      workerRunId: "run-1",
      reservationKey: "window-first",
      amount: 1,
    }),
  );
  assert.equal(reserved.allowed, true);
  if (!reserved.allowed) return;
  await harness.service.settle({
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    fencingToken: 1,
    reservationId: reserved.reservation.id,
    actualAmount: 1,
    now: NOW,
  });

  const withinWindow = await harness.service.reserve(
    reserveInput({
      workerRunId: "run-2",
      reservationKey: "window-blocked",
      amount: 0.01,
      now: new Date(NOW.getTime() + POLICY.windowMs - 1),
    }),
  );
  assert.equal(withinWindow.allowed, false);

  const afterWindow = await harness.service.reserve(
    reserveInput({
      workerRunId: "run-2",
      reservationKey: "window-allowed",
      amount: 1,
      now: new Date(NOW.getTime() + POLICY.windowMs + 1),
    }),
  );
  assert.equal(afterWindow.allowed, true);
});

function budgetHarness(): {
  readonly data: PacketAgentData;
  readonly service: ReturnType<typeof createWorkerRollingBudgetService>;
} {
  const data = createSeedStore();
  const definition = makeWorkerDefinition({ status: "active" });
  const version = makeWorkerVersion({ status: "validated" });
  const deployment = makeWorkerDeployment({ status: "active" });
  const secondDeployment = makeWorkerDeployment({
    id: "deployment-2",
    status: "deployed",
  });
  const lease = {
    ownerId: "test-owner",
    fencingToken: 1,
    acquiredAt: NOW.toISOString(),
    renewedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
  };
  data.workerDefinitions.push(definition);
  data.workerVersions.push(version);
  data.workerDeployments.push(deployment);
  data.workerDeployments.push(secondDeployment);
  data.workerRuns.push(
    makeWorkerRun({
      id: "run-1",
      status: "running",
      runtimeFence: 1,
      runtimeLease: lease,
    }),
    makeWorkerRun({
      id: "run-2",
      status: "running",
      runtimeFence: 1,
      runtimeLease: { ...lease, ownerId: "test-owner-2" },
    }),
    makeWorkerRun({
      id: "run-3",
      workerDeploymentId: "deployment-2",
      status: "running",
      runtimeFence: 1,
      runtimeLease: { ...lease, ownerId: "test-owner-3" },
    }),
  );

  let tail = Promise.resolve();
  const mutateStore = async <T>(
    mutator: (store: PacketAgentData) => T | Promise<T>,
  ): Promise<T> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await mutator(data);
    } finally {
      release();
    }
  };
  return {
    data,
    service: createWorkerRollingBudgetService({ mutateStore, now: () => NOW }),
  };
}

function reserveInput(
  overrides: Partial<WorkerRollingBudgetReserveInput> & {
    readonly workerRunId: string;
    readonly reservationKey: string;
  },
): WorkerRollingBudgetReserveInput {
  return {
    workspaceId: "workspace-1",
    workerDeploymentId: overrides.workerDeploymentId ?? "deployment-1",
    workerRunId: overrides.workerRunId,
    workerVersionId: "worker-version-1",
    fencingToken: 1,
    reservationKey: overrides.reservationKey,
    kind: overrides.kind ?? ("provider_cost_usd" as WorkerBudgetReservationKind),
    amount: overrides.amount ?? 0.5,
    policy: overrides.policy ?? POLICY,
    now: overrides.now ?? NOW,
  };
}
