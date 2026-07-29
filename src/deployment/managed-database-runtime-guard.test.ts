import assert from "node:assert/strict";
import test from "node:test";
import {
  assertManagedDatabaseRuntimeSupported,
  assessManagedDatabaseRuntimeGuard,
  buildManagedDatabaseRuntimeGuardReport,
  ManagedDatabaseRuntimeGuardError,
  type ManagedDatabaseRuntimeGuardObservedEnvValue,
} from "./managed-database-runtime-guard.js";

function observedEnvValue(
  report: ReturnType<typeof assessManagedDatabaseRuntimeGuard>,
  name: string,
): ManagedDatabaseRuntimeGuardObservedEnvValue {
  const entry = report.observed.env[name];
  assert.ok(entry, `expected observed env entry for ${name}`);
  return entry;
}

test("local JSON runtime is allowed by default", () => {
  const report = assessManagedDatabaseRuntimeGuard({ env: {} });

  assert.equal(report.allowed, true);
  assert.equal(report.status, "pass");
  assert.equal(report.classification, "local-json");
  assert.equal(report.observed.store, "json");
  assert.equal(report.observed.dbPath, null);
  assert.equal(report.managedDatabaseRuntimeBlocked, false);
  assert.equal(report.blockers.length, 0);
  assert.ok(report.summary.includes("local JSON"));
  assert.ok(
    report.checks.some(
      (check) => check.id === "supported-runtime-store" && check.status === "pass",
    ),
  );
});

test("single-node SQLite runtime is allowed", () => {
  const report = buildManagedDatabaseRuntimeGuardReport({
    PACKETAGENT_STORE: "sqlite",
    PACKETAGENT_DB_PATH: "/srv/packetagent/packetagent.sqlite",
    PACKETAGENT_DATABASE_TOPOLOGY: "single-node-sqlite",
  });

  assert.equal(report.allowed, true);
  assert.equal(report.status, "pass");
  assert.equal(report.classification, "single-node-sqlite");
  assert.equal(report.observed.store, "sqlite");
  assert.equal(report.observed.dbPath, "/srv/packetagent/packetagent.sqlite");
  assert.equal(report.observed.databaseTopology, "single-node-sqlite");
  assert.equal(report.blockers.length, 0);
  assert.ok(report.summary.includes("single-node SQLite"));
});

test("SQLite without PACKETAGENT_DB_PATH warns about the default path", () => {
  const report = assessManagedDatabaseRuntimeGuard({ env: { PACKETAGENT_STORE: "sqlite" } });

  assert.equal(report.allowed, true);
  assert.equal(report.classification, "single-node-sqlite");
  assert.equal(report.observed.dbPath, "data/packetagent.sqlite");
  assert.ok(report.warnings.some((warning) => warning.includes("PACKETAGENT_DB_PATH is not set")));
});

test("managed database URL is redacted and blocked", () => {
  const report = assessManagedDatabaseRuntimeGuard({
    env: {
      PACKETAGENT_STORE: "sqlite",
      DATABASE_URL: "postgres://packetagent:secret@db.example.com/packetagent",
    },
  });
  const urlEntry = observedEnvValue(report, "DATABASE_URL");

  assert.equal(report.allowed, false);
  assert.equal(report.managedDatabaseRuntimeBlocked, true);
  assert.equal(report.status, "fail");
  assert.equal(report.classification, "managed-database-blocked");
  assert.equal(urlEntry.configured, true);
  assert.equal(urlEntry.redacted, true);
  assert.equal(urlEntry.value, "[redacted]");
  assert.equal(report.observed.databaseUrl, "[redacted]");
  assert.ok(
    report.blockers.some((blocker) => blocker.includes("recognized managed Postgres adapter")),
  );
  assert.ok(report.warnings.some((warning) => warning.includes("redacted")));
  assert.ok(
    report.nextSteps.some((step) => step.includes("PACKETAGENT_MANAGED_DATABASE_ADAPTER=postgres")),
  );
});

