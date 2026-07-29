export type ManagedDatabaseRuntimeGuardStatus = "pass" | "warn" | "fail";
export type ManagedDatabaseRuntimeGuardClassification =
  | "local-json"
  | "single-node-sqlite"
  | "managed-postgres"
  | "managed-database-blocked"
  | "unsupported-store"
  | "bypassed";

export interface ManagedDatabaseRuntimeGuardEnv {
  NODE_ENV?: string;
  PACKETAGENT_STORE?: string;
  PACKETAGENT_DB_PATH?: string;
  PACKETAGENT_MANAGED_DATABASE_URL?: string;
  DATABASE_URL?: string;
  PACKETAGENT_DATABASE_URL?: string;
  PACKETAGENT_MANAGED_DATABASE_ADAPTER?: string;
  PACKETAGENT_DATABASE_TOPOLOGY?: string;
  PACKETAGENT_UNSUPPORTED_MANAGED_DB_RUNTIME_BYPASS?: string;
}

export interface ManagedDatabaseRuntimeGuardObservedEnvValue {
  configured: boolean;
  value: string | null;
  redacted: boolean;
}

export interface ManagedDatabaseRuntimeGuardObservedConfig {
  nodeEnv: string;
  store: string;
  dbPath: string | null;
  databaseTopology: string | null;
  bypassEnabled: boolean;
  managedDatabaseUrl: string | null;
  databaseUrl: string | null;
  packetagentDatabaseUrl: string | null;
  managedDatabaseAdapter?: string | null;
  env: Record<string, ManagedDatabaseRuntimeGuardObservedEnvValue>;
}

export interface ManagedDatabaseRuntimeGuardCheck {
  id: string;
  status: ManagedDatabaseRuntimeGuardStatus;
  summary: string;
}

export interface ManagedDatabaseRuntimeGuardReport {
  allowed: boolean;
  managedDatabaseRuntimeBlocked: boolean;
  status: ManagedDatabaseRuntimeGuardStatus;
  classification: ManagedDatabaseRuntimeGuardClassification;
  summary: string;
  checks: ManagedDatabaseRuntimeGuardCheck[];
  blockers: string[];
  warnings: string[];
  nextSteps: string[];
  observed: ManagedDatabaseRuntimeGuardObservedConfig;
}

export interface ManagedDatabaseRuntimeGuardDeps {
  supportedLocalModes?: readonly string[];
}

export interface ManagedDatabaseRuntimeGuardInput extends ManagedDatabaseRuntimeGuardDeps {
  env?: ManagedDatabaseRuntimeGuardEnv;
}

export class ManagedDatabaseRuntimeGuardError extends Error {
  constructor(readonly report: ManagedDatabaseRuntimeGuardReport) {
    super(report.summary);
    this.name = "ManagedDatabaseRuntimeGuardError";
  }
}

const DEFAULT_SQLITE_PATH = "data/packetagent.sqlite";
const BYPASS_ENV_KEY = "PACKETAGENT_UNSUPPORTED_MANAGED_DB_RUNTIME_BYPASS";
const OBSERVED_ENV_KEYS = [
  "NODE_ENV",
  "PACKETAGENT_STORE",
  "PACKETAGENT_DB_PATH",
  "PACKETAGENT_MANAGED_DATABASE_URL",
  "DATABASE_URL",
  "PACKETAGENT_DATABASE_URL",
  "PACKETAGENT_MANAGED_DATABASE_ADAPTER",
  "PACKETAGENT_DATABASE_TOPOLOGY",
  BYPASS_ENV_KEY,
] as const;
const MANAGED_TOPOLOGY_HINTS = new Set([
  "managed",
  "managed-db",
  "managed-database",
  "postgres",
  "postgresql",
]);
const SUPPORTED_MANAGED_DATABASE_ADAPTERS = new Set([
  "postgres",
  "postgresql",
  "managed-postgres",
  "managed-postgresql",
]);
const URL_LIKE_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;

function clean(value: string | undefined): string {
  return (value ?? "").trim();
}

function normalize(value: string | undefined): string {
  return clean(value).toLowerCase();
}

function configured(value: string | undefined): boolean {
  return clean(value).length > 0;
}

function truthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(normalize(value));
}

function redactedValue(
  key: string,
  value: string | undefined,
): Pick<ManagedDatabaseRuntimeGuardObservedEnvValue, "value" | "redacted"> {
  const normalized = clean(value);
  if (!normalized) return { value: null, redacted: false };
  if (
    key === "PACKETAGENT_MANAGED_DATABASE_URL" ||
    key === "DATABASE_URL" ||
    key === "PACKETAGENT_DATABASE_URL" ||
    URL_LIKE_PATTERN.test(normalized)
  ) {
    return { value: "[redacted]", redacted: true };
  }
  return { value: normalized, redacted: false };
}

