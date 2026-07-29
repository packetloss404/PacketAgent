import assert from "node:assert/strict";
import test from "node:test";
import { resolvePacketAgentStoreMode } from "../mode.js";
import type { ManagedPostgresStoreQueryClient, ManagedPostgresStoreQueryResult } from "../types.js";
import {
  managedDatabaseAsyncStoreBackend,
  setManagedPostgresPoolClientFactoryForTests,
  shutdownManagedPostgresStoreClientPool,
} from "./managed-postgres.js";

test("the production managed Postgres adapter reuses its pool until shutdown", async () => {
  const previousStore = process.env.PACKETAGENT_STORE;
  const previousDatabaseUrl = process.env.PACKETAGENT_DATABASE_URL;
  let created = 0;
  let closed = 0;
  let payloadJson: string | null = null;

  await shutdownManagedPostgresStoreClientPool();
  const restorePoolFactory = setManagedPostgresPoolClientFactoryForTests(() => {
    created += 1;
    const client: ManagedPostgresStoreQueryClient = {
      async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params: readonly unknown[] = [],
      ): Promise<ManagedPostgresStoreQueryResult<TRow>> {
        const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
        if (normalized.startsWith("select payload from packetagent_document_store")) {
          return {
            rows: payloadJson ? ([{ payload: payloadJson }] as unknown as TRow[]) : [],
          };
        }
        if (normalized.startsWith("insert into packetagent_document_store")) {
          payloadJson = String(params[3]);
        }
        return { rows: [] };
      },
      async connect() {
        return {
          query(sql, params) {
            return client.query(sql, params);
          },
          release() {
            // A real pg.Pool returns a dedicated client to the pool here.
          },
        };
      },
      close() {
        closed += 1;
      },
    };
    return client;
  });

  try {
    process.env.PACKETAGENT_STORE = "postgres";
    process.env.PACKETAGENT_DATABASE_URL =
      "postgres://packetagent:secret@db.example.com/packetagent";
    const backend = managedDatabaseAsyncStoreBackend(resolvePacketAgentStoreMode());

    await backend.load();
    await backend.load();

    assert.equal(created, 1);
    assert.equal(closed, 0);

    await shutdownManagedPostgresStoreClientPool();
    assert.equal(closed, 1);
  } finally {
    await shutdownManagedPostgresStoreClientPool();
    restorePoolFactory();
    if (previousStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = previousStore;
    if (previousDatabaseUrl === undefined) delete process.env.PACKETAGENT_DATABASE_URL;
    else process.env.PACKETAGENT_DATABASE_URL = previousDatabaseUrl;
  }
});
