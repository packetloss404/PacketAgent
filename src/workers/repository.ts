import { createHash } from "node:crypto";
import {
  loadStoreAsync as defaultLoadStore,
  mutateStoreAsync as defaultMutateStore,
  type PacketAgentData,
} from "../packetagent-store.js";
import { WorkerLifecycleError } from "./errors.js";
import {
  assertWorkerDeploymentPolicyIntegrity,
  workerCompiledPolicyDigest,
} from "./capabilities.js";
import { assertValidWorkerCredentialRecord } from "./credential-types.js";
import { assertValidWorkerBudgetReservationRecord } from "./budget-types.js";
import {
  WORKER_NOTIFICATION_OUTBOX_SCHEMA_VERSION,
  assertValidWorkerApprovalGrant,
  assertValidWorkerAttentionRequest,
  assertValidWorkerControlCommand,
  assertValidWorkerNotificationDeliveryReference,
  type WorkerControlRunBinding,
} from "./control-types.js";
import {
  WORKER_COMMAND_SCHEMA_VERSION,
  WORKER_EVENT_SCHEMA_VERSION,
  WORKER_ROLLOUT_SCHEMA_VERSION,
  type WorkerDeploymentRollout,
  type WorkerEvent,
  type WorkerJournalAppendInput,
  type WorkerLifecycleCommandReceipt,
} from "./persistence-types.js";
import { WORKER_EFFECT_RECEIPT_SCHEMA_VERSION, type WorkerEffectReceipt } from "./effect-types.js";
import { appendWorkerJournalEntry } from "./observability/journal.js";
import {
  assertValidPacketProductCredentialRecord,
  assertValidWorkerPackageDeploymentRecord,
  assertValidWorkerPackageReceipt,
} from "./package/trust-types.js";
import { assertValidPacketProductEventAcknowledgementRecord } from "./package/event-types.js";
import {
  assertValidWorkerArtifactManifest,
  assertValidWorkerEvidenceEntry,
  assertValidWorkerEvent,
} from "./observability/validation.js";
import type { WorkerDefinition, WorkerDeployment, WorkerVersion } from "./types.js";
import {
  assertValidWorkerCheckpoint,
  assertValidWorkerDefinition,
  assertValidWorkerDeployment,
  assertValidWorkerRun,
  assertValidWorkerVersion,
  canonicalWorkerJson,
  validateWorkerRecordSet,
} from "./validation.js";

type MaybePromise<T> = T | Promise<T>;

export interface WorkerRepositoryDependencies {
  readonly loadStore?: () => MaybePromise<PacketAgentData>;
  readonly mutateStore?: <T>(
    mutator: (data: PacketAgentData) => MaybePromise<T>,
  ) => MaybePromise<T>;
}

export interface WorkerRepositoryTransaction {
  readonly workspaceId: string;
  findDefinition(id: string): WorkerDefinition | null;
  findVersion(id: string): WorkerVersion | null;
  findDeployment(id: string): WorkerDeployment | null;
  listVersions(workerDefinitionId: string): WorkerVersion[];
  listDeployments(workerDefinitionId: string): WorkerDeployment[];
  nextVersionNumber(workerDefinitionId: string): number;
  nextEventSequence(): number;
  findCommandReceipt(idempotencyKey: string): WorkerLifecycleCommandReceipt | null;
  insertDefinition(record: WorkerDefinition): void;
  replaceDefinition(record: WorkerDefinition): void;
  insertVersion(record: WorkerVersion): void;
  replaceVersion(record: WorkerVersion): void;
  insertDeployment(record: WorkerDeployment): void;
  replaceDeployment(record: WorkerDeployment): void;
  insertRollout(record: WorkerDeploymentRollout): void;
  insertCommandReceipt(record: WorkerLifecycleCommandReceipt): void;
  appendJournal(input: WorkerJournalAppendInput): void;
}

export interface WorkerRepository {
  listDefinitions(workspaceId: string): Promise<WorkerDefinition[]>;
  findDefinition(workspaceId: string, id: string): Promise<WorkerDefinition | null>;
  listVersions(workspaceId: string, workerDefinitionId: string): Promise<WorkerVersion[]>;
  findVersion(workspaceId: string, id: string): Promise<WorkerVersion | null>;
  listDeployments(workspaceId: string, workerDefinitionId?: string): Promise<WorkerDeployment[]>;
  findDeployment(workspaceId: string, id: string): Promise<WorkerDeployment | null>;
  listRollouts(workspaceId: string, workerDefinitionId: string): Promise<WorkerDeploymentRollout[]>;
  listEvents(workspaceId: string, afterSequence?: number): Promise<WorkerEvent[]>;
  transact<T>(
    workspaceId: string,
    mutation: (transaction: WorkerRepositoryTransaction) => T,
  ): Promise<T>;
}

