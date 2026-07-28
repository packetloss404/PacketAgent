import { createHash } from "node:crypto";
import {
  loadStoreAsync as defaultLoadStore,
  mutateStoreAsync as defaultMutateStore,
  type PacketAgentData,
} from "../../packetagent-store.js";
import { createWorkerActivationService, type WorkerActivationService } from "../activation.js";
import type { WorkerActivationAdmissionResult } from "../activation-types.js";
import {
  createWorkerControlService,
  type WorkerControlResult,
  type WorkerControlService,
} from "../control-service.js";
import { WorkerLifecycleError } from "../errors.js";
import {
  createWorkerOperationsReadModel,
  type WorkerOperationsReadModel,
  type WorkerRunListFilters,
} from "../observability/read-model.js";
import type { WorkerLifecycleCommandResponse } from "../persistence-types.js";
import { validateWorkerPersistence } from "../repository.js";
import { createWorkerLifecycleService, type WorkerLifecycleService } from "../service.js";
import type { JsonObject, WorkerDeployment, WorkerTraceContext, WorkerVersion } from "../types.js";
import { canonicalWorkerJson } from "../validation.js";
import {
  PacketProductTrustError,
  createPacketProductTrustService,
  type AcceptWorkerPackageInput,
  type PacketProductTrustService,
} from "./trust.js";
import {
  WORKER_PACKAGE_DEPLOYMENT_SCHEMA_VERSION,
  assertValidWorkerPackageDeploymentRecord,
  type WorkerPackageDeploymentRecord,
  type WorkerPackageReceipt,
} from "./trust-types.js";
import { validateWorkerPackage } from "./validation.js";
import type { WorkerPackage } from "./types.js";

type MaybePromise<T> = T | Promise<T>;

export const PACKET_PRODUCT_DEPLOYMENT_RESULT_SCHEMA_VERSION =
  "packetagent.packet-product-deployment-result/v1" as const;

export interface PacketProductPackageInput extends AcceptWorkerPackageInput {
  readonly idempotencyKey: string;
}

export interface PacketProductUpdateInput extends PacketProductPackageInput {
  readonly workerDeploymentId: string;
  readonly expectedRevision: number;
  readonly statusReason?: string;
}

export interface PacketProductDeploymentControlInput {
  readonly authorization: string | null | undefined;
  readonly workspaceId: string;
  readonly workerDeploymentId: string;
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  readonly statusReason?: string;
}

export interface PacketProductActivationInput extends PacketProductDeploymentControlInput {
  readonly startRun: boolean;
  readonly triggerId?: string;
  readonly input?: JsonObject;
  readonly trace?: WorkerTraceContext;
}

export interface PacketProductRollbackInput extends PacketProductDeploymentControlInput {
  readonly targetPackageVersion: number;
}

export interface PacketProductDeploymentResult {
  readonly schemaVersion: typeof PACKET_PRODUCT_DEPLOYMENT_RESULT_SCHEMA_VERSION;
  readonly dryRun: boolean;
  readonly receipt: WorkerPackageReceipt;
  readonly binding?: WorkerPackageDeploymentRecord;
  readonly replayed: boolean;
  readonly requiredLocalApprovals: readonly {
    readonly capabilityId: string;
    readonly approval: string;
  }[];
  readonly capabilities: {
    readonly requested: readonly string[];
    readonly packageAllowed: readonly string[];
    readonly locallyAccepted: readonly string[];
    readonly grants: WorkerPackageReceipt["capabilityDecision"]["grants"];
    readonly policyDigest: string;
  };
  readonly definition?: WorkerLifecycleCommandResponse["definition"];
  readonly version?: WorkerLifecycleCommandResponse["version"];
  readonly deployment?: WorkerLifecycleCommandResponse["deployment"];
  readonly previousDeployment?: WorkerLifecycleCommandResponse["previousDeployment"];
  readonly rollout?: WorkerLifecycleCommandResponse["rollout"];
  readonly activation?: WorkerActivationAdmissionResult;
  readonly resultingIds: {
    readonly receiptId: string;
    readonly workerDefinitionId?: string;
    readonly workerVersionId?: string;
    readonly workerDeploymentId?: string;
    readonly previousWorkerDeploymentId?: string;
    readonly workerRunId?: string;
    readonly executionJobId?: string;
  };
}

