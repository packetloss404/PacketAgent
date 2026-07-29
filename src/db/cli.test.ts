import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { backfillActivationSignals, backfillActivities, backfillAgentRuns, backfillAlertEvents, backfillAppDatabase, backfillInvitationEmailDeliveries, backfillJobMetricSnapshots, backfillJobs, backfillManagedPostgres, backfillProviderCalls, backupDatabase, compareManagedPostgresStores, loadManagedPostgresSource, managedPostgresStoreStats, migrateDatabase, migrationStatus, readAppData, resetAppDatabase, resetDatabase, restoreDatabase, seedAppDatabase, seedDatabase, verifyActivationSignals, verifyActivities, verifyAgentRuns, verifyAlertEvents, verifyInvitationEmailDeliveries, verifyJobMetricSnapshots, verifyJobs, verifyManagedPostgres, verifyProviderCalls, type ManagedPostgresDocumentStoreDeps } from "./cli";
import type { ActivationSignalRecord, ActivityRecord, AgentRunRecord, AlertEventRecord, InvitationEmailDeliveryRecord, JobMetricSnapshotRecord, JobRecord, ProviderCallRecord, PacketAgentData } from "../packetagent-store";
import { createSeedStore } from "../packetagent-store";
import { makeWorkerDefinition, makeWorkerVersion } from "../workers/__tests__/fixtures.js";

const expectedMigrations = readdirSync(resolve(process.cwd(), "src", "db", "migrations"))
  .filter((name) => name.endsWith(".sql"))
  .sort();