export function createWorkerRepository(
  dependencies: WorkerRepositoryDependencies = {},
): WorkerRepository {
  const loadStore = dependencies.loadStore ?? defaultLoadStore;
  const mutateStore = dependencies.mutateStore ?? defaultMutateStore;

  return {
    async listDefinitions(workspaceId) {
      const data = await loadStore();
      validateWorkerPersistence(data);
      return clone(
        data.workerDefinitions
          .filter((record) => record.workspaceId === workspaceId)
          .sort((left, right) => {
            const updated = right.updatedAt.localeCompare(left.updatedAt);
            return updated !== 0 ? updated : left.id.localeCompare(right.id);
          }),
      );
    },
    async findDefinition(workspaceId, id) {
      const data = await loadStore();
      validateWorkerPersistence(data);
      return cloneOrNull(
        data.workerDefinitions.find(
          (record) => record.workspaceId === workspaceId && record.id === id,
        ) ?? null,
      );
    },
    async listVersions(workspaceId, workerDefinitionId) {
      const data = await loadStore();
      validateWorkerPersistence(data);
      return clone(
        data.workerVersions
          .filter(
            (record) =>
              record.workspaceId === workspaceId &&
              record.workerDefinitionId === workerDefinitionId,
          )
          .sort((left, right) => right.version - left.version),
      );
    },
    async findVersion(workspaceId, id) {
      const data = await loadStore();
      validateWorkerPersistence(data);
      return cloneOrNull(
        data.workerVersions.find(
          (record) => record.workspaceId === workspaceId && record.id === id,
        ) ?? null,
      );
    },
    async listDeployments(workspaceId, workerDefinitionId) {
      const data = await loadStore();
      validateWorkerPersistence(data);
      return clone(
        data.workerDeployments
          .filter(
            (record) =>
              record.workspaceId === workspaceId &&
              (workerDefinitionId === undefined ||
                record.workerDefinitionId === workerDefinitionId),
          )
          .sort((left, right) => {
            const updated = right.updatedAt.localeCompare(left.updatedAt);
            return updated !== 0 ? updated : left.id.localeCompare(right.id);
          }),
      );
    },
    async findDeployment(workspaceId, id) {
      const data = await loadStore();
      validateWorkerPersistence(data);
      return cloneOrNull(
        data.workerDeployments.find(
          (record) => record.workspaceId === workspaceId && record.id === id,
        ) ?? null,
      );
    },
    async listRollouts(workspaceId, workerDefinitionId) {
      const data = await loadStore();
      validateWorkerPersistence(data);
      return clone(
        data.workerDeploymentRollouts
          .filter(
            (record) =>
              record.workspaceId === workspaceId &&
              record.workerDefinitionId === workerDefinitionId,
          )
          .sort((left, right) => {
            const created = right.createdAt.localeCompare(left.createdAt);
            return created !== 0 ? created : left.id.localeCompare(right.id);
          }),
      );
    },
    async listEvents(workspaceId, afterSequence = 0) {
      const data = await loadStore();
      validateWorkerPersistence(data);
      return clone(
        data.workerEvents
          .filter((record) => record.workspaceId === workspaceId && record.sequence > afterSequence)
          .sort((left, right) => left.sequence - right.sequence),
      );
    },
    async transact(workspaceId, mutation) {
      return await mutateStore((data) => {
        validateWorkerPersistence(data);
        const transaction = createTransaction(data, workspaceId);
        const result = mutation(transaction);
        validateWorkerPersistence(data);
        return clone(result);
      });
    },
  };
}

function createTransaction(
  data: PacketAgentData,
  workspaceId: string,
): WorkerRepositoryTransaction {
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
    listVersions(workerDefinitionId) {
      return data.workerVersions.filter(
        (record) =>
          record.workspaceId === workspaceId && record.workerDefinitionId === workerDefinitionId,
      );
    },
    listDeployments(workerDefinitionId) {
      return data.workerDeployments.filter(
        (record) =>
          record.workspaceId === workspaceId && record.workerDefinitionId === workerDefinitionId,
      );
    },
    nextVersionNumber(workerDefinitionId) {
      return (
        data.workerVersions
          .filter(
            (record) =>
              record.workspaceId === workspaceId &&
              record.workerDefinitionId === workerDefinitionId,
          )
          .reduce((maximum, record) => Math.max(maximum, record.version), 0) + 1
      );
    },
    nextEventSequence() {
      return (
        data.workerEvents
          .filter((record) => record.workspaceId === workspaceId)
          .reduce((maximum, record) => Math.max(maximum, record.sequence), 0) + 1
      );
    },
    findCommandReceipt(idempotencyKey) {
      return (
        data.workerCommandReceipts.find(
          (record) =>
            record.workspaceId === workspaceId && record.idempotencyKey === idempotencyKey,
        ) ?? null
      );
    },
    insertDefinition(record) {
      assertWorkspace(record.workspaceId, workspaceId);
      assertMissingId(data.workerDefinitions, workspaceId, record.id, "WorkerDefinition");
      data.workerDefinitions.push(record);
    },
    replaceDefinition(record) {
      replaceRecord(data.workerDefinitions, workspaceId, record, "WorkerDefinition");
    },
    insertVersion(record) {
      assertWorkspace(record.workspaceId, workspaceId);
      assertMissingId(data.workerVersions, workspaceId, record.id, "WorkerVersion");
      data.workerVersions.push(record);
    },
    replaceVersion(record) {
      replaceRecord(data.workerVersions, workspaceId, record, "WorkerVersion");
    },
    insertDeployment(record) {
      assertWorkspace(record.workspaceId, workspaceId);
      assertMissingId(data.workerDeployments, workspaceId, record.id, "WorkerDeployment");
      data.workerDeployments.push(record);
    },
    replaceDeployment(record) {
      replaceRecord(data.workerDeployments, workspaceId, record, "WorkerDeployment");
    },
    insertRollout(record) {
      assertWorkspace(record.workspaceId, workspaceId);
      assertMissingId(
        data.workerDeploymentRollouts,
        workspaceId,
        record.id,
        "WorkerDeploymentRollout",
      );
      data.workerDeploymentRollouts.push(record);
    },
    insertCommandReceipt(record) {
      assertWorkspace(record.workspaceId, workspaceId);
      if (
        data.workerCommandReceipts.some(
          (entry) =>
            entry.workspaceId === workspaceId && entry.idempotencyKey === record.idempotencyKey,
        )
      ) {
        throw new WorkerLifecycleError(
          "conflict",
          "Worker lifecycle idempotency key already exists.",
        );
      }
      data.workerCommandReceipts.push(record);
    },
    appendJournal(input) {
      assertWorkspace(input.workspaceId, workspaceId);
      appendWorkerJournalEntry(data, input);
    },
  };
}

