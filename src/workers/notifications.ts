import { createHash, randomUUID } from "node:crypto";
import {
  mutateStoreAsync as defaultMutateStore,
  type JobRecord,
  type PacketAgentData,
} from "../packetagent-store.js";
import { JobDeferredError } from "../jobs/scheduler.js";
import { redactSensitiveString, redactSensitiveValue } from "../security/redaction.js";
import {
  WORKER_NOTIFICATION_ENVELOPE_SCHEMA_VERSION,
  WORKER_NOTIFICATION_OUTBOX_SCHEMA_VERSION,
  assertValidWorkerNotificationOutboxItem,
  type WorkerNotificationDeliveryMetadata,
  type WorkerNotificationEnvelope,
  type WorkerNotificationEvent,
  type WorkerNotificationOutboxItem,
} from "./control-types.js";
import { WorkerLifecycleError } from "./errors.js";
import {
  appendWorkerJournalEntry,
  type WorkerJournalAppendResult,
} from "./observability/journal.js";
import type { WorkerJournalAppendInput } from "./persistence-types.js";
import { validateWorkerPersistence } from "./repository.js";
import type {
  JsonObject,
  WorkerNotificationRouteReference,
  WorkerRun,
  WorkerVersion,
} from "./types.js";

type MaybePromise<T> = T | Promise<T>;

export const WORKER_NOTIFICATION_DELIVERY_JOB_TYPE = "worker.notification.deliver" as const;

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_PROGRESS_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_TERMINAL_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const RETRY_BASE_MS = 30_000;
const RETRY_CAP_MS = 60 * 60 * 1_000;
const DELIVERY_ATTEMPT_LEASE_MS = 5 * 60 * 1_000;

type WorkerNotificationIdKind = "outbox" | "job";
type WorkerNotificationIdFactory = (kind: WorkerNotificationIdKind) => string;

export interface WorkerNotificationRequest {
  readonly event: WorkerNotificationEvent;
  readonly title: string;
  readonly deduplicationKey?: string;
  readonly deliveryKeySuffix?: string;
  readonly data?: JsonObject;
  readonly attentionRequestId?: string;
  readonly controlCommandId?: string;
  readonly routeIds?: readonly string[];
  readonly expiresAt?: string;
  readonly maxAttempts?: number;
}

export interface WorkerEventWithNotificationsResult extends WorkerJournalAppendResult {
  readonly outboxItems: readonly WorkerNotificationOutboxItem[];
  readonly jobs: readonly JobRecord[];
}

