import { getDefaultSandboxService, type SandboxExecRequest } from "../sandbox/sandbox-service.js";
import type { SandboxDriver } from "../sandbox/sandbox-driver.js";
import type { SandboxExecRecord } from "../sandbox/types.js";

export interface WorkerSandboxRequest {
  readonly workspaceId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly network: "none";
}

export interface WorkerSandboxResult {
  readonly execId: string;
  readonly status: "success" | "failed" | "timeout" | "canceled";
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

export interface WorkerSandboxPort {
  execute(input: WorkerSandboxRequest): Promise<WorkerSandboxResult>;
}

export interface WorkerSandboxService {
  resolveDriver(): Promise<SandboxDriver>;
  startExec(request: SandboxExecRequest): Promise<SandboxExecRecord>;
  waitForExec(id: string): Promise<SandboxExecRecord | null>;
  cancelExec(workspaceId: string, id: string): Promise<SandboxExecRecord | null>;
}

export function createWorkerSandboxPort(
  service: WorkerSandboxService = getDefaultSandboxService(),
): WorkerSandboxPort {
  return {
    async execute(input) {
      if (input.network !== "none") {
        throw new Error("Worker sandbox execution requires an explicit deny-all network policy.");
      }
      const driver = await service.resolveDriver();
      if (driver.id !== "docker") {
        throw new Error("Autonomous Worker execution requires the isolated Docker sandbox driver.");
      }
      if (input.signal.aborted) throw abortError(input.signal);

      const started = await service.startExec({
        workspaceId: input.workspaceId,
        command: [input.command, ...input.args].map(shellQuote).join(" "),
        runtime: runtimeForCommand(input.command),
        workingDir: "/tmp",
        timeoutMs: input.timeoutMs,
        env: {},
      });
      const onAbort = (): void => {
        void service.cancelExec(input.workspaceId, started.id);
      };
      input.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const completed = (await service.waitForExec(started.id)) ?? started;
        return {
          execId: completed.id,
          status:
            completed.status === "queued" || completed.status === "running"
              ? "failed"
              : completed.status,
          ...(completed.exitCode === undefined ? {} : { exitCode: completed.exitCode }),
          stdout: completed.stdoutPreview ?? "",
          stderr: completed.stderrPreview ?? "",
          ...(completed.errorMessage ? { error: completed.errorMessage } : {}),
        };
      } finally {
        input.signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

function runtimeForCommand(command: string): string {
  if (command === "node" || command === "npm") return "node-20";
  if (command === "python" || command === "python3") return "python-3.11";
  return "ubuntu-22";
}

function shellQuote(value: string): string {
  if (value.includes("\0"))
    throw new Error("Worker sandbox arguments must not contain null bytes.");
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(typeof signal.reason === "string" ? signal.reason : "aborted");
}
