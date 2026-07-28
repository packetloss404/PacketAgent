import { createHash, randomUUID } from "node:crypto";
import { WorkerLifecycleError } from "./errors.js";
import { compileWorkerCapabilityPolicy, WorkerCapabilityCompilationError } from "./capabilities.js";
import {
  WORKER_COMMAND_SCHEMA_VERSION,
  WORKER_ROLLOUT_SCHEMA_VERSION,
  type WorkerDeploymentRollout,
  type WorkerLifecycleCommandResponse,
  type WorkerLifecycleOperation,
} from "./persistence-types.js";
import {
  createWorkerRepository,
  type WorkerRepository,
  type WorkerRepositoryTransaction,
} from "./repository.js";
import {
  assertWorkerDefinitionUpdate,
  assertWorkerDeploymentUpdate,
  assertWorkerVersionDeployable,
  assertWorkerVersionUpdate,
  WorkerTransitionError,
} from "./transitions.js";
import {
  WORKER_CONTRACT_SCHEMA_VERSION,
  type WorkerActorReference,
  type WorkerDefinition,
  type WorkerDeployment,
  type WorkerDeploymentCapabilityGrant,
  type WorkerSourceProvenance,
  type WorkerVersion,
  type WorkerVersionContent,
} from "./types.js";
import {
  assertValidWorkerDefinition,
  assertValidWorkerDeployment,
  assertValidWorkerVersion,
  canonicalWorkerJson,
  computeWorkerVersionContentDigest,
  WorkerContractValidationError,
} from "./validation.js";

export interface WorkerCommandContext {
  readonly workspaceId: string;
  readonly actor: WorkerActorReference;
  readonly idempotencyKey: string;
}

export interface CreateWorkerDefinitionInput extends WorkerCommandContext {
  readonly definitionId?: string;
  readonly versionId?: string;
  readonly name: string;
  readonly description: string;
  readonly content: WorkerVersionContent;
  readonly source: WorkerSourceProvenance;
}

export interface CreateWorkerVersionInput extends WorkerCommandContext {
  readonly workerDefinitionId: string;
  readonly versionId?: string;
  readonly content: WorkerVersionContent;
  readonly source: WorkerSourceProvenance;
}

export interface UpdateWorkerDraftVersionInput extends WorkerCommandContext {
  readonly workerVersionId: string;
  readonly expectedContentDigest: string;
  readonly content: WorkerVersionContent;
}

export interface ChangeWorkerVersionStatusInput extends WorkerCommandContext {
  readonly workerVersionId: string;
  readonly expectedContentDigest: string;
}

export interface CreateWorkerDeploymentInput extends WorkerCommandContext {
  readonly deploymentId?: string;
  readonly workerVersionId: string;
  readonly capabilityGrants?: readonly WorkerDeploymentCapabilityGrant[];
}

export interface TransitionWorkerDeploymentInput extends WorkerCommandContext {
  readonly workerDeploymentId: string;
  readonly expectedRevision: number;
  readonly statusReason?: string;
}

export interface RollbackWorkerDeploymentInput extends TransitionWorkerDeploymentInput {
  readonly targetWorkerVersionId: string;
  readonly replacementDeploymentId?: string;
  readonly capabilityGrants?: readonly WorkerDeploymentCapabilityGrant[];
}

export interface UpdateWorkerDeploymentInput extends TransitionWorkerDeploymentInput {
  readonly targetWorkerVersionId: string;
  readonly replacementDeploymentId?: string;
  readonly capabilityGrants?: readonly WorkerDeploymentCapabilityGrant[];
}

export interface RetireWorkerDefinitionInput extends WorkerCommandContext {
  readonly workerDefinitionId: string;
  readonly expectedUpdatedAt: string;
}

export interface WorkerDefinitionDetail {
  readonly definition: WorkerDefinition;
  readonly versions: readonly WorkerVersion[];
  readonly deployments: readonly WorkerDeployment[];
  readonly rollouts: readonly WorkerDeploymentRollout[];
}

