import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  clearStoreCacheForTests,
  resetStoreForTests,
  loadStore,
  mutateStore,
  type ProviderCallRecord,
} from "../../packetagent-store.js";
import {
  listProviderCalls,
  listProviderCallsAsync,
  recordedCall,
  recordedStream,
  summarizeUsage,
  summarizeUsageAsync,
} from "../ledger.js";
import type { ProviderStreamChunk } from "../types.js";

test("recordedCall writes a success record with measured duration", async () => {
  resetStoreForTests();
  const result = await recordedCall(
    {
      recordId: "provider-call-explicit",
      workspaceId: "alpha",
      routeKey: "workflow.draft",
      provider: "stub",
      model: "stub-small",
    },
    async () => ({ usage: { promptTokens: 5, completionTokens: 8, costUsd: 0 } }),
  );
  assert.deepEqual(result.usage, { promptTokens: 5, completionTokens: 8, costUsd: 0 });
  const calls = listProviderCalls("alpha");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, "provider-call-explicit");
  assert.equal(calls[0].status, "success");
  assert.equal(calls[0].promptTokens, 5);
  assert.ok(calls[0].durationMs >= 0);
});

test("recordedCall writes an error record and re-throws", async () => {
  resetStoreForTests();
  await assert.rejects(
    () =>
      recordedCall(
        {
          workspaceId: "alpha",
          routeKey: "agent.summary",
          provider: "openai",
          model: "gpt-4o-mini",
        },
        async () => {
          throw new Error("boom");
        },
      ),
    /boom/,
  );
  const calls = listProviderCalls("alpha");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].status, "error");
  assert.equal(calls[0].errorMessage, "boom");
});

test("recordedStream records once with accumulated final usage", async () => {
  resetStoreForTests();
  async function* iter(): AsyncIterable<ProviderStreamChunk> {
    yield { delta: "hi" };
    yield { delta: " world" };
    yield { done: true, usage: { promptTokens: 3, completionTokens: 7, costUsd: 0.001 } };
  }
  const collected: ProviderStreamChunk[] = [];
  for await (const c of recordedStream(
    {
      workspaceId: "alpha",
      routeKey: "agent.reasoning",
      provider: "anthropic",
      model: "claude-opus-4-7",
    },
    iter(),
  )) {
    collected.push(c);
  }
  const calls = listProviderCalls("alpha");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].promptTokens, 3);
  assert.equal(calls[0].completionTokens, 7);
  assert.ok(calls[0].costUsd > 0);
  assert.equal(collected.length, 3);
});

test("recordedStream with chunk error marks status error", async () => {
  resetStoreForTests();
  async function* iter(): AsyncIterable<ProviderStreamChunk> {
    yield { delta: "x" };
    yield { error: "no key" };
  }
  for await (const _ of recordedStream(
    { workspaceId: "alpha", routeKey: "x", provider: "stub", model: "stub-small" },
    iter(),
  )) {
    /* drain */
  }
  const calls = listProviderCalls("alpha");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].status, "error");
  assert.equal(calls[0].errorMessage, "no key");
});

test("listProviderCalls returns newest-first and respects limit", async () => {
  resetStoreForTests();
  for (let i = 0; i < 5; i++) {
    await recordedCall(
      { workspaceId: "alpha", routeKey: `r${i}`, provider: "stub", model: "stub-small" },
      async () => ({ usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 } }),
    );
  }
  const last3 = listProviderCalls("alpha", { limit: 3 });
  assert.equal(last3.length, 3);
  assert.equal(last3[0].routeKey, "r4");
});

