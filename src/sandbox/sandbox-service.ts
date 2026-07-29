/**
 * Sandbox orchestration service.
 *
 * Owns driver selection, exec lifecycle, in-memory active-exec map, output
 * buffering, timeout enforcement, persistence, and SSE event emission.
 *
 * Environment variables:
 *   PACKETAGENT_SANDBOX_DRIVER          docker | native | auto (default: auto)
 *   PACKETAGENT_SANDBOX_DEFAULT_RUNTIME default runtime id (default: node-20)
 *   PACKETAGENT_SANDBOX_DEFAULT_TIMEOUT_MS default exec timeout (default: 120000)
 *   PACKETAGENT_SANDBOX_MEMORY_MB       per-exec memory limit (default: 512)
 *   PACKETAGENT_SANDBOX_CPUS            per-exec cpu count (default: 1)
 *
 * Future hook for the app builder integration:
 *   `runBuildInSandbox(appId, checkpointId)` — the eventual entry point that
 *   `app-builder-service.ts` will use to route `npm test`, `vite build`, and
 *   shell commands through this subsystem instead of running them on the host.
 *   That function lives in `app-builder-service.ts` (not here) so app-builder
 *   ownership is preserved; this comment marks the integration seam.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { createDockerDriver } from "./docker-driver.js";
import { createNativeDriver } from "./native-driver.js";
import {
  type SandboxChunkEvent,
  type SandboxDriver,
  type SandboxExitEvent,
  type SandboxHandle,
  type SandboxRuntimeDescriptor,
  type SandboxSubscription,
} from "./sandbox-driver.js";
import { createSandboxStore, type SandboxStore } from "./sandbox-store.js";
import type {
  SandboxDriver as SandboxDriverId,
  SandboxExecRecord,
  SandboxExecStatus,
  SandboxRuntimeView,
  SandboxStatusView,
} from "./types.js";

const PREVIEW_BYTE_BUDGET = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RUNTIME = "node-20";
const NATIVE_INSECURE_NOTE =
  "Native driver is active for owner/admin trusted-host diagnostics only. It has no isolation, is not a sandbox, and never runs generated or autonomous code.";
const NATIVE_PRODUCTION_BLOCK_MESSAGE =
  "sandbox: native driver is blocked; it runs untrusted code on the host with no isolation. Use PACKETAGENT_SANDBOX_DRIVER=docker, or set PACKETAGENT_ALLOW_INSECURE_NATIVE_SANDBOX=true only for a trusted development host";
const DOCKER_UNAVAILABLE_BLOCK_MESSAGE =
  "sandbox: Docker is unavailable and the native fallback is disabled. Start Docker (PACKETAGENT_SANDBOX_DRIVER=docker), or set PACKETAGENT_ALLOW_INSECURE_NATIVE_SANDBOX=true only for a trusted development host to allow the insecure native fallback";
const NATIVE_UNTRUSTED_BLOCK_MESSAGE =
  "sandbox: untrusted execution requires Docker; the native host driver is restricted to explicit owner/admin trusted-host diagnostics";

export interface SandboxExecRequest {
  workspaceId: string;
  appId?: string;
  checkpointId?: string;
  command: string;
  runtime?: string;
  workingDir?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
  /** Internal-only: reject execution unless this driver is selected. */
  requiredDriver?: SandboxDriverId;
  /** Internal-only trusted image and bind-mount overrides. */
  image?: string;
  mounts?: ReadonlyArray<{
    source: string;
    target: string;
    readOnly?: boolean;
  }>;
}

export type AggregateSmokeStatus = "pass" | "fail" | "warn";
export type SmokeItemStatus = "pass" | "fail" | "timeout" | "canceled";

export interface SandboxSmokeItemResult {
  name: string;
  status: SmokeItemStatus;
  execId: string;
  exitCode?: number;
  durationMs?: number;
  stdoutPreview?: string;
  stderrPreview?: string;
  errorMessage?: string;
}

export interface SandboxSmokeBatchResult {
  status: AggregateSmokeStatus;
  items: SandboxSmokeItemResult[];
}