function observedEnvValue(
  key: (typeof OBSERVED_ENV_KEYS)[number],
  value: string | undefined,
): ManagedDatabaseRuntimeGuardObservedEnvValue {
  return {
    configured: configured(value),
    ...redactedValue(key, value),
  };
}

function buildObservedEnv(
  env: ManagedDatabaseRuntimeGuardEnv,
): Record<string, ManagedDatabaseRuntimeGuardObservedEnvValue> {
  const observed: Record<string, ManagedDatabaseRuntimeGuardObservedEnvValue> = {};
  for (const key of OBSERVED_ENV_KEYS) observed[key] = observedEnvValue(key, env[key]);
  return observed;
}

function pushCheck(
  checks: ManagedDatabaseRuntimeGuardCheck[],
  id: string,
  status: ManagedDatabaseRuntimeGuardStatus,
  summary: string,
): void {
  checks.push({ id, status, summary });
}

function statusFromChecks(
  checks: ManagedDatabaseRuntimeGuardCheck[],
  bypassEnabled: boolean,
): ManagedDatabaseRuntimeGuardStatus {
  if (checks.some((check) => check.status === "fail")) return bypassEnabled ? "warn" : "fail";
  if (checks.some((check) => check.status === "warn")) return "warn";
  return "pass";
}

function managedDatabaseUrlConfigured(env: ManagedDatabaseRuntimeGuardEnv): boolean {
  return (
    configured(env.PACKETAGENT_MANAGED_DATABASE_URL) ||
    configured(env.DATABASE_URL) ||
    configured(env.PACKETAGENT_DATABASE_URL)
  );
}

function supportedStore(store: string, supportedLocalModes: readonly string[]): boolean {
  return supportedLocalModes.includes(store);
}

function managedStoreRequested(store: string): boolean {
  return MANAGED_TOPOLOGY_HINTS.has(store);
}

function buildNextSteps(
  checks: ManagedDatabaseRuntimeGuardCheck[],
  bypassEnabled: boolean,
): string[] {
  const steps = new Set<string>();

  for (const check of checks) {
    if (check.status === "pass") continue;
    if (check.id === "supported-runtime-store") {
      steps.add(
        "Set PACKETAGENT_STORE=json for local JSON storage or PACKETAGENT_STORE=sqlite for single-node SQLite storage.",
      );
    }
    if (check.id === "managed-database-runtime") {
      steps.add(
        "Configure PACKETAGENT_MANAGED_DATABASE_ADAPTER=postgres with a managed database URL before enabling managed Postgres startup.",
      );
    }
  }

  if (bypassEnabled) {
    steps.add(
      `Unset ${BYPASS_ENV_KEY} to restore the managed database runtime guard after the emergency or development-only window.`,
    );
  }

  return Array.from(steps);
}

