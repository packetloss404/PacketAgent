import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStore, resetStoreForTests, type AgentRunRecord } from "./packetagent-store.js";
import { sqliteAgentRunsRepository } from "./repositories/agent-runs-repo.js";
import { cancelAgentRunAsync, createAgent, runAgent, updateAgent } from "./services/agents.js";
import { login } from "./services/auth.js";
import { createWorkerActivationService } from "./workers/activation.js";
import { materializeLegacyAgentWorker } from "./agents/canonical-materialization.js";
import { reconcileLegacyAgentWorkers } from "./agents/canonical-reconciliation.js";
import { refreshLegacyAgentRunFromCanonical } from "./agents/canonical-run-compatibility.js";

resetStoreForTests();
const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
const created = createAgent(auth.context, {
  name: "R6.6 verifier",
  description: "Verifies canonical-only Agent execution.",
  instructions: "Return a concise bounded result.",
});
const first = await runAgent(auth.context, created.agent.id, {
  idempotencyKey: "r6.6-verifier-run-1",
});
const replay = await runAgent(auth.context, created.agent.id, {
  idempotencyKey: "r6.6-verifier-run-1",
});
updateAgent(auth.context, created.agent.id, {
  instructions: "Return a concise bounded result after the immutable edit.",
});
const rolled = await runAgent(auth.context, created.agent.id, {
  idempotencyKey: "r6.6-verifier-run-2",
});

const scheduled = createAgent(auth.context, {
  name: "R6.6 scheduled verifier",
  description: "Verifies canonical cron migration.",
  instructions: "Return a bounded scheduled result.",
  triggerKind: "schedule",
  schedule: "*/20 * * * *",
});
const scheduleResult = await reconcileLegacyAgentWorkers(scheduled.agent.id);

const cancelSource = createAgent(auth.context, {
  name: "R6.6 cancel verifier",
  description: "Verifies canonical control propagation.",
  instructions: "Wait for execution.",
});
const cancelAgent = loadStore().agents.find((entry) => entry.id === cancelSource.agent.id);
check(cancelAgent, "Cancel verifier Agent is missing.");
const cancelMaterialized = await materializeLegacyAgentWorker(cancelAgent, null);
const cancelAdmission = await createWorkerActivationService().admit({
  workspaceId: auth.context.workspace.id,
  workerDeploymentId: cancelMaterialized.deployment.id,
  triggerId: "legacy-trigger-manual",
  source: "manual",
  deliveryId: "r6.6-verifier-cancel",
  actor: { type: "user", id: auth.context.user.id },
  payload: {},
});
const cancelCompatibility = await refreshLegacyAgentRunFromCanonical(
  auth.context.workspace.id,
  cancelAdmission.runId,
);
check(cancelCompatibility, "Cancel verifier compatibility run is missing.");
await cancelAgentRunAsync(auth.context, cancelCompatibility.id);

const data = loadStore();
const firstCanonical = data.workerRuns.find((entry) => entry.id === first.run.workerRunId);
const definitionVersions = data.workerVersions.filter(
  (entry) => entry.workerDefinitionId === first.run.workerDefinitionId,
);
const tempDir = mkdtempSync(join(tmpdir(), "packetagent-r6.6-verifier-"));
let sqliteRoundTrip: AgentRunRecord | null = null;
try {
  const repo = sqliteAgentRunsRepository({
    dbPath: join(tempDir, "packetagent.sqlite"),
  });
  const compatibility = data.agentRuns.find((entry) => entry.workerRunId === first.run.workerRunId);
  check(compatibility, "Verifier compatibility record is missing.");
  repo.upsert(compatibility);
  sqliteRoundTrip = repo.find(compatibility.workspaceId, compatibility.id);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

const agentServiceSource = readFileSync("src/services/agents.ts", "utf8");
const assertions = {
  canonicalLifecycle:
    first.run.status === "success" &&
    firstCanonical?.status === "completed" &&
    Boolean(first.run.workerDefinitionId) &&
    Boolean(first.run.workerVersionId) &&
    Boolean(first.run.workerDeploymentId) &&
    Boolean(first.run.workerRunId),
  restartSafeReplay:
    replay.run.workerRunId === first.run.workerRunId &&
    data.workerActivationInboxes.find((entry) => entry.workerRunId === first.run.workerRunId)
      ?.duplicateCount === 1,
  immutableVersionRollover:
    rolled.run.workerVersionId !== first.run.workerVersionId &&
    definitionVersions.length === 2 &&
    definitionVersions.every((version) => version.status === "validated"),
  canonicalEvidence:
    data.workerCheckpoints.some((checkpoint) => checkpoint.workerRunId === first.run.workerRunId) &&
    data.workerEvents.some(
      (event) =>
        "workerRunId" in event &&
        event.workerRunId === first.run.workerRunId &&
        event.type === "worker.run.terminal",
    ),
  compatibilityReadModel:
    data.agentRuns.filter((entry) => entry.workerRunId === first.run.workerRunId).length === 1,
  canonicalStop:
    data.workerRuns.find((entry) => entry.id === cancelAdmission.runId)?.status === "cancelled" &&
    data.workerControlCommands.some(
      (command) =>
        command.workerRunId === cancelAdmission.runId &&
        command.kind === "stop_run" &&
        command.status === "applied",
    ),
  canonicalScheduleOnly:
    scheduleResult.failures.length === 0 &&
    data.jobs.some(
      (job) =>
        job.type === "worker.activate.cron" &&
        job.payload.workerDeploymentId ===
          data.workerDeployments.find(
            (deployment) =>
              deployment.workerDefinitionId === `compat:agent:${scheduled.agent.id}:definition`,
          )?.id,
    ) &&
    !data.jobs.some(
      (job) =>
        job.type === "agent.run" &&
        job.payload.agentId === scheduled.agent.id &&
        (job.status === "queued" || job.status === "running"),
    ),
  persistenceAndSingleEngine:
    sqliteRoundTrip?.workerDefinitionId === first.run.workerDefinitionId &&
    sqliteRoundTrip?.workerVersionId === first.run.workerVersionId &&
    sqliteRoundTrip?.workerDeploymentId === first.run.workerDeploymentId &&
    sqliteRoundTrip?.workerRunId === first.run.workerRunId &&
    agentServiceSource.includes("executeLegacyAgentCanonically") &&
    !agentServiceSource.includes("runAgentLoop"),
};

const result = {
  ok: Object.values(assertions).every(Boolean),
  assertions,
  canonical: {
    definitionId: first.run.workerDefinitionId,
    initialVersionId: first.run.workerVersionId,
    rolledVersionId: rolled.run.workerVersionId,
    runId: first.run.workerRunId,
    stoppedRunId: cancelAdmission.runId,
  },
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;

function check<T>(value: T, message: string): asserts value is NonNullable<T> {
  if (value === null || value === undefined || value === false) {
    throw new Error(message);
  }
}