function replaceRecord<T extends { readonly id: string; readonly workspaceId: string }>(
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

function assertMissingId<T extends { readonly id: string; readonly workspaceId: string }>(
  collection: readonly T[],
  workspaceId: string,
  id: string,
  label: string,
): void {
  if (collection.some((entry) => entry.workspaceId === workspaceId && entry.id === id)) {
    throw new WorkerLifecycleError("conflict", `${label} ${id} already exists.`);
  }
}

function assertWorkspace(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new WorkerLifecycleError(
      "integrity",
      "Worker repository transaction attempted a cross-workspace write.",
    );
  }
}

export function validateWorkerPersistence(data: PacketAgentData): void {
  try {
    data.workerCredentials.forEach(assertValidWorkerCredentialRecord);
    data.packetProductCredentials.forEach(assertValidPacketProductCredentialRecord);
    data.workerPackageReceipts.forEach(assertValidWorkerPackageReceipt);
    data.workerPackageDeployments.forEach(assertValidWorkerPackageDeploymentRecord);
    data.packetProductEventAcknowledgements.forEach(
      assertValidPacketProductEventAcknowledgementRecord,
    );
    data.workerDefinitions.forEach(assertValidWorkerDefinition);
    data.workerVersions.forEach(assertValidWorkerVersion);
    data.workerDeployments.forEach(assertValidWorkerDeployment);
    data.workerRuns.forEach(assertValidWorkerRun);
    data.workerCheckpoints.forEach(assertValidWorkerCheckpoint);
    data.workerEffectReceipts.forEach(assertValidWorkerEffectReceipt);
    data.workerBudgetReservations.forEach(assertValidWorkerBudgetReservationRecord);
    data.workerAttentionRequests.forEach(assertValidWorkerAttentionRequest);
    data.workerApprovalGrants.forEach(assertValidWorkerApprovalGrant);
    data.workerControlCommands.forEach(assertValidWorkerControlCommand);
    data.workerNotificationDeliveries.forEach(assertValidWorkerNotificationDeliveryReference);
    data.workerEvidenceEntries.forEach(assertValidWorkerEvidenceEntry);
    data.workerArtifactManifests.forEach(assertValidWorkerArtifactManifest);

    assertUnique(data.workerCredentials, (record) => `${record.workspaceId}:${record.id}`);
    assertUnique(data.workerCredentials, (record) => `${record.workspaceId}:${record.reference}`);
    assertUnique(data.packetProductCredentials, (record) => `${record.workspaceId}:${record.id}`);
    assertUnique(data.workerPackageReceipts, (record) => `${record.workspaceId}:${record.id}`);
    assertUnique(
      data.workerPackageReceipts,
      (record) => `${record.workspaceId}:${record.idempotencyKey}`,
    );
    assertUnique(data.workerPackageDeployments, (record) => `${record.workspaceId}:${record.id}`);
    assertUnique(
      data.workerPackageDeployments,
      (record) => `${record.workspaceId}:${record.workerDeploymentId}`,
    );
    assertUnique(
      data.packetProductEventAcknowledgements,
      (record) => `${record.workspaceId}:${record.id}`,
    );
    assertUnique(
      data.packetProductEventAcknowledgements,
      (record) => `${record.workspaceId}:${record.idempotencyKey}`,
    );
    assertUnique(data.workerDefinitions, (record) => `${record.workspaceId}:${record.id}`);
    assertUnique(data.workerVersions, (record) => `${record.workspaceId}:${record.id}`);
    assertUnique(
      data.workerVersions,
      (record) => `${record.workspaceId}:${record.workerDefinitionId}:${record.version}`,
    );
    assertUnique(data.workerDeployments, (record) => `${record.workspaceId}:${record.id}`);
    assertUnique(data.workerRuns, (record) => `${record.workspaceId}:${record.id}`);
    assertUnique(data.workerCheckpoints, (record) => `${record.workspaceId}:${record.id}`);
    assertUnique(
      data.workerCheckpoints,
      (record) => `${record.workspaceId}:${record.workerRunId}:${record.sequence}`,
    );
    assertUnique(data.workerEffectReceipts, (record) => `${record.workspaceId}:${record.id}`);
    assertUnique(
      data.workerEffectReceipts,
      (record) => `${record.workspaceId}:${record.effectKey}`,
    );
    assertUnique(
      data.workerEffectReceipts,
      (record) =>
        `${record.workspaceId}:${record.workerRunId}:${record.iteration}:${record.actionId}`,
    );
    assertUnique(data.workerBudgetReservations, (record) => `${record.workspaceId}:${record.id}`);
    assertUnique(
      data.workerBudgetReservations,
      (record) => `${record.workspaceId}:${record.reservationKey}`,
    );
    assertUnique(data.workerAttentionRequests, (record) => `${record.workspaceId}:${record.id}`);
    assertUnique(
      data.workerAttentionRequests,
      (record) => `${record.workspaceId}:${record.requestKey}`,
    );
    assertUnique(data.workerApprovalGrants, (record) => `${record.workspaceId}:${record.id}`);
    assertUnique(
      data.workerApprovalGrants,
      (record) => `${record.workspaceId}:${record.nonceDigest}`,
    );
    assertUnique(data.workerControlCommands, (record) => `${record.workspaceId}:${record.id}`);
    assertUnique(
      data.workerControlCommands,
      (record) => `${record.workspaceId}:${record.idempotencyKey}`,
    );
    assertUnique(
      data.workerNotificationDeliveries,
      (record) => `${record.workspaceId}:${record.id}`,
    );
    assertUnique(
      data.workerNotificationDeliveries,
      (record) => `${record.workspaceId}:${record.deliveryKey}`,
    );
    assertUnique(
      data.workerNotificationDeliveries.filter(
        (record) => record.schemaVersion === WORKER_NOTIFICATION_OUTBOX_SCHEMA_VERSION,
      ),
      (record) => `${record.workspaceId}:${record.idempotencyKey}`,
    );
    assertUnique(
      data.workerCommandReceipts,
      (record) => `${record.workspaceId}:${record.idempotencyKey}`,
    );
    assertUnique(data.workerCommandReceipts, (record) => `${record.workspaceId}:${record.id}`);
    assertUnique(data.workerDeploymentRollouts, (record) => `${record.workspaceId}:${record.id}`);
    assertUnique(data.workerEvents, (record) => `${record.workspaceId}:${record.id}`);
    assertUnique(data.workerEvents, (record) => `${record.workspaceId}:${record.sequence}`);
    assertUnique(data.workerEvidenceEntries, (record) => `${record.workspaceId}:${record.id}`);
    assertUnique(
      data.workerEvidenceEntries,
      (record) => `${record.workspaceId}:${record.sequence}`,
    );
    assertUnique(data.workerArtifactManifests, (record) => `${record.workspaceId}:${record.id}`);

    validatePackageTrustReferences(data);
    validateCoreReferences(data);
    validateSupportRecords(data);
    for (const definition of data.workerDefinitions) {
      const deployments = data.workerDeployments.filter(
        (record) =>
          record.workspaceId === definition.workspaceId &&
          record.workerDefinitionId === definition.id,
      );
      if (deployments.filter((record) => record.status === "active").length > 1) {
        throw new Error(`WorkerDefinition ${definition.id} has more than one active deployment.`);
      }
      const issues = validateWorkerRecordSet({
        definition,
        versions: data.workerVersions.filter(
          (record) =>
            record.workspaceId === definition.workspaceId &&
            record.workerDefinitionId === definition.id,
        ),
        deployments,
        runs: data.workerRuns.filter(
          (record) =>
            record.workspaceId === definition.workspaceId &&
            record.workerDefinitionId === definition.id,
        ),
        checkpoints: data.workerCheckpoints.filter((checkpoint) =>
          data.workerRuns.some(
            (run) =>
              run.workspaceId === definition.workspaceId &&
              run.workerDefinitionId === definition.id &&
              run.id === checkpoint.workerRunId,
          ),
        ),
      });
      if (issues.length > 0) {
        throw new Error(issues.map((entry) => `${entry.path} ${entry.message}`).join("; "));
      }
      if (
        definition.currentVersionId &&
        !data.workerVersions.some(
          (record) =>
            record.workspaceId === definition.workspaceId &&
            record.workerDefinitionId === definition.id &&
            record.id === definition.currentVersionId,
        )
      ) {
        throw new Error(`WorkerDefinition ${definition.id} currentVersionId does not resolve.`);
      }
    }
  } catch (error) {
    if (error instanceof WorkerLifecycleError) throw error;
    throw new WorkerLifecycleError(
      "integrity",
      `Worker persistence integrity check failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

function validatePackageTrustReferences(data: PacketAgentData): void {
  const packageDigests = new Map<string, string>();
  for (const receipt of data.workerPackageReceipts) {
    const credential = data.packetProductCredentials.find(
      (record) => record.workspaceId === receipt.workspaceId && record.id === receipt.credentialId,
    );
    if (!credential) {
      throw new Error(
        `Worker package receipt ${receipt.id} references a missing Packet-product credential.`,
      );
    }
    if (
      receipt.authenticatedActor.id !== credential.subjectId ||
      receipt.authenticatedActor.product !== credential.product
    ) {
      throw new Error(
        `Worker package receipt ${receipt.id} actor does not match its Packet-product credential.`,
      );
    }
    if (
      receipt.workerVersionContentDigest !==
      receipt.capabilityDecision.compiledPolicy.workerVersionContentDigest
    ) {
      throw new Error(
        `Worker package receipt ${receipt.id} compiled policy is bound to another version digest.`,
      );
    }
    const { policyDigest: _policyDigest, ...policy } = receipt.capabilityDecision.compiledPolicy;
    if (
      receipt.capabilityDecision.compiledPolicy.policyDigest !== workerCompiledPolicyDigest(policy)
    ) {
      throw new Error(`Worker package receipt ${receipt.id} compiled policy digest is invalid.`);
    }
    const coordinate = `${receipt.workspaceId}:${receipt.packageId}:${receipt.packageVersion}`;
    const priorDigest = packageDigests.get(coordinate);
    if (priorDigest !== undefined && priorDigest !== receipt.packageDigest) {
      throw new Error(
        `Worker package coordinate ${coordinate} is bound to multiple package digests.`,
      );
    }
    packageDigests.set(coordinate, receipt.packageDigest);
  }
  for (const binding of data.workerPackageDeployments) {
    const receipt = data.workerPackageReceipts.find(
      (record) => record.workspaceId === binding.workspaceId && record.id === binding.receiptId,
    );
    const definition = data.workerDefinitions.find(
      (record) =>
        record.workspaceId === binding.workspaceId && record.id === binding.workerDefinitionId,
    );
    const version = data.workerVersions.find(
      (record) =>
        record.workspaceId === binding.workspaceId && record.id === binding.workerVersionId,
    );
    const deployment = data.workerDeployments.find(
      (record) =>
        record.workspaceId === binding.workspaceId && record.id === binding.workerDeploymentId,
    );
    if (!receipt || !definition || !version || !deployment) {
      throw new Error(
        `Worker package deployment ${binding.id} references a missing receipt or Worker record.`,
      );
    }
    if (
      binding.packageId !== receipt.packageId ||
      binding.packageVersion !== receipt.packageVersion ||
      binding.packageDigest !== receipt.packageDigest ||
      canonicalWorkerJson(binding.actor) !== canonicalWorkerJson(receipt.authenticatedActor) ||
      version.workerDefinitionId !== definition.id ||
      deployment.workerDefinitionId !== definition.id ||
      deployment.workerVersionId !== version.id ||
      version.contentDigest !== receipt.workerVersionContentDigest ||
      canonicalWorkerJson(version.source) !== canonicalWorkerJson(receipt.source)
    ) {
      throw new Error(
        `Worker package deployment ${binding.id} is not bound to its accepted package and immutable Worker records.`,
      );
    }
    if (
      canonicalWorkerJson(deployment.capabilityGrants ?? []) !==
        canonicalWorkerJson(receipt.capabilityDecision.grants) ||
      deployment.compiledPolicy?.policyDigest !==
        receipt.capabilityDecision.compiledPolicy.policyDigest
    ) {
      throw new Error(
        `Worker package deployment ${binding.id} does not preserve its locally accepted capability decision.`,
      );
    }
  }
  for (const acknowledgement of data.packetProductEventAcknowledgements) {
    const credential = data.packetProductCredentials.find(
      (record) =>
        record.workspaceId === acknowledgement.workspaceId &&
        record.id === acknowledgement.credentialId,
    );
    const binding = data.workerPackageDeployments.find(
      (record) =>
        record.workspaceId === acknowledgement.workspaceId &&
        record.id === acknowledgement.packageDeploymentId,
    );
    const run = acknowledgement.workerRunId
      ? data.workerRuns.find(
          (record) =>
            record.workspaceId === acknowledgement.workspaceId &&
            record.id === acknowledgement.workerRunId,
        )
      : undefined;
    if (
      !credential ||
      !binding ||
      binding.workerDeploymentId !== acknowledgement.workerDeploymentId ||
      acknowledgement.actor.id !== credential.subjectId ||
      acknowledgement.actor.product !== credential.product ||
      (acknowledgement.streamKind === "run" &&
        (!run || run.workerDeploymentId !== acknowledgement.workerDeploymentId))
    ) {
      throw new Error(
        `Packet-product event acknowledgement ${acknowledgement.id} has an invalid credential, deployment, or run binding.`,
      );
    }
  }
}

function validateCoreReferences(data: PacketAgentData): void {
  for (const version of data.workerVersions) {
    if (
      !data.workerDefinitions.some(
        (record) =>
          record.workspaceId === version.workspaceId && record.id === version.workerDefinitionId,
      )
    ) {
      throw new Error(`WorkerVersion ${version.id} references a missing definition.`);
    }
  }
  for (const deployment of data.workerDeployments) {
    const version = data.workerVersions.find(
      (record) =>
        record.workspaceId === deployment.workspaceId && record.id === deployment.workerVersionId,
    );
    if (
      !data.workerDefinitions.some(
        (record) =>
          record.workspaceId === deployment.workspaceId &&
          record.id === deployment.workerDefinitionId,
      ) ||
      !version ||
      version.workerDefinitionId !== deployment.workerDefinitionId
    ) {
      throw new Error(
        `WorkerDeployment ${deployment.id} references an inconsistent definition or version.`,
      );
    }
    assertWorkerDeploymentPolicyIntegrity(deployment, version);
  }
  for (const run of data.workerRuns) {
    const deployment = data.workerDeployments.find(
      (record) => record.workspaceId === run.workspaceId && record.id === run.workerDeploymentId,
    );
    if (
      !deployment ||
      deployment.workerDefinitionId !== run.workerDefinitionId ||
      deployment.workerVersionId !== run.workerVersionId
    ) {
      throw new Error(`WorkerRun ${run.id} references an inconsistent deployment or version.`);
    }
  }
  for (const checkpoint of data.workerCheckpoints) {
    const run = data.workerRuns.find(
      (record) =>
        record.workspaceId === checkpoint.workspaceId && record.id === checkpoint.workerRunId,
    );
    if (!run || run.workerVersionId !== checkpoint.workerVersionId) {
      throw new Error(
        `WorkerCheckpoint ${checkpoint.id} references an inconsistent run or version.`,
      );
    }
  }
  for (const receipt of data.workerEffectReceipts) {
    const run = data.workerRuns.find(
      (record) => record.workspaceId === receipt.workspaceId && record.id === receipt.workerRunId,
    );
    if (
      !run ||
      run.workerVersionId !== receipt.workerVersionId ||
      run.workerDeploymentId !== receipt.workerDeploymentId
    ) {
      throw new Error(
        `WorkerEffectReceipt ${receipt.id} references an inconsistent run, version, or deployment.`,
      );
    }
  }
  for (const reservation of data.workerBudgetReservations) {
    const run = data.workerRuns.find(
      (record) =>
        record.workspaceId === reservation.workspaceId && record.id === reservation.workerRunId,
    );
    if (
      !run ||
      run.workerVersionId !== reservation.workerVersionId ||
      run.workerDeploymentId !== reservation.workerDeploymentId
    ) {
      throw new Error(
        `Worker budget reservation ${reservation.id} references an inconsistent run, version, or deployment.`,
      );
    }
  }
  for (const attention of data.workerAttentionRequests) {
    assertControlRunBinding(data, attention, "Worker attention request");
    if (attention.resolutionCommandId) {
      const command = data.workerControlCommands.find(
        (record) =>
          record.workspaceId === attention.workspaceId &&
          record.workerRunId === attention.workerRunId &&
          record.attentionRequestId === attention.id &&
          record.id === attention.resolutionCommandId,
      );
      const expectedKinds =
        attention.status === "approved"
          ? ["approve_once", "approve_for_run"]
          : attention.status === "rejected"
            ? ["reject_attention"]
            : [];
      if (
        !command ||
        command.status !== "applied" ||
        !expectedKinds.includes(command.kind) ||
        command.actor.type !== attention.resolvedBy?.type ||
        command.actor.id !== attention.resolvedBy.id
      ) {
        throw new Error(
          `Worker attention request ${attention.id} references an inconsistent resolution command.`,
        );
      }
    }
  }
  for (const grant of data.workerApprovalGrants) {
    assertControlRunBinding(data, grant, "Worker approval grant");
    const attention = data.workerAttentionRequests.find(
      (record) =>
        record.workspaceId === grant.workspaceId && record.id === grant.attentionRequestId,
    );
    if (
      !attention ||
      attention.workerRunId !== grant.workerRunId ||
      attention.capabilityId !== grant.capabilityId ||
      attention.operationDigest !== grant.operationDigest ||
      attention.policyDigest !== grant.policyDigest ||
      attention.status !== "approved" ||
      !data.workerControlCommands.some(
        (record) =>
          record.workspaceId === grant.workspaceId &&
          record.id === attention.resolutionCommandId &&
          record.approvalGrantId === grant.id &&
          record.kind === (grant.scope === "once" ? "approve_once" : "approve_for_run") &&
          record.status === "applied" &&
          record.actor.type === grant.grantedBy.type &&
          record.actor.id === grant.grantedBy.id,
      )
    ) {
      throw new Error(
        `Worker approval grant ${grant.id} references an inconsistent attention request.`,
      );
    }
  }
  for (const command of data.workerControlCommands) {
    const deployment = data.workerDeployments.find(
      (record) =>
        record.workspaceId === command.workspaceId && record.id === command.workerDeploymentId,
    );
    const version = data.workerVersions.find(
      (record) =>
        record.workspaceId === command.workspaceId && record.id === command.workerVersionId,
    );
    if (
      !deployment ||
      !version ||
      deployment.workerDefinitionId !== command.workerDefinitionId ||
      deployment.workerVersionId !== command.workerVersionId ||
      version.workerDefinitionId !== command.workerDefinitionId ||
      version.contentDigest !== command.workerVersionContentDigest
    ) {
      throw new Error(
        `Worker control command ${command.id} references an inconsistent deployment or version.`,
      );
    }
    if (command.workerRunId) {
      const run = data.workerRuns.find(
        (record) => record.workspaceId === command.workspaceId && record.id === command.workerRunId,
      );
      if (
        !run ||
        run.workerDefinitionId !== command.workerDefinitionId ||
        run.workerDeploymentId !== command.workerDeploymentId ||
        run.workerVersionId !== command.workerVersionId
      ) {
        throw new Error(`Worker control command ${command.id} references an inconsistent run.`);
      }
    }
    if (command.attentionRequestId) {
      const attention = data.workerAttentionRequests.find(
        (record) =>
          record.workspaceId === command.workspaceId &&
          record.workerRunId === command.workerRunId &&
          record.id === command.attentionRequestId,
      );
      if (
        !attention ||
        attention.capabilityId !== command.capabilityId ||
        attention.operationDigest !== command.operationDigest
      ) {
        throw new Error(
          `Worker control command ${command.id} references an inconsistent attention request.`,
        );
      }
    }
    if (command.approvalGrantId) {
      const grant = data.workerApprovalGrants.find(
        (record) =>
          record.workspaceId === command.workspaceId &&
          record.attentionRequestId === command.attentionRequestId &&
          record.id === command.approvalGrantId,
      );
      if (
        !grant ||
        grant.workerRunId !== command.workerRunId ||
        grant.capabilityId !== command.capabilityId ||
        grant.operationDigest !== command.operationDigest ||
        grant.scope !== (command.kind === "approve_once" ? "once" : "run")
      ) {
        throw new Error(
          `Worker control command ${command.id} references an inconsistent approval grant.`,
        );
      }
    }
  }
  for (const delivery of data.workerNotificationDeliveries) {
    assertControlRunBinding(data, delivery, "Worker notification delivery");
    const version = data.workerVersions.find(
      (record) =>
        record.workspaceId === delivery.workspaceId && record.id === delivery.workerVersionId,
    )!;
    const route = version.content.notificationRoutes.find(
      (record) => record.id === delivery.notificationRouteId,
    );
    if (
      !route ||
      route.kind !== delivery.notificationRouteKind ||
      route.reference !== delivery.notificationRouteReference ||
      !route.events.includes(delivery.event)
    ) {
      throw new Error(
        `Worker notification delivery ${delivery.id} references an inconsistent notification route.`,
      );
    }
    if (delivery.schemaVersion === WORKER_NOTIFICATION_OUTBOX_SCHEMA_VERSION) {
      const sourceEvent = data.workerEvents.find(
        (record) =>
          record.workspaceId === delivery.workspaceId && record.id === delivery.sourceEventId,
      );
      const evidence = data.workerEvidenceEntries.find(
        (record) =>
          record.workspaceId === delivery.workspaceId && record.id === delivery.envelope.evidenceId,
      );
      const sourceRetainedByTombstone =
        ["delivered", "dead_letter", "expired"].includes(delivery.status) &&
        hasWorkerEventRetentionTombstone(data, delivery.sourceEventId, delivery.sourceEventDigest);
      if (
        (!sourceRetainedByTombstone &&
          (!sourceEvent ||
            sourceEvent.schemaVersion !== WORKER_EVENT_SCHEMA_VERSION ||
            sourceEvent.eventDigest !== delivery.sourceEventDigest ||
            sourceEvent.evidenceId !== delivery.envelope.evidenceId ||
            sourceEvent.workerRunId !== delivery.workerRunId ||
            !evidence ||
            evidence.sourceEventId !== sourceEvent.id ||
            evidence.sourceEventDigest !== sourceEvent.eventDigest)) ||
        (sourceRetainedByTombstone && (sourceEvent !== undefined || evidence !== undefined))
      ) {
        throw new Error(
          `Worker notification outbox item ${delivery.id} references inconsistent source evidence.`,
        );
      }
    }
    if (
      delivery.attentionRequestId &&
      !data.workerAttentionRequests.some(
        (record) =>
          record.workspaceId === delivery.workspaceId &&
          record.workerRunId === delivery.workerRunId &&
          record.id === delivery.attentionRequestId,
      )
    ) {
      throw new Error(
        `Worker notification delivery ${delivery.id} references a missing attention request.`,
      );
    }
    if (
      delivery.controlCommandId &&
      !data.workerControlCommands.some(
        (record) =>
          record.workspaceId === delivery.workspaceId &&
          record.id === delivery.controlCommandId &&
          (record.workerRunId === undefined || record.workerRunId === delivery.workerRunId),
      )
    ) {
      throw new Error(
        `Worker notification delivery ${delivery.id} references a missing control command.`,
      );
    }
  }
}

function hasWorkerEventRetentionTombstone(
  data: PacketAgentData,
  sourceEventId: string,
  sourceEventDigest: string,
): boolean {
  const resourceIdDigest = `sha256:${createHash("sha256")
    .update(canonicalWorkerJson({ resourceId: sourceEventId }))
    .digest("hex")}`;
  return data.workerEvents.some(
    (event) =>
      event.type.startsWith("worker.retention.") &&
      event.data?.resourceKind === "worker_event" &&
      event.data.contentDigest === sourceEventDigest &&
      Array.isArray(event.data.resourceIdDigests) &&
      event.data.resourceIdDigests.includes(resourceIdDigest),
  );
}

function assertControlRunBinding(
  data: PacketAgentData,
  binding: WorkerControlRunBinding,
  label: string,
): void {
  const run = data.workerRuns.find(
    (record) => record.workspaceId === binding.workspaceId && record.id === binding.workerRunId,
  );
  const version = data.workerVersions.find(
    (record) => record.workspaceId === binding.workspaceId && record.id === binding.workerVersionId,
  );
  if (
    !run ||
    !version ||
    run.workerDefinitionId !== binding.workerDefinitionId ||
    run.workerDeploymentId !== binding.workerDeploymentId ||
    run.workerVersionId !== binding.workerVersionId ||
    version.workerDefinitionId !== binding.workerDefinitionId ||
    version.contentDigest !== binding.workerVersionContentDigest
  ) {
    throw new Error(`${label} references an inconsistent run, deployment, or version.`);
  }
}

function validateSupportRecords(data: PacketAgentData): void {
  for (const receipt of data.workerCommandReceipts) {
    if (
      receipt.schemaVersion !== WORKER_COMMAND_SCHEMA_VERSION ||
      !receipt.id ||
      !receipt.workspaceId ||
      !receipt.idempotencyKey ||
      !receipt.requestDigest ||
      !receipt.actor?.type ||
      !receipt.actor.id
    ) {
      throw new Error("Worker lifecycle command receipt is invalid.");
    }
  }
  for (const event of data.workerEvents) {
    assertValidWorkerEvent(event);
    if (
      !data.workerDefinitions.some(
        (record) =>
          record.workspaceId === event.workspaceId && record.id === event.workerDefinitionId,
      ) ||
      (event.workerVersionId !== undefined &&
        !data.workerVersions.some(
          (record) =>
            record.workspaceId === event.workspaceId &&
            record.workerDefinitionId === event.workerDefinitionId &&
            record.id === event.workerVersionId,
        )) ||
      (event.workerDeploymentId !== undefined &&
        !data.workerDeployments.some(
          (record) =>
            record.workspaceId === event.workspaceId &&
            record.workerDefinitionId === event.workerDefinitionId &&
            record.id === event.workerDeploymentId,
        ))
    ) {
      throw new Error(`Worker event ${event.id} references a missing Worker record.`);
    }
  }
  validateWorkerEvidenceGraph(data);
  for (const rollout of data.workerDeploymentRollouts) {
    if (
      rollout.schemaVersion !== WORKER_ROLLOUT_SCHEMA_VERSION ||
      !rollout.id ||
      !rollout.workspaceId ||
      !rollout.workerDefinitionId ||
      !rollout.fromDeploymentId ||
      !rollout.toDeploymentId ||
      !rollout.createdBy?.type ||
      !rollout.createdBy.id ||
      rollout.fromDeploymentId === rollout.toDeploymentId
    ) {
      throw new Error("Worker deployment rollout is invalid.");
    }
    for (const deploymentId of [rollout.fromDeploymentId, rollout.toDeploymentId]) {
      if (
        !data.workerDeployments.some(
          (record) =>
            record.workspaceId === rollout.workspaceId &&
            record.workerDefinitionId === rollout.workerDefinitionId &&
            record.id === deploymentId,
        )
      ) {
        throw new Error(`Worker deployment rollout ${rollout.id} references a missing deployment.`);
      }
    }
  }
}

function validateWorkerEvidenceGraph(data: PacketAgentData): void {
  for (const event of data.workerEvents) {
    if (event.schemaVersion !== WORKER_EVENT_SCHEMA_VERSION) continue;
    const evidence = data.workerEvidenceEntries.find(
      (entry) => entry.workspaceId === event.workspaceId && entry.id === event.evidenceId,
    );
    if (
      !evidence ||
      evidence.sourceEventId !== event.id ||
      evidence.sourceEventDigest !== event.eventDigest ||
      evidence.sequence !== event.sequence ||
      evidence.workerDefinitionId !== event.workerDefinitionId ||
      evidence.workerVersionId !== event.workerVersionId ||
      evidence.workerDeploymentId !== event.workerDeploymentId ||
      evidence.workerRunId !== event.workerRunId
    ) {
      throw new Error(`Worker event ${event.id} references inconsistent evidence.`);
    }
    if (event.workerRunId) {
      const run = data.workerRuns.find(
        (record) => record.workspaceId === event.workspaceId && record.id === event.workerRunId,
      );
      if (
        !run ||
        run.workerDefinitionId !== event.workerDefinitionId ||
        run.workerVersionId !== event.workerVersionId ||
        run.workerDeploymentId !== event.workerDeploymentId
      ) {
        throw new Error(`Worker event ${event.id} references an inconsistent run.`);
      }
    }
  }
  assertMonotonicEventStreams(data.workerEvents);
  for (const evidence of data.workerEvidenceEntries) {
    const event = data.workerEvents.find(
      (record) =>
        record.workspaceId === evidence.workspaceId && record.id === evidence.sourceEventId,
    );
    if (
      !event ||
      event.schemaVersion !== WORKER_EVENT_SCHEMA_VERSION ||
      event.evidenceId !== evidence.id
    ) {
      throw new Error(`Worker evidence ${evidence.id} references a missing source event.`);
    }
    for (const artifactId of evidence.artifactManifestIds ?? []) {
      if (
        !data.workerArtifactManifests.some(
          (record) => record.workspaceId === evidence.workspaceId && record.id === artifactId,
        )
      ) {
        throw new Error(`Worker evidence ${evidence.id} references a missing artifact manifest.`);
      }
    }
  }
  for (const manifest of data.workerArtifactManifests) {
    const run = data.workerRuns.find(
      (record) => record.workspaceId === manifest.workspaceId && record.id === manifest.workerRunId,
    );
    if (
      !run ||
      run.workerDefinitionId !== manifest.workerDefinitionId ||
      run.workerVersionId !== manifest.workerVersionId ||
      run.workerDeploymentId !== manifest.workerDeploymentId ||
      manifest.provenance.sourceEvidenceIds.some(
        (id) =>
          !data.workerEvidenceEntries.some(
            (entry) => entry.workspaceId === manifest.workspaceId && entry.id === id,
          ),
      )
    ) {
      throw new Error(`Worker artifact manifest ${manifest.id} has inconsistent provenance.`);
    }
  }
}

function assertMonotonicEventStreams(events: readonly WorkerEvent[]): void {
  const deploymentSequences = new Map<string, number>();
  const runSequences = new Map<string, number>();
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    if (event.schemaVersion !== WORKER_EVENT_SCHEMA_VERSION) continue;
    if (event.workerDeploymentId) {
      assertIncreasingSequence(
        deploymentSequences,
        `${event.workspaceId}:${event.workerDeploymentId}`,
        event.deploymentSequence!,
        "deployment",
      );
    }
    if (event.workerRunId) {
      assertIncreasingSequence(
        runSequences,
        `${event.workspaceId}:${event.workerRunId}`,
        event.runSequence!,
        "run",
      );
    }
  }
}

function assertIncreasingSequence(
  sequences: Map<string, number>,
  key: string,
  next: number,
  label: string,
): void {
  const previous = sequences.get(key) ?? 0;
  if (next <= previous) {
    throw new Error(`Worker ${label} event sequence is not monotonic for ${key}.`);
  }
  sequences.set(key, next);
}

function assertValidWorkerEffectReceipt(receipt: WorkerEffectReceipt): void {
  if (
    receipt.schemaVersion !== WORKER_EFFECT_RECEIPT_SCHEMA_VERSION ||
    !receipt.id ||
    !receipt.workspaceId ||
    !receipt.workerRunId ||
    !receipt.workerVersionId ||
    !receipt.workerDeploymentId ||
    !/^sha256:[a-f0-9]{64}$/.test(receipt.effectKey) ||
    !/^sha256:[a-f0-9]{64}$/.test(receipt.inputDigest) ||
    !Number.isSafeInteger(receipt.iteration) ||
    receipt.iteration < 0 ||
    !receipt.actionId ||
    !receipt.capabilityId ||
    !receipt.toolName ||
    !receipt.operation ||
    !["idempotent_mutation", "reconcilable_mutation", "non_replayable_mutation"].includes(
      receipt.classification,
    ) ||
    !["prepared", "completed"].includes(receipt.status) ||
    !Number.isFinite(Date.parse(receipt.preparedAt))
  ) {
    throw new Error("Worker effect receipt is invalid.");
  }
  if (
    receipt.status === "completed" &&
    (!receipt.completedAt ||
      !receipt.result ||
      !Number.isFinite(Date.parse(receipt.completedAt)) ||
      !["inline_redacted", "retention_tombstone"].includes(receipt.result.kind) ||
      !/^sha256:[a-f0-9]{64}$/.test(receipt.result.digest))
  ) {
    throw new Error("Completed Worker effect receipt is missing its result reference.");
  }
  if (
    receipt.result?.kind === "retention_tombstone" &&
    (!/^sha256:[a-f0-9]{64}$/.test(receipt.result.originalDigest) ||
      !receipt.result.tombstoneEventId ||
      !Number.isFinite(Date.parse(receipt.result.deletedAt)))
  ) {
    throw new Error("Worker effect retention tombstone is invalid.");
  }
  if (receipt.result) {
    const { digest: resultDigest, ...content } = receipt.result;
    const expectedDigest = `sha256:${createHash("sha256")
      .update(canonicalWorkerJson(content))
      .digest("hex")}`;
    if (resultDigest !== expectedDigest) {
      throw new Error("Worker effect result digest does not match its contents.");
    }
  }
  if (
    receipt.status === "prepared" &&
    (receipt.completedAt !== undefined || receipt.result !== undefined)
  ) {
    throw new Error("Prepared Worker effect receipt cannot contain a completion.");
  }
}

function assertUnique<T>(records: readonly T[], key: (record: T) => string): void {
  const seen = new Set<string>();
  for (const record of records) {
    const value = key(record);
    if (seen.has(value)) throw new Error(`duplicate Worker persistence key ${value}`);
    seen.add(value);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneOrNull<T>(value: T | null): T | null {
  return value === null ? null : clone(value);
}
