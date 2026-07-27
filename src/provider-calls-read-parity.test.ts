import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listProviderCallsForWorkspaceViaRepository } from "./provider-calls-read.js";
import {
  createProviderCallsRepository,
  type ProviderCallsRepository,
} from "./repositories/provider-calls-repo.js";
import { listProviderCallsForWorkspaceIndexed } from "./packetagent-store.js";
import type { ProviderCallRecord, PacketAgentData } from "./packetagent-store.js";

type ProviderCallListFilter = {
  workspaceId: string;
  since?: string;
  limit?: number;
};

function makeStore(records: ProviderCallRecord[] = []): PacketAgentData {
  return { providerCalls: [...records] } as unknown as PacketAgentData;
}

function makeRecord(
  overrides: Partial<ProviderCallRecord> & { id: string; workspaceId: string; completedAt: string },
): ProviderCallRecord {
  return {
    id: overrides.id,
    workspaceId: overrides.workspaceId,
    routeKey: overrides.routeKey ?? "test.route",
    provider: overrides.provider ?? "stub",
    model: overrides.model ?? "stub",
    promptTokens: overrides.promptTokens ?? 1,
    completionTokens: overrides.completionTokens ?? 1,
    costUsd: overrides.costUsd ?? 0,
    durationMs: overrides.durationMs ?? 1,
    status: overrides.status ?? "success",
    errorMessage: overrides.errorMessage,
    startedAt: overrides.startedAt ?? overrides.completedAt,
    completedAt: overrides.completedAt,
  };
}

function memoryProviderCallsRepository(records: ProviderCallRecord[]): ProviderCallsRepository {
  const collection = [...records];
  return {
    list(filter: ProviderCallListFilter) {
      let filtered = collection.filter((entry) => entry.workspaceId === filter.workspaceId);
      if (filter.since) {
        const cutoff = Date.parse(filter.since);
        filtered = filtered.filter((entry) => Date.parse(entry.completedAt) >= cutoff);
      }
      filtered = filtered.slice().sort(compareProviderCalls);
      return filter.limit ? filtered.slice(0, filter.limit) : filtered;
    },
    find(id: string) {
      return collection.find((entry) => entry.id === id) ?? null;
    },
    upsert(record: ProviderCallRecord) {
      const index = collection.findIndex((entry) => entry.id === record.id);
      if (index >= 0) collection[index] = record;
      else collection.push(record);
    },
    count() {
      return collection.length;
    },
  } as unknown as ProviderCallsRepository;
}

function compareProviderCalls(left: ProviderCallRecord, right: ProviderCallRecord): number {
  const cmp = right.completedAt.localeCompare(left.completedAt);
  if (cmp !== 0) return cmp;
  return right.id.localeCompare(left.id);
}

