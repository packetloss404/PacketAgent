/**
 * Shared sandbox API contract.
 *
 * The frontend (`web/src/...`) maintains its own copy of these shapes — keep
 * the two in sync. Any breaking change here MUST be coordinated with the
 * frontend owner.
 */

export type SandboxDriver = "docker" | "native";

export type SandboxExecStatus =
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "timeout"
  | "canceled";

export interface SandboxExecRecord {
  id: string;
  workspaceId: string;
  appId?: string;
  checkpointId?: string;
  /** Driver-specific identifier. For docker, this is the container name; for
   * native, it is `native:<pid>`. */
  sandboxId: string;
  driver: SandboxDriver;
  runtime: string;
  command: string;
  workingDir: string;
  env?: Record<string, string>;
  status: SandboxExecStatus;
  exitCode?: number;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  stdoutPreview?: string;
  stderrPreview?: string;
  errorMessage?: string;
  /** Legacy name retained for persisted compatibility; equals wallClockTimeoutMs. */
  cpuLimitMs?: number;
  wallClockTimeoutMs?: number;
  cpuLimit?: number;
  memoryLimitMb?: number;
  processLimit?: number;
  tmpfsSizeMb?: number;
  networkPolicy?: "none" | "host";
  filesystemPolicy?: "read-only-root+bounded-tmpfs" | "host";
  environmentPolicy?: "validated-explicit" | "scrubbed-host+validated-explicit";
  createdAt: string;
  updatedAt: string;
}

export interface SandboxRuntimeView {
  id: string;
  ready: boolean;
  image?: string;
  description?: string;
}

export interface SandboxStatusView {
  driver: SandboxDriver;
  available: boolean;
  executionClass: "isolated" | "trusted-host-only";
  untrustedCodeSupported: boolean;
  runtimes: SandboxRuntimeView[];
  note?: string;
}

export interface SandboxExecRequestBody {
  appId?: string;
  checkpointId?: string;
  command: string;
  runtime?: string;
  workingDir?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
}
