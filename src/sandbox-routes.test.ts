import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { Hono } from "hono";
import { SESSION_COOKIE_NAME } from "./auth-utils.js";
import { appRoutes } from "./app-routes.js";
import { createSandboxRoutes } from "./sandbox-routes.js";
import { enforcePrivateAppMutationSecurity } from "./route-security.js";
import { login } from "./packetagent-services.js";
import { mutateStore, resetStoreForTests } from "./packetagent-store.js";
import { SandboxService } from "./sandbox/sandbox-service.js";
import { createJsonSandboxStore } from "./sandbox/sandbox-store.js";
import type {
  SandboxDriver,
  SandboxExitListener,
  SandboxHandle,
  SandboxStartSpec,
  SandboxSubscription,
} from "./sandbox/sandbox-driver.js";
import type { PacketAgentData } from "./packetagent-store.js";

interface MockHandleInternal extends SandboxHandle {
  emitter: EventEmitter;
  exitedCalled: boolean;
  done: Promise<void>;
}

function createMockDriver(behavior: (handle: MockHandleInternal, spec: SandboxStartSpec) => void): SandboxDriver {
  let counter = 0;
  return {
    id: "native",
    async available() {
      return true;
    },
    runtimes() {
      return [{ id: "node-20", ready: true, image: "mock:node-20" }];
    },
    async start(spec: SandboxStartSpec): Promise<SandboxHandle> {
      counter += 1;
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
      setImmediate(() => behavior(handle, spec));
      return handle;
    },
    async cancel() {
      // not exercised here
    },
    subscribe(handle, onChunk, onExit): SandboxSubscription {
      const internal = handle as MockHandleInternal;
      internal.emitter.on("chunk", onChunk as (event: unknown) => void);
      internal.emitter.once("exit", (evt: Parameters<SandboxExitListener>[0]) => {
        internal.exitedCalled = true;
        (onExit as (event: Parameters<SandboxExitListener>[0]) => void)(evt);
      });
      return {
        unsubscribe() {
          internal.emitter.removeAllListeners("chunk");
          internal.emitter.removeAllListeners("exit");
        },
      };
    },
  };
}

function createInMemoryStore() {
  const data: Partial<PacketAgentData> = {};
  return createJsonSandboxStore({
    loadStore: () => data as PacketAgentData,
    mutateStore: <T,>(mutator: (data: PacketAgentData) => T): T => mutator(data as PacketAgentData),
  });
}

function createTestApp(service: SandboxService) {
  const app = new Hono();
  app.use("/api/app/*", enforcePrivateAppMutationSecurity);
  app.route("/api", appRoutes);
  app.route("/api/app/sandbox", createSandboxRoutes({ service }));
  return app;
}