function withStoreMode<T>(store: string | undefined, fn: () => T): T {
  const previousStore = process.env.PACKETAGENT_STORE;
  if (store === undefined) delete process.env.PACKETAGENT_STORE;
  else process.env.PACKETAGENT_STORE = store;
  try {
    return fn();
  } finally {
    if (previousStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = previousStore;
  }
}

function withTempSqlite<T>(fn: (dbPath: string) => T): T {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-provider-calls-read-parity-"));
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

function createRepository(dbPath: string): ProviderCallsRepository {
  return (createProviderCallsRepository as (deps?: { dbPath?: string }) => ProviderCallsRepository)({ dbPath });
}

function upsertProviderCall(repository: ProviderCallsRepository, record: ProviderCallRecord): void {
  const writable = repository as unknown as { upsert?: (entry: ProviderCallRecord) => void };
  const upsert = writable.upsert;
  if (typeof upsert !== "function") assert.fail("expected provider calls repository to expose upsert");
  upsert(record);
}

test("listProviderCallsForWorkspaceViaRepository delegates JSON-mode filters and limit to the repository", () => {
  withStoreMode(undefined, () => {
    const repository = memoryProviderCallsRepository([
      makeRecord({ id: "call_old", workspaceId: "ws_target", completedAt: "2026-04-26T01:00:00.000Z" }),
      makeRecord({ id: "call_tie_a", workspaceId: "ws_target", completedAt: "2026-04-26T02:00:00.000Z" }),
      makeRecord({ id: "call_new", workspaceId: "ws_target", completedAt: "2026-04-26T03:00:00.000Z" }),
      makeRecord({ id: "call_tie_b", workspaceId: "ws_target", completedAt: "2026-04-26T02:00:00.000Z" }),
      makeRecord({ id: "call_other", workspaceId: "ws_other", completedAt: "2026-04-26T04:00:00.000Z" }),
    ]);

    const result = listProviderCallsForWorkspaceViaRepository(
      "ws_target",
      { since: "2026-04-26T02:00:00.000Z", limit: 2 },
      { repository },
    );

    assert.deepEqual(result.map((entry) => entry.id), ["call_new", "call_tie_b"]);
  });
});

test("listProviderCallsForWorkspaceIndexed reads provider calls from the SQLite repository", () => {
  withTempSqlite((dbPath) => {
    const repository = createRepository(dbPath);
    const seedRecords = [
      makeRecord({ id: "sqlite_a", workspaceId: "ws_sqlite", completedAt: "2026-04-26T01:00:00.000Z" }),
      makeRecord({ id: "sqlite_b", workspaceId: "ws_sqlite", completedAt: "2026-04-26T02:00:00.000Z" }),
      makeRecord({ id: "sqlite_c", workspaceId: "ws_sqlite", completedAt: "2026-04-26T03:00:00.000Z" }),
      makeRecord({ id: "sqlite_other", workspaceId: "ws_other", completedAt: "2026-04-26T04:00:00.000Z" }),
    ];
    for (const record of seedRecords) upsertProviderCall(repository, record);

    const limited = listProviderCallsForWorkspaceIndexed("ws_sqlite", {
      since: "2026-04-26T02:00:00.000Z",
      limit: 2,
    });
    assert.deepEqual(limited.map((entry) => entry.id), ["sqlite_c", "sqlite_b"]);

    const allRows = listProviderCallsForWorkspaceIndexed("ws_sqlite");
    assert.deepEqual(allRows.map((entry) => entry.id), ["sqlite_c", "sqlite_b", "sqlite_a"]);
  });
});

test("listProviderCallsForWorkspaceViaRepository merges and de-dupes JSON fallback rows in SQLite mode", () => {
  withTempSqlite((dbPath) => {
    const repository = createRepository(dbPath);
    const repoRecords = [
      makeRecord({ id: "repo_new", workspaceId: "ws_merge", completedAt: "2026-04-26T06:00:00.000Z" }),
      makeRecord({
        id: "shared_call",
        workspaceId: "ws_merge",
        routeKey: "repo.route",
        completedAt: "2026-04-26T03:00:00.000Z",
      }),
      makeRecord({ id: "repo_tie_a", workspaceId: "ws_merge", completedAt: "2026-04-26T04:00:00.000Z" }),
      makeRecord({ id: "repo_tie_b", workspaceId: "ws_merge", completedAt: "2026-04-26T04:00:00.000Z" }),
    ];
    for (const record of repoRecords) upsertProviderCall(repository, record);

    const fallbackData = makeStore([
      makeRecord({ id: "json_only", workspaceId: "ws_merge", completedAt: "2026-04-26T05:00:00.000Z" }),
      makeRecord({
        id: "shared_call",
        workspaceId: "ws_merge",
        routeKey: "fallback.route",
        completedAt: "2026-04-26T07:00:00.000Z",
      }),
      makeRecord({ id: "json_old", workspaceId: "ws_merge", completedAt: "2026-04-26T01:00:00.000Z" }),
      makeRecord({ id: "json_other", workspaceId: "ws_other", completedAt: "2026-04-26T08:00:00.000Z" }),
    ]);

    const merged = listProviderCallsForWorkspaceViaRepository(
      "ws_merge",
      { since: "2026-04-26T02:00:00.000Z" },
      { loadStore: () => fallbackData },
    );
    assert.deepEqual(merged.map((entry) => entry.id), [
      "repo_new",
      "json_only",
      "repo_tie_b",
      "repo_tie_a",
      "shared_call",
    ]);
    assert.equal(merged.find((entry) => entry.id === "shared_call")?.routeKey, "repo.route");

    const limited = listProviderCallsForWorkspaceViaRepository(
      "ws_merge",
      { since: "2026-04-26T02:00:00.000Z", limit: 3 },
      { loadStore: () => fallbackData },
    );
    assert.deepEqual(limited.map((entry) => entry.id), ["repo_new", "json_only", "repo_tie_b"]);
  });
});
