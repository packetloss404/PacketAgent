import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { fileLeaderLock, noopLeaderLock, type SchedulerLeaderLock } from "./scheduler-lock.js";
import { httpLeaderLock } from "./scheduler-http-coordinator.js";

export interface SchedulerLeaderEnv {
  [key: string]: string | undefined;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_HTTP_TIMEOUT_MS = 5_000;
const DEFAULT_FILE_PATH = "data/scheduler-leader.json";

function defaultProcessId(): string {
  return `${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;
}

function resolveTtlMs(env: SchedulerLeaderEnv): number {
  const raw = env.PACKETAGENT_SCHEDULER_LEADER_TTL_MS;
  if (raw === undefined) return DEFAULT_TTL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTL_MS;
  return parsed;
}

function resolveHttpTimeoutMs(env: SchedulerLeaderEnv): number {
  const raw = env.PACKETAGENT_SCHEDULER_LEADER_HTTP_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_HTTP_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_HTTP_TIMEOUT_MS;
  return parsed;
}

function resolveProcessId(env: SchedulerLeaderEnv): string {
  const override = env.PACKETAGENT_SCHEDULER_LEADER_PROCESS_ID;
  if (override && override.length > 0) return override;
  return defaultProcessId();
}

export function selectSchedulerLeaderLock(
  env: SchedulerLeaderEnv = process.env,
): SchedulerLeaderLock {
  const rawMode = env.PACKETAGENT_SCHEDULER_LEADER_MODE;
  const mode = rawMode === undefined ? "off" : rawMode.trim().toLowerCase();

  if (rawMode === undefined && mode === "off") {
    return noopLeaderLock();
  }

  if (mode === "off") {
    return noopLeaderLock();
  }

  if (mode === "file") {
    const path = env.PACKETAGENT_SCHEDULER_LEADER_FILE_PATH ?? DEFAULT_FILE_PATH;
    return fileLeaderLock({
      path,
      processId: resolveProcessId(env),
      ttlMs: resolveTtlMs(env),
    });
  }

  if (mode === "http") {
    const url = env.PACKETAGENT_SCHEDULER_LEADER_HTTP_URL;
    if (!url || url.length === 0) {
      throw new Error(
        'PACKETAGENT_SCHEDULER_LEADER_HTTP_URL must be set when PACKETAGENT_SCHEDULER_LEADER_MODE="http"',
      );
    }
    const secret = env.PACKETAGENT_SCHEDULER_LEADER_HTTP_SECRET;
    const failOpen = env.PACKETAGENT_SCHEDULER_LEADER_HTTP_FAIL_OPEN === "true";
    return httpLeaderLock({
      url,
      processId: resolveProcessId(env),
      ttlMs: resolveTtlMs(env),
      secret,
      timeoutMs: resolveHttpTimeoutMs(env),
      failOpen,
    });
  }

  throw new Error(
    `PACKETAGENT_SCHEDULER_LEADER_MODE must be one of: off, file, http (got: "${rawMode ?? ""}")`,
  );
}
