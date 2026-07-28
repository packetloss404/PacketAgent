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
import { makeWorkerVersionContent } from "./fixtures.js";
import { createWorkerActivationService } from "../activation.js";
import { createWorkerRuntimeRepository } from "../runtime/repository.js";
import { createWorkerEffectRepository } from "../effects.js";
import { createWorkerRecoveryCoordinator } from "../runtime/recovery.js";
import { WORKER_MEMORY_SCHEMA_VERSION } from "../runtime/checkpoint.js";

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
  readonly exportedDefinitionIds: readonly string[];
  readonly exportedDeploymentIds: readonly string[];
  readonly activationInboxCount: number;
  readonly activationDuplicateCounts: readonly number[];
  readonly workerRunJobCount: number;
  readonly terminalRunStatuses: readonly string[];
  readonly checkpointCount: number;
  readonly effectReceiptStatuses: readonly string[];
  readonly compiledPolicyDigests: readonly string[];
  readonly capabilityGrantCounts: readonly string[];
  readonly runRevisions: readonly number[];
}

async function runBackendScenario(): Promise<BackendScenarioResult> {
  const service = createWorkerLifecycleService();
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
  assert.equal(
    exported.data.workerEffectReceipts.length,
    stored.workerEffectReceipts.length,
  );
  assert.equal(
    exported.data.workerActivationInboxes.length,
    stored.workerActivationInboxes.length,
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
    compiledPolicyDigests: stored.workerDeployments
      .map((deployment) => `${deployment.id}:${deployment.compiledPolicy!.policyDigest}`)
      .sort(),
    capabilityGrantCounts: stored.workerDeployments
      .map((deployment) => `${deployment.id}:${deployment.capabilityGrants!.length}`)
      .sort(),
    runRevisions: stored.workerRuns.map((run) => run.revision).sort((a, b) => a - b),
  };
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
    (record) =>
      record.workerDefinitionId === "worker-race" && record.status === "active",
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
  const results = await Promise.all([
    services[0].admit(input),
    services[1].admit(input),
  ]);
  assert.deepEqual(
    results.map((result) => result.disposition).sort(),
    ["accepted", "duplicate"],
  );
  assert.equal(results[0].runId, results[1].runId);
}

async function runActivationQueueFailureRollback(): Promise<void> {
  const before = await loadStoreAsync();
  const deployment = before.workerDeployments.find(
    (record) =>
      record.workerDefinitionId === "worker-race" && record.status === "active",
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
    after.workerActivationInboxes.some(
      (record) => record.deliveryId === "parity-queue-failure",
    ),
    false,
  );
  assert.equal(after.workerActivationInboxes.length, before.workerActivationInboxes.length);
  assert.equal(after.workerRuns.length, before.workerRuns.length);
  assert.equal(after.jobs.length, before.jobs.length);
  assert.equal(after.workerEvents.length, before.workerEvents.length);
}

async function runRuntimePersistence(): Promise<void> {
  const data = await loadStoreAsync();
  const run = data.workerRuns.find((record) => record.status === "queued");
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
  const effects = createWorkerEffectRepository({
    now: () => acquiredAt,
    id: (kind) => `${kind}-parity-${++nextRuntimeId}`,
  });
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
      (record) =>
        record.type === "worker.run" &&
        record.payload.workerRunId === run.id,
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
  assert.equal(terminal.revision, 6);
  assert.equal(terminal.runtimeLease, undefined);
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
      assert.equal(data.workerDefinitions.length, 2);
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
