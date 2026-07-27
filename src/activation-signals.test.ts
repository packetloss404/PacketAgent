import assert from "node:assert/strict";
import test from "node:test";
import { login, retryAgentRun } from "./packetagent-services";
import { loadStore, resetStoreForTests, snapshotForWorkspace } from "./packetagent-store";

test("retry activation emission is idempotent for a source run", async () => {
  resetStoreForTests();
  const auth = login({ email: "beta@packetagent.local", password: "demo12345" });
  const failed = loadStore().agentRuns.find((entry) => entry.workspaceId === "beta" && entry.status === "failed");
  assert.ok(failed, "expected a failed beta run");

  await retryAgentRun(auth.context, failed.id);
  await retryAgentRun(auth.context, failed.id);

  const store = loadStore();
  assert.equal(
    store.activationSignals.filter((entry) => entry.workspaceId === "beta" && entry.kind === "retry" && entry.sourceId === failed.id).length,
    1,
  );
  assert.equal(
    store.activationSignals.find((entry) => entry.workspaceId === "beta" && entry.kind === "retry" && entry.sourceId === failed.id)?.origin,
    "user_entered",
  );
  assert.equal(
    store.activities.filter((entry) => entry.workspaceId === "beta" && entry.event === "agent.run.retry" && entry.data.previousRunId === failed.id).length,
    1,
  );
});

test("activation snapshots normalize user facts and system signals while preserving source records", () => {
  const store = resetStoreForTests();
  delete store.activationFacts.alpha;
  store.activationSignals = [
    {
      id: "signal_alpha_user_scope",
      workspaceId: "alpha",
      kind: "scope_change",
      source: "user_fact",
      origin: "user_entered",
      sourceId: "fact_alpha_scope",
      createdAt: "2026-04-22T10:00:00.000Z",
      updatedAt: "2026-04-22T10:00:00.000Z",
    },
    {
      id: "signal_alpha_system_retry",
      workspaceId: "alpha",
      kind: "retry",
      source: "system_fact",
      origin: "system_observed",
      sourceId: "run_alpha_retry",
      createdAt: "2026-04-22T11:00:00.000Z",
      updatedAt: "2026-04-22T11:00:00.000Z",
    },
  ];

  const snapshot = snapshotForWorkspace(store, "alpha");

  assert.equal(snapshot.scopeChangeCount, 1);
  assert.equal(snapshot.retryCount, 1);
  assert.deepEqual(store.activationSignals.map((entry) => entry.source).sort(), ["system_fact", "user_fact"]);
  assert.deepEqual(store.activationSignals.map((entry) => entry.origin).sort(), ["system_observed", "user_entered"]);
});