export interface PacketProductDeploymentServiceDependencies {
  readonly trust?: PacketProductTrustService;
  readonly lifecycle?: WorkerLifecycleService;
  readonly activation?: WorkerActivationService;
  readonly control?: WorkerControlService;
  readonly readModel?: WorkerOperationsReadModel;
  readonly loadStore?: () => MaybePromise<PacketAgentData>;
  readonly mutateStore?: <T>(
    mutation: (data: PacketAgentData) => MaybePromise<T>,
  ) => MaybePromise<T>;
  readonly now?: () => string;
}

export interface PacketProductDeploymentService {
  validatePackage(input: PacketProductPackageInput): Promise<PacketProductDeploymentResult>;
  deployPackage(input: PacketProductPackageInput): Promise<PacketProductDeploymentResult>;
  updatePackage(input: PacketProductUpdateInput): Promise<PacketProductDeploymentResult>;
  activate(input: PacketProductActivationInput): Promise<PacketProductDeploymentResult>;
  inspect(input: {
    readonly authorization: string | null | undefined;
    readonly workspaceId: string;
    readonly workerDeploymentId: string;
  }): Promise<PacketProductDeploymentResult>;
  listRuns(
    input: {
      readonly authorization: string | null | undefined;
      readonly workspaceId: string;
      readonly workerDeploymentId: string;
    },
    filters?: Omit<WorkerRunListFilters, "workerDeploymentId">,
  ): ReturnType<WorkerOperationsReadModel["listRuns"]>;
  pause(input: PacketProductDeploymentControlInput): Promise<PacketProductDeploymentResult>;
  resume(input: PacketProductDeploymentControlInput): Promise<PacketProductDeploymentResult>;
  rollback(input: PacketProductRollbackInput): Promise<PacketProductDeploymentResult>;
  revoke(input: PacketProductDeploymentControlInput): Promise<{
    readonly schemaVersion: typeof PACKET_PRODUCT_DEPLOYMENT_RESULT_SCHEMA_VERSION;
    readonly receipt: WorkerPackageReceipt;
    readonly binding: WorkerPackageDeploymentRecord;
    readonly control: WorkerControlResult;
  }>;
}

