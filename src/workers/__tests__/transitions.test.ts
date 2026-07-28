import assert from "node:assert/strict";
import test from "node:test";
import type { WorkerDeploymentStatus, WorkerRunStatus, WorkerVersionStatus } from "../types.js";
import {
  assertWorkerDeploymentTransition,
  assertWorkerDeploymentUpdate,
  assertWorkerRunTransition,
  assertWorkerRunUpdate,
  assertWorkerVersionDeployable,
  assertWorkerVersionTransition,
  assertWorkerVersionUpdate,
  canTransitionWorkerDeployment,
  canTransitionWorkerRun,
  canTransitionWorkerVersion,
  isTerminalWorkerDeploymentStatus,
  isTerminalWorkerRunStatus,
  WorkerTransitionError,
} from "../transitions.js";
import { computeWorkerVersionContentDigest } from "../validation.js";
import {
  makeWorkerDeployment,
  makeWorkerRun,
  makeWorkerVersion,
  makeWorkerVersionContent,
  TEST_LATER,
} from "./fixtures.js";

test("WorkerVersion transition map admits only forward lifecycle edges", () => {
  const allowed: Array<[WorkerVersionStatus, WorkerVersionStatus]> = [
    ["draft", "validated"],
    ["draft", "rejected"],
    ["draft", "retired"],
    ["validated", "retired"],
  ];
  for (const [from, to] of allowed) {
    assert.equal(canTransitionWorkerVersion(from, to), true, `${from} -> ${to}`);
    assert.doesNotThrow(() => assertWorkerVersionTransition(from, to));
  }

  const rejected: Array<[WorkerVersionStatus, WorkerVersionStatus]> = [
    ["validated", "draft"],
    ["rejected", "draft"],
    ["retired", "validated"],
    ["draft", "draft"],
  ];
  for (const [from, to] of rejected) {
    assert.equal(canTransitionWorkerVersion(from, to), false, `${from} -> ${to}`);
    assert.throws(() => assertWorkerVersionTransition(from, to), WorkerTransitionError);
  }
});

test("WorkerDeployment lifecycle supports validation, activation, attention, and stop controls", () => {
  const allowed: Array<[WorkerDeploymentStatus, WorkerDeploymentStatus]> = [
    ["draft", "validated"],
    ["validated", "deployed"],
    ["deployed", "active"],
    ["active", "paused"],
    ["paused", "active"],
    ["active", "attention"],
    ["attention", "active"],
    ["active", "retired"],
    ["active", "revoked"],
  ];
  for (const [from, to] of allowed) {
    assert.equal(canTransitionWorkerDeployment(from, to), true, `${from} -> ${to}`);
    assert.doesNotThrow(() => assertWorkerDeploymentTransition(from, to));
  }
});

test("terminal WorkerDeployment states cannot transition", () => {
  for (const status of ["retired", "rejected", "revoked"] as const) {
    assert.equal(isTerminalWorkerDeploymentStatus(status), true);
    assert.throws(() => assertWorkerDeploymentTransition(status, "active"), WorkerTransitionError);
  }
});

test("WorkerRun transition map covers approval, pause, and explicit terminal outcomes", () => {
  const allowed: Array<[WorkerRunStatus, WorkerRunStatus]> = [
    ["queued", "running"],
    ["running", "waiting_for_approval"],
    ["waiting_for_approval", "running"],
    ["running", "paused"],
    ["paused", "running"],
    ["running", "completed"],
    ["running", "failed"],
    ["running", "budget_exhausted"],
    ["running", "cancelled"],
    ["running", "quarantined"],
  ];
  for (const [from, to] of allowed) {
    assert.equal(canTransitionWorkerRun(from, to), true, `${from} -> ${to}`);
    assert.doesNotThrow(() => assertWorkerRunTransition(from, to));
  }
});

