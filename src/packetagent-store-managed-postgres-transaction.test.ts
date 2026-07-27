import assert from "node:assert/strict";
import test from "node:test";
import {
  clearStoreCacheForTests,
  mutateStoreAsync,
  setManagedPostgresStoreClientFactoryForTests,
  type ManagedPostgresStoreClientConfig,
  type ManagedPostgresStoreQueryClient,
  type ManagedPostgresStoreQueryResult,
  type ManagedPostgresStoreTransactionClient,
  upsertRequirement,
} from "./packetagent-store";

const STORE_ENV_KEYS = [
  "PACKETAGENT_STORE",
  "DATABASE_URL",
  "PACKETAGENT_DATABASE_URL",
  "PACKETAGENT_MANAGED_DATABASE_URL",
] as const;

interface QueryLog {
  target: string;
  sql: string;
  params: readonly unknown[];
}

class TransactionConnection implements ManagedPostgresStoreTransactionClient {
  readonly queries: QueryLog[];
  readonly target: string;
  readonly failOnceOnInsert?: { code: string; used: boolean };
  payloadJson: string | null;
  released = 0;

  constructor(options: {
    queries: QueryLog[];
    target: string;
    payloadJson: string | null;
    failOnceOnInsert?: { code: string; used: boolean };
  }) {
    this.queries = options.queries;
    this.target = options.target;
    this.payloadJson = options.payloadJson;
    this.failOnceOnInsert = options.failOnceOnInsert;
  }

  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<ManagedPostgresStoreQueryResult<TRow>> {
    this.queries.push({ target: this.target, sql, params });
    const normalized = normalizeSql(sql);

    if (normalized.includes("for update")) {
      return {
        rows: this.payloadJson ? [{ payload: this.payloadJson } as unknown as TRow] : [],
      };
    }

    if (normalized.startsWith("insert into packetagent_document_store")) {
      if (this.failOnceOnInsert && !this.failOnceOnInsert.used) {
        this.failOnceOnInsert.used = true;
        throw Object.assign(new Error("serialization failure"), { code: this.failOnceOnInsert.code });
      }
      this.payloadJson = String(params[3]);
    }

    return { rows: [] };
  }

  release(): void {
    this.released += 1;
  }
}

class ConnectedManagedPostgresClient implements ManagedPostgresStoreQueryClient {
  readonly queries: QueryLog[] = [];
  readonly connections: TransactionConnection[] = [];
  readonly failOnceOnInsert?: { code: string; used: boolean };
  payloadJson: string | null = null;
  closed = 0;

  constructor(options: { failOnceOnInsertCode?: string } = {}) {
    if (options.failOnceOnInsertCode) {
      this.failOnceOnInsert = { code: options.failOnceOnInsertCode, used: false };
    }
  }

  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<ManagedPostgresStoreQueryResult<TRow>> {
    this.queries.push({ target: "pool", sql, params });
    const normalized = normalizeSql(sql);
    assert.equal(isTransactionStatement(normalized), false, `${normalized} must not use pool.query`);

    if (normalized.startsWith("select payload from packetagent_document_store")) {
      return {
        rows: this.payloadJson ? [{ payload: this.payloadJson } as unknown as TRow] : [],
      };
    }

    return { rows: [] };
  }

  async connect(): Promise<ManagedPostgresStoreTransactionClient> {
    const connection = new TransactionConnection({
      queries: this.queries,
      target: `connection-${this.connections.length + 1}`,
      payloadJson: this.payloadJson,
      failOnceOnInsert: this.failOnceOnInsert,
    });
    this.connections.push(connection);
    return connection;
  }

  close(): void {
    this.closed += 1;
  }

  committedPayload(): string | null {
    const committed = [...this.connections].reverse().find((connection) =>
      connection.queries.some((entry) => entry.target === connection.target && normalizeSql(entry.sql) === "commit"));
    return committed?.payloadJson ?? null;
  }