export function assessManagedDatabaseRuntimeGuard(
  input: ManagedDatabaseRuntimeGuardInput = {},
): ManagedDatabaseRuntimeGuardReport {
  const env = input.env ?? {};
  const supportedLocalModes = input.supportedLocalModes ?? ["json", "sqlite"];
  const store = normalize(env.PACKETAGENT_STORE) || "json";
  const nodeEnv = normalize(env.NODE_ENV) || "development";
  const databaseTopology = normalize(env.PACKETAGENT_DATABASE_TOPOLOGY);
  const bypassEnabled = truthy(env.PACKETAGENT_UNSUPPORTED_MANAGED_DB_RUNTIME_BYPASS);
  const adapter = normalize(env.PACKETAGENT_MANAGED_DATABASE_ADAPTER);
  const hasManagedDatabaseUrl = managedDatabaseUrlConfigured(env);
  const recognizedAdapter = SUPPORTED_MANAGED_DATABASE_ADAPTERS.has(adapter);
  const managedPostgresSupported = recognizedAdapter && hasManagedDatabaseUrl;
  const hasManagedIntent =
    hasManagedDatabaseUrl ||
    MANAGED_TOPOLOGY_HINTS.has(databaseTopology) ||
    managedStoreRequested(store);

  const checks: ManagedDatabaseRuntimeGuardCheck[] = [];
  const warnings: string[] = [];

  if (
    supportedStore(store, supportedLocalModes) ||
    (managedStoreRequested(store) && managedPostgresSupported)
  ) {
    pushCheck(
      checks,
      "supported-runtime-store",
      "pass",
      managedStoreRequested(store)
        ? `PACKETAGENT_STORE=${store} is allowed by a recognized managed Postgres adapter and managed database URL.`
        : store === "sqlite"
          ? "PACKETAGENT_STORE=sqlite is supported only for single-node SQLite runtime."
          : "PACKETAGENT_STORE is using the supported local JSON runtime.",
    );
  } else {
    pushCheck(
      checks,
      "supported-runtime-store",
      "fail",
      MANAGED_TOPOLOGY_HINTS.has(store)
        ? `PACKETAGENT_STORE=${store} crosses the managed database runtime boundary; a recognized managed Postgres adapter and managed database URL are required for the app startup path to be supported.`
        : `PACKETAGENT_STORE=${store} is not a supported runtime storage mode.`,
    );
  }

  pushCheck(
    checks,
    "managed-database-runtime",
    hasManagedIntent && !managedPostgresSupported ? "fail" : "pass",
    hasManagedIntent
      ? managedPostgresSupported
        ? "Managed database runtime intent is allowed; a recognized managed Postgres adapter and managed database URL are configured."
        : "Managed database runtime intent requires a recognized managed Postgres adapter (PACKETAGENT_MANAGED_DATABASE_ADAPTER) and a managed database URL."
      : "No managed database URL or managed database runtime hint was detected.",
  );

  if (store === "sqlite" && !configured(env.PACKETAGENT_DB_PATH)) {
    warnings.push(
      `PACKETAGENT_DB_PATH is not set; SQLite will use the default local path ${DEFAULT_SQLITE_PATH}.`,
    );
  }
  if (hasManagedDatabaseUrl) {
    warnings.push(
      managedPostgresSupported
        ? "Managed database URL values were redacted; they are allowed by the recognized managed Postgres adapter."
        : "Managed database URL values were redacted and require a recognized managed Postgres adapter.",
    );
  }
  if (adapter.length > 0 && !managedPostgresSupported) {
    warnings.push(
      "PACKETAGENT_MANAGED_DATABASE_ADAPTER is configured, but managed Postgres support also requires a recognized postgres adapter value and a managed database URL.",
    );
  }
  if (bypassEnabled) {
    warnings.push(
      `${BYPASS_ENV_KEY}=true bypassed the managed database runtime guard for emergency or development-only use.`,
    );
  }

  const blockers = checks.filter((check) => check.status === "fail").map((check) => check.summary);
  const managedDatabaseRuntimeBlocked = hasManagedIntent && !managedPostgresSupported;
  const allowed = blockers.length === 0 || bypassEnabled;
  const status = statusFromChecks(checks, bypassEnabled);

  let classification: ManagedDatabaseRuntimeGuardClassification;
  if (bypassEnabled) {
    classification = "bypassed";
  } else if (hasManagedIntent && managedPostgresSupported) {
    classification = "managed-postgres";
  } else if (hasManagedIntent) {
    classification = "managed-database-blocked";
  } else if (!supportedStore(store, supportedLocalModes)) {
    classification = "unsupported-store";
  } else {
    classification = store === "sqlite" ? "single-node-sqlite" : "local-json";
  }

  const summary = allowed
    ? bypassEnabled
      ? "Managed database runtime guard was bypassed; unsupported runtime configuration remains present."
      : hasManagedIntent && managedPostgresSupported
        ? "Managed database runtime guard allows managed Postgres startup with a recognized adapter and managed database URL."
        : store === "sqlite"
          ? "Managed database runtime guard allows supported single-node SQLite runtime."
          : "Managed database runtime guard allows supported local JSON runtime."
    : "Managed database runtime guard blocked unsupported managed database runtime configuration.";

  const observedEnv = buildObservedEnv(env);

  return {
    allowed,
    managedDatabaseRuntimeBlocked,
    status,
    classification,
    summary,
    checks,
    blockers,
    warnings,
    nextSteps: buildNextSteps(checks, bypassEnabled),
    observed: {
      nodeEnv,
      store,
      dbPath: store === "sqlite" ? clean(env.PACKETAGENT_DB_PATH) || DEFAULT_SQLITE_PATH : null,
      databaseTopology: databaseTopology || null,
      bypassEnabled,
      managedDatabaseUrl: observedEnv.PACKETAGENT_MANAGED_DATABASE_URL.value,
      databaseUrl: observedEnv.DATABASE_URL.value,
      packetagentDatabaseUrl: observedEnv.PACKETAGENT_DATABASE_URL.value,
      managedDatabaseAdapter: adapter || null,
      env: observedEnv,
    },
  };
}

export function buildManagedDatabaseRuntimeGuardReport(
  env: ManagedDatabaseRuntimeGuardEnv = {},
  deps: ManagedDatabaseRuntimeGuardDeps = {},
): ManagedDatabaseRuntimeGuardReport {
  return assessManagedDatabaseRuntimeGuard({ env, ...deps });
}

export function assertManagedDatabaseRuntimeSupported(
  env: ManagedDatabaseRuntimeGuardEnv = {},
  deps: ManagedDatabaseRuntimeGuardDeps = {},
): ManagedDatabaseRuntimeGuardReport {
  const report = buildManagedDatabaseRuntimeGuardReport(env, deps);
  if (!report.allowed) throw new ManagedDatabaseRuntimeGuardError(report);
  return report;
}
