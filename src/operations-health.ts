import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import {
  loadStore as defaultLoadStore,
  loadStoreAsync as defaultLoadStoreAsync,
} from "./packetagent-store.js";
import {
  getSchedulerHeartbeat as defaultSchedulerHeartbeat,
  type SchedulerHeartbeat,
} from "./jobs/scheduler-heartbeat.js";
import { redactedErrorMessage } from "./security/redaction.js";
import {
  getDefaultSandboxService as defaultGetSandboxService,
  type SandboxServiceHealthSnapshot,
} from "./sandbox/sandbox-service.js";

export type SubsystemStatus = "ok" | "degraded" | "down" | "disabled";

export interface SubsystemHealth {
  name: string;
  status: SubsystemStatus;
  detail: string;
  checkedAt: string;
  observedAt?: string;
}

export interface OperationsHealthReport {
  generatedAt: string;
  overall: SubsystemStatus;
  subsystems: SubsystemHealth[];
}

export interface OperationsHealthDeps {
  loadStore?: () => unknown;
  schedulerHeartbeat?: () => SchedulerHeartbeat;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  fileExists?: (path: string) => boolean;
  schedulerStaleAfterMs?: number;
  sandboxHealth?: () => SandboxServiceHealthSnapshot | Promise<SandboxServiceHealthSnapshot>;
}

export interface OperationsHealthAsyncDeps extends Omit<OperationsHealthDeps, "loadStore"> {
  loadStore?: () => unknown | Promise<unknown>;
}

const DEFAULT_SCHEDULER_STALE_AFTER_MS = 60_000;

function checkStore(loadStore: () => unknown, checkedAt: string): SubsystemHealth {
  try {
    const result = loadStore();
    if (result && typeof result === "object") {
      return { name: "store", status: "ok", detail: "loaded successfully", checkedAt };
    }
    return {
      name: "store",
      status: "down",
      detail: "store returned an unexpected shape",
      checkedAt,
    };
  } catch (error) {
    return {
      name: "store",
      status: "down",
      detail: `store load failed: ${redactedErrorMessage(error)}`,
      checkedAt,
    };
  }
}

async function checkStoreAsync(
  loadStore: () => unknown | Promise<unknown>,
  checkedAt: string,
): Promise<SubsystemHealth> {
  try {
    const result = await loadStore();
    if (result && typeof result === "object") {
      return { name: "store", status: "ok", detail: "loaded successfully", checkedAt };
    }
    return {
      name: "store",
      status: "down",
      detail: "store returned an unexpected shape",
      checkedAt,
    };
  } catch (error) {
    return {
      name: "store",
      status: "down",
      detail: `store load failed: ${redactedErrorMessage(error)}`,
      checkedAt,
    };
  }
}

function checkScheduler(
  heartbeat: SchedulerHeartbeat,
  now: Date,
  staleAfterMs: number,
  checkedAt: string,
): SubsystemHealth {
  if (heartbeat.schedulerStartedAt === null) {
    return {
      name: "scheduler",
      status: "down",
      detail: "scheduler has not been started in this process",
      checkedAt,
    };
  }
  if (heartbeat.lastTickEndedAt === null) {
    return {
      name: "scheduler",
      status: "degraded",
      detail: "scheduler has started but no tick has completed yet",
      checkedAt,
    };
  }
  const tickEndedMs = Date.parse(heartbeat.lastTickEndedAt);
  const tickAge = now.getTime() - tickEndedMs;
  if (tickAge > staleAfterMs) {
    const seconds = Math.round(tickAge / 1000);
    return {
      name: "scheduler",
      status: "degraded",
      detail: `last tick was ${seconds}s ago`,
      checkedAt,
      observedAt: heartbeat.lastTickEndedAt,
    };
  }
  return {
    name: "scheduler",
    status: "ok",
    detail: `last tick ${tickAge}ms ago, ticksSinceStart=${heartbeat.ticksSinceStart}`,
    checkedAt,
    observedAt: heartbeat.lastTickEndedAt,
  };
}

function checkAccessLog(
  env: NodeJS.ProcessEnv,
  fileExists: (path: string) => boolean,
  checkedAt: string,
): SubsystemHealth {
  const mode = (env.PACKETAGENT_ACCESS_LOG_MODE ?? "").trim().toLowerCase() || "off";
  if (mode === "off") {
    return { name: "accessLog", status: "disabled", detail: "access log is off", checkedAt };
  }
  if (mode === "stdout") {
    return { name: "accessLog", status: "ok", detail: "writing to stdout", checkedAt };
  }
  if (mode === "file") {
    const rawPath = env.PACKETAGENT_ACCESS_LOG_PATH;
    if (typeof rawPath !== "string" || rawPath.length === 0) {
      return {
        name: "accessLog",
        status: "down",
        detail: "file mode requires PACKETAGENT_ACCESS_LOG_PATH",
        checkedAt,
      };
    }
    const resolved = resolvePath(process.cwd(), rawPath);
    const parent = dirname(resolved);
    if (!fileExists(parent)) {
      return {
        name: "accessLog",
        status: "down",
        detail: `access log directory does not exist: ${parent}`,
        checkedAt,
      };
    }
    if (!fileExists(resolved)) {
      return {
        name: "accessLog",
        status: "degraded",
        detail: `access log file does not exist yet: ${resolved}`,
        checkedAt,
      };
    }
    return { name: "accessLog", status: "ok", detail: `file present at ${resolved}`, checkedAt };
  }
  return { name: "accessLog", status: "disabled", detail: "access log is off", checkedAt };
}

