import { randomUUID } from "node:crypto";
import {
  loadStoreAsync,
  mutateStoreAsync,
  type AgentRecord,
  type AgentTriggerKind,
  type JobRecord,
  type ProviderRecord,
} from "../packetagent-store.js";
import { redactedErrorMessage } from "../security/redaction.js";
import type { AuthenticatedContext } from "../services/context.js";
import {
  createWorkerActivationService,
  type WorkerActivationService,
} from "../workers/activation.js";
import type { WorkerActivationSource } from "../workers/activation-types.js";
import { WorkerLifecycleError } from "../workers/errors.js";
import { createWorkerLifecycleService, type WorkerLifecycleService } from "../workers/service.js";
import type { WorkerDeployment } from "../workers/types.js";
import {
  createWorkerExecutionJobHandler,
  type WorkerExecutionJobHandlerDependencies,
} from "../workers/runtime/job-handler.js";
import { materializeLegacyAgentWorker } from "./canonical-materialization.js";
import { refreshLegacyAgentRunFromCanonical } from "./canonical-run-compatibility.js";

export interface ExecuteLegacyAgentCanonicalInput {
  readonly context: AuthenticatedContext;
  readonly agent: AgentRecord;
  readonly inputs: Record<string, string | number | boolean>;
  readonly triggerKind: AgentTriggerKind;
  readonly idempotencyKey?: string;
}

export interface ExecuteLegacyAgentCanonicalDependencies {
  readonly lifecycle?: WorkerLifecycleService;
  readonly activation?: WorkerActivationService;
  readonly executionHandler?: ReturnType<typeof createWorkerExecutionJobHandler>;
  readonly loadStore?: typeof loadStoreAsync;
  readonly mutateStore?: typeof mutateStoreAsync;
  readonly now?: () => Date;
  readonly id?: () => string;
}

