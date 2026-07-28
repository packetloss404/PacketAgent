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
}

async function runBackendScenario(): Promise<BackendScenarioResult> {
  const service = createWorkerLifecycleService();
  await runActivationRace(service);
  await runRollback(service);
  await runActivationAdmissionRace();
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
  assert.equal(exported.data.workerCommandReceipts.length, stored.workerCommandReceipts.length);
  assert.equal(exported.data.workerEvents.length, stored.workerEvents.length);
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
