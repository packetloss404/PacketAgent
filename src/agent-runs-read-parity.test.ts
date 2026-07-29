import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  findAgentRunForWorkspaceIndexed,
  listAgentRunsForAgentIndexed,
  listAgentRunsForWorkspaceIndexed,
} from "./packetagent-store.js";
import {
  createAgentRunsRepository,
  jsonAgentRunsRepository,
} from "./repositories/agent-runs-repo.js";
import type { AgentRunRecord, PacketAgentData } from "./packetagent-store.js";

function makeStore(records: AgentRunRecord[] = []): PacketAgentData {
  return { agentRuns: [...records] } as unknown as PacketAgentData;
}

function makeRecord(
  overrides: Partial<AgentRunRecord> & { id: string; workspaceId: string; createdAt: string },
): AgentRunRecord {
  return {
    id: overrides.id,
    workspaceId: overrides.workspaceId,
    title: overrides.title ?? "Run",
    status: overrides.status ?? "success",
    logs: overrides.logs ?? [],
    createdAt: overrides.createdAt,
    updatedAt: overrides.updatedAt ?? overrides.createdAt,
    ...(overrides.agentId !== undefined ? { agentId: overrides.agentId } : {}),
    ...(overrides.triggerKind !== undefined ? { triggerKind: overrides.triggerKind } : {}),
    ...(overrides.transcript !== undefined ? { transcript: overrides.transcript } : {}),
    ...(overrides.startedAt !== undefined ? { startedAt: overrides.startedAt } : {}),
    ...(overrides.completedAt !== undefined ? { completedAt: overrides.completedAt } : {}),
    ...(overrides.inputs !== undefined ? { inputs: overrides.inputs } : {}),
    ...(overrides.output !== undefined ? { output: overrides.output } : {}),
    ...(overrides.error !== undefined ? { error: overrides.error } : {}),
    ...(overrides.toolCalls !== undefined ? { toolCalls: overrides.toolCalls } : {}),
    ...(overrides.modelUsed !== undefined ? { modelUsed: overrides.modelUsed } : {}),
    ...(overrides.costUsd !== undefined ? { costUsd: overrides.costUsd } : {}),
  };
}

