import assert from "node:assert/strict";
import test from "node:test";
import type { SandboxDriver } from "../sandbox/sandbox-driver.js";
import type { SandboxExecRequest } from "../sandbox/sandbox-service.js";
import type { SandboxExecRecord } from "../sandbox/types.js";
import { createWorkerSandboxPort, type WorkerSandboxService } from "./sandbox-execution.js";

function driver(id: "docker" | "native"): SandboxDriver {
  return {
    id,
    available: async () => true,
    runtimes: () => [],
    async start() {
      throw new Error("unused");
    },
    async cancel() {},
    subscribe() {
      return { unsubscribe() {} };
    },
  };
}

function record(
  request: SandboxExecRequest,
  patch: Partial<SandboxExecRecord> = {},
): SandboxExecRecord {
  return {
    id: "exec-1",
    workspaceId: request.workspaceId,
    sandboxId: "container-1",
    driver: "docker",
    runtime: request.runtime ?? "node-20",
    command: request.command,
    workingDir: request.workingDir ?? "/tmp",
    status: "success",
    exitCode: 0,
    stdoutPreview: "done",
    stderrPreview: "",
    createdAt: "2026-07-27T12:00:00.000Z",
    updatedAt: "2026-07-27T12:00:01.000Z",
    ...patch,
  };
}

test("Worker sandbox refuses the native driver even when the generic service selected it", async () => {
  let started = false;
  const service: WorkerSandboxService = {
    resolveDriver: async () => driver("native"),
    async startExec() {
      started = true;
      throw new Error("must not start");
    },
    waitForExec: async () => null,
    cancelExec: async () => null,
  };

  await assert.rejects(
    createWorkerSandboxPort(service).execute({
      workspaceId: "alpha",
      command: "node",
      args: ["--version"],
      timeoutMs: 1_000,
      signal: new AbortController().signal,
      network: "none",
    }),
    /requires the isolated Docker sandbox driver/,
  );
  assert.equal(started, false);
});

test("Worker sandbox uses Docker with no environment, no network, bounded time, and quoted args", async () => {
  let request: SandboxExecRequest | undefined;
  const service: WorkerSandboxService = {
    resolveDriver: async () => driver("docker"),
    async startExec(input) {
      request = input;
      return record(input, { status: "running" });
    },
    async waitForExec() {
      return record(request!, { status: "success" });
    },
    cancelExec: async () => null,
  };

  const result = await createWorkerSandboxPort(service).execute({
    workspaceId: "alpha",
    command: "node",
    args: ["-e", "console.log('safe')"],
    timeoutMs: 2_500,
    signal: new AbortController().signal,
    network: "none",
  });

  assert.equal(result.status, "success");
  assert.equal(result.stdout, "done");
  assert.deepEqual(request, {
    workspaceId: "alpha",
    command: `'node' '-e' 'console.log('"'"'safe'"'"')'`,
    runtime: "node-20",
    workingDir: "/tmp",
    timeoutMs: 2_500,
    env: {},
  });
});

test("Worker sandbox passes adversarial arguments as quoted data without shell interpolation", async () => {
  let request: SandboxExecRequest | undefined;
  const service: WorkerSandboxService = {
    resolveDriver: async () => driver("docker"),
    async startExec(input) {
      request = input;
      return record(input, { status: "running" });
    },
    async waitForExec() {
      return record(request!, { status: "success" });
    },
    cancelExec: async () => null,
  };

  await createWorkerSandboxPort(service).execute({
    workspaceId: "alpha",
    command: "node",
    args: [
      "$(touch /tmp/packetagent-pwned)",
      "; rm -rf /",
      "single'quote",
      "line\nbreak",
      '"double quoted"',
    ],
    timeoutMs: 2_500,
    signal: new AbortController().signal,
    network: "none",
  });

  assert.equal(
    request?.command,
    `'node' '$(touch /tmp/packetagent-pwned)' '; rm -rf /' 'single'"'"'quote' 'line\nbreak' '"double quoted"'`,
  );
});
