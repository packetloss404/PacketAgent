import {
  loadStoreAsync as defaultLoadStore,
  mutateStoreAsync as defaultMutateStore,
  type JobRecord,
  type PacketAgentData,
} from "../packetagent-store.js";
import { WorkerLifecycleError } from "./errors.js";
import {
  WORKER_ACTIVATION_INBOX_SCHEMA_VERSION,
  WORKER_ACTIVATION_PAYLOAD_SCHEMA_VERSION,
  WORKER_ACTIVATION_SCHEMA_VERSION,
  workerActivationDeliveryKey,
  type WorkerActivationInboxRecord,
  type WorkerActivationPayloadRecord,
} from "./activation-types.js";
import { appendWorkerJournalEntry } from "./observability/journal.js";
import type { WorkerJournalAppendInput } from "./persistence-types.js";
import { validateWorkerPersistence } from "./repository.js";
import type { WorkerDefinition, WorkerDeployment, WorkerRun, WorkerVersion } from "./types.js";

type MaybePromise<T> = T | Promise<T>;

export interface WorkerActivationRepositoryDependencies {
  readonly loadStore?: () => MaybePromise<PacketAgentData>;
  readonly mutateStore?: <T>(
    mutator: (data: PacketAgentData) => MaybePromise<T>,
  ) => MaybePromise<T>;
}

export interface WorkerActivationRepositoryTransaction {
  readonly workspaceId: string;
  findDefinition(id: string): WorkerDefinition | null;
  findVersion(id: string): WorkerVersion | null;
  findDeployment(id: string): WorkerDeployment | null;
  findInbox(input: {
    workerDeploymentId: string;
    triggerId: string;
    source: WorkerActivationInboxRecord["source"];
    deliveryId: string;
  }): WorkerActivationInboxRecord | null;
  insertInbox(record: WorkerActivationInboxRecord): void;
  replaceInbox(record: WorkerActivationInboxRecord): void;
  insertPayload(record: WorkerActivationPayloadRecord): void;
  insertRun(record: WorkerRun): void;
  insertJob(record: JobRecord): void;
  appendJournal(input: WorkerJournalAppendInput): void;
}

export interface WorkerActivationRepository {
  listInboxes(
    workspaceId: string,
    options?: { workerDeploymentId?: string; limit?: number },
  ): Promise<readonly WorkerActivationInboxRecord[]>;
  findPayloadByReference(
    workspaceId: string,
    reference: string,
  ): Promise<WorkerActivationPayloadRecord | null>;
  pruneExpiredPayloads(workspaceId: string, now: Date): Promise<number>;
  transact<T>(
    workspaceId: string,
    mutation: (transaction: WorkerActivationRepositoryTransaction) => T,
  ): Promise<T>;
}

export function createWorkerActivationRepository(
  dependencies: WorkerActivationRepositoryDependencies = {},
): WorkerActivationRepository {
  const loadStore = dependencies.loadStore ?? defaultLoadStore;
  const mutateStore = dependencies.mutateStore ?? defaultMutateStore;

  return {
    async listInboxes(workspaceId, options = {}) {
      const data = await loadStore();
      validateWorkerActivationPersistence(data);
      const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
      return clone(
        data.workerActivationInboxes
          .filter(
            (record) =>
              record.workspaceId === workspaceId &&
              (options.workerDeploymentId === undefined ||
                record.workerDeploymentId === options.workerDeploymentId),
          )
          .sort((left, right) => {
            const seen = right.firstSeenAt.localeCompare(left.firstSeenAt);
            return seen !== 0 ? seen : left.id.localeCompare(right.id);
          })
          .slice(0, limit),
      );
    },
    async findPayloadByReference(workspaceId, reference) {
      const data = await loadStore();
      validateWorkerActivationPersistence(data);
      return cloneOrNull(
        data.workerActivationPayloads.find(
          (record) => record.workspaceId === workspaceId && record.reference === reference,
        ) ?? null,
      );
    },
    async pruneExpiredPayloads(workspaceId, now) {
      return await mutateStore((data) => {
        validateWorkerActivationPersistence(data);
        const retained = data.workerActivationPayloads.filter(
          (record) =>
            record.workspaceId !== workspaceId || Date.parse(record.expiresAt) > now.getTime(),
        );
        const count = data.workerActivationPayloads.length - retained.length;
        data.workerActivationPayloads = retained;
        validateWorkerActivationPersistence(data);
        return count;
      });
    },
    async transact(workspaceId, mutation) {
      return await mutateStore((data) => {
        validateWorkerActivationPersistence(data);
        const result = mutation(createTransaction(data, workspaceId));
        validateWorkerActivationPersistence(data);
        return clone(result);
      });
    },
  };
}