function authHeaders(cookieValue: string) {
  return { Cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` };
}

test("sandbox routes: GET /status requires authentication", async () => {
  resetStoreForTests();
  const store = createInMemoryStore();
  const driver = createMockDriver(() => {});
  const service = new SandboxService({ store, dockerDriver: driver, nativeDriver: driver, forcedDriver: "native", env: { PACKETAGENT_ALLOW_INSECURE_NATIVE_SANDBOX: "true" } });
  const app = createTestApp(service);
  const response = await app.request("/api/app/sandbox/status");
  assert.equal(response.status, 401);
});

test("sandbox routes: POST /exec rejects users without member role", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  mutateStore((data) => {
    const m = data.memberships.find((entry) => entry.workspaceId === "alpha" && entry.userId === "user_alpha");
    assert.ok(m);
    m.role = "viewer";
  });
  const store = createInMemoryStore();
  const driver = createMockDriver(() => {});
  const service = new SandboxService({ store, dockerDriver: driver, nativeDriver: driver, forcedDriver: "native", env: { PACKETAGENT_ALLOW_INSECURE_NATIVE_SANDBOX: "true" } });
  const app = createTestApp(service);

  const response = await app.request("/api/app/sandbox/exec", {
    method: "POST",
    headers: { ...authHeaders(auth.cookieValue), "content-type": "application/json" },
    body: JSON.stringify({ command: "echo hi" }),
  });
  assert.equal(response.status, 403);
});

test("sandbox routes: POST /exec returns running record on happy path", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const store = createInMemoryStore();
  const driver = createMockDriver((handle) => {
    handle.emitter.emit("chunk", { stream: "stdout", data: "hello\n" });
    handle.emitter.emit("exit", { exitCode: 0, signal: null });
  });
  const service = new SandboxService({ store, dockerDriver: driver, nativeDriver: driver, forcedDriver: "native", env: { PACKETAGENT_ALLOW_INSECURE_NATIVE_SANDBOX: "true" } });
  const app = createTestApp(service);

  const response = await app.request("/api/app/sandbox/exec", {
    method: "POST",
    headers: { ...authHeaders(auth.cookieValue), "content-type": "application/json" },
    body: JSON.stringify({ command: "echo hello" }),
  });
  assert.equal(response.status, 201);
  const body = (await response.json()) as { exec: { id: string; status: string; driver: string; runtime: string } };
  assert.ok(body.exec.id);
  assert.ok(["queued", "running", "success"].includes(body.exec.status));
  assert.equal(body.exec.driver, "native");

  // Wait for completion, then GET the record
  await service.waitForExec(body.exec.id);
  const detail = await app.request(`/api/app/sandbox/exec/${body.exec.id}`, {
    headers: authHeaders(auth.cookieValue),
  });
  assert.equal(detail.status, 200);
  const detailBody = (await detail.json()) as { exec: { status: string; exitCode: number; stdoutPreview: string } };
  assert.equal(detailBody.exec.status, "success");
  assert.equal(detailBody.exec.exitCode, 0);
  assert.ok(detailBody.exec.stdoutPreview.includes("hello"));
});

test("sandbox routes: GET /exec lists workspace execs", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const store = createInMemoryStore();
  const driver = createMockDriver((handle) => {
    handle.emitter.emit("exit", { exitCode: 0, signal: null });
  });
  const service = new SandboxService({ store, dockerDriver: driver, nativeDriver: driver, forcedDriver: "native", env: { PACKETAGENT_ALLOW_INSECURE_NATIVE_SANDBOX: "true" } });
  const app = createTestApp(service);

  const created = await app.request("/api/app/sandbox/exec", {
    method: "POST",
    headers: { ...authHeaders(auth.cookieValue), "content-type": "application/json" },
    body: JSON.stringify({ command: "true" }),
  });
  const createdBody = (await created.json()) as { exec: { id: string } };
  await service.waitForExec(createdBody.exec.id);

  const listed = await app.request("/api/app/sandbox/exec?limit=10", {
    headers: authHeaders(auth.cookieValue),
  });
  assert.equal(listed.status, 200);
  const listedBody = (await listed.json()) as { execs: Array<{ id: string }> };
  assert.ok(listedBody.execs.some((e) => e.id === createdBody.exec.id));
});

test("sandbox routes: POST /exec/:id/cancel returns canceled record", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const store = createInMemoryStore();
  const driver: SandboxDriver = (() => {
    let counter = 0;
    let canceledHandle: MockHandleInternal | null = null;
    const inst: SandboxDriver = {
      id: "native",
      async available() {
        return true;
      },
      runtimes() {
        return [{ id: "node-20", ready: true }];
      },
      async start(spec: SandboxStartSpec): Promise<SandboxHandle> {
        counter += 1;
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
        canceledHandle = handle;
        void spec;
        return handle;
      },
      async cancel(handle: SandboxHandle): Promise<void> {
        const internal = handle as MockHandleInternal;
        if (canceledHandle === internal && !internal.exitedCalled) {
          internal.exitedCalled = true;
          internal.emitter.emit("exit", {
            exitCode: null,
            signal: "SIGKILL",
            errorMessage: "execution canceled",
          });
        }
      },
      subscribe(handle, onChunk, onExit): SandboxSubscription {
        const internal = handle as MockHandleInternal;
        internal.emitter.on("chunk", onChunk as (event: unknown) => void);
        internal.emitter.once("exit", (evt: Parameters<SandboxExitListener>[0]) => {
          internal.exitedCalled = true;
          (onExit as (event: Parameters<SandboxExitListener>[0]) => void)(evt);
        });
        return {
          unsubscribe() {
            internal.emitter.removeAllListeners("chunk");
            internal.emitter.removeAllListeners("exit");
          },
        };
      },
    };
    return inst;
  })();

  const service = new SandboxService({ store, dockerDriver: driver, nativeDriver: driver, forcedDriver: "native", env: { PACKETAGENT_ALLOW_INSECURE_NATIVE_SANDBOX: "true" } });
  const app = createTestApp(service);

  const created = await app.request("/api/app/sandbox/exec", {
    method: "POST",
    headers: { ...authHeaders(auth.cookieValue), "content-type": "application/json" },
    body: JSON.stringify({ command: "sleep 60" }),
  });
  const createdBody = (await created.json()) as { exec: { id: string } };

  const canceled = await app.request(`/api/app/sandbox/exec/${createdBody.exec.id}/cancel`, {
    method: "POST",
    headers: authHeaders(auth.cookieValue),
  });
  assert.equal(canceled.status, 200);
  const canceledBody = (await canceled.json()) as { exec: { status: string } };
  assert.equal(canceledBody.exec.status, "canceled");
});

test("sandbox routes: POST /exec rejects empty command", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const store = createInMemoryStore();
  const driver = createMockDriver(() => {});
  const service = new SandboxService({ store, dockerDriver: driver, nativeDriver: driver, forcedDriver: "native", env: { PACKETAGENT_ALLOW_INSECURE_NATIVE_SANDBOX: "true" } });
  const app = createTestApp(service);

  const response = await app.request("/api/app/sandbox/exec", {
    method: "POST",
    headers: { ...authHeaders(auth.cookieValue), "content-type": "application/json" },
    body: JSON.stringify({ command: "  " }),
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /command is required/);
});
