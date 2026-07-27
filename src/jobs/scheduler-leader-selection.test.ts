import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { selectSchedulerLeaderLock, type SchedulerLeaderEnv } from "./scheduler-leader-selection.js";

function makeTempDir(): string {
  const dir = path.join(tmpdir(), `packetagent-leader-sel-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("default env returns a noop lock that acquires successfully", async () => {
  const lock = selectSchedulerLeaderLock({});
  assert.equal(typeof lock.acquire, "function");
  assert.equal(await lock.acquire(), true);
  assert.equal(lock.isHeld(), true);
  await lock.release();
});

test("MODE=off returns a noop lock", async () => {
  const lock = selectSchedulerLeaderLock({ PACKETAGENT_SCHEDULER_LEADER_MODE: "off" });
  assert.equal(await lock.acquire(), true);
  assert.equal(lock.isHeld(), true);
  await lock.release();
});

test("MODE=off is case-insensitive and trims whitespace", async () => {
  const lock = selectSchedulerLeaderLock({ PACKETAGENT_SCHEDULER_LEADER_MODE: "  OFF  " });
  assert.equal(await lock.acquire(), true);
});

test("MODE=file returns a lock that writes the expected file at the configured path", async (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lockPath = path.join(dir, "leader.json");

  const env: SchedulerLeaderEnv = {
    PACKETAGENT_SCHEDULER_LEADER_MODE: "file",
    PACKETAGENT_SCHEDULER_LEADER_FILE_PATH: lockPath,
    PACKETAGENT_SCHEDULER_LEADER_PROCESS_ID: "test-proc-1",
  };
  const lock = selectSchedulerLeaderLock(env);
  assert.equal(await lock.acquire(), true);
  assert.equal(lock.isHeld(), true);

  const state = JSON.parse(readFileSync(lockPath, "utf8")) as { processId: string; expiresAt: number };
  assert.equal(state.processId, "test-proc-1");
  assert.equal(typeof state.expiresAt, "number");

  await lock.release();
});

test("MODE=http without URL throws a descriptive error", () => {
  assert.throws(
    () => selectSchedulerLeaderLock({ PACKETAGENT_SCHEDULER_LEADER_MODE: "http" }),
    /PACKETAGENT_SCHEDULER_LEADER_HTTP_URL/,
  );
});

test("MODE=http with URL constructs a lock satisfying the interface", () => {
  const lock = selectSchedulerLeaderLock({
    PACKETAGENT_SCHEDULER_LEADER_MODE: "http",
    PACKETAGENT_SCHEDULER_LEADER_HTTP_URL: "http://localhost:9999/leader",
    PACKETAGENT_SCHEDULER_LEADER_HTTP_SECRET: "shh",
  });
  assert.equal(typeof lock.acquire, "function");
  assert.equal(typeof lock.release, "function");
  assert.equal(typeof lock.isHeld, "function");
  assert.equal(lock.isHeld(), false);
});

test("invalid MODE value throws including the offending value in the message", () => {
  assert.throws(
    () => selectSchedulerLeaderLock({ PACKETAGENT_SCHEDULER_LEADER_MODE: "bogus" }),
    /off, file, http \(got: "bogus"\)/,
  );
});

test("explicitly empty MODE value throws", () => {
  assert.throws(
    () => selectSchedulerLeaderLock({ PACKETAGENT_SCHEDULER_LEADER_MODE: "" }),
    /off, file, http/,
  );
});

test("default TTL is 30000 when not set (file mode writes expiresAt = now + 30000)", async (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lockPath = path.join(dir, "leader.json");
  const before = Date.now();
  const lock = selectSchedulerLeaderLock({
    PACKETAGENT_SCHEDULER_LEADER_MODE: "file",
    PACKETAGENT_SCHEDULER_LEADER_FILE_PATH: lockPath,
    PACKETAGENT_SCHEDULER_LEADER_PROCESS_ID: "ttl-default",
  });
  assert.equal(await lock.acquire(), true);
  const after = Date.now();
  const state = JSON.parse(readFileSync(lockPath, "utf8")) as { expiresAt: number };
  assert.ok(state.expiresAt >= before + 30_000);
  assert.ok(state.expiresAt <= after + 30_000);
  await lock.release();
});

test("valid TTL override is respected", async (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lockPath = path.join(dir, "leader.json");
  const before = Date.now();
  const lock = selectSchedulerLeaderLock({
    PACKETAGENT_SCHEDULER_LEADER_MODE: "file",
    PACKETAGENT_SCHEDULER_LEADER_FILE_PATH: lockPath,
    PACKETAGENT_SCHEDULER_LEADER_PROCESS_ID: "ttl-override",
    PACKETAGENT_SCHEDULER_LEADER_TTL_MS: "60000",
  });
  assert.equal(await lock.acquire(), true);
  const after = Date.now();
  const state = JSON.parse(readFileSync(lockPath, "utf8")) as { expiresAt: number };
  assert.ok(state.expiresAt >= before + 60_000);
  assert.ok(state.expiresAt <= after + 60_000);
  await lock.release();
});

test("garbage TTL ('abc') falls back to default 30000", async (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lockPath = path.join(dir, "leader.json");
  const before = Date.now();
  const lock = selectSchedulerLeaderLock({
    PACKETAGENT_SCHEDULER_LEADER_MODE: "file",
    PACKETAGENT_SCHEDULER_LEADER_FILE_PATH: lockPath,
    PACKETAGENT_SCHEDULER_LEADER_PROCESS_ID: "ttl-abc",
    PACKETAGENT_SCHEDULER_LEADER_TTL_MS: "abc",
  });
  assert.equal(await lock.acquire(), true);
  const after = Date.now();
  const state = JSON.parse(readFileSync(lockPath, "utf8")) as { expiresAt: number };
  assert.ok(state.expiresAt >= before + 30_000);
  assert.ok(state.expiresAt <= after + 30_000);
  await lock.release();
});

test("zero TTL falls back to default 30000", async (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lockPath = path.join(dir, "leader.json");
  const before = Date.now();
  const lock = selectSchedulerLeaderLock({
    PACKETAGENT_SCHEDULER_LEADER_MODE: "file",
    PACKETAGENT_SCHEDULER_LEADER_FILE_PATH: lockPath,
    PACKETAGENT_SCHEDULER_LEADER_PROCESS_ID: "ttl-zero",
    PACKETAGENT_SCHEDULER_LEADER_TTL_MS: "0",
  });
  assert.equal(await lock.acquire(), true);
  const after = Date.now();
  const state = JSON.parse(readFileSync(lockPath, "utf8")) as { expiresAt: number };
  assert.ok(state.expiresAt >= before + 30_000);
  assert.ok(state.expiresAt <= after + 30_000);
  await lock.release();
});

test("negative TTL falls back to default 30000", async (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lockPath = path.join(dir, "leader.json");
  const before = Date.now();
  const lock = selectSchedulerLeaderLock({
    PACKETAGENT_SCHEDULER_LEADER_MODE: "file",
    PACKETAGENT_SCHEDULER_LEADER_FILE_PATH: lockPath,
    PACKETAGENT_SCHEDULER_LEADER_PROCESS_ID: "ttl-neg",
    PACKETAGENT_SCHEDULER_LEADER_TTL_MS: "-1",
  });
  assert.equal(await lock.acquire(), true);
  const after = Date.now();
  const state = JSON.parse(readFileSync(lockPath, "utf8")) as { expiresAt: number };
  assert.ok(state.expiresAt >= before + 30_000);
  assert.ok(state.expiresAt <= after + 30_000);
  await lock.release();
});

test("PACKETAGENT_SCHEDULER_LEADER_PROCESS_ID override is propagated to file lock", async (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lockPath = path.join(dir, "leader.json");
  const lock = selectSchedulerLeaderLock({
    PACKETAGENT_SCHEDULER_LEADER_MODE: "file",
    PACKETAGENT_SCHEDULER_LEADER_FILE_PATH: lockPath,
    PACKETAGENT_SCHEDULER_LEADER_PROCESS_ID: "custom-pid-xyz",
  });
  assert.equal(await lock.acquire(), true);
  const state = JSON.parse(readFileSync(lockPath, "utf8")) as { processId: string };
  assert.equal(state.processId, "custom-pid-xyz");
  await lock.release();
});