export function createPacketProductDeploymentService(
  dependencies: PacketProductDeploymentServiceDependencies = {},
): PacketProductDeploymentService {
  const loadStore = dependencies.loadStore ?? defaultLoadStore;
  const mutateStore = dependencies.mutateStore ?? defaultMutateStore;
  const trust = dependencies.trust ?? createPacketProductTrustService({ loadStore, mutateStore });
  const lifecycle = dependencies.lifecycle ?? createWorkerLifecycleService();
  const activation = dependencies.activation ?? createWorkerActivationService();
  const control = dependencies.control ?? createWorkerControlService({ mutateStore });
  const readModel =
    dependencies.readModel ??
    createWorkerOperationsReadModel({
      loadStore,
    });
  const now = dependencies.now ?? (() => new Date().toISOString());

  async function validatePackage(
    input: PacketProductPackageInput,
  ): Promise<PacketProductDeploymentResult> {
    requireCommandInput(input);
    const accepted = await trust.acceptPackage(input);
    return projectResult(accepted.receipt, accepted.replayed, undefined, {}, undefined, true);
  }

  async function deployPackage(
    input: PacketProductPackageInput,
  ): Promise<PacketProductDeploymentResult> {
    requireCommandInput(input);
    const accepted = await trust.acceptPackage(input);
    const auth = await trust.authorizeWrite({
      authorization: input.authorization,
      workspaceId: input.workspaceId,
      operation: "package.deploy",
    });
    const workerPackage = requireValidatedPackage(input.workerPackage);
    const ids = packageWorkerIds(input.workspaceId, workerPackage);
    const existingBinding = await findPackageBinding(
      loadStore,
      input.workspaceId,
      workerPackage.packageId,
      workerPackage.packageVersion,
      workerPackage.integrity.digest,
    );
    if (existingBinding) {
      const response = await resolveLifecycleResponse(
        lifecycle,
        input.workspaceId,
        existingBinding,
      );
      return projectResult(accepted.receipt, true, existingBinding, response);
    }

    const version = await ensurePackageVersion({
      lifecycle,
      workspaceId: input.workspaceId,
      actor: auth.actor,
      receipt: accepted.receipt,
      workerPackage,
      ids,
    });
    let deployment = await optionalDeployment(lifecycle, input.workspaceId, ids.deploymentId);
    if (!deployment) {
      deployment = requireDeploymentResponse(
        await lifecycle.createDeployment({
          workspaceId: input.workspaceId,
          actor: auth.actor,
          idempotencyKey: internalKey(accepted.receipt.id, "deployment.create"),
          deploymentId: ids.deploymentId,
          workerVersionId: version.id,
          capabilityGrants: accepted.receipt.capabilityDecision.grants,
        }),
      );
    }
    if (deployment.status === "draft") {
      deployment = requireDeploymentResponse(
        await lifecycle.validateDeployment({
          workspaceId: input.workspaceId,
          actor: auth.actor,
          idempotencyKey: internalKey(accepted.receipt.id, "deployment.validate"),
          workerDeploymentId: deployment.id,
          expectedRevision: deployment.revision,
        }),
      );
    }
    if (deployment.status === "validated") {
      deployment = requireDeploymentResponse(
        await lifecycle.deploy({
          workspaceId: input.workspaceId,
          actor: auth.actor,
          idempotencyKey: internalKey(accepted.receipt.id, "deployment.deploy"),
          workerDeploymentId: deployment.id,
          expectedRevision: deployment.revision,
        }),
      );
    }
    if (deployment.status !== "deployed") {
      throw new WorkerLifecycleError(
        "conflict",
        `Packet-product deploy resolved to an unexpected ${deployment.status} deployment.`,
      );
    }
    const binding = await bindDeployment(mutateStore, now, {
      receipt: accepted.receipt,
      workerDefinitionId: ids.definitionId,
      workerVersionId: version.id,
      workerDeploymentId: deployment.id,
      operation: "deploy",
      actor: auth.actor,
    });
    return projectResult(
      accepted.receipt,
      accepted.replayed,
      binding,
      await resolveLifecycleResponse(lifecycle, input.workspaceId, binding),
    );
  }

  async function updatePackage(
    input: PacketProductUpdateInput,
  ): Promise<PacketProductDeploymentResult> {
    requireCommandInput(input);
    requireRevision(input.expectedRevision);
    const accepted = await trust.acceptPackage(input);
    const auth = await trust.authorizeWrite({
      authorization: input.authorization,
      workspaceId: input.workspaceId,
      operation: "package.update",
    });
    const current = await requireBoundDeployment(
      loadStore,
      input.workspaceId,
      input.workerDeploymentId,
    );
    const workerPackage = requireValidatedPackage(input.workerPackage);
    if (current.binding.packageId !== workerPackage.packageId) {
      throw fieldError(
        "$.workerPackage.packageId",
        "package.update.package_mismatch",
        "must match the package bound to the deployment being updated",
      );
    }
    if (workerPackage.packageVersion <= current.binding.packageVersion) {
      throw fieldError(
        "$.workerPackage.packageVersion",
        "package.update.version_not_newer",
        "must be greater than the package version bound to the current deployment",
      );
    }
    const existingBinding = await findPackageBinding(
      loadStore,
      input.workspaceId,
      workerPackage.packageId,
      workerPackage.packageVersion,
      workerPackage.integrity.digest,
    );
    if (existingBinding) {
      const response = await resolveLifecycleResponse(
        lifecycle,
        input.workspaceId,
        existingBinding,
      );
      return projectResult(accepted.receipt, true, existingBinding, response);
    }
    const ids = packageWorkerIds(input.workspaceId, workerPackage);
    if (ids.definitionId !== current.binding.workerDefinitionId) {
      throw new WorkerLifecycleError(
        "integrity",
        "Packet-product package identity does not resolve to its bound WorkerDefinition.",
      );
    }
    const version = await ensurePackageVersion({
      lifecycle,
      workspaceId: input.workspaceId,
      actor: auth.actor,
      receipt: accepted.receipt,
      workerPackage,
      ids,
    });
    const response = await lifecycle.updateDeployment({
      workspaceId: input.workspaceId,
      actor: auth.actor,
      idempotencyKey: internalKey(accepted.receipt.id, "deployment.update"),
      workerDeploymentId: input.workerDeploymentId,
      expectedRevision: input.expectedRevision,
      targetWorkerVersionId: version.id,
      replacementDeploymentId: ids.deploymentId,
      capabilityGrants: accepted.receipt.capabilityDecision.grants,
      ...(input.statusReason ? { statusReason: input.statusReason } : {}),
    });
    const deployment = requireDeploymentResponse(response);
    const binding = await bindDeployment(mutateStore, now, {
      receipt: accepted.receipt,
      workerDefinitionId: current.binding.workerDefinitionId,
      workerVersionId: version.id,
      workerDeploymentId: deployment.id,
      operation: "update",
      actor: auth.actor,
    });
    return projectResult(accepted.receipt, accepted.replayed, binding, response);
  }

  async function activate(
    input: PacketProductActivationInput,
  ): Promise<PacketProductDeploymentResult> {
    requireControlInput(input);
    const auth = await trust.authorizeWrite({
      authorization: input.authorization,
      workspaceId: input.workspaceId,
      operation: "deployment.activate",
    });
    const current = await requireBoundDeployment(
      loadStore,
      input.workspaceId,
      input.workerDeploymentId,
    );
    const response = await lifecycle.activate({
      workspaceId: input.workspaceId,
      actor: auth.actor,
      idempotencyKey: internalKey(input.idempotencyKey, "deployment.activate"),
      workerDeploymentId: input.workerDeploymentId,
      expectedRevision: input.expectedRevision,
      ...(input.statusReason ? { statusReason: input.statusReason } : {}),
    });
    let activationResult: WorkerActivationAdmissionResult | undefined;
    if (input.startRun) {
      const version = response.version ?? current.version;
      const triggerId =
        input.triggerId ??
        version.content.triggers.find((trigger) => trigger.enabled && trigger.kind === "manual")
          ?.id;
      if (!triggerId) {
        throw fieldError(
          "$.triggerId",
          "deployment.activation.manual_trigger_required",
          "is required because the deployed Worker version has no enabled manual trigger",
        );
      }
      activationResult = await activation.admit({
        workspaceId: input.workspaceId,
        workerDeploymentId: input.workerDeploymentId,
        triggerId,
        source: "manual",
        deliveryId: internalKey(input.idempotencyKey, "manual-run"),
        actor: auth.actor,
        payload: input.input ?? {},
        ...(input.trace ? { trace: input.trace } : {}),
      });
    }
    return projectResult(
      current.receipt,
      false,
      current.binding,
      {
        ...response,
        ...(activationResult ? { activation: activationResult } : {}),
      },
      activationResult,
    );
  }

  async function inspect(input: {
    readonly authorization: string | null | undefined;
    readonly workspaceId: string;
    readonly workerDeploymentId: string;
  }): Promise<PacketProductDeploymentResult> {
    await trust.authenticate({
      authorization: input.authorization,
      workspaceId: input.workspaceId,
      operation: "deployment.inspect",
    });
    const current = await requireBoundDeployment(
      loadStore,
      input.workspaceId,
      input.workerDeploymentId,
    );
    return projectResult(current.receipt, false, current.binding, {
      definition: current.definition,
      version: current.version,
      deployment: current.deployment,
    });
  }

  async function listRuns(
    input: {
      readonly authorization: string | null | undefined;
      readonly workspaceId: string;
      readonly workerDeploymentId: string;
    },
    filters: Omit<WorkerRunListFilters, "workerDeploymentId"> = {},
  ) {
    await trust.authenticate({
      authorization: input.authorization,
      workspaceId: input.workspaceId,
      operation: "deployment.list_runs",
    });
    await requireBoundDeployment(loadStore, input.workspaceId, input.workerDeploymentId);
    return await readModel.listRuns(input.workspaceId, {
      ...filters,
      workerDeploymentId: input.workerDeploymentId,
    });
  }

  async function transition(
    input: PacketProductDeploymentControlInput,
    operation: "deployment.pause" | "deployment.resume",
  ): Promise<PacketProductDeploymentResult> {
    requireControlInput(input);
    const auth = await trust.authorizeWrite({
      authorization: input.authorization,
      workspaceId: input.workspaceId,
      operation,
    });
    const current = await requireBoundDeployment(
      loadStore,
      input.workspaceId,
      input.workerDeploymentId,
    );
    const method = operation === "deployment.pause" ? lifecycle.pause : lifecycle.resume;
    const response = await method({
      workspaceId: input.workspaceId,
      actor: auth.actor,
      idempotencyKey: internalKey(input.idempotencyKey, operation),
      workerDeploymentId: input.workerDeploymentId,
      expectedRevision: input.expectedRevision,
      ...(input.statusReason ? { statusReason: input.statusReason } : {}),
    });
    return projectResult(current.receipt, false, current.binding, response);
  }

  async function rollback(
    input: PacketProductRollbackInput,
  ): Promise<PacketProductDeploymentResult> {
    requireControlInput(input);
    if (!Number.isSafeInteger(input.targetPackageVersion) || input.targetPackageVersion < 1) {
      throw fieldError(
        "$.targetPackageVersion",
        "request.positive_integer",
        "must be a positive integer",
      );
    }
    const auth = await trust.authorizeWrite({
      authorization: input.authorization,
      workspaceId: input.workspaceId,
      operation: "deployment.rollback",
    });
    const current = await requireBoundDeployment(
      loadStore,
      input.workspaceId,
      input.workerDeploymentId,
    );
    const target = await requirePackageVersionBinding(
      loadStore,
      input.workspaceId,
      current.binding.packageId,
      input.targetPackageVersion,
    );
    const replacementDeploymentId = stableId("deployment", [
      input.workspaceId,
      current.binding.packageId,
      String(input.targetPackageVersion),
      input.workerDeploymentId,
      input.idempotencyKey,
    ]);
    const response = await lifecycle.rollback({
      workspaceId: input.workspaceId,
      actor: auth.actor,
      idempotencyKey: internalKey(input.idempotencyKey, "deployment.rollback"),
      workerDeploymentId: input.workerDeploymentId,
      expectedRevision: input.expectedRevision,
      targetWorkerVersionId: target.binding.workerVersionId,
      replacementDeploymentId,
      capabilityGrants: target.receipt.capabilityDecision.grants,
      ...(input.statusReason ? { statusReason: input.statusReason } : {}),
    });
    const deployment = requireDeploymentResponse(response);
    const binding = await bindDeployment(mutateStore, now, {
      receipt: target.receipt,
      workerDefinitionId: current.binding.workerDefinitionId,
      workerVersionId: target.binding.workerVersionId,
      workerDeploymentId: deployment.id,
      operation: "rollback",
      actor: auth.actor,
    });
    return projectResult(target.receipt, false, binding, response);
  }

  return {
    validatePackage,
    deployPackage,
    updatePackage,
    activate,
    inspect,
    listRuns,
    pause: (input) => transition(input, "deployment.pause"),
    resume: (input) => transition(input, "deployment.resume"),
    rollback,
    async revoke(input) {
      requireControlInput(input);
      const auth = await trust.authorizeWrite({
        authorization: input.authorization,
        workspaceId: input.workspaceId,
        operation: "deployment.revoke",
      });
      const current = await requireBoundDeployment(
        loadStore,
        input.workspaceId,
        input.workerDeploymentId,
      );
      const result = await control.revokeDeployment({
        workspaceId: input.workspaceId,
        actor: auth.actor,
        idempotencyKey: internalKey(input.idempotencyKey, "deployment.revoke"),
        expectedRevision: input.expectedRevision,
        workerDeploymentId: input.workerDeploymentId,
      });
      return {
        schemaVersion: PACKET_PRODUCT_DEPLOYMENT_RESULT_SCHEMA_VERSION,
        receipt: current.receipt,
        binding: current.binding,
        control: result,
      };
    },
  };
}

