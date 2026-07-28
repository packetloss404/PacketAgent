import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
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
    cpus: 1,
  });

  for (const expected of [
    "--network=none",
    "--pids-limit=64",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    "--user=65534:65534",
    "--read-only",
    "--tmpfs",
  ]) {
    assert.ok(capturedArgs.includes(expected), `missing ${expected}`);
  }
  assert.equal(capturedArgs.includes("-e"), false);
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