function mapExecStatusToSmoke(status: SandboxExecStatus): SmokeItemStatus {
  switch (status) {
    case "success":
      return "pass";
    case "timeout":
      return "timeout";
    case "canceled":
      return "canceled";
    default:
      return "fail";
  }
}

export interface SandboxServiceEvents {
  "exec.update": (record: SandboxExecRecord) => void;
  "exec.chunk": (record: SandboxExecRecord, event: SandboxChunkEvent) => void;
  "exec.done": (record: SandboxExecRecord) => void;
}

export interface SandboxServiceFailureSnapshot {
  id: string;
  status: SandboxExecStatus;
  errorMessage?: string;
  completedAt?: string;
}

export interface SandboxServiceHealthSnapshot {
  driver: SandboxDriverId;
  available: boolean;
  executionClass: "isolated" | "trusted-host-only";
  untrustedCodeSupported: boolean;
  runtimes: SandboxRuntimeView[];
  activeExecs: number;
  recentFailures: SandboxServiceFailureSnapshot[];
  note?: string;
}

interface ActiveExec {
  record: SandboxExecRecord;
  driver: SandboxDriver;
  handle: SandboxHandle;
  subscription: SandboxSubscription;
  stdoutBuffer: BufferedStream;
  stderrBuffer: BufferedStream;
  done: Promise<SandboxExecRecord>;
}

class BufferedStream {
  private chunks: string[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly limit: number) {}

  push(data: string): void {
    if (data.length === 0) return;
    this.chunks.push(data);
    this.size += data.length;
    while (this.size > this.limit && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this.size -= dropped.length;
      this.truncated = true;
    }
    if (this.size > this.limit && this.chunks.length === 1) {
      const overflow = this.size - this.limit;
      this.chunks[0] = this.chunks[0]!.slice(overflow);
      this.size -= overflow;
      this.truncated = true;
    }
  }

  read(): string {
    return this.chunks.join("");
  }
}