test("recognized postgres adapter and managed URL allow managed Postgres startup", () => {
  const report = assessManagedDatabaseRuntimeGuard({
    env: {
      PACKETAGENT_STORE: "sqlite",
      PACKETAGENT_MANAGED_DATABASE_ADAPTER: "postgres",
      PACKETAGENT_MANAGED_DATABASE_URL: "postgres://packetagent:secret@db.example.com/packetagent",
    },
  });

  assert.equal(report.allowed, true);
  assert.equal(report.managedDatabaseRuntimeBlocked, false);
  assert.equal(report.status, "pass");
  assert.equal(report.classification, "managed-postgres");
  assert.equal(report.observed.managedDatabaseAdapter, "postgres");
  assert.equal(report.blockers.length, 0);
  assert.ok(report.summary.includes("managed Postgres"));
  assert.doesNotThrow(() =>
    assertManagedDatabaseRuntimeSupported({
      PACKETAGENT_STORE: "sqlite",
      PACKETAGENT_MANAGED_DATABASE_ADAPTER: "postgres",
      PACKETAGENT_MANAGED_DATABASE_URL: "postgres://packetagent:secret@db.example.com/packetagent",
    }),
  );
});

test("PACKETAGENT_STORE=postgres without adapter is blocked at the managed runtime boundary", () => {
  const report = assessManagedDatabaseRuntimeGuard({
    env: {
      PACKETAGENT_STORE: "postgres",
    },
  });

  assert.equal(report.allowed, false);
  assert.equal(report.managedDatabaseRuntimeBlocked, true);
  assert.equal(report.status, "fail");
  assert.equal(report.classification, "managed-database-blocked");
  assert.equal(report.observed.store, "postgres");
  assert.ok(
    report.blockers.some((blocker) => blocker.includes("managed database runtime boundary")),
  );
  assert.ok(
    report.nextSteps.some((step) => step.includes("PACKETAGENT_MANAGED_DATABASE_ADAPTER=postgres")),
  );
  assert.throws(
    () =>
      assertManagedDatabaseRuntimeSupported({
        PACKETAGENT_STORE: "postgres",
      }),
    ManagedDatabaseRuntimeGuardError,
  );
});

test("sync managed-postgres store without adapter throws (re-pointed multi-writer posture)", () => {
  const env = {
    PACKETAGENT_STORE: "postgres",
    PACKETAGENT_MANAGED_DATABASE_URL: "postgres://packetagent:secret@db.example.com/packetagent",
    PACKETAGENT_DATABASE_TOPOLOGY: "distributed",
  } as const;
  const report = assessManagedDatabaseRuntimeGuard({ env });

  assert.equal(report.allowed, false);
  assert.equal(report.managedDatabaseRuntimeBlocked, true);
  assert.equal(report.status, "fail");
  assert.equal(report.classification, "managed-database-blocked");
  assert.ok(report.blockers.some((blocker) => blocker.includes("managed Postgres adapter")));
  assert.throws(() => assertManagedDatabaseRuntimeSupported(env), ManagedDatabaseRuntimeGuardError);
});

test("PACKETAGENT_STORE=postgres is allowed when managed Postgres adapter and URL are configured", () => {
  const report = assessManagedDatabaseRuntimeGuard({
    env: {
      PACKETAGENT_STORE: "postgres",
      PACKETAGENT_MANAGED_DATABASE_ADAPTER: "postgres",
      PACKETAGENT_MANAGED_DATABASE_URL: "postgres://packetagent:secret@db.example.com/packetagent",
    },
  });

  assert.equal(report.allowed, true);
  assert.equal(report.status, "pass");
  assert.equal(report.classification, "managed-postgres");
  assert.equal(report.observed.store, "postgres");
  assert.ok(
    report.checks.some(
      (check) => check.id === "supported-runtime-store" && check.status === "pass",
    ),
  );
});

test("PACKETAGENT_STORE=managed without adapter is blocked at the managed runtime boundary", () => {
  const report = assessManagedDatabaseRuntimeGuard({
    env: {
      PACKETAGENT_STORE: "managed",
    },
  });

  assert.equal(report.allowed, false);
  assert.equal(report.managedDatabaseRuntimeBlocked, true);
  assert.equal(report.status, "fail");
  assert.equal(report.classification, "managed-database-blocked");
  assert.equal(report.observed.store, "managed");
  assert.ok(
    report.blockers.some((blocker) => blocker.includes("managed database runtime boundary")),
  );
});

test("PACKETAGENT_STORE=managed is allowed when managed Postgres adapter and URL are configured", () => {
  const report = assessManagedDatabaseRuntimeGuard({
    env: {
      PACKETAGENT_STORE: "managed",
      PACKETAGENT_MANAGED_DATABASE_ADAPTER: "postgres",
      PACKETAGENT_DATABASE_URL: "postgres://packetagent:secret@packetagent.internal/app",
    },
  });

  assert.equal(report.allowed, true);
  assert.equal(report.status, "pass");
  assert.equal(report.classification, "managed-postgres");
  assert.equal(report.observed.store, "managed");
});

