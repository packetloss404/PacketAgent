import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileLeaderLock, noopLeaderLock } from "./scheduler-lock.js";

function makeTempDir(): string {
  const dir = path.join(tmpdir(), `packetagent-leader-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("noopLeaderLock acquires, releases without throwing, and reports held", async () => {
  const lock = noopLeaderLock();
  assert.equal(lock.isHeld(), true);
  assert.equal(await lock.acquire(), true);
  assert.equal(lock.isHeld(), true);
  await lock.release();
  assert.equal(lock.isHeld(), true);
});

test("fileLeaderLock first acquire writes the lock file with our processId", async (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lockPath = path.join(dir, "scheduler.lock");
  const lock = fileLeaderLock({ path: lockPath, processId: "proc-a", ttlMs: 5_000, now: () => 1_000 });

  const acquired = await lock.acquire();
  assert.equal(acquired, true);
  assert.equal(lock.isHeld(), true);

  const raw = readFileSync(lockPath, "utf8");
  const state = JSON.parse(raw) as { processId: string; expiresAt: number };
  assert.equal(state.processId, "proc-a");
  assert.equal(state.expiresAt, 6_000);
});

test("fileLeaderLock same-processId re-acquire renews the TTL", async (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lockPath = path.join(dir, "scheduler.lock");
  let now = 1_000;
  const lock = fileLeaderLock({ path: lockPath, processId: "proc-a", ttlMs: 5_000, now: () => now });

  assert.equal(await lock.acquire(), true);
  const first = JSON.parse(readFileSync(lockPath, "utf8")) as { expiresAt: number };
  assert.equal(first.expiresAt, 6_000);

  now = 3_000;
  assert.equal(await lock.acquire(), true);
  assert.equal(lock.isHeld(), true);
  const renewed = JSON.parse(readFileSync(lockPath, "utf8")) as { expiresAt: number; processId: string };
  assert.equal(renewed.expiresAt, 8_000);
  assert.equal(renewed.processId, "proc-a");
});

test("fileLeaderLock different processId fails to acquire while non-expired lock is held", async (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lockPath = path.join(dir, "scheduler.lock");
  const owner = fileLeaderLock({ path: lockPath, processId: "proc-a", ttlMs: 5_000, now: () => 1_000 });
  const challenger = fileLeaderLock({ path: lockPath, processId: "proc-b", ttlMs: 5_000, now: () => 2_000 });

  assert.equal(await owner.acquire(), true);
  assert.equal(await challenger.acquire(), false);
  assert.equal(challenger.isHeld(), false);

  const state = JSON.parse(readFileSync(lockPath, "utf8")) as { processId: string };
  assert.equal(state.processId, "proc-a");
});

test("fileLeaderLock different processId can take over after the lock expires", async (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lockPath = path.join(dir, "scheduler.lock");
  const owner = fileLeaderLock({ path: lockPath, processId: "proc-a", ttlMs: 5_000, now: () => 1_000 });
  const challenger = fileLeaderLock({ path: lockPath, processId: "proc-b", ttlMs: 5_000, now: () => 10_000 });

  assert.equal(await owner.acquire(), true);
  assert.equal(await challenger.acquire(), true);
  assert.equal(challenger.isHeld(), true);

  const state = JSON.parse(readFileSync(lockPath, "utf8")) as { processId: string; expiresAt: number };
  assert.equal(state.processId, "proc-b");
  assert.equal(state.expiresAt, 15_000);
});

test("fileLeaderLock release deletes the file when we own it; new owner can then acquire", async (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lockPath = path.join(dir, "scheduler.lock");
  const owner = fileLeaderLock({ path: lockPath, processId: "proc-a", ttlMs: 5_000, now: () => 1_000 });
  const challenger = fileLeaderLock({ path: lockPath, processId: "proc-b", ttlMs: 5_000, now: () => 2_000 });

  assert.equal(await owner.acquire(), true);
  await owner.release();
  assert.equal(owner.isHeld(), false);
  assert.equal(existsSync(lockPath), false);

  assert.equal(await challenger.acquire(), true);
  const state = JSON.parse(readFileSync(lockPath, "utf8")) as { processId: string };
  assert.equal(state.processId, "proc-b");
});

test("fileLeaderLock release does not delete the file when a different processId owns it", async (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lockPath = path.join(dir, "scheduler.lock");
  const owner = fileLeaderLock({ path: lockPath, processId: "proc-a", ttlMs: 5_000, now: () => 1_000 });
  const stranger = fileLeaderLock({ path: lockPath, processId: "proc-b", ttlMs: 5_000, now: () => 2_000 });

  assert.equal(await owner.acquire(), true);
  await stranger.release();

  assert.equal(existsSync(lockPath), true);
  const state = JSON.parse(readFileSync(lockPath, "utf8")) as { processId: string };
  assert.equal(state.processId, "proc-a");
});

test("fileLeaderLock treats a corrupt JSON file as no-holder and acquires", async (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lockPath = path.join(dir, "scheduler.lock");
  writeFileSync(lockPath, "{not valid json", "utf8");

  const lock = fileLeaderLock({ path: lockPath, processId: "proc-a", ttlMs: 5_000, now: () => 1_000 });
  assert.equal(await lock.acquire(), true);
  assert.equal(lock.isHeld(), true);

  const state = JSON.parse(readFileSync(lockPath, "utf8")) as { processId: string };
  assert.equal(state.processId, "proc-a");
});

test("fileLeaderLock acquire throws when parent directory does not exist", async () => {
  const missing = path.join(tmpdir(), `packetagent-leader-missing-${randomUUID()}`, "scheduler.lock");
  const lock = fileLeaderLock({ path: missing, processId: "proc-a", ttlMs: 5_000, now: () => 1_000 });
  await assert.rejects(() => lock.acquire(), /parent directory/);
});
