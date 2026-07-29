import { createHash } from "node:crypto";
import { setCachedStore } from "../cache.js";
import {
  cleanStoreEnvValue,
  MANAGED_DATABASE_URL_ENV_KEYS,
  ManagedPostgresStoreConfigurationError,
} from "../mode.js";
import { normalizeStore } from "../normalize.js";
import { seedStore } from "../seed.js";
import type {
  ManagedPostgresStoreClientConfig,
  ManagedPostgresStoreClientFactory,
  ManagedPostgresStoreQueryClient,
  ManagedPostgresStoreTransactionClient,
  ResolvedPacketAgentStoreMode,
  PacketAgentData,
} from "../types.js";
import type { AsyncStoreBackend } from "./types.js";

// BACKEND module: managed Postgres document store. Imports leaves only
// (cache/mode/normalize/seed) — never another backend or the barrel. The
// advisory-lock + transaction + retry behavior is moved verbatim. The client
// factory (and its test override) is module-private state exposed through
// accessors.

const MANAGED_POSTGRES_DOCUMENT_KEY = "packetagent:store";
const MANAGED_POSTGRES_SCHEMA_VERSION = 1;

let managedPostgresStoreClientFactory: ManagedPostgresStoreClientFactory =
  createDefaultManagedPostgresStoreClient;
let managedPostgresPoolClientFactory: ManagedPostgresStoreClientFactory =
  createUncachedManagedPostgresPoolClient;
const managedPostgresPoolHandles = new Map<string, Promise<ManagedPostgresPoolHandle>>();

interface ManagedPostgresPoolHandle {
  client: ManagedPostgresStoreQueryClient;
  close(): Promise<void>;
}

export function setManagedPostgresStoreClientFactoryForTests(
  factory: ManagedPostgresStoreClientFactory | null,
): () => void {
  const previous = managedPostgresStoreClientFactory;
  managedPostgresStoreClientFactory = factory ?? createDefaultManagedPostgresStoreClient;
  return () => {
    managedPostgresStoreClientFactory = previous;
  };
}

export function setManagedPostgresPoolClientFactoryForTests(
  factory: ManagedPostgresStoreClientFactory | null,
): () => void {
  const previous = managedPostgresPoolClientFactory;
  managedPostgresPoolClientFactory = factory ?? createUncachedManagedPostgresPoolClient;
  return () => {
    managedPostgresPoolClientFactory = previous;
  };
}

export function managedDatabaseAsyncStoreBackend(
  resolution: ResolvedPacketAgentStoreMode,
): AsyncStoreBackend {
  const config = resolveManagedPostgresStoreClientConfig(resolution);

  return {
    key: managedPostgresBackendKey(config),
    load() {
      return loadManagedPostgresStore(config);
    },
    mutate(mutator) {
      return mutateManagedPostgresStore(config, mutator);
    },
  };
}

function resolveManagedPostgresStoreClientConfig(
  resolution: ResolvedPacketAgentStoreMode,
): ManagedPostgresStoreClientConfig {
  const envKey = MANAGED_DATABASE_URL_ENV_KEYS.find(
    (key) => cleanStoreEnvValue(process.env[key]).length > 0,
  );
  if (!envKey) {
    throw new ManagedPostgresStoreConfigurationError(
      "Managed Postgres storage requires DATABASE_URL, PACKETAGENT_DATABASE_URL, or PACKETAGENT_MANAGED_DATABASE_URL.",
    );
  }

  return {
    url: cleanStoreEnvValue(process.env[envKey]),
    envKey,
    resolution,
  };
}

async function createDefaultManagedPostgresStoreClient(
  config: ManagedPostgresStoreClientConfig,
): Promise<ManagedPostgresStoreQueryClient> {
  const poolKey = createHash("sha256").update(config.url).digest("hex");
  let handlePromise = managedPostgresPoolHandles.get(poolKey);
  if (!handlePromise) {
    handlePromise = createManagedPostgresPoolHandle(config);
    managedPostgresPoolHandles.set(poolKey, handlePromise);
    void handlePromise.catch(() => {
      if (managedPostgresPoolHandles.get(poolKey) === handlePromise) {
        managedPostgresPoolHandles.delete(poolKey);
      }
    });
  }
  return (await handlePromise).client;
}