export async function executeLegacyAgentCanonically(
  input: ExecuteLegacyAgentCanonicalInput,
  dependencies: ExecuteLegacyAgentCanonicalDependencies = {},
) {
  const loadStore = dependencies.loadStore ?? loadStoreAsync;
  const mutateStore = dependencies.mutateStore ?? mutateStoreAsync;
  const lifecycle = dependencies.lifecycle ?? createWorkerLifecycleService();
  const activation = dependencies.activation ?? createWorkerActivationService();
  const executionHandler =
    dependencies.executionHandler ??
    createWorkerExecutionJobHandler({
      onRunUpdated: async (workspaceId, workerRunId) => {
        await refreshLegacyAgentRunFromCanonical(workspaceId, workerRunId);
      },
    } satisfies WorkerExecutionJobHandlerDependencies);
  const now = dependencies.now ?? (() => new Date());
  const deliveryId =
    normalizedIdempotencyKey(input.idempotencyKey) ??
    `legacy-agent-run:${(dependencies.id ?? randomUUID)()}`;
  const snapshot = await loadStore();
  const provider = resolveProvider(snapshot.providers, input.agent);
  const materialized = await materializeLegacyAgentWorker(input.agent, provider, {
    lifecycle,
  });
  const initiallyPaused = materialized.deployment.status === "paused";
  let admissionDeployment = materialized.deployment;
  if (initiallyPaused) {
    admissionDeployment = await resumeForAdmission(
      lifecycle,
      input.agent,
      admissionDeployment,
      deliveryId,
    );
  }

  const trigger = canonicalTrigger(input.agent, input.triggerKind);
  let admitted;
  try {
    admitted = await activation.admit({
      workspaceId: input.context.workspace.id,
      workerDeploymentId: admissionDeployment.id,
      triggerId: trigger.id,
      source: trigger.source,
      deliveryId,
      actor:
        trigger.source === "manual"
          ? {
              type: "user",
              id: input.context.user.id,
              displayName: input.context.user.displayName,
            }
          : {
              type: "system",
              id: `legacy-agent:${input.agent.id}:${trigger.source}`,
            },
      payload: { ...input.inputs },
    });
  } finally {
    if (initiallyPaused) {
      await pauseAfterAdmission(lifecycle, input.agent, admissionDeployment, deliveryId);
    }
  }

  await refreshLegacyAgentRunFromCanonical(input.context.workspace.id, admitted.runId);
  const job = await claimExecutionJob(
    mutateStore,
    input.context.workspace.id,
    admitted.executionJobId,
    now(),
  );
  try {
    await executionHandler.handle(job, { signal: new AbortController().signal });
    await completeExecutionJob(mutateStore, input.context.workspace.id, job.id, "success", now());
  } catch (error) {
    await completeExecutionJob(
      mutateStore,
      input.context.workspace.id,
      job.id,
      "failed",
      now(),
      redactedErrorMessage(error),
    );
    await refreshLegacyAgentRunFromCanonical(input.context.workspace.id, admitted.runId);
    throw error;
  }
  const run = await refreshLegacyAgentRunFromCanonical(input.context.workspace.id, admitted.runId);
  if (!run) {
    throw new WorkerLifecycleError(
      "integrity",
      "Canonical Worker run did not produce its Agent compatibility read model.",
    );
  }
  return { run, canonical: materialized, replayed: admitted.disposition === "duplicate" };
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

function canonicalTrigger(
  agent: AgentRecord,
  triggerKind: AgentTriggerKind,
): { id: string; source: WorkerActivationSource } {
  if (triggerKind === "manual") {
    return { id: "legacy-trigger-manual", source: "manual" };
  }
  if (triggerKind === "schedule" && agent.triggerKind === "schedule") {
    return { id: "legacy-trigger-schedule", source: "cron" };
  }
  if (triggerKind === "webhook" && agent.triggerKind === "webhook") {
    return { id: "legacy-trigger-webhook", source: "webhook" };
  }
  if (triggerKind === "email" && agent.triggerKind === "email") {
    return { id: "legacy-trigger-email", source: "webhook" };
  }
  throw new WorkerLifecycleError(
    "invalid_input",
    `Agent trigger ${agent.triggerKind} cannot receive a ${triggerKind} launch.`,
  );
}

async function resumeForAdmission(
  lifecycle: WorkerLifecycleService,
  agent: AgentRecord,
  deployment: WorkerDeployment,
  deliveryId: string,
): Promise<WorkerDeployment> {
  const result = await lifecycle.resume({
    workspaceId: agent.workspaceId,
    actor: {
      type: "system",
      id: "packetagent.legacy-agent-admission",
    },
    idempotencyKey: transitionKey(deliveryId, "resume"),
    workerDeploymentId: deployment.id,
    expectedRevision: deployment.revision,
    statusReason: "Temporary manual Agent activation admission.",
  });
  if (!result.deployment) {
    throw new WorkerLifecycleError(
      "integrity",
      "Paused Agent deployment did not resume for activation admission.",
    );
  }
  return result.deployment;
}

async function pauseAfterAdmission(
  lifecycle: WorkerLifecycleService,
  agent: AgentRecord,
  deployment: WorkerDeployment,
  deliveryId: string,
): Promise<void> {
  await lifecycle.pause({
    workspaceId: agent.workspaceId,
    actor: {
      type: "system",
      id: "packetagent.legacy-agent-admission",
    },
    idempotencyKey: transitionKey(deliveryId, "pause"),
    workerDeploymentId: deployment.id,
    expectedRevision: deployment.revision,
    statusReason: "Restored paused Agent posture after activation admission.",
  });
}

async function claimExecutionJob(
  mutateStore: typeof mutateStoreAsync,
  workspaceId: string,
  jobId: string,
  timestamp: Date,
): Promise<JobRecord> {
  return await mutateStore((data) => {
    const job = data.jobs.find((entry) => entry.workspaceId === workspaceId && entry.id === jobId);
    if (!job) {
      throw new WorkerLifecycleError(
        "integrity",
        "Canonical Worker activation did not persist its execution job.",
      );
    }
    if (job.status === "queued") {
      job.status = "running";
      job.attempts += 1;
      job.startedAt = timestamp.toISOString();
      job.updatedAt = job.startedAt;
    }
    return { ...job, payload: { ...job.payload } };
  });
}

async function completeExecutionJob(
  mutateStore: typeof mutateStoreAsync,
  workspaceId: string,
  jobId: string,
  status: "success" | "failed",
  timestamp: Date,
  error?: string,
): Promise<void> {
  await mutateStore((data) => {
    const job = data.jobs.find((entry) => entry.workspaceId === workspaceId && entry.id === jobId);
    if (!job) return;
    job.status = status;
    job.completedAt = timestamp.toISOString();
    job.updatedAt = job.completedAt;
    if (error) job.error = error;
  });
}

function normalizedIdempotencyKey(value: string | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (normalized.length > 512) {
    throw new WorkerLifecycleError(
      "invalid_input",
      "Agent run idempotency key must be at most 512 characters.",
    );
  }
  return normalized;
}

function transitionKey(deliveryId: string, operation: string): string {
  return `legacy-agent-admission:${operation}:${deliveryId}`;
}
