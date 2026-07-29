import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listActivitiesForWorkspaceViaRepository } from "./activities-read.js";
import {
  createActivitiesRepository,
  type ActivitiesRepository,
  type ListActivitiesFilter,
} from "./repositories/activities-repo.js";
import { listActivitiesForWorkspaceIndexed } from "./packetagent-store.js";
import type { ActivityRecord, PacketAgentData } from "./packetagent-store.js";

function makeStore(records: ActivityRecord[] = []): PacketAgentData {
  return { activities: [...records] } as unknown as PacketAgentData;
}

function makeRecord(
  overrides: Partial<ActivityRecord> & { id: string; workspaceId: string; occurredAt: string },
): ActivityRecord {
  return {
    id: overrides.id,
    workspaceId: overrides.workspaceId,
    scope: overrides.scope ?? "workspace",
    event: overrides.event ?? "activity.test",
    occurredAt: overrides.occurredAt,
    actor: overrides.actor ?? { type: "system", id: "system" },
    data: overrides.data ?? {},
  };
}

function memoryActivitiesRepository(records: ActivityRecord[]): ActivitiesRepository {
  const collection = [...records];
  return {
    list(filter: ListActivitiesFilter) {
      const filtered = collection.filter((entry) => entry.workspaceId === filter.workspaceId);
      filtered.sort(compareActivities);
      return filter.limit && filter.limit > 0 ? filtered.slice(0, filter.limit) : filtered;
    },
    find(id) {
      return collection.find((entry) => entry.id === id) ?? null;
    },
    upsert(record) {
      const index = collection.findIndex((entry) => entry.id === record.id);
      if (index >= 0) collection[index] = record;
      else collection.push(record);
    },
    count() {
      return collection.length;
    },
  };
}

function unsortedActivitiesRepository(records: ActivityRecord[]): ActivitiesRepository {
  return {
    ...memoryActivitiesRepository(records),
    list() {
      return [...records];
    },
  };
}

