import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { exportWorkspaceDataAsync } from "../../jobs/export-workspace.js";
import {
  clearStoreCacheForTests,
  createSeedStore,
  loadStoreAsync,
  mutateStoreAsync,
  resetStoreForTests,
  setManagedPostgresStoreClientFactoryForTests,
  type ManagedPostgresStoreClientConfig,
  type ManagedPostgresStoreQueryClient,
  type ManagedPostgresStoreQueryResult,
  type PacketAgentData,
} from "../../packetagent-store.js";
import { WorkerLifecycleError } from "../errors.js";
import {
  createWorkerLifecycleService,
  type WorkerCommandContext,
  type WorkerLifecycleService,
} from "../service.js";
import type { WorkerSourceProvenance } from "../types.js";
import {
  makeWorkerAttentionRequest,
  makeWorkerNotificationDelivery,
  makeWorkerVersionContent,
} from "./fixtures.js";
import { createWorkerActivationService } from "../activation.js";
import { createWorkerRuntimeRepository } from "../runtime/repository.js";
import { createWorkerEffectRepository } from "../effects.js";
import { createWorkerRecoveryCoordinator } from "../runtime/recovery.js";
import { WORKER_MEMORY_SCHEMA_VERSION } from "../runtime/checkpoint.js";
import { createWorkerCredentialService } from "../credentials.js";
import { resolveWorkerRollingBudgetPolicy } from "../budget-types.js";
import { createWorkerRollingBudgetService } from "../rolling-budget.js";
import { createWorkerControlService } from "../control-service.js";
import {
  WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION,
  type WorkerArtifactManifest,
} from "../observability/types.js";
import { computeWorkerArtifactManifestDigest } from "../observability/validation.js";
import type {
  WorkerObservabilityRollup,
  WorkerObservabilityRollupSet,
} from "../observability/rollup-types.js";
import { buildWorkerObservabilityRollups } from "../observability/rollups.js";
import { createWorkerRetentionService } from "../observability/retention.js";
import { createWorkerOperationsReadModel } from "../observability/read-model.js";
import {
  WORKER_RETENTION_POLICY_SCHEMA_VERSION,
  type WorkerRetentionPolicy,
} from "../observability/retention-types.js";
import { createPacketProductTrustService } from "../package/trust.js";
import { createPacketProductDeploymentService } from "../package/deployment.js";
import type { WorkerPackage } from "../package/types.js";

const STORE_ENV_KEYS = [
  "PACKETAGENT_STORE",
  "PACKETAGENT_DB_PATH",
  "DATABASE_URL",
  "PACKETAGENT_DATABASE_URL",
  "PACKETAGENT_MANAGED_DATABASE_URL",
  "PACKETAGENT_DATABASE_TOPOLOGY",
] as const;

const ACTOR = {
  type: "user",
  id: "user_alpha",
  displayName: "Alpha",
} as const;
const SOURCE: WorkerSourceProvenance = {
  product: "PacketAgent",
  kind: "native",
};

test("Worker lifecycle has JSON, SQLite, and managed Postgres parity", async () => {
  const json = await withJsonStore(runBackendScenario);
  const sqlite = await withSqliteStore(runBackendScenario);
  const managed = await withManagedPostgresStore(runBackendScenario);

  assert.deepEqual(sqlite, json);
  assert.deepEqual(managed, json);
});

interface BackendScenarioResult {
  readonly definitionStatuses: readonly string[];
  readonly deploymentStatusCounts: readonly string[];
  readonly activeVersionIds: readonly string[];
  readonly rolloutLinks: readonly string[];
  readonly commandCount: number;
  readonly eventSequences: readonly number[];
  readonly evidenceSequences: readonly number[];
  readonly artifactManifestDigests: readonly string[];
  readonly exportedDefinitionIds: readonly string[];
  readonly exportedDeploymentIds: readonly string[];
  readonly activationInboxCount: number;
  readonly activationDuplicateCounts: readonly number[];
  readonly workerRunJobCount: number;
  readonly terminalRunStatuses: readonly string[];
  readonly checkpointCount: number;
  readonly effectReceiptStatuses: readonly string[];
  readonly effectResultKinds: readonly string[];
  readonly compiledPolicyDigests: readonly string[];
  readonly capabilityGrantCounts: readonly string[];
  readonly runRevisions: readonly number[];
  readonly workerCredentialRefs: readonly string[];
  readonly exportedWorkerCredentialRefs: readonly string[];
  readonly budgetReservationStatuses: readonly string[];
  readonly exportedBudgetReservationCount: number;
  readonly controlRecordStatuses: readonly string[];
  readonly exportedControlRecordCounts: readonly number[];
  readonly exportedEvidenceCount: number;
  readonly exportedArtifactManifestCount: number;
  readonly retentionEventCount: number;
  readonly rollupProjection: ReturnType<typeof parityRollupProjection>;
  readonly operationsReadModel: Awaited<ReturnType<typeof parityOperationsProjection>>;
  readonly packetProductCredentialCount: number;
  readonly workerPackageReceiptProjection: readonly string[];
  readonly workerPackageDeploymentProjection: readonly string[];
  readonly exportedPacketProductCredentialCount: number;
  readonly exportedWorkerPackageReceiptCount: number;
  readonly exportedWorkerPackageDeploymentCount: number;
}

