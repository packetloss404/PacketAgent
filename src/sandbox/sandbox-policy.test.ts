import assert from "node:assert/strict";
import test from "node:test";
import {
  redactedSandboxEnvironment,
  resolveSandboxExecutionPolicy,
  SANDBOX_POLICY_LIMITS,
} from "./sandbox-policy.js";

function dockerPolicy(
  overrides: Partial<Parameters<typeof resolveSandboxExecutionPolicy>[0]> = {},
) {
  return resolveSandboxExecutionPolicy({
    driver: "docker",
    command: "node --version",
    workingDir: "/workspace",
    configEnv: {},
    ...overrides,
  });
}

test("sandbox policy resolves bounded Docker defaults and explicit safe env", () => {
  const policy = dockerPolicy({
    requestedEnv: { CI: "1", NODE_ENV: "sandbox" },
  });

  assert.deepEqual(policy, {
    driver: "docker",
    timeoutMs: 120_000,
    memoryLimitMb: 512,
    cpus: 1,
    pidsLimit: 64,
    tmpfsSizeMb: 256,
    workingDir: "/workspace",
    env: { CI: "1", NODE_ENV: "sandbox" },
    networkPolicy: "none",
    filesystemPolicy: "read-only-root+bounded-tmpfs",
    environmentPolicy: "validated-explicit",
  });
});

test("sandbox policy clamps operator resource configuration", () => {
  const policy = dockerPolicy({
    configEnv: {
      PACKETAGENT_SANDBOX_MEMORY_MB: "999999",
      PACKETAGENT_SANDBOX_CPUS: "0.01",
      PACKETAGENT_SANDBOX_PIDS_LIMIT: "2",
      PACKETAGENT_SANDBOX_TMPFS_MB: "999999",
      PACKETAGENT_SANDBOX_DEFAULT_TIMEOUT_MS: "900000",
      PACKETAGENT_SANDBOX_MAX_TIMEOUT_MS: "30000",
    },
  });

  assert.equal(policy.memoryLimitMb, 8_192);
  assert.equal(policy.cpus, 0.1);
  assert.equal(policy.pidsLimit, 16);
  assert.equal(policy.tmpfsSizeMb, 1_024);
  assert.equal(policy.timeoutMs, 30_000);
});

test("sandbox policy rejects timeout, working-directory, command, and stdin escapes", () => {
  assert.throws(() => dockerPolicy({ timeoutMs: 120_001 }), /timeoutMs/);
  assert.throws(() => dockerPolicy({ workingDir: "/etc" }), /workingDir/);
  assert.throws(() => dockerPolicy({ workingDir: "../workspace" }), /workingDir/);
  assert.throws(() => dockerPolicy({ command: `echo\u0000no` }), /command/);
  assert.throws(
    () =>
      dockerPolicy({
        stdin: "x".repeat(SANDBOX_POLICY_LIMITS.maxStdinBytes + 1),
      }),
    /stdin/,
  );
});

test("sandbox policy rejects secret, process-control, malformed, and oversized env", () => {
  for (const key of [
    "OPENAI_API_KEY",
    "AUTH_TOKEN",
    "DATABASE_URL",
    "NODE_OPTIONS",
    "LD_PRELOAD",
    "PATH",
    "bad-name",
  ]) {
    assert.throws(() => dockerPolicy({ requestedEnv: { [key]: "value" } }), /env name/);
  }
  assert.throws(
    () =>
      dockerPolicy({
        requestedEnv: { SAFE_VALUE: "x".repeat(SANDBOX_POLICY_LIMITS.maxEnvValueBytes + 1) },
      }),
    /too large/,
  );
});

test("sandbox policy redacts every persisted explicit env value", () => {
  assert.deepEqual(redactedSandboxEnvironment({ CI: "1", MODE: "test" }), {
    CI: "[redacted]",
    MODE: "[redacted]",
  });
});

test("trusted host policy is labeled as host authority, not isolated", () => {
  const policy = resolveSandboxExecutionPolicy({
    driver: "native",
    command: "echo trusted",
    workingDir: "D:\\trusted",
    configEnv: {},
  });

  assert.equal(policy.networkPolicy, "host");
  assert.equal(policy.filesystemPolicy, "host");
  assert.equal(policy.environmentPolicy, "scrubbed-host+validated-explicit");
});
