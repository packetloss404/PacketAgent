import assert from "node:assert/strict";
import test from "node:test";
import {
  clearStoreCacheForTests,
  createSeedStore,
  findUserByEmailIndexedAsync,
  findWorkspaceBriefIndexedAsync,
  listAgentsForWorkspaceIndexedAsync,
  listRequirementsForWorkspaceIndexedAsync,
  loadStoreAsync,
  type ManagedPostgresStoreClientConfig,
  type ManagedPostgresStoreQueryClient,
  type ManagedPostgresStoreQueryResult,
  mutateStoreAsync,
  setManagedPostgresStoreClientFactoryForTests,
  type PacketAgentData,
  upsertRequirement,
} from "./packetagent-store";

const STORE_ENV_KEYS = [
  "PACKETAGENT_STORE",
  "PACKETAGENT_DB_PATH",
  "DATABASE_URL",
  "PACKETAGENT_DATABASE_URL",
  "PACKETAGENT_MANAGED_DATABASE_URL",
  "PACKETAGENT_DATABASE_TOPOLOGY",
] as const;

type StoreEnvKey = (typeof STORE_ENV_KEYS)[number];

interface QueryLog {
  sql: string;
  params: readonly unknown[];
}

class FakeManagedPostgresClient implements ManagedPostgresStoreQueryClient {
  readonly queries: QueryLog[] = [];
  payloadJson: string | null = null;
  metadataJson: string | null = null;
  closed = 0;

  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<ManagedPostgresStoreQueryResult<TRow>> {
    this.queries.push({ sql, params });
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();

    if (normalized.startsWith("select payload from packetagent_document_store")) {
      return {
        rows: this.payloadJson ? [{ payload: this.payloadJson } as unknown as TRow] : [],
      };
    }

    if (normalized.startsWith("insert into packetagent_document_store")) {
      this.metadataJson = String(params[2]);
      this.payloadJson = String(params[3]);
    }

    return { rows: [] };
  }

  close(): void {
    this.closed += 1;
  }

  storedData(): PacketAgentData {
    assert.ok(this.payloadJson);
    return JSON.parse(this.payloadJson) as PacketAgentData;
  }

  normalizedQueries(): string[] {
    return this.queries.map((entry) => entry.sql.replace(/\s+/g, " ").trim().toLowerCase());
  }
}

