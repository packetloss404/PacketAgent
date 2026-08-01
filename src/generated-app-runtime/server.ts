import { fork, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GENERATED_APP_SCHEMA_CHANGE_POLICY,
  type GeneratedAppRuntimeModel,
  type GeneratedAppSchemaChangePolicy,
} from "../generated-app-runtime.js";
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

export interface GeneratedAppRuntimeMetrics {
  requests: number;
  successfulRequests: number;
  failedRequests: number;
  retryAttempts: number;
  workerStarts: number;
  startupFailures: number;
  crashes: number;
  schemaRestarts: number;
  evictions: number;
}

export interface GeneratedAppRuntimeCrashRecord {
  appId: string;
  workspaceId: string;
  at: string;
  reason: "unexpected-exit" | "request-failed" | "startup-failed";
  code?: number;
  signal?: NodeJS.Signals;
}

export interface GeneratedAppRuntimePoolHealth {
  status: "idle" | "healthy" | "degraded";
  observedAt: string;
  schemaChangePolicy: GeneratedAppSchemaChangePolicy;
  maxProcesses: number;
  processCount: number;
  activeRequests: number;
  metrics: GeneratedAppRuntimeMetrics;
  processes: Array<{
    appId: string;
    workspaceId: string;
    schemaSignature: string;
    pid?: number;
    state: "starting" | "ready";
    startedAt: string;
    lastUsedAt: string;
    activeRequests: number;
    restarts: number;
  }>;
  recentCrashes: GeneratedAppRuntimeCrashRecord[];
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

export const DEFAULT_GENERATED_APP_RUNTIME_MAX_PROCESSES = 4;
export const MAX_GENERATED_APP_RUNTIME_MAX_PROCESSES = 64;
const STARTUP_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 2_000;
const OUTPUT_BUFFER_LIMIT = 4_000;
const CRASH_DEGRADED_WINDOW_MS = 5 * 60_000;
const MAX_TRACKED_RUNTIME_KEYS = 500;

let defaultPool: GeneratedAppRuntimeProcessPool | null = null;

export class GeneratedAppRuntimeProcessPool {
  private readonly maxProcesses: number;
  private readonly workerFactory: GeneratedAppRuntimeWorkerFactory;
  private readonly now: () => Date;
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly restartCounts = new Map<string, number>();
  private readonly metrics = new Map<string, GeneratedAppRuntimeMetrics>();
  private readonly recentCrashes = new Map<string, GeneratedAppRuntimeCrashRecord>();

  constructor(options: GeneratedAppRuntimeProcessPoolOptions = {}) {
    this.maxProcesses = clampMaxProcesses(options.maxProcesses ?? defaultMaxProcesses());
    this.workerFactory = options.workerFactory ?? spawnGeneratedAppRuntimeWorker;
    this.now = options.now ?? (() => new Date());
  }

