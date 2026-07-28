/**
 * Docker sandbox driver.
 *
 * Shells out to the `docker` binary that is expected to be on PATH. We do
 * NOT take a runtime dependency on `dockerode` so that the API surface stays
 * trivially mockable and so the project does not pull in another npm dep.
 *
 * Each exec runs in its own short-lived container with these guard rails:
 *   docker run --rm -i \
 *     --network=none \
 *     --cpus=<cpus> \
 *     --memory=<memory>m \
 *     --pids-limit=64 \
 *     --cap-drop=ALL \
 *     --security-opt=no-new-privileges:true \
 *     --user=65534:65534 \
 *     --read-only \
 *     --tmpfs /tmp \
 *     -w <workingDir> \
 *     <image> sh -c <command>
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type {
  SandboxChunkListener,
  SandboxDriver,
  SandboxExitListener,
  SandboxHandle,
  SandboxRuntimeDescriptor,
  SandboxStartSpec,
  SandboxSubscription,
} from "./sandbox-driver.js";

interface DockerHandleInternal extends SandboxHandle {
  containerName: string;
  child: ChildProcessWithoutNullStreams;
  emitter: EventEmitter;
  killTimer: NodeJS.Timeout | null;
  exited: boolean;
  forcedTimeout: boolean;
  canceled: boolean;
}

interface RuntimeImageMap {
  [runtime: string]: { image: string; description?: string };
}

const RUNTIME_IMAGES: RuntimeImageMap = {
  "node-20": { image: "node:20-alpine", description: "Node.js 20 (alpine)" },
  "python-3.11": { image: "python:3.11-alpine", description: "Python 3.11 (alpine)" },
  "ubuntu-22": { image: "ubuntu:22.04", description: "Ubuntu 22.04" },
};

export type DockerSpawn = typeof spawn;

export interface DockerDriverDeps {
  spawnImpl?: DockerSpawn;
  /** Override `docker info` invocation for tests. Resolves to true if docker
   *  is available. Defaults to running `docker info` and checking exit code. */
  availabilityProbe?: () => Promise<boolean>;
}

export function createDockerDriver(deps: DockerDriverDeps = {}): SandboxDriver {
  const spawnFn = deps.spawnImpl ?? spawn;
  const probe = deps.availabilityProbe ?? (() => probeDocker(spawnFn));

  return {
    id: "docker",

    async available(): Promise<boolean> {
      try {
        return await probe();
      } catch {
        return false;
      }
    },

    runtimes(): SandboxRuntimeDescriptor[] {
      return Object.entries(RUNTIME_IMAGES).map(([id, descriptor]) => ({
        id,
        ready: true,
        image: descriptor.image,
        ...(descriptor.description ? { description: descriptor.description } : {}),
      }));
    },

    async start(spec: SandboxStartSpec): Promise<SandboxHandle> {
      const runtimeEntry = RUNTIME_IMAGES[spec.runtime];
      if (!runtimeEntry) {
        throw Object.assign(new Error(`unknown sandbox runtime: ${spec.runtime}`), {
          status: 400,
        });
      }

      const containerName = `packetagent-sandbox-${randomUUID()}`;
      const memoryMb = Math.max(64, Math.floor(spec.memoryLimitMb ?? 512));
      const cpus = Math.max(1, Number(spec.cpus ?? 1));

      const args: string[] = [
        "run",
        "--rm",
        "-i",
        "--name",
        containerName,
        "--network=none",
        `--cpus=${cpus}`,
        `--memory=${memoryMb}m`,
        "--pids-limit=64",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges:true",
        "--user=65534:65534",
        "--read-only",
        "--tmpfs",
        "/tmp",
        "-w",
        spec.workingDir,
      ];

      for (const [key, value] of Object.entries(spec.env ?? {})) {
        args.push("-e", `${key}=${value}`);
      }

      args.push(runtimeEntry.image, "sh", "-c", spec.command);

      const child = spawnFn("docker", args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: dockerCliEnvironment(),
        shell: false,
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;

      const emitter = new EventEmitter();
      const handle: DockerHandleInternal = {
        sandboxId: containerName,
        containerName,
        child,
        emitter,
        killTimer: null,
        exited: false,
        forcedTimeout: false,
        canceled: false,
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
          ...(handle.forcedTimeout
            ? { errorMessage: "execution timed out" }
            : handle.canceled
              ? { errorMessage: "execution canceled" }
              : {}),
        });
      });

      if (spec.stdin !== undefined) {
        try {
          child.stdin.end(spec.stdin);
        } catch {
          /* ignore */
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
          dockerKillContainer(spawnFn, containerName).catch(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              /* ignore */
            }
          });
        }, spec.timeoutMs);
      }

      return handle;
    },

    async cancel(handle: SandboxHandle): Promise<void> {
      const internal = handle as DockerHandleInternal;
      if (internal.exited) return;
      internal.canceled = true;
      try {
        await dockerKillContainer(spawnFn, internal.containerName);
      } catch {
        try {
          internal.child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    },

    subscribe(
      handle: SandboxHandle,
      onChunk: SandboxChunkListener,
      onExit: SandboxExitListener,
    ): SandboxSubscription {
      const internal = handle as DockerHandleInternal;
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

async function probeDocker(spawnFn: DockerSpawn): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = spawnFn("docker", ["info"], {
        stdio: ["ignore", "ignore", "ignore"],
        env: dockerCliEnvironment(),
        shell: false,
        windowsHide: true,
      });
      child.on("error", () => finish(false));
      child.on("close", (code) => finish(code === 0));
    } catch {
      finish(false);
    }
  });
}

async function dockerKillContainer(spawnFn: DockerSpawn, containerName: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    try {
      const child = spawnFn("docker", ["kill", containerName], {
        stdio: ["ignore", "ignore", "ignore"],
        env: dockerCliEnvironment(),
        shell: false,
        windowsHide: true,
      });
      child.on("error", (err) => finish(err));
      child.on("close", (code) => {
        if (code === 0) finish(null);
        else finish(new Error(`docker kill ${containerName} exited ${code}`));
      });
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function dockerCliEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
  ] as const;
  return Object.fromEntries(
    allowed.flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]])),
  );
}