async function runBackendScenario(): Promise<BackendScenarioResult> {
  const credentialService = createWorkerCredentialService();
  await credentialService.upsert({
    workspaceId: "alpha",
    reference: "vault:release-api",
    kind: "api_key",
    label: "Release API",
    value: "backend-parity-secret",
  });
  const service = createWorkerLifecycleService();
  const packetProductToken = await runPacketProductTrustPersistence();
  await runActivationRace(service);
  await runRollback(service);
  await runActivationAdmissionRace();
  await runRuntimePersistence();
  await runActivationQueueFailureRollback();

  clearStoreCacheForTests();
  const reloadedService = createWorkerLifecycleService();
  const definitions = await reloadedService.listDefinitions("alpha");
  const race = await reloadedService.getDefinition("alpha", "worker-race");
  const rollback = await reloadedService.getDefinition("alpha", "worker-rollback");
  const stored = await loadStoreAsync();
  const exported = await exportWorkspaceDataAsync({ workspaceId: "alpha" });
  const rollupProjection = buildWorkerObservabilityRollups(stored, "alpha");
  const operationsReadModel = await parityOperationsProjection(stored);
  const reordered = structuredClone(stored);
  reverseRollupSources(reordered);
  assert.deepEqual(buildWorkerObservabilityRollups(reordered, "alpha"), rollupProjection);
  assert.deepEqual(await parityOperationsProjection(reordered), operationsReadModel);

  assert.equal(race.deployments.filter((deployment) => deployment.status === "active").length, 1);
  assert.equal(rollback.rollouts.length, 1);
  assert.equal(rollback.rollouts[0].kind, "rollback");
  assert.equal(
    stored.workerDeployments.every(
      (deployment) => deployment.compiledPolicy && deployment.capabilityGrants,
    ),
    true,
  );
  assert.equal(exported.data.workerCommandReceipts.length, stored.workerCommandReceipts.length);
  assert.equal(exported.data.workerEvents.length, stored.workerEvents.length);
  assert.equal(exported.data.workerEvidenceEntries.length, stored.workerEvidenceEntries.length);
  assert.equal(exported.data.workerArtifactManifests.length, stored.workerArtifactManifests.length);
  assert.equal(exported.data.workerEffectReceipts.length, stored.workerEffectReceipts.length);
  assert.equal(
    exported.data.workerBudgetReservations.length,
    stored.workerBudgetReservations.length,
  );
  assert.equal(exported.data.workerAttentionRequests.length, stored.workerAttentionRequests.length);
  assert.equal(exported.data.workerApprovalGrants.length, stored.workerApprovalGrants.length);
  assert.equal(exported.data.workerControlCommands.length, stored.workerControlCommands.length);
  assert.equal(
    exported.data.workerNotificationDeliveries.length,
    stored.workerNotificationDeliveries.length,
  );
  assert.equal(exported.data.workerActivationInboxes.length, stored.workerActivationInboxes.length);
  assert.equal(
    exported.data.packetProductCredentials.length,
    stored.packetProductCredentials.length,
  );
  assert.equal(exported.data.workerPackageReceipts.length, stored.workerPackageReceipts.length);
  assert.equal(
    exported.data.workerPackageDeployments.length,
    stored.workerPackageDeployments.length,
  );
  assert.equal(JSON.stringify(exported).includes("backend-parity-secret"), false);
  assert.equal(JSON.stringify(exported).includes(stored.workerCredentials[0].ciphertext), false);
  assert.equal(JSON.stringify(exported).includes(packetProductToken), false);
  assert.equal(
    JSON.stringify(exported).includes(stored.packetProductCredentials[0]!.tokenDigest),
    false,
  );

  return {
    definitionStatuses: definitions
      .map((definition) => `${definition.id}:${definition.status}`)
      .sort(),
    deploymentStatusCounts: deploymentStatusCounts(stored),
    activeVersionIds: stored.workerDeployments
      .filter(
        (deployment) =>
          deployment.workerDefinitionId === "worker-rollback" && deployment.status === "active",
      )
      .map((deployment) => deployment.workerVersionId)
      .sort(),
    rolloutLinks: stored.workerDeploymentRollouts
      .map((rollout) => `${rollout.kind}:${rollout.fromDeploymentId}->${rollout.toDeploymentId}`)
      .sort(),
    commandCount: stored.workerCommandReceipts.length,
    eventSequences: stored.workerEvents.map((event) => event.sequence),
    evidenceSequences: stored.workerEvidenceEntries
      .map((entry) => entry.sequence)
      .sort((left, right) => left - right),
    artifactManifestDigests: stored.workerArtifactManifests
      .map((manifest) => manifest.manifestDigest)
      .sort(),
    exportedDefinitionIds: exported.data.workerDefinitions
      .map((definition) => definition.id)
      .sort(),
    exportedDeploymentIds: exported.data.workerDeployments
      .map((deployment) => deployment.id)
      .sort(),
    activationInboxCount: stored.workerActivationInboxes.length,
    activationDuplicateCounts: stored.workerActivationInboxes.map(
      (record) => record.duplicateCount,
    ),
    workerRunJobCount: stored.jobs.filter((job) => job.type === "worker.run").length,
    terminalRunStatuses: stored.workerRuns
      .filter((run) => run.status === "completed")
      .map((run) => `${run.id}:${run.terminalReason}`)
      .sort(),
    checkpointCount: stored.workerCheckpoints.length,
    effectReceiptStatuses: stored.workerEffectReceipts
      .map((receipt) => `${receipt.toolName}:${receipt.status}`)
      .sort(),
    effectResultKinds: stored.workerEffectReceipts
      .map((receipt) => receipt.result?.kind ?? "none")
      .sort(),
    compiledPolicyDigests: stored.workerDeployments
      .map((deployment) => `${deployment.id}:${deployment.compiledPolicy!.policyDigest}`)
      .sort(),
    capabilityGrantCounts: stored.workerDeployments
      .map((deployment) => `${deployment.id}:${deployment.capabilityGrants!.length}`)
      .sort(),
    runRevisions: stored.workerRuns.map((run) => run.revision).sort((a, b) => a - b),
    workerCredentialRefs: stored.workerCredentials
      .map((credential) => `${credential.workspaceId}:${credential.reference}:${credential.kind}`)
      .sort(),
    exportedWorkerCredentialRefs: exported.data.workerCredentials
      .map((credential) => `${credential.workspaceId}:${credential.reference}:${credential.kind}`)
      .sort(),
    budgetReservationStatuses: stored.workerBudgetReservations
      .map(
        (reservation) =>
          `${reservation.kind}:${reservation.status}:${reservation.settledAmount ?? reservation.releaseReason ?? "held"}`,
      )
      .sort(),
    exportedBudgetReservationCount: exported.data.workerBudgetReservations.length,
    controlRecordStatuses: [
      ...stored.workerAttentionRequests.map((record) => `attention:${record.status}`),
      ...stored.workerApprovalGrants.map((record) => `approval:${record.status}`),
      ...stored.workerControlCommands.map((record) => `command:${record.status}`),
      ...stored.workerNotificationDeliveries.map((record) => `notification:${record.status}`),
    ].sort(),
    exportedControlRecordCounts: [
      exported.data.workerAttentionRequests.length,
      exported.data.workerApprovalGrants.length,
      exported.data.workerControlCommands.length,
      exported.data.workerNotificationDeliveries.length,
    ],
    exportedEvidenceCount: exported.data.workerEvidenceEntries.length,
    exportedArtifactManifestCount: exported.data.workerArtifactManifests.length,
    retentionEventCount: stored.workerEvents.filter((event) =>
      event.type.startsWith("worker.retention."),
    ).length,
    rollupProjection: parityRollupProjection(rollupProjection),
    operationsReadModel,
    packetProductCredentialCount: stored.packetProductCredentials.length,
    workerPackageReceiptProjection: stored.workerPackageReceipts
      .map(
        (receipt) =>
          `${receipt.packageId}:${receipt.packageVersion}:${receipt.integrity.digestVerified}:${receipt.capabilityDecision.compiledPolicy.policyDigest}`,
      )
      .sort(),
    workerPackageDeploymentProjection: stored.workerPackageDeployments
      .map(
        (binding) =>
          `${binding.packageId}:${binding.packageVersion}:${binding.operation}:${binding.workerDefinitionId}:${binding.workerVersionId}:${binding.workerDeploymentId}`,
      )
      .sort(),
    exportedPacketProductCredentialCount: exported.data.packetProductCredentials.length,
    exportedWorkerPackageReceiptCount: exported.data.workerPackageReceipts.length,
    exportedWorkerPackageDeploymentCount: exported.data.workerPackageDeployments.length,
  };
}

