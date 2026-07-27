import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProviderCallsRepository,
  jsonProviderCallsRepository,
  sqliteProviderCallsRepository,
  type ProviderCallsRepository,
  type ProviderCallsRepositoryDeps,
} from "./provider-calls-repo.js";
import type { ProviderCallRecord, PacketAgentData } from "../packetagent-store.js";

function makeRecord(overrides: Partial<ProviderCallRecord> & { id: string }): ProviderCallRecord {
  const record: ProviderCallRecord = {
    id: overrides.id,
    workspaceId: overrides.workspaceId ?? "ws_default",
    routeKey: overrides.routeKey ?? "route.default",
    provider: overrides.provider ?? "stub",
    model: overrides.model ?? "stub-small",
    promptTokens: overrides.promptTokens ?? 0,
    completionTokens: overrides.completionTokens ?? 0,
    costUsd: overrides.costUsd ?? 0,
    durationMs: overrides.durationMs ?? 0,
    status: overrides.status ?? "success",
    startedAt: overrides.startedAt ?? "2026-04-26T10:00:00.000Z",
    completedAt: overrides.completedAt ?? "2026-04-26T10:00:01.000Z",
  };
  if (overrides.errorMessage !== undefined) record.errorMessage = overrides.errorMessage;
  return record;
}

function makeJsonRepo(): ProviderCallsRepository {
  const data = { providerCalls: [] as ProviderCallRecord[] } as unknown as PacketAgentData;
  const deps: ProviderCallsRepositoryDeps = {
    loadStore: () => data,
    mutateStore: <T,>(mutator: (target: PacketAgentData) => T) => mutator(data),
  };
  return jsonProviderCallsRepository(deps);
}