export interface WorkerLifecycleServiceDependencies {
  readonly repository?: WorkerRepository;
  readonly now?: () => Date;
  readonly id?: (
    kind: "definition" | "version" | "deployment" | "rollout" | "receipt" | "event",
  ) => string;
}

export interface WorkerLifecycleService {
  listDefinitions(workspaceId: string): Promise<readonly WorkerDefinition[]>;
  getDefinition(workspaceId: string, id: string): Promise<WorkerDefinitionDetail>;
  getVersion(workspaceId: string, id: string): Promise<WorkerVersion>;
  getDeployment(workspaceId: string, id: string): Promise<WorkerDeployment>;
  listEvents(
    workspaceId: string,
    afterSequence?: number,
  ): ReturnType<WorkerRepository["listEvents"]>;
  createDefinition(input: CreateWorkerDefinitionInput): Promise<WorkerLifecycleCommandResponse>;
  createVersion(input: CreateWorkerVersionInput): Promise<WorkerLifecycleCommandResponse>;
  updateDraftVersion(input: UpdateWorkerDraftVersionInput): Promise<WorkerLifecycleCommandResponse>;
  validateVersion(input: ChangeWorkerVersionStatusInput): Promise<WorkerLifecycleCommandResponse>;
  rejectVersion(input: ChangeWorkerVersionStatusInput): Promise<WorkerLifecycleCommandResponse>;
  createDeployment(input: CreateWorkerDeploymentInput): Promise<WorkerLifecycleCommandResponse>;
  validateDeployment(
    input: TransitionWorkerDeploymentInput,
  ): Promise<WorkerLifecycleCommandResponse>;
  deploy(input: TransitionWorkerDeploymentInput): Promise<WorkerLifecycleCommandResponse>;
  activate(input: TransitionWorkerDeploymentInput): Promise<WorkerLifecycleCommandResponse>;
  pause(input: TransitionWorkerDeploymentInput): Promise<WorkerLifecycleCommandResponse>;
  resume(input: TransitionWorkerDeploymentInput): Promise<WorkerLifecycleCommandResponse>;
  retireDeployment(input: TransitionWorkerDeploymentInput): Promise<WorkerLifecycleCommandResponse>;
  updateDeployment(input: UpdateWorkerDeploymentInput): Promise<WorkerLifecycleCommandResponse>;
  rollback(input: RollbackWorkerDeploymentInput): Promise<WorkerLifecycleCommandResponse>;
  retireDefinition(input: RetireWorkerDefinitionInput): Promise<WorkerLifecycleCommandResponse>;
}