  normalizedQueries(target?: string): string[] {
    return this.queries
      .filter((entry) => target === undefined || entry.target === target)
      .map((entry) => normalizeSql(entry.sql));
  }
}

async function withManagedPostgresClient(
  client: ConnectedManagedPostgresClient,
  run: (configs: ManagedPostgresStoreClientConfig[]) => Promise<void>,
): Promise<void> {
  const previous = new Map<(typeof STORE_ENV_KEYS)[number], string | undefined>();
  for (const key of STORE_ENV_KEYS) previous.set(key, process.env[key]);

  const configs: ManagedPostgresStoreClientConfig[] = [];
  const restoreFactory = setManagedPostgresStoreClientFactoryForTests((config) => {
    configs.push(config);
    return client;
  });

  try {
    for (const key of STORE_ENV_KEYS) delete process.env[key];
    process.env.PACKETAGENT_STORE = "postgres";
    process.env.PACKETAGENT_DATABASE_URL = "postgres://packetagent:secret@db.example.com/packetagent";
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

test("managed Postgres mutations use a dedicated connection for the full transaction", async () => {
  const client = new ConnectedManagedPostgresClient();

  await withManagedPostgresClient(client, async (configs) => {
    await mutateStoreAsync((data) => upsertRequirement(data, {
      id: "req_managed_postgres_transaction_connection",
      workspaceId: "alpha",
      title: "Dedicated transaction connection",
      priority: "must",
      status: "approved",
      createdByUserId: "user_alpha",
    }, "2026-05-01T18:00:00.000Z"));

    assert.equal(configs[0]?.envKey, "PACKETAGENT_DATABASE_URL");
    assert.equal(client.connections.length, 1);
    assert.deepEqual(client.normalizedQueries("pool"), [
      "create table if not exists packetagent_document_store ( document_key text primary key, schema_version integer not null, metadata jsonb not null default '{}'::jsonb, payload jsonb not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now() )",
    ]);
    assert.equal(client.normalizedQueries("connection-1").includes("begin"), true);
    assert.equal(client.normalizedQueries("connection-1").some((query) => query.startsWith("select pg_advisory_xact_lock")), true);
    assert.equal(client.normalizedQueries("connection-1").some((query) => query.includes("for update")), true);
    assert.equal(client.normalizedQueries("connection-1").some((query) => query.startsWith("insert into packetagent_document_store")), true);
    assert.equal(client.normalizedQueries("connection-1").includes("commit"), true);
    assert.equal(client.connections[0]?.released, 1);
    assert.equal(client.closed, 1);
    assert.match(client.committedPayload() ?? "", /req_managed_postgres_transaction_connection/);
  });
});

test("managed Postgres mutation retries serialization failures on a fresh transaction connection", async () => {
  const client = new ConnectedManagedPostgresClient({ failOnceOnInsertCode: "40001" });
  let attempts = 0;

  await withManagedPostgresClient(client, async () => {
    await mutateStoreAsync((data) => {
      attempts += 1;
      return upsertRequirement(data, {
        id: "req_managed_postgres_retry",
        workspaceId: "alpha",
        title: "Retry managed Postgres transaction",
        priority: "must",
        status: "approved",
        createdByUserId: "user_alpha",
      }, "2026-05-01T18:30:00.000Z");
    });

    assert.equal(attempts, 2);
    assert.equal(client.connections.length, 2);
    assert.equal(client.normalizedQueries("connection-1").includes("rollback"), true);
    assert.equal(client.normalizedQueries("connection-2").includes("commit"), true);
    assert.equal(client.connections.every((connection) => connection.released === 1), true);
    assert.match(client.committedPayload() ?? "", /req_managed_postgres_retry/);
  });
});

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function isTransactionStatement(normalizedSql: string): boolean {
  return normalizedSql === "begin"
    || normalizedSql === "commit"
    || normalizedSql === "rollback"
    || normalizedSql.startsWith("select pg_advisory_xact_lock")
    || normalizedSql.includes("for update")
    || normalizedSql.startsWith("insert into packetagent_document_store");
}
