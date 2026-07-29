/**
 * Sandbox driver interface.
 *
 * Drivers are the only place in the sandbox subsystem that touches process
 * spawning, container lifecycles, or the host filesystem. The orchestrator
 * (sandbox-service.ts) consumes this contract so that tests can substitute a
 * fake driver without spawning real processes.
 */

export type SandboxDriverId = "docker" | "native";

export interface SandboxRuntimeDescriptor {
  id: string;
  ready: boolean;
  image?: string;
  description?: string;
}

export interface SandboxStartSpec {
  /** Stable identifier for tracing/logging only. */
  execId: string;
  runtime: string;
  command: string;
  workingDir: string;
  env?: Record<string, string>;
  stdin?: string;
  /** Hard wall-clock timeout (ms). The orchestrator also enforces this; the
   * driver may use it to set its own kill timer if it has one. */
  timeoutMs: number;
  memoryLimitMb?: number;
  cpus?: number;
  pidsLimit?: number;
  tmpfsSizeMb?: number;
  networkPolicy?: "none" | "host";
  /** Trusted internal image override. Public sandbox routes do not expose it. */
  image?: string;
  /** Trusted internal bind mounts. Public sandbox routes do not expose them. */
  mounts?: ReadonlyArray<{
    source: string;
    target: string;
    readOnly?: boolean;
  }>;
}

export interface SandboxHandle {
  /** Driver-specific identifier (container id, pid namespace id, etc.). */
  sandboxId: string;
  /** Resolves when the underlying process is fully torn down. */
  done: Promise<void>;
}

export type SandboxStreamName = "stdout" | "stderr";

export interface SandboxChunkEvent {
  stream: SandboxStreamName;
  data: string;
}

export interface SandboxExitEvent {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Optional error message produced by the driver itself (e.g. spawn failure
   * or timeout). The orchestrator translates this into status=failed/timeout. */
  errorMessage?: string;
}

export type SandboxChunkListener = (event: SandboxChunkEvent) => void;
export type SandboxExitListener = (event: SandboxExitEvent) => void;

export interface SandboxSubscription {
  unsubscribe(): void;
}

export interface SandboxDriver {
  readonly id: SandboxDriverId;
  available(): Promise<boolean>;
  runtimes(): SandboxRuntimeDescriptor[];
  start(spec: SandboxStartSpec): Promise<SandboxHandle>;
  cancel(handle: SandboxHandle): Promise<void>;
  subscribe(
    handle: SandboxHandle,
    onChunk: SandboxChunkListener,
    onExit: SandboxExitListener,
  ): SandboxSubscription;
}