export function appendWorkerEventWithNotifications(
  data: PacketAgentData,
  input: {
    readonly journal: WorkerJournalAppendInput;
    readonly notification?: WorkerNotificationRequest;
    readonly id?: WorkerNotificationIdFactory;
  },
): WorkerEventWithNotificationsResult {
  const journal = appendWorkerJournalEntry(data, input.journal);
  if (!input.notification) {
    return { ...journal, outboxItems: [], jobs: [] };
  }
  const run = requireRunForEvent(data, journal.event);
  const version = requireVersionForRun(data, run);
  const id = input.id ?? ((kind: WorkerNotificationIdKind) => `${kind}_${randomUUID()}`);
  const createdAt = journal.event.occurredAt;
  const expiresAt =
    input.notification.expiresAt ??
    new Date(
      Date.parse(createdAt) +
        (input.notification.event === "progress"
          ? DEFAULT_PROGRESS_TTL_MS
          : DEFAULT_TERMINAL_TTL_MS),
    ).toISOString();
  const maxAttempts = input.notification.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    Date.parse(expiresAt) <= Date.parse(createdAt)
  ) {
    throw new WorkerLifecycleError(
      "invalid_input",
      "Worker notification retry and expiry bounds are invalid.",
    );
  }

  const routeIds = input.notification.routeIds ? new Set(input.notification.routeIds) : undefined;
  const routes = version.content.notificationRoutes.filter(
    (route) =>
      route.events.includes(input.notification!.event) &&
      (routeIds === undefined || routeIds.has(route.id)),
  );
  const outboxItems: WorkerNotificationOutboxItem[] = [];
  const jobs: JobRecord[] = [];
  for (const route of routes) {
    const deliveryKey = `${input.notification.deduplicationKey ?? journal.event.id}:${
      route.id
    }:${input.notification.deliveryKeySuffix ?? input.notification.event}`;
    const existing = data.workerNotificationDeliveries.find(
      (record) => record.workspaceId === run.workspaceId && record.deliveryKey === deliveryKey,
    );
    if (existing) {
      if (existing.schemaVersion !== WORKER_NOTIFICATION_OUTBOX_SCHEMA_VERSION) {
        throw new WorkerLifecycleError(
          "integrity",
          "Worker notification delivery key collides with a legacy record.",
        );
      }
      outboxItems.push(existing);
      continue;
    }
    const outboxId = id("outbox");
    const envelope = makeEnvelope(
      journal,
      run,
      version,
      input.notification,
      route,
      outboxId,
      input.journal.knownSecretValues,
    );
    const outbox: WorkerNotificationOutboxItem = {
      schemaVersion: WORKER_NOTIFICATION_OUTBOX_SCHEMA_VERSION,
      id: outboxId,
      deliveryKey,
      idempotencyKey: `packetagent-notification-${digest(deliveryKey)}`,
      workspaceId: run.workspaceId,
      workerDefinitionId: run.workerDefinitionId,
      workerDeploymentId: run.workerDeploymentId,
      workerRunId: run.id,
      workerVersionId: run.workerVersionId,
      workerVersionContentDigest: version.contentDigest,
      event: input.notification.event,
      ...(input.notification.attentionRequestId
        ? { attentionRequestId: input.notification.attentionRequestId }
        : {}),
      ...(input.notification.controlCommandId
        ? { controlCommandId: input.notification.controlCommandId }
        : {}),
      sourceEventId: journal.event.id,
      sourceEventDigest: journal.event.eventDigest,
      notificationRouteId: route.id,
      notificationRouteKind: route.kind,
      notificationRouteReference: route.reference,
      envelope,
      status: "queued",
      attemptCount: 0,
      maxAttempts,
      scheduledAt: createdAt,
      expiresAt,
      createdAt,
      updatedAt: createdAt,
    };
    assertValidWorkerNotificationOutboxItem(outbox);
    const job: JobRecord = {
      id: id("job"),
      workspaceId: run.workspaceId,
      type: WORKER_NOTIFICATION_DELIVERY_JOB_TYPE,
      payload: { outboxItemId: outbox.id },
      status: "queued",
      attempts: 0,
      maxAttempts,
      scheduledAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    };
    data.workerNotificationDeliveries.push(outbox);
    data.jobs.push(job);
    outboxItems.push(outbox);
    jobs.push(job);
  }
  return { ...journal, outboxItems, jobs };
}

export interface WorkerNotificationTransport {
  deliver(input: {
    readonly route: WorkerNotificationRouteReference;
    readonly envelope: WorkerNotificationEnvelope;
    readonly idempotencyKey: string;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly deliveryReference: string;
    readonly metadata?: WorkerNotificationDeliveryMetadata;
  }>;
}

export class WorkerNotificationDeliveryError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable: boolean) {
    super(code);
    this.name = "WorkerNotificationDeliveryError";
    this.code = safeFailureCode(code);
    this.retryable = retryable;
  }
}

export type WorkerNotificationDeliveryResult =
  | {
      readonly disposition: "delivered" | "dead_letter" | "expired" | "unchanged";
      readonly outbox: WorkerNotificationOutboxItem;
    }
  | {
      readonly disposition: "retry";
      readonly retryAt: string;
      readonly outbox: WorkerNotificationOutboxItem;
    };

export interface WorkerNotificationServiceDependencies {
  readonly mutateStore?: <T>(
    mutator: (data: PacketAgentData) => MaybePromise<T>,
  ) => MaybePromise<T>;
  readonly transport?: WorkerNotificationTransport;
  readonly now?: () => Date;
}

export interface WorkerNotificationService {
  deliver(input: {
    readonly workspaceId: string;
    readonly outboxItemId: string;
    readonly signal?: AbortSignal;
  }): Promise<WorkerNotificationDeliveryResult>;
}

