import { Pool } from "pg";
import type { PoolConfig, QueryConfig, QueryResult, QueryResultRow } from "pg";

export const MANAGED_POSTGRES_ENV_KEYS = [
  "PACKETAGENT_MANAGED_DATABASE_URL",
  "PACKETAGENT_DATABASE_URL",
  "DATABASE_URL",
] as const;

export type ManagedPostgresEnvKey = (typeof MANAGED_POSTGRES_ENV_KEYS)[number];

export type ManagedPostgresEnv = Partial<Record<ManagedPostgresEnvKey, string | undefined>>;

export interface ManagedPostgresConfig {
  configured: boolean;
  source: ManagedPostgresEnvKey | null;
  connectionString: string | null;
  redactedConnectionString: string | null;
  summary: string;
}

export interface ManagedPostgresPoolClient {
  query<Row extends QueryResultRow = QueryResultRow>(
    queryTextOrConfig: string | QueryConfig<unknown[]>,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
  release(err?: Error | boolean): void;
}

export interface ManagedPostgresPool {
  query<Row extends QueryResultRow = QueryResultRow>(
    queryTextOrConfig: string | QueryConfig<unknown[]>,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
  connect(): Promise<ManagedPostgresPoolClient>;
  end(): Promise<void>;
}

export interface ManagedPostgresClient extends ManagedPostgresPool {
  readonly config: ManagedPostgresConfig;
  readonly pool: ManagedPostgresPool;
  close(): Promise<void>;
}

export type ManagedPostgresPoolConstructor = new (config: PoolConfig) => ManagedPostgresPool;

export interface CreateManagedPostgresPoolOptions {
  env?: ManagedPostgresEnv;
  poolConfig?: Omit<PoolConfig, "connectionString">;
  PoolCtor?: ManagedPostgresPoolConstructor;
}

export interface CreateManagedPostgresClientOptions extends CreateManagedPostgresPoolOptions {
  pool?: ManagedPostgresPool;
}

export class ManagedPostgresConfigError extends Error {
  constructor(readonly config: ManagedPostgresConfig) {
    super(config.summary);
    this.name = "ManagedPostgresConfigError";
  }
}

let sharedPool: ManagedPostgresPool | null = null;
let sharedConfig: ManagedPostgresConfig | null = null;

function clean(value: string | undefined): string {
  return (value ?? "").trim();
}

function firstConfiguredUrl(env: ManagedPostgresEnv): Pick<ManagedPostgresConfig, "source" | "connectionString"> {
  for (const key of MANAGED_POSTGRES_ENV_KEYS) {
    const value = clean(env[key]);
    if (value) return { source: key, connectionString: value };
  }
  return { source: null, connectionString: null };
}

export function redactPostgresConnectionString(value: string | null | undefined): string | null {
  return clean(value ?? undefined) ? "[redacted]" : null;
}

export function resolveManagedPostgresConfig(env: ManagedPostgresEnv = process.env): ManagedPostgresConfig {
  const { source, connectionString } = firstConfiguredUrl(env);
  const redactedConnectionString = redactPostgresConnectionString(connectionString);

  if (!source || !connectionString) {
    return {
      configured: false,
      source: null,
      connectionString: null,
      redactedConnectionString: null,
      summary: "Managed Postgres is not configured.",
    };
  }

  return {
    configured: true,
    source,
    connectionString,
    redactedConnectionString,
    summary: `Managed Postgres is configured from ${source} (${redactedConnectionString}).`,
  };
}

export function assertManagedPostgresConfigured(config: ManagedPostgresConfig): asserts config is ManagedPostgresConfig & {
  configured: true;
  source: ManagedPostgresEnvKey;
  connectionString: string;
  redactedConnectionString: string;
} {
  if (!config.configured || !config.connectionString) throw new ManagedPostgresConfigError(config);
}

function buildManagedPostgresPool(
  config: ManagedPostgresConfig & {
    configured: true;
    source: ManagedPostgresEnvKey;
    connectionString: string;
    redactedConnectionString: string;
  },
  options: CreateManagedPostgresPoolOptions,
): ManagedPostgresPool {
  const PoolCtor = options.PoolCtor ?? Pool;
  return new PoolCtor({
    ...options.poolConfig,
    connectionString: config.connectionString,
  });
}

function clientFromPool(config: ManagedPostgresConfig, pool: ManagedPostgresPool): ManagedPostgresClient {
  assertManagedPostgresConfigured(config);
  return {
    config,
    pool,
    query(queryTextOrConfig, values) {
      return pool.query(queryTextOrConfig, values);
    },
    connect() {
      return pool.connect();
    },
    end() {
      return pool.end();
    },
    close() {
      return pool.end();
    },
  };
}

export function createManagedPostgresPool(options: CreateManagedPostgresPoolOptions = {}): ManagedPostgresPool {
  const config = resolveManagedPostgresConfig(options.env);
  assertManagedPostgresConfigured(config);
  return buildManagedPostgresPool(config, options);
}

export function createManagedPostgresClient(options: CreateManagedPostgresClientOptions = {}): ManagedPostgresClient {
  const config = resolveManagedPostgresConfig(options.env);
  assertManagedPostgresConfigured(config);
  const pool = options.pool ?? createManagedPostgresPool(options);
  return clientFromPool(config, pool);
}

export function getManagedPostgresPool(options: CreateManagedPostgresPoolOptions = {}): ManagedPostgresPool {
  if (!sharedPool) {
    const config = resolveManagedPostgresConfig(options.env);
    assertManagedPostgresConfigured(config);
    sharedConfig = config;
    sharedPool = buildManagedPostgresPool(config, options);
  }
  return sharedPool;
}

export function getManagedPostgresClient(options: CreateManagedPostgresClientOptions = {}): ManagedPostgresClient {
  if (options.pool) return createManagedPostgresClient(options);
  const pool = options.pool ?? getManagedPostgresPool(options);
  return clientFromPool(sharedConfig ?? resolveManagedPostgresConfig(options.env), pool);
}

export async function closeManagedPostgresPool(): Promise<void> {
  const pool = sharedPool;
  sharedPool = null;
  sharedConfig = null;
  if (pool) await pool.end();
}
