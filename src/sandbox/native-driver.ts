/**
 * Native (no-isolation) sandbox driver.
 *
 * This is a fallback for hosts that do not have Docker available. It runs the
 * supplied command via `child_process.spawn({ shell: true })` on the host
 * directly. There is NO isolation: filesystem, network, env, and process
 * trees are all shared with the host. This is clearly insecure and is only
 * intended for development boxes that opt in via PACKETAGENT_SANDBOX_DRIVER=native
 * or by simply having no Docker installed.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type {
  SandboxChunkListener,
  SandboxDriver,
  SandboxExitListener,
  SandboxHandle,
  SandboxRuntimeDescriptor,
  SandboxStartSpec,
  SandboxSubscription,
} from "./sandbox-driver.js";

interface NativeHandleInternal extends SandboxHandle {
  child: ChildProcessWithoutNullStreams;
  emitter: EventEmitter;
  killTimer: NodeJS.Timeout | null;
  exited: boolean;
  forcedTimeout: boolean;
}

function forceKill(child: ChildProcessWithoutNullStreams): void {
  if (child.killed) return;
  if (process.platform === "win32" && child.pid !== undefined) {
    // SIGKILL is a no-op for shell-spawned children on Windows. Use taskkill
    // to terminate the process tree instead.
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* ignore */
  }
}

const NATIVE_RUNTIMES: SandboxRuntimeDescriptor[] = [
  { id: "host", ready: true, description: "host shell (no isolation)" },
  { id: "node-20", ready: true, description: "host node (no isolation)" },
  { id: "python-3.11", ready: true, description: "host python (no isolation)" },
  { id: "ubuntu-22", ready: true, description: "host shell (no isolation)" },
];

export interface NativeDriverDeps {
  spawnImpl?: typeof spawn;
}

/**
 * Non-secret host environment variables that are safe to forward to the
 * untrusted child. We do NOT pass `...process.env` because that leaks secrets
 * (MASTER_KEY, provider API keys, DATABASE_URL, etc.) into generated code.
 * Only the minimum needed for binaries and the shell to resolve and run.
 */
const ALLOWED_HOST_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "TZ",
  // Windows shell needs these to locate cmd.exe and system binaries.
  "SystemRoot",
  "windir",
  "COMSPEC",
  "PATHEXT",
];

function buildChildEnv(specEnv?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ALLOWED_HOST_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // Caller-provided env wins and is the only channel for additional values.
  return { ...env, ...(specEnv ?? {}) };
}

export function createNativeDriver(deps: NativeDriverDeps = {}): SandboxDriver {
  const spawnFn = deps.spawnImpl ?? spawn;

  return {
    id: "native",

    async available(): Promise<boolean> {
      return true;
    },

    runtimes(): SandboxRuntimeDescriptor[] {
      return NATIVE_RUNTIMES.map((entry) => ({ ...entry }));
    },

    async start(spec: SandboxStartSpec): Promise<SandboxHandle> {
      const emitter = new EventEmitter();
      const child = spawnFn(spec.command, {
        cwd: spec.workingDir,
        env: buildChildEnv(spec.env),
        shell: true,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;

      const handle: NativeHandleInternal = {
        sandboxId: `native:${child.pid ?? "unknown"}`,
        child,
        emitter,
        killTimer: null,
        exited: false,
        forcedTimeout: false,
        done: new Promise<void>(() => {}),
      };

      handle.done = new Promise<void>((resolve) => {
        const finalize = () => {
          if (handle.killTimer) {
            clearTimeout(handle.killTimer);
            handle.killTimer = null;
          }
          resolve();
        };
        child.once("close", finalize);
        child.once("error", finalize);
      });

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (data: string) => {
        emitter.emit("chunk", { stream: "stdout", data });
      });
      child.stderr.on("data", (data: string) => {
        emitter.emit("chunk", { stream: "stderr", data });
      });
      child.on("error", (err) => {
        if (handle.exited) return;
        handle.exited = true;
        emitter.emit("exit", {
          exitCode: null,
          signal: null,
          errorMessage: err.message,
        });
      });
      child.on("close", (code, signal) => {
        if (handle.exited) return;
        handle.exited = true;
        emitter.emit("exit", {
          exitCode: typeof code === "number" ? code : null,
          signal: signal ?? null,
          ...(handle.forcedTimeout ? { errorMessage: "execution timed out" } : {}),
        });
      });

      if (spec.stdin !== undefined) {
        try {
          child.stdin.end(spec.stdin);
        } catch {
          /* stdin closed before write – ignore */
        }
      } else {
        try {
          child.stdin.end();
        } catch {
          /* ignore */
        }
      }

      if (spec.timeoutMs > 0) {
        handle.killTimer = setTimeout(() => {
          if (handle.exited) return;
          handle.forcedTimeout = true;
          forceKill(child);
        }, spec.timeoutMs);
      }

      return handle;
    },

    async cancel(handle: SandboxHandle): Promise<void> {
      const internal = handle as NativeHandleInternal;
      if (internal.exited) return;
      forceKill(internal.child);
    },

    subscribe(
      handle: SandboxHandle,
      onChunk: SandboxChunkListener,
      onExit: SandboxExitListener,
    ): SandboxSubscription {
      const internal = handle as NativeHandleInternal;
      internal.emitter.on("chunk", onChunk);
      internal.emitter.once("exit", onExit);
      return {
        unsubscribe() {
          internal.emitter.off("chunk", onChunk);
          internal.emitter.off("exit", onExit);
        },
      };
    },
  };
}