test("managed URL hints are redacted and block strict startup", () => {
  const report = assessManagedDatabaseRuntimeGuard({
    env: {
      PACKETAGENT_STORE: "sqlite",
      PACKETAGENT_MANAGED_DATABASE_URL: "postgres://packetagent:secret@db.example.com/packetagent",
      PACKETAGENT_DATABASE_URL: "postgres://packetagent:secret@packetagent.internal/app",
    },
  });
  const managedUrl = observedEnvValue(report, "PACKETAGENT_MANAGED_DATABASE_URL");
  const packetagentDatabaseUrl = observedEnvValue(report, "PACKETAGENT_DATABASE_URL");

  assert.equal(report.allowed, false);
  assert.equal(report.managedDatabaseRuntimeBlocked, true);
  assert.equal(report.status, "fail");
  assert.equal(report.classification, "managed-database-blocked");
  assert.equal(managedUrl.value, "[redacted]");
  assert.equal(managedUrl.redacted, true);
  assert.equal(packetagentDatabaseUrl.value, "[redacted]");
  assert.equal(packetagentDatabaseUrl.redacted, true);
  assert.ok(
    report.warnings.some((warning) => warning.includes("recognized managed Postgres adapter")),
  );
  assert.throws(
    () =>
      assertManagedDatabaseRuntimeSupported({
        PACKETAGENT_STORE: "sqlite",
        PACKETAGENT_DATABASE_URL: "postgres://packetagent:secret@packetagent.internal/app",
      }),
    ManagedDatabaseRuntimeGuardError,
  );
});

test("unrecognized adapter does not unlock managed Postgres startup", () => {
  const report = assessManagedDatabaseRuntimeGuard({
    env: {
      PACKETAGENT_STORE: "postgres",
      PACKETAGENT_MANAGED_DATABASE_ADAPTER: "mysql",
      PACKETAGENT_MANAGED_DATABASE_URL: "postgres://packetagent:secret@db.example.com/packetagent",
    },
  });

  assert.equal(report.allowed, false);
  assert.equal(report.classification, "managed-database-blocked");
  assert.ok(
    report.warnings.some((warning) => warning.includes("recognized postgres adapter value")),
  );
});

test("unsupported store is classified and blocked", () => {
  const report = assessManagedDatabaseRuntimeGuard({
    env: {
      PACKETAGENT_STORE: "memory",
    },
  });

  assert.equal(report.allowed, false);
  assert.equal(report.status, "fail");
  assert.equal(report.classification, "unsupported-store");
  assert.equal(report.observed.store, "memory");
  assert.ok(
    report.blockers.some((blocker) => blocker.includes("not a supported runtime storage mode")),
  );
  assert.ok(report.nextSteps.some((step) => step.includes("PACKETAGENT_STORE=json")));
});

test("bypass flag downgrades a blocked managed runtime to a warning", () => {
  const report = assessManagedDatabaseRuntimeGuard({
    env: {
      PACKETAGENT_STORE: "postgres",
      PACKETAGENT_MANAGED_DATABASE_URL: "postgres://packetagent:secret@db.example.com/packetagent",
      PACKETAGENT_UNSUPPORTED_MANAGED_DB_RUNTIME_BYPASS: "true",
    },
  });

  assert.equal(report.allowed, true);
  assert.equal(report.status, "warn");
  assert.equal(report.classification, "bypassed");
  assert.equal(report.observed.bypassEnabled, true);
  assert.equal(observedEnvValue(report, "PACKETAGENT_MANAGED_DATABASE_URL").value, "[redacted]");
  assert.ok(report.blockers.length > 0);
  assert.ok(
    report.warnings.some((warning) =>
      warning.includes("bypassed the managed database runtime guard"),
    ),
  );
  assert.ok(report.summary.includes("bypassed"));
  assert.doesNotThrow(() =>
    assertManagedDatabaseRuntimeSupported({
      PACKETAGENT_STORE: "postgres",
      PACKETAGENT_UNSUPPORTED_MANAGED_DB_RUNTIME_BYPASS: "true",
    }),
  );
});

test("assert helper throws when unsupported runtime is not bypassed", () => {
  assert.throws(
    () =>
      assertManagedDatabaseRuntimeSupported({
        PACKETAGENT_STORE: "postgres",
        PACKETAGENT_DATABASE_URL: "postgres://packetagent:secret@packetagent.internal/app",
      }),
    (error) => {
      assert.ok(error instanceof ManagedDatabaseRuntimeGuardError);
      assert.equal(error.report.allowed, false);
      assert.equal(error.report.classification, "managed-database-blocked");
      return true;
    },
  );
});
