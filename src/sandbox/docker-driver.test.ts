import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createDockerDriver } from "./docker-driver.js";

test("Docker sandbox applies isolation flags and scrubs the Docker CLI environment", async () => {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;

  let capturedArgs: readonly string[] = [];
  let capturedOptions: Record<string, unknown> = {};
  const spawnImpl = ((
    command: string,
    args: readonly string[],
    options: Record<string, unknown>,
  ) => {
    assert.equal(command, "docker");
    capturedArgs = args;
    capturedOptions = options;
    return child;
  }) as unknown as typeof spawn;

  const driver = createDockerDriver({
    spawnImpl,
    availabilityProbe: async () => true,
  });
  const handle = await driver.start({
    execId: "exec-1",
    runtime: "node-20",
    command: "'node' '--version'",
    workingDir: "/tmp",
    env: {},
    timeoutMs: 1_000,
    memoryLimitMb: 256,
    cpus: 0.5,
    pidsLimit: 32,
    tmpfsSizeMb: 128,
    networkPolicy: "none",
    image: "packetagent-codegen-validator:abc123",
    mounts: [{ source: join(tmpdir(), "generated-input"), target: "/input", readOnly: true }],
  });

  for (const expected of [
    "--network=none",
    "--ipc=none",
    "--cpus=0.5",
    "--memory=256m",
    "--memory-swap=256m",
    "--pids-limit=32",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    "--user=65534:65534",
    "--read-only",
    "--tmpfs",
  ]) {
    assert.ok(capturedArgs.includes(expected), `missing ${expected}`);
  }
  assert.equal(capturedArgs.includes("-e"), false);
  assert.ok(capturedArgs.includes("packetagent-codegen-validator:abc123"));
  const tmpfsIndex = capturedArgs.indexOf("--tmpfs");
  assert.equal(capturedArgs[tmpfsIndex + 1], "/tmp:rw,nosuid,nodev,exec,size=128m,mode=1777");
  const mountIndex = capturedArgs.indexOf("--mount");
  assert.ok(mountIndex >= 0);
  assert.match(capturedArgs[mountIndex + 1] ?? "", /target=\/input,readonly$/);
  assert.equal(capturedOptions.shell, false);
  const env = capturedOptions.env as NodeJS.ProcessEnv;
  const allowed = new Set([
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
  ]);
  assert.equal(
    Object.keys(env).every((key) => allowed.has(key)),
    true,
  );

  child.emit("close", 0, null);
  await handle.done;
});

test("Docker sandbox rejects missing network policy and writable or out-of-scope mounts", async () => {
  const driver = createDockerDriver({
    availabilityProbe: async () => true,
  });
  const base = {
    execId: "exec-policy",
    runtime: "node-20",
    command: "true",
    workingDir: "/tmp",
    timeoutMs: 1_000,
    memoryLimitMb: 256,
    cpus: 1,
    pidsLimit: 32,
    tmpfsSizeMb: 128,
  };

  await assert.rejects(() => driver.start(base), /networkPolicy=none/);
  await assert.rejects(
    () =>
      driver.start({
        ...base,
        networkPolicy: "none",
        mounts: [{ source: join(tmpdir(), "generated-input"), target: "/input", readOnly: false }],
      }),
    /invalid trusted bind mount/,
  );
  await assert.rejects(
    () =>
      driver.start({
        ...base,
        networkPolicy: "none",
        mounts: [
          { source: join(tmpdir(), "generated-input"), target: "/workspace", readOnly: true },
        ],
      }),
    /invalid trusted bind mount/,
  );
});
