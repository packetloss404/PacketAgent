import { randomUUID } from "node:crypto";
import type { AlertEvent } from "../alerts/alert-engine.js";
import { nextAfterInTimezone } from "../jobs/cron.js";
import {
  loadStoreAsync as defaultLoadStore,
  mutateStoreAsync as defaultMutateStore,
  type JobRecord,
  type PacketAgentData,
} from "../packetagent-store.js";
import {
  createWorkerActivationService,
  generateWorkerTrace,
  type WorkerActivationService,
} from "./activation.js";
import { WorkerLifecycleError } from "./errors.js";
import type {
  JsonObject,
  WorkerActorReference,
  WorkerTraceContext,
  WorkerVersion,
} from "./types.js";

export const WORKER_CRON_ACTIVATION_JOB_TYPE = "worker.activate.cron" as const;
export const WORKER_CRON_PROJECTION_JOB_TYPE = "worker.cron.project" as const;

export interface WorkerActivationAdapterDependencies {
  readonly service?: WorkerActivationService;
  readonly loadStore?: () => Promise<PacketAgentData>;
  readonly mutateStore?: <T>(mutator: (data: PacketAgentData) => T | Promise<T>) => Promise<T>;
  readonly now?: () => Date;
  readonly id?: () => string;
}

export interface WorkerWebhookDeliveryInput {
  readonly webhookRef: string;
  readonly deliveryId: string;
  readonly occurredAt?: string;
  readonly payload: JsonObject;
  readonly trace?: WorkerTraceContext;
}

export interface WorkerQueueDeliveryInput {
  readonly workspaceId: string;
  readonly workerDeploymentId: string;
  readonly triggerId: string;
  readonly queueRef: string;
  readonly upstreamMessageId: string;
  readonly occurredAt?: string;
  readonly payload: JsonObject;
  readonly actor?: WorkerActorReference;
  readonly trace?: WorkerTraceContext;
}

export interface WorkerCronProjectionResult {
  readonly desired: number;
  readonly enqueued: number;
  readonly canceled: number;
}

export async function activateWorkerWebhookDelivery(
  input: WorkerWebhookDeliveryInput,
  dependencies: WorkerActivationAdapterDependencies = {},
) {
  const service = dependencies.service ?? createWorkerActivationService();
  const data = await (dependencies.loadStore ?? defaultLoadStore)();
  const targets = activeTriggerTargets(data, (trigger) => {
    return trigger.kind === "webhook" && trigger.webhookRef === input.webhookRef;
  });
  if (targets.length === 0) {
    throw new WorkerLifecycleError("not_found", "Worker webhook was not found.");
  }
  if (targets.length > 1) {
    throw new WorkerLifecycleError(
      "integrity",
      "Worker webhook reference resolves to more than one active trigger.",
    );
  }
  const target = targets[0];
  return await service.admit({
    workspaceId: target.deployment.workspaceId,
    workerDeploymentId: target.deployment.id,
    triggerId: target.trigger.id,
    source: "webhook",
    deliveryId: input.deliveryId,
    occurredAt: input.occurredAt,
    actor: {
      type: "system",
      id: `worker-webhook:${target.trigger.id}`,
    },
    payload: input.payload,
    trace: input.trace,
  });
}

export async function activateWorkerQueueDelivery(
  input: WorkerQueueDeliveryInput,
  dependencies: WorkerActivationAdapterDependencies = {},
) {
  const service = dependencies.service ?? createWorkerActivationService();
  const data = await (dependencies.loadStore ?? defaultLoadStore)();
  const target = activeTriggerTargets(
    data,
    (trigger) =>
      trigger.kind === "queue" &&
      trigger.id === input.triggerId &&
      trigger.queueRef === input.queueRef,
  ).find(
    (candidate) =>
      candidate.deployment.workspaceId === input.workspaceId &&
      candidate.deployment.id === input.workerDeploymentId,
  );
  if (!target) {
    throw new WorkerLifecycleError(
      "not_found",
      "Active Worker queue trigger was not found for the supplied queue reference.",
    );
  }
  return await service.admit({
    workspaceId: input.workspaceId,
    workerDeploymentId: input.workerDeploymentId,
    triggerId: input.triggerId,
    source: "queue",
    deliveryId: input.upstreamMessageId,
    occurredAt: input.occurredAt,
    actor: input.actor ?? {
      type: "system",
      id: "worker-queue",
    },
    payload: input.payload,
    trace: input.trace,
  });
}

