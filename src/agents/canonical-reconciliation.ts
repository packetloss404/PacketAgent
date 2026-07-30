import {
  loadStoreAsync,
  mutateStoreAsync,
  type AgentRecord,
  type JobRecord,
  type ProviderRecord,
} from "../packetagent-store.js";
import { redactedErrorMessage } from "../security/redaction.js";
import { projectWorkerCronTriggers } from "../workers/adapters.js";
import { WorkerLifecycleError } from "../workers/errors.js";
import { isTerminalWorkerDeploymentStatus } from "../workers/transitions.js";
import { createWorkerLifecycleService, type WorkerLifecycleService } from "../workers/service.js";
import { materializeLegacyAgentWorker } from "./canonical-materialization.js";

const RECONCILIATION_ACTOR = {
  type: "system" as const,
  id: "packetagent.legacy-agent-reconciler",
  displayName: "PacketAgent legacy Agent reconciler",
};

export interface LegacyAgentReconciliationResult {
  readonly considered: number;
  readonly materialized: number;
  readonly retired: number;
  readonly canceledLegacyJobs: number;
  readonly cronDesired: number;
  readonly cronEnqueued: number;
  readonly cronCanceled: number;
  readonly failures: readonly {
    agentId: string;
    message: string;
  }[];
}

export async function reconcileLegacyAgentWorkers(
  agentId?: string,
): Promise<LegacyAgentReconciliationResult> {
  const lifecycle = createWorkerLifecycleService();
  const snapshot = await loadStoreAsync();
  const agents = snapshot.agents.filter((agent) => !agentId || agent.id === agentId);
  const canceledLegacyJobs = await cancelLegacyScheduleJobs(agents);
  let materialized = 0;
  let retired = 0;
  const failures: Array<{ agentId: string; message: string }> = [];

  for (const agent of agents) {
    try {
      if (agent.status === "archived") {
        if (await retireLegacyAgentWorker(agent, lifecycle)) retired += 1;
        continue;
      }
      await materializeLegacyAgentWorker(agent, resolveProvider(snapshot.providers, agent), {
        lifecycle,
      });
      materialized += 1;
    } catch (error) {
      await makeLegacyAgentWorkerInert(agent, lifecycle);
      failures.push({
        agentId: agent.id,
        message: redactedErrorMessage(error),
      });
    }
  }

  const cron = await projectWorkerCronTriggers();
  return {
    considered: agents.length,
    materialized,
    retired,
    canceledLegacyJobs,
    cronDesired: cron.desired,
    cronEnqueued: cron.enqueued,
    cronCanceled: cron.canceled,
    failures,
  };
}

function resolveProvider(
  providers: readonly ProviderRecord[],
  agent: AgentRecord,
): ProviderRecord | null {
  if (!agent.providerId) return null;
  return (
    providers.find(
      (entry) => entry.workspaceId === agent.workspaceId && entry.id === agent.providerId,
    ) ?? null
  );
}

async function cancelLegacyScheduleJobs(agents: readonly AgentRecord[]): Promise<number> {
  const agentIds = new Set(agents.map((agent) => agent.id));
  const timestamp = new Date().toISOString();
  return await mutateStoreAsync((data) => {
    let canceled = 0;
    for (const job of data.jobs) {
      if (
        isLegacyAgentScheduleJob(job) &&
        typeof job.payload.agentId === "string" &&
        agentIds.has(job.payload.agentId) &&
        (job.status === "queued" || job.status === "running")
      ) {
        job.cancelRequested = true;
        if (job.status === "queued") {
          job.status = "canceled";
          job.completedAt = timestamp;
        }
        job.updatedAt = timestamp;
        canceled += 1;
      }
    }
    return canceled;
  });
}

function isLegacyAgentScheduleJob(job: JobRecord): boolean {
  return job.type === "agent.run" && job.payload.triggerKind === "schedule";
}

async function retireLegacyAgentWorker(
  agent: AgentRecord,
  lifecycle: WorkerLifecycleService,
): Promise<boolean> {
  let detail;
  try {
    detail = await lifecycle.getDefinition(
      agent.workspaceId,
      `compat:agent:${agent.id}:definition`,
    );
  } catch (error) {
    if (error instanceof WorkerLifecycleError && error.code === "not_found") {
      return false;
    }
    throw error;
  }
  if (detail.definition.status === "retired") return false;
  for (const deployment of detail.deployments) {
    if (isTerminalWorkerDeploymentStatus(deployment.status)) continue;
    await lifecycle.retireDeployment({
      workspaceId: agent.workspaceId,
      actor: RECONCILIATION_ACTOR,
      idempotencyKey: `legacy-agent:archive:deployment:${deployment.id}:${deployment.revision}`,
      workerDeploymentId: deployment.id,
      expectedRevision: deployment.revision,
      statusReason: "The source Agent was archived.",
    });
  }
  detail = await lifecycle.getDefinition(agent.workspaceId, detail.definition.id);
  await lifecycle.retireDefinition({
    workspaceId: agent.workspaceId,
    actor: RECONCILIATION_ACTOR,
    idempotencyKey: `legacy-agent:archive:definition:${detail.definition.id}:${detail.definition.updatedAt}`,
    workerDefinitionId: detail.definition.id,
    expectedUpdatedAt: detail.definition.updatedAt,
  });
  return true;
}

async function makeLegacyAgentWorkerInert(
  agent: AgentRecord,
  lifecycle: WorkerLifecycleService,
): Promise<void> {
  let detail;
  try {
    detail = await lifecycle.getDefinition(
      agent.workspaceId,
      `compat:agent:${agent.id}:definition`,
    );
  } catch (error) {
    if (error instanceof WorkerLifecycleError && error.code === "not_found") return;
    throw error;
  }
  for (const deployment of detail.deployments) {
    if (deployment.status !== "active" && deployment.status !== "attention") {
      continue;
    }
    await lifecycle.pause({
      workspaceId: agent.workspaceId,
      actor: RECONCILIATION_ACTOR,
      idempotencyKey: `legacy-agent:inert:deployment:${deployment.id}:${deployment.revision}`,
      workerDeploymentId: deployment.id,
      expectedRevision: deployment.revision,
      statusReason: "The source Agent could not compile to a current canonical Worker.",
    });
  }
}
