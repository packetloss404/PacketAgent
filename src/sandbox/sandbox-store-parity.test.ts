import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PacketAgentData } from "../packetagent-store.js";
import type { SandboxExecRecord } from "./types.js";
import { createJsonSandboxStore, createSqliteSandboxStore } from "./sandbox-store.js";

function inMemoryDocumentDeps() {
  const data: Partial<PacketAgentData> = {};
  return {
    loadStore: () => data as PacketAgentData,
    mutateStore: <T>(mutator: (value: PacketAgentData) => T): T => mutator(data as PacketAgentData),
  };
}

function policyRecord(): SandboxExecRecord {
  return {
    id: "exec-policy-parity",
    workspaceId: "alpha",
    sandboxId: "packetagent-sandbox-policy",
    driver: "docker",
    runtime: "node-20",
    command: "node --version",
    workingDir: "/workspace",
    env: { CI: "[redacted]" },
    status: "success",
    exitCode: 0,
    cpuLimitMs: 30_000,
    wallClockTimeoutMs: 30_000,
    cpuLimit: 0.5,
    memoryLimitMb: 256,
    processLimit: 32,
    tmpfsSizeMb: 128,
    networkPolicy: "none",
    filesystemPolicy: "read-only-root+bounded-tmpfs",
    environmentPolicy: "validated-explicit",
    createdAt: "2026-07-29T20:00:00.000Z",
    updatedAt: "2026-07-29T20:00:01.000Z",
  };
}

test("sandbox execution policy fields have JSON and SQLite persistence parity", async () => {
  const root = await mkdtemp(join(tmpdir(), "packetagent-sandbox-policy-"));
  try {
    const jsonStore = createJsonSandboxStore(inMemoryDocumentDeps());
    const sqliteStore = createSqliteSandboxStore({
      ...inMemoryDocumentDeps(),
      dbPath: join(root, "sandbox.sqlite"),
    });
    const record = policyRecord();

    await jsonStore.insertExec(record);
    await sqliteStore.insertExec(record);

    assert.deepEqual(await jsonStore.getExec("alpha", record.id), record);
    assert.deepEqual(await sqliteStore.getExec("alpha", record.id), record);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