async function createManagedPostgresPoolHandle(
  config: ManagedPostgresStoreClientConfig,
): Promise<ManagedPostgresPoolHandle> {
  const pool = await managedPostgresPoolClientFactory(config);
  return {
    client: {
      query(sql, params) {
        return pool.query(sql, params);
      },
      connect() {
        return pool.connect?.() ?? Promise.resolve(pool);
      },
    },
    async close() {
      await pool.close?.();
    },
  };
}

async function createUncachedManagedPostgresPoolClient(
  config: ManagedPostgresStoreClientConfig,
): Promise<ManagedPostgresStoreQueryClient> {
  const importModule = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<unknown>;
  let pgModule: unknown;
  try {
    pgModule = await importModule("pg");
  } catch (error) {
    throw new ManagedPostgresStoreConfigurationError(
      `Managed Postgres storage requires the optional "pg" package to be installed. ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const poolConstructor = (
    pgModule as {
      Pool?: new (options: { connectionString: string }) => ManagedPostgresStoreQueryClient & {
        end?: () => Promise<void> | void;
      };
    }
  ).Pool;
  if (!poolConstructor) {
    throw new ManagedPostgresStoreConfigurationError(
      "Managed Postgres storage could not find pg.Pool.",
    );
  }

  const pool = new poolConstructor({ connectionString: config.url });
  return {
    query(sql, params) {
      return pool.query(sql, params);
    },
    connect() {
      return pool.connect?.() ?? Promise.resolve(pool);
    },
    close() {
      return pool.end?.() ?? pool.close?.();
    },
  };
}

export async function shutdownManagedPostgresStoreClientPool(): Promise<void> {
  const handles = [...managedPostgresPoolHandles.values()];
  managedPostgresPoolHandles.clear();
  const settledHandles = await Promise.allSettled(handles);
  await Promise.all(
    settledHandles.flatMap((result) =>
      result.status === "fulfilled" ? [result.value.close()] : [],
    ),
  );
}

async function withManagedPostgresClient<T>(
  config: ManagedPostgresStoreClientConfig,
  run: (client: ManagedPostgresStoreQueryClient) => Promise<T>,
): Promise<T> {
  const client = await managedPostgresStoreClientFactory(config);
  try {
    return await run(client);
  } finally {
    await client.close?.();
  }
}

async function ensureManagedPostgresDocumentStore(
  client: ManagedPostgresStoreQueryClient,
): Promise<void> {
  await client.query(`
    create table if not exists packetagent_document_store (
      document_key text primary key,
      schema_version integer not null,
      metadata jsonb not null default '{}'::jsonb,
      payload jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);
}

async function loadManagedPostgresStore(
  config: ManagedPostgresStoreClientConfig,
): Promise<PacketAgentData> {
  const backendKey = managedPostgresBackendKey(config);
  return withManagedPostgresClient(config, async (client) => {
    await ensureManagedPostgresDocumentStore(client);
    const loaded = await readManagedPostgresStore(client);
    if (loaded) return loaded;

    return withManagedPostgresMutationRetry(async () => {
      return withManagedPostgresTransactionClient(client, async (transactionClient) => {
        await transactionClient.query("select pg_advisory_xact_lock(hashtext($1))", [
          MANAGED_POSTGRES_DOCUMENT_KEY,
        ]);
        const existing = await readManagedPostgresStore(transactionClient, true);
        if (existing) return existing;

        const seeded = seedStore();
        await persistManagedPostgresStore(transactionClient, seeded);
        setCachedStore(seeded, backendKey);
        return seeded;
      });
    });
  });
}

async function mutateManagedPostgresStore<T>(
  config: ManagedPostgresStoreClientConfig,
  mutator: (data: PacketAgentData) => T | Promise<T>,
): Promise<T> {
  const backendKey = managedPostgresBackendKey(config);
  return withManagedPostgresMutationRetry(() =>
    withManagedPostgresClient(config, async (client) => {
      await ensureManagedPostgresDocumentStore(client);
      return withManagedPostgresTransactionClient(client, async (transactionClient) => {
        await transactionClient.query("select pg_advisory_xact_lock(hashtext($1))", [
          MANAGED_POSTGRES_DOCUMENT_KEY,
        ]);
        const data = (await readManagedPostgresStore(transactionClient, true)) ?? seedStore();
        const result = await mutator(data);
        await persistManagedPostgresStore(transactionClient, data);
        setCachedStore(data, backendKey);
        return result;
      });
    }),
  );
}

async function withManagedPostgresTransactionClient<T>(
  client: ManagedPostgresStoreQueryClient,
  run: (client: ManagedPostgresStoreTransactionClient) => Promise<T>,
): Promise<T> {
  const transactionClient = await acquireManagedPostgresTransactionClient(client);
  try {
    await transactionClient.query("begin");
    try {
      const result = await run(transactionClient);
      await transactionClient.query("commit");
      return result;
    } catch (error) {
      return await rollbackManagedPostgresTransaction(transactionClient, error);
    }
  } finally {
    await releaseManagedPostgresTransactionClient(transactionClient, client);
  }
}

async function acquireManagedPostgresTransactionClient(
  client: ManagedPostgresStoreQueryClient,
): Promise<ManagedPostgresStoreTransactionClient> {
  return client.connect?.() ?? client;
}

async function rollbackManagedPostgresTransaction(
  client: ManagedPostgresStoreTransactionClient,
  cause: unknown,
): Promise<never> {
  try {
    await client.query("rollback");
  } catch {
    // Preserve the original mutation error; rollback failures are secondary here.
  }
  throw cause;
}

async function releaseManagedPostgresTransactionClient(
  transactionClient: ManagedPostgresStoreTransactionClient,
  parentClient: ManagedPostgresStoreQueryClient,
): Promise<void> {
  if (transactionClient === parentClient) return;
  if (transactionClient.release) {
    await transactionClient.release();
    return;
  }
  await transactionClient.close?.();
}

async function withManagedPostgresMutationRetry<T>(run: () => Promise<T>): Promise<T> {
  const maxAttempts = 3;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableManagedPostgresTransactionError(error)) throw error;
      await delayManagedPostgresRetry(attempt);
    }
  }
}