function withTempSqlite<T>(fn: (dbPath: string) => T): T {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-agent-runs-read-parity-"));
  const dbPath = join(tempDir, "packetagent.sqlite");
  const previousStore = process.env.PACKETAGENT_STORE;
  const previousDbPath = process.env.PACKETAGENT_DB_PATH;
  process.env.PACKETAGENT_STORE = "sqlite";
  process.env.PACKETAGENT_DB_PATH = dbPath;
  try {
    return fn(dbPath);
  } finally {
    if (previousStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = previousStore;
    if (previousDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = previousDbPath;
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test("listAgentRunsForWorkspaceIndexed returns workspace-scoped runs sorted by createdAt DESC via repository", () => {
  const data = makeStore([
    makeRecord({ id: "run_a", workspaceId: "ws_target", createdAt: "2026-04-26T01:00:00.000Z" }),
    makeRecord({ id: "run_c", workspaceId: "ws_target", createdAt: "2026-04-26T03:00:00.000Z" }),
    makeRecord({ id: "run_b", workspaceId: "ws_target", createdAt: "2026-04-26T02:00:00.000Z" }),
    makeRecord({ id: "run_other", workspaceId: "ws_other", createdAt: "2026-04-26T04:00:00.000Z" }),
  ]);
  const repository = jsonAgentRunsRepository({ loadStore: () => data });

  const result = repository.list("ws_target");

  assert.deepEqual(
    result.map((entry) => entry.id),
    ["run_c", "run_b", "run_a"],
  );
});

test("listAgentRunsForWorkspaceIndexed returns [] when the workspace has no runs", () => {
  const data = makeStore([
    makeRecord({ id: "run_other", workspaceId: "ws_other", createdAt: "2026-04-26T01:00:00.000Z" }),
  ]);
  const repository = jsonAgentRunsRepository({ loadStore: () => data });

  const result = repository.list("ws_target");

  assert.deepEqual(result, []);
});

test("listAgentRunsForWorkspaceIndexed default limit is 50 and cap is 200", () => {
  const many: AgentRunRecord[] = [];
  for (let index = 0; index < 250; index += 1) {
    const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString();
    many.push(
      makeRecord({
        id: `run_${index.toString().padStart(4, "0")}`,
        workspaceId: "ws_target",
        createdAt: stamp,
      }),
    );
  }
  const data = makeStore(many);
  const repository = jsonAgentRunsRepository({ loadStore: () => data });

  const defaultLimit = repository.list("ws_target");
  assert.equal(defaultLimit.length, 50);
  // descending — newest (highest index) first
  assert.equal(defaultLimit[0].id, "run_0249");
  assert.equal(defaultLimit[49].id, "run_0200");

  const explicit = repository.list("ws_target", 100);
  assert.equal(explicit.length, 100);

  const capped = repository.list("ws_target", 1000);
  assert.equal(capped.length, 200);
});

test("listAgentRunsForAgentIndexed filters to the (workspaceId, agentId) tuple", () => {
  const data = makeStore([
    makeRecord({
      id: "run_alpha_1",
      workspaceId: "ws_target",
      agentId: "agent_alpha",
      createdAt: "2026-04-26T01:00:00.000Z",
    }),
    makeRecord({
      id: "run_alpha_2",
      workspaceId: "ws_target",
      agentId: "agent_alpha",
      createdAt: "2026-04-26T02:00:00.000Z",
    }),
    makeRecord({
      id: "run_beta",
      workspaceId: "ws_target",
      agentId: "agent_beta",
      createdAt: "2026-04-26T03:00:00.000Z",
    }),
    makeRecord({
      id: "run_other",
      workspaceId: "ws_other",
      agentId: "agent_alpha",
      createdAt: "2026-04-26T04:00:00.000Z",
    }),
  ]);
  const repository = jsonAgentRunsRepository({ loadStore: () => data });

  const alphaRuns = repository.listForAgent("ws_target", "agent_alpha");
  assert.deepEqual(
    alphaRuns.map((entry) => entry.id),
    ["run_alpha_2", "run_alpha_1"],
  );

  const betaRuns = repository.listForAgent("ws_target", "agent_beta");
  assert.deepEqual(
    betaRuns.map((entry) => entry.id),
    ["run_beta"],
  );

  const noneRuns = repository.listForAgent("ws_target", "agent_missing");
  assert.deepEqual(noneRuns, []);
});

test("findAgentRunForWorkspaceIndexed returns the matching row and null for cross-workspace lookups", () => {
  const data = makeStore([
    makeRecord({
      id: "run_match",
      workspaceId: "ws_target",
      createdAt: "2026-04-26T01:00:00.000Z",
    }),
    makeRecord({
      id: "run_other_ws",
      workspaceId: "ws_other",
      createdAt: "2026-04-26T02:00:00.000Z",
    }),
  ]);
  const repository = jsonAgentRunsRepository({ loadStore: () => data });

  const found = repository.find("ws_target", "run_match");
  assert.equal(found?.id, "run_match");

  const crossWorkspace = repository.find("ws_target", "run_other_ws");
  assert.equal(crossWorkspace, null);

  const missing = repository.find("ws_target", "run_does_not_exist");
  assert.equal(missing, null);
});

test("listAgentRunsForWorkspaceIndexed reads from the SQLite repository when PACKETAGENT_STORE=sqlite", () => {
  withTempSqlite((dbPath) => {
    const seedRecords: AgentRunRecord[] = [
      makeRecord({
        id: "sqlite_a",
        workspaceId: "ws_target",
        agentId: "agent_alpha",
        createdAt: "2026-04-26T01:00:00.000Z",
      }),
      makeRecord({
        id: "sqlite_b",
        workspaceId: "ws_target",
        agentId: "agent_beta",
        createdAt: "2026-04-26T02:00:00.000Z",
      }),
      makeRecord({
        id: "sqlite_c",
        workspaceId: "ws_target",
        agentId: "agent_alpha",
        createdAt: "2026-04-26T03:00:00.000Z",
      }),
      makeRecord({
        id: "sqlite_other",
        workspaceId: "ws_other",
        agentId: "agent_alpha",
        createdAt: "2026-04-26T04:00:00.000Z",
      }),
    ];

    const seedingRepo = createAgentRunsRepository({ dbPath });
    for (const record of seedRecords) {
      seedingRepo.upsert(record);
    }
    assert.equal(seedingRepo.count(), seedRecords.length);

    const descending = listAgentRunsForWorkspaceIndexed("ws_target");
    assert.deepEqual(
      descending.map((entry) => entry.id),
      ["sqlite_c", "sqlite_b", "sqlite_a"],
    );

    const filtered = listAgentRunsForAgentIndexed("ws_target", "agent_alpha");
    assert.deepEqual(
      filtered.map((entry) => entry.id),
      ["sqlite_c", "sqlite_a"],
    );

    const found = findAgentRunForWorkspaceIndexed("ws_target", "sqlite_b");
    assert.equal(found?.id, "sqlite_b");
    assert.equal(found?.agentId, "agent_beta");

    const crossWorkspace = findAgentRunForWorkspaceIndexed("ws_target", "sqlite_other");
    assert.equal(crossWorkspace, null);
  });
});