  async request(
    input: GeneratedAppRuntimeProcessRequest,
  ): Promise<GeneratedAppRuntimeProcessResponse> {
    const key = runtimePoolKey(input.workspaceId, input.appId);
    this.metricForKey(key).requests += 1;
    try {
      const result = await this.requestWithRetry(input, false);
      this.metricForKey(key).successfulRequests += 1;
      return result;
    } catch (error) {
      this.metricForKey(key).failedRequests += 1;
      throw error;
    }
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

  health(filter: { workspaceId: string; appId?: string }): GeneratedAppRuntimePoolHealth {
    const observedAt = this.now();
    const matches = (workspaceId: string, appId: string) =>
      workspaceId === filter.workspaceId && (!filter.appId || appId === filter.appId);
    const processes = [...this.entries.values()]
      .filter((entry) => matches(entry.workspaceId, entry.appId))
      .map((entry) => ({
        appId: entry.appId,
        workspaceId: entry.workspaceId,
        schemaSignature: entry.schemaSignature,
        pid: entry.worker?.pid,
        state: entry.worker ? ("ready" as const) : ("starting" as const),
        startedAt: entry.startedAt,
        lastUsedAt: new Date(entry.lastUsedAt).toISOString(),
        activeRequests: entry.activeRequests,
        restarts: entry.restarts,
      }))
      .sort((left, right) => left.appId.localeCompare(right.appId));
    const recentCrashes = [...this.recentCrashes.values()]
      .filter((crash) => matches(crash.workspaceId, crash.appId))
      .sort((left, right) => right.at.localeCompare(left.at));
    const metrics = emptyRuntimeMetrics();
    for (const [key, value] of this.metrics.entries()) {
      const identity = runtimePoolIdentity(key);
      if (!matches(identity.workspaceId, identity.appId)) continue;
      addRuntimeMetrics(metrics, value);
    }
    const hasRecentCrash = recentCrashes.some(
      (crash) => observedAt.getTime() - Date.parse(crash.at) <= CRASH_DEGRADED_WINDOW_MS,
    );

    return {
      status: hasRecentCrash ? "degraded" : processes.length > 0 ? "healthy" : "idle",
      observedAt: observedAt.toISOString(),
      schemaChangePolicy: GENERATED_APP_SCHEMA_CHANGE_POLICY,
      maxProcesses: this.maxProcesses,
      processCount: processes.length,
      activeRequests: processes.reduce((total, process) => total + process.activeRequests, 0),
      metrics,
      processes,
      recentCrashes,
    };
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
      if (!retried) {
        this.metricForKey(entry.key).retryAttempts += 1;
        return this.requestWithRetry(input, true);
      }
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
      this.metricForKey(key).schemaRestarts += 1;
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
        onExit: (details) => {
          if (this.entries.get(entry.key) !== entry) return;
          entry.stopped = true;
          this.entries.delete(entry.key);
          this.restartCounts.set(entry.key, entry.restarts + 1);
          this.metricForKey(entry.key).crashes += 1;
          this.recordCrash(entry, "unexpected-exit", {
            ...(details.code !== null ? { code: details.code } : {}),
            ...(details.signal ? { signal: details.signal } : {}),
          });
        },
      });
      this.metricForKey(entry.key).workerStarts += 1;
      entry.worker = worker;
      entry.startedAt = worker.startedAt;
      return entry;
    } catch (error) {
      if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
      this.metricForKey(entry.key).startupFailures += 1;
      this.recordCrash(entry, "startup-failed");
      throw error;
    }
  }

  private async markEntryCrashed(entry: RuntimeEntry): Promise<void> {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    entry.stopped = true;
    this.restartCounts.set(entry.key, entry.restarts + 1);
    this.metricForKey(entry.key).crashes += 1;
    this.recordCrash(entry, "request-failed");
    await this.stopEntry(entry, "request-failed");
  }

  private async evictIfNeeded(protectedKey?: string): Promise<void> {
    while (this.entries.size > this.maxProcesses) {
      const candidate = [...this.entries.values()]
        .filter((entry) => entry.key !== protectedKey && entry.activeRequests === 0)
        .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
      if (!candidate) return;
      this.entries.delete(candidate.key);
      this.metricForKey(candidate.key).evictions += 1;
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

  private metricForKey(key: string): GeneratedAppRuntimeMetrics {
    const current = this.metrics.get(key);
    if (current) return current;
    const created = emptyRuntimeMetrics();
    this.metrics.set(key, created);
    this.trimTrackedKeys();
    return created;
  }

  private recordCrash(
    entry: Pick<RuntimeEntry, "key" | "appId" | "workspaceId">,
    reason: GeneratedAppRuntimeCrashRecord["reason"],
    details: { code?: number; signal?: NodeJS.Signals } = {},
  ): void {
    this.recentCrashes.set(entry.key, {
      appId: entry.appId,
      workspaceId: entry.workspaceId,
      at: this.now().toISOString(),
      reason,
      ...details,
    });
    this.trimTrackedKeys();
  }

  private trimTrackedKeys(): void {
    while (this.metrics.size > MAX_TRACKED_RUNTIME_KEYS) {
      const oldestKey = this.metrics.keys().next().value as string | undefined;
      if (!oldestKey) break;
      if (this.entries.has(oldestKey)) {
        const value = this.metrics.get(oldestKey);
        this.metrics.delete(oldestKey);
        if (value) this.metrics.set(oldestKey, value);
        continue;
      }
      this.metrics.delete(oldestKey);
      this.recentCrashes.delete(oldestKey);
      this.restartCounts.delete(oldestKey);
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
  const compiled = fileURLToPath(import.meta.url).endsWith(".js");
  const workerPath = fileURLToPath(
    new URL(
      compiled ? "./generated-app-runtime/server-worker.js" : "./server-worker.ts",
      import.meta.url,
    ),
  );
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
    execArgv: compiled ? ["--enable-source-maps"] : ["--import", "tsx"],
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

function runtimePoolIdentity(key: string): { workspaceId: string; appId: string } {
  const separator = key.indexOf("\0");
  return {
    workspaceId: separator >= 0 ? key.slice(0, separator) : "",
    appId: separator >= 0 ? key.slice(separator + 1) : key,
  };
}

function defaultMaxProcesses(): number {
  const parsed = Number.parseInt(
    process.env.PACKETAGENT_GENERATED_APP_RUNTIME_MAX_PROCESSES ?? "",
    10,
  );
  return Number.isFinite(parsed) && parsed > 0
    ? clampMaxProcesses(parsed)
    : DEFAULT_GENERATED_APP_RUNTIME_MAX_PROCESSES;
}

function clampMaxProcesses(value: number): number {
  return Math.min(MAX_GENERATED_APP_RUNTIME_MAX_PROCESSES, Math.max(1, Math.floor(value)));
}

function emptyRuntimeMetrics(): GeneratedAppRuntimeMetrics {
  return {
    requests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    retryAttempts: 0,
    workerStarts: 0,
    startupFailures: 0,
    crashes: 0,
    schemaRestarts: 0,
    evictions: 0,
  };
}

function addRuntimeMetrics(
  target: GeneratedAppRuntimeMetrics,
  source: GeneratedAppRuntimeMetrics,
): void {
  for (const key of Object.keys(target) as Array<keyof GeneratedAppRuntimeMetrics>) {
    target[key] += source[key];
  }
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