function createTransaction(
  data: PacketAgentData,
  workspaceId: string,
): WorkerActivationRepositoryTransaction {
  return {
    workspaceId,
    findDefinition(id) {
      return (
        data.workerDefinitions.find(
          (record) => record.workspaceId === workspaceId && record.id === id,
        ) ?? null
      );
    },
    findVersion(id) {
      return (
        data.workerVersions.find(
          (record) => record.workspaceId === workspaceId && record.id === id,
        ) ?? null
      );
    },
    findDeployment(id) {
      return (
        data.workerDeployments.find(
          (record) => record.workspaceId === workspaceId && record.id === id,
        ) ?? null
      );
    },
    findInbox(input) {
      const key = workerActivationDeliveryKey({ workspaceId, ...input });
      return (
        data.workerActivationInboxes.find(
          (record) => workerActivationDeliveryKey(record) === key,
        ) ?? null
      );
    },
    insertInbox(record) {
      assertWorkspace(record.workspaceId, workspaceId);
      const key = workerActivationDeliveryKey(record);
      if (
        data.workerActivationInboxes.some(
          (entry) =>
            entry.workspaceId === workspaceId &&
            (entry.id === record.id || workerActivationDeliveryKey(entry) === key),
        )
      ) {
        throw new WorkerLifecycleError("conflict", "Worker activation delivery already exists.");
      }
      data.workerActivationInboxes.push(record);
    },
    replaceInbox(record) {
      replaceWorkspaceRecord(
        data.workerActivationInboxes,
        workspaceId,
        record,
        "WorkerActivationInbox",
      );
    },
    insertPayload(record) {
      assertWorkspace(record.workspaceId, workspaceId);
      if (
        data.workerActivationPayloads.some(
          (entry) =>
            entry.workspaceId === workspaceId &&
            (entry.id === record.id || entry.reference === record.reference),
        )
      ) {
        throw new WorkerLifecycleError(
          "conflict",
          "Worker activation payload reference already exists.",
        );
      }
      data.workerActivationPayloads.push(record);
    },
    insertRun(record) {
      assertWorkspace(record.workspaceId, workspaceId);
      if (
        data.workerRuns.some((entry) => entry.workspaceId === workspaceId && entry.id === record.id)
      ) {
        throw new WorkerLifecycleError("conflict", `WorkerRun ${record.id} already exists.`);
      }
      data.workerRuns.push(record);
    },
    insertJob(record) {
      assertWorkspace(record.workspaceId, workspaceId);
      if (data.jobs.some((entry) => entry.id === record.id)) {
        throw new WorkerLifecycleError("conflict", `Job ${record.id} already exists.`);
      }
      data.jobs.push(record);
    },
    appendJournal(input) {
      assertWorkspace(input.workspaceId, workspaceId);
      appendWorkerJournalEntry(data, input);
    },
  };
}