async function ensurePackageVersion(input: {
  readonly lifecycle: WorkerLifecycleService;
  readonly workspaceId: string;
  readonly actor: WorkerPackageReceipt["authenticatedActor"];
  readonly receipt: WorkerPackageReceipt;
  readonly workerPackage: WorkerPackage;
  readonly ids: ReturnType<typeof packageWorkerIds>;
}): Promise<WorkerVersion> {
  let version = await optionalVersion(input.lifecycle, input.workspaceId, input.ids.versionId);
  if (!version) {
    const definition = await optionalDefinition(
      input.lifecycle,
      input.workspaceId,
      input.ids.definitionId,
    );
    const response = definition
      ? await input.lifecycle.createVersion({
          workspaceId: input.workspaceId,
          actor: input.actor,
          idempotencyKey: internalKey(input.receipt.id, "version.create"),
          workerDefinitionId: definition.id,
          versionId: input.ids.versionId,
          content: input.workerPackage.worker.content,
          source: input.workerPackage.source,
        })
      : await input.lifecycle.createDefinition({
          workspaceId: input.workspaceId,
          actor: input.actor,
          idempotencyKey: internalKey(input.receipt.id, "definition.create"),
          definitionId: input.ids.definitionId,
          versionId: input.ids.versionId,
          name: input.workerPackage.worker.name,
          description: input.workerPackage.worker.description,
          content: input.workerPackage.worker.content,
          source: input.workerPackage.source,
        });
    version = requireVersionResponse(response);
  }
  if (
    version.workerDefinitionId !== input.ids.definitionId ||
    version.contentDigest !== input.receipt.workerVersionContentDigest ||
    canonicalWorkerJson(version.source) !== canonicalWorkerJson(input.receipt.source)
  ) {
    throw new WorkerLifecycleError(
      "integrity",
      "Packet-product WorkerVersion does not match its accepted package receipt.",
    );
  }
  if (version.status === "draft") {
    version = requireVersionResponse(
      await input.lifecycle.validateVersion({
        workspaceId: input.workspaceId,
        actor: input.actor,
        idempotencyKey: internalKey(input.receipt.id, "version.validate"),
        workerVersionId: version.id,
        expectedContentDigest: version.contentDigest,
      }),
    );
  }
  if (version.status !== "validated") {
    throw new WorkerLifecycleError(
      "conflict",
      `Packet-product WorkerVersion is ${version.status}, not validated.`,
    );
  }
  return version;
}

