import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { SandboxService } from "./sandbox-service.js";
import { createJsonSandboxStore } from "./sandbox-store.js";
import type {
  SandboxChunkListener,
  SandboxDriver,
  SandboxExitListener,
  SandboxHandle,
  SandboxStartSpec,
  SandboxSubscription,
} from "./sandbox-driver.js";
import type { PacketAgentData } from "../packetagent-store.js";

interface MockHandleInternal extends SandboxHandle {
  emitter: EventEmitter;
  exitedCalled: boolean;
  done: Promise<void>;
}

interface MockDriverOptions {
  /** Behavior to invoke once start completes. Allows tests to simulate
   *  chunks/exit asynchronously. */
  behavior: (handle: MockHandleInternal, spec: SandboxStartSpec) => void;
  available?: boolean;
  id?: SandboxDriver["id"];
}

function createMockDriver(opts: MockDriverOptions): SandboxDriver & {
  cancelCalled: number;
  startedSpecs: SandboxStartSpec[];
} {
  let counter = 0;
  let cancelCalled = 0;
  const startedSpecs: SandboxStartSpec[] = [];

  const driver: SandboxDriver & { cancelCalled: number; startedSpecs: SandboxStartSpec[] } = {
    id: opts.id ?? "native",
    cancelCalled: 0,
    startedSpecs,
    async available() {
      return opts.available ?? true;
    },
    runtimes() {
      return [{ id: "mock", ready: true }];
    },
    async start(spec: SandboxStartSpec): Promise<SandboxHandle> {
      counter += 1;
      startedSpecs.push(spec);
      const emitter = new EventEmitter();
      const handle: MockHandleInternal = {
        sandboxId: `mock:${counter}`,
        emitter,
        exitedCalled: false,
        done: new Promise<void>(() => {}),
      };
      let resolveDone!: () => void;
      handle.done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      emitter.once("exit", () => resolveDone());
      // Defer behavior so caller can subscribe first.
      setImmediate(() => opts.behavior(handle, spec));
      return handle;
    },
    async cancel(handle: SandboxHandle) {
      cancelCalled += 1;
      driver.cancelCalled = cancelCalled;
      const internal = handle as MockHandleInternal;
      if (!internal.exitedCalled) {
        internal.exitedCalled = true;
        setImmediate(() =>
          internal.emitter.emit("exit", {
            exitCode: null,
            signal: "SIGKILL",
            errorMessage: "execution canceled",
          }),
        );
      }
    },
    subscribe(handle, onChunk, onExit): SandboxSubscription {
      const internal = handle as MockHandleInternal;
      internal.emitter.on("chunk", onChunk as (event: unknown) => void);
      internal.emitter.once("exit", (evt: Parameters<SandboxExitListener>[0]) => {
        internal.exitedCalled = true;
        (onExit as (event: Parameters<SandboxExitListener>[0]) => void)(evt);
      });
      void onChunk;
      void onExit;
      return {
        unsubscribe() {
          internal.emitter.removeAllListeners("chunk");
          internal.emitter.removeAllListeners("exit");
        },
      };
    },
  };
  return driver;
}

function createInMemoryStore() {
  const data: Partial<PacketAgentData> = {};
  return createJsonSandboxStore({
    loadStore: () => data as PacketAgentData,
    mutateStore: <T>(mutator: (data: PacketAgentData) => T): T => mutator(data as PacketAgentData),
  });
}

