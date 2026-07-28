import {
  loadStoreAsync as defaultLoadStore,
  mutateStoreAsync as defaultMutateStore,
  type PacketAgentData,
} from "../packetagent-store.js";
import { WorkerLifecycleError } from "./errors.js";
import { assertWorkerDeploymentPolicyIntegrity } from "./capabilities.js";
import { assertValidWorkerCredentialRecord } from "./credential-types.js";
import { assertValidWorkerBudgetReservationRecord } from "./budget-types.js";
import {
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
  type WorkerLifecycleCommandReceipt,
} from "./persistence-types.js";
import { WORKER_EFFECT_RECEIPT_SCHEMA_VERSION, type WorkerEffectReceipt } from "./effect-types.js";
import type { WorkerDefinition, WorkerDeployment, WorkerVersion } from "./types.js";
import {
  assertValidWorkerCheckpoint,
  assertValidWorkerDefinition,
  assertValidWorkerDeployment,
  assertValidWorkerRun,
  assertValidWorkerVersion,
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
  appendEvent(record: WorkerEvent): void;
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
    appendEvent(record) {
      assertWorkspace(record.workspaceId, workspaceId);
      data.workerEvents.push(record);
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

    assertUnique(data.workerCredentials, (record) => `${record.workspaceId}:${record.id}`);
    assertUnique(data.workerCredentials, (record) => `${record.workspaceId}:${record.reference}`);
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
      data.workerCommandReceipts,
      (record) => `${record.workspaceId}:${record.idempotencyKey}`,
    );
    assertUnique(data.workerCommandReceipts, (record) => `${record.workspaceId}:${record.id}`);
    assertUnique(data.workerDeploymentRollouts, (record) => `${record.workspaceId}:${record.id}`);
    assertUnique(data.workerEvents, (record) => `${record.workspaceId}:${record.id}`);
    assertUnique(data.workerEvents, (record) => `${record.workspaceId}:${record.sequence}`);

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
    if (
      event.schemaVersion !== WORKER_EVENT_SCHEMA_VERSION ||
      !event.id ||
      !event.workspaceId ||
      !event.workerDefinitionId ||
      !event.type ||
      !event.actor?.type ||
      !event.actor.id ||
      !Number.isInteger(event.sequence) ||
      event.sequence <= 0
    ) {
      throw new Error("Worker event is invalid.");
    }
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
      receipt.result.kind !== "inline_redacted" ||
      !/^sha256:[a-f0-9]{64}$/.test(receipt.result.digest))
  ) {
    throw new Error("Completed Worker effect receipt is missing its result reference.");
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
