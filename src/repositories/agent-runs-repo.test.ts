import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentRunsRepository,
  jsonAgentRunsRepository,
  sqliteAgentRunsRepository,
  type AgentRunsRepository,
  type AgentRunsRepositoryDeps,
} from "./agent-runs-repo.js";
import type { AgentRunRecord, PacketAgentData } from "../packetagent-store.js";

function makeRecord(overrides: Partial<AgentRunRecord> & { id: string }): AgentRunRecord {
  const record: AgentRunRecord = {
    id: overrides.id,
    workspaceId: overrides.workspaceId ?? "ws_default",
    title: overrides.title ?? "Default run",
    status: overrides.status ?? "running",
    logs: overrides.logs ?? [],
    createdAt: overrides.createdAt ?? "2026-04-26T10:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-26T10:00:00.000Z",
  };
  if (overrides.agentId !== undefined) record.agentId = overrides.agentId;
  if (overrides.workerDefinitionId !== undefined) {
    record.workerDefinitionId = overrides.workerDefinitionId;
  }
  if (overrides.workerVersionId !== undefined) {
    record.workerVersionId = overrides.workerVersionId;
  }
  if (overrides.workerDeploymentId !== undefined) {
    record.workerDeploymentId = overrides.workerDeploymentId;
  }
  if (overrides.workerRunId !== undefined) record.workerRunId = overrides.workerRunId;
  if (overrides.triggerKind !== undefined) record.triggerKind = overrides.triggerKind;
  if (overrides.transcript !== undefined) record.transcript = overrides.transcript;
  if (overrides.startedAt !== undefined) record.startedAt = overrides.startedAt;
  if (overrides.completedAt !== undefined) record.completedAt = overrides.completedAt;
  if (overrides.inputs !== undefined) record.inputs = overrides.inputs;
  if (overrides.output !== undefined) record.output = overrides.output;
  if (overrides.error !== undefined) record.error = overrides.error;
  if (overrides.toolCalls !== undefined) record.toolCalls = overrides.toolCalls;
  if (overrides.modelUsed !== undefined) record.modelUsed = overrides.modelUsed;
  if (overrides.costUsd !== undefined) record.costUsd = overrides.costUsd;
  if (overrides.evaluation !== undefined) record.evaluation = overrides.evaluation;
  return record;
}

function makeJsonRepo(): AgentRunsRepository {
  const data = { agentRuns: [] as AgentRunRecord[] } as unknown as PacketAgentData;
  const deps: AgentRunsRepositoryDeps = {
    loadStore: () => data,
    mutateStore: <T>(mutator: (target: PacketAgentData) => T) => mutator(data),
  };
  return jsonAgentRunsRepository(deps);
}