function isRetryableManagedPostgresTransactionError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  return code === "40001" || code === "40P01" || code === "55P03" || code === "57014";
}

function delayManagedPostgresRetry(attempt: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 10));
}

function managedPostgresBackendKey(config: ManagedPostgresStoreClientConfig): string {
  return [
    "postgres",
    config.resolution.mode,
    config.resolution.requestedStore,
    config.envKey,
    createHash("sha256").update(config.url).digest("hex").slice(0, 16),
  ].join(":");
}

async function readManagedPostgresStore(
  client: ManagedPostgresStoreQueryClient,
  forUpdate = false,
): Promise<PacketAgentData | null> {
  const result = await client.query<{ payload: unknown }>(
    `
      select payload
      from packetagent_document_store
      where document_key = $1
      limit 1
      ${forUpdate ? "for update" : ""}
    `,
    [MANAGED_POSTGRES_DOCUMENT_KEY],
  );
  const row = result.rows[0];
  if (!row) return null;
  const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
  return normalizeStore(payload as Partial<PacketAgentData>);
}

async function persistManagedPostgresStore(
  client: ManagedPostgresStoreQueryClient,
  data: PacketAgentData,
): Promise<void> {
  await client.query(
    `
      insert into packetagent_document_store (
        document_key, schema_version, metadata, payload, created_at, updated_at
      )
      values ($1, $2, $3::jsonb, $4::jsonb, now(), now())
      on conflict(document_key) do update set
        schema_version = excluded.schema_version,
        metadata = excluded.metadata,
        payload = excluded.payload,
        updated_at = now()
    `,
    [
      MANAGED_POSTGRES_DOCUMENT_KEY,
      MANAGED_POSTGRES_SCHEMA_VERSION,
      JSON.stringify({
        adapter: "managed-postgres-document-store",
        foundation: "phase-50",
      }),
      JSON.stringify(normalizeStore(data)),
    ],
  );
}