export function createWorkerNotificationService(
  dependencies: WorkerNotificationServiceDependencies = {},
): WorkerNotificationService {
  const mutateStore = dependencies.mutateStore ?? defaultMutateStore;
  const transport = dependencies.transport ?? createDefaultWorkerNotificationTransport();
  const now = dependencies.now ?? (() => new Date());

  return {
    async deliver(input) {
      const timestamp = now();
      const claim = await mutateStore((data) => {
        validateWorkerPersistence(data);
        const current = requireOutbox(data, input.workspaceId, input.outboxItemId);
        if (current.status === "delivered") {
          return { disposition: "delivered" as const, outbox: current };
        }
        if (current.status === "dead_letter") {
          return { disposition: "dead_letter" as const, outbox: current };
        }
        if (current.status === "expired") {
          return { disposition: "expired" as const, outbox: current };
        }
        if (timestamp.getTime() >= Date.parse(current.expiresAt)) {
          const expired = replaceOutbox(data, current, {
            status: "expired",
            lastFailureCode: "expired",
            updatedAt: timestamp.toISOString(),
          });
          validateWorkerPersistence(data);
          return { disposition: "expired" as const, outbox: expired };
        }
        if (timestamp.getTime() < Date.parse(current.scheduledAt)) {
          return {
            disposition: "retry" as const,
            retryAt: current.scheduledAt,
            outbox: current,
          };
        }
        if (current.attemptCount >= current.maxAttempts) {
          const deadLetter = replaceOutbox(data, current, {
            status: "dead_letter",
            lastFailureCode: current.lastFailureCode ?? "attempts_exhausted",
            updatedAt: timestamp.toISOString(),
          });
          validateWorkerPersistence(data);
          return { disposition: "dead_letter" as const, outbox: deadLetter };
        }
        const sending = replaceOutbox(data, current, {
          status: "sending",
          attemptCount: current.attemptCount + 1,
          lastAttemptAt: timestamp.toISOString(),
          scheduledAt: new Date(timestamp.getTime() + DELIVERY_ATTEMPT_LEASE_MS).toISOString(),
          lastFailureCode: undefined,
          updatedAt: timestamp.toISOString(),
        });
        validateWorkerPersistence(data);
        return { disposition: "sending" as const, outbox: sending };
      });

      if (claim.disposition !== "sending") {
        return clone(claim);
      }

      const route: WorkerNotificationRouteReference = {
        id: claim.outbox.notificationRouteId,
        kind: claim.outbox.notificationRouteKind,
        reference: claim.outbox.notificationRouteReference,
        events: [claim.outbox.event],
      };
      const startedAt = now().getTime();
      try {
        const delivered = await transport.deliver({
          route,
          envelope: claim.outbox.envelope,
          idempotencyKey: claim.outbox.idempotencyKey,
          signal: input.signal ?? new AbortController().signal,
        });
        const completedAt = now();
        const result = await mutateStore((data) => {
          validateWorkerPersistence(data);
          const current = requireMatchingAttempt(data, claim.outbox);
          const metadata = normalizeDeliveryMetadata(
            delivered.metadata,
            route.kind,
            Math.max(0, completedAt.getTime() - startedAt),
          );
          const next = replaceOutbox(data, current, {
            status: "delivered",
            deliveredAt: completedAt.toISOString(),
            deliveryReference: redactSensitiveString(delivered.deliveryReference),
            deliveryMetadata: metadata,
            lastFailureCode: undefined,
            updatedAt: completedAt.toISOString(),
          });
          validateWorkerPersistence(data);
          return next;
        });
        return { disposition: "delivered", outbox: clone(result) };
      } catch (error) {
        const failure =
          error instanceof WorkerNotificationDeliveryError
            ? error
            : new WorkerNotificationDeliveryError("transport_error", true);
        const failedAt = now();
        const result = await mutateStore((data) => {
          validateWorkerPersistence(data);
          const current = requireMatchingAttempt(data, claim.outbox);
          const expired = failedAt.getTime() >= Date.parse(current.expiresAt);
          const deadLetter =
            expired || !failure.retryable || current.attemptCount >= current.maxAttempts;
          const retryAt = new Date(
            Math.min(
              Date.parse(current.expiresAt),
              failedAt.getTime() + retryBackoffMs(current.attemptCount),
            ),
          ).toISOString();
          const next = replaceOutbox(data, current, {
            status: expired ? "expired" : deadLetter ? "dead_letter" : "failed",
            scheduledAt: deadLetter || expired ? current.scheduledAt : retryAt,
            lastFailureCode: expired ? "expired" : failure.code,
            updatedAt: failedAt.toISOString(),
          });
          validateWorkerPersistence(data);
          return { outbox: next, retryAt };
        });
        if (result.outbox.status === "expired") {
          return { disposition: "expired", outbox: clone(result.outbox) };
        }
        if (result.outbox.status === "dead_letter") {
          return { disposition: "dead_letter", outbox: clone(result.outbox) };
        }
        return {
          disposition: "retry",
          retryAt: result.retryAt,
          outbox: clone(result.outbox),
        };
      }
    },
  };
}