async function runPacketProductTrustPersistence(): Promise<string> {
  const trust = createPacketProductTrustService();
  const issued = await trust.issueCredential({
    workspaceId: "alpha",
    subjectId: "packetade:backend-parity",
    allowedOperations: ["package.validate", "package.deploy"],
    createdBy: ACTOR,
  });
  const workerPackage = JSON.parse(
    readFileSync(
      resolve(
        process.cwd(),
        "src",
        "workers",
        "package",
        "fixtures",
        "worker-package-v1.valid.json",
      ),
      "utf8",
    ),
  ) as WorkerPackage;
  const deploymentService = createPacketProductDeploymentService({ trust });
  await deploymentService.deployPackage({
    authorization: `Bearer ${issued.token}`,
    workspaceId: "alpha",
    idempotencyKey: "packetade-backend-parity-deploy",
    workerPackage,
    acceptedCapabilityIds: ["release-read"],
  });
  return issued.token;
}

function parityRollupProjection(rollups: WorkerObservabilityRollupSet) {
  return {
    schemaVersion: rollups.schemaVersion,
    workspaceId: rollups.workspaceId,
    computedThroughSequence: rollups.computedThroughSequence,
    versions: rollups.versions.map(stableRollupFields),
    deployments: rollups.deployments.map(stableRollupFields),
    runs: rollups.runs.map(stableRollupFields),
  };
}