async function bindDeployment(
  mutateStore: NonNullable<PacketProductDeploymentServiceDependencies["mutateStore"]>,
  now: NonNullable<PacketProductDeploymentServiceDependencies["now"]>,
  input: {
    readonly receipt: WorkerPackageReceipt;
    readonly workerDefinitionId: string;
    readonly workerVersionId: string;
    readonly workerDeploymentId: string;
    readonly operation: WorkerPackageDeploymentRecord["operation"];
    readonly actor: WorkerPackageDeploymentRecord["actor"];
  },
): Promise<WorkerPackageDeploymentRecord> {
  return await mutateStore((data) => {
    validateWorkerPersistence(data);
    const existing = data.workerPackageDeployments.find(
      (record) =>
        record.workspaceId === input.receipt.workspaceId &&
        record.workerDeploymentId === input.workerDeploymentId,
    );
    if (existing) {
      if (
        existing.receiptId !== input.receipt.id ||
        existing.packageId !== input.receipt.packageId ||
        existing.packageVersion !== input.receipt.packageVersion ||
        existing.packageDigest !== input.receipt.packageDigest ||
        existing.workerDefinitionId !== input.workerDefinitionId ||
        existing.workerVersionId !== input.workerVersionId ||
        existing.operation !== input.operation ||
        canonicalWorkerJson(existing.actor) !== canonicalWorkerJson(input.actor)
      ) {
        throw new WorkerLifecycleError(
          "idempotency_mismatch",
          "Worker deployment is already bound to a different accepted package.",
        );
      }
      return structuredClone(existing);
    }
    const record: WorkerPackageDeploymentRecord = {
      schemaVersion: WORKER_PACKAGE_DEPLOYMENT_SCHEMA_VERSION,
      id: stableId("package_deployment", [input.receipt.workspaceId, input.workerDeploymentId]),
      workspaceId: input.receipt.workspaceId,
      receiptId: input.receipt.id,
      packageId: input.receipt.packageId,
      packageVersion: input.receipt.packageVersion,
      packageDigest: input.receipt.packageDigest,
      workerDefinitionId: input.workerDefinitionId,
      workerVersionId: input.workerVersionId,
      workerDeploymentId: input.workerDeploymentId,
      operation: input.operation,
      actor: structuredClone(input.actor),
      createdAt: now(),
    };
    assertValidWorkerPackageDeploymentRecord(record);
    data.workerPackageDeployments.push(record);
    validateWorkerPersistence(data);
    return structuredClone(record);
  });
}

