import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  clearStoreCacheForTests,
  loadStore,
  ManagedDatabaseStoreBoundaryError,
  MANAGED_DATABASE_SYNC_ADAPTER_GAP_MESSAGE,
  mutateStore,
  resolvePacketAgentStoreMode,
  resetStoreForTests,
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

function withStoreEnv(env: Partial<Record<StoreEnvKey, string>>, run: () => void): void {
  const previous = new Map<StoreEnvKey, string | undefined>();
  for (const key of STORE_ENV_KEYS) previous.set(key, process.env[key]);

  try {
    for (const key of STORE_ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(env) as Array<[StoreEnvKey, string | undefined]>) {
      if (value !== undefined) process.env[key] = value;
    }
    clearStoreCacheForTests();
    run();
  } finally {
    clearStoreCacheForTests();
    for (const key of STORE_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("default JSON store remains supported when no managed database hints are present", () => {
  withStoreEnv({}, () => {
    const store = resetStoreForTests();

    assert.equal(resolvePacketAgentStoreMode().mode, "json");
    assert.equal(store.workspaces.some((entry) => entry.id === "alpha"), true);
    assert.equal(loadStore().users.some((entry) => entry.email === "alpha@packetagent.local"), true);
  });
});

test("sqlite store remains supported and persists through cache reloads", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-managed-boundary-"));
  const dbPath = join(tempDir, "packetagent.sqlite");

  try {
    withStoreEnv({ PACKETAGENT_STORE: "sqlite", PACKETAGENT_DB_PATH: dbPath }, () => {
      assert.equal(resolvePacketAgentStoreMode().mode, "sqlite");
      resetStoreForTests();
      mutateStore((data) => {
        upsertRequirement(data, {
          id: "req_managed_boundary_sqlite",
          workspaceId: "alpha",
          title: "SQLite boundary requirement",
          priority: "must",
          status: "approved",
          createdByUserId: "user_alpha",
        }, "2026-04-28T12:00:00.000Z");
      });

      clearStoreCacheForTests();
      assert.equal(loadStore().requirements.some((entry) => entry.id === "req_managed_boundary_sqlite"), true);
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("managed database store modes fail at the synchronous store boundary", () => {
  for (const storeMode of ["managed", "postgres", "postgresql"]) {
    withStoreEnv({ PACKETAGENT_STORE: storeMode }, () => {
      const resolution = resolvePacketAgentStoreMode();
      assert.equal(resolution.mode, storeMode === "managed" ? "managed" : "postgres");

      assert.throws(
        () => loadStore(),
        (error) => {
          assert.ok(error instanceof ManagedDatabaseStoreBoundaryError);
          assert.equal(error.storeMode, storeMode);
          assert.deepEqual(error.managedDatabaseUrlKeys, []);
          assert.match(error.message, /PACKETAGENT_STORE=/);
          assert.ok(error.message.startsWith(MANAGED_DATABASE_SYNC_ADAPTER_GAP_MESSAGE));
          return true;
        },
      );

      let mutatorRan = false;
      assert.throws(
        () => mutateStore(() => {
          mutatorRan = true;
          return "should-not-run";
        }),
        (error) => {
          assert.ok(error instanceof ManagedDatabaseStoreBoundaryError);
          assert.equal(error.storeMode, storeMode);
          assert.deepEqual(error.managedDatabaseUrlKeys, []);
          assert.match(error.message, /PACKETAGENT_STORE=/);
          return true;
        },
      );
      assert.equal(mutatorRan, false);
    });
  }
});

test("managed database URL hints guard synchronous load and mutate instead of falling back to JSON or SQLite", () => {
  const url = "postgres://packetagent:secret@db.example.com/packetagent";
  const cases: Array<Partial<Record<StoreEnvKey, string>>> = [
    { DATABASE_URL: url },
    { PACKETAGENT_DATABASE_URL: url },
    { PACKETAGENT_MANAGED_DATABASE_URL: url },
    { PACKETAGENT_STORE: "sqlite", PACKETAGENT_DB_PATH: join(tmpdir(), "packetagent-boundary.sqlite"), DATABASE_URL: url },
  ];

  for (const env of cases) {
    withStoreEnv(env, () => {
      const expectedUrlKeys = STORE_ENV_KEYS.filter((key) => key.endsWith("DATABASE_URL") && env[key]);

      assert.throws(
        () => loadStore(),
        (error) => {
          assert.ok(error instanceof ManagedDatabaseStoreBoundaryError);
          assert.deepEqual(error.managedDatabaseUrlKeys, expectedUrlKeys);
          assert.ok(error.message.startsWith(MANAGED_DATABASE_SYNC_ADAPTER_GAP_MESSAGE));
          return true;
        },
      );

      let mutatorRan = false;
      assert.throws(
        () => mutateStore(() => {
          mutatorRan = true;
          return "should-not-run";
        }),
        (error) => {
          assert.ok(error instanceof ManagedDatabaseStoreBoundaryError);
          assert.deepEqual(error.managedDatabaseUrlKeys, expectedUrlKeys);
          assert.ok(error.message.startsWith(MANAGED_DATABASE_SYNC_ADAPTER_GAP_MESSAGE));
          return true;
        },
      );
      assert.equal(mutatorRan, false);
    });
  }
});
