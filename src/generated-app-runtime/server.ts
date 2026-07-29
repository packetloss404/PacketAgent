import { fork, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GeneratedAppRuntimeModel } from "../generated-app-runtime.js";
import {
  generatedAppRuntimeSchemaSignature,
  type GeneratedAppRuntimeApiRequest,
  type GeneratedAppRuntimeApiResult,
} from "./sqlite.js";

export interface GeneratedAppRuntimeProcessRequest extends GeneratedAppRuntimeApiRequest {
  appId: string;
  workspaceId: string;
  model: GeneratedAppRuntimeModel;
  runtimeRoot?: string;
}

export interface GeneratedAppRuntimeProcessResponse extends GeneratedAppRuntimeApiResult {
  process: GeneratedAppRuntimeProcessInfo;
}

export interface GeneratedAppRuntimeProcessInfo {
  pid?: number;
  startedAt: string;
  restarts: number;
  schemaSignature: string;
}

export interface GeneratedAppRuntimeWorkerStartConfig {
  appId: string;
  workspaceId: string;
  model: GeneratedAppRuntimeModel;
  runtimeRoot?: string;
  schemaSignature: string;
  onExit?: (details: { code: number | null; signal: NodeJS.Signals | null }) => void;
}

export interface GeneratedAppRuntimeWorkerHandle {
  pid?: number;
  startedAt: string;
  request(request: GeneratedAppRuntimeApiRequest): Promise<GeneratedAppRuntimeApiResult>;
  stop(reason?: string): Promise<void>;
}

export type GeneratedAppRuntimeWorkerFactory = (
  config: GeneratedAppRuntimeWorkerStartConfig,
) => Promise<GeneratedAppRuntimeWorkerHandle>;

export interface GeneratedAppRuntimeProcessPoolOptions {
  maxProcesses?: number;
  workerFactory?: GeneratedAppRuntimeWorkerFactory;
  now?: () => Date;
}

interface RuntimeEntry {
  key: string;
  appId: string;
  workspaceId: string;
  schemaSignature: string;
  startedAt: string;
  restarts: number;
  lastUsedAt: number;
  activeRequests: number;
  stopped: boolean;
  ready: Promise<RuntimeEntry>;
  worker?: GeneratedAppRuntimeWorkerHandle;
}

const DEFAULT_MAX_PROCESSES = 4;
const STARTUP_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 2_000;
const OUTPUT_BUFFER_LIMIT = 4_000;

let defaultPool: GeneratedAppRuntimeProcessPool | null = null;

export class GeneratedAppRuntimeProcessPool {
  private readonly maxProcesses: number;
  private readonly workerFactory: GeneratedAppRuntimeWorkerFactory;
  private readonly now: () => Date;
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly restartCounts = new Map<string, number>();

  constructor(options: GeneratedAppRuntimeProcessPoolOptions = {}) {
    this.maxProcesses = Math.max(1, Math.floor(options.maxProcesses ?? defaultMaxProcesses()));
    this.workerFactory = options.workerFactory ?? spawnGeneratedAppRuntimeWorker;
    this.now = options.now ?? (() => new Date());
  }

  async request(
    input: GeneratedAppRuntimeProcessRequest,
  ): Promise<GeneratedAppRuntimeProcessResponse> {
    return this.requestWithRetry(input, false);
  }