function withTempSqlite(testFn: (repo: AgentRunsRepository) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "packetagent-agent-runs-repo-"));
  const dbPath = join(dir, "packetagent.sqlite");
  const prevStore = process.env.PACKETAGENT_STORE;
  const prevDbPath = process.env.PACKETAGENT_DB_PATH;
  process.env.PACKETAGENT_STORE = "sqlite";
  process.env.PACKETAGENT_DB_PATH = dbPath;
  try {
    const repo = sqliteAgentRunsRepository({ dbPath });
    testFn(repo);
  } finally {
    if (prevStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = prevStore;
    if (prevDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = prevDbPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

function runOnBoth(scenario: (repo: AgentRunsRepository) => void): void {
  scenario(makeJsonRepo());
  withTempSqlite(scenario);
}

test("empty repository returns no rows", () => {
  runOnBoth((repo) => {
    assert.deepEqual(repo.list("ws_a"), []);
    assert.deepEqual(repo.listForAgent("ws_a", "agent_a"), []);
    assert.equal(repo.count(), 0);
    assert.equal(repo.find("ws_a", "run_missing"), null);
  });
});

test("upsert then list returns the record verbatim", () => {
  runOnBoth((repo) => {
    const record = makeRecord({
      id: "run_1",
      workspaceId: "ws_a",
      agentId: "agent_a",
      workerDefinitionId: "worker_definition_a",
      workerVersionId: "worker_version_a",
      workerDeploymentId: "worker_deployment_a",
      workerRunId: "worker_run_a",
      title: "Build report",
      status: "success",
      triggerKind: "manual",
      startedAt: "2026-04-26T10:00:01.000Z",
      completedAt: "2026-04-26T10:01:00.000Z",
      output: "ok",
      modelUsed: "claude-opus",
      costUsd: 0.42,
      createdAt: "2026-04-26T10:00:00.000Z",
      updatedAt: "2026-04-26T10:01:00.000Z",
    });
    repo.upsert(record);
    const rows = repo.list("ws_a");
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], record);
    assert.equal(repo.count(), 1);
  });
});

test("list returns rows sorted descending by createdAt", () => {
  runOnBoth((repo) => {
    repo.upsert(
      makeRecord({ id: "a", workspaceId: "ws_a", createdAt: "2026-04-26T12:00:00.000Z" }),
    );
    repo.upsert(
      makeRecord({ id: "b", workspaceId: "ws_a", createdAt: "2026-04-26T10:00:00.000Z" }),
    );
    repo.upsert(
      makeRecord({ id: "c", workspaceId: "ws_a", createdAt: "2026-04-26T11:00:00.000Z" }),
    );
    const ids = repo.list("ws_a").map((entry) => entry.id);
    assert.deepEqual(ids, ["a", "c", "b"]);
  });
});

test("list filters by workspace", () => {
  runOnBoth((repo) => {
    repo.upsert(
      makeRecord({ id: "a", workspaceId: "ws_a", createdAt: "2026-04-26T10:00:00.000Z" }),
    );
    repo.upsert(
      makeRecord({ id: "b", workspaceId: "ws_b", createdAt: "2026-04-26T11:00:00.000Z" }),
    );
    repo.upsert(
      makeRecord({ id: "c", workspaceId: "ws_a", createdAt: "2026-04-26T12:00:00.000Z" }),
    );
    const aIds = repo.list("ws_a").map((entry) => entry.id);
    assert.deepEqual(aIds, ["c", "a"]);
    const bIds = repo.list("ws_b").map((entry) => entry.id);
    assert.deepEqual(bIds, ["b"]);
  });
});

test("listForAgent filters by workspace and agent", () => {
  runOnBoth((repo) => {
    repo.upsert(
      makeRecord({
        id: "a",
        workspaceId: "ws_a",
        agentId: "agent_x",
        createdAt: "2026-04-26T10:00:00.000Z",
      }),
    );
    repo.upsert(
      makeRecord({
        id: "b",
        workspaceId: "ws_a",
        agentId: "agent_y",
        createdAt: "2026-04-26T11:00:00.000Z",
      }),
    );
    repo.upsert(
      makeRecord({
        id: "c",
        workspaceId: "ws_a",
        agentId: "agent_x",
        createdAt: "2026-04-26T12:00:00.000Z",
      }),
    );
    repo.upsert(
      makeRecord({
        id: "d",
        workspaceId: "ws_b",
        agentId: "agent_x",
        createdAt: "2026-04-26T13:00:00.000Z",
      }),
    );
    const ids = repo.listForAgent("ws_a", "agent_x").map((entry) => entry.id);
    assert.deepEqual(ids, ["c", "a"]);
  });
});

test("listForAgent excludes rows where agentId is undefined", () => {
  runOnBoth((repo) => {
    repo.upsert(
      makeRecord({
        id: "with",
        workspaceId: "ws_a",
        agentId: "agent_x",
        createdAt: "2026-04-26T10:00:00.000Z",
      }),
    );
    repo.upsert(
      makeRecord({ id: "without", workspaceId: "ws_a", createdAt: "2026-04-26T11:00:00.000Z" }),
    );
    const ids = repo.listForAgent("ws_a", "agent_x").map((entry) => entry.id);
    assert.deepEqual(ids, ["with"]);
  });
});

test("list applies default limit of 50 and caps at 200", () => {
  runOnBoth((repo) => {
    for (let index = 0; index < 210; index += 1) {
      const id = `run_${String(index).padStart(3, "0")}`;
      const seconds = String(index % 60).padStart(2, "0");
      const millis = String(index).padStart(3, "0");
      repo.upsert(
        makeRecord({
          id,
          workspaceId: "ws_a",
          createdAt: `2026-04-26T10:00:${seconds}.${millis}Z`,
        }),
      );
    }
    assert.equal(repo.list("ws_a").length, 50);
    assert.equal(repo.list("ws_a", 1).length, 1);
    assert.equal(repo.list("ws_a", 1000).length, 200);
  });
});

test("listForAgent applies default limit of 50 and caps at 200", () => {
  runOnBoth((repo) => {
    for (let index = 0; index < 210; index += 1) {
      const id = `run_${String(index).padStart(3, "0")}`;
      const seconds = String(index % 60).padStart(2, "0");
      const millis = String(index).padStart(3, "0");
      repo.upsert(
        makeRecord({
          id,
          workspaceId: "ws_a",
          agentId: "agent_x",
          createdAt: `2026-04-26T10:00:${seconds}.${millis}Z`,
        }),
      );
    }
    assert.equal(repo.listForAgent("ws_a", "agent_x").length, 50);
    assert.equal(repo.listForAgent("ws_a", "agent_x", 1).length, 1);
    assert.equal(repo.listForAgent("ws_a", "agent_x", 1000).length, 200);
  });
});

test("find returns the matching row", () => {
  runOnBoth((repo) => {
    repo.upsert(makeRecord({ id: "run_1", workspaceId: "ws_a", title: "first" }));
    repo.upsert(makeRecord({ id: "run_2", workspaceId: "ws_a", title: "second" }));
    const result = repo.find("ws_a", "run_2");
    assert.ok(result);
    assert.equal(result?.title, "second");
  });
});

test("find returns null when workspaceId does not match", () => {
  runOnBoth((repo) => {
    repo.upsert(makeRecord({ id: "run_1", workspaceId: "ws_a" }));
    assert.equal(repo.find("ws_b", "run_1"), null);
  });
});

test("find returns null when run id is unknown", () => {
  runOnBoth((repo) => {
    repo.upsert(makeRecord({ id: "run_1", workspaceId: "ws_a" }));
    assert.equal(repo.find("ws_a", "missing"), null);
  });
});

test("upsert replaces existing row by id", () => {
  runOnBoth((repo) => {
    repo.upsert(
      makeRecord({
        id: "run_1",
        workspaceId: "ws_a",
        title: "first",
        status: "running",
        updatedAt: "2026-04-26T10:00:00.000Z",
      }),
    );
    repo.upsert(
      makeRecord({
        id: "run_1",
        workspaceId: "ws_a",
        title: "second",
        status: "success",
        updatedAt: "2026-04-26T10:05:00.000Z",
      }),
    );
    assert.equal(repo.count(), 1);
    const row = repo.find("ws_a", "run_1");
    assert.equal(row?.title, "second");
    assert.equal(row?.status, "success");
    assert.equal(row?.updatedAt, "2026-04-26T10:05:00.000Z");
  });
});

test("sub-array round-trip preserves transcript, logs, and toolCalls", () => {
  runOnBoth((repo) => {
    const record = makeRecord({
      id: "run_complex",
      workspaceId: "ws_a",
      transcript: [
        {
          id: "step_1",
          title: "plan",
          status: "success",
          output: "ok",
          durationMs: 250,
          startedAt: "2026-04-26T10:00:00.000Z",
        },
      ],
      logs: [
        { at: "2026-04-26T10:00:00.000Z", level: "info", message: "started" },
        { at: "2026-04-26T10:00:01.000Z", level: "warn", message: "slow" },
      ],
      toolCalls: [
        {
          id: "call_1",
          toolName: "search",
          input: { query: "foo" },
          output: { hits: 3 },
          durationMs: 120,
          startedAt: "2026-04-26T10:00:00.000Z",
          completedAt: "2026-04-26T10:00:00.120Z",
          status: "ok",
        },
      ],
      evaluation: {
        schemaVersion: "packetagent.agent-first-run-evaluation/v1",
        kind: "first_run",
        status: "passed",
        expected: {
          inputs: { query: "foo" },
          output: "A useful result.",
          toolCalls: ["search"],
        },
        actual: {
          inputs: { query: "foo" },
          output: "ok",
          toolCalls: [{ name: "search", status: "ok" }],
          runStatus: "success",
          model: "model-test",
        },
        checks: [
          {
            id: "run_status",
            label: "Run completed",
            status: "passed",
            note: "The run completed.",
          },
        ],
        notes: ["All deterministic checks passed."],
        evaluatedAt: "2026-07-29T12:00:01.000Z",
      },
    });
    repo.upsert(record);
    const found = repo.find("ws_a", "run_complex");
    assert.deepEqual(found, record);
  });
});

test("sub-array fallback handles undefined transcript and toolCalls with empty logs", () => {
  runOnBoth((repo) => {
    const record = makeRecord({
      id: "run_min",
      workspaceId: "ws_a",
      logs: [],
    });
    repo.upsert(record);
    const found = repo.find("ws_a", "run_min");
    assert.ok(found);
    assert.deepEqual(found?.logs, []);
    assert.equal(found?.transcript, undefined);
    assert.equal(found?.toolCalls, undefined);
  });
});

test("inputs round-trip preserves mixed scalar values", () => {
  runOnBoth((repo) => {
    const record = makeRecord({
      id: "run_inputs",
      workspaceId: "ws_a",
      inputs: { foo: "bar", n: 42, ok: true },
    });
    repo.upsert(record);
    const found = repo.find("ws_a", "run_inputs");
    assert.deepEqual(found?.inputs, { foo: "bar", n: 42, ok: true });
  });
});

test("optional fields round-trip as undefined when omitted", () => {
  runOnBoth((repo) => {
    const record = makeRecord({
      id: "run_optional",
      workspaceId: "ws_a",
      logs: [],
    });
    repo.upsert(record);
    const found = repo.find("ws_a", "run_optional");
    assert.ok(found);
    assert.equal(found?.agentId, undefined);
    assert.equal(found?.triggerKind, undefined);
    assert.equal(found?.startedAt, undefined);
    assert.equal(found?.completedAt, undefined);
    assert.equal(found?.inputs, undefined);
    assert.equal(found?.output, undefined);
    assert.equal(found?.error, undefined);
    assert.equal(found?.modelUsed, undefined);
    assert.equal(found?.costUsd, undefined);
  });
});

test("createAgentRunsRepository returns json impl when env is unset", () => {
  const prevStore = process.env.PACKETAGENT_STORE;
  try {
    delete process.env.PACKETAGENT_STORE;
    const data = { agentRuns: [] as AgentRunRecord[] } as unknown as PacketAgentData;
    const repo = createAgentRunsRepository({
      loadStore: () => data,
      mutateStore: <T>(mutator: (target: PacketAgentData) => T) => mutator(data),
    });
    repo.upsert(makeRecord({ id: "run_1", workspaceId: "ws_a" }));
    assert.equal(repo.count(), 1);
    assert.equal(data.agentRuns.length, 1);
  } finally {
    if (prevStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = prevStore;
  }
});

test("createAgentRunsRepository returns sqlite impl when env requests it", () => {
  const dir = mkdtempSync(join(tmpdir(), "packetagent-agent-runs-factory-"));
  const dbPath = join(dir, "packetagent.sqlite");
  const prevStore = process.env.PACKETAGENT_STORE;
  const prevDbPath = process.env.PACKETAGENT_DB_PATH;
  process.env.PACKETAGENT_STORE = "sqlite";
  process.env.PACKETAGENT_DB_PATH = dbPath;
  try {
    const repo = createAgentRunsRepository({ dbPath });
    repo.upsert(makeRecord({ id: "run_1", workspaceId: "ws_a" }));
    assert.equal(repo.count(), 1);
    assert.equal(repo.list("ws_a")[0]?.id, "run_1");
  } finally {
    if (prevStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = prevStore;
    if (prevDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = prevDbPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