test("sandbox service: store insert + get round-trip", async () => {
  const store = createInMemoryStore();
  const now = new Date("2026-05-03T12:00:00.000Z");
  const record = {
    id: "exec-1",
    workspaceId: "alpha",
    sandboxId: "mock:1",
    driver: "native" as const,
    runtime: "node-20",
    command: "echo hi",
    workingDir: "/workspace",
    status: "queued" as const,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await store.insertExec(record);
  const found = await store.getExec("alpha", "exec-1");
  assert.ok(found);
  assert.equal(found?.id, "exec-1");
  assert.equal(found?.command, "echo hi");

  await store.updateExec("exec-1", { status: "success", exitCode: 0 });
  const updated = await store.getExec("alpha", "exec-1");
  assert.equal(updated?.status, "success");
  assert.equal(updated?.exitCode, 0);

  const list = await store.listExecs("alpha");
  assert.equal(list.length, 1);
  assert.equal(list[0]?.id, "exec-1");
});

test("sandbox service: happy path stdout exit 0 → success", async () => {
  const store = createInMemoryStore();
  const driver = createMockDriver({
    behavior: (handle) => {
      handle.emitter.emit("chunk", { stream: "stdout", data: "hello\n" });
      handle.emitter.emit("exit", { exitCode: 0, signal: null });
    },
  });
  const service = new SandboxService({
    store,
    dockerDriver: driver,
    nativeDriver: driver,
    forcedDriver: "native",
    env: { PACKETAGENT_ALLOW_INSECURE_NATIVE_SANDBOX: "true" },
  });
  const exec = await service.startTrustedHostExec({
    workspaceId: "alpha",
    command: "echo hello",
  });
  const final = await service.waitForExec(exec.id);
  assert.equal(final?.status, "success");
  assert.equal(final?.exitCode, 0);
  assert.ok(final?.stdoutPreview?.includes("hello"));
  assert.equal(final?.driver, "native");
  assert.equal(driver.startedSpecs[0]?.workingDir, process.cwd());
});

test("sandbox service: cancel stops the exec and reports canceled", async () => {
  const store = createInMemoryStore();
  // Long-running mock: never emits exit on its own.
  const driver = createMockDriver({
    behavior: (handle) => {
      handle.emitter.emit("chunk", { stream: "stdout", data: "starting\n" });
    },
  });
  const service = new SandboxService({
    store,
    dockerDriver: driver,
    nativeDriver: driver,
    forcedDriver: "native",
    env: { PACKETAGENT_ALLOW_INSECURE_NATIVE_SANDBOX: "true" },
  });
  const exec = await service.startTrustedHostExec({
    workspaceId: "alpha",
    command: "sleep 60",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const canceled = await service.cancelExec("alpha", exec.id);
  assert.equal(canceled?.status, "canceled");
  // Wait for the underlying driver exit to flush
  await service.waitForExec(exec.id);
  const final = await service.getExec("alpha", exec.id);
  assert.equal(final?.status, "canceled");
  assert.equal(driver.cancelCalled, 1);
});

test("sandbox service: enforces driver timeout via timeout exit message", async () => {
  const store = createInMemoryStore();
  const driver = createMockDriver({
    behavior: (handle) => {
      // Simulate driver-side timeout
      setImmediate(() =>
        handle.emitter.emit("exit", {
          exitCode: null,
          signal: "SIGKILL",
          errorMessage: "execution timed out",
        }),
      );
    },
  });
  const service = new SandboxService({
    store,
    dockerDriver: driver,
    nativeDriver: driver,
    forcedDriver: "native",
    env: { PACKETAGENT_ALLOW_INSECURE_NATIVE_SANDBOX: "true" },
  });
  const exec = await service.startTrustedHostExec({
    workspaceId: "alpha",
    command: "sleep 99",
    timeoutMs: 50,
  });
  const final = await service.waitForExec(exec.id);
  assert.equal(final?.status, "timeout");
  assert.equal(final?.errorMessage, "execution timed out");
});

test("sandbox service: status reflects native driver insecure note", async () => {
  const store = createInMemoryStore();
  const driver = createMockDriver({ behavior: () => {} });
  const service = new SandboxService({
    store,
    dockerDriver: driver,
    nativeDriver: driver,
    forcedDriver: "native",
    env: { PACKETAGENT_ALLOW_INSECURE_NATIVE_SANDBOX: "true" },
  });
  const status = await service.getStatus();
  assert.equal(status.driver, "native");
  assert.equal(status.available, true);
  assert.equal(status.executionClass, "trusted-host-only");
  assert.equal(status.untrustedCodeSupported, false);
  assert.match(status.note ?? "", /no isolation/i);
});

test("sandbox service: native driver always fails closed for untrusted execution", async () => {
  const store = createInMemoryStore();
  const driver = createMockDriver({ behavior: () => {} });
  const service = new SandboxService({
    store,
    dockerDriver: driver,
    nativeDriver: driver,
    forcedDriver: "native",
    env: { PACKETAGENT_ALLOW_INSECURE_NATIVE_SANDBOX: "true" },
  });

  await assert.rejects(
    () => service.startExec({ workspaceId: "alpha", command: "echo unsafe" }),
    /untrusted execution requires Docker/,
  );
  assert.equal(driver.startedSpecs.length, 0);
});

test("sandbox service: resolves, persists, and passes one bounded Docker policy", async () => {
  const store = createInMemoryStore();
  const driver = createMockDriver({
    id: "docker",
    behavior: (handle) => {
      handle.emitter.emit("exit", { exitCode: 0, signal: null });
    },
  });
  const service = new SandboxService({
    store,
    dockerDriver: driver,
    nativeDriver: driver,
    forcedDriver: "docker",
    env: {
      PACKETAGENT_SANDBOX_MAX_TIMEOUT_MS: "30000",
      PACKETAGENT_SANDBOX_MEMORY_MB: "256",
      PACKETAGENT_SANDBOX_CPUS: "0.5",
      PACKETAGENT_SANDBOX_PIDS_LIMIT: "32",
      PACKETAGENT_SANDBOX_TMPFS_MB: "128",
    },
  });

  const started = await service.startExec({
    workspaceId: "alpha",
    command: "node --version",
    workingDir: "/tmp/job",
    timeoutMs: 25_000,
    env: { CI: "1" },
  });
  const final = await service.waitForExec(started.id);

  assert.equal(final?.wallClockTimeoutMs, 25_000);
  assert.equal(final?.cpuLimit, 0.5);
  assert.equal(final?.memoryLimitMb, 256);
  assert.equal(final?.processLimit, 32);
  assert.equal(final?.tmpfsSizeMb, 128);
  assert.equal(final?.networkPolicy, "none");
  assert.equal(final?.filesystemPolicy, "read-only-root+bounded-tmpfs");
  assert.equal(final?.environmentPolicy, "validated-explicit");
  assert.deepEqual(final?.env, { CI: "[redacted]" });

  const spec = driver.startedSpecs[0];
  assert.equal(spec?.timeoutMs, 25_000);
  assert.equal(spec?.cpus, 0.5);
  assert.equal(spec?.memoryLimitMb, 256);
  assert.equal(spec?.pidsLimit, 32);
  assert.equal(spec?.tmpfsSizeMb, 128);
  assert.equal(spec?.networkPolicy, "none");
  assert.deepEqual(spec?.env, { CI: "1" });
});

test("sandbox service: rejects policy escapes before Docker starts", async () => {
  const store = createInMemoryStore();
  const driver = createMockDriver({ id: "docker", behavior: () => {} });
  const service = new SandboxService({
    store,
    dockerDriver: driver,
    nativeDriver: driver,
    forcedDriver: "docker",
    env: { PACKETAGENT_SANDBOX_MAX_TIMEOUT_MS: "30000" },
  });

  await assert.rejects(
    () =>
      service.startExec({
        workspaceId: "alpha",
        command: "true",
        env: { OPENAI_API_KEY: "must-not-enter-sandbox" },
      }),
    /env name is not allowed/,
  );
  await assert.rejects(
    () =>
      service.startExec({
        workspaceId: "alpha",
        command: "true",
        workingDir: "/etc",
      }),
    /workingDir/,
  );
  await assert.rejects(
    () =>
      service.startExec({
        workspaceId: "alpha",
        command: "true",
        timeoutMs: 30_001,
      }),
    /timeoutMs/,
  );
  assert.equal(driver.startedSpecs.length, 0);
});

test("sandbox service: blocks native driver in production by default", async () => {
  const store = createInMemoryStore();
  const driver = createMockDriver({ behavior: () => {} });
  const service = new SandboxService({
    store,
    dockerDriver: driver,
    nativeDriver: driver,
    forcedDriver: "native",
    env: { NODE_ENV: "production" },
  });

  await assert.rejects(() => service.getStatus(), /native driver is blocked/);
});

test("sandbox service: blocks auto fallback to native in production when Docker is unavailable", async () => {
  const store = createInMemoryStore();
  const dockerDriver = createMockDriver({ behavior: () => {}, available: false, id: "docker" });
  const nativeDriver = createMockDriver({ behavior: () => {} });
  const service = new SandboxService({
    store,
    dockerDriver,
    nativeDriver,
    env: { NODE_ENV: "production", PACKETAGENT_SANDBOX_DRIVER: "auto" },
  });

  await assert.rejects(() => service.getStatus(), /native fallback is disabled/);
});

test("sandbox service: allows explicit insecure native opt-in in production", async () => {
  const store = createInMemoryStore();
  const driver = createMockDriver({ behavior: () => {} });
  const service = new SandboxService({
    store,
    dockerDriver: driver,
    nativeDriver: driver,
    forcedDriver: "native",
    env: {
      NODE_ENV: "production",
      PACKETAGENT_ALLOW_INSECURE_NATIVE_SANDBOX: "true",
    },
  });

  const status = await service.getStatus();
  assert.equal(status.driver, "native");
});

test("sandbox service: runSmokeBatch aggregates pass when all items succeed", async () => {
  const store = createInMemoryStore();
  const driver = createMockDriver({
    id: "docker",
    behavior: (handle) => {
      handle.emitter.emit("chunk", { stream: "stdout", data: "ok\n" });
      handle.emitter.emit("exit", { exitCode: 0, signal: null });
    },
  });
  const service = new SandboxService({
    store,
    dockerDriver: driver,
    nativeDriver: driver,
    forcedDriver: "docker",
  });
  const result = await service.runSmokeBatch("alpha", [
    { name: "route /a", command: "echo a" },
    { name: "route /b", command: "echo b" },
  ]);
  assert.equal(result.status, "pass");
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0]?.status, "pass");
  assert.equal(result.items[0]?.exitCode, 0);
  assert.ok(result.items[0]?.execId);
});

test("sandbox service: runSmokeBatch reports fail when any item exits non-zero", async () => {
  const store = createInMemoryStore();
  let count = 0;
  const driver = createMockDriver({
    id: "docker",
    behavior: (handle) => {
      const exitCode = count++ === 0 ? 0 : 1;
      handle.emitter.emit("chunk", { stream: "stdout", data: "x" });
      handle.emitter.emit("exit", { exitCode, signal: null });
    },
  });
  const service = new SandboxService({
    store,
    dockerDriver: driver,
    nativeDriver: driver,
    forcedDriver: "docker",
  });
  const result = await service.runSmokeBatch("alpha", [
    { name: "first", command: "echo ok" },
    { name: "second", command: "false" },
  ]);
  assert.equal(result.status, "fail");
  assert.equal(result.items[0]?.status, "pass");
  assert.equal(result.items[1]?.status, "fail");
  assert.equal(result.items[1]?.exitCode, 1);
});

test("sandbox service: stdout/stderr previews are bounded to ~16KB", async () => {
  const store = createInMemoryStore();
  const driver = createMockDriver({
    behavior: (handle) => {
      handle.emitter.emit("chunk", { stream: "stdout", data: "X".repeat(20_000) });
      handle.emitter.emit("chunk", { stream: "stdout", data: "TAIL" });
      handle.emitter.emit("exit", { exitCode: 0, signal: null });
    },
  });
  const service = new SandboxService({
    store,
    dockerDriver: driver,
    nativeDriver: driver,
    forcedDriver: "native",
    env: { PACKETAGENT_ALLOW_INSECURE_NATIVE_SANDBOX: "true" },
  });
  const exec = await service.startTrustedHostExec({
    workspaceId: "alpha",
    command: "spew",
  });
  const final = await service.waitForExec(exec.id);
  assert.ok(final?.stdoutPreview);
  assert.ok((final?.stdoutPreview?.length ?? 0) <= 16 * 1024);
  assert.ok(final?.stdoutPreview?.endsWith("TAIL"), "preview should retain the tail of the stream");
});

test("sandbox service: preview limits are byte-based for multibyte output", async () => {
  const store = createInMemoryStore();
  const driver = createMockDriver({
    id: "docker",
    behavior: (handle) => {
      handle.emitter.emit("chunk", { stream: "stdout", data: "🧪".repeat(10_000) });
      handle.emitter.emit("exit", { exitCode: 0, signal: null });
    },
  });
  const service = new SandboxService({
    store,
    dockerDriver: driver,
    nativeDriver: driver,
    forcedDriver: "docker",
  });
  const exec = await service.startExec({ workspaceId: "alpha", command: "spew" });
  const final = await service.waitForExec(exec.id);

  assert.ok(Buffer.byteLength(final?.stdoutPreview ?? "", "utf8") <= 16 * 1024);
});