  async shutdown(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((entry) => this.stopEntry(entry, "shutdown")));
  }

  snapshot(): Array<{
    appId: string;
    workspaceId: string;
    schemaSignature: string;
    pid?: number;
    activeRequests: number;
  }> {
    return [...this.entries.values()].map((entry) => ({
      appId: entry.appId,
      workspaceId: entry.workspaceId,
      schemaSignature: entry.schemaSignature,
      pid: entry.worker?.pid,
      activeRequests: entry.activeRequests,
    }));
  }

  private async requestWithRetry(
    input: GeneratedAppRuntimeProcessRequest,
    retried: boolean,
  ): Promise<GeneratedAppRuntimeProcessResponse> {
    const entry = await this.ensureEntry(input);
    entry.activeRequests += 1;
    entry.lastUsedAt = this.now().getTime();
    try {
      const worker = entry.worker;
      if (!worker) throw new Error("generated app runtime process was not ready");
      const result = await worker.request({
        method: input.method,
        path: input.path,
        body: input.body,
      });
      return {
        ...result,
        process: {
          pid: worker.pid,
          startedAt: worker.startedAt,
          restarts: entry.restarts,
          schemaSignature: entry.schemaSignature,
        },
      };
    } catch (error) {
      await this.markEntryCrashed(entry);
      if (!retried) return this.requestWithRetry(input, true);
      throw error;
    } finally {
      entry.activeRequests = Math.max(0, entry.activeRequests - 1);
      entry.lastUsedAt = this.now().getTime();
      await this.evictIfNeeded();
    }
  }

  private async ensureEntry(input: GeneratedAppRuntimeProcessRequest): Promise<RuntimeEntry> {
    const key = runtimePoolKey(input.workspaceId, input.appId);
    const schemaSignature = generatedAppRuntimeSchemaSignature(input.model);
    const existing = this.entries.get(key);
    if (existing && !existing.stopped && existing.schemaSignature === schemaSignature) {
      return existing.ready;
    }

    if (existing) {
      await this.stopEntry(existing, "schema-changed");
      this.entries.delete(key);
    }

    const restarts = this.restartCounts.get(key) ?? 0;
    const entry = {
      key,
      appId: input.appId,
      workspaceId: input.workspaceId,
      schemaSignature,
      startedAt: this.now().toISOString(),
      restarts,
      lastUsedAt: this.now().getTime(),
      activeRequests: 0,
      stopped: false,
    } as RuntimeEntry;
    entry.ready = this.startEntry(entry, input);
    this.entries.set(key, entry);
    const readyEntry = await entry.ready;
    await this.evictIfNeeded(key);
    return readyEntry;
  }

  private async startEntry(
    entry: RuntimeEntry,
    input: GeneratedAppRuntimeProcessRequest,
  ): Promise<RuntimeEntry> {
    try {
      const worker = await this.workerFactory({
        appId: input.appId,
        workspaceId: input.workspaceId,
        model: input.model,
        runtimeRoot: input.runtimeRoot,
        schemaSignature: entry.schemaSignature,
        onExit: () => {
          if (this.entries.get(entry.key) !== entry) return;
          entry.stopped = true;
          this.entries.delete(entry.key);
          this.restartCounts.set(entry.key, entry.restarts + 1);
        },
      });
      entry.worker = worker;
      entry.startedAt = worker.startedAt;
      return entry;
    } catch (error) {
      if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
      throw error;
    }
  }

  private async markEntryCrashed(entry: RuntimeEntry): Promise<void> {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    entry.stopped = true;
    this.restartCounts.set(entry.key, entry.restarts + 1);
    await this.stopEntry(entry, "request-failed");
  }

  private async evictIfNeeded(protectedKey?: string): Promise<void> {
    while (this.entries.size > this.maxProcesses) {
      const candidate = [...this.entries.values()]
        .filter((entry) => entry.key !== protectedKey && entry.activeRequests === 0)
        .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
      if (!candidate) return;
      this.entries.delete(candidate.key);
      await this.stopEntry(candidate, "lru-eviction");
    }
  }

  private async stopEntry(entry: RuntimeEntry, reason: string): Promise<void> {
    entry.stopped = true;
    try {
      const worker =
        entry.worker ?? (await entry.ready.then((ready) => ready.worker).catch(() => undefined));
      await worker?.stop(reason);
    } catch {
      // A dead worker is already past the useful cleanup boundary.
    }
  }
}

export function getDefaultGeneratedAppRuntimeProcessPool(): GeneratedAppRuntimeProcessPool {
  if (!defaultPool) defaultPool = new GeneratedAppRuntimeProcessPool();
  return defaultPool;
}

export function setDefaultGeneratedAppRuntimeProcessPoolForTests(
  pool: GeneratedAppRuntimeProcessPool | null,
): void {
  defaultPool = pool;
}

export async function shutdownDefaultGeneratedAppRuntimeProcessPool(): Promise<void> {
  await defaultPool?.shutdown();
  defaultPool = null;
}