async function parityOperationsProjection(data: PacketAgentData) {
  const readModel = createWorkerOperationsReadModel({
    loadStore: () => data,
  });
  const health = await readModel.health("alpha");
  const runPage = await readModel.listRuns("alpha", { limit: 200 });
  const details = await Promise.all(
    runPage.runs.map((run) => readModel.getRun("alpha", run.id, 200)),
  );
  return {
    health,
    page: runPage.page,
    runs: runPage.runs.map((run) => ({
      id: run.id,
      definition: run.definition,
      version: run.version,
      deployment: run.deployment,
      status: run.status,
      revision: run.revision,
      attempt: run.attempt,
      trigger: run.trigger,
      terminalReason: run.terminalReason,
      budget: run.budget,
      latestCheckpoint: run.latestCheckpoint,
      attention: run.attention,
      rollup: stableRollupFields(run.rollup),
      controls: run.controls,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    })),
    details: details.map((detail) => ({
      runId: detail.run.id,
      attention: detail.attention.map((entry) => ({
        id: entry.id,
        status: entry.status,
        capabilityId: entry.capabilityId,
        operationDigest: entry.operationDigest,
      })),
      events: detail.events.items.map((entry) => ({
        id: entry.id,
        sequence: entry.sequence,
        type: entry.type,
        summary: entry.summary,
      })),
      evidence: detail.evidence.items.map((entry) => ({
        id: entry.id,
        sequence: entry.sequence,
        classification: entry.classification,
        hasSha256Digest: /^sha256:[0-9a-f]{64}$/.test(entry.evidenceDigest),
      })),
      artifacts: detail.artifacts.items.map((entry) => ({
        id: entry.id,
        classification: entry.classification,
        artifact: entry.artifact,
        manifestDigest: entry.manifestDigest,
      })),
    })),
  };
}

function stableRollupFields(rollup: WorkerObservabilityRollup) {
  return {
    identity: rollup.identity,
    computedThroughSequence: rollup.computedThroughSequence,
    events: rollup.events,
    evidenceEntries: rollup.evidenceEntries,
    legacyEvents: rollup.legacyEvents,
    providers: rollup.providers,
    tools: rollup.tools,
    effects: rollup.effects,
    retries: rollup.retries,
    queue: {
      jobs: rollup.queue.jobs,
      startedSamples: rollup.queue.startedSamples,
      pendingSamples: rollup.queue.pendingSamples,
      totalDurationMs: rollup.queue.totalDurationMs,
      averageDurationMs: rollup.queue.averageDurationMs,
      maximumDurationMs: rollup.queue.maximumDurationMs,
    },
    approvals: rollup.approvals,
    checkpoints: {
      count: rollup.checkpoints.count,
      latestSequence: rollup.checkpoints.latestSequence,
    },
    budget: rollup.budget,
    artifacts: rollup.artifacts,
    outcomes: rollup.outcomes,
    sourceGaps: rollup.sourceGaps,
  };
}

function reverseRollupSources(data: PacketAgentData): void {
  data.workerVersions.reverse();
  data.workerDeployments.reverse();
  data.workerRuns.reverse();
  data.workerEvents.reverse();
  data.workerEvidenceEntries.reverse();
  data.jobs.reverse();
  data.providerCalls.reverse();
  data.workerEffectReceipts.reverse();
  data.workerBudgetReservations.reverse();
  data.workerAttentionRequests.reverse();
  data.workerApprovalGrants.reverse();
  data.workerCheckpoints.reverse();
  data.workerArtifactManifests.reverse();
  data.activities.reverse();
}