export function validateWorkerActivationPersistence(data: PacketAgentData): void {
  validateWorkerPersistence(data);
  try {
    assertUnique(data.workerActivationInboxes, (record) => `${record.workspaceId}:${record.id}`);
    assertUnique(data.workerActivationInboxes, workerActivationDeliveryKey);
    assertUnique(data.workerActivationPayloads, (record) => `${record.workspaceId}:${record.id}`);
    assertUnique(
      data.workerActivationPayloads,
      (record) => `${record.workspaceId}:${record.reference}`,
    );

    for (const payload of data.workerActivationPayloads) {
      if (
        payload.schemaVersion !== WORKER_ACTIVATION_PAYLOAD_SCHEMA_VERSION ||
        !payload.id ||
        !payload.reference ||
        !payload.workspaceId ||
        !payload.digest.startsWith("sha256:") ||
        !["large", "sensitive", "large_and_sensitive"].includes(payload.classification) ||
        !Number.isSafeInteger(payload.byteLength) ||
        payload.byteLength < 0 ||
        !payload.ciphertext ||
        !payload.iv ||
        !payload.authTag ||
        !isCanonicalTimestamp(payload.createdAt) ||
        !isCanonicalTimestamp(payload.expiresAt) ||
        Date.parse(payload.expiresAt) <= Date.parse(payload.createdAt)
      ) {
        throw new Error(`Worker activation payload ${payload.id || "<unknown>"} is invalid.`);
      }
    }

    for (const inbox of data.workerActivationInboxes) {
      validateInbox(data, inbox);
    }
  } catch (error) {
    if (error instanceof WorkerLifecycleError) throw error;
    throw new WorkerLifecycleError(
      "integrity",
      `Worker activation persistence integrity check failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

function validateInbox(data: PacketAgentData, inbox: WorkerActivationInboxRecord): void {
  const envelope = inbox.envelope;
  if (
    inbox.schemaVersion !== WORKER_ACTIVATION_INBOX_SCHEMA_VERSION ||
    inbox.disposition !== "accepted" ||
    !inbox.id ||
    !inbox.workspaceId ||
    !inbox.workerDeploymentId ||
    !inbox.workerVersionId ||
    !inbox.triggerId ||
    !inbox.deliveryId ||
    !inbox.requestDigest.startsWith("sha256:") ||
    !inbox.workerRunId ||
    !inbox.executionJobId ||
    !["manual", "cron", "webhook", "alert", "queue"].includes(inbox.source) ||
    !Number.isSafeInteger(inbox.duplicateCount) ||
    inbox.duplicateCount < 0 ||
    !isCanonicalTimestamp(inbox.firstSeenAt) ||
    !isCanonicalTimestamp(inbox.lastSeenAt) ||
    envelope.schemaVersion !== WORKER_ACTIVATION_SCHEMA_VERSION ||
    envelope.workspaceId !== inbox.workspaceId ||
    envelope.workerDeploymentId !== inbox.workerDeploymentId ||
    envelope.workerVersionId !== inbox.workerVersionId ||
    envelope.triggerId !== inbox.triggerId ||
    envelope.source !== inbox.source ||
    envelope.deliveryId !== inbox.deliveryId ||
    envelope.triggerKind !== inbox.source ||
    envelope.receivedAt !== inbox.firstSeenAt ||
    Date.parse(inbox.lastSeenAt) < Date.parse(inbox.firstSeenAt) ||
    !isCanonicalTimestamp(envelope.occurredAt) ||
    !isCanonicalTimestamp(envelope.receivedAt) ||
    !envelope.actor?.id ||
    !envelope.actor.type ||
    !/^[0-9a-f]{32}$/.test(envelope.trace?.traceId ?? "") ||
    /^0{32}$/.test(envelope.trace?.traceId ?? "") ||
    (envelope.trace?.spanId !== undefined &&
      (!/^[0-9a-f]{16}$/.test(envelope.trace.spanId) || /^0{16}$/.test(envelope.trace.spanId)))
  ) {
    throw new Error(`Worker activation inbox ${inbox.id || "<unknown>"} is invalid.`);
  }
  if ((envelope.payload === undefined) === (envelope.payloadReference === undefined)) {
    throw new Error(`Worker activation inbox ${inbox.id} must contain one payload form.`);
  }
  if (
    envelope.payloadRetention.mode === "inline" &&
    (envelope.payload === undefined || envelope.payloadReference !== undefined)
  ) {
    throw new Error(`Worker activation inbox ${inbox.id} has invalid inline retention.`);
  }
  if (
    envelope.payloadRetention.mode === "encrypted_reference" &&
    (envelope.payloadReference === undefined ||
      envelope.payload !== undefined ||
      envelope.payloadReference.encrypted !== true ||
      !envelope.payloadReference.digest.startsWith("sha256:") ||
      !Number.isSafeInteger(envelope.payloadReference.byteLength) ||
      envelope.payloadReference.byteLength < 0 ||
      !isCanonicalTimestamp(envelope.payloadReference.expiresAt) ||
      envelope.payloadRetention.expiresAt !== envelope.payloadReference.expiresAt)
  ) {
    throw new Error(`Worker activation inbox ${inbox.id} has invalid reference retention.`);
  }

  const deployment = data.workerDeployments.find(
    (record) => record.workspaceId === inbox.workspaceId && record.id === inbox.workerDeploymentId,
  );
  const version = data.workerVersions.find(
    (record) => record.workspaceId === inbox.workspaceId && record.id === inbox.workerVersionId,
  );
  const run = data.workerRuns.find(
    (record) => record.workspaceId === inbox.workspaceId && record.id === inbox.workerRunId,
  );
  const job = data.jobs.find(
    (record) => record.workspaceId === inbox.workspaceId && record.id === inbox.executionJobId,
  );
  if (
    !deployment ||
    !version ||
    !run ||
    !job ||
    deployment.workerVersionId !== version.id ||
    run.workerDeploymentId !== deployment.id ||
    run.workerVersionId !== version.id ||
    job.type !== "worker.run" ||
    job.payload.workerRunId !== run.id ||
    job.payload.workerDeploymentId !== deployment.id ||
    job.payload.workerVersionId !== version.id ||
    job.payload.activationInboxId !== inbox.id
  ) {
    throw new Error(`Worker activation inbox ${inbox.id} has inconsistent references.`);
  }
  if (envelope.payloadReference) {
    const payload = data.workerActivationPayloads.find(
      (record) =>
        record.workspaceId === inbox.workspaceId &&
        record.reference === envelope.payloadReference?.reference,
    );
    if (
      payload &&
      (payload.digest !== envelope.payloadReference.digest ||
        payload.expiresAt !== envelope.payloadReference.expiresAt)
    ) {
      throw new Error(`Worker activation inbox ${inbox.id} has an inconsistent payload reference.`);
    }
  }
}

function replaceWorkspaceRecord<T extends { readonly id: string; readonly workspaceId: string }>(
  collection: T[],
  workspaceId: string,
  record: T,
  label: string,
): void {
  assertWorkspace(record.workspaceId, workspaceId);
  const index = collection.findIndex(
    (entry) => entry.workspaceId === workspaceId && entry.id === record.id,
  );
  if (index < 0) {
    throw new WorkerLifecycleError("not_found", `${label} ${record.id} was not found.`);
  }
  collection[index] = record;
}

function assertWorkspace(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new WorkerLifecycleError(
      "integrity",
      "Worker activation transaction attempted a cross-workspace write.",
    );
  }
}

function assertUnique<T>(records: readonly T[], key: (record: T) => string): void {
  const seen = new Set<string>();
  for (const record of records) {
    const value = key(record);
    if (seen.has(value)) throw new Error(`duplicate Worker activation key ${value}`);
    seen.add(value);
  }
}

function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneOrNull<T>(value: T | null): T | null {
  return value === null ? null : clone(value);
}