test("summarizeUsage aggregates across providers and routes", async () => {
  resetStoreForTests();
  await recordedCall(
    {
      workspaceId: "alpha",
      routeKey: "workflow.draft",
      provider: "anthropic",
      model: "claude-opus-4-7",
    },
    async () => ({ usage: { promptTokens: 10, completionTokens: 20, costUsd: 0.01 } }),
  );
  await recordedCall(
    {
      workspaceId: "alpha",
      routeKey: "workflow.draft",
      provider: "anthropic",
      model: "claude-opus-4-7",
    },
    async () => ({ usage: { promptTokens: 5, completionTokens: 5, costUsd: 0.005 } }),
  );
  await recordedCall(
    { workspaceId: "alpha", routeKey: "agent.summary", provider: "openai", model: "gpt-4o-mini" },
    async () => ({ usage: { promptTokens: 2, completionTokens: 3, costUsd: 0.001 } }),
  );
  const summary = summarizeUsage("alpha");
  assert.equal(summary.totalCalls, 3);
  assert.ok(Math.abs(summary.totalCostUsd - 0.016) < 1e-9);
  assert.equal(summary.byProvider.find((p) => p.provider === "anthropic")?.calls, 2);
  assert.equal(summary.byRoute.find((r) => r.routeKey === "workflow.draft")?.calls, 2);
  assert.equal(summary.last24h.calls, 3);
});

test("summarizeUsage excludes records older than 24h from last24h block", () => {
  resetStoreForTests();
  const data = loadStore();
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  data.providerCalls.push({
    id: "p1",
    workspaceId: "alpha",
    routeKey: "x",
    provider: "stub",
    model: "stub-small",
    promptTokens: 1,
    completionTokens: 1,
    costUsd: 0.5,
    durationMs: 1,
    status: "success",
    startedAt: old,
    completedAt: old,
  });
  const summary = summarizeUsage("alpha");
  assert.equal(summary.totalCalls, 1);
  assert.equal(summary.last24h.calls, 0);
  assert.equal(summary.last24h.costUsd, 0);
});

test("async provider usage readers mirror sync summaries", async () => {
  resetStoreForTests();
  await recordedCall(
    { workspaceId: "alpha", routeKey: "async.summary", provider: "stub", model: "stub-small" },
    async () => ({ usage: { promptTokens: 6, completionTokens: 4, costUsd: 0.003 } }),
  );

  const calls = await listProviderCallsAsync("alpha", { limit: 1 });
  const summary = await summarizeUsageAsync("alpha");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].routeKey, "async.summary");
  assert.equal(summary.totalCalls, 1);
  assert.equal(summary.totalPromptTokens, 6);
});