test("terminal WorkerRun states cannot transition", () => {
  for (const status of [
    "completed",
    "failed",
    "budget_exhausted",
    "cancelled",
    "quarantined",
  ] as const) {
    assert.equal(isTerminalWorkerRunStatus(status), true);
    assert.throws(() => assertWorkerRunTransition(status, "running"), WorkerTransitionError);
  }
});

test("draft WorkerVersion content can change when its digest changes with it", () => {
  const previous = makeWorkerVersion();
  const content = makeWorkerVersionContent({
    objective: "A revised bounded release-readiness objective.",
  });
  const next = makeWorkerVersion({
    content,
    contentDigest: computeWorkerVersionContentDigest(content),
  });
  assert.doesNotThrow(() => assertWorkerVersionUpdate(previous, next));
});

test("validated WorkerVersion content is immutable", () => {
  const previous = makeWorkerVersion({ status: "validated" });
  const content = makeWorkerVersionContent({
    objective: "Attempt to mutate an already validated version.",
  });
  const next = makeWorkerVersion({
    status: "validated",
    content,
    contentDigest: computeWorkerVersionContentDigest(content),
  });
  assert.throws(
    () => assertWorkerVersionUpdate(previous, next),
    (error: unknown) => {
      assert.ok(error instanceof WorkerTransitionError);
      assert.equal(error.code, "version.validated_content_immutable");
      return true;
    },
  );
});

test("deployment-bound draft WorkerVersion content is immutable", () => {
  const previous = makeWorkerVersion();
  const content = makeWorkerVersionContent({
    objective: "Attempt to mutate a deployment-bound draft.",
  });
  const next = makeWorkerVersion({
    content,
    contentDigest: computeWorkerVersionContentDigest(content),
  });
  assert.throws(
    () => assertWorkerVersionUpdate(previous, next, { deploymentBound: true }),
    (error: unknown) => {
      assert.ok(error instanceof WorkerTransitionError);
      assert.equal(error.code, "version.deployed_content_immutable");
      return true;
    },
  );
});

test("only validated WorkerVersions are deployable", () => {
  assert.doesNotThrow(() =>
    assertWorkerVersionDeployable(makeWorkerVersion({ status: "validated" })),
  );
  assert.throws(
    () => assertWorkerVersionDeployable(makeWorkerVersion()),
    (error: unknown) => {
      assert.ok(error instanceof WorkerTransitionError);
      assert.equal(error.code, "version.not_validated");
      return true;
    },
  );
});

test("WorkerDeployment cannot change its pinned WorkerVersion", () => {
  const previous = makeWorkerDeployment({ status: "deployed" });
  const next = makeWorkerDeployment({
    status: "active",
    revision: 2,
    workerVersionId: "worker-version-2",
    updatedAt: TEST_LATER,
  });
  assert.throws(
    () => assertWorkerDeploymentUpdate(previous, next),
    (error: unknown) => {
      assert.ok(error instanceof WorkerTransitionError);
      assert.equal(error.code, "immutable.workerVersionId");
      return true;
    },
  );
});

test("WorkerDeployment update requires one optimistic revision step", () => {
  const previous = makeWorkerDeployment({ status: "deployed" });
  const next = makeWorkerDeployment({
    status: "active",
    revision: 3,
    updatedAt: TEST_LATER,
  });
  assert.throws(
    () => assertWorkerDeploymentUpdate(previous, next),
    (error: unknown) => {
      assert.ok(error instanceof WorkerTransitionError);
      assert.equal(error.code, "deployment.revision");
      return true;
    },
  );
});

test("WorkerRun remains pinned to the deployment's WorkerVersion", () => {
  const previous = makeWorkerRun({ status: "running" });
  const next = makeWorkerRun({
    status: "completed",
    workerVersionId: "worker-version-2",
  });
  assert.throws(
    () => assertWorkerRunUpdate(previous, next),
    (error: unknown) => {
      assert.ok(error instanceof WorkerTransitionError);
      assert.equal(error.code, "immutable.workerVersionId");
      return true;
    },
  );
});