function withTempSqlite(testFn: (repo: ProviderCallsRepository) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "packetagent-provider-calls-repo-"));
  const dbPath = join(dir, "packetagent.sqlite");
  const prevStore = process.env.PACKETAGENT_STORE;
  const prevDbPath = process.env.PACKETAGENT_DB_PATH;
  process.env.PACKETAGENT_STORE = "sqlite";
  process.env.PACKETAGENT_DB_PATH = dbPath;
  try {
    const repo = sqliteProviderCallsRepository({ dbPath });
    testFn(repo);
  } finally {
    if (prevStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = prevStore;
    if (prevDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = prevDbPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

function runOnBoth(scenario: (repo: ProviderCallsRepository) => void): void {
  scenario(makeJsonRepo());
  withTempSqlite(scenario);
}

test("empty repository returns no rows for a workspace", () => {
  runOnBoth((repo) => {
    assert.deepEqual(repo.list({ workspaceId: "ws_a" }), []);
    assert.equal(repo.count(), 0);
  });
});

test("upsert then list returns the record verbatim", () => {
  runOnBoth((repo) => {
    const record = makeRecord({
      id: "call_1",
      workspaceId: "ws_a",
      routeKey: "agent.generate",
      provider: "openai",
      model: "gpt-4.1",
      promptTokens: 123,
      completionTokens: 45,
      costUsd: 0.0312,
      durationMs: 678,
      status: "success",
      startedAt: "2026-04-26T10:00:00.000Z",
      completedAt: "2026-04-26T10:00:01.000Z",
    });
    repo.upsert(record);
    const rows = repo.list({ workspaceId: "ws_a" });
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], record);
    assert.equal(repo.count(), 1);
  });
});

test("insertMany inserts and upserts by id", () => {
  runOnBoth((repo) => {
    const original = makeRecord({
      id: "dup",
      workspaceId: "ws_a",
      model: "first",
      completedAt: "2026-04-26T10:00:00.000Z",
    });
    const replacement = makeRecord({
      id: "dup",
      workspaceId: "ws_a",
      model: "second",
      promptTokens: 10,
      completedAt: "2026-04-26T11:00:00.000Z",
    });
    const other = makeRecord({
      id: "other",
      workspaceId: "ws_a",
      completedAt: "2026-04-26T12:00:00.000Z",
    });

    repo.insertMany([original, other]);
    repo.insertMany([replacement]);

    assert.equal(repo.count(), 2);
    const rows = repo.list({ workspaceId: "ws_a" });
    assert.deepEqual(rows.map((entry) => entry.id), ["other", "dup"]);
    assert.equal(rows.find((entry) => entry.id === "dup")?.model, "second");
    assert.equal(rows.find((entry) => entry.id === "dup")?.promptTokens, 10);
  });
});

test("list filters by workspaceId", () => {
  runOnBoth((repo) => {
    repo.upsert(makeRecord({ id: "a", workspaceId: "ws_a", completedAt: "2026-04-26T10:00:00.000Z" }));
    repo.upsert(makeRecord({ id: "b", workspaceId: "ws_b", completedAt: "2026-04-26T11:00:00.000Z" }));
    repo.upsert(makeRecord({ id: "c", workspaceId: "ws_a", completedAt: "2026-04-26T12:00:00.000Z" }));

    assert.deepEqual(repo.list({ workspaceId: "ws_a" }).map((entry) => entry.id), ["c", "a"]);
    assert.deepEqual(repo.list({ workspaceId: "ws_b" }).map((entry) => entry.id), ["b"]);
  });
});

test("list filters by since inclusively using completedAt", () => {
  runOnBoth((repo) => {
    repo.insertMany([
      makeRecord({ id: "a", workspaceId: "ws_a", completedAt: "2026-04-26T10:00:00.000Z" }),
      makeRecord({ id: "b", workspaceId: "ws_a", completedAt: "2026-04-26T12:00:00.000Z" }),
      makeRecord({ id: "c", workspaceId: "ws_a", completedAt: "2026-04-26T14:00:00.000Z" }),
    ]);

    const rows = repo.list({ workspaceId: "ws_a", since: "2026-04-26T12:00:00.000Z" });
    assert.deepEqual(rows.map((entry) => entry.id), ["c", "b"]);
  });
});

test("list applies only positive limits after filtering", () => {
  runOnBoth((repo) => {
    for (let index = 0; index < 5; index += 1) {
      repo.upsert(
        makeRecord({
          id: `call_${index}`,
          workspaceId: "ws_a",
          completedAt: `2026-04-26T10:00:0${index}.000Z`,
        }),
      );
    }

    assert.deepEqual(
      repo.list({ workspaceId: "ws_a", since: "2026-04-26T10:00:02.000Z", limit: 2 }).map((entry) => entry.id),
      ["call_4", "call_3"],
    );
    assert.equal(repo.list({ workspaceId: "ws_a", limit: 0 }).length, 5);
    assert.equal(repo.list({ workspaceId: "ws_a", limit: -1 }).length, 5);
  });
});

test("list with since and limit returns correct bounded results", () => {
  runOnBoth((repo) => {
    repo.insertMany([
      makeRecord({ id: "t08", workspaceId: "ws_a", completedAt: "2026-04-26T08:00:00.000Z" }),
      makeRecord({ id: "t10", workspaceId: "ws_a", completedAt: "2026-04-26T10:00:00.000Z" }),
      makeRecord({ id: "t12", workspaceId: "ws_a", completedAt: "2026-04-26T12:00:00.000Z" }),
      makeRecord({ id: "t14", workspaceId: "ws_a", completedAt: "2026-04-26T14:00:00.000Z" }),
      // Different workspace must never leak into the result.
      makeRecord({ id: "other", workspaceId: "ws_b", completedAt: "2026-04-26T13:00:00.000Z" }),
    ]);

    // since is inclusive on completedAt and the LIMIT bounds the newest rows.
    assert.deepEqual(
      repo.list({ workspaceId: "ws_a", since: "2026-04-26T10:00:00.000Z" }).map((entry) => entry.id),
      ["t14", "t12", "t10"],
    );
    assert.deepEqual(
      repo
        .list({ workspaceId: "ws_a", since: "2026-04-26T10:00:00.000Z", limit: 2 })
        .map((entry) => entry.id),
      ["t14", "t12"],
    );
    // since that excludes everything returns an empty result.
    assert.deepEqual(
      repo.list({ workspaceId: "ws_a", since: "2026-04-26T15:00:00.000Z" }),
      [],
    );
  });
});

test("list sorts by completedAt descending then id descending", () => {
  runOnBoth((repo) => {
    repo.insertMany([
      makeRecord({ id: "a", workspaceId: "ws_a", completedAt: "2026-04-26T12:00:00.000Z" }),
      makeRecord({ id: "c", workspaceId: "ws_a", completedAt: "2026-04-26T12:00:00.000Z" }),
      makeRecord({ id: "b", workspaceId: "ws_a", completedAt: "2026-04-26T10:00:00.000Z" }),
      makeRecord({ id: "d", workspaceId: "ws_a", completedAt: "2026-04-26T11:00:00.000Z" }),
    ]);

    assert.deepEqual(repo.list({ workspaceId: "ws_a" }).map((entry) => entry.id), ["c", "a", "d", "b"]);
  });
});

test("optional errorMessage round-trips as undefined or populated", () => {
  runOnBoth((repo) => {
    const success = makeRecord({
      id: "success",
      workspaceId: "ws_a",
      status: "success",
      completedAt: "2026-04-26T10:00:00.000Z",
    });
    const error = makeRecord({
      id: "error",
      workspaceId: "ws_a",
      status: "error",
      errorMessage: "provider unavailable",
      completedAt: "2026-04-26T11:00:00.000Z",
    });

    repo.insertMany([success, error]);

    const rows = repo.list({ workspaceId: "ws_a" });
    assert.equal(rows.find((entry) => entry.id === "success")?.errorMessage, undefined);
    assert.ok(!("errorMessage" in (rows.find((entry) => entry.id === "success") ?? {})));
    assert.equal(rows.find((entry) => entry.id === "error")?.errorMessage, "provider unavailable");
  });
});

test("numeric fields round-trip through JSON and SQLite", () => {
  runOnBoth((repo) => {
    const record = makeRecord({
      id: "numbers",
      workspaceId: "ws_a",
      promptTokens: 1234,
      completionTokens: 567,
      costUsd: 1.2345,
      durationMs: 890,
    });

    repo.upsert(record);
    const found = repo.list({ workspaceId: "ws_a" })[0];
    assert.equal(found?.promptTokens, 1234);
    assert.equal(found?.completionTokens, 567);
    assert.equal(found?.costUsd, 1.2345);
    assert.equal(found?.durationMs, 890);
  });
});

test("pruneRetainLatest preserves newest rows overall and returns removed count", () => {
  runOnBoth((repo) => {
    repo.insertMany([
      makeRecord({ id: "old", workspaceId: "ws_a", completedAt: "2026-04-26T09:00:00.000Z" }),
      makeRecord({ id: "middle", workspaceId: "ws_b", completedAt: "2026-04-26T10:00:00.000Z" }),
      makeRecord({ id: "tie_a", workspaceId: "ws_a", completedAt: "2026-04-26T11:00:00.000Z" }),
      makeRecord({ id: "tie_z", workspaceId: "ws_a", completedAt: "2026-04-26T11:00:00.000Z" }),
      makeRecord({ id: "latest", workspaceId: "ws_a", completedAt: "2026-04-26T12:00:00.000Z" }),
    ]);

    const removed = repo.pruneRetainLatest(3);
    assert.equal(removed, 2);
    assert.equal(repo.count(), 3);
    assert.deepEqual(repo.list({ workspaceId: "ws_a" }).map((entry) => entry.id), ["latest", "tie_z", "tie_a"]);
    assert.deepEqual(repo.list({ workspaceId: "ws_b" }), []);
  });
});

test("createProviderCallsRepository selects JSON implementation by default", () => {
  const prevStore = process.env.PACKETAGENT_STORE;
  try {
    delete process.env.PACKETAGENT_STORE;
    const data = { providerCalls: [] as ProviderCallRecord[] } as unknown as PacketAgentData;
    const repo = createProviderCallsRepository({
      loadStore: () => data,
      mutateStore: <T,>(mutator: (target: PacketAgentData) => T) => mutator(data),
    });
    repo.upsert(makeRecord({ id: "call_1", workspaceId: "ws_a" }));
    assert.equal(repo.count(), 1);
    assert.equal(data.providerCalls.length, 1);
  } finally {
    if (prevStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = prevStore;
  }
});

test("createProviderCallsRepository returns SQLite implementation when env requests it", () => {
  const dir = mkdtempSync(join(tmpdir(), "packetagent-provider-calls-repo-factory-"));
  const dbPath = join(dir, "packetagent.sqlite");
  const prevStore = process.env.PACKETAGENT_STORE;
  const prevDbPath = process.env.PACKETAGENT_DB_PATH;
  process.env.PACKETAGENT_STORE = "sqlite";
  process.env.PACKETAGENT_DB_PATH = dbPath;
  try {
    const repo = createProviderCallsRepository({ dbPath });
    repo.upsert(makeRecord({ id: "call_1", workspaceId: "ws_a" }));
    assert.equal(repo.count(), 1);
    assert.equal(repo.list({ workspaceId: "ws_a" })[0]?.id, "call_1");
  } finally {
    if (prevStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = prevStore;
    if (prevDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = prevDbPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