export function createWorkerLifecycleService(
  dependencies: WorkerLifecycleServiceDependencies = {},
): WorkerLifecycleService {
  const repository = dependencies.repository ?? createWorkerRepository();
  const now = dependencies.now ?? (() => new Date());
  const id = dependencies.id ?? defaultId;

  return {
    listDefinitions(workspaceId) {
      return repository.listDefinitions(workspaceId);
    },
    async getDefinition(workspaceId, definitionId) {
      const definition = await repository.findDefinition(workspaceId, definitionId);
      if (!definition)
        throw new WorkerLifecycleError(
          "not_found",
          `WorkerDefinition ${definitionId} was not found.`,
        );
      const [versions, deployments, rollouts] = await Promise.all([
        repository.listVersions(workspaceId, definitionId),
        repository.listDeployments(workspaceId, definitionId),
        repository.listRollouts(workspaceId, definitionId),
      ]);
      return { definition, versions, deployments, rollouts };
    },
    async getVersion(workspaceId, versionId) {
      const version = await repository.findVersion(workspaceId, versionId);
      if (!version)
        throw new WorkerLifecycleError("not_found", `WorkerVersion ${versionId} was not found.`);
      return version;
    },
    async getDeployment(workspaceId, deploymentId) {
      const deployment = await repository.findDeployment(workspaceId, deploymentId);
      if (!deployment)
        throw new WorkerLifecycleError(
          "not_found",
          `WorkerDeployment ${deploymentId} was not found.`,
        );
      return deployment;
    },
    listEvents(workspaceId, afterSequence) {
      return repository.listEvents(workspaceId, afterSequence);
    },
    createDefinition(input) {
      return executeCommand(
        repository,
        now,
        id,
        input,
        "definition.create",
        input.definitionId,
        {
          definitionId: input.definitionId,
          versionId: input.versionId,
          name: input.name,
          description: input.description,
          content: input.content,
          source: input.source,
        },
        (transaction, timestamp) => {
          const definition: WorkerDefinition = {
            schemaVersion: WORKER_CONTRACT_SCHEMA_VERSION,
            id: input.definitionId ?? id("definition"),
            workspaceId: input.workspaceId,
            name: requireNonEmpty(input.name, "name"),
            description: requireNonEmpty(input.description, "description"),
            status: "draft",
            createdBy: input.actor,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          const version: WorkerVersion = {
            schemaVersion: WORKER_CONTRACT_SCHEMA_VERSION,
            id: input.versionId ?? id("version"),
            workspaceId: input.workspaceId,
            workerDefinitionId: definition.id,
            version: 1,
            status: "draft",
            content: input.content,
            contentDigest: computeWorkerVersionContentDigest(input.content),
            source: input.source,
            createdBy: input.actor,
            createdAt: timestamp,
          };
          assertValidWorkerDefinition(definition);
          assertValidWorkerVersion(version);
          transaction.insertDefinition(definition);
          transaction.insertVersion(version);
          appendEvent(transaction, id, timestamp, {
            type: "worker.definition.created",
            definition,
            version,
            actor: input.actor,
            summary: `Worker ${definition.name} created with draft version 1.`,
          });
          return { definition, version };
        },
      );
    },
    createVersion(input) {
      return executeCommand(
        repository,
        now,
        id,
        input,
        "version.create",
        input.workerDefinitionId,
        {
          workerDefinitionId: input.workerDefinitionId,
          versionId: input.versionId,
          content: input.content,
          source: input.source,
        },
        (transaction, timestamp) => {
          const definition = requireDefinition(transaction, input.workerDefinitionId);
          if (definition.status === "retired")
            throw new WorkerLifecycleError(
              "conflict",
              "A retired WorkerDefinition cannot receive a new version.",
            );
          const version: WorkerVersion = {
            schemaVersion: WORKER_CONTRACT_SCHEMA_VERSION,
            id: input.versionId ?? id("version"),
            workspaceId: input.workspaceId,
            workerDefinitionId: definition.id,
            version: transaction.nextVersionNumber(definition.id),
            status: "draft",
            content: input.content,
            contentDigest: computeWorkerVersionContentDigest(input.content),
            source: input.source,
            createdBy: input.actor,
            createdAt: timestamp,
          };
          assertValidWorkerVersion(version);
          transaction.insertVersion(version);
          appendEvent(transaction, id, timestamp, {
            type: "worker.version.created",
            definition,
            version,
            actor: input.actor,
            summary: `Worker ${definition.name} draft version ${version.version} created.`,
          });
          return { definition, version };
        },
      );
    },
    updateDraftVersion(input) {
      return executeCommand(
        repository,
        now,
        id,
        input,
        "version.update_draft",
        input.workerVersionId,
        {
          workerVersionId: input.workerVersionId,
          expectedContentDigest: input.expectedContentDigest,
          content: input.content,
        },
        (transaction, timestamp) => {
          const previous = requireVersion(transaction, input.workerVersionId);
          assertExpectedDigest(previous, input.expectedContentDigest);
          if (previous.status !== "draft")
            throw new WorkerLifecycleError("conflict", "Only a draft WorkerVersion can be edited.");
          if (
            transaction
              .listDeployments(previous.workerDefinitionId)
              .some((deployment) => deployment.workerVersionId === previous.id)
          ) {
            throw new WorkerLifecycleError(
              "conflict",
              "A deployment-bound WorkerVersion cannot be edited.",
            );
          }
          const version: WorkerVersion = {
            ...previous,
            content: input.content,
            contentDigest: computeWorkerVersionContentDigest(input.content),
          };
          assertWorkerVersionUpdate(previous, version);
          transaction.replaceVersion(version);
          const definition = requireDefinition(transaction, previous.workerDefinitionId);
          appendEvent(transaction, id, timestamp, {
            type: "worker.version.updated",
            definition,
            version,
            actor: input.actor,
            summary: `Worker ${definition.name} draft version ${version.version} updated.`,
          });
          return { definition, version };
        },
      );
    },
    validateVersion(input) {
      return changeVersionStatus(repository, now, id, input, "version.validate", "validated");
    },
    rejectVersion(input) {
      return changeVersionStatus(repository, now, id, input, "version.reject", "rejected");
    },
    createDeployment(input) {
      return executeCommand(
        repository,
        now,
        id,
        input,
        "deployment.create",
        input.workerVersionId,
        {
          workerVersionId: input.workerVersionId,
          deploymentId: input.deploymentId,
          capabilityGrants: input.capabilityGrants,
        },
        (transaction, timestamp) => {
          const version = requireVersion(transaction, input.workerVersionId);
          assertWorkerVersionDeployable(version);
          const definition = requireDefinition(transaction, version.workerDefinitionId);
          if (definition.status === "retired")
            throw new WorkerLifecycleError(
              "conflict",
              "A retired WorkerDefinition cannot be deployed.",
            );
          if (
            transaction
              .listDeployments(definition.id)
              .some(
                (deployment) =>
                  deployment.workerVersionId === version.id &&
                  !["retired", "rejected", "revoked"].includes(deployment.status),
              )
          ) {
            throw new WorkerLifecycleError(
              "conflict",
              "This WorkerVersion already has a nonterminal deployment.",
            );
          }
          const compiled = compileWorkerCapabilityPolicy({
            workerVersionContentDigest: version.contentDigest,
            requestedCapabilities: version.content.tools,
            allowedCapabilityIds: version.content.policy.permissions.allowedCapabilityIds,
            credentialRefs: version.content.credentialRefs,
            ...(input.capabilityGrants ? { deploymentGrants: input.capabilityGrants } : {}),
          });
          const deployment: WorkerDeployment = {
            schemaVersion: WORKER_CONTRACT_SCHEMA_VERSION,
            id: input.deploymentId ?? id("deployment"),
            workspaceId: input.workspaceId,
            workerDefinitionId: definition.id,
            workerVersionId: version.id,
            status: "draft",
            revision: 1,
            capabilityGrants: compiled.grants,
            compiledPolicy: compiled.policy,
            createdBy: input.actor,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          assertValidWorkerDeployment(deployment);
          transaction.insertDeployment(deployment);
          appendEvent(transaction, id, timestamp, {
            type: "worker.deployment.created",
            definition,
            version,
            deployment,
            actor: input.actor,
            summary: `Draft deployment created for Worker ${definition.name} version ${version.version}.`,
          });
          return { definition, version, deployment };
        },
      );
    },
    validateDeployment(input) {
      return transitionDeployment(repository, now, id, input, "deployment.validate", "validated");
    },
    deploy(input) {
      return transitionDeployment(
        repository,
        now,
        id,
        input,
        "deployment.deploy",
        "deployed",
        true,
      );
    },
    activate(input) {
      return transitionDeployment(repository, now, id, input, "deployment.activate", "active");
    },
    pause(input) {
      return transitionDeployment(repository, now, id, input, "deployment.pause", "paused");
    },
    resume(input) {
      return transitionDeployment(repository, now, id, input, "deployment.resume", "active");
    },
    retireDeployment(input) {
      return transitionDeployment(repository, now, id, input, "deployment.retire", "retired");
    },
    updateDeployment(input) {
      return rolloutDeployment(repository, now, id, input, "update");
    },
    rollback(input) {
      return rolloutDeployment(repository, now, id, input, "rollback");
    },
    retireDefinition(input) {
      return executeCommand(
        repository,
        now,
        id,
        input,
        "definition.retire",
        input.workerDefinitionId,
        {
          workerDefinitionId: input.workerDefinitionId,
          expectedUpdatedAt: input.expectedUpdatedAt,
        },
        (transaction, timestamp) => {
          const previous = requireDefinition(transaction, input.workerDefinitionId);
          if (previous.updatedAt !== input.expectedUpdatedAt)
            throw new WorkerLifecycleError(
              "conflict",
              "WorkerDefinition was changed by another command.",
            );
          if (
            transaction
              .listDeployments(previous.id)
              .some((deployment) =>
                ["draft", "validated", "deployed", "active", "paused", "attention"].includes(
                  deployment.status,
                ),
              )
          ) {
            throw new WorkerLifecycleError(
              "conflict",
              "Retire every nonterminal WorkerDeployment before retiring its definition.",
            );
          }
          const definition: WorkerDefinition = {
            ...previous,
            status: "retired",
            updatedAt: timestamp,
          };
          assertWorkerDefinitionUpdate(previous, definition);
          transaction.replaceDefinition(definition);
          appendEvent(transaction, id, timestamp, {
            type: "worker.definition.retired",
            definition,
            actor: input.actor,
            summary: `Worker ${definition.name} retired.`,
          });
          return { definition };
        },
      );
    },
  };
}

function changeVersionStatus(
  repository: WorkerRepository,
  now: () => Date,
  id: NonNullable<WorkerLifecycleServiceDependencies["id"]>,
  input: ChangeWorkerVersionStatusInput,
  operation: "version.validate" | "version.reject",
  status: "validated" | "rejected",
): Promise<WorkerLifecycleCommandResponse> {
  return executeCommand(
    repository,
    now,
    id,
    input,
    operation,
    input.workerVersionId,
    {
      workerVersionId: input.workerVersionId,
      expectedContentDigest: input.expectedContentDigest,
    },
    (transaction, timestamp) => {
      const previous = requireVersion(transaction, input.workerVersionId);
      assertExpectedDigest(previous, input.expectedContentDigest);
      const version: WorkerVersion = {
        ...previous,
        status,
        ...(status === "validated" ? { validatedAt: timestamp } : { rejectedAt: timestamp }),
      };
      assertWorkerVersionUpdate(previous, version);
      transaction.replaceVersion(version);
      const definition = requireDefinition(transaction, previous.workerDefinitionId);
      appendEvent(transaction, id, timestamp, {
        type: status === "validated" ? "worker.version.validated" : "worker.version.rejected",
        definition,
        version,
        actor: input.actor,
        summary: `Worker ${definition.name} version ${version.version} ${status}.`,
      });
      return { definition, version };
    },
  );
}

function transitionDeployment(
  repository: WorkerRepository,
  now: () => Date,
  id: NonNullable<WorkerLifecycleServiceDependencies["id"]>,
  input: TransitionWorkerDeploymentInput,
  operation:
    | "deployment.validate"
    | "deployment.deploy"
    | "deployment.activate"
    | "deployment.pause"
    | "deployment.resume"
    | "deployment.retire",
  status: "validated" | "deployed" | "active" | "paused" | "retired",
  updateDefinition = false,
): Promise<WorkerLifecycleCommandResponse> {
  return executeCommand(
    repository,
    now,
    id,
    input,
    operation,
    input.workerDeploymentId,
    {
      workerDeploymentId: input.workerDeploymentId,
      expectedRevision: input.expectedRevision,
      statusReason: input.statusReason,
    },
    (transaction, timestamp) => {
      const previous = requireDeployment(transaction, input.workerDeploymentId);
      assertExpectedRevision(previous, input.expectedRevision);
      const version = requireVersion(transaction, previous.workerVersionId);
      assertWorkerVersionDeployable(version);
      if (
        status === "active" &&
        transaction
          .listDeployments(previous.workerDefinitionId)
          .some((deployment) => deployment.id !== previous.id && deployment.status === "active")
      ) {
        throw new WorkerLifecycleError(
          "conflict",
          "Another WorkerDeployment is already active for this definition.",
        );
      }
      const deployment: WorkerDeployment = {
        ...previous,
        status,
        revision: previous.revision + 1,
        ...(input.statusReason ? { statusReason: input.statusReason } : {}),
        updatedAt: timestamp,
        ...deploymentTimestamp(status, timestamp),
      };
      assertWorkerDeploymentUpdate(previous, deployment);
      transaction.replaceDeployment(deployment);
      const previousDefinition = requireDefinition(transaction, previous.workerDefinitionId);
      const definition: WorkerDefinition = updateDefinition
        ? {
            ...previousDefinition,
            status: "active",
            currentVersionId: version.id,
            updatedAt: timestamp,
          }
        : previousDefinition;
      if (updateDefinition) {
        assertWorkerDefinitionUpdate(previousDefinition, definition);
        transaction.replaceDefinition(definition);
      }
      appendEvent(transaction, id, timestamp, {
        type: `worker.deployment.${status}`,
        definition,
        version,
        deployment,
        actor: input.actor,
        summary: `Worker ${definition.name} deployment ${status}.`,
      });
      return { definition, version, deployment };
    },
  );
}

function rolloutDeployment(
  repository: WorkerRepository,
  now: () => Date,
  id: NonNullable<WorkerLifecycleServiceDependencies["id"]>,
  input: UpdateWorkerDeploymentInput | RollbackWorkerDeploymentInput,
  kind: "update" | "rollback",
): Promise<WorkerLifecycleCommandResponse> {
  return executeCommand(
    repository,
    now,
    id,
    input,
    kind === "update" ? "deployment.update" : "deployment.rollback",
    input.workerDeploymentId,
    {
      workerDeploymentId: input.workerDeploymentId,
      targetWorkerVersionId: input.targetWorkerVersionId,
      replacementDeploymentId: input.replacementDeploymentId,
      expectedRevision: input.expectedRevision,
      statusReason: input.statusReason,
      capabilityGrants: input.capabilityGrants,
    },
    (transaction, timestamp) => {
      const previous = requireDeployment(transaction, input.workerDeploymentId);
      assertExpectedRevision(previous, input.expectedRevision);
      if (!["deployed", "active", "paused"].includes(previous.status)) {
        throw new WorkerLifecycleError(
          "invalid_transition",
          `WorkerDeployment cannot ${kind === "update" ? "update" : "roll back"} from ${previous.status}.`,
        );
      }
      const version = requireVersion(transaction, input.targetWorkerVersionId);
      const previousVersion = requireVersion(transaction, previous.workerVersionId);
      assertWorkerVersionDeployable(version);
      const validDirection =
        kind === "update"
          ? version.version > previousVersion.version
          : version.version < previousVersion.version;
      if (version.workerDefinitionId !== previous.workerDefinitionId || !validDirection) {
        throw new WorkerLifecycleError(
          "conflict",
          kind === "update"
            ? "Update must select a newer validated version of the same WorkerDefinition."
            : "Rollback must select an older validated version of the same WorkerDefinition.",
        );
      }
      if (
        transaction
          .listDeployments(previous.workerDefinitionId)
          .some(
            (deployment) =>
              deployment.id !== previous.id &&
              deployment.workerVersionId === version.id &&
              !["retired", "rejected", "revoked"].includes(deployment.status),
          )
      ) {
        throw new WorkerLifecycleError(
          "conflict",
          `${kind === "update" ? "Update" : "Rollback"} target already has a nonterminal deployment.`,
        );
      }
      const definition = requireDefinition(transaction, previous.workerDefinitionId);
      const compiled = compileWorkerCapabilityPolicy({
        workerVersionContentDigest: version.contentDigest,
        requestedCapabilities: version.content.tools,
        allowedCapabilityIds: version.content.policy.permissions.allowedCapabilityIds,
        credentialRefs: version.content.credentialRefs,
        ...(input.capabilityGrants ? { deploymentGrants: input.capabilityGrants } : {}),
      });
      const retired: WorkerDeployment = {
        ...previous,
        status: "retired",
        revision: previous.revision + 1,
        statusReason:
          input.statusReason ??
          (kind === "update" ? "Replaced by update." : "Replaced by rollback."),
        updatedAt: timestamp,
        retiredAt: timestamp,
      };
      assertWorkerDeploymentUpdate(previous, retired);
      transaction.replaceDeployment(retired);

      const replacementStatus = previous.status;
      const deployment: WorkerDeployment = {
        schemaVersion: WORKER_CONTRACT_SCHEMA_VERSION,
        id: input.replacementDeploymentId ?? id("deployment"),
        workspaceId: input.workspaceId,
        workerDefinitionId: definition.id,
        workerVersionId: version.id,
        status: replacementStatus,
        revision: 1,
        capabilityGrants: compiled.grants,
        compiledPolicy: compiled.policy,
        statusReason:
          input.statusReason ?? (kind === "update" ? "Update deployment." : "Rollback deployment."),
        createdBy: input.actor,
        createdAt: timestamp,
        updatedAt: timestamp,
        validatedAt: timestamp,
        deployedAt: timestamp,
        ...(replacementStatus === "active" || replacementStatus === "paused"
          ? { activatedAt: timestamp }
          : {}),
        ...(replacementStatus === "paused" ? { pausedAt: timestamp } : {}),
      };
      assertValidWorkerDeployment(deployment);
      transaction.insertDeployment(deployment);

      const rollout: WorkerDeploymentRollout = {
        schemaVersion: WORKER_ROLLOUT_SCHEMA_VERSION,
        id: id("rollout"),
        workspaceId: input.workspaceId,
        workerDefinitionId: definition.id,
        fromDeploymentId: previous.id,
        toDeploymentId: deployment.id,
        kind,
        createdBy: input.actor,
        createdAt: timestamp,
      };
      transaction.insertRollout(rollout);
      const updatedDefinition: WorkerDefinition = {
        ...definition,
        status: "active",
        currentVersionId: version.id,
        updatedAt: timestamp,
      };
      assertWorkerDefinitionUpdate(definition, updatedDefinition);
      transaction.replaceDefinition(updatedDefinition);
      appendEvent(transaction, id, timestamp, {
        type: kind === "update" ? "worker.deployment.updated" : "worker.deployment.rolled_back",
        definition: updatedDefinition,
        version,
        deployment,
        actor: input.actor,
        summary:
          kind === "update"
            ? `Worker ${definition.name} updated to version ${version.version}.`
            : `Worker ${definition.name} rolled back to version ${version.version}.`,
      });
      return {
        definition: updatedDefinition,
        version,
        deployment,
        previousDeployment: retired,
        rollout,
      };
    },
  );
}

async function executeCommand(
  repository: WorkerRepository,
  now: () => Date,
  id: NonNullable<WorkerLifecycleServiceDependencies["id"]>,
  context: WorkerCommandContext,
  operation: WorkerLifecycleOperation,
  targetId: string | undefined,
  request: unknown,
  mutation: (
    transaction: WorkerRepositoryTransaction,
    timestamp: string,
  ) => WorkerLifecycleCommandResponse,
): Promise<WorkerLifecycleCommandResponse> {
  validateCommandContext(context);
  const requestDigest = digestRequest(request);
  try {
    return await repository.transact(context.workspaceId, (transaction) => {
      const existing = transaction.findCommandReceipt(context.idempotencyKey);
      if (existing) {
        if (
          existing.operation !== operation ||
          existing.targetId !== targetId ||
          existing.requestDigest !== requestDigest ||
          canonicalWorkerJson(existing.actor) !== canonicalWorkerJson(context.actor)
        ) {
          throw new WorkerLifecycleError(
            "idempotency_mismatch",
            "Worker lifecycle idempotency key was already used for different input.",
          );
        }
        return existing.response;
      }

      const timestamp = now().toISOString();
      const response = mutation(transaction, timestamp);
      transaction.insertCommandReceipt({
        schemaVersion: WORKER_COMMAND_SCHEMA_VERSION,
        id: id("receipt"),
        workspaceId: context.workspaceId,
        idempotencyKey: context.idempotencyKey,
        operation,
        ...(targetId ? { targetId } : {}),
        requestDigest,
        response,
        actor: context.actor,
        createdAt: timestamp,
      });
      return response;
    });
  } catch (error) {
    if (error instanceof WorkerLifecycleError) throw error;
    if (error instanceof WorkerTransitionError) {
      throw new WorkerLifecycleError("invalid_transition", error.message, {
        cause: error,
      });
    }
    if (error instanceof WorkerContractValidationError) {
      throw new WorkerLifecycleError("invalid_input", error.message, {
        cause: error,
      });
    }
    if (error instanceof WorkerCapabilityCompilationError) {
      throw new WorkerLifecycleError("invalid_input", error.message, {
        cause: error,
      });
    }
    throw error;
  }
}

interface AppendEventInput {
  readonly type: string;
  readonly definition: WorkerDefinition;
  readonly version?: WorkerVersion;
  readonly deployment?: WorkerDeployment;
  readonly actor: WorkerActorReference;
  readonly summary: string;
}

function appendEvent(
  transaction: WorkerRepositoryTransaction,
  id: NonNullable<WorkerLifecycleServiceDependencies["id"]>,
  occurredAt: string,
  input: AppendEventInput,
): void {
  transaction.appendJournal({
    id: id("event"),
    workspaceId: transaction.workspaceId,
    type: input.type,
    source: "lifecycle",
    workerDefinitionId: input.definition.id,
    ...(input.version ? { workerVersionId: input.version.id } : {}),
    ...(input.deployment ? { workerDeploymentId: input.deployment.id } : {}),
    actor: input.actor,
    summary: input.summary,
    occurredAt,
  });
}

function deploymentTimestamp(
  status: "validated" | "deployed" | "active" | "paused" | "retired",
  timestamp: string,
): Partial<WorkerDeployment> {
  if (status === "validated") return { validatedAt: timestamp };
  if (status === "deployed") return { deployedAt: timestamp };
  if (status === "active") return { activatedAt: timestamp };
  if (status === "paused") return { pausedAt: timestamp };
  return { retiredAt: timestamp };
}

function requireDefinition(transaction: WorkerRepositoryTransaction, id: string): WorkerDefinition {
  const record = transaction.findDefinition(id);
  if (!record) throw new WorkerLifecycleError("not_found", `WorkerDefinition ${id} was not found.`);
  return record;
}

function requireVersion(transaction: WorkerRepositoryTransaction, id: string): WorkerVersion {
  const record = transaction.findVersion(id);
  if (!record) throw new WorkerLifecycleError("not_found", `WorkerVersion ${id} was not found.`);
  return record;
}

function requireDeployment(transaction: WorkerRepositoryTransaction, id: string): WorkerDeployment {
  const record = transaction.findDeployment(id);
  if (!record) throw new WorkerLifecycleError("not_found", `WorkerDeployment ${id} was not found.`);
  return record;
}

function assertExpectedDigest(version: WorkerVersion, expectedContentDigest: string): void {
  if (version.contentDigest !== expectedContentDigest)
    throw new WorkerLifecycleError("conflict", "WorkerVersion content changed after it was read.");
}

function assertExpectedRevision(deployment: WorkerDeployment, expectedRevision: number): void {
  if (deployment.revision !== expectedRevision)
    throw new WorkerLifecycleError(
      "conflict",
      `WorkerDeployment revision conflict: expected ${expectedRevision}, current ${deployment.revision}.`,
    );
}

function validateCommandContext(context: WorkerCommandContext): void {
  requireNonEmpty(context.workspaceId, "workspaceId");
  requireNonEmpty(context.idempotencyKey, "idempotencyKey");
  if (!context.actor?.id || !context.actor.type)
    throw new WorkerLifecycleError("invalid_input", "actor is required.");
}

function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new WorkerLifecycleError("invalid_input", `${field} is required.`);
  return value.trim();
}

function digestRequest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalWorkerJson(value)).digest("hex")}`;
}

function defaultId(
  kind: "definition" | "version" | "deployment" | "rollout" | "receipt" | "event",
): string {
  const prefixes = {
    definition: "worker",
    version: "worker_version",
    deployment: "worker_deployment",
    rollout: "worker_rollout",
    receipt: "worker_command",
    event: "worker_event",
  } as const;
  return `${prefixes[kind]}_${randomUUID()}`;
}