function compareActivities(left: ActivityRecord, right: ActivityRecord): number {
  const cmp = right.occurredAt.localeCompare(left.occurredAt);
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
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-activities-read-parity-"));
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

test("listActivitiesForWorkspaceViaRepository returns workspace-scoped rows via repository", () => {
  withStoreMode(undefined, () => {
    const records = [
      makeRecord({
        id: "activity_old",
        workspaceId: "ws_target",
        occurredAt: "2026-04-26T01:00:00.000Z",
      }),
      makeRecord({
        id: "activity_other",
        workspaceId: "ws_other",
        occurredAt: "2026-04-26T04:00:00.000Z",
      }),
      makeRecord({
        id: "activity_new",
        workspaceId: "ws_target",
        occurredAt: "2026-04-26T03:00:00.000Z",
      }),
    ];
    const repository = memoryActivitiesRepository(records);

    const result = listActivitiesForWorkspaceViaRepository("ws_target", undefined, { repository });

    assert.deepEqual(
      result.map((entry) => entry.id),
      ["activity_new", "activity_old"],
    );
  });
});

test("listActivitiesForWorkspaceViaRepository sorts and applies activity limit semantics in SQLite mode", () => {
  withStoreMode("sqlite", () => {
    const records = [
      makeRecord({
        id: "activity_tie_a",
        workspaceId: "ws_target",
        occurredAt: "2026-04-26T02:00:00.000Z",
      }),
      makeRecord({
        id: "activity_old",
        workspaceId: "ws_target",
        occurredAt: "2026-04-26T01:00:00.000Z",
      }),
      makeRecord({
        id: "activity_late",
        workspaceId: "ws_target",
        occurredAt: "2026-04-26T03:00:00.000Z",
      }),
      makeRecord({
        id: "activity_tie_b",
        workspaceId: "ws_target",
        occurredAt: "2026-04-26T02:00:00.000Z",
      }),
      makeRecord({
        id: "activity_other",
        workspaceId: "ws_other",
        occurredAt: "2026-04-26T04:00:00.000Z",
      }),
    ];
    const repository = unsortedActivitiesRepository(records);
    const deps = { repository, loadStore: () => makeStore([]) };

    const limited = listActivitiesForWorkspaceViaRepository("ws_target", 3, deps);
    assert.deepEqual(
      limited.map((entry) => entry.id),
      ["activity_late", "activity_tie_b", "activity_tie_a"],
    );

    const zeroLimit = listActivitiesForWorkspaceViaRepository("ws_target", 0, deps);
    assert.deepEqual(
      zeroLimit.map((entry) => entry.id),
      ["activity_late", "activity_tie_b", "activity_tie_a", "activity_old"],
    );

    const negativeLimit = listActivitiesForWorkspaceViaRepository("ws_target", -1, deps);
    assert.deepEqual(
      negativeLimit.map((entry) => entry.id),
      zeroLimit.map((entry) => entry.id),
    );
  });
});

test("listActivitiesForWorkspaceIndexed reads from the SQLite activities repository with existing signature", () => {
  withTempSqlite((dbPath) => {
    const seedRecords = [
      makeRecord({
        id: "sqlite_a",
        workspaceId: "ws_sqlite",
        occurredAt: "2026-04-26T01:00:00.000Z",
      }),
      makeRecord({
        id: "sqlite_b",
        workspaceId: "ws_sqlite",
        occurredAt: "2026-04-26T02:00:00.000Z",
      }),
      makeRecord({
        id: "sqlite_c",
        workspaceId: "ws_sqlite",
        occurredAt: "2026-04-26T03:00:00.000Z",
      }),
      makeRecord({
        id: "sqlite_other",
        workspaceId: "ws_other",
        occurredAt: "2026-04-26T04:00:00.000Z",
      }),
    ];

    const seedingRepo = createActivitiesRepository({ dbPath });
    for (const record of seedRecords) {
      seedingRepo.upsert(record);
    }
    assert.equal(seedingRepo.count(), seedRecords.length);

    const limited = listActivitiesForWorkspaceIndexed("ws_sqlite", 2);
    assert.deepEqual(
      limited.map((entry) => entry.id),
      ["sqlite_c", "sqlite_b"],
    );

    const allRows = listActivitiesForWorkspaceIndexed("ws_sqlite");
    assert.deepEqual(
      allRows.map((entry) => entry.id),
      ["sqlite_c", "sqlite_b", "sqlite_a"],
    );
  });
});

test("listActivitiesForWorkspaceViaRepository merges and de-dupes JSON fallback rows in SQLite mode", () => {
  withTempSqlite(() => {
    const seedingRepo = createActivitiesRepository();
    const repoRecord = makeRecord({
      id: "sqlite_repo",
      workspaceId: "ws_merge",
      occurredAt: "2026-04-26T06:00:00.000Z",
    });
    const sharedRepoRecord = makeRecord({
      id: "shared_activity",
      workspaceId: "ws_merge",
      event: "activity.repo",
      occurredAt: "2026-04-26T01:00:00.000Z",
    });
    seedingRepo.upsert(repoRecord);
    seedingRepo.upsert(sharedRepoRecord);

    const fallbackData = makeStore([
      makeRecord({
        id: "json_only",
        workspaceId: "ws_merge",
        occurredAt: "2026-04-26T05:00:00.000Z",
      }),
      makeRecord({
        id: "shared_activity",
        workspaceId: "ws_merge",
        event: "activity.fallback",
        occurredAt: "2026-04-26T07:00:00.000Z",
      }),
      makeRecord({
        id: "json_other",
        workspaceId: "ws_other",
        occurredAt: "2026-04-26T08:00:00.000Z",
      }),
    ]);

    const merged = listActivitiesForWorkspaceViaRepository("ws_merge", undefined, {
      loadStore: () => fallbackData,
    });
    assert.deepEqual(
      merged.map((entry) => entry.id),
      ["sqlite_repo", "json_only", "shared_activity"],
    );
    assert.equal(merged.find((entry) => entry.id === "shared_activity")?.event, "activity.repo");

    const limited = listActivitiesForWorkspaceViaRepository("ws_merge", 2, {
      loadStore: () => fallbackData,
    });
    assert.deepEqual(
      limited.map((entry) => entry.id),
      ["sqlite_repo", "json_only"],
    );
  });
});