export async function spawnGeneratedAppRuntimeWorker(
  config: GeneratedAppRuntimeWorkerStartConfig,
): Promise<GeneratedAppRuntimeWorkerHandle> {
  const workerPath = fileURLToPath(new URL("./server-worker.ts", import.meta.url));
  const configDir = path.join(
    tmpdir(),
    `packetagent-generated-runtime-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      appId: config.appId,
      workspaceId: config.workspaceId,
      model: config.model,
      runtimeRoot: config.runtimeRoot,
    }),
  );

  const child = fork(workerPath, [configPath], {
    cwd: process.cwd(),
    env: scrubRuntimeEnvironment(process.env),
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const output = captureChildOutput(child);
  let stopped = false;
  let readyPort: number | null = null;

  const stop = async (_reason?: string): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await stopChild(child);
    rmSync(configDir, { recursive: true, force: true });
  };

  child.once("exit", (code, signal) => {
    if (!stopped) config.onExit?.({ code, signal });
    rmSync(configDir, { recursive: true, force: true });
  });

  let ready: { port: number; pid?: number };
  try {
    ready = await waitForWorkerReady(child, output);
  } catch (error) {
    stopped = true;
    await stopChild(child);
    rmSync(configDir, { recursive: true, force: true });
    throw error;
  }
  readyPort = ready.port;
  const baseUrl = `http://127.0.0.1:${readyPort}`;

  return {
    pid: ready.pid ?? child.pid,
    startedAt: new Date().toISOString(),
    request: async (request) => requestWorker(baseUrl, request),
    stop,
  };
}

function runtimePoolKey(workspaceId: string, appId: string): string {
  return `${workspaceId}\0${appId}`;
}

function defaultMaxProcesses(): number {
  const parsed = Number.parseInt(
    process.env.PACKETAGENT_GENERATED_APP_RUNTIME_MAX_PROCESSES ?? "",
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_PROCESSES;
}

function waitForWorkerReady(
  child: ChildProcess,
  output: () => string,
): Promise<{ port: number; pid?: number }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(`generated app runtime worker startup timed out${formatWorkerOutput(output())}`),
      );
    }, STARTUP_TIMEOUT_MS);

    const onMessage = (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const payload = message as { type?: unknown; port?: unknown; pid?: unknown; error?: unknown };
      if (payload.type === "ready" && typeof payload.port === "number") {
        cleanup();
        resolve({
          port: payload.port,
          pid: typeof payload.pid === "number" ? payload.pid : undefined,
        });
        return;
      }
      if (payload.type === "error") {
        cleanup();
        reject(
          new Error(
            `generated app runtime worker failed: ${String(payload.error ?? "unknown error")}${formatWorkerOutput(output())}`,
          ),
        );
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `generated app runtime worker exited before ready (${code ?? signal ?? "unknown"})${formatWorkerOutput(output())}`,
        ),
      );
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
    };

    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function requestWorker(
  baseUrl: string,
  request: GeneratedAppRuntimeApiRequest,
): Promise<GeneratedAppRuntimeApiResult> {
  const target = new URL(`/${(request.path || "").replace(/^\/+/, "")}`, baseUrl);
  const hasBody = request.body !== undefined && !isReadOnlyMethod(request.method);
  const response = await fetch(target, {
    method: request.method,
    headers: hasBody ? { "Content-Type": "application/json" } : undefined,
    body: hasBody ? JSON.stringify(request.body) : undefined,
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  return { status: response.status, body };
}

function isReadOnlyMethod(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized === "GET" || normalized === "HEAD";
}

function captureChildOutput(child: ChildProcess): () => string {
  let output = "";
  const append = (chunk: Buffer | string) => {
    output = `${output}${chunk.toString()}`;
    if (output.length > OUTPUT_BUFFER_LIMIT) output = output.slice(-OUTPUT_BUFFER_LIMIT);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return () => output.trim();
}

function formatWorkerOutput(output: string): string {
  return output ? `\n${output}` : "";
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
      resolve();
    }, STOP_TIMEOUT_MS);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function scrubRuntimeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR"];
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = env[key];
    if (value !== undefined) scrubbed[key] = value;
  }
  scrubbed.NODE_ENV = env.NODE_ENV ?? "development";
  return scrubbed;
}