export async function activateWorkerAlertEvents(
  events: readonly AlertEvent[],
  dependencies: WorkerActivationAdapterDependencies = {},
): Promise<number> {
  if (events.length === 0) return 0;
  const service = dependencies.service ?? createWorkerActivationService();
  const data = await (dependencies.loadStore ?? defaultLoadStore)();
  let accepted = 0;
  for (const event of events) {
    const targets = activeTriggerTargets(
      data,
      (trigger) => trigger.kind === "alert" && trigger.alertRuleId === event.ruleId,
    );
    for (const target of targets) {
      await service.admit({
        workspaceId: target.deployment.workspaceId,
        workerDeploymentId: target.deployment.id,
        triggerId: target.trigger.id,
        source: "alert",
        deliveryId: event.id,
        occurredAt: event.observedAt,
        actor: {
          type: "system",
          id: `alert-rule:${event.ruleId}`,
        },
        payload: {
          alert_id: event.id,
          rule_id: event.ruleId,
          severity: event.severity,
          title: event.title,
          detail: event.detail,
          observed_at: event.observedAt,
          context: event.context as JsonObject,
        },
        trace: generateWorkerTrace(),
      });
      accepted += 1;
    }
  }
  return accepted;
}

export async function handleWorkerCronActivationJob(
  job: JobRecord,
  dependencies: WorkerActivationAdapterDependencies = {},
) {
  const workerDeploymentId = requiredJobString(job, "workerDeploymentId");
  const triggerId = requiredJobString(job, "triggerId");
  return await (dependencies.service ?? createWorkerActivationService()).admit({
    workspaceId: job.workspaceId,
    workerDeploymentId,
    triggerId,
    source: "cron",
    deliveryId: job.id,
    occurredAt: job.scheduledAt,
    actor: {
      type: "system",
      id: "worker-cron",
    },
    payload: {},
    trace: generateWorkerTrace(),
  });
}