async function withManagedStoreEnv(
  env: Partial<Record<StoreEnvKey, string>>,
  client: FakeManagedPostgresClient,
  run: (configs: ManagedPostgresStoreClientConfig[]) => Promise<void> | void,
): Promise<void> {
  const previous = new Map<StoreEnvKey, string | undefined>();
  for (const key of STORE_ENV_KEYS) previous.set(key, process.env[key]);

  const configs: ManagedPostgresStoreClientConfig[] = [];
  const restoreFactory = setManagedPostgresStoreClientFactoryForTests((config) => {
    configs.push(config);
    return client;
  });

  try {
    for (const key of STORE_ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(env) as Array<[StoreEnvKey, string | undefined]>) {
      if (value !== undefined) process.env[key] = value;
    }
    clearStoreCacheForTests();
    await run(configs);
  } finally {
    clearStoreCacheForTests();
    restoreFactory();
    for (const key of STORE_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("loadStoreAsync initializes the managed Postgres document store", async () => {
  const client = new FakeManagedPostgresClient();

  await withManagedStoreEnv({
    PACKETAGENT_STORE: "postgres",
    PACKETAGENT_DATABASE_URL: "postgres://packetagent:secret@db.example.com/packetagent",
  }, client, async (configs) => {
    const loaded = await loadStoreAsync();

    assert.equal(configs[0].envKey, "PACKETAGENT_DATABASE_URL");
    assert.equal(loaded.workspaces.some((entry) => entry.id === "alpha"), true);
    assert.equal(client.storedData().users.some((entry) => entry.email === "alpha@packetagent.local"), true);
    assert.deepEqual(JSON.parse(client.metadataJson ?? "{}"), {
      adapter: "managed-postgres-document-store",
      foundation: "phase-50",
    });
    assert.equal(client.normalizedQueries().some((query) => query.startsWith("create table if not exists packetagent_document_store")), true);
    assert.equal(client.normalizedQueries().some((query) => query.startsWith("insert into packetagent_document_store")), true);
    assert.equal(client.closed, 1);
  });
});

test("mutateStoreAsync persists managed Postgres document updates in a transaction", async () => {
  const client = new FakeManagedPostgresClient();
  client.payloadJson = JSON.stringify(createSeedStore());

  await withManagedStoreEnv({
    PACKETAGENT_STORE: "managed",
    PACKETAGENT_MANAGED_DATABASE_URL: "postgres://packetagent:secret@db.example.com/packetagent",
  }, client, async () => {
    const requirementId = await mutateStoreAsync(async (data) => {
      await Promise.resolve();
      return upsertRequirement(data, {
        id: "req_managed_postgres_async",
        workspaceId: "alpha",
        title: "Managed Postgres async boundary",
        priority: "must",
        status: "approved",
        createdByUserId: "user_alpha",
      }, "2026-04-29T15:00:00.000Z").id;
    });

    assert.equal(requirementId, "req_managed_postgres_async");
    assert.equal(client.storedData().requirements.some((entry) => entry.id === requirementId), true);

    const queries = client.normalizedQueries();
    assert.equal(queries.includes("begin"), true);
    assert.equal(queries.some((query) => query.startsWith("select pg_advisory_xact_lock")), true);
    assert.equal(queries.some((query) => query.includes("for update")), true);
    assert.equal(queries.includes("commit"), true);
    assert.equal(queries.includes("rollback"), false);
  });
});

test("mutateStoreAsync rolls back managed Postgres document updates when the mutator fails", async () => {
  const client = new FakeManagedPostgresClient();
  client.payloadJson = JSON.stringify(createSeedStore());

  await withManagedStoreEnv({
    DATABASE_URL: "postgres://packetagent:secret@db.example.com/packetagent",
  }, client, async () => {
    await assert.rejects(
      mutateStoreAsync((data) => {
        upsertRequirement(data, {
          id: "req_managed_postgres_rollback",
          workspaceId: "alpha",
          title: "Managed Postgres rollback boundary",
          priority: "must",
          status: "approved",
          createdByUserId: "user_alpha",
        }, "2026-04-29T16:00:00.000Z");
        throw new Error("stop transaction");
      }),
      /stop transaction/,
    );

    assert.equal(client.storedData().requirements.some((entry) => entry.id === "req_managed_postgres_rollback"), false);
    assert.equal(client.normalizedQueries().includes("rollback"), true);
    assert.equal(client.normalizedQueries().includes("commit"), false);
  });
});

test("managed database URL hints use the async Postgres backend even when sqlite is requested", async () => {
  const client = new FakeManagedPostgresClient();

  await withManagedStoreEnv({
    PACKETAGENT_STORE: "sqlite",
    PACKETAGENT_DB_PATH: "ignored-by-managed-url-hint.sqlite",
    DATABASE_URL: "postgres://packetagent:secret@db.example.com/packetagent",
  }, client, async (configs) => {
    const loaded = await loadStoreAsync();

    assert.equal(configs[0].envKey, "DATABASE_URL");
    assert.equal(loaded.workspaces.some((entry) => entry.id === "alpha"), true);
    assert.equal(client.normalizedQueries().some((query) => query.startsWith("create table if not exists packetagent_document_store")), true);
  });
});

test("async indexed helpers read through the managed Postgres document store", async () => {
  const client = new FakeManagedPostgresClient();
  client.payloadJson = JSON.stringify(createSeedStore());

  await withManagedStoreEnv({
    PACKETAGENT_STORE: "postgres",
    PACKETAGENT_DATABASE_URL: "postgres://packetagent:secret@db.example.com/packetagent",
  }, client, async () => {
    assert.equal((await findUserByEmailIndexedAsync("ALPHA@PACKETAGENT.LOCAL"))?.id, "user_alpha");
    assert.equal((await findWorkspaceBriefIndexedAsync("alpha"))?.workspaceId, "alpha");
    assert.equal((await listAgentsForWorkspaceIndexedAsync("alpha")).length > 0, true);
    assert.equal((await listRequirementsForWorkspaceIndexedAsync("alpha")).length > 0, true);

    const queries = client.normalizedQueries();
    assert.equal(queries.some((query) => query.startsWith("select payload from packetagent_document_store")), true);
  });
});

test("managed URL alone supports startup load, mutate, and async reread through Postgres", async () => {
  const client = new FakeManagedPostgresClient();

  await withManagedStoreEnv({
    PACKETAGENT_MANAGED_DATABASE_URL: "postgres://packetagent:secret@managed.example.com/packetagent",
  }, client, async (configs) => {
    const loaded = await loadStoreAsync();
    assert.equal(loaded.workspaces.some((entry) => entry.id === "alpha"), true);

    const requirementId = await mutateStoreAsync((data) => upsertRequirement(data, {
      id: "req_managed_url_only_runtime_surface",
      workspaceId: "alpha",
      title: "Managed URL only runtime surface",
      priority: "must",
      status: "approved",
      createdByUserId: "user_alpha",
    }, "2026-04-30T11:00:00.000Z").id);

    clearStoreCacheForTests();
    const requirements = await listRequirementsForWorkspaceIndexedAsync("alpha");

    assert.equal(requirementId, "req_managed_url_only_runtime_surface");
    assert.equal(requirements.some((entry) => entry.id === requirementId), true);
    assert.equal(configs[0]?.envKey, "PACKETAGENT_MANAGED_DATABASE_URL");
    assert.equal(configs[0]?.resolution.mode, "managed");
    assert.equal(configs[0]?.resolution.requestedStore, "");

    const queries = client.normalizedQueries();
    assert.equal(queries.some((query) => query.startsWith("create table if not exists packetagent_document_store")), true);
    assert.equal(queries.some((query) => query.startsWith("insert into packetagent_document_store")), true);
    assert.equal(queries.some((query) => query.includes("for update")), true);
    assert.equal(queries.filter((query) => query.startsWith("select payload from packetagent_document_store")).length >= 2, true);
  });
});

test("single-writer managed Postgres remains supported through the async backend", async () => {
  const client = new FakeManagedPostgresClient();

  await withManagedStoreEnv({
    PACKETAGENT_STORE: "postgres",
    PACKETAGENT_DATABASE_URL: "postgres://packetagent:secret@db.example.com/packetagent",
    PACKETAGENT_DATABASE_TOPOLOGY: "single-writer",
  }, client, async (configs) => {
    const requirementId = await mutateStoreAsync((data) => upsertRequirement(data, {
      id: "req_single_writer_managed_postgres",
      workspaceId: "alpha",
      title: "Single-writer managed Postgres",
      priority: "must",
      status: "approved",
      createdByUserId: "user_alpha",
    }, "2026-04-30T17:00:00.000Z").id);

    assert.equal(requirementId, "req_single_writer_managed_postgres");
    assert.equal(client.storedData().requirements.some((entry) => entry.id === requirementId), true);
    assert.equal(configs[0]?.envKey, "PACKETAGENT_DATABASE_URL");
    assert.equal(configs[0]?.resolution.mode, "postgres");

    const queries = client.normalizedQueries();
    assert.equal(queries.some((query) => query.startsWith("select pg_advisory_xact_lock")), true);
    assert.equal(queries.some((query) => query.includes("for update")), true);
    assert.equal(queries.includes("commit"), true);
  });
});
