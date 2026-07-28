import assert from "node:assert/strict";
import test from "node:test";
import {
  workerRunDetailAccessibleState,
  workerRunListAccessibleState,
} from "./worker-operations-state.js";

test("Worker list loading, error, and empty states expose explicit live-region semantics", () => {
  assert.deepEqual(
    workerRunListAccessibleState({
      loading: true,
      error: null,
      visibleRuns: 0,
    }),
    {
      kind: "loading",
      message: "Loading Worker operations…",
      role: "status",
      ariaLive: "polite",
    },
  );
  assert.deepEqual(
    workerRunListAccessibleState({
      loading: false,
      error: "Worker health failed.",
      visibleRuns: 0,
    }),
    {
      kind: "error",
      message: "Worker health failed.",
      role: "alert",
      ariaLive: "assertive",
    },
  );
  assert.deepEqual(
    workerRunListAccessibleState({
      loading: false,
      error: null,
      visibleRuns: 0,
    }),
    {
      kind: "empty",
      message: "No canonical Worker runs match this view.",
      role: "status",
      ariaLive: "polite",
    },
  );
});

test("Worker detail loading, error, and missing states remain distinguishable", () => {
  assert.equal(
    workerRunDetailAccessibleState({
      loading: true,
      error: null,
      hasDetail: false,
    }).kind,
    "loading",
  );
  assert.deepEqual(
    workerRunDetailAccessibleState({
      loading: false,
      error: "WorkerRun run-404 was not found.",
      hasDetail: false,
    }),
    {
      kind: "error",
      message: "WorkerRun run-404 was not found.",
      role: "alert",
      ariaLive: "assertive",
    },
  );
  assert.deepEqual(
    workerRunDetailAccessibleState({
      loading: false,
      error: null,
      hasDetail: false,
    }),
    {
      kind: "error",
      message: "Worker run not found.",
      role: "alert",
      ariaLive: "assertive",
    },
  );
});

test("ready Worker states do not announce duplicate status messages", () => {
  assert.deepEqual(
    workerRunListAccessibleState({
      loading: false,
      error: null,
      visibleRuns: 2,
    }),
    {
      kind: "ready",
      message: "",
      role: "region",
      ariaLive: "off",
    },
  );
  assert.equal(
    workerRunDetailAccessibleState({
      loading: false,
      error: null,
      hasDetail: true,
    }).kind,
    "ready",
  );
});