async function requireBoundDeployment(
  loadStore: () => MaybePromise<PacketAgentData>,
  workspaceId: string,
  workerDeploymentId: string,
) {
  const data = await loadStore();
  validateWorkerPersistence(data);
  const binding = data.workerPackageDeployments.find(
    (record) =>
      record.workspaceId === workspaceId && record.workerDeploymentId === workerDeploymentId,
  );
  if (!binding) {
    throw new WorkerLifecycleError(
      "not_found",
      `Packet-product WorkerDeployment ${workerDeploymentId} was not found.`,
    );
  }
  return resolveBoundRecords(data, binding);
}

async function requirePackageVersionBinding(
  loadStore: () => MaybePromise<PacketAgentData>,
  workspaceId: string,
  packageId: string,
  packageVersion: number,
) {
  const data = await loadStore();
  validateWorkerPersistence(data);
  const binding = [...data.workerPackageDeployments]
    .reverse()
    .find(
      (record) =>
        record.workspaceId === workspaceId &&
        record.packageId === packageId &&
        record.packageVersion === packageVersion,
    );
  if (!binding) {
    throw fieldError(
      "$.targetPackageVersion",
      "package.rollback.target_not_found",
      "does not identify a previously deployed package version",
      404,
    );
  }
  return resolveBoundRecords(data, binding);
}