function checkSandboxSync(env: NodeJS.ProcessEnv, checkedAt: string): SubsystemHealth {
  const requested = (env.PACKETAGENT_SANDBOX_DRIVER ?? "auto").toLowerCase();
  const driver = requested === "native" ? "native" : requested === "docker" ? "docker" : "auto";
  return {
    name: "sandbox",
    status: "ok",
    detail: `sandbox subsystem configured (driver=${driver})`,
    checkedAt,
  };
}

async function checkSandboxAsync(
  snapshotFn: () => SandboxServiceHealthSnapshot | Promise<SandboxServiceHealthSnapshot>,
  checkedAt: string,
): Promise<SubsystemHealth> {
  try {
    const snapshot = await snapshotFn();
    const readyRuntimes = snapshot.runtimes.filter((entry) => entry.ready).length;
    const failureCount = snapshot.recentFailures.length;
    const status: SubsystemStatus = snapshot.available
      ? failureCount > 0
        ? "degraded"
        : "ok"
      : "degraded";
    const detailParts = [
      `driver=${snapshot.driver}`,
      `available=${snapshot.available}`,
      `runtimesReady=${readyRuntimes}/${snapshot.runtimes.length}`,
      `activeExecs=${snapshot.activeExecs}`,
      `recentFailures=${failureCount}`,
    ];
    if (snapshot.note) detailParts.push(snapshot.note);
    return {
      name: "sandbox",
      status,
      detail: detailParts.join("; "),
      checkedAt,
    };
  } catch (error) {
    return {
      name: "sandbox",
      status: "down",
      detail: `sandbox health probe failed: ${redactedErrorMessage(error)}`,
      checkedAt,
    };
  }
}

function reduceOverall(subsystems: SubsystemHealth[]): SubsystemStatus {
  let result: SubsystemStatus = "ok";
  for (const subsystem of subsystems) {
    if (subsystem.status === "down") return "down";
    if (subsystem.status === "degraded") result = "degraded";
  }
  return result;
}

export function getOperationsHealth(deps: OperationsHealthDeps = {}): OperationsHealthReport {
  const loadStore = deps.loadStore ?? defaultLoadStore;
  const schedulerHeartbeat = deps.schedulerHeartbeat ?? defaultSchedulerHeartbeat;
  const env = deps.env ?? process.env;
  const now = (deps.now ?? (() => new Date()))();
  const fileExists = deps.fileExists ?? existsSync;
  const staleAfterMs = deps.schedulerStaleAfterMs ?? DEFAULT_SCHEDULER_STALE_AFTER_MS;
  const checkedAt = now.toISOString();

  const subsystems: SubsystemHealth[] = [
    checkStore(loadStore, checkedAt),
    checkScheduler(schedulerHeartbeat(), now, staleAfterMs, checkedAt),
    checkAccessLog(env, fileExists, checkedAt),
    checkSandboxSync(env, checkedAt),
  ];

  return {
    generatedAt: checkedAt,
    overall: reduceOverall(subsystems),
    subsystems,
  };
}

export async function getOperationsHealthAsync(
  deps: OperationsHealthAsyncDeps = {},
): Promise<OperationsHealthReport> {
  const loadStore = deps.loadStore ?? defaultLoadStoreAsync;
  const schedulerHeartbeat = deps.schedulerHeartbeat ?? defaultSchedulerHeartbeat;
  const env = deps.env ?? process.env;
  const now = (deps.now ?? (() => new Date()))();
  const fileExists = deps.fileExists ?? existsSync;
  const staleAfterMs = deps.schedulerStaleAfterMs ?? DEFAULT_SCHEDULER_STALE_AFTER_MS;
  const checkedAt = now.toISOString();

  const sandboxSnapshotFn =
    deps.sandboxHealth ?? (() => defaultGetSandboxService().getHealthSnapshot());
  const subsystems: SubsystemHealth[] = [
    await checkStoreAsync(loadStore, checkedAt),
    checkScheduler(schedulerHeartbeat(), now, staleAfterMs, checkedAt),
    checkAccessLog(env, fileExists, checkedAt),
    await checkSandboxAsync(sandboxSnapshotFn, checkedAt),
  ];

  return {
    generatedAt: checkedAt,
    overall: reduceOverall(subsystems),
    subsystems,
  };
}