export function createWorkerNotificationDeliveryJobHandler(
  service: WorkerNotificationService = createWorkerNotificationService(),
): {
  handle(job: JobRecord, context?: { readonly signal: AbortSignal }): Promise<unknown>;
} {
  return {
    async handle(job, context) {
      if (job.type !== WORKER_NOTIFICATION_DELIVERY_JOB_TYPE) {
        throw new Error(`Unsupported Worker notification job type ${job.type}.`);
      }
      const outboxItemId =
        typeof job.payload.outboxItemId === "string" ? job.payload.outboxItemId.trim() : "";
      if (!outboxItemId) {
        throw new Error("Worker notification delivery job is missing outboxItemId.");
      }
      const result = await service.deliver({
        workspaceId: job.workspaceId,
        outboxItemId,
        ...(context?.signal ? { signal: context.signal } : {}),
      });
      if (result.disposition === "retry") {
        throw new JobDeferredError(
          "Worker notification delivery is scheduled for bounded retry.",
          new Date(result.retryAt),
        );
      }
      return result;
    },
  };
}

export function createDefaultWorkerNotificationTransport(
  externalTransports: Partial<
    Record<
      Exclude<WorkerNotificationRouteReference["kind"], "packetagent">,
      WorkerNotificationTransport
    >
  > = {},
): WorkerNotificationTransport {
  return {
    async deliver(input) {
      if (input.route.kind === "packetagent") {
        return {
          deliveryReference: `packetagent:${input.envelope.id}`,
          metadata: { provider: "packetagent" },
        };
      }
      const transport = externalTransports[input.route.kind];
      if (!transport) {
        throw new WorkerNotificationDeliveryError("route_unavailable", true);
      }
      return transport.deliver(input);
    },
  };
}

function makeEnvelope(
  journal: WorkerJournalAppendResult,
  run: WorkerRun,
  version: WorkerVersion,
  notification: WorkerNotificationRequest,
  route: WorkerNotificationRouteReference,
  outboxId: string,
  knownSecretValues: readonly (string | null | undefined)[] | undefined,
): WorkerNotificationEnvelope {
  const data = redactSensitiveValue(
    {
      ...(journal.event.data ?? {}),
      ...(notification.data ?? {}),
      evidenceId: journal.evidence.id,
      routeKind: route.kind,
    },
    knownSecretValues,
  ) as JsonObject;
  return {
    schemaVersion: WORKER_NOTIFICATION_ENVELOPE_SCHEMA_VERSION,
    id: `envelope:${outboxId}`,
    specversion: "1.0",
    source: `urn:packetagent:worker:${run.workspaceId}`,
    type: (
      {
        attention: "com.packetagent.worker.attention.v1",
        progress: "com.packetagent.worker.progress.v1",
        terminal: "com.packetagent.worker.terminal.v1",
      } as const
    )[notification.event],
    subject: `worker-run:${run.id}`,
    time: journal.event.occurredAt,
    workspaceId: run.workspaceId,
    workerDefinitionId: run.workerDefinitionId,
    workerDeploymentId: run.workerDeploymentId,
    workerRunId: run.id,
    workerVersionId: run.workerVersionId,
    workerVersionContentDigest: version.contentDigest,
    event: notification.event,
    sourceEventId: journal.event.id,
    sourceEventDigest: journal.event.eventDigest,
    evidenceId: journal.evidence.id,
    threadKey: `worker-run:${run.id}`,
    title: redactSensitiveString(notification.title, knownSecretValues),
    summary: journal.event.summary,
    data,
  };
}