function deploymentStatusCounts(data: PacketAgentData): string[] {
  const counts = new Map<string, number>();
  for (const deployment of data.workerDeployments) {
    const key = `${deployment.workerDefinitionId}:${deployment.status}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, count]) => `${key}:${count}`).sort();
}

async function runActivationRace(service: WorkerLifecycleService): Promise<void> {
  const created = await service.createDefinition({
    ...command("race-create"),
    definitionId: "worker-race",
    versionId: "worker-race-v1",
    name: "Activation race",
    description: "Proves that only one deployment becomes active.",
    content: makeWorkerVersionContent(),
    source: SOURCE,
  });
  const version1 = await service.validateVersion({
    ...command("race-v1-validate"),
    workerVersionId: created.version!.id,
    expectedContentDigest: created.version!.contentDigest,
  });
  const version2Draft = await service.createVersion({
    ...command("race-v2-create"),
    workerDefinitionId: created.definition!.id,
    versionId: "worker-race-v2",
    content: makeWorkerVersionContent({
      objective: "Exercise the second activation candidate.",
    }),
    source: SOURCE,
  });
  const version2 = await service.validateVersion({
    ...command("race-v2-validate"),
    workerVersionId: version2Draft.version!.id,
    expectedContentDigest: version2Draft.version!.contentDigest,
  });
  const deployment1 = await createDeployableDeployment(
    service,
    "race-v1",
    "worker-race-deployment-v1",
    version1.version!.id,
  );
  const deployment2 = await createDeployableDeployment(
    service,
    "race-v2",
    "worker-race-deployment-v2",
    version2.version!.id,
  );

  const attempts = await Promise.allSettled([
    service.activate({
      ...command("race-v2-activate"),
      workerDeploymentId: deployment2.id,
      expectedRevision: deployment2.revision,
    }),
    service.activate({
      ...command("race-v1-activate"),
      workerDeploymentId: deployment1.id,
      expectedRevision: deployment1.revision,
    }),
  ]);
  const fulfilled = attempts.filter((result) => result.status === "fulfilled");
  const rejected = attempts.filter((result) => result.status === "rejected");

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(
    rejected.every(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof WorkerLifecycleError &&
        result.reason.code === "conflict",
    ),
    true,
  );
}

async function runActivationAdmissionRace(): Promise<void> {
  const data = await loadStoreAsync();
  const deployment = data.workerDeployments.find(
    (record) => record.workerDefinitionId === "worker-race" && record.status === "active",
  );
  assert.ok(deployment);
  const services = ["process-a", "process-b"].map((processId) => {
    let nextId = 0;
    return createWorkerActivationService({
      now: () => new Date("2026-07-27T15:00:00.000Z"),
      id: (kind) => `${kind}-${processId}-${++nextId}`,
    });
  });
  const input = {
    workspaceId: "alpha",
    workerDeploymentId: deployment.id,
    triggerId: "manual",
    source: "manual" as const,
    deliveryId: "parity-delivery-1",
    occurredAt: "2026-07-27T14:59:00.000Z",
    actor: ACTOR,
    payload: { release_id: "release-parity" },
  };
  const results = await Promise.all([services[0].admit(input), services[1].admit(input)]);
  assert.deepEqual(results.map((result) => result.disposition).sort(), ["accepted", "duplicate"]);
  assert.equal(results[0].runId, results[1].runId);
}

async function runActivationQueueFailureRollback(): Promise<void> {
  const before = await loadStoreAsync();
  const deployment = before.workerDeployments.find(
    (record) => record.workerDefinitionId === "worker-race" && record.status === "active",
  );
  assert.ok(deployment);
  const service = createWorkerActivationService({
    now: () => new Date("2026-07-27T15:05:00.000Z"),
    id: (kind) => `${kind}-rollback`,
    onCommitPhase: (phase) => {
      if (phase === "after_event_append") {
        throw new Error("injected execution queue failure");
      }
    },
  });
  await assert.rejects(
    service.admit({
      workspaceId: "alpha",
      workerDeploymentId: deployment.id,
      triggerId: "manual",
      source: "manual",
      deliveryId: "parity-queue-failure",
      actor: ACTOR,
      payload: { release_id: "release-rollback" },
    }),
    /injected execution queue failure/,
  );
  clearStoreCacheForTests();
  const after = await loadStoreAsync();
  assert.equal(
    after.workerActivationInboxes.some((record) => record.deliveryId === "parity-queue-failure"),
    false,
  );
  assert.equal(after.workerActivationInboxes.length, before.workerActivationInboxes.length);
  assert.equal(after.workerRuns.length, before.workerRuns.length);
  assert.equal(after.jobs.length, before.jobs.length);
  assert.equal(after.workerEvents.length, before.workerEvents.length);
}

async function runRuntimePersistence(): Promise<void> {
  let data = await loadStoreAsync();
  const admittedRun = data.workerRuns.find((record) => record.status === "queued");
  assert.ok(admittedRun);
  const admittedVersion = data.workerVersions.find(
    (record) =>
      record.workspaceId === admittedRun.workspaceId && record.id === admittedRun.workerVersionId,
  );
  assert.ok(admittedVersion);
  const admittedDeployment = data.workerDeployments.find(
    (record) =>
      record.workspaceId === admittedRun.workspaceId &&
      record.id === admittedRun.workerDeploymentId,
  );
  assert.ok(admittedDeployment?.compiledPolicy);
  const admittedPolicy = admittedDeployment.compiledPolicy;
  const controlAt = new Date("2026-07-27T15:00:30.000Z");
  let nextControlId = 0;
  const controls = createWorkerControlService({
    now: () => controlAt,
    id: (kind) => `${kind}-parity-control-${++nextControlId}`,
    nonce: () => "parity-approval-nonce",
  });
  const paused = await controls.pauseRun({
    workspaceId: admittedRun.workspaceId,
    workerRunId: admittedRun.id,
    actor: ACTOR,
    idempotencyKey: "parity-pause",
    expectedRevision: admittedRun.revision,
  });
  assert.equal(paused.run?.status, "paused");
  const controlBinding = {
    workspaceId: admittedRun.workspaceId,
    workerDefinitionId: admittedRun.workerDefinitionId,
    workerDeploymentId: admittedRun.workerDeploymentId,
    workerRunId: admittedRun.id,
    workerVersionId: admittedRun.workerVersionId,
    workerVersionContentDigest: admittedVersion.contentDigest,
  };
  const notificationRoute = admittedVersion.content.notificationRoutes[0];
  assert.ok(notificationRoute);
  await mutateStoreAsync((store) => {
    store.workerAttentionRequests.push(
      makeWorkerAttentionRequest({
        ...controlBinding,
        id: "attention-parity",
        requestKey: "parity:iteration-1:action-approval",
        policyDigest: admittedPolicy.policyDigest,
        notificationRouteIds: [notificationRoute.id],
        requestedAt: "2026-07-27T15:00:10.000Z",
        escalatesAt: "2026-07-27T15:30:00.000Z",
        expiresAt: "2026-07-27T16:00:00.000Z",
      }),
    );
  });
  const approved = await controls.approveOnce({
    workspaceId: admittedRun.workspaceId,
    attentionRequestId: "attention-parity",
    actor: ACTOR,
    idempotencyKey: "parity-approve",
    expectedRevision: paused.run!.revision,
    expiresAt: "2026-07-27T15:45:00.000Z",
  });
  assert.equal(approved.approvalGrant?.scope, "once");
  const resumed = await controls.resumeRun({
    workspaceId: admittedRun.workspaceId,
    workerRunId: admittedRun.id,
    actor: ACTOR,
    idempotencyKey: "parity-resume",
    expectedRevision: paused.run!.revision,
  });
  assert.equal(resumed.run?.status, "queued");
  data = await loadStoreAsync();
  const run = data.workerRuns.find((record) => record.id === admittedRun.id);
  assert.ok(run);
  const acquiredAt = new Date("2026-07-27T15:01:00.000Z");
  let nextRuntimeId = 0;
  const repository = createWorkerRuntimeRepository({
    now: () => acquiredAt,
    id: (kind) => `${kind}-parity-${++nextRuntimeId}`,
    leaseDurationMs: 1_000,
  });
  const acquisition = await repository.acquire({
    workspaceId: run.workspaceId,
    workerRunId: run.id,
    ownerId: "parity-supervisor",
    now: acquiredAt,
  });
  assert.equal(acquisition.disposition, "acquired");
  if (acquisition.disposition !== "acquired") return;
  await mutateStoreAsync((store) => {
    store.workerNotificationDeliveries.push(
      makeWorkerNotificationDelivery({
        ...controlBinding,
        id: "notification-parity",
        deliveryKey: "attention-parity:local-attention:requested",
        attentionRequestId: "attention-parity",
        notificationRouteId: notificationRoute.id,
        notificationRouteKind: notificationRoute.kind,
        notificationRouteReference: notificationRoute.reference,
        scheduledAt: controlAt.toISOString(),
        createdAt: controlAt.toISOString(),
        updatedAt: controlAt.toISOString(),
      }),
    );
  });
  const effects = createWorkerEffectRepository({
    now: () => acquiredAt,
    id: (kind) => `${kind}-parity-${++nextRuntimeId}`,
  });
  const budgets = createWorkerRollingBudgetService();
  const rollingPolicy = resolveWorkerRollingBudgetPolicy(
    acquisition.context.version.content.policy.budgets,
  );
  const settledBudget = await budgets.reserve({
    workspaceId: run.workspaceId,
    workerDeploymentId: run.workerDeploymentId,
    workerRunId: run.id,
    workerVersionId: run.workerVersionId,
    fencingToken: acquisition.lease.fencingToken,
    reservationKey: "parity-billable-action",
    kind: "billable_action",
    amount: 1,
    policy: rollingPolicy,
    now: acquiredAt,
  });
  assert.equal(settledBudget.allowed, true);
  if (!settledBudget.allowed) return;
  await budgets.settle({
    workspaceId: run.workspaceId,
    workerRunId: run.id,
    fencingToken: acquisition.lease.fencingToken,
    reservationId: settledBudget.reservation.id,
    actualAmount: 1,
    now: acquiredAt,
  });
  const abandonedBudget = await budgets.reserve({
    workspaceId: run.workspaceId,
    workerDeploymentId: run.workerDeploymentId,
    workerRunId: run.id,
    workerVersionId: run.workerVersionId,
    fencingToken: acquisition.lease.fencingToken,
    reservationKey: "parity-abandoned-provider",
    kind: "provider_cost_usd",
    amount: 0.5,
    policy: rollingPolicy,
    now: acquiredAt,
  });
  assert.equal(abandonedBudget.allowed, true);
  const prepared = await effects.prepare({
    workspaceId: run.workspaceId,
    workerRunId: run.id,
    workerVersionId: run.workerVersionId,
    workerDeploymentId: run.workerDeploymentId,
    fencingToken: acquisition.lease.fencingToken,
    iteration: 1,
    actionId: "parity-action-1",
    capabilityId: "release-read",
    toolName: "http_fetch",
    operation: "http.put",
    inputDigest: `sha256:${"a".repeat(64)}`,
    effectKey: `sha256:${"b".repeat(64)}`,
    classification: "idempotent_mutation",
  });
  const completedEffect = await effects.complete({
    workspaceId: run.workspaceId,
    workerRunId: run.id,
    fencingToken: acquisition.lease.fencingToken,
    effectKey: prepared.receipt.effectKey,
    result: {
      callId: "parity-action-1",
      toolName: "http_fetch",
      status: "ok",
      output: { status: 200 },
      durationMs: 1,
      startedAt: acquiredAt.toISOString(),
      completedAt: acquiredAt.toISOString(),
    },
  });
  await mutateStoreAsync((store) => {
    const sourceEvidence = store.workerEvidenceEntries.find((entry) =>
      entry.sourceReferences.some(
        (reference) => reference.kind === "effect_receipt" && reference.id === completedEffect.id,
      ),
    );
    assert.ok(sourceEvidence);
    const unsigned = {
      schemaVersion: WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION,
      id: "artifact-manifest-parity",
      workspaceId: run.workspaceId,
      workerDefinitionId: run.workerDefinitionId,
      workerVersionId: run.workerVersionId,
      workerDeploymentId: run.workerDeploymentId,
      workerRunId: run.id,
      artifact: {
        reference: "artifact:parity-release-report",
        name: "release-report.json",
        mediaType: "application/json",
        byteLength: 128,
        contentDigest: `sha256:${"c".repeat(64)}`,
      },
      classification: "internal" as const,
      provenance: {
        producerKind: "worker_tool" as const,
        producerId: "parity-action-1",
        sourceEvidenceIds: [sourceEvidence.id],
        materials: [],
      },
      createdAt: acquiredAt.toISOString(),
    };
    const manifest: WorkerArtifactManifest = {
      ...unsigned,
      manifestDigest: computeWorkerArtifactManifestDigest(unsigned),
    };
    store.workerArtifactManifests.push(manifest);
  });
  const checkpoint = await repository.save({
    workspaceId: run.workspaceId,
    workerRunId: run.id,
    workerVersionId: run.workerVersionId,
    expectedRunRevision: acquisition.context.run.revision,
    expectedCheckpointSequence: -1,
    fencingToken: acquisition.lease.fencingToken,
    cursor: {
      phase: "plan",
      iteration: 1,
      actionIndex: 0,
    },
    budgetUsage: {
      elapsedMs: 10,
      iterations: 1,
      providerCostUsd: 0.01,
      consecutiveFailures: 0,
      toolCalls: 0,
    },
    workingMemory: {
      schemaVersion: WORKER_MEMORY_SCHEMA_VERSION,
      iterationOpen: false,
      pendingTools: [],
      toolResults: [],
      candidateOutputPresent: false,
    },
    completedActionIds: ["parity-action-1"],
    pendingApprovalIds: [],
    artifactRefs: [],
    effectReceiptIds: [completedEffect.id],
  });
  await mutateStoreAsync((store) => {
    const job = store.jobs.find(
      (record) => record.type === "worker.run" && record.payload.workerRunId === run.id,
    );
    assert.ok(job);
    job.status = "running";
    job.attempts = 1;
    job.startedAt = acquiredAt.toISOString();
    job.updatedAt = acquiredAt.toISOString();
  });
  const recoveryAt = new Date("2026-07-27T15:01:02.000Z");
  const recovery = createWorkerRecoveryCoordinator({
    now: () => recoveryAt,
    id: (kind) => `${kind}-parity-${++nextRuntimeId}`,
  });
  const recovered = await recovery.recoverExpired();
  assert.deepEqual(recovered.requeuedRunIds, [run.id]);
  const reacquired = await repository.acquire({
    workspaceId: run.workspaceId,
    workerRunId: run.id,
    ownerId: "parity-supervisor-restarted",
    now: recoveryAt,
  });
  assert.equal(reacquired.disposition, "acquired");
  if (reacquired.disposition !== "acquired") return;
  assert.equal(reacquired.context.checkpoint?.id, checkpoint.checkpointId);
  const terminal = await repository.finalize({
    context: reacquired.context,
    finalization: {
      expectedRunRevision: reacquired.context.run.revision,
      fencingToken: reacquired.lease.fencingToken,
      status: "completed",
      terminalReason: "objective_satisfied",
      budgetUsage: {
        elapsedMs: 12,
        iterations: 1,
        providerCostUsd: 0.01,
        consecutiveFailures: 0,
        toolCalls: 0,
      },
      output: "ready",
    },
    now: new Date("2026-07-27T15:01:01.000Z"),
  });
  assert.equal(terminal.revision, reacquired.context.run.revision + 1);
  assert.equal(terminal.runtimeLease, undefined);

  const retentionPolicy: WorkerRetentionPolicy = {
    schemaVersion: WORKER_RETENTION_POLICY_SCHEMA_VERSION,
    metadataDays: 1,
    summaryDays: 1,
    promptDays: 1,
    toolPayloadDays: 1,
    artifactDays: 1,
  };
  let retentionId = 0;
  const retention = createWorkerRetentionService({
    now: () => new Date("2026-08-27T15:01:02.000Z"),
    id: () => `event-parity-retention-${++retentionId}`,
    artifactPort: {
      async delete() {
        return "deleted";
      },
    },
  });
  const retained = await retention.cleanup({
    workspaceId: run.workspaceId,
    policy: retentionPolicy,
    maxItems: 500,
    maxDurationMs: 60_000,
  });
  assert.ok(retained.deleted > 0);
  const compacted = await loadStoreAsync();
  assert.equal(
    compacted.workerEffectReceipts.find((receipt) => receipt.id === completedEffect.id)?.result
      ?.kind,
    "retention_tombstone",
  );
  assert.equal(
    compacted.workerCheckpoints.some((record) => record.workerRunId === run.id),
    false,
  );
}

async function runRollback(service: WorkerLifecycleService): Promise<void> {
  const created = await service.createDefinition({
    ...command("rollback-create"),
    definitionId: "worker-rollback",
    versionId: "worker-rollback-v1",
    name: "Rollback Worker",
    description: "Proves immutable rollback deployment replacement.",
    content: makeWorkerVersionContent(),
    source: SOURCE,
  });
  const version1 = await service.validateVersion({
    ...command("rollback-v1-validate"),
    workerVersionId: created.version!.id,
    expectedContentDigest: created.version!.contentDigest,
  });
  const deployment1 = await createDeployableDeployment(
    service,
    "rollback-v1",
    "worker-rollback-deployment-v1",
    version1.version!.id,
  );
  const active1 = await service.activate({
    ...command("rollback-v1-activate"),
    workerDeploymentId: deployment1.id,
    expectedRevision: deployment1.revision,
  });
  await service.retireDeployment({
    ...command("rollback-v1-retire"),
    workerDeploymentId: active1.deployment!.id,
    expectedRevision: active1.deployment!.revision,
  });

  const version2Draft = await service.createVersion({
    ...command("rollback-v2-create"),
    workerDefinitionId: created.definition!.id,
    versionId: "worker-rollback-v2",
    content: makeWorkerVersionContent({
      objective: "Exercise rollback from version two.",
    }),
    source: SOURCE,
  });
  const version2 = await service.validateVersion({
    ...command("rollback-v2-validate"),
    workerVersionId: version2Draft.version!.id,
    expectedContentDigest: version2Draft.version!.contentDigest,
  });
  const deployment2 = await createDeployableDeployment(
    service,
    "rollback-v2",
    "worker-rollback-deployment-v2",
    version2.version!.id,
  );
  const active2 = await service.activate({
    ...command("rollback-v2-activate"),
    workerDeploymentId: deployment2.id,
    expectedRevision: deployment2.revision,
  });
  const rolledBack = await service.rollback({
    ...command("rollback-execute"),
    workerDeploymentId: active2.deployment!.id,
    targetWorkerVersionId: version1.version!.id,
    replacementDeploymentId: "worker-rollback-deployment-replacement",
    expectedRevision: active2.deployment!.revision,
  });

  assert.equal(rolledBack.previousDeployment?.status, "retired");
  assert.equal(rolledBack.deployment?.status, "active");
  assert.equal(rolledBack.deployment?.workerVersionId, version1.version?.id);
}

async function createDeployableDeployment(
  service: WorkerLifecycleService,
  keyPrefix: string,
  deploymentId: string,
  workerVersionId: string,
): Promise<{ id: string; revision: number }> {
  const draft = await service.createDeployment({
    ...command(`${keyPrefix}-deployment-create`),
    deploymentId,
    workerVersionId,
  });
  const validated = await service.validateDeployment({
    ...command(`${keyPrefix}-deployment-validate`),
    workerDeploymentId: draft.deployment!.id,
    expectedRevision: draft.deployment!.revision,
  });
  const deployed = await service.deploy({
    ...command(`${keyPrefix}-deployment-deploy`),
    workerDeploymentId: validated.deployment!.id,
    expectedRevision: validated.deployment!.revision,
  });
  return {
    id: deployed.deployment!.id,
    revision: deployed.deployment!.revision,
  };
}

function command(idempotencyKey: string): WorkerCommandContext {
  return {
    workspaceId: "alpha",
    actor: ACTOR,
    idempotencyKey,
  };
}

async function withJsonStore<T>(run: () => Promise<T>): Promise<T> {
  const dataFile = resolve(process.cwd(), "data", "packetagent.json");
  const existed = existsSync(dataFile);
  const previousContents = existed ? readFileSync(dataFile) : null;
  return withStoreEnvironment(
    { PACKETAGENT_STORE: "json" },
    async () => {
      resetStoreForTests();
      return await run();
    },
    () => {
      if (previousContents) writeFileSync(dataFile, previousContents);
      else if (!existed) rmSync(dataFile, { force: true });
    },
  );
}

async function withSqliteStore<T>(run: () => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "packetagent-worker-sqlite-"));
  const dbPath = join(directory, "packetagent.sqlite");
  return withStoreEnvironment(
    {
      PACKETAGENT_STORE: "sqlite",
      PACKETAGENT_DB_PATH: dbPath,
    },
    async () => {
      resetStoreForTests();
      const result = await run();
      const data = await loadStoreAsync();
      assert.equal(data.workerDefinitions.length, 3);
      return result;
    },
    () => rmSync(directory, { recursive: true, force: true }),
  );
}

async function withManagedPostgresStore<T>(run: () => Promise<T>): Promise<T> {
  const database = new FakeManagedPostgresDatabase(createSeedStore());
  const restoreFactory = setManagedPostgresStoreClientFactoryForTests(
    (_config: ManagedPostgresStoreClientConfig) => database.connect(),
  );
  try {
    return await withStoreEnvironment(
      {
        PACKETAGENT_STORE: "postgres",
        PACKETAGENT_DATABASE_URL: "postgres://packetagent:secret@worker-parity.example/packetagent",
      },
      run,
    );
  } finally {
    restoreFactory();
  }
}

async function withStoreEnvironment<T>(
  values: Partial<Record<(typeof STORE_ENV_KEYS)[number], string>>,
  run: () => Promise<T>,
  cleanup?: () => void,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of STORE_ENV_KEYS) previous.set(key, process.env[key]);
  try {
    for (const key of STORE_ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) process.env[key] = value;
    }
    clearStoreCacheForTests();
    return await run();
  } finally {
    clearStoreCacheForTests();
    cleanup?.();
    for (const key of STORE_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

class FakeManagedPostgresDatabase {
  private payloadJson: string;
  private lockTail: Promise<void> = Promise.resolve();

  constructor(seed: PacketAgentData) {
    this.payloadJson = JSON.stringify(seed);
  }

  connect(): ManagedPostgresStoreQueryClient {
    return new FakeManagedPostgresConnection(this);
  }

  read(): string {
    return this.payloadJson;
  }

  write(value: string): void {
    this.payloadJson = value;
  }

  async acquire(): Promise<() => void> {
    const predecessor = this.lockTail;
    let release!: () => void;
    this.lockTail = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    await predecessor;
    return release;
  }
}

class FakeManagedPostgresConnection implements ManagedPostgresStoreQueryClient {
  private releaseLock: (() => void) | null = null;

  constructor(private readonly database: FakeManagedPostgresDatabase) {}

  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<ManagedPostgresStoreQueryResult<TRow>> {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (normalized.startsWith("select pg_advisory_xact_lock")) {
      this.releaseLock = await this.database.acquire();
      return { rows: [] };
    }
    if (normalized.startsWith("select payload from packetagent_document_store")) {
      return {
        rows: [{ payload: this.database.read() } as unknown as TRow],
      };
    }
    if (normalized.startsWith("insert into packetagent_document_store")) {
      this.database.write(String(params[3]));
      return { rows: [] };
    }
    if (normalized === "commit" || normalized === "rollback") {
      this.releaseLock?.();
      this.releaseLock = null;
    }
    return { rows: [] };
  }

  close(): void {
    this.releaseLock?.();
    this.releaseLock = null;
  }
}