async function withSqliteLedgerStore(testFn: (dbPath: string) => Promise<void>): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-ledger-"));
  const dbPath = join(tempDir, "packetagent.sqlite");
  const previousStore = process.env.PACKETAGENT_STORE;
  const previousDbPath = process.env.PACKETAGENT_DB_PATH;
  try {
    process.env.PACKETAGENT_STORE = "sqlite";
    process.env.PACKETAGENT_DB_PATH = dbPath;
    clearStoreCacheForTests();
    resetStoreForTests();
    await testFn(dbPath);
  } finally {
    if (previousStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = previousStore;
    if (previousDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = previousDbPath;
    clearStoreCacheForTests();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function readProviderCallMirrors(dbPath: string): {
  appRecords: ProviderCallRecord[];
  dedicated: ProviderCallRecord[];
} {
  const db = new DatabaseSync(dbPath);
  try {
    const appRows = db
      .prepare(
        `
      select payload
      from app_records
      where collection = 'providerCalls'
      order by json_extract(payload, '$.completedAt'), id
    `,
      )
      .all() as Array<{ payload: string }>;
    const dedicatedRows = db
      .prepare(
        `
      select id, workspace_id, route_key, provider, model, prompt_tokens,
        completion_tokens, cost_usd, duration_ms, status, error_message,
        started_at, completed_at
      from provider_calls
      order by completed_at, id
    `,
      )
      .all() as Array<{
      id: string;
      workspace_id: string;
      route_key: string;
      provider: ProviderCallRecord["provider"];
      model: string;
      prompt_tokens: number;
      completion_tokens: number;
      cost_usd: number;
      duration_ms: number;
      status: ProviderCallRecord["status"];
      error_message: string | null;
      started_at: string;
      completed_at: string;
    }>;
    return {
      appRecords: appRows.map((row) => JSON.parse(row.payload) as ProviderCallRecord),
      dedicated: dedicatedRows.map((row) => {
        const record: ProviderCallRecord = {
          id: row.id,
          workspaceId: row.workspace_id,
          routeKey: row.route_key,
          provider: row.provider,
          model: row.model,
          promptTokens: row.prompt_tokens,
          completionTokens: row.completion_tokens,
          costUsd: row.cost_usd,
          durationMs: row.duration_ms,
          status: row.status,
          startedAt: row.started_at,
          completedAt: row.completed_at,
        };
        if (row.error_message !== null) record.errorMessage = row.error_message;
        return record;
      }),
    };
  } finally {
    db.close();
  }
}

function makeProviderCallRecord(id: string, index: number): ProviderCallRecord {
  const timestamp = new Date(Date.UTC(2026, 3, 26, 12, 0, 0) + index * 1000).toISOString();
  return {
    id,
    workspaceId: "alpha",
    routeKey: `cap.${index}`,
    provider: "stub",
    model: "stub-small",
    promptTokens: 1,
    completionTokens: 1,
    costUsd: 0,
    durationMs: 1,
    status: "success",
    startedAt: timestamp,
    completedAt: timestamp,
  };
}

function insertDedicatedProviderCalls(dbPath: string, records: ProviderCallRecord[]): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("begin");
    const stmt = db.prepare(`
      insert or replace into provider_calls (
        id, workspace_id, route_key, provider, model, prompt_tokens,
        completion_tokens, cost_usd, duration_ms, status, error_message,
        started_at, completed_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const record of records) {
      stmt.run(
        record.id,
        record.workspaceId,
        record.routeKey,
        record.provider,
        record.model,
        record.promptTokens,
        record.completionTokens,
        record.costUsd,
        record.durationMs,
        record.status,
        record.errorMessage ?? null,
        record.startedAt,
        record.completedAt,
      );
    }
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  } finally {
    db.close();
  }
}

test("recordedCall in sqlite mode writes provider calls to provider_calls only", async () => {
  await withSqliteLedgerStore(async (dbPath) => {
    await recordedCall(
      { workspaceId: "alpha", routeKey: "provider.cutover", provider: "stub", model: "stub-small" },
      async () => ({ usage: { promptTokens: 4, completionTokens: 6, costUsd: 0.002 } }),
    );

    const mirrors = readProviderCallMirrors(dbPath);
    assert.equal(mirrors.appRecords.length, 0);
    assert.equal(mirrors.dedicated.length, 1);
    assert.equal(mirrors.dedicated[0].routeKey, "provider.cutover");
  });
});

test("recordedCall in sqlite mode prunes provider call cap in the dedicated table", async () => {
  await withSqliteLedgerStore(async (dbPath) => {
    const records = Array.from({ length: 5_000 }, (_, index) =>
      makeProviderCallRecord(`provider_call_${index}`, index),
    );
    mutateStore((data) => {
      data.providerCalls = records;
      return null;
    });
    insertDedicatedProviderCalls(dbPath, records);

    await recordedCall(
      { workspaceId: "alpha", routeKey: "provider.cap", provider: "stub", model: "stub-small" },
      async () => ({ usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 } }),
    );

    const mirrors = readProviderCallMirrors(dbPath);
    const appIds = new Set(mirrors.appRecords.map((entry) => entry.id));
    const dedicatedIds = new Set(mirrors.dedicated.map((entry) => entry.id));
    assert.equal(mirrors.appRecords.length, 0);
    assert.equal(mirrors.dedicated.length, 5_000);
    assert.equal(appIds.has("provider_call_0"), false);
    assert.equal(dedicatedIds.has("provider_call_0"), false);
    assert.equal(
      mirrors.dedicated.some((entry) => entry.routeKey === "provider.cap"),
      true,
    );
  });
});