test("migrateDatabase applies activation migrations idempotently", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");

    const first = migrateDatabase({ dbPath });
    const second = migrateDatabase({ dbPath });

    assert.deepEqual(first.applied, expectedMigrations);
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.skipped, expectedMigrations);

    const db = new DatabaseSync(dbPath);
    try {
      const rows = db.prepare("select name from schema_migrations").all() as Array<{ name: string }>;
      assert.deepEqual(rows.map((row) => row.name), expectedMigrations);
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateDatabase creates runtime app tables", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");

    migrateDatabase({ dbPath });

    const expectedTables = [
      "users",
      "sessions",
      "workspaces",
      "workspace_memberships",
      "workspace_invitations",
      "workspace_briefs",
      "workspace_brief_versions",
      "requirements",
      "implementation_plan_items",
      "workflow_concerns",
      "validation_evidence",
      "release_confirmations",
      "onboarding_states",
      "activities",
      "agents",
      "providers",
      "agent_runs",
      "workspace_env_vars",
      "api_keys",
      "provider_calls",
      "jobs",
      "share_tokens",
      "rate_limit_buckets",
      "activation_signals",
      "activation_facts",
      "activation_read_models",
      "worker_definitions",
      "worker_versions",
      "worker_deployments",
      "worker_runs",
      "worker_checkpoints",
      "worker_effect_receipts",
      "worker_deployment_rollouts",
      "worker_command_receipts",
      "worker_events",
      "packet_product_credentials",
      "worker_package_receipts",
      "worker_package_deployments",
      "packet_product_event_acknowledgements",
    ];

    const db = new DatabaseSync(dbPath);
    try {
      const rows = db.prepare(`
        select name
        from sqlite_master
        where type = 'table' and name in (${expectedTables.map(() => "?").join(", ")})
        order by name
      `).all(...expectedTables) as Array<{ name: string }>;

      assert.deepEqual(rows.map((row) => row.name), [...expectedTables].sort());
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Worker migration enforces lifecycle identity and concurrency constraints", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    seedAppDatabase({ dbPath });
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("pragma foreign_keys = on");
      db.prepare(`
        insert into worker_definitions (
          workspace_id, id, status, name, current_version_id, updated_at, payload
        ) values (?, ?, ?, ?, ?, ?, json(?))
      `).run("alpha", "worker-db", "active", "Database Worker", null, "2026-07-27T12:00:00.000Z", "{}");
      db.prepare(`
        insert into worker_versions (
          workspace_id, id, worker_definition_id, version, status,
          content_digest, created_at, payload
        ) values (?, ?, ?, ?, ?, ?, ?, json(?))
      `).run("alpha", "worker-db-v1", "worker-db", 1, "validated", "sha256:test", "2026-07-27T12:00:00.000Z", "{}");
      db.prepare("update worker_definitions set current_version_id = ? where workspace_id = ? and id = ?")
        .run("worker-db-v1", "alpha", "worker-db");

      const insertDeployment = db.prepare(`
        insert into worker_deployments (
          workspace_id, id, worker_definition_id, worker_version_id,
          status, revision, updated_at, payload
        ) values (?, ?, ?, ?, ?, ?, ?, json(?))
      `);
      insertDeployment.run("alpha", "worker-db-deployment-1", "worker-db", "worker-db-v1", "active", 1, "2026-07-27T12:00:00.000Z", "{}");

      assert.throws(
        () => insertDeployment.run("alpha", "worker-db-deployment-2", "worker-db", "worker-db-v1", "active", 1, "2026-07-27T12:01:00.000Z", "{}"),
        /UNIQUE constraint failed/,
      );
      assert.throws(
        () => insertDeployment.run("alpha", "worker-db-invalid-revision", "worker-db", "worker-db-v1", "draft", 0, "2026-07-27T12:01:00.000Z", "{}"),
        /CHECK constraint failed/,
      );
      assert.throws(
        () => db.prepare(`
          insert into worker_versions (
            workspace_id, id, worker_definition_id, version, status,
            content_digest, created_at, payload
          ) values (?, ?, ?, ?, ?, ?, ?, json(?))
        `).run("alpha", "worker-db-v1-duplicate-number", "worker-db", 1, "validated", "sha256:other", "2026-07-27T12:02:00.000Z", "{}"),
        /UNIQUE constraint failed/,
      );

      const activeIndex = db.prepare("select name from sqlite_master where type = 'index' and name = ?")
        .get("idx_worker_deployments_one_active_definition") as { name: string } | undefined;
      assert.equal(activeIndex?.name, "idx_worker_deployments_one_active_definition");
      assert.deepEqual(db.prepare("pragma foreign_key_check").all(), []);
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("rate limit bucket migration backfills legacy app_records buckets", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    const legacyBucket = {
      id: "auth:login:sha256:legacy",
      count: 7,
      resetAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    };

    const db = new DatabaseSync(dbPath);
    try {
      db.exec("create table schema_migrations (name text primary key, applied_at text not null default (datetime('now'))) ");
      db.exec(`
        create table app_records (
          collection text not null,
          id text not null,
          workspace_id text null,
          payload text not null check (json_valid(payload)),
          updated_at text null,
          primary key (collection, id)
        )
      `);
      const insertMigration = db.prepare("insert into schema_migrations (name) values (?)");
      for (const name of expectedMigrations.filter((entry) => entry !== "0009_rate_limit_buckets.sql")) {
        insertMigration.run(name);
      }
      db.prepare("insert into app_records (collection, id, workspace_id, payload, updated_at) values ('rateLimits', ?, null, json(?), ?)")
        .run(legacyBucket.id, JSON.stringify(legacyBucket), legacyBucket.updatedAt);
    } finally {
      db.close();
    }

    const migrated = migrateDatabase({ dbPath });
    assert.deepEqual(migrated.applied, ["0009_rate_limit_buckets.sql"]);

    const migratedDb = new DatabaseSync(dbPath);
    try {
      const bucket = migratedDb.prepare("select id, count, reset_at as resetAt, updated_at as updatedAt from rate_limit_buckets where id = ?").get(legacyBucket.id) as typeof legacyBucket | undefined;
      const legacyRows = migratedDb.prepare("select count(*) as count from app_records where collection = 'rateLimits'").get() as { count: number };
      assert.deepEqual(bucket ? { ...bucket } : undefined, legacyBucket);
      assert.equal(legacyRows.count, 0);
    } finally {
      migratedDb.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrationStatus reports pending and applied migrations without creating a database", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "missing.sqlite");

    const missing = migrationStatus({ dbPath });
    assert.equal(missing.exists, false);
    assert.deepEqual(missing.pending, expectedMigrations);

    migrateDatabase({ dbPath });
    const migrated = migrationStatus({ dbPath });

    assert.equal(migrated.exists, true);
    assert.deepEqual(migrated.applied, expectedMigrations);
    assert.deepEqual(migrated.pending, []);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("migrateDatabase rejects an existing database with foreign-key violations", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });

    const db = new DatabaseSync(dbPath);
    try {
      db.exec("pragma foreign_keys = off");
      db.prepare(`
        insert into workspace_memberships (workspace_id, user_id, role, joined_at)
        values (?, ?, 'viewer', ?)
      `).run("missing-workspace", "missing-user", "2026-07-28T12:00:00.000Z");
    } finally {
      db.close();
    }

    assert.throws(
      () => migrateDatabase({ dbPath }),
      /migration validation failed SQLite foreign_key_check with 2 violation\(s\)/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backupDatabase copies a migrated database and restoreDatabase validates before replacing", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    const backupPath = join(tempDir, "packetagent.backup.sqlite");
    seedAppDatabase({ dbPath });

    const backup = backupDatabase({ dbPath, backupPath });
    resetDatabase({ dbPath });
    const empty = readAppData({ dbPath });

    assert.equal(backup.backupPath, backupPath);
    assert.equal(empty, null);

    const restore = restoreDatabase({ dbPath, backupPath });
    const restored = readAppData({ dbPath });

    assert.equal(restore.backupPath, backupPath);
    assert.deepEqual(migrationStatus({ dbPath }).pending, []);
    assert.equal(restored?.workspaces.length, 3);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("restoreDatabase rejects a foreign-key-corrupt backup without replacing the current database", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    const backupPath = join(tempDir, "packetagent.corrupt.sqlite");
    seedAppDatabase({ dbPath });
    backupDatabase({ dbPath, backupPath });

    const currentDb = new DatabaseSync(dbPath);
    try {
      currentDb.exec("create table current_restore_marker (value text not null)");
      currentDb.prepare("insert into current_restore_marker (value) values (?)").run(
        "preserve-me",
      );
    } finally {
      currentDb.close();
    }

    const corruptBackup = new DatabaseSync(backupPath);
    try {
      corruptBackup.exec("pragma foreign_keys = off");
      corruptBackup.prepare(`
        insert into workspace_memberships (workspace_id, user_id, role, joined_at)
        values (?, ?, 'viewer', ?)
      `).run("missing-workspace", "missing-user", "2026-07-28T12:00:00.000Z");
    } finally {
      corruptBackup.close();
    }

    assert.throws(
      () => restoreDatabase({ dbPath, backupPath }),
      /migration validation failed SQLite foreign_key_check with 2 violation\(s\)/,
    );
    const preservedDb = new DatabaseSync(dbPath);
    try {
      const marker = preservedDb.prepare("select value from current_restore_marker").get() as {
        value: string;
      };
      assert.equal(marker.value, "preserve-me");
    } finally {
      preservedDb.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("seedAppDatabase writes the full seed store and activation rows", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");

    const result = seedAppDatabase({ dbPath });
    const data = readAppData({ dbPath });

    assert.equal(result.workspaces, 3);
    assert.equal(data?.workspaces.length, 3);
    assert.equal(data?.users.length, 3);
    assert.equal(data?.agents.some((agent) => agent.id === "agent_alpha_support"), true);
    assert.ok((data?.activationSignals.length ?? 0) > 0);

    const db = new DatabaseSync(dbPath);
    try {
      const trackCount = db.prepare("select count(*) as count from activation_tracks").get() as { count: number };
      const signalRows = db.prepare("select count(*) as count from activation_signals").get() as { count: number };
      const appRecordSignalRows = db.prepare("select count(*) as count from app_records where collection = 'activationSignals'").get() as { count: number };
      assert.equal(trackCount.count, 3);
      assert.equal(signalRows.count, data?.activationSignals.length ?? 0);
      assert.equal(appRecordSignalRows.count, 0);
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backfillAppDatabase reads a JSON store path into SQLite", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    const jsonPath = join(tempDir, "packetagent.json");
    const data = createSeedStore();
    data.workspaces[0] = { ...data.workspaces[0], name: "Backfilled Workspace" };
    data.rateLimits = [{
      id: "auth:login:sha256:backfill",
      count: 3,
      resetAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-04-02T00:00:00.000Z",
    }];
    data.activationSignals = [
      makeActivationSignal({
        id: "signal_backfill_cli",
        workspaceId: "alpha",
        stableKey: "alpha:signal:backfill-cli",
        data: { source: "backfill" },
      }),
    ];
    data.workerDefinitions = [
      makeWorkerDefinition({
        workspaceId: "alpha",
        id: "worker-backfill",
      }),
    ];
    data.workerVersions = [
      makeWorkerVersion({
        workspaceId: "alpha",
        id: "worker-backfill-v1",
        workerDefinitionId: "worker-backfill",
      }),
    ];
    writeFileSync(jsonPath, JSON.stringify(data));

    const result = backfillAppDatabase({ dbPath, jsonPath });
    const stored = readAppData({ dbPath });

    assert.equal(result.source, "backfill");
    assert.equal(stored?.workspaces[0]?.name, "Backfilled Workspace");
    assert.equal(stored?.rateLimits?.[0]?.id, "auth:login:sha256:backfill");
    assert.deepEqual(stored?.activationSignals.map((entry) => entry.id), ["signal_backfill_cli"]);
    assert.deepEqual(stored?.workerDefinitions.map((entry) => entry.id), ["worker-backfill"]);
    assert.deepEqual(stored?.workerVersions.map((entry) => entry.id), ["worker-backfill-v1"]);

    const db = new DatabaseSync(dbPath);
    try {
      const bucketRows = db.prepare("select count(*) as count from rate_limit_buckets").get() as { count: number };
      const rateLimitAppRecordRows = db.prepare("select count(*) as count from app_records where collection = 'rateLimits'").get() as { count: number };
      const signalRows = db.prepare("select count(*) as count from activation_signals where id = 'signal_backfill_cli'").get() as { count: number };
      const signalAppRecordRows = db.prepare("select count(*) as count from app_records where collection = 'activationSignals'").get() as { count: number };
      const workerDefinitionRows = db.prepare("select count(*) as count from worker_definitions where id = 'worker-backfill'").get() as { count: number };
      const workerVersionRows = db.prepare("select count(*) as count from worker_versions where id = 'worker-backfill-v1'").get() as { count: number };
      assert.equal(bucketRows.count, 1);
      assert.equal(rateLimitAppRecordRows.count, 0);
      assert.equal(signalRows.count, 1);
      assert.equal(signalAppRecordRows.count, 0);
      assert.equal(workerDefinitionRows.count, 1);
      assert.equal(workerVersionRows.count, 1);
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function managedPostgresDeps(target: PacketAgentData): ManagedPostgresDocumentStoreDeps {
  return {
    async loadTargetStore() {
      return structuredClone(target);
    },
    async mutateTargetStore(mutator) {
      return mutator(target);
    },
  };
}

test("loadManagedPostgresSource falls back to the default seed when JSON is missing", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const result = loadManagedPostgresSource({ jsonPath: join(tempDir, "missing.json") });

    assert.equal(result.source, "seed");
    assert.equal(result.data.workspaces.some((workspace) => workspace.id === "alpha"), true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("managed Postgres store comparison is order-insensitive and reports drift", () => {
  const source = createSeedStore();
  const target = structuredClone(source);
  target.users = [...target.users].reverse();
  target.workspaces[0] = { ...target.workspaces[0], name: "Drifted Workspace" };
  target.shareTokens.push({
    id: "share_extra",
    workspaceId: "alpha",
    token: "extra",
    scope: "overview",
    createdByUserId: "user_alpha",
    readCount: 0,
    createdAt: "2026-04-29T12:00:00.000Z",
    expiresAt: "2026-05-29T12:00:00.000Z",
  });

  const stats = managedPostgresStoreStats(source);
  const comparison = compareManagedPostgresStores(source, target);

  assert.ok(stats.records > 0);
  assert.equal(comparison.contentDrift, 1);
  assert.equal(comparison.targetOnly, 1);
  assert.equal(comparison.sourceOnly, 0);
});

test("backfillManagedPostgres dry-run reports differences without mutating the async target", async () => {
  const source = createSeedStore();
  const target = createSeedStore();
  target.workspaces = [];

  const result = await backfillManagedPostgres(
    { dryRun: true, source: "json", jsonPath: "ignored.json" },
    {
      ...managedPostgresDeps(target),
      loadJsonSource: () => source,
    },
  );

  assert.equal(result.dryRun, true);
  assert.equal(result.source, "json");
  assert.equal(result.writtenRecords, 0);
  assert.ok(result.wouldWriteRecords > 0);
  assert.equal(target.workspaces.length, 0);
});

test("backfillManagedPostgres defaults to the managed async store boundary", async () => {
  const envKeys = ["PACKETAGENT_STORE", "DATABASE_URL", "PACKETAGENT_DATABASE_URL", "PACKETAGENT_MANAGED_DATABASE_URL"] as const;
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  try {
    for (const key of envKeys) delete process.env[key];

    await assert.rejects(
      backfillManagedPostgres({ dryRun: true, source: "seed" }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.name, /Managed.*(?:Postgres|Database)/);
        return true;
      },
    );
    assert.equal(process.env.PACKETAGENT_STORE, undefined);
  } finally {
    for (const key of envKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("backfillManagedPostgres writes JSON source data through the async target boundary", async () => {
  const source = createSeedStore();
  source.workspaces[0] = { ...source.workspaces[0], name: "Managed Backfill Workspace" };
  const target = createSeedStore();
  target.shareTokens.push({
    id: "share_target_only",
    workspaceId: "alpha",
    token: "target-only",
    scope: "overview",
    createdByUserId: "user_alpha",
    readCount: 0,
    createdAt: "2026-07-28T12:00:00.000Z",
    expiresAt: "2026-08-28T12:00:00.000Z",
  });

  const result = await backfillManagedPostgres(
    { source: "json", jsonPath: "ignored.json" },
    {
      ...managedPostgresDeps(target),
      loadJsonSource: () => source,
    },
  );

  assert.equal(result.writtenRecords, result.sourceRecords);
  assert.equal(target.workspaces[0]?.name, "Managed Backfill Workspace");
  assert.equal(result.targetCountsAfter?.workspaces, source.workspaces.length);
  assert.equal(target.shareTokens.some((token) => token.id === "share_target_only"), true);
  assert.equal(result.targetCountsAfter?.shareTokens, source.shareTokens.length + 1);
});

test("backfillManagedPostgres does not rewrite a target that only has additional records", async () => {
  const source = createSeedStore();
  const target = structuredClone(source);
  target.shareTokens.push({
    id: "share_target_only",
    workspaceId: "alpha",
    token: "target-only",
    scope: "overview",
    createdByUserId: "user_alpha",
    readCount: 0,
    createdAt: "2026-07-28T12:00:00.000Z",
    expiresAt: "2026-08-28T12:00:00.000Z",
  });
  let mutations = 0;

  const result = await backfillManagedPostgres(
    { source: "json", jsonPath: "ignored.json" },
    {
      ...managedPostgresDeps(target),
      loadJsonSource: () => source,
      async mutateTargetStore(mutator) {
        mutations += 1;
        return mutator(target);
      },
    },
  );

  assert.equal(result.targetOnly, 1);
  assert.equal(result.wouldWriteRecords, 0);
  assert.equal(result.writtenRecords, 0);
  assert.equal(mutations, 0);
});

test("verifyManagedPostgres compares a SQLite hydrated source with the async target", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    const source = createSeedStore();
    seedAppDatabase({ dbPath }, source);
    const target = structuredClone(source);

    const result = await verifyManagedPostgres(
      { dbPath, source: "sqlite" },
      managedPostgresDeps(target),
    );

    assert.equal(result.source, "sqlite");
    assert.equal(result.sourcePath, dbPath);
    assert.equal(result.sourceOnly, 0);
    assert.equal(result.targetOnly, 0);
    assert.equal(result.contentDrift, 0);
    assert.equal(result.matched, result.sourceRecords);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resetAppDatabase recreates migrated DB state with seed app data", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    const jsonPath = join(tempDir, "packetagent.json");
    writeFileSync(jsonPath, JSON.stringify({ workspaces: [{ id: "json-only" }] }));
    seedAppDatabase({ dbPath });

    const result = resetAppDatabase({ dbPath, jsonPath });
    const stored = readAppData({ dbPath });
    const jsonContents = JSON.parse(readFileSync(jsonPath, "utf8")) as { workspaces: Array<{ id: string }> };

    assert.equal(result.command, "reset-app");
    assert.equal(stored?.workspaces.some((workspace) => workspace.id === "alpha"), true);
    assert.deepEqual(jsonContents.workspaces, [{ id: "json-only" }]);

    const db = new DatabaseSync(dbPath);
    try {
      const signalRows = db.prepare("select count(*) as count from activation_signals").get() as { count: number };
      const appRecordSignalRows = db.prepare("select count(*) as count from app_records where collection = 'activationSignals'").get() as { count: number };
      assert.equal(signalRows.count, stored?.activationSignals.length ?? 0);
      assert.equal(appRecordSignalRows.count, 0);
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("seedDatabase writes activation rows derived from the local seed store", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");

    const result = seedDatabase({ dbPath });

    assert.equal(result.workspaces, 3);
    assert.equal(result.tracks, 3);
    assert.ok(result.milestones > 0);
    assert.equal(result.checklistItems, 15);

    const db = new DatabaseSync(dbPath);
    try {
      const track = db.prepare("select current_stage from activation_tracks where workspace_id = ?").get("gamma") as { current_stage: string };
      const checklistCount = db.prepare("select count(*) as count from activation_checklist_items").get() as { count: number };
      assert.equal(track.current_stage, "complete");
      assert.equal(checklistCount.count, 15);
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resetDatabase recreates an empty migrated database", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    seedDatabase({ dbPath });

    const result = resetDatabase({ dbPath });

    assert.equal(result.path, dbPath);

    const db = new DatabaseSync(dbPath);
    try {
      const trackCount = db.prepare("select count(*) as count from activation_tracks").get() as { count: number };
      assert.equal(trackCount.count, 0);
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function makeJobMetricSnapshot(overrides: Partial<JobMetricSnapshotRecord> & { id: string }): JobMetricSnapshotRecord {
  return {
    id: overrides.id,
    capturedAt: overrides.capturedAt ?? "2026-04-26T12:00:00.000Z",
    type: overrides.type ?? "scheduler.tick",
    totalRuns: overrides.totalRuns ?? 0,
    succeededRuns: overrides.succeededRuns ?? 0,
    failedRuns: overrides.failedRuns ?? 0,
    canceledRuns: overrides.canceledRuns ?? 0,
    lastRunStartedAt: overrides.lastRunStartedAt ?? null,
    lastRunFinishedAt: overrides.lastRunFinishedAt ?? null,
    lastDurationMs: overrides.lastDurationMs ?? null,
    averageDurationMs: overrides.averageDurationMs ?? null,
    p95DurationMs: overrides.p95DurationMs ?? null,
  };
}

function insertAppRecordSnapshot(dbPath: string, record: JobMetricSnapshotRecord): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      insert into app_records (collection, id, workspace_id, payload, updated_at)
      values ('jobMetricSnapshots', ?, null, json(?), ?)
      on conflict(collection, id) do update set payload = excluded.payload, updated_at = excluded.updated_at
    `).run(record.id, JSON.stringify(record), record.capturedAt);
  } finally {
    db.close();
  }
}

function insertDedicatedSnapshot(dbPath: string, record: JobMetricSnapshotRecord): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      insert or replace into job_metric_snapshots (
        id, captured_at, type, total_runs, succeeded_runs, failed_runs, canceled_runs,
        last_run_started_at, last_run_finished_at, last_duration_ms, average_duration_ms, p95_duration_ms
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.capturedAt,
      record.type,
      record.totalRuns,
      record.succeededRuns,
      record.failedRuns,
      record.canceledRuns,
      record.lastRunStartedAt,
      record.lastRunFinishedAt,
      record.lastDurationMs,
      record.averageDurationMs,
      record.p95DurationMs,
    );
  } finally {
    db.close();
  }
}

function countDedicatedSnapshots(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("select count(*) as count from job_metric_snapshots").get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

test("backfillJobMetricSnapshots reports zero for an empty store", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });

    const result = backfillJobMetricSnapshots({ dbPath });

    assert.equal(result.scanned, 0);
    assert.equal(result.wouldInsert, 0);
    assert.equal(result.alreadyPresent, 0);
    assert.equal(result.drift, 0);
    assert.equal(result.inserted, 0);
    assert.equal(countDedicatedSnapshots(dbPath), 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backfillJobMetricSnapshots inserts JSON-side rows into the dedicated table", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertAppRecordSnapshot(dbPath, makeJobMetricSnapshot({ id: "snap_a", totalRuns: 5 }));

    const result = backfillJobMetricSnapshots({ dbPath });

    assert.equal(result.scanned, 1);
    assert.equal(result.wouldInsert, 1);
    assert.equal(result.alreadyPresent, 0);
    assert.equal(result.inserted, 1);
    assert.equal(countDedicatedSnapshots(dbPath), 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backfillJobMetricSnapshots is idempotent on re-run", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertAppRecordSnapshot(dbPath, makeJobMetricSnapshot({ id: "snap_a", totalRuns: 5 }));

    backfillJobMetricSnapshots({ dbPath });
    const second = backfillJobMetricSnapshots({ dbPath });

    assert.equal(second.scanned, 1);
    assert.equal(second.wouldInsert, 0);
    assert.equal(second.alreadyPresent, 1);
    assert.equal(second.drift, 0);
    assert.equal(second.inserted, 0);
    assert.equal(countDedicatedSnapshots(dbPath), 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backfillJobMetricSnapshots --dry-run does not write", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertAppRecordSnapshot(dbPath, makeJobMetricSnapshot({ id: "snap_a" }));
    insertAppRecordSnapshot(dbPath, makeJobMetricSnapshot({ id: "snap_b" }));

    const result = backfillJobMetricSnapshots({ dbPath, dryRun: true });

    assert.equal(result.dryRun, true);
    assert.equal(result.scanned, 2);
    assert.equal(result.wouldInsert, 2);
    assert.equal(result.inserted, 0);
    assert.equal(countDedicatedSnapshots(dbPath), 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backfillJobMetricSnapshots reports drift when content differs", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    const jsonRecord = makeJobMetricSnapshot({ id: "snap_a", totalRuns: 5 });
    insertAppRecordSnapshot(dbPath, jsonRecord);
    insertDedicatedSnapshot(dbPath, { ...jsonRecord, totalRuns: 99 });

    const result = backfillJobMetricSnapshots({ dbPath, dryRun: true });

    assert.equal(result.scanned, 1);
    assert.equal(result.wouldInsert, 0);
    assert.equal(result.alreadyPresent, 0);
    assert.equal(result.drift, 1);
    assert.equal(result.inserted, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyJobMetricSnapshots reports matched when both sides identical", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    const record = makeJobMetricSnapshot({ id: "snap_a", totalRuns: 7 });
    insertAppRecordSnapshot(dbPath, record);
    insertDedicatedSnapshot(dbPath, record);

    const result = verifyJobMetricSnapshots({ dbPath });

    assert.equal(result.matched, 1);
    assert.equal(result.jsonOnly, 0);
    assert.equal(result.sqliteOnly, 0);
    assert.equal(result.contentDrift, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyJobMetricSnapshots reports jsonOnly when JSON-side has rows not yet backfilled", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertAppRecordSnapshot(dbPath, makeJobMetricSnapshot({ id: "snap_a" }));
    insertAppRecordSnapshot(dbPath, makeJobMetricSnapshot({ id: "snap_b" }));

    const result = verifyJobMetricSnapshots({ dbPath });

    assert.equal(result.jsonOnly, 2);
    assert.equal(result.sqliteOnly, 0);
    assert.equal(result.matched, 0);
    assert.equal(result.contentDrift, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyJobMetricSnapshots reports sqliteOnly when dedicated table has extra rows", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertDedicatedSnapshot(dbPath, makeJobMetricSnapshot({ id: "extra" }));

    const result = verifyJobMetricSnapshots({ dbPath });

    assert.equal(result.sqliteOnly, 1);
    assert.equal(result.jsonOnly, 0);
    assert.equal(result.matched, 0);
    assert.equal(result.contentDrift, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyJobMetricSnapshots reports contentDrift when ids match but content differs", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    const record = makeJobMetricSnapshot({ id: "snap_a", totalRuns: 5 });
    insertAppRecordSnapshot(dbPath, record);
    insertDedicatedSnapshot(dbPath, { ...record, totalRuns: 99 });

    const result = verifyJobMetricSnapshots({ dbPath });

    assert.equal(result.contentDrift, 1);
    assert.equal(result.matched, 0);
    assert.equal(result.jsonOnly, 0);
    assert.equal(result.sqliteOnly, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function makeAlertRecord(overrides: Partial<AlertEventRecord> & { id: string }): AlertEventRecord {
  const record: AlertEventRecord = {
    id: overrides.id,
    ruleId: overrides.ruleId ?? "subsystem-degraded",
    severity: overrides.severity ?? "warning",
    title: overrides.title ?? "Title",
    detail: overrides.detail ?? "Detail",
    observedAt: overrides.observedAt ?? "2026-04-26T12:00:00.000Z",
    context: overrides.context ?? {},
    delivered: overrides.delivered ?? true,
    deliveryAttempts: overrides.deliveryAttempts ?? 1,
    lastDeliveryAttemptAt: overrides.lastDeliveryAttemptAt ?? "2026-04-26T12:00:00.000Z",
    deadLettered: overrides.deadLettered ?? false,
  };
  if (overrides.deliveryError !== undefined) record.deliveryError = overrides.deliveryError;
  return record;
}

function insertAppRecordAlert(dbPath: string, record: AlertEventRecord): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      insert into app_records (collection, id, workspace_id, payload, updated_at)
      values ('alertEvents', ?, null, json(?), ?)
      on conflict(collection, id) do update set payload = excluded.payload, updated_at = excluded.updated_at
    `).run(record.id, JSON.stringify(record), record.observedAt);
  } finally {
    db.close();
  }
}

function insertDedicatedAlert(dbPath: string, record: AlertEventRecord): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      insert or replace into alert_events (
        id, rule_id, severity, title, detail, observed_at, context,
        delivered, delivery_error, delivery_attempts, last_delivery_attempt_at, dead_lettered
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.ruleId,
      record.severity,
      record.title,
      record.detail,
      record.observedAt,
      JSON.stringify(record.context ?? {}),
      record.delivered ? 1 : 0,
      record.deliveryError ?? null,
      record.deliveryAttempts ?? null,
      record.lastDeliveryAttemptAt ?? null,
      record.deadLettered === undefined ? null : record.deadLettered ? 1 : 0,
    );
  } finally {
    db.close();
  }
}

function countDedicatedAlerts(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("select count(*) as count from alert_events").get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

test("backfillAlertEvents reports zero for an empty store", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });

    const result = backfillAlertEvents({ dbPath });

    assert.equal(result.scanned, 0);
    assert.equal(result.wouldInsert, 0);
    assert.equal(result.alreadyPresent, 0);
    assert.equal(result.drift, 0);
    assert.equal(result.inserted, 0);
    assert.equal(countDedicatedAlerts(dbPath), 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backfillAlertEvents inserts JSON-side rows into the dedicated table", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertAppRecordAlert(dbPath, makeAlertRecord({ id: "alert_a" }));

    const result = backfillAlertEvents({ dbPath });

    assert.equal(result.scanned, 1);
    assert.equal(result.wouldInsert, 1);
    assert.equal(result.alreadyPresent, 0);
    assert.equal(result.inserted, 1);
    assert.equal(countDedicatedAlerts(dbPath), 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backfillAlertEvents is idempotent on re-run", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertAppRecordAlert(dbPath, makeAlertRecord({ id: "alert_a" }));

    backfillAlertEvents({ dbPath });
    const second = backfillAlertEvents({ dbPath });

    assert.equal(second.scanned, 1);
    assert.equal(second.wouldInsert, 0);
    assert.equal(second.alreadyPresent, 1);
    assert.equal(second.drift, 0);
    assert.equal(second.inserted, 0);
    assert.equal(countDedicatedAlerts(dbPath), 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backfillAlertEvents --dry-run does not write", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertAppRecordAlert(dbPath, makeAlertRecord({ id: "alert_a" }));
    insertAppRecordAlert(dbPath, makeAlertRecord({ id: "alert_b" }));

    const result = backfillAlertEvents({ dbPath, dryRun: true });

    assert.equal(result.dryRun, true);
    assert.equal(result.scanned, 2);
    assert.equal(result.wouldInsert, 2);
    assert.equal(result.inserted, 0);
    assert.equal(countDedicatedAlerts(dbPath), 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backfillAlertEvents reports drift when content differs", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    const jsonRecord = makeAlertRecord({ id: "alert_a", title: "json title" });
    insertAppRecordAlert(dbPath, jsonRecord);
    insertDedicatedAlert(dbPath, { ...jsonRecord, title: "drifted title" });

    const result = backfillAlertEvents({ dbPath, dryRun: true });

    assert.equal(result.scanned, 1);
    assert.equal(result.wouldInsert, 0);
    assert.equal(result.alreadyPresent, 0);
    assert.equal(result.drift, 1);
    assert.equal(result.inserted, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyAlertEvents reports matched when both sides identical", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    const record = makeAlertRecord({ id: "alert_a" });
    insertAppRecordAlert(dbPath, record);
    insertDedicatedAlert(dbPath, record);

    const result = verifyAlertEvents({ dbPath });

    assert.equal(result.matched, 1);
    assert.equal(result.jsonOnly, 0);
    assert.equal(result.sqliteOnly, 0);
    assert.equal(result.contentDrift, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyAlertEvents reports jsonOnly when JSON-side has rows not yet backfilled", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertAppRecordAlert(dbPath, makeAlertRecord({ id: "alert_a" }));
    insertAppRecordAlert(dbPath, makeAlertRecord({ id: "alert_b" }));

    const result = verifyAlertEvents({ dbPath });

    assert.equal(result.jsonOnly, 2);
    assert.equal(result.sqliteOnly, 0);
    assert.equal(result.matched, 0);
    assert.equal(result.contentDrift, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyAlertEvents reports sqliteOnly when dedicated table has extra rows", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertDedicatedAlert(dbPath, makeAlertRecord({ id: "extra" }));

    const result = verifyAlertEvents({ dbPath });

    assert.equal(result.sqliteOnly, 1);
    assert.equal(result.jsonOnly, 0);
    assert.equal(result.matched, 0);
    assert.equal(result.contentDrift, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyAlertEvents reports contentDrift when ids match but content differs", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    const record = makeAlertRecord({ id: "alert_a", title: "json title" });
    insertAppRecordAlert(dbPath, record);
    insertDedicatedAlert(dbPath, { ...record, title: "drifted title" });

    const result = verifyAlertEvents({ dbPath });

    assert.equal(result.contentDrift, 1);
    assert.equal(result.matched, 0);
    assert.equal(result.jsonOnly, 0);
    assert.equal(result.sqliteOnly, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function makeAgentRun(overrides: Partial<AgentRunRecord> & { id: string }): AgentRunRecord {
  return {
    id: overrides.id,
    workspaceId: overrides.workspaceId ?? "workspace_a",
    title: overrides.title ?? "Run title",
    status: overrides.status ?? "success",
    logs: overrides.logs ?? [],
    createdAt: overrides.createdAt ?? "2026-04-26T12:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-26T12:00:00.000Z",
    ...(overrides.agentId !== undefined ? { agentId: overrides.agentId } : {}),
    ...(overrides.triggerKind !== undefined ? { triggerKind: overrides.triggerKind } : {}),
    ...(overrides.transcript !== undefined ? { transcript: overrides.transcript } : {}),
    ...(overrides.startedAt !== undefined ? { startedAt: overrides.startedAt } : {}),
    ...(overrides.completedAt !== undefined ? { completedAt: overrides.completedAt } : {}),
    ...(overrides.inputs !== undefined ? { inputs: overrides.inputs } : {}),
    ...(overrides.output !== undefined ? { output: overrides.output } : {}),
    ...(overrides.error !== undefined ? { error: overrides.error } : {}),
    ...(overrides.toolCalls !== undefined ? { toolCalls: overrides.toolCalls } : {}),
    ...(overrides.modelUsed !== undefined ? { modelUsed: overrides.modelUsed } : {}),
    ...(overrides.costUsd !== undefined ? { costUsd: overrides.costUsd } : {}),
  };
}

function insertAppRecordAgentRun(dbPath: string, record: AgentRunRecord): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      insert into app_records (collection, id, workspace_id, payload, updated_at)
      values ('agentRuns', ?, ?, json(?), ?)
      on conflict(collection, id) do update set workspace_id = excluded.workspace_id, payload = excluded.payload, updated_at = excluded.updated_at
    `).run(record.id, record.workspaceId, JSON.stringify(record), record.updatedAt);
  } finally {
    db.close();
  }
}

function insertDedicatedAgentRun(dbPath: string, record: AgentRunRecord): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      insert or replace into agent_runs (
        id, workspace_id, agent_id, title, status, trigger_kind,
        started_at, completed_at, inputs, output, error,
        logs, tool_calls, transcript, model_used, cost_usd,
        created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.workspaceId,
      record.agentId ?? null,
      record.title,
      record.status,
      record.triggerKind ?? null,
      record.startedAt ?? null,
      record.completedAt ?? null,
      record.inputs === undefined ? null : JSON.stringify(record.inputs),
      record.output ?? null,
      record.error ?? null,
      JSON.stringify(record.logs ?? []),
      record.toolCalls === undefined ? null : JSON.stringify(record.toolCalls),
      record.transcript === undefined ? null : JSON.stringify(record.transcript),
      record.modelUsed ?? null,
      record.costUsd ?? null,
      record.createdAt,
      record.updatedAt,
    );
  } finally {
    db.close();
  }
}

function insertAppRecordAgent(dbPath: string, agentId: string, workspaceId: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    const payload = JSON.stringify({ id: agentId, workspaceId });
    db.prepare(`
      insert into app_records (collection, id, workspace_id, payload, updated_at)
      values ('agents', ?, ?, json(?), ?)
      on conflict(collection, id) do update set workspace_id = excluded.workspace_id, payload = excluded.payload, updated_at = excluded.updated_at
    `).run(agentId, workspaceId, payload, "2026-04-26T12:00:00.000Z");
  } finally {
    db.close();
  }
}

function countDedicatedAgentRuns(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("select count(*) as count from agent_runs").get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

test("backfillAgentRuns reports zero for an empty store", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });

    const result = backfillAgentRuns({ dbPath });

    assert.equal(result.scanned, 0);
    assert.equal(result.wouldInsert, 0);
    assert.equal(result.alreadyPresent, 0);
    assert.equal(result.drift, 0);
    assert.equal(result.inserted, 0);
    assert.equal(countDedicatedAgentRuns(dbPath), 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backfillAgentRuns inserts JSON-side rows into the dedicated table", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertAppRecordAgentRun(dbPath, makeAgentRun({ id: "run_a" }));

    const result = backfillAgentRuns({ dbPath });

    assert.equal(result.scanned, 1);
    assert.equal(result.wouldInsert, 1);
    assert.equal(result.alreadyPresent, 0);
    assert.equal(result.inserted, 1);
    assert.equal(countDedicatedAgentRuns(dbPath), 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backfillAgentRuns is idempotent on re-run", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertAppRecordAgentRun(dbPath, makeAgentRun({ id: "run_a" }));

    backfillAgentRuns({ dbPath });
    const second = backfillAgentRuns({ dbPath });

    assert.equal(second.scanned, 1);
    assert.equal(second.wouldInsert, 0);
    assert.equal(second.alreadyPresent, 1);
    assert.equal(second.drift, 0);
    assert.equal(second.inserted, 0);
    assert.equal(countDedicatedAgentRuns(dbPath), 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backfillAgentRuns --dry-run does not write", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertAppRecordAgentRun(dbPath, makeAgentRun({ id: "run_a" }));
    insertAppRecordAgentRun(dbPath, makeAgentRun({ id: "run_b" }));

    const result = backfillAgentRuns({ dbPath, dryRun: true });

    assert.equal(result.dryRun, true);
    assert.equal(result.scanned, 2);
    assert.equal(result.wouldInsert, 2);
    assert.equal(result.inserted, 0);
    assert.equal(countDedicatedAgentRuns(dbPath), 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyAgentRuns reports matched when both sides identical", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    const record = makeAgentRun({ id: "run_a" });
    insertAppRecordAgentRun(dbPath, record);
    insertDedicatedAgentRun(dbPath, record);

    const result = verifyAgentRuns({ dbPath });

    assert.equal(result.matched, 1);
    assert.equal(result.jsonOnly, 0);
    assert.equal(result.sqliteOnly, 0);
    assert.equal(result.contentDrift, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyAgentRuns reports jsonOnly when JSON-side has rows not yet backfilled", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertAppRecordAgentRun(dbPath, makeAgentRun({ id: "run_a" }));
    insertAppRecordAgentRun(dbPath, makeAgentRun({ id: "run_b" }));

    const result = verifyAgentRuns({ dbPath });

    assert.equal(result.jsonOnly, 2);
    assert.equal(result.sqliteOnly, 0);
    assert.equal(result.matched, 0);
    assert.equal(result.contentDrift, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyAgentRuns reports sqliteOnly when dedicated table has extra rows", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertDedicatedAgentRun(dbPath, makeAgentRun({ id: "extra" }));

    const result = verifyAgentRuns({ dbPath });

    assert.equal(result.sqliteOnly, 1);
    assert.equal(result.jsonOnly, 0);
    assert.equal(result.matched, 0);
    assert.equal(result.contentDrift, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyAgentRuns reports contentDrift when ids match but content differs", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    const record = makeAgentRun({ id: "run_a", status: "success" });
    insertAppRecordAgentRun(dbPath, record);
    insertDedicatedAgentRun(dbPath, { ...record, status: "failed" });

    const result = verifyAgentRuns({ dbPath });

    assert.equal(result.contentDrift, 1);
    assert.equal(result.matched, 0);
    assert.equal(result.jsonOnly, 0);
    assert.equal(result.sqliteOnly, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backfillAgentRuns --check-orphans counts runs whose agentId references a missing agent", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertAppRecordAgent(dbPath, "agent_present", "workspace_a");
    insertAppRecordAgentRun(dbPath, makeAgentRun({ id: "run_orphan", agentId: "agent_missing" }));
    insertAppRecordAgentRun(dbPath, makeAgentRun({ id: "run_attached", agentId: "agent_present" }));
    insertAppRecordAgentRun(dbPath, makeAgentRun({ id: "run_detached" }));

    const result = backfillAgentRuns({ dbPath, checkOrphans: true });

    assert.equal(result.orphanCount, 1);
    assert.equal(result.scanned, 3);
    assert.equal(result.inserted, 3);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyAgentRuns --check-orphans surfaces orphan count without blocking verification", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    const orphan = makeAgentRun({ id: "run_orphan", agentId: "agent_missing" });
    insertAppRecordAgentRun(dbPath, orphan);
    insertDedicatedAgentRun(dbPath, orphan);

    const result = verifyAgentRuns({ dbPath, checkOrphans: true });

    assert.equal(result.orphanCount, 1);
    assert.equal(result.matched, 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function makeJob(overrides: Partial<JobRecord> & { id: string }): JobRecord {
  const record: JobRecord = {
    id: overrides.id,
    workspaceId: overrides.workspaceId ?? "workspace_a",
    type: overrides.type ?? "agent.run",
    payload: overrides.payload ?? {},
    status: overrides.status ?? "queued",
    attempts: overrides.attempts ?? 0,
    maxAttempts: overrides.maxAttempts ?? 3,
    scheduledAt: overrides.scheduledAt ?? "2026-04-26T12:00:00.000Z",
    createdAt: overrides.createdAt ?? "2026-04-26T12:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-26T12:00:00.000Z",
  };
  if (overrides.startedAt !== undefined) record.startedAt = overrides.startedAt;
  if (overrides.completedAt !== undefined) record.completedAt = overrides.completedAt;
  if (overrides.cron !== undefined) record.cron = overrides.cron;
  if (overrides.result !== undefined) record.result = overrides.result;
  if (overrides.error !== undefined) record.error = overrides.error;
  if (overrides.cancelRequested !== undefined) record.cancelRequested = overrides.cancelRequested;
  return record;
}

function insertAppRecordJob(dbPath: string, record: JobRecord): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      insert into app_records (collection, id, workspace_id, payload, updated_at)
      values ('jobs', ?, ?, json(?), ?)
      on conflict(collection, id) do update set workspace_id = excluded.workspace_id, payload = excluded.payload, updated_at = excluded.updated_at
    `).run(record.id, record.workspaceId, JSON.stringify(record), record.updatedAt);
  } finally {
    db.close();
  }
}

function insertDedicatedJob(dbPath: string, record: JobRecord): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      insert or replace into jobs (
        id, workspace_id, type, payload, status, attempts, max_attempts,
        scheduled_at, started_at, completed_at, cron, result, error,
        cancel_requested, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.workspaceId,
      record.type,
      JSON.stringify(record.payload ?? {}),
      record.status,
      record.attempts,
      record.maxAttempts,
      record.scheduledAt,
      record.startedAt ?? null,
      record.completedAt ?? null,
      record.cron ?? null,
      record.result === undefined ? null : JSON.stringify(record.result),
      record.error ?? null,
      record.cancelRequested === undefined ? null : record.cancelRequested ? 1 : 0,
      record.createdAt,
      record.updatedAt,
    );
  } finally {
    db.close();
  }
}

function countDedicatedJobs(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("select count(*) as count from jobs").get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

test("backfillJobs reports zero for an empty store", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });

    const result = backfillJobs({ dbPath });

    assert.equal(result.scanned, 0);
    assert.equal(result.wouldInsert, 0);
    assert.equal(result.alreadyPresent, 0);
    assert.equal(result.drift, 0);
    assert.equal(result.inserted, 0);
    assert.equal(countDedicatedJobs(dbPath), 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backfillJobs inserts JSON-side rows into the dedicated jobs table", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertAppRecordJob(dbPath, makeJob({ id: "job_a" }));

    const result = backfillJobs({ dbPath });

    assert.equal(result.scanned, 1);
    assert.equal(result.wouldInsert, 1);
    assert.equal(result.alreadyPresent, 0);
    assert.equal(result.inserted, 1);
    assert.equal(countDedicatedJobs(dbPath), 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backfillJobs is idempotent on re-run", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertAppRecordJob(dbPath, makeJob({ id: "job_a" }));

    backfillJobs({ dbPath });
    const second = backfillJobs({ dbPath });

    assert.equal(second.scanned, 1);
    assert.equal(second.wouldInsert, 0);
    assert.equal(second.alreadyPresent, 1);
    assert.equal(second.drift, 0);
    assert.equal(second.inserted, 0);
    assert.equal(countDedicatedJobs(dbPath), 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backfillJobs --dry-run does not write", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertAppRecordJob(dbPath, makeJob({ id: "job_a" }));
    insertAppRecordJob(dbPath, makeJob({ id: "job_b" }));

    const result = backfillJobs({ dbPath, dryRun: true });

    assert.equal(result.dryRun, true);
    assert.equal(result.scanned, 2);
    assert.equal(result.wouldInsert, 2);
    assert.equal(result.inserted, 0);
    assert.equal(countDedicatedJobs(dbPath), 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backfillJobs reports drift when content differs", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    const jsonRecord = makeJob({ id: "job_a", status: "queued" });
    insertAppRecordJob(dbPath, jsonRecord);
    insertDedicatedJob(dbPath, { ...jsonRecord, status: "running" });

    const result = backfillJobs({ dbPath, dryRun: true });

    assert.equal(result.scanned, 1);
    assert.equal(result.wouldInsert, 0);
    assert.equal(result.alreadyPresent, 0);
    assert.equal(result.drift, 1);
    assert.equal(result.inserted, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyJobs reports matched when both sides identical", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    const record = makeJob({ id: "job_a" });
    insertAppRecordJob(dbPath, record);
    insertDedicatedJob(dbPath, record);

    const result = verifyJobs({ dbPath });

    assert.equal(result.matched, 1);
    assert.equal(result.jsonOnly, 0);
    assert.equal(result.sqliteOnly, 0);
    assert.equal(result.contentDrift, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyJobs reports jsonOnly when JSON-side has rows not yet backfilled", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertAppRecordJob(dbPath, makeJob({ id: "job_a" }));
    insertAppRecordJob(dbPath, makeJob({ id: "job_b" }));

    const result = verifyJobs({ dbPath });

    assert.equal(result.jsonOnly, 2);
    assert.equal(result.sqliteOnly, 0);
    assert.equal(result.matched, 0);
    assert.equal(result.contentDrift, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyJobs reports sqliteOnly when dedicated table has extra rows", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertDedicatedJob(dbPath, makeJob({ id: "extra" }));

    const result = verifyJobs({ dbPath });

    assert.equal(result.sqliteOnly, 1);
    assert.equal(result.jsonOnly, 0);
    assert.equal(result.matched, 0);
    assert.equal(result.contentDrift, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyJobs reports contentDrift when ids match but content differs", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    const record = makeJob({ id: "job_a", status: "queued" });
    insertAppRecordJob(dbPath, record);
    insertDedicatedJob(dbPath, { ...record, status: "running" });

    const result = verifyJobs({ dbPath });

    assert.equal(result.contentDrift, 1);
    assert.equal(result.matched, 0);
    assert.equal(result.jsonOnly, 0);
    assert.equal(result.sqliteOnly, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function makeInvitationEmailDelivery(
  overrides: Partial<InvitationEmailDeliveryRecord> & { id: string },
): InvitationEmailDeliveryRecord {
  const record: InvitationEmailDeliveryRecord = {
    id: overrides.id,
    workspaceId: overrides.workspaceId ?? "workspace_a",
    invitationId: overrides.invitationId ?? "inv_a",
    recipientEmail: overrides.recipientEmail ?? "user@example.com",
    subject: overrides.subject ?? "You're invited",
    status: overrides.status ?? "pending",
    provider: overrides.provider ?? "local",
    mode: overrides.mode ?? "dev",
    createdAt: overrides.createdAt ?? "2026-04-26T12:00:00.000Z",
  };
  if (overrides.sentAt !== undefined) record.sentAt = overrides.sentAt;
  if (overrides.error !== undefined) record.error = overrides.error;
  if (overrides.providerStatus !== undefined) record.providerStatus = overrides.providerStatus;
  if (overrides.providerDeliveryId !== undefined) record.providerDeliveryId = overrides.providerDeliveryId;
  if (overrides.providerStatusAt !== undefined) record.providerStatusAt = overrides.providerStatusAt;
  if (overrides.providerError !== undefined) record.providerError = overrides.providerError;
  return record;
}

function insertAppRecordInvitationEmailDelivery(
  dbPath: string,
  record: InvitationEmailDeliveryRecord,
): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      insert into app_records (collection, id, workspace_id, payload, updated_at)
      values ('invitationEmailDeliveries', ?, ?, json(?), ?)
      on conflict(collection, id) do update set workspace_id = excluded.workspace_id, payload = excluded.payload, updated_at = excluded.updated_at
    `).run(record.id, record.workspaceId, JSON.stringify(record), record.createdAt);
  } finally {
    db.close();
  }
}

function insertDedicatedInvitationEmailDelivery(
  dbPath: string,
  record: InvitationEmailDeliveryRecord,
): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      insert or replace into invitation_email_deliveries (
        id, workspace_id, invitation_id, recipient_email, subject,
        status, provider, mode, created_at, sent_at, error,
        provider_status, provider_delivery_id, provider_status_at, provider_error
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.workspaceId,
      record.invitationId,
      record.recipientEmail,
      record.subject,
      record.status,
      record.provider,
      record.mode,
      record.createdAt,
      record.sentAt ?? null,
      record.error ?? null,
      record.providerStatus ?? null,
      record.providerDeliveryId ?? null,
      record.providerStatusAt ?? null,
      record.providerError ?? null,
    );
  } finally {
    db.close();
  }
}

function countDedicatedInvitationEmailDeliveries(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("select count(*) as count from invitation_email_deliveries").get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

test("backfillInvitationEmailDeliveries reports zero for an empty store", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });

    const result = backfillInvitationEmailDeliveries({ dbPath });

    assert.equal(result.scanned, 0);
    assert.equal(result.wouldInsert, 0);
    assert.equal(result.alreadyPresent, 0);
    assert.equal(result.drift, 0);
    assert.equal(result.inserted, 0);
    assert.equal(countDedicatedInvitationEmailDeliveries(dbPath), 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backfillInvitationEmailDeliveries inserts JSON-side rows into the dedicated table", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertAppRecordInvitationEmailDelivery(dbPath, makeInvitationEmailDelivery({ id: "ied_a" }));

    const result = backfillInvitationEmailDeliveries({ dbPath });

    assert.equal(result.scanned, 1);
    assert.equal(result.wouldInsert, 1);
    assert.equal(result.alreadyPresent, 0);
    assert.equal(result.inserted, 1);
    assert.equal(countDedicatedInvitationEmailDeliveries(dbPath), 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backfillInvitationEmailDeliveries is idempotent on re-run", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertAppRecordInvitationEmailDelivery(dbPath, makeInvitationEmailDelivery({ id: "ied_a" }));

    backfillInvitationEmailDeliveries({ dbPath });
    const second = backfillInvitationEmailDeliveries({ dbPath });

    assert.equal(second.scanned, 1);
    assert.equal(second.wouldInsert, 0);
    assert.equal(second.alreadyPresent, 1);
    assert.equal(second.drift, 0);
    assert.equal(second.inserted, 0);
    assert.equal(countDedicatedInvitationEmailDeliveries(dbPath), 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backfillInvitationEmailDeliveries --dry-run does not write", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertAppRecordInvitationEmailDelivery(dbPath, makeInvitationEmailDelivery({ id: "ied_a" }));
    insertAppRecordInvitationEmailDelivery(dbPath, makeInvitationEmailDelivery({ id: "ied_b" }));

    const result = backfillInvitationEmailDeliveries({ dbPath, dryRun: true });

    assert.equal(result.dryRun, true);
    assert.equal(result.scanned, 2);
    assert.equal(result.wouldInsert, 2);
    assert.equal(result.inserted, 0);
    assert.equal(countDedicatedInvitationEmailDeliveries(dbPath), 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backfillInvitationEmailDeliveries reports drift when content differs", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    const jsonRecord = makeInvitationEmailDelivery({ id: "ied_a", status: "pending" });
    insertAppRecordInvitationEmailDelivery(dbPath, jsonRecord);
    insertDedicatedInvitationEmailDelivery(dbPath, { ...jsonRecord, status: "sent" });

    const result = backfillInvitationEmailDeliveries({ dbPath, dryRun: true });

    assert.equal(result.scanned, 1);
    assert.equal(result.wouldInsert, 0);
    assert.equal(result.alreadyPresent, 0);
    assert.equal(result.drift, 1);
    assert.equal(result.inserted, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyInvitationEmailDeliveries reports matched when both sides identical", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    const record = makeInvitationEmailDelivery({ id: "ied_a" });
    insertAppRecordInvitationEmailDelivery(dbPath, record);
    insertDedicatedInvitationEmailDelivery(dbPath, record);

    const result = verifyInvitationEmailDeliveries({ dbPath });

    assert.equal(result.matched, 1);
    assert.equal(result.jsonOnly, 0);
    assert.equal(result.sqliteOnly, 0);
    assert.equal(result.contentDrift, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyInvitationEmailDeliveries reports jsonOnly when JSON-side has rows not yet backfilled", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertAppRecordInvitationEmailDelivery(dbPath, makeInvitationEmailDelivery({ id: "ied_a" }));
    insertAppRecordInvitationEmailDelivery(dbPath, makeInvitationEmailDelivery({ id: "ied_b" }));

    const result = verifyInvitationEmailDeliveries({ dbPath });

    assert.equal(result.jsonOnly, 2);
    assert.equal(result.sqliteOnly, 0);
    assert.equal(result.matched, 0);
    assert.equal(result.contentDrift, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyInvitationEmailDeliveries reports sqliteOnly when dedicated table has extra rows", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertDedicatedInvitationEmailDelivery(dbPath, makeInvitationEmailDelivery({ id: "extra" }));

    const result = verifyInvitationEmailDeliveries({ dbPath });

    assert.equal(result.sqliteOnly, 1);
    assert.equal(result.jsonOnly, 0);
    assert.equal(result.matched, 0);
    assert.equal(result.contentDrift, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyInvitationEmailDeliveries reports contentDrift when ids match but content differs", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    const record = makeInvitationEmailDelivery({ id: "ied_a", status: "pending" });
    insertAppRecordInvitationEmailDelivery(dbPath, record);
    insertDedicatedInvitationEmailDelivery(dbPath, { ...record, status: "sent" });

    const result = verifyInvitationEmailDeliveries({ dbPath });

    assert.equal(result.contentDrift, 1);
    assert.equal(result.matched, 0);
    assert.equal(result.jsonOnly, 0);
    assert.equal(result.sqliteOnly, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function makeActivityRecord(overrides: Partial<ActivityRecord> & { id: string }): ActivityRecord {
  return {
    id: overrides.id,
    workspaceId: overrides.workspaceId ?? "workspace_a",
    scope: overrides.scope ?? "workspace",
    event: overrides.event ?? "workspace.updated",
    occurredAt: overrides.occurredAt ?? "2026-04-26T12:00:00.000Z",
    actor: overrides.actor ?? { type: "user", id: "user_a", displayName: "User A" },
    data: overrides.data ?? { title: "Workspace updated" },
  };
}

function insertAppRecordActivity(dbPath: string, record: ActivityRecord): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      insert into app_records (collection, id, workspace_id, payload, updated_at)
      values ('activities', ?, ?, json(?), ?)
      on conflict(collection, id) do update set workspace_id = excluded.workspace_id, payload = excluded.payload, updated_at = excluded.updated_at
    `).run(record.id, record.workspaceId, JSON.stringify(record), record.occurredAt);
  } finally {
    db.close();
  }
}

function insertDedicatedActivity(dbPath: string, record: ActivityRecord): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      insert or replace into activities (
        id, workspace_id, occurred_at, type, payload, user_id, related_subject
      ) values (?, ?, ?, ?, json(?), ?, ?)
    `).run(
      record.id,
      record.workspaceId,
      record.occurredAt,
      record.event,
      JSON.stringify(record),
      record.actor.type === "user" ? record.actor.id : null,
      null,
    );
  } finally {
    db.close();
  }
}

function countDedicatedActivities(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("select count(*) as count from activities").get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

test("backfillActivities reports zero for an empty store", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });

    const result = backfillActivities({ dbPath });

    assert.equal(result.scanned, 0);
    assert.equal(result.wouldInsert, 0);
    assert.equal(result.alreadyPresent, 0);
    assert.equal(result.drift, 0);
    assert.equal(result.inserted, 0);
    assert.equal(countDedicatedActivities(dbPath), 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backfillActivities inserts JSON-side rows into the dedicated table", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertAppRecordActivity(dbPath, makeActivityRecord({ id: "activity_a" }));

    const result = backfillActivities({ dbPath });

    assert.equal(result.scanned, 1);
    assert.equal(result.wouldInsert, 1);
    assert.equal(result.alreadyPresent, 0);
    assert.equal(result.inserted, 1);
    assert.equal(countDedicatedActivities(dbPath), 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backfillActivities is idempotent on re-run", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertAppRecordActivity(dbPath, makeActivityRecord({ id: "activity_a" }));

    backfillActivities({ dbPath });
    const second = backfillActivities({ dbPath });

    assert.equal(second.scanned, 1);
    assert.equal(second.wouldInsert, 0);
    assert.equal(second.alreadyPresent, 1);
    assert.equal(second.drift, 0);
    assert.equal(second.inserted, 0);
    assert.equal(countDedicatedActivities(dbPath), 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backfillActivities --dry-run does not write", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertAppRecordActivity(dbPath, makeActivityRecord({ id: "activity_a" }));
    insertAppRecordActivity(dbPath, makeActivityRecord({ id: "activity_b" }));

    const result = backfillActivities({ dbPath, dryRun: true });

    assert.equal(result.dryRun, true);
    assert.equal(result.scanned, 2);
    assert.equal(result.wouldInsert, 2);
    assert.equal(result.inserted, 0);
    assert.equal(countDedicatedActivities(dbPath), 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backfillActivities reports drift when content differs", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    const jsonRecord = makeActivityRecord({ id: "activity_a", event: "workspace.updated" });
    insertAppRecordActivity(dbPath, jsonRecord);
    insertDedicatedActivity(dbPath, { ...jsonRecord, event: "workspace.renamed" });

    const result = backfillActivities({ dbPath, dryRun: true });

    assert.equal(result.scanned, 1);
    assert.equal(result.wouldInsert, 0);
    assert.equal(result.alreadyPresent, 0);
    assert.equal(result.drift, 1);
    assert.equal(result.inserted, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyActivities reports matched when both sides identical", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    const record = makeActivityRecord({ id: "activity_a" });
    insertAppRecordActivity(dbPath, record);
    insertDedicatedActivity(dbPath, record);

    const result = verifyActivities({ dbPath });

    assert.equal(result.matched, 1);
    assert.equal(result.jsonOnly, 0);
    assert.equal(result.sqliteOnly, 0);
    assert.equal(result.contentDrift, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyActivities reports jsonOnly when JSON-side has rows not yet backfilled", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertAppRecordActivity(dbPath, makeActivityRecord({ id: "activity_a" }));
    insertAppRecordActivity(dbPath, makeActivityRecord({ id: "activity_b" }));

    const result = verifyActivities({ dbPath });

    assert.equal(result.jsonOnly, 2);
    assert.equal(result.sqliteOnly, 0);
    assert.equal(result.matched, 0);
    assert.equal(result.contentDrift, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyActivities reports sqliteOnly when dedicated table has extra rows", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertDedicatedActivity(dbPath, makeActivityRecord({ id: "extra" }));

    const result = verifyActivities({ dbPath });

    assert.equal(result.sqliteOnly, 1);
    assert.equal(result.jsonOnly, 0);
    assert.equal(result.matched, 0);
    assert.equal(result.contentDrift, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyActivities reports contentDrift when ids match but content differs", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    const record = makeActivityRecord({ id: "activity_a", data: { title: "Original title" } });
    insertAppRecordActivity(dbPath, record);
    insertDedicatedActivity(dbPath, { ...record, data: { title: "Changed title" } });

    const result = verifyActivities({ dbPath });

    assert.equal(result.contentDrift, 1);
    assert.equal(result.matched, 0);
    assert.equal(result.jsonOnly, 0);
    assert.equal(result.sqliteOnly, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function makeProviderCall(overrides: Partial<ProviderCallRecord> & { id: string }): ProviderCallRecord {
  const record: ProviderCallRecord = {
    id: overrides.id,
    workspaceId: overrides.workspaceId ?? "alpha",
    routeKey: overrides.routeKey ?? "agent.summary",
    provider: overrides.provider ?? "stub",
    model: overrides.model ?? "stub-small",
    promptTokens: overrides.promptTokens ?? 1,
    completionTokens: overrides.completionTokens ?? 2,
    costUsd: overrides.costUsd ?? 0,
    durationMs: overrides.durationMs ?? 10,
    status: overrides.status ?? "success",
    startedAt: overrides.startedAt ?? "2026-04-26T12:00:00.000Z",
    completedAt: overrides.completedAt ?? "2026-04-26T12:00:01.000Z",
  };
  if (overrides.errorMessage !== undefined) record.errorMessage = overrides.errorMessage;
  return record;
}

function prepareProviderCallDb(dbPath: string): void {
  seedDatabase({ dbPath });
}

function insertAppRecordProviderCall(dbPath: string, record: ProviderCallRecord): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      insert into app_records (collection, id, workspace_id, payload, updated_at)
      values ('providerCalls', ?, ?, json(?), ?)
      on conflict(collection, id) do update set workspace_id = excluded.workspace_id, payload = excluded.payload, updated_at = excluded.updated_at
    `).run(record.id, record.workspaceId, JSON.stringify(record), record.completedAt);
  } finally {
    db.close();
  }
}

function insertDedicatedProviderCall(dbPath: string, record: ProviderCallRecord): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      insert or replace into provider_calls (
        id, workspace_id, route_key, provider, model, prompt_tokens,
        completion_tokens, cost_usd, duration_ms, status, error_message,
        started_at, completed_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.workspaceId,
      record.routeKey,
      record.provider,
      record.model,
      record.promptTokens,
      record.completionTokens,
      record.costUsd,
      record.durationMs,
      record.status,
      record.errorMessage ?? null,
      record.startedAt,
      record.completedAt,
    );
  } finally {
    db.close();
  }
}

function countDedicatedProviderCalls(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("select count(*) as count from provider_calls").get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

test("backfillProviderCalls reports zero for an empty store", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    prepareProviderCallDb(dbPath);

    const result = backfillProviderCalls({ dbPath });

    assert.equal(result.scanned, 0);
    assert.equal(result.wouldInsert, 0);
    assert.equal(result.alreadyPresent, 0);
    assert.equal(result.drift, 0);
    assert.equal(result.inserted, 0);
    assert.equal(countDedicatedProviderCalls(dbPath), 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backfillProviderCalls inserts JSON-side rows into the dedicated table", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    prepareProviderCallDb(dbPath);
    insertAppRecordProviderCall(dbPath, makeProviderCall({ id: "provider_call_a" }));

    const result = backfillProviderCalls({ dbPath });

    assert.equal(result.scanned, 1);
    assert.equal(result.wouldInsert, 1);
    assert.equal(result.alreadyPresent, 0);
    assert.equal(result.inserted, 1);
    assert.equal(countDedicatedProviderCalls(dbPath), 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backfillProviderCalls is idempotent on re-run", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    prepareProviderCallDb(dbPath);
    insertAppRecordProviderCall(dbPath, makeProviderCall({ id: "provider_call_a" }));

    backfillProviderCalls({ dbPath });
    const second = backfillProviderCalls({ dbPath });

    assert.equal(second.scanned, 1);
    assert.equal(second.wouldInsert, 0);
    assert.equal(second.alreadyPresent, 1);
    assert.equal(second.drift, 0);
    assert.equal(second.inserted, 0);
    assert.equal(countDedicatedProviderCalls(dbPath), 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backfillProviderCalls --dry-run does not write", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    prepareProviderCallDb(dbPath);
    insertAppRecordProviderCall(dbPath, makeProviderCall({ id: "provider_call_a" }));
    insertAppRecordProviderCall(dbPath, makeProviderCall({ id: "provider_call_b" }));

    const result = backfillProviderCalls({ dbPath, dryRun: true });

    assert.equal(result.dryRun, true);
    assert.equal(result.scanned, 2);
    assert.equal(result.wouldInsert, 2);
    assert.equal(result.inserted, 0);
    assert.equal(countDedicatedProviderCalls(dbPath), 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backfillProviderCalls reports drift when content differs", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    prepareProviderCallDb(dbPath);
    const jsonRecord = makeProviderCall({ id: "provider_call_a", promptTokens: 5 });
    insertAppRecordProviderCall(dbPath, jsonRecord);
    insertDedicatedProviderCall(dbPath, { ...jsonRecord, promptTokens: 99 });

    const result = backfillProviderCalls({ dbPath, dryRun: true });

    assert.equal(result.scanned, 1);
    assert.equal(result.wouldInsert, 0);
    assert.equal(result.alreadyPresent, 0);
    assert.equal(result.drift, 1);
    assert.equal(result.inserted, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyProviderCalls reports matched when both sides identical", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    prepareProviderCallDb(dbPath);
    const record = makeProviderCall({ id: "provider_call_a" });
    insertAppRecordProviderCall(dbPath, record);
    insertDedicatedProviderCall(dbPath, record);

    const result = verifyProviderCalls({ dbPath });

    assert.equal(result.matched, 1);
    assert.equal(result.jsonOnly, 0);
    assert.equal(result.sqliteOnly, 0);
    assert.equal(result.contentDrift, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyProviderCalls reports jsonOnly when JSON-side has rows not yet backfilled", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    prepareProviderCallDb(dbPath);
    insertAppRecordProviderCall(dbPath, makeProviderCall({ id: "provider_call_a" }));
    insertAppRecordProviderCall(dbPath, makeProviderCall({ id: "provider_call_b" }));

    const result = verifyProviderCalls({ dbPath });

    assert.equal(result.jsonOnly, 2);
    assert.equal(result.sqliteOnly, 0);
    assert.equal(result.matched, 0);
    assert.equal(result.contentDrift, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyProviderCalls reports sqliteOnly when dedicated table has extra rows", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    prepareProviderCallDb(dbPath);
    insertDedicatedProviderCall(dbPath, makeProviderCall({ id: "extra" }));

    const result = verifyProviderCalls({ dbPath });

    assert.equal(result.sqliteOnly, 1);
    assert.equal(result.jsonOnly, 0);
    assert.equal(result.matched, 0);
    assert.equal(result.contentDrift, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyProviderCalls reports contentDrift when ids match but content differs", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    prepareProviderCallDb(dbPath);
    const record = makeProviderCall({ id: "provider_call_a", status: "success" });
    insertAppRecordProviderCall(dbPath, record);
    insertDedicatedProviderCall(dbPath, { ...record, status: "error", errorMessage: "provider failed" });

    const result = verifyProviderCalls({ dbPath });

    assert.equal(result.contentDrift, 1);
    assert.equal(result.matched, 0);
    assert.equal(result.jsonOnly, 0);
    assert.equal(result.sqliteOnly, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function makeActivationSignal(overrides: Partial<ActivationSignalRecord> & { id: string }): ActivationSignalRecord {
  const record: ActivationSignalRecord = {
    id: overrides.id,
    workspaceId: overrides.workspaceId ?? "alpha",
    kind: overrides.kind ?? "retry",
    source: overrides.source ?? "user_fact",
    createdAt: overrides.createdAt ?? "2026-04-26T12:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-26T12:00:01.000Z",
  };
  if (overrides.origin !== undefined) record.origin = overrides.origin;
  if (overrides.sourceId !== undefined) record.sourceId = overrides.sourceId;
  if (overrides.stableKey !== undefined) record.stableKey = overrides.stableKey;
  if (overrides.data !== undefined) record.data = overrides.data;
  return record;
}

function insertAppRecordActivationSignal(dbPath: string, record: ActivationSignalRecord): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      insert into app_records (collection, id, workspace_id, payload, updated_at)
      values ('activationSignals', ?, ?, json(?), ?)
      on conflict(collection, id) do update set workspace_id = excluded.workspace_id, payload = excluded.payload, updated_at = excluded.updated_at
    `).run(record.id, record.workspaceId, JSON.stringify(record), record.updatedAt);
  } finally {
    db.close();
  }
}

function insertDedicatedActivationSignal(dbPath: string, record: ActivationSignalRecord): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      insert or replace into activation_signals (
        id, workspace_id, kind, source, origin, source_id, stable_key, data, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.workspaceId,
      record.kind,
      record.source,
      record.origin ?? null,
      record.sourceId ?? null,
      record.stableKey ?? null,
      record.data === undefined ? null : JSON.stringify(record.data),
      record.createdAt,
      record.updatedAt,
    );
  } finally {
    db.close();
  }
}

function countDedicatedActivationSignals(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("select count(*) as count from activation_signals").get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

test("backfillActivationSignals inserts JSON-side rows into the dedicated table", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertAppRecordActivationSignal(dbPath, makeActivationSignal({ id: "signal_a", stableKey: "alpha:signal:a" }));

    const result = backfillActivationSignals({ dbPath });

    assert.equal(result.scanned, 1);
    assert.equal(result.wouldInsert, 1);
    assert.equal(result.alreadyPresent, 0);
    assert.equal(result.inserted, 1);
    assert.equal(countDedicatedActivationSignals(dbPath), 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backfillActivationSignals is idempotent and supports dry-run", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertAppRecordActivationSignal(dbPath, makeActivationSignal({ id: "signal_a", stableKey: "alpha:signal:a" }));

    backfillActivationSignals({ dbPath });
    const second = backfillActivationSignals({ dbPath, dryRun: true });

    assert.equal(second.dryRun, true);
    assert.equal(second.scanned, 1);
    assert.equal(second.wouldInsert, 0);
    assert.equal(second.alreadyPresent, 1);
    assert.equal(second.inserted, 0);
    assert.equal(countDedicatedActivationSignals(dbPath), 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backfillActivationSignals treats matching stable-key rows with different ids as drift", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    const jsonRecord = makeActivationSignal({
      id: "legacy_signal",
      stableKey: "alpha:signal:shared",
      source: "user_fact",
    });
    const dedicatedRecord = makeActivationSignal({
      id: "dedicated_signal",
      stableKey: "alpha:signal:shared",
      source: "system_fact",
      origin: "system_observed",
    });
    insertAppRecordActivationSignal(dbPath, jsonRecord);
    insertDedicatedActivationSignal(dbPath, dedicatedRecord);

    const result = backfillActivationSignals({ dbPath });

    assert.equal(result.scanned, 1);
    assert.equal(result.wouldInsert, 0);
    assert.equal(result.alreadyPresent, 0);
    assert.equal(result.drift, 1);
    assert.equal(result.inserted, 0);
    assert.equal(countDedicatedActivationSignals(dbPath), 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyActivationSignals treats dedicated-only rows as healthy after mirror retirement", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    insertDedicatedActivationSignal(dbPath, makeActivationSignal({ id: "dedicated_only", stableKey: "alpha:dedicated-only" }));

    const result = verifyActivationSignals({ dbPath });

    assert.equal(result.matched, 0);
    assert.equal(result.jsonOnly, 0);
    assert.equal(result.sqliteOnly, 0);
    assert.equal(result.contentDrift, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("verifyActivationSignals reports jsonOnly sqliteOnly and contentDrift", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });
    const matching = makeActivationSignal({ id: "matching", stableKey: "alpha:matching" });
    const drift = makeActivationSignal({ id: "drift", source: "user_fact", stableKey: "alpha:drift" });
    insertAppRecordActivationSignal(dbPath, matching);
    insertDedicatedActivationSignal(dbPath, matching);
    insertAppRecordActivationSignal(dbPath, makeActivationSignal({ id: "json_only", stableKey: "alpha:json_only" }));
    insertDedicatedActivationSignal(dbPath, makeActivationSignal({ id: "sqlite_only", stableKey: "alpha:sqlite_only" }));
    insertAppRecordActivationSignal(dbPath, drift);
    insertDedicatedActivationSignal(dbPath, { ...drift, source: "system_fact", origin: "system_observed" });

    const result = verifyActivationSignals({ dbPath });

    assert.equal(result.matched, 1);
    assert.equal(result.jsonOnly, 1);
    assert.equal(result.sqliteOnly, 0);
    assert.equal(result.contentDrift, 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