export async function projectWorkerCronTriggers(
  dependencies: WorkerActivationAdapterDependencies = {},
): Promise<WorkerCronProjectionResult> {
  const mutateStore = dependencies.mutateStore ?? defaultMutateStore;
  const now = dependencies.now ?? (() => new Date());
  const id = dependencies.id ?? randomUUID;
  const timestamp = now().toISOString();
  return await mutateStore((data) => {
    const desired = cronTargets(data);
    const desiredByKey = new Map(desired.map((target) => [cronTargetKey(target), target]));
    let canceled = 0;
    let enqueued = 0;
    const liveByKey = new Map<string, JobRecord>();

    for (const job of data.jobs) {
      if (
        job.type !== WORKER_CRON_ACTIVATION_JOB_TYPE ||
        (job.status !== "queued" && job.status !== "running")
      ) {
        continue;
      }
      const key = cronJobKey(job);
      const target = key ? desiredByKey.get(key) : undefined;
      const matches =
        target &&
        job.cron === target.trigger.expression &&
        job.payload.timezone === target.trigger.timezone &&
        job.payload.workerVersionId === target.version.id;
      if (!matches || (key && liveByKey.has(key))) {
        job.cancelRequested = true;
        if (job.status === "queued") {
          job.status = "canceled";
          job.completedAt = timestamp;
        }
        job.updatedAt = timestamp;
        canceled += 1;
        continue;
      }
      if (key) liveByKey.set(key, job);
    }

    for (const target of desired) {
      const key = cronTargetKey(target);
      if (liveByKey.has(key)) continue;
      const job: JobRecord = {
        id: id(),
        workspaceId: target.deployment.workspaceId,
        type: WORKER_CRON_ACTIVATION_JOB_TYPE,
        payload: {
          workerDeploymentId: target.deployment.id,
          workerVersionId: target.version.id,
          triggerId: target.trigger.id,
          timezone: target.trigger.timezone,
        },
        status: "queued",
        attempts: 0,
        maxAttempts: Math.max(1, target.version.content.policy.retry.maxAttempts),
        scheduledAt: nextAfterInTimezone(
          target.trigger.expression,
          now(),
          target.trigger.timezone,
        ).toISOString(),
        cron: target.trigger.expression,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      data.jobs.push(job);
      liveByKey.set(key, job);
      enqueued += 1;
    }

    return { desired: desired.length, enqueued, canceled };
  });
}

export async function ensureWorkerCronProjectionJob(
  dependencies: WorkerActivationAdapterDependencies = {},
): Promise<JobRecord> {
  const mutateStore = dependencies.mutateStore ?? defaultMutateStore;
  const now = dependencies.now ?? (() => new Date());
  const id = dependencies.id ?? randomUUID;
  return await mutateStore((data) => {
    const existing = data.jobs.find(
      (job) =>
        job.type === WORKER_CRON_PROJECTION_JOB_TYPE &&
        (job.status === "queued" || job.status === "running"),
    );
    if (existing) return existing;
    const timestamp = now().toISOString();
    const record: JobRecord = {
      id: id(),
      workspaceId: "system",
      type: WORKER_CRON_PROJECTION_JOB_TYPE,
      payload: {},
      status: "queued",
      attempts: 0,
      maxAttempts: 3,
      scheduledAt: timestamp,
      cron: "* * * * *",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    data.jobs.push(record);
    return record;
  });
}

type ActiveTriggerTarget = ReturnType<typeof activeTriggerTargets>[number];

function activeTriggerTargets(
  data: PacketAgentData,
  matches: (trigger: WorkerVersion["content"]["triggers"][number]) => boolean,
) {
  const targets: Array<{
    deployment: PacketAgentData["workerDeployments"][number];
    version: WorkerVersion;
    trigger: WorkerVersion["content"]["triggers"][number];
  }> = [];
  for (const deployment of data.workerDeployments) {
    if (deployment.status !== "active") continue;
    const version = data.workerVersions.find(
      (candidate) =>
        candidate.workspaceId === deployment.workspaceId &&
        candidate.id === deployment.workerVersionId &&
        candidate.status === "validated",
    );
    if (!version) continue;
    for (const trigger of version.content.triggers) {
      if (trigger.enabled && matches(trigger)) {
        targets.push({ deployment, version, trigger });
      }
    }
  }
  return targets;
}

function cronTargets(data: PacketAgentData): Array<
  ActiveTriggerTarget & {
    trigger: Extract<ActiveTriggerTarget["trigger"], { kind: "cron" }>;
  }
> {
  return activeTriggerTargets(data, (trigger) => trigger.kind === "cron").filter(
    (
      target,
    ): target is ActiveTriggerTarget & {
      trigger: Extract<ActiveTriggerTarget["trigger"], { kind: "cron" }>;
    } => target.trigger.kind === "cron",
  );
}

function cronTargetKey(target: ActiveTriggerTarget): string {
  return [target.deployment.workspaceId, target.deployment.id, target.trigger.id].join("\u001f");
}

function cronJobKey(job: JobRecord): string | null {
  const deploymentId = job.payload.workerDeploymentId;
  const triggerId = job.payload.triggerId;
  if (typeof deploymentId !== "string" || typeof triggerId !== "string") return null;
  return [job.workspaceId, deploymentId, triggerId].join("\u001f");
}

function requiredJobString(job: JobRecord, key: string): string {
  const value = job.payload[key];
  if (typeof value !== "string" || !value) {
    throw new Error(`${job.type} job missing ${key}`);
  }
  return value;
}