export interface SandboxServiceDeps {
  store?: SandboxStore;
  dockerDriver?: SandboxDriver;
  nativeDriver?: SandboxDriver;
  /** Selection override – mainly for tests. */
  forcedDriver?: SandboxDriverId;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export class SandboxService {
  readonly events = new EventEmitter();
  private readonly store: SandboxStore;
  private readonly dockerDriver: SandboxDriver;
  private readonly nativeDriver: SandboxDriver;
  private readonly env: NodeJS.ProcessEnv;
  private readonly forcedDriver?: SandboxDriverId;
  private readonly nowFn: () => Date;
  private readonly active = new Map<string, ActiveExec>();
  private readonly recentFailures: SandboxServiceFailureSnapshot[] = [];
  private cachedDriver: SandboxDriver | null = null;
  private cachedDriverAvailable: boolean | null = null;

  constructor(deps: SandboxServiceDeps = {}) {
    this.store = deps.store ?? createSandboxStore();
    this.dockerDriver = deps.dockerDriver ?? createDockerDriver();
    this.nativeDriver = deps.nativeDriver ?? createNativeDriver();
    this.env = deps.env ?? process.env;
    this.nowFn = deps.now ?? (() => new Date());
    if (deps.forcedDriver) this.forcedDriver = deps.forcedDriver;
  }

  async getStatus(): Promise<SandboxStatusView> {
    const driver = await this.resolveDriver();
    const available = await driver.available();
    const runtimes = driver.runtimes();
    const view: SandboxStatusView = {
      driver: driver.id,
      available,
      executionClass: driver.id === "docker" ? "isolated" : "trusted-host-only",
      untrustedCodeSupported: driver.id === "docker" && available,
      runtimes,
    };
    if (driver.id === "native") view.note = NATIVE_INSECURE_NOTE;
    return view;
  }

  async listRuntimes(): Promise<SandboxRuntimeDescriptor[]> {
    const driver = await this.resolveDriver();
    return driver.runtimes();
  }

  async getHealthSnapshot(): Promise<SandboxServiceHealthSnapshot> {
    const driver = await this.resolveDriver();
    const available = await driver.available();
    const snapshot: SandboxServiceHealthSnapshot = {
      driver: driver.id,
      available,
      executionClass: driver.id === "docker" ? "isolated" : "trusted-host-only",
      untrustedCodeSupported: driver.id === "docker" && available,
      runtimes: driver.runtimes(),
      activeExecs: this.active.size,
      recentFailures: this.recentFailures.slice(-5),
    };
    if (driver.id === "native") snapshot.note = NATIVE_INSECURE_NOTE;
    return snapshot;
  }

  /** Returns the persisted record for an exec, falling back to in-memory. */
  async getExec(workspaceId: string, id: string): Promise<SandboxExecRecord | null> {
    const persisted = await this.store.getExec(workspaceId, id);
    if (persisted) return this.withPreviewIfActive(persisted);
    const active = this.active.get(id);
    if (active && active.record.workspaceId === workspaceId) return this.snapshotActive(active);
    return null;
  }

  async listExecs(
    workspaceId: string,
    filters: { appId?: string; status?: SandboxExecStatus; limit?: number } = {},
  ): Promise<SandboxExecRecord[]> {
    return this.store.listExecs(workspaceId, filters);
  }

  /**
   * Starts untrusted execution. Docker is the only supported security
   * boundary; native host execution always fails closed here.
   */
  async startExec(request: SandboxExecRequest): Promise<SandboxExecRecord> {
    return await this.startExecWithTrust(request, false);
  }

  /**
   * Explicit operator-only diagnostic path. Callers must independently prove
   * owner/admin authority before using it. It never becomes a generated-code
   * or autonomous-Worker fallback.
   */
  async startTrustedHostExec(request: SandboxExecRequest): Promise<SandboxExecRecord> {
    return await this.startExecWithTrust(request, true);
  }

  private async startExecWithTrust(
    request: SandboxExecRequest,
    trustedHostDiagnostic: boolean,
  ): Promise<SandboxExecRecord> {
    const driver = await this.resolveDriver();
    if (driver.id === "native" && !trustedHostDiagnostic) {
      throw new Error(NATIVE_UNTRUSTED_BLOCK_MESSAGE);
    }
    if (request.requiredDriver && driver.id !== request.requiredDriver) {
      throw new Error(
        `sandbox: execution requires ${request.requiredDriver}; selected driver is ${driver.id}`,
      );
    }
    const now = this.nowFn().toISOString();
    const id = randomUUID();
    const runtime = request.runtime ?? this.defaultRuntime();
    const timeoutMs = clampPositive(
      request.timeoutMs,
      this.defaultTimeoutMs(),
      1,
      24 * 60 * 60 * 1000,
    );
    const memoryMb = clampPositive(
      this.numberFromEnv("PACKETAGENT_SANDBOX_MEMORY_MB"),
      512,
      64,
      8192,
    );
    const cpus = clampPositive(this.numberFromEnv("PACKETAGENT_SANDBOX_CPUS"), 1, 1, 32);

    const baseRecord: SandboxExecRecord = {
      id,
      workspaceId: request.workspaceId,
      sandboxId: "",
      driver: driver.id,
      runtime,
      command: request.command,
      workingDir: request.workingDir ?? defaultWorkingDirForDriver(driver.id),
      status: "queued",
      cpuLimitMs: timeoutMs,
      memoryLimitMb: memoryMb,
      createdAt: now,
      updatedAt: now,
    };
    if (request.appId !== undefined) baseRecord.appId = request.appId;
    if (request.checkpointId !== undefined) baseRecord.checkpointId = request.checkpointId;
    if (request.env !== undefined) baseRecord.env = request.env;

    await this.store.insertExec(baseRecord);

    let handle: SandboxHandle;
    try {
      handle = await driver.start({
        execId: id,
        runtime,
        command: request.command,
        workingDir: baseRecord.workingDir,
        ...(request.env ? { env: request.env } : {}),
        ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
        timeoutMs,
        memoryLimitMb: memoryMb,
        cpus,
        ...(request.image ? { image: request.image } : {}),
        ...(request.mounts ? { mounts: request.mounts } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedRecord = await this.persistUpdate(id, {
        status: "failed",
        errorMessage: message,
        completedAt: this.nowFn().toISOString(),
        durationMs: 0,
      });
      if (failedRecord) {
        this.recordFailure(failedRecord);
        this.emitUpdate(failedRecord);
        this.emitDone(failedRecord);
      }
      throw error;
    }

    const startedAt = this.nowFn().toISOString();
    const startedRecord = await this.persistUpdate(id, {
      sandboxId: handle.sandboxId,
      status: "running",
      startedAt,
    });
    if (!startedRecord) {
      throw new Error("sandbox exec record disappeared after start");
    }

    const stdoutBuffer = new BufferedStream(PREVIEW_BYTE_BUDGET);
    const stderrBuffer = new BufferedStream(PREVIEW_BYTE_BUDGET);

    const completion = new Promise<SandboxExecRecord>((resolve) => {
      const subscription = driver.subscribe(
        handle,
        (chunk) => this.onChunk(id, chunk, stdoutBuffer, stderrBuffer),
        (exit) => {
          this.onExit(id, exit, stdoutBuffer, stderrBuffer, startedAt)
            .then(resolve)
            .catch((err) => {
              // Make absolutely sure we always resolve so /stream callers don't hang
              const record = this.active.get(id)?.record ?? startedRecord;
              const fallback: SandboxExecRecord = {
                ...record,
                status: "failed",
                errorMessage: err instanceof Error ? err.message : String(err),
                updatedAt: this.nowFn().toISOString(),
              };
              resolve(fallback);
            });
        },
      );
      this.active.set(id, {
        record: startedRecord,
        driver,
        handle,
        subscription,
        stdoutBuffer,
        stderrBuffer,
        done: Promise.resolve(startedRecord), // overwritten below
      });
    });

    const active = this.active.get(id);
    if (active) active.done = completion;

    this.emitUpdate(startedRecord);
    return startedRecord;
  }

  async cancelExec(workspaceId: string, id: string): Promise<SandboxExecRecord | null> {
    const active = this.active.get(id);
    if (active && active.record.workspaceId === workspaceId) {
      try {
        await active.driver.cancel(active.handle);
      } catch {
        /* swallow – the exit handler will still fire on close */
      }
      const record = await this.persistUpdate(id, {
        status: "canceled",
        completedAt: this.nowFn().toISOString(),
      });
      if (record) {
        active.record = record;
        this.emitUpdate(record);
      }
      return record;
    }
    return this.store.getExec(workspaceId, id);
  }

  /**
   * Runs a batch of smoke commands sequentially and aggregates results.
   * Used by `app-builder-service` integration to gate smoke / build status
   * on real sandbox-isolated exec exit codes instead of synthetic checks.
   */
  async runSmokeBatch(
    workspaceId: string,
    items: ReadonlyArray<{
      name: string;
      command: string;
      runtime?: string;
      appId?: string;
      checkpointId?: string;
      timeoutMs?: number;
      env?: Record<string, string>;
    }>,
  ): Promise<SandboxSmokeBatchResult> {
    const results: SandboxSmokeItemResult[] = [];
    for (const item of items) {
      const request: SandboxExecRequest = {
        workspaceId,
        command: item.command,
        ...(item.runtime ? { runtime: item.runtime } : {}),
        ...(item.appId ? { appId: item.appId } : {}),
        ...(item.checkpointId ? { checkpointId: item.checkpointId } : {}),
        ...(item.timeoutMs ? { timeoutMs: item.timeoutMs } : {}),
        ...(item.env ? { env: item.env } : {}),
      };
      let started: SandboxExecRecord;
      try {
        started = await this.startExec(request);
      } catch (error) {
        results.push({
          name: item.name,
          status: "fail",
          execId: "",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const final = (await this.waitForExec(started.id)) ?? started;
      const item_result: SandboxSmokeItemResult = {
        name: item.name,
        status: mapExecStatusToSmoke(final.status),
        execId: final.id,
      };
      if (final.exitCode !== undefined) item_result.exitCode = final.exitCode;
      if (final.durationMs !== undefined) item_result.durationMs = final.durationMs;
      if (final.stderrPreview) item_result.stderrPreview = final.stderrPreview;
      if (final.stdoutPreview) item_result.stdoutPreview = final.stdoutPreview;
      if (final.errorMessage) item_result.errorMessage = final.errorMessage;
      results.push(item_result);
    }
    const status: AggregateSmokeStatus = results.every((r) => r.status === "pass")
      ? "pass"
      : results.some((r) => r.status === "fail" || r.status === "timeout")
        ? "fail"
        : "warn";
    return { status, items: results };
  }

  /** Wait until the exec terminates. Useful in tests. */
  async waitForExec(id: string): Promise<SandboxExecRecord | null> {
    const active = this.active.get(id);
    if (active) {
      const result = await active.done;
      return result;
    }
    return null;
  }

  async resolveDriver(): Promise<SandboxDriver> {
    // Only a *positive* Docker selection is cached across the process lifetime.
    // The native driver is never cached so the fail-closed guard is re-evaluated
    // on every resolution and an out-of-band insecure opt-in can never be
    // "stuck" past a config change.
    if (this.cachedDriver === this.dockerDriver && this.cachedDriverAvailable) {
      return this.dockerDriver;
    }
    const requested = (
      this.forcedDriver ??
      this.env.PACKETAGENT_SANDBOX_DRIVER ??
      "auto"
    ).toLowerCase();
    if (requested === "native") {
      // Explicit native: refused unless the operator opted into the insecure flag.
      this.assertNativeAllowed();
      return this.nativeDriver;
    }
    if (requested === "docker") {
      const dockerOk = await this.dockerDriver.available().catch(() => false);
      if (!dockerOk) {
        // Fail closed: never silently run native when Docker was explicitly requested.
        throw new Error(DOCKER_UNAVAILABLE_BLOCK_MESSAGE);
      }
      this.cachedDriver = this.dockerDriver;
      this.cachedDriverAvailable = true;
      return this.dockerDriver;
    }
    // auto
    const dockerOk = await this.dockerDriver.available().catch(() => false);
    if (dockerOk) {
      this.cachedDriver = this.dockerDriver;
      this.cachedDriverAvailable = true;
      return this.dockerDriver;
    }
    // Docker unavailable under auto. Fail closed: only fall back to the
    // insecure native driver when the operator explicitly opted in.
    if (!this.nativeOptIn()) {
      throw new Error(DOCKER_UNAVAILABLE_BLOCK_MESSAGE);
    }
    this.assertNativeAllowed();
    return this.nativeDriver;
  }

  private async onChunk(
    id: string,
    chunk: SandboxChunkEvent,
    stdoutBuffer: BufferedStream,
    stderrBuffer: BufferedStream,
  ): Promise<void> {
    const buffer = chunk.stream === "stdout" ? stdoutBuffer : stderrBuffer;
    buffer.push(chunk.data);
    const active = this.active.get(id);
    if (!active) return;
    const record: SandboxExecRecord = {
      ...active.record,
      stdoutPreview: stdoutBuffer.read(),
      stderrPreview: stderrBuffer.read(),
      updatedAt: this.nowFn().toISOString(),
    };
    active.record = record;
    this.events.emit("exec.chunk", record, chunk);
  }

  private async onExit(
    id: string,
    exit: SandboxExitEvent,
    stdoutBuffer: BufferedStream,
    stderrBuffer: BufferedStream,
    startedAt: string,
  ): Promise<SandboxExecRecord> {
    const active = this.active.get(id);
    const completedAt = this.nowFn().toISOString();
    const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
    const status = this.deriveStatus(exit, active?.record.status);

    const patch: Partial<SandboxExecRecord> = {
      status,
      completedAt,
      durationMs,
      stdoutPreview: stdoutBuffer.read(),
      stderrPreview: stderrBuffer.read(),
    };
    if (typeof exit.exitCode === "number") patch.exitCode = exit.exitCode;
    if (exit.errorMessage) patch.errorMessage = exit.errorMessage;

    const updated = await this.persistUpdate(id, patch);
    if (active) {
      active.subscription.unsubscribe();
      this.active.delete(id);
    }
    if (updated) {
      if (updated.status !== "success") this.recordFailure(updated);
      this.emitUpdate(updated);
      this.emitDone(updated);
    }
    return updated ?? (active?.record as SandboxExecRecord);
  }

  private deriveStatus(
    exit: SandboxExitEvent,
    currentStatus?: SandboxExecStatus,
  ): SandboxExecStatus {
    if (currentStatus === "canceled") return "canceled";
    if (exit.errorMessage?.includes("timed out")) return "timeout";
    if (exit.errorMessage?.includes("canceled")) return "canceled";
    if (exit.errorMessage) return "failed";
    if (typeof exit.exitCode === "number") {
      return exit.exitCode === 0 ? "success" : "failed";
    }
    return "failed";
  }

  private async persistUpdate(
    id: string,
    patch: Partial<SandboxExecRecord>,
  ): Promise<SandboxExecRecord | null> {
    const updated = await this.store.updateExec(id, {
      ...patch,
      updatedAt: this.nowFn().toISOString(),
    });
    if (updated) {
      const active = this.active.get(id);
      if (active) active.record = updated;
    }
    return updated ?? null;
  }

  private snapshotActive(active: ActiveExec): SandboxExecRecord {
    return {
      ...active.record,
      stdoutPreview: active.stdoutBuffer.read(),
      stderrPreview: active.stderrBuffer.read(),
    };
  }

  private withPreviewIfActive(record: SandboxExecRecord): SandboxExecRecord {
    const active = this.active.get(record.id);
    if (!active) return record;
    return {
      ...record,
      stdoutPreview: active.stdoutBuffer.read(),
      stderrPreview: active.stderrBuffer.read(),
    };
  }

  private emitUpdate(record: SandboxExecRecord): void {
    this.events.emit("exec.update", record);
  }

  private emitDone(record: SandboxExecRecord): void {
    this.events.emit("exec.done", record);
  }

  private recordFailure(record: SandboxExecRecord): void {
    const snapshot: SandboxServiceFailureSnapshot = {
      id: record.id,
      status: record.status,
    };
    if (record.errorMessage) snapshot.errorMessage = record.errorMessage;
    if (record.completedAt) snapshot.completedAt = record.completedAt;
    this.recentFailures.push(snapshot);
    while (this.recentFailures.length > 20) this.recentFailures.shift();
  }

  private defaultRuntime(): string {
    const value = this.env.PACKETAGENT_SANDBOX_DEFAULT_RUNTIME;
    return value && value.length > 0 ? value : DEFAULT_RUNTIME;
  }

  private defaultTimeoutMs(): number {
    return clampPositive(
      this.numberFromEnv("PACKETAGENT_SANDBOX_DEFAULT_TIMEOUT_MS"),
      DEFAULT_TIMEOUT_MS,
      1,
      24 * 60 * 60 * 1000,
    );
  }

  private numberFromEnv(key: string): number | undefined {
    const raw = this.env[key];
    if (raw === undefined || raw === "") return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private nativeOptIn(): boolean {
    return isTruthy(this.env.PACKETAGENT_ALLOW_INSECURE_NATIVE_SANDBOX);
  }

  /**
   * Refuses the native (no-isolation) driver in ALL environments unless the
   * operator explicitly opts in via PACKETAGENT_ALLOW_INSECURE_NATIVE_SANDBOX.
   * This is independent of NODE_ENV — the native driver runs untrusted code
   * directly on the host, so it must always be opt-in (fail closed).
   */
  private assertNativeAllowed(): void {
    if (this.nativeOptIn()) return;
    throw new Error(NATIVE_PRODUCTION_BLOCK_MESSAGE);
  }
}

function clampPositive(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const candidate = value ?? fallback;
  if (!Number.isFinite(candidate) || candidate < min) return Math.max(min, fallback);
  return Math.min(candidate, max);
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function defaultWorkingDirForDriver(driver: SandboxDriverId): string {
  return driver === "native" ? process.cwd() : "/workspace";
}

let defaultInstance: SandboxService | null = null;

export function getDefaultSandboxService(): SandboxService {
  if (!defaultInstance) defaultInstance = new SandboxService();
  return defaultInstance;
}

export function setDefaultSandboxServiceForTests(service: SandboxService | null): void {
  defaultInstance = service;
}