function resolveBoundRecords(data: PacketAgentData, binding: WorkerPackageDeploymentRecord) {
  const receipt = data.workerPackageReceipts.find(
    (record) => record.workspaceId === binding.workspaceId && record.id === binding.receiptId,
  );
  const definition = data.workerDefinitions.find(
    (record) =>
      record.workspaceId === binding.workspaceId && record.id === binding.workerDefinitionId,
  );
  const version = data.workerVersions.find(
    (record) => record.workspaceId === binding.workspaceId && record.id === binding.workerVersionId,
  );
  const deployment = data.workerDeployments.find(
    (record) =>
      record.workspaceId === binding.workspaceId && record.id === binding.workerDeploymentId,
  );
  if (!receipt || !definition || !version || !deployment) {
    throw new WorkerLifecycleError(
      "integrity",
      "Packet-product deployment binding does not resolve to durable Worker records.",
    );
  }
  return {
    binding: structuredClone(binding),
    receipt: structuredClone(receipt),
    definition: structuredClone(definition),
    version: structuredClone(version),
    deployment: structuredClone(deployment),
  };
}

async function findPackageBinding(
  loadStore: () => MaybePromise<PacketAgentData>,
  workspaceId: string,
  packageId: string,
  packageVersion: number,
  packageDigest: string,
): Promise<WorkerPackageDeploymentRecord | undefined> {
  const data = await loadStore();
  validateWorkerPersistence(data);
  const candidates = data.workerPackageDeployments.filter(
    (record) =>
      record.workspaceId === workspaceId &&
      record.packageId === packageId &&
      record.packageVersion === packageVersion,
  );
  const conflict = candidates.find((record) => record.packageDigest !== packageDigest);
  if (conflict) {
    throw new WorkerLifecycleError(
      "conflict",
      "WorkerPackage ID and version are already deployed with different content.",
    );
  }
  return candidates.at(-1);
}

async function resolveLifecycleResponse(
  lifecycle: WorkerLifecycleService,
  workspaceId: string,
  binding: WorkerPackageDeploymentRecord,
): Promise<WorkerLifecycleCommandResponse> {
  const detail = await lifecycle.getDefinition(workspaceId, binding.workerDefinitionId);
  const version = detail.versions.find((record) => record.id === binding.workerVersionId);
  const deployment = detail.deployments.find((record) => record.id === binding.workerDeploymentId);
  if (!version || !deployment) {
    throw new WorkerLifecycleError(
      "integrity",
      "Packet-product deployment binding does not resolve through the lifecycle service.",
    );
  }
  return { definition: detail.definition, version, deployment };
}

function projectResult(
  receipt: WorkerPackageReceipt,
  replayed: boolean,
  binding?: WorkerPackageDeploymentRecord,
  response: WorkerLifecycleCommandResponse & {
    readonly activation?: WorkerActivationAdmissionResult;
  } = {},
  activation?: WorkerActivationAdmissionResult,
  dryRun = false,
): PacketProductDeploymentResult {
  const decision = receipt.capabilityDecision;
  return {
    schemaVersion: PACKET_PRODUCT_DEPLOYMENT_RESULT_SCHEMA_VERSION,
    dryRun,
    receipt: structuredClone(receipt),
    ...(binding ? { binding: structuredClone(binding) } : {}),
    replayed,
    requiredLocalApprovals: decision.grants
      .filter((grant) => grant.approval !== "never")
      .map((grant) => ({
        capabilityId: grant.capabilityId,
        approval: grant.approval,
      })),
    capabilities: {
      requested: [...decision.requestedCapabilityIds],
      packageAllowed: [...decision.packageAllowedCapabilityIds],
      locallyAccepted: [...decision.acceptedCapabilityIds],
      grants: structuredClone(decision.grants),
      policyDigest: decision.compiledPolicy.policyDigest,
    },
    ...(response.definition ? { definition: response.definition } : {}),
    ...(response.version ? { version: response.version } : {}),
    ...(response.deployment ? { deployment: response.deployment } : {}),
    ...(response.previousDeployment ? { previousDeployment: response.previousDeployment } : {}),
    ...(response.rollout ? { rollout: response.rollout } : {}),
    ...((activation ?? response.activation)
      ? { activation: activation ?? response.activation }
      : {}),
    resultingIds: {
      receiptId: receipt.id,
      ...(response.definition ? { workerDefinitionId: response.definition.id } : {}),
      ...(response.version ? { workerVersionId: response.version.id } : {}),
      ...(response.deployment ? { workerDeploymentId: response.deployment.id } : {}),
      ...(response.previousDeployment
        ? { previousWorkerDeploymentId: response.previousDeployment.id }
        : {}),
      ...((activation ?? response.activation)
        ? {
            workerRunId: (activation ?? response.activation)!.runId,
            executionJobId: (activation ?? response.activation)!.executionJobId,
          }
        : {}),
    },
  };
}