function requireRunForEvent(
  data: PacketAgentData,
  event: WorkerJournalAppendResult["event"],
): WorkerRun {
  if (!event.workerRunId) {
    throw new WorkerLifecycleError(
      "integrity",
      "Worker notification source event is not bound to a run.",
    );
  }
  const run = data.workerRuns.find(
    (record) => record.workspaceId === event.workspaceId && record.id === event.workerRunId,
  );
  if (!run) {
    throw new WorkerLifecycleError(
      "integrity",
      "Worker notification source event references a missing run.",
    );
  }
  return run;
}

function requireVersionForRun(data: PacketAgentData, run: WorkerRun): WorkerVersion {
  const version = data.workerVersions.find(
    (record) => record.workspaceId === run.workspaceId && record.id === run.workerVersionId,
  );
  if (!version || version.workerDefinitionId !== run.workerDefinitionId) {
    throw new WorkerLifecycleError(
      "integrity",
      "Worker notification source run references an inconsistent version.",
    );
  }
  return version;
}

function requireOutbox(
  data: PacketAgentData,
  workspaceId: string,
  outboxItemId: string,
): WorkerNotificationOutboxItem {
  const record = data.workerNotificationDeliveries.find(
    (entry) => entry.workspaceId === workspaceId && entry.id === outboxItemId,
  );
  if (!record || record.schemaVersion !== WORKER_NOTIFICATION_OUTBOX_SCHEMA_VERSION) {
    throw new WorkerLifecycleError(
      "not_found",
      `Worker notification outbox item ${outboxItemId} was not found.`,
    );
  }
  return record;
}

function requireMatchingAttempt(
  data: PacketAgentData,
  claimed: WorkerNotificationOutboxItem,
): WorkerNotificationOutboxItem {
  const current = requireOutbox(data, claimed.workspaceId, claimed.id);
  if (
    current.status !== "sending" ||
    current.attemptCount !== claimed.attemptCount ||
    current.idempotencyKey !== claimed.idempotencyKey
  ) {
    throw new WorkerLifecycleError(
      "conflict",
      "Worker notification delivery attempt lost its durable claim.",
    );
  }
  return current;
}

function replaceOutbox(
  data: PacketAgentData,
  current: WorkerNotificationOutboxItem,
  patch: Partial<WorkerNotificationOutboxItem>,
): WorkerNotificationOutboxItem {
  const index = data.workerNotificationDeliveries.findIndex(
    (record) => record.workspaceId === current.workspaceId && record.id === current.id,
  );
  if (index < 0) {
    throw new WorkerLifecycleError(
      "not_found",
      `Worker notification outbox item ${current.id} was not found.`,
    );
  }
  const next = {
    ...current,
    ...patch,
  } as WorkerNotificationOutboxItem;
  data.workerNotificationDeliveries[index] = next;
  return next;
}

function normalizeDeliveryMetadata(
  metadata: WorkerNotificationDeliveryMetadata | undefined,
  routeKind: WorkerNotificationRouteReference["kind"],
  measuredLatencyMs: number,
): WorkerNotificationDeliveryMetadata {
  const provider = redactSensitiveString(metadata?.provider ?? routeKind).slice(0, 100);
  const reportedLatencyMs = metadata?.latencyMs;
  return {
    provider: provider || routeKind,
    ...(metadata?.responseCode !== undefined ? { responseCode: metadata.responseCode } : {}),
    latencyMs:
      typeof reportedLatencyMs === "number" &&
      Number.isSafeInteger(reportedLatencyMs) &&
      reportedLatencyMs >= 0
        ? reportedLatencyMs
        : Math.round(measuredLatencyMs),
  };
}

function safeFailureCode(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_");
  return normalized.slice(0, 100) || "transport_error";
}

function retryBackoffMs(attemptCount: number): number {
  return Math.min(RETRY_BASE_MS * Math.pow(2, Math.max(0, attemptCount - 1)), RETRY_CAP_MS);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
