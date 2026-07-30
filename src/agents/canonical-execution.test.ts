import assert from "node:assert/strict";
import test from "node:test";
import { loadStore, resetStoreForTests } from "../packetagent-store.js";
import { cancelAgentRunAsync, createAgent, runAgent } from "../services/agents.js";
import { login } from "../services/auth.js";
import { createWorkerActivationService } from "../workers/activation.js";
import { materializeLegacyAgentWorker } from "./canonical-materialization.js";
import { refreshLegacyAgentRunFromCanonical } from "./canonical-run-compatibility.js";

test("legacy Agent launch is replay-safe and executes as one canonical WorkerRun", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const created = createAgent(auth.context, {
    name: "Canonical launch",
    description: "Exercises the legacy Agent compatibility execution seam.",
    instructions: "Return a concise bounded result.",
    inputSchema: [
      {
        key: "release",
        label: "Release",
        type: "string",
        required: true,
      },
    ],
  });

  const first = await runAgent(auth.context, created.agent.id, {
    inputs: { release: "v6.6" },
    idempotencyKey: "canonical-launch-1",
  });
  const replay = await runAgent(auth.context, created.agent.id, {
    inputs: { release: "v6.6" },
    idempotencyKey: "canonical-launch-1",
  });

  assert.equal(first.run.status, "success");
  assert.equal(replay.run.id, first.run.id);
  assert.equal(replay.run.workerRunId, first.run.workerRunId);
  assert.ok(first.run.workerDefinitionId);
  assert.ok(first.run.workerVersionId);
  assert.ok(first.run.workerDeploymentId);
  assert.ok(first.run.workerRunId);

  const data = loadStore();
  const workerRuns = data.workerRuns.filter(
    (run) =>
      run.workspaceId === auth.context.workspace.id &&
      run.workerDefinitionId === first.run.workerDefinitionId,
  );
  assert.equal(workerRuns.length, 1);
  assert.equal(workerRuns[0].status, "completed");
  assert.ok(
    data.workerCheckpoints.some((checkpoint) => checkpoint.workerRunId === first.run.workerRunId),
  );
  assert.ok(
    data.workerEvents.some(
      (event) =>
        "workerRunId" in event &&
        event.workerRunId === first.run.workerRunId &&
        event.type === "worker.run.terminal",
    ),
  );
  const inbox = data.workerActivationInboxes.filter(
    (entry) => entry.workerRunId === first.run.workerRunId,
  );
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].duplicateCount, 1);
  assert.equal(data.agentRuns.filter((run) => run.workerRunId === first.run.workerRunId).length, 1);

  await assert.rejects(
    () =>
      runAgent(auth.context, created.agent.id, {
        inputs: { release: "different-intent" },
        idempotencyKey: "canonical-launch-1",
      }),
    /idempotency|different (request|input)/i,
  );
});

test("manual compatibility launch restores a paused Agent deployment posture", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const created = createAgent(auth.context, {
    name: "Paused canonical launch",
    description: "Runs manually without enabling automatic triggers.",
    instructions: "Return a concise bounded result.",
    status: "paused",
  });

  const result = await runAgent(auth.context, created.agent.id, {
    idempotencyKey: "paused-launch-1",
  });
  assert.equal(result.run.status, "success");

  const data = loadStore();
  const deployment = data.workerDeployments.find(
    (entry) => entry.id === result.run.workerDeploymentId,
  );
  assert.equal(deployment?.status, "paused");
  assert.equal(
    data.workerRuns.find((entry) => entry.id === result.run.workerRunId)?.status,
    "completed",
  );
});

test("legacy Agent cancel propagates to the canonical Worker control plane", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const created = createAgent(auth.context, {
    name: "Canonical cancellation",
    description: "Stops through the Worker control plane.",
    instructions: "Wait for execution.",
  });
  const snapshot = loadStore();
  const agent = snapshot.agents.find((entry) => entry.id === created.agent.id);
  assert.ok(agent);
  const materialized = await materializeLegacyAgentWorker(agent, null);
  const admitted = await createWorkerActivationService().admit({
    workspaceId: auth.context.workspace.id,
    workerDeploymentId: materialized.deployment.id,
    triggerId: "legacy-trigger-manual",
    source: "manual",
    deliveryId: "canonical-cancel-1",
    actor: {
      type: "user",
      id: auth.context.user.id,
      displayName: auth.context.user.displayName,
    },
    payload: {},
  });
  const compatibility = await refreshLegacyAgentRunFromCanonical(
    auth.context.workspace.id,
    admitted.runId,
  );
  assert.equal(compatibility?.status, "queued");

  const canceled = await cancelAgentRunAsync(auth.context, compatibility?.id ?? admitted.runId);
  assert.equal(canceled.run.status, "canceled");

  const data = loadStore();
  assert.equal(data.workerRuns.find((entry) => entry.id === admitted.runId)?.status, "cancelled");
  assert.ok(
    data.workerControlCommands.some(
      (command) =>
        command.workerRunId === admitted.runId &&
        command.kind === "stop_run" &&
        command.status === "applied",
    ),
  );
});
