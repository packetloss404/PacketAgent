import { posix } from "node:path";
import type { SandboxDriverId } from "./sandbox-driver.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MEMORY_MB = 512;
const DEFAULT_CPUS = 1;
const DEFAULT_PIDS = 64;
const DEFAULT_TMPFS_MB = 256;

const MAX_COMMAND_BYTES = 32 * 1024;
const MAX_STDIN_BYTES = 64 * 1024;
const MAX_ENV_ENTRIES = 32;
const MAX_ENV_NAME_BYTES = 64;
const MAX_ENV_VALUE_BYTES = 4 * 1024;
const MAX_ENV_TOTAL_BYTES = 32 * 1024;

const DOCKER_WORKING_ROOTS = ["/workspace", "/tmp"] as const;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN_ENV_NAME =
  /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|DATABASE_URL)(?:$|_)/i;
const DANGEROUS_ENV_NAME =
  /^(?:PATH|HOME|NODE_OPTIONS|BUN_OPTIONS|DENO_.+|LD_.+|DYLD_.+|DOCKER_.+|CONTAINER_.+|KUBECONFIG|COMSPEC|SYSTEMROOT|WINDIR)$/i;

export type SandboxNetworkPolicy = "none" | "host";
export type SandboxFilesystemPolicy = "read-only-root+bounded-tmpfs" | "host";
export type SandboxEnvironmentPolicy = "validated-explicit" | "scrubbed-host+validated-explicit";

export interface SandboxExecutionPolicy {
  driver: SandboxDriverId;
  timeoutMs: number;
  memoryLimitMb: number;
  cpus: number;
  pidsLimit: number;
  tmpfsSizeMb: number;
  workingDir: string;
  env: Record<string, string>;
  networkPolicy: SandboxNetworkPolicy;
  filesystemPolicy: SandboxFilesystemPolicy;
  environmentPolicy: SandboxEnvironmentPolicy;
}

export interface SandboxPolicyInput {
  driver: SandboxDriverId;
  command: string;
  workingDir: string;
  requestedEnv?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  configEnv: NodeJS.ProcessEnv;
}

export function resolveSandboxExecutionPolicy(input: SandboxPolicyInput): SandboxExecutionPolicy {
  validateBoundedText("command", input.command, MAX_COMMAND_BYTES, false);
  if (input.stdin !== undefined) validateBoundedText("stdin", input.stdin, MAX_STDIN_BYTES, true);

  const maxTimeoutMs = boundedConfigNumber(
    input.configEnv.PACKETAGENT_SANDBOX_MAX_TIMEOUT_MS,
    DEFAULT_MAX_TIMEOUT_MS,
    1_000,
    15 * 60_000,
  );
  const defaultTimeoutMs = Math.min(
    boundedConfigNumber(
      input.configEnv.PACKETAGENT_SANDBOX_DEFAULT_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      1_000,
      15 * 60_000,
    ),
    maxTimeoutMs,
  );
  const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > maxTimeoutMs) {
    throw policyError(`timeoutMs must be between 1 and ${maxTimeoutMs}`);
  }

  const workingDir =
    input.driver === "docker" ? validatedDockerWorkingDir(input.workingDir) : input.workingDir;
  if (workingDir.includes("\0")) throw policyError("workingDir must not contain null bytes");

  return {
    driver: input.driver,
    timeoutMs: Math.floor(timeoutMs),
    memoryLimitMb: boundedConfigNumber(
      input.configEnv.PACKETAGENT_SANDBOX_MEMORY_MB,
      DEFAULT_MEMORY_MB,
      64,
      8_192,
    ),
    cpus: boundedConfigNumber(input.configEnv.PACKETAGENT_SANDBOX_CPUS, DEFAULT_CPUS, 0.1, 8),
    pidsLimit: Math.floor(
      boundedConfigNumber(input.configEnv.PACKETAGENT_SANDBOX_PIDS_LIMIT, DEFAULT_PIDS, 16, 512),
    ),
    tmpfsSizeMb: Math.floor(
      boundedConfigNumber(
        input.configEnv.PACKETAGENT_SANDBOX_TMPFS_MB,
        DEFAULT_TMPFS_MB,
        64,
        1_024,
      ),
    ),
    workingDir,
    env: validatedExplicitEnvironment(input.requestedEnv),
    networkPolicy: input.driver === "docker" ? "none" : "host",
    filesystemPolicy: input.driver === "docker" ? "read-only-root+bounded-tmpfs" : "host",
    environmentPolicy:
      input.driver === "docker" ? "validated-explicit" : "scrubbed-host+validated-explicit",
  };
}

export function redactedSandboxEnvironment(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(env).map((key) => [key, "[redacted]"]));
}

function validatedDockerWorkingDir(value: string): string {
  if (!value.startsWith("/") || value.includes("\\") || value.includes("\0")) {
    throw policyError("Docker workingDir must be an absolute container path");
  }
  const normalized = posix.normalize(value);
  if (
    !DOCKER_WORKING_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`))
  ) {
    throw policyError("Docker workingDir must stay under /workspace or /tmp");
  }
  return normalized;
}

function validatedExplicitEnvironment(
  requested: Record<string, string> | undefined,
): Record<string, string> {
  if (!requested) return {};
  const entries = Object.entries(requested);
  if (entries.length > MAX_ENV_ENTRIES) {
    throw policyError(`sandbox env may contain at most ${MAX_ENV_ENTRIES} entries`);
  }

  let totalBytes = 0;
  const result: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (
      !ENV_NAME.test(key) ||
      Buffer.byteLength(key) > MAX_ENV_NAME_BYTES ||
      DANGEROUS_ENV_NAME.test(key) ||
      FORBIDDEN_ENV_NAME.test(key)
    ) {
      throw policyError(`sandbox env name is not allowed: ${key}`);
    }
    if (typeof value !== "string" || value.includes("\0")) {
      throw policyError(`sandbox env value must be a null-free string: ${key}`);
    }
    const valueBytes = Buffer.byteLength(value);
    if (valueBytes > MAX_ENV_VALUE_BYTES) {
      throw policyError(`sandbox env value is too large: ${key}`);
    }
    totalBytes += Buffer.byteLength(key) + valueBytes;
    if (totalBytes > MAX_ENV_TOTAL_BYTES) {
      throw policyError(`sandbox env exceeds ${MAX_ENV_TOTAL_BYTES} bytes`);
    }
    result[key] = value;
  }
  return result;
}

function validateBoundedText(
  field: string,
  value: string,
  maxBytes: number,
  allowEmpty: boolean,
): void {
  if (typeof value !== "string" || value.includes("\0")) {
    throw policyError(`${field} must be a null-free string`);
  }
  const bytes = Buffer.byteLength(value);
  if ((!allowEmpty && value.trim().length === 0) || bytes > maxBytes) {
    throw policyError(`${field} must contain 1-${maxBytes} bytes`);
  }
}

function boundedConfigNumber(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function policyError(message: string): Error {
  return Object.assign(new Error(`sandbox policy: ${message}`), { status: 400 });
}

export const SANDBOX_POLICY_LIMITS = {
  maxCommandBytes: MAX_COMMAND_BYTES,
  maxStdinBytes: MAX_STDIN_BYTES,
  maxEnvEntries: MAX_ENV_ENTRIES,
  maxEnvNameBytes: MAX_ENV_NAME_BYTES,
  maxEnvValueBytes: MAX_ENV_VALUE_BYTES,
  maxEnvTotalBytes: MAX_ENV_TOTAL_BYTES,
  dockerWorkingRoots: DOCKER_WORKING_ROOTS,
} as const;
