import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "./db/cli.js";
import { upsertAgentRun, type AgentRunRecord, type PacketAgentData } from "./packetagent-store.js";

interface AgentRunRow {
  id: string;
  workspace_id: string;
  agent_id: string | null;
  title: string;
  status: string;
  trigger_kind: string | null;
  started_at: string | null;
  completed_at: string | null;
  inputs: string | null;
  output: string | null;
  error: string | null;
  logs: string;
  tool_calls: string | null;
  transcript: string | null;
  model_used: string | null;
  cost_usd: number | null;
  created_at: string;
  updated_at: string;
}

function makeStore(records: AgentRunRecord[] = []): PacketAgentData {
  return { agentRuns: [...records] } as unknown as PacketAgentData;
}

function readDedicated(dbPath: string): AgentRunRow[] {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare(
        `
      select id, workspace_id, agent_id, title, status, trigger_kind,
        started_at, completed_at, inputs, output, error,
        logs, tool_calls, transcript, model_used, cost_usd,
        created_at, updated_at
      from agent_runs
      order by created_at, id
    `,
      )
      .all() as unknown as AgentRunRow[];
  } finally {
    db.close();
  }
}

function withSqliteEnv(dbPath: string) {
  const previousStore = process.env.PACKETAGENT_STORE;
  const previousDbPath = process.env.PACKETAGENT_DB_PATH;
  process.env.PACKETAGENT_STORE = "sqlite";
  process.env.PACKETAGENT_DB_PATH = dbPath;
  return () => {
    if (previousStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = previousStore;
    if (previousDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = previousDbPath;
  };
}

test("upsertAgentRun dual-writes JSON-side and dedicated agent_runs table in SQLite mode", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-agent-runs-dual-"));
  const dbPath = join(tempDir, "packetagent.sqlite");
  migrateDatabase({ dbPath });
  const restore = withSqliteEnv(dbPath);
  try {
    const data = makeStore();
    const run = upsertAgentRun(
      data,
      {
        id: "run_a",
        workspaceId: "workspace_a",
        agentId: "agent_a",
        title: "First run",
        status: "success",
        triggerKind: "manual",
        logs: [],
        startedAt: "2026-04-26T12:00:00.000Z",
        completedAt: "2026-04-26T12:01:00.000Z",
      },
      "2026-04-26T12:00:00.000Z",
    );

    assert.equal(run.id, "run_a");
    assert.equal(data.agentRuns.length, 1);
    const dedicated = readDedicated(dbPath);
    assert.equal(dedicated.length, 1);
    assert.equal(dedicated[0].id, "run_a");
    assert.equal(dedicated[0].workspace_id, "workspace_a");
    assert.equal(dedicated[0].agent_id, "agent_a");
    assert.equal(dedicated[0].status, "success");
    assert.equal(dedicated[0].trigger_kind, "manual");
  } finally {
    restore();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("upsertAgentRun replaces both sides consistently when called twice with the same id", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-agent-runs-dual-"));
  const dbPath = join(tempDir, "packetagent.sqlite");
  migrateDatabase({ dbPath });
  const restore = withSqliteEnv(dbPath);
  try {
    const data = makeStore();
    upsertAgentRun(
      data,
      {
        id: "run_a",
        workspaceId: "workspace_a",
        title: "Initial",
        status: "running",
        logs: [],
      },
      "2026-04-26T12:00:00.000Z",
    );
    upsertAgentRun(
      data,
      {
        id: "run_a",
        workspaceId: "workspace_a",
        title: "Updated",
        status: "success",
        logs: [],
      },
      "2026-04-26T12:05:00.000Z",
    );

    assert.equal(data.agentRuns.length, 1);
    assert.equal(data.agentRuns[0].title, "Updated");
    assert.equal(data.agentRuns[0].status, "success");
    const dedicated = readDedicated(dbPath);
    assert.equal(dedicated.length, 1);
    assert.equal(dedicated[0].title, "Updated");
    assert.equal(dedicated[0].status, "success");
  } finally {
    restore();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("upsertAgentRun round-trips transcript, logs, and toolCalls through both sides", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-agent-runs-dual-"));
  const dbPath = join(tempDir, "packetagent.sqlite");
  migrateDatabase({ dbPath });
  const restore = withSqliteEnv(dbPath);
  try {
    const data = makeStore();
    const transcript = [
      {
        id: "step_1",
        title: "Step 1",
        status: "success" as const,
        output: "ok",
        durationMs: 100,
        startedAt: "2026-04-26T12:00:00.000Z",
      },
      {
        id: "step_2",
        title: "Step 2",
        status: "success" as const,
        output: "done",
        durationMs: 50,
        startedAt: "2026-04-26T12:00:00.500Z",
      },
    ];
    const logs = [
      { at: "2026-04-26T12:00:00.000Z", level: "info" as const, message: "started" },
      { at: "2026-04-26T12:00:30.000Z", level: "info" as const, message: "tool used" },
    ];
    const toolCalls = [
      {
        id: "tc_1",
        toolName: "search",
        input: { query: "x" },
        durationMs: 12,
        startedAt: "2026-04-26T12:00:10.000Z",
        completedAt: "2026-04-26T12:00:10.012Z",
        status: "ok" as const,
      },
    ];

    upsertAgentRun(
      data,
      {
        id: "run_a",
        workspaceId: "workspace_a",
        title: "With sub-arrays",
        status: "success",
        transcript,
        logs,
        toolCalls,
      },
      "2026-04-26T12:00:00.000Z",
    );

    assert.deepEqual(data.agentRuns[0].transcript, transcript);
    assert.deepEqual(data.agentRuns[0].logs, logs);
    assert.deepEqual(data.agentRuns[0].toolCalls, toolCalls);

    const dedicated = readDedicated(dbPath);
    assert.equal(dedicated.length, 1);
    assert.deepEqual(JSON.parse(dedicated[0].transcript ?? "null"), transcript);
    assert.deepEqual(JSON.parse(dedicated[0].logs), logs);
    assert.deepEqual(JSON.parse(dedicated[0].tool_calls ?? "null"), toolCalls);
  } finally {
    restore();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("upsertAgentRun is a no-op for the dedicated agent_runs table in JSON-default mode", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-agent-runs-dual-"));
  const dbPath = join(tempDir, "packetagent.sqlite");
  migrateDatabase({ dbPath });
  const previousStore = process.env.PACKETAGENT_STORE;
  delete process.env.PACKETAGENT_STORE;
  try {
    const data = makeStore();
    upsertAgentRun(
      data,
      {
        id: "run_a",
        workspaceId: "workspace_a",
        title: "JSON-only",
        status: "success",
        logs: [],
      },
      "2026-04-26T12:00:00.000Z",
    );

    assert.equal(data.agentRuns.length, 1);
    const dedicated = readDedicated(dbPath);
    assert.equal(dedicated.length, 0);
  } finally {
    if (previousStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = previousStore;
    rmSync(tempDir, { recursive: true, force: true });
  }
});
