import assert from "node:assert/strict";
import test from "node:test";
import {
  clearStoreCacheForTests,
  createSeedStore,
  mutateStoreAsync,
  setManagedPostgresStoreClientFactoryForTests,
  type ManagedPostgresStoreClientConfig,
  type ManagedPostgresStoreQueryClient,
  type ManagedPostgresStoreQueryResult,
  type PacketAgentData,
  upsertRequirement,
} from "./packetagent-store";

const STORE_ENV_KEYS = [
  "PACKETAGENT_STORE",
  "DATABASE_URL",
  "PACKETAGENT_DATABASE_URL",
  "PACKETAGENT_MANAGED_DATABASE_URL",
] as const;

type StoreEnvKey = (typeof STORE_ENV_KEYS)[number];

interface QueryLog {
  clientId: string;
  sql: string;
  params: readonly unknown[];
}

interface ClientEvent {
  clientId: string;
  event: "begin" | "advisory-lock" | "row-lock" | "persist" | "commit" | "rollback" | "close";
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function withManagedPostgresEnv(
  env: Partial<Record<StoreEnvKey, string>>,
  factory: (config: ManagedPostgresStoreClientConfig) => ManagedPostgresStoreQueryClient,
  run: (configs: ManagedPostgresStoreClientConfig[]) => Promise<void> | void,
): Promise<void> {
  const previous = new Map<StoreEnvKey, string | undefined>();
  for (const key of STORE_ENV_KEYS) previous.set(key, process.env[key]);

  const configs: ManagedPostgresStoreClientConfig[] = [];
  const restoreFactory = setManagedPostgresStoreClientFactoryForTests((config) => {
    configs.push(config);
    return factory(config);
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

function normalizedSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function retryableTransactionConflict(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = "40001";
  return error;
}

class SharedManagedPostgresDocument {
  payloadJson = JSON.stringify(createSeedStore());
  readonly events: ClientEvent[] = [];
  readonly queries: QueryLog[] = [];
  readonly persistedPayloads: PacketAgentData[] = [];
  blockedOnRowLock: (() => void) | null = null;
  failNextPersistWith: Error | null = null;
  private rowLockOwner: string | null = null;
  private rowLockWaiters: Array<() => void> = [];

  async acquireRowLock(clientId: string): Promise<void> {
    if (this.rowLockOwner === null) {
      this.rowLockOwner = clientId;
      return;
    }

    this.blockedOnRowLock?.();
    await new Promise<void>((resolve) => this.rowLockWaiters.push(resolve));
    this.rowLockOwner = clientId;
  }

  releaseRowLock(clientId: string): void {
    if (this.rowLockOwner !== clientId) return;
    this.rowLockOwner = null;
    this.rowLockWaiters.shift()?.();
  }
}

class ConcurrentManagedPostgresClient implements ManagedPostgresStoreQueryClient {
  private inTransaction = false;
  private advisoryLocked = false;
  private rowLocked = false;

  constructor(
    readonly id: string,
    private readonly document: SharedManagedPostgresDocument,
  ) {}

  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<ManagedPostgresStoreQueryResult<TRow>> {
    this.document.queries.push({ clientId: this.id, sql, params });
    const normalized = normalizedSql(sql);

    if (normalized.startsWith("create table if not exists packetagent_document_store")) {
      return { rows: [] };
    }

    if (normalized === "begin") {
      assert.equal(
        this.inTransaction,
        false,
        "transaction should not be nested on the same client",
      );
      this.inTransaction = true;
      this.document.events.push({ clientId: this.id, event: "begin" });
      return { rows: [] };
    }

    if (normalized.startsWith("select pg_advisory_xact_lock")) {
      assert.equal(this.inTransaction, true, "advisory lock must be taken inside the transaction");
      this.advisoryLocked = true;
      this.document.events.push({ clientId: this.id, event: "advisory-lock" });
      return { rows: [] };
    }

    if (normalized.startsWith("select payload from packetagent_document_store")) {
      if (normalized.includes("for update")) {
        assert.equal(this.inTransaction, true, "row lock must be taken inside the transaction");
        assert.equal(
          this.advisoryLocked,
          true,
          "row lock must be taken after the advisory transaction lock",
        );
        await this.document.acquireRowLock(this.id);
        this.rowLocked = true;
        this.document.events.push({ clientId: this.id, event: "row-lock" });
      }
      return {
        rows: this.document.payloadJson
          ? [{ payload: this.document.payloadJson } as unknown as TRow]
          : [],
      };
    }

    if (normalized.startsWith("insert into packetagent_document_store")) {
      assert.equal(this.inTransaction, true, "persist must use the transaction client");
      assert.equal(this.rowLocked, true, "persist must happen after the row is locked for update");
      if (this.document.failNextPersistWith) {
        const error = this.document.failNextPersistWith;
        this.document.failNextPersistWith = null;
        throw error;
      }
      this.document.payloadJson = String(params[3]);
      this.document.persistedPayloads.push(
        JSON.parse(this.document.payloadJson) as PacketAgentData,
      );
      this.document.events.push({ clientId: this.id, event: "persist" });
      return { rows: [] };
    }

    if (normalized === "commit") {
      assert.equal(this.inTransaction, true, "commit must use the transaction client");
      this.inTransaction = false;
      this.advisoryLocked = false;
      this.rowLocked = false;
      this.document.events.push({ clientId: this.id, event: "commit" });
      this.document.releaseRowLock(this.id);
      return { rows: [] };
    }

    if (normalized === "rollback") {
      assert.equal(this.inTransaction, true, "rollback must use the transaction client");
      this.inTransaction = false;
      this.advisoryLocked = false;
      this.rowLocked = false;
      this.document.events.push({ clientId: this.id, event: "rollback" });
      this.document.releaseRowLock(this.id);
      return { rows: [] };
    }

    return { rows: [] };
  }

  close(): void {
    this.document.events.push({ clientId: this.id, event: "close" });
    this.document.releaseRowLock(this.id);
  }
}

function createClientFactory(
  document: SharedManagedPostgresDocument,
): () => ConcurrentManagedPostgresClient {
  let nextId = 0;
  return () => {
    nextId += 1;
    return new ConcurrentManagedPostgresClient(`client-${nextId}`, document);
  };
}

function requirementIds(data: PacketAgentData): string[] {
  return data.requirements.map((entry) => entry.id);
}

test("managed Postgres mutations serialize horizontal writers behind advisory and row locks", async () => {
  const document = new SharedManagedPostgresDocument();
  const createClient = createClientFactory(document);
  const firstEnteredMutator = deferred();
  const releaseFirstMutator = deferred();
  const secondBlockedOnRowLock = deferred();
  document.blockedOnRowLock = () => secondBlockedOnRowLock.resolve();

  await withManagedPostgresEnv(
    {
      PACKETAGENT_STORE: "postgres",
      PACKETAGENT_DATABASE_URL: "postgres://packetagent:secret@db.example.com/packetagent",
    },
    createClient,
    async () => {
      const firstWrite = mutateStoreAsync(async (data) => {
        firstEnteredMutator.resolve();
        await releaseFirstMutator.promise;
        return upsertRequirement(
          data,
          {
            id: "req_phase62_first_horizontal_writer",
            workspaceId: "alpha",
            title: "Phase 62 first horizontal writer",
            priority: "must",
            status: "approved",
            createdByUserId: "user_alpha",
          },
          "2026-05-01T18:00:00.000Z",
        ).id;
      });

      await firstEnteredMutator.promise;

      const secondWrite = mutateStoreAsync(
        (data) =>
          upsertRequirement(
            data,
            {
              id: "req_phase62_second_horizontal_writer",
              workspaceId: "alpha",
              title: "Phase 62 second horizontal writer",
              priority: "must",
              status: "approved",
              createdByUserId: "user_alpha",
            },
            "2026-05-01T18:01:00.000Z",
          ).id,
      );

      await secondBlockedOnRowLock.promise;
      releaseFirstMutator.resolve();

      assert.deepEqual(await Promise.all([firstWrite, secondWrite]), [
        "req_phase62_first_horizontal_writer",
        "req_phase62_second_horizontal_writer",
      ]);
    },
  );

  const storedIds = requirementIds(JSON.parse(document.payloadJson) as PacketAgentData);
  assert.equal(storedIds.includes("req_phase62_first_horizontal_writer"), true);
  assert.equal(storedIds.includes("req_phase62_second_horizontal_writer"), true);

  for (const clientId of ["client-1", "client-2"]) {
    const events = document.events
      .filter((entry) => entry.clientId === clientId)
      .map((entry) => entry.event);
    assert.deepEqual(events, ["begin", "advisory-lock", "row-lock", "persist", "commit", "close"]);
  }
});

test("managed Postgres rollback releases the transaction client after a failed horizontal write", async () => {
  const document = new SharedManagedPostgresDocument();
  const createClient = createClientFactory(document);

  await withManagedPostgresEnv(
    {
      PACKETAGENT_STORE: "postgres",
      PACKETAGENT_DATABASE_URL: "postgres://packetagent:secret@db.example.com/packetagent",
    },
    createClient,
    async () => {
      await assert.rejects(
        mutateStoreAsync((data) => {
          upsertRequirement(
            data,
            {
              id: "req_phase62_rolled_back_horizontal_writer",
              workspaceId: "alpha",
              title: "Phase 62 rolled back horizontal writer",
              priority: "must",
              status: "approved",
              createdByUserId: "user_alpha",
            },
            "2026-05-01T18:02:00.000Z",
          );
          throw new Error("abort horizontal write");
        }),
        /abort horizontal write/,
      );
    },
  );

  const storedIds = requirementIds(JSON.parse(document.payloadJson) as PacketAgentData);
  assert.equal(storedIds.includes("req_phase62_rolled_back_horizontal_writer"), false);
  assert.deepEqual(
    document.events.map((entry) => entry.event),
    ["begin", "advisory-lock", "row-lock", "rollback", "close"],
  );
});

test("managed Postgres retries retryable transaction conflicts without duplicating failed writes", async () => {
  const document = new SharedManagedPostgresDocument();
  const createClient = createClientFactory(document);
  document.failNextPersistWith = retryableTransactionConflict("serialization failure");
  let mutatorCalls = 0;

  await withManagedPostgresEnv(
    {
      PACKETAGENT_STORE: "postgres",
      PACKETAGENT_DATABASE_URL: "postgres://packetagent:secret@db.example.com/packetagent",
    },
    createClient,
    async () => {
      const requirementId = await mutateStoreAsync((data) => {
        mutatorCalls += 1;
        return upsertRequirement(
          data,
          {
            id: "req_phase62_retryable_conflict",
            workspaceId: "alpha",
            title: "Phase 62 retryable conflict",
            priority: "must",
            status: "approved",
            createdByUserId: "user_alpha",
          },
          "2026-05-01T18:03:00.000Z",
        ).id;
      });

      assert.equal(requirementId, "req_phase62_retryable_conflict");
    },
  );

  const storedIds = requirementIds(JSON.parse(document.payloadJson) as PacketAgentData);
  assert.equal(mutatorCalls, 2);
  assert.equal(storedIds.filter((id) => id === "req_phase62_retryable_conflict").length, 1);
  assert.equal(document.persistedPayloads.length, 1);
  assert.deepEqual(
    document.events.map((entry) => entry.event),
    [
      "begin",
      "advisory-lock",
      "row-lock",
      "rollback",
      "close",
      "begin",
      "advisory-lock",
      "row-lock",
      "persist",
      "commit",
      "close",
    ],
  );
});