function packageWorkerIds(workspaceId: string, workerPackage: WorkerPackage) {
  const common = [
    workspaceId,
    workerPackage.packageId,
    String(workerPackage.packageVersion),
    workerPackage.integrity.digest,
  ];
  return {
    definitionId: stableId("definition", [workspaceId, workerPackage.packageId]),
    versionId: stableId("version", common),
    deploymentId: stableId("deployment", common),
  };
}

function stableId(kind: string, parts: readonly string[]): string {
  const digest = createHash("sha256")
    .update("packetagent.packet-product-worker-id/v1\0")
    .update(kind)
    .update("\0")
    .update(parts.join("\0"))
    .digest("hex")
    .slice(0, 32);
  return `${kind}_pkade_${digest}`;
}

function internalKey(key: string, operation: string): string {
  return `packetade:${createHash("sha256")
    .update("packetagent.packet-product-command/v1\0")
    .update(key)
    .update("\0")
    .update(operation)
    .digest("hex")}`;
}

function requireValidatedPackage(value: unknown): WorkerPackage {
  const result = validateWorkerPackage(value);
  if (!result.ok) {
    throw new PacketProductTrustError(
      "invalid_package",
      "WorkerPackage integrity or schema validation failed.",
      400,
      { issues: result.issues },
    );
  }
  return result.value;
}

function requireCommandInput(input: PacketProductPackageInput): void {
  requireNonEmpty(input.workspaceId, "$.workspaceId");
  requireNonEmpty(input.idempotencyKey, "$.headers.Idempotency-Key");
}

function requireControlInput(input: PacketProductDeploymentControlInput): void {
  requireNonEmpty(input.workspaceId, "$.workspaceId");
  requireNonEmpty(input.workerDeploymentId, "$.workerDeploymentId");
  requireNonEmpty(input.idempotencyKey, "$.headers.Idempotency-Key");
  requireRevision(input.expectedRevision);
}

function requireRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw fieldError(
      "$.expectedRevision",
      "request.positive_integer",
      "must be a positive integer",
    );
  }
}

function requireNonEmpty(value: string, path: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw fieldError(path, "request.non_empty_string", "must be a non-empty string");
  }
}

function fieldError(
  path: string,
  code: string,
  message: string,
  status: 400 | 404 = 400,
): PacketProductTrustError {
  return new PacketProductTrustError(
    status === 404 ? "not_found" : "invalid_input",
    "Packet-product request is invalid.",
    status,
    {
      issues: [{ path, code, message }],
    },
  );
}

async function optionalDefinition(
  lifecycle: WorkerLifecycleService,
  workspaceId: string,
  id: string,
) {
  try {
    return (await lifecycle.getDefinition(workspaceId, id)).definition;
  } catch (error) {
    if (error instanceof WorkerLifecycleError && error.code === "not_found") return undefined;
    throw error;
  }
}

async function optionalVersion(lifecycle: WorkerLifecycleService, workspaceId: string, id: string) {
  try {
    return await lifecycle.getVersion(workspaceId, id);
  } catch (error) {
    if (error instanceof WorkerLifecycleError && error.code === "not_found") return undefined;
    throw error;
  }
}

async function optionalDeployment(
  lifecycle: WorkerLifecycleService,
  workspaceId: string,
  id: string,
) {
  try {
    return await lifecycle.getDeployment(workspaceId, id);
  } catch (error) {
    if (error instanceof WorkerLifecycleError && error.code === "not_found") return undefined;
    throw error;
  }
}

function requireVersionResponse(response: WorkerLifecycleCommandResponse): WorkerVersion {
  if (!response.version) {
    throw new WorkerLifecycleError("integrity", "Lifecycle response omitted WorkerVersion.");
  }
  return response.version;
}

function requireDeploymentResponse(response: WorkerLifecycleCommandResponse): WorkerDeployment {
  if (!response.deployment) {
    throw new WorkerLifecycleError("integrity", "Lifecycle response omitted WorkerDeployment.");
  }
  return response.deployment;
}
