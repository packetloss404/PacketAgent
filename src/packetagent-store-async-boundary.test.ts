import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  clearStoreCacheForTests,
  findUserByEmailIndexedAsync,
  findWorkspaceMembershipIndexedAsync,
  findWorkspaceBriefIndexedAsync,
  listAgentsForWorkspaceIndexedAsync,
  listRequirementsForWorkspaceIndexedAsync,
  loadStore,
  loadStoreAsync,
  ManagedDatabaseStoreBoundaryError,
  ManagedPostgresStoreConfigurationError,
  mutateStore,
  mutateStoreAsync,
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

async function withStoreEnv(
  env: Partial<Record<StoreEnvKey, string>>,
  run: () => Promise<void> | void,
): Promise<void> {
  const previous = new Map<StoreEnvKey, string | undefined>();
  for (const key of STORE_ENV_KEYS) previous.set(key, process.env[key]);

  try {
    for (const key of STORE_ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(env) as Array<[StoreEnvKey, string | undefined]>) {
      if (value !== undefined) process.env[key] = value;
    }
    clearStoreCacheForTests();
    await run();
  } finally {
    clearStoreCacheForTests();
    for (const key of STORE_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("JSON async load and mutate reuse the current store behavior", async () => {
  await withStoreEnv({ PACKETAGENT_STORE: "json" }, async () => {
    const seeded = resetStoreForTests();
    const loaded = await loadStoreAsync();
    assert.equal(loaded, seeded);
    assert.equal(loaded.workspaces.some((entry) => entry.id === "alpha"), true);
    assert.equal((await findUserByEmailIndexedAsync("ALPHA@PACKETAGENT.LOCAL"))?.id, "user_alpha");
    assert.equal((await findWorkspaceMembershipIndexedAsync("alpha", "user_alpha"))?.role, "owner");
    assert.equal((await findWorkspaceBriefIndexedAsync("alpha"))?.workspaceId, "alpha");
    assert.equal((await listAgentsForWorkspaceIndexedAsync("alpha")).length > 0, true);

    const requirementId = await mutateStoreAsync(async (data) => {
      await Promise.resolve();
      const requirement = upsertRequirement(data, {
        id: "req_async_json_boundary",
        workspaceId: "alpha",
        title: "Async JSON boundary requirement",
        priority: "must",
        status: "approved",
        createdByUserId: "user_alpha",
      }, "2026-04-29T12:00:00.000Z");
      return requirement.id;
    });

    assert.equal(requirementId, "req_async_json_boundary");
    clearStoreCacheForTests();
    assert.equal((await loadStoreAsync()).requirements.some((entry) => entry.id === requirementId), true);
    assert.equal((await listRequirementsForWorkspaceIndexedAsync("alpha")).some((entry) => entry.id === requirementId), true);
  });
});

test("managed and Postgres modes require a managed database URL for async wrappers", async () => {
  for (const storeMode of ["managed", "postgres", "postgresql"]) {
    await withStoreEnv({ PACKETAGENT_STORE: storeMode }, async () => {
      await assert.rejects(
        loadStoreAsync(),
        (error) => {
          assert.ok(error instanceof ManagedPostgresStoreConfigurationError);
          assert.match(error.message, /requires DATABASE_URL/);
          return true;
        },
      );

      let mutatorRan = false;
      await assert.rejects(
        mutateStoreAsync(() => {
          mutatorRan = true;
          return "should-not-run";
        }),
        ManagedPostgresStoreConfigurationError,
      );
      assert.equal(mutatorRan, false);
    });
  }
});

test("synchronous JSON and SQLite APIs still return direct values", async () => {
  await withStoreEnv({ PACKETAGENT_STORE: "json" }, () => {
    resetStoreForTests();
    const result = mutateStore((data) => {
      upsertRequirement(data, {
        id: "req_sync_json_boundary",
        workspaceId: "alpha",
        title: "Sync JSON boundary requirement",
        priority: "must",
        status: "approved",
        createdByUserId: "user_alpha",
      }, "2026-04-29T13:00:00.000Z");
      return "sync-json-result";
    });

    assert.equal(result, "sync-json-result");
    assert.equal(loadStore().requirements.some((entry) => entry.id === "req_sync_json_boundary"), true);
  });

  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-async-boundary-sync-"));
  try {
    await withStoreEnv({ PACKETAGENT_STORE: "sqlite", PACKETAGENT_DB_PATH: join(tempDir, "packetagent.sqlite") }, () => {
      resetStoreForTests();
      const result = mutateStore((data) => {
        upsertRequirement(data, {
          id: "req_sync_sqlite_boundary",
          workspaceId: "alpha",
          title: "Sync SQLite boundary requirement",
          priority: "must",
          status: "approved",
          createdByUserId: "user_alpha",
        }, "2026-04-29T14:00:00.000Z");
        return "sync-sqlite-result";
      });

      assert.equal(result, "sync-sqlite-result");
      clearStoreCacheForTests();
      assert.equal(loadStore().requirements.some((entry) => entry.id === "req_sync_sqlite_boundary"), true);
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("synchronous APIs stay guarded when managed database hints are configured", async () => {
  await withStoreEnv({
    PACKETAGENT_STORE: "json",
    DATABASE_URL: "postgres://packetagent:secret@db.example.com/packetagent",
  }, () => {
    assert.throws(
      () => loadStore(),
      (error) => {
        assert.ok(error instanceof ManagedDatabaseStoreBoundaryError);
        assert.equal(error.code, "PACKETAGENT_MANAGED_DATABASE_SYNC_ADAPTER_GAP");
        assert.match(error.message, /DATABASE_URL/);
        return true;
      },
    );

    let mutatorRan = false;
    assert.throws(
      () => mutateStore(() => {
        mutatorRan = true;
        return "should-not-run";
      }),
      ManagedDatabaseStoreBoundaryError,
    );
    assert.equal(mutatorRan, false);
  });
});

test("synchronous managed Postgres store stays guarded at the boundary", async () => {
  await withStoreEnv({
    PACKETAGENT_STORE: "postgres",
    PACKETAGENT_MANAGED_DATABASE_URL: "postgres://packetagent:secret@db.example.com/packetagent",
  }, () => {
    assert.throws(
      () => loadStore(),
      (error) => {
        assert.ok(error instanceof ManagedDatabaseStoreBoundaryError);
        assert.equal(error.code, "PACKETAGENT_MANAGED_DATABASE_SYNC_ADAPTER_GAP");
        assert.equal(error.storeMode, "postgres");
        assert.deepEqual(error.managedDatabaseUrlKeys, ["PACKETAGENT_MANAGED_DATABASE_URL"]);
        return true;
      },
    );

    let mutatorRan = false;
    assert.throws(
      () => mutateStore(() => {
        mutatorRan = true;
        return "should-not-run";
      }),
      ManagedDatabaseStoreBoundaryError,
    );
    assert.equal(mutatorRan, false);
  });
});
