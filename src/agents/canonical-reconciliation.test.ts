import assert from "node:assert/strict";
import test from "node:test";
import { loadStore, resetStoreForTests } from "../packetagent-store.js";
import { createAgent, updateAgent, archiveAgent } from "../services/agents.js";
import { login } from "../services/auth.js";
import { handleWorkerCronActivationJob } from "../workers/adapters.js";
import { createWorkerExecutionJobHandler } from "../workers/runtime/job-handler.js";
import { refreshLegacyAgentRunFromCanonical } from "./canonical-run-compatibility.js";
import { reconcileLegacyAgentWorkers } from "./canonical-reconciliation.js";

test("scheduled Agent reconciliation replaces legacy jobs with canonical cron activation", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const created = createAgent(auth.context, {
    name: "Canonical schedule",
    description: "Runs through the Worker cron adapter.",
    instructions: "Return a bounded scheduled result.",
    triggerKind: "schedule",
    schedule: "*/15 * * * *",
    status: "active",
  });

  const reconciled = await reconcileLegacyAgentWorkers(created.agent.id);
  assert.equal(reconciled.failures.length, 0);
  assert.equal(reconciled.materialized, 1);
  assert.equal(reconciled.cronDesired, 1);

  let data = loadStore();
  assert.equal(
    data.jobs.filter(
      (job) =>
        job.type === "agent.run" &&
        job.payload.agentId === created.agent.id &&
        (job.status === "queued" || job.status === "running"),
    ).length,
    0,
  );
  const firstCron = data.jobs.find(
    (job) =>
      job.type === "worker.activate.cron" && job.status === "queued" && job.cron === "*/15 * * * *",
  );
  assert.ok(firstCron);
  const admitted = await handleWorkerCronActivationJob(firstCron);
  const executionJob = loadStore().jobs.find((job) => job.id === admitted.executionJobId);
  assert.ok(executionJob);
  await createWorkerExecutionJobHandler({
    onRunUpdated: async (workspaceId, workerRunId) => {
      await refreshLegacyAgentRunFromCanonical(workspaceId, workerRunId);
    },
  }).handle(executionJob, { signal: new AbortController().signal });
  const scheduledRun = loadStore().agentRuns.find((run) => run.workerRunId === admitted.runId);
  assert.equal(scheduledRun?.status, "success");
  assert.equal(scheduledRun?.triggerKind, "schedule");

  updateAgent(auth.context, created.agent.id, {
    name: "Canonical schedule renamed",
    schedule: "*/30 * * * *",
  });
  const updated = await reconcileLegacyAgentWorkers(created.agent.id);
  assert.equal(updated.failures.length, 0);

  data = loadStore();
  const definition = data.workerDefinitions.find(
    (entry) => entry.id === `compat:agent:${created.agent.id}:definition`,
  );
  assert.equal(definition?.name, "Canonical schedule renamed");
  assert.equal(
    data.jobs.filter(
      (job) =>
        job.type === "worker.activate.cron" &&
        job.status === "queued" &&
        job.cron === "*/30 * * * *",
    ).length,
    1,
  );
  assert.equal(data.jobs.find((job) => job.id === firstCron.id)?.status, "canceled");

  archiveAgent(auth.context, created.agent.id);
  const archived = await reconcileLegacyAgentWorkers(created.agent.id);
  assert.equal(archived.failures.length, 0);
  assert.equal(archived.retired, 1);

  data = loadStore();
  assert.equal(
    data.workerDefinitions.find((entry) => entry.id === definition?.id)?.status,
    "retired",
  );
  assert.equal(
    data.jobs.filter(
      (job) =>
        job.type === "worker.activate.cron" &&
        (job.status === "queued" || job.status === "running"),
    ).length,
    0,
  );
});

test("invalid legacy tool configuration cannot create a fallback schedule", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const created = createAgent(auth.context, {
    name: "Invalid scheduled tools",
    description: "Must stay inert until its tool configuration is valid.",
    instructions: "Use only registered tools.",
    triggerKind: "schedule",
    schedule: "0 * * * *",
    status: "active",
    enabledTools: ["missing_runtime_tool"],
  });

  const result = await reconcileLegacyAgentWorkers(created.agent.id);
  assert.equal(result.materialized, 0);
  assert.equal(result.failures.length, 1);
  assert.equal(
    loadStore().jobs.filter(
      (job) =>
        job.type === "agent.run" &&
        job.payload.agentId === created.agent.id &&
        (job.status === "queued" || job.status === "running"),
    ).length,
    0,
  );
  assert.equal(
    loadStore().workerDefinitions.some(
      (definition) => definition.id === `compat:agent:${created.agent.id}:definition`,
    ),
    false,
  );
});

test("a failed Agent edit makes the last canonical schedule inert", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const created = createAgent(auth.context, {
    name: "Schedule compile failure",
    description: "Must stop automatic activation after an invalid edit.",
    instructions: "Return a bounded result.",
    triggerKind: "schedule",
    schedule: "10 * * * *",
    status: "active",
  });
  const initial = await reconcileLegacyAgentWorkers(created.agent.id);
  assert.equal(initial.failures.length, 0);
  assert.equal(initial.materialized, 1);

  updateAgent(auth.context, created.agent.id, {
    enabledTools: ["missing_runtime_tool"],
  });
  const failed = await reconcileLegacyAgentWorkers(created.agent.id);
  assert.equal(failed.materialized, 0);
  assert.equal(failed.failures.length, 1);

  const data = loadStore();
  const definitionId = `compat:agent:${created.agent.id}:definition`;
  assert.ok(
    data.workerDeployments
      .filter((deployment) => deployment.workerDefinitionId === definitionId)
      .every((deployment) => deployment.status !== "active" && deployment.status !== "attention"),
  );
  assert.equal(
    data.jobs.filter(
      (job) =>
        job.type === "worker.activate.cron" &&
        (job.status === "queued" || job.status === "running") &&
        data.workerDeployments.some(
          (deployment) =>
            deployment.id === job.payload.workerDeploymentId &&
            deployment.workerDefinitionId === definitionId,
        ),
    ).length,
    0,
  );
});
