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

export interface SandboxEgressRequest {
  id: string;
  url: string;
}

export interface SandboxEgressReceipt {
  id: string;
  /** Query values are never persisted. */
  target: string;
  origin: string;
  method: "GET";
  status: "declared" | "materialized";
  mountPath: string;
  responseStatus?: number;
  contentType?: string;
  byteLength?: number;
  sha256?: string;
  connectedAddress?: string;
}

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
  networkPolicy?: "none" | "brokered-prefetch" | "host";
  filesystemPolicy?: "read-only-root+bounded-tmpfs" | "host";
  environmentPolicy?: "validated-explicit" | "scrubbed-host+validated-explicit";
  egress?: SandboxEgressReceipt[];
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
  egressPolicy: "deny-all" | "brokered-prefetch";
  egressAllowedOrigins: string[];
  egressMaxFetches: number;
  egressMaxResponseBytes: number;
  note?: string;
}

export interface SandboxExecRequestBody {
  appId?: string;
  checkpointId?: string;
  command: string;
  runtime?: string;
  workingDir?: string;
  env?: Record<string, string>;
  egress?: SandboxEgressRequest[];
  timeoutMs?: number;
  stdin?: string;
}
