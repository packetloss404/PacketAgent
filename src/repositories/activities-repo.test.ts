import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  asyncActivitiesRepositoryFromSync,
  createActivitiesRepository,
  createAsyncActivitiesRepository,
  jsonActivitiesRepository,
  sqliteActivitiesRepository,
  type ActivitiesRepository,
  type ActivitiesRepositoryDeps,
} from "./activities-repo.js";
import type { ActivityRecord, PacketAgentData } from "../packetagent-store.js";

function makeRecord(overrides: Partial<ActivityRecord> & { id: string }): ActivityRecord {
  return {
    id: overrides.id,
    workspaceId: overrides.workspaceId ?? "ws_default",
    scope: overrides.scope ?? "workspace",
    event: overrides.event ?? "activity.default",
    occurredAt: overrides.occurredAt ?? "2026-04-26T10:00:00.000Z",
    actor: overrides.actor ?? { type: "system", id: "system" },
    data: overrides.data ?? {},
  };
}

function makeJsonRepo(): ActivitiesRepository {
  const data = { activities: [] as ActivityRecord[] } as unknown as PacketAgentData;
  const deps: ActivitiesRepositoryDeps = {
    loadStore: () => data,
    mutateStore: <T,>(mutator: (target: PacketAgentData) => T) => mutator(data),
  };
  return jsonActivitiesRepository(deps);
}

function withTempSqlite(testFn: (repo: ActivitiesRepository, dbPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "packetagent-activities-repo-"));
  const dbPath = join(dir, "packetagent.sqlite");
  const prevStore = process.env.PACKETAGENT_STORE;
  const prevDbPath = process.env.PACKETAGENT_DB_PATH;
  process.env.PACKETAGENT_STORE = "sqlite";
  process.env.PACKETAGENT_DB_PATH = dbPath;
  try {
    const repo = sqliteActivitiesRepository({ dbPath });
    testFn(repo, dbPath);
  } finally {
    if (prevStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = prevStore;
    if (prevDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = prevDbPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

function runOnBoth(scenario: (repo: ActivitiesRepository) => void): void {
  scenario(makeJsonRepo());
  withTempSqlite((repo) => scenario(repo));
}

test("empty repository returns no rows for a workspace", () => {
  runOnBoth((repo) => {
    assert.deepEqual(repo.list({ workspaceId: "ws_a" }), []);
    assert.equal(repo.count(), 0);
    assert.equal(repo.find("missing"), null);
  });
});

test("upsert then list and find return the record verbatim", () => {
  runOnBoth((repo) => {
    const record = makeRecord({
      id: "act_1",
      workspaceId: "ws_a",
      scope: "activation",
      event: "agent.run.retry",
      occurredAt: "2026-04-26T10:00:00.000Z",
      actor: { type: "user", id: "user_1", displayName: "Alice" },
      data: { title: "Retry run", attempt: 2, urgent: true, note: null },
    });
    repo.upsert(record);
    const rows = repo.list({ workspaceId: "ws_a" });
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], record);
    assert.deepEqual(repo.find("act_1"), record);
    assert.equal(repo.count(), 1);
  });
});

test("list filters by workspaceId", () => {
  runOnBoth((repo) => {
    repo.upsert(makeRecord({ id: "a", workspaceId: "ws_a", occurredAt: "2026-04-26T10:00:00.000Z" }));
    repo.upsert(makeRecord({ id: "b", workspaceId: "ws_b", occurredAt: "2026-04-26T11:00:00.000Z" }));
    repo.upsert(makeRecord({ id: "c", workspaceId: "ws_a", occurredAt: "2026-04-26T12:00:00.000Z" }));
    assert.deepEqual(repo.list({ workspaceId: "ws_a" }).map((entry) => entry.id), ["c", "a"]);
    assert.deepEqual(repo.list({ workspaceId: "ws_b" }).map((entry) => entry.id), ["b"]);
  });
});

test("list sorts by occurredAt descending then id descending", () => {
  runOnBoth((repo) => {
    repo.upsert(makeRecord({ id: "a", workspaceId: "ws_a", occurredAt: "2026-04-26T12:00:00.000Z" }));
    repo.upsert(makeRecord({ id: "c", workspaceId: "ws_a", occurredAt: "2026-04-26T12:00:00.000Z" }));
    repo.upsert(makeRecord({ id: "b", workspaceId: "ws_a", occurredAt: "2026-04-26T10:00:00.000Z" }));
    repo.upsert(makeRecord({ id: "d", workspaceId: "ws_a", occurredAt: "2026-04-26T11:00:00.000Z" }));
    const ids = repo.list({ workspaceId: "ws_a" }).map((entry) => entry.id);
    assert.deepEqual(ids, ["c", "a", "d", "b"]);
  });
});

test("list applies only positive limits", () => {
  runOnBoth((repo) => {
    for (let index = 0; index < 5; index += 1) {
      repo.upsert(
        makeRecord({
          id: `act_${index}`,
          workspaceId: "ws_a",
          occurredAt: `2026-04-26T10:00:0${index}.000Z`,
        }),
      );
    }
    assert.equal(repo.list({ workspaceId: "ws_a", limit: 2 }).length, 2);
    assert.equal(repo.list({ workspaceId: "ws_a", limit: 0 }).length, 5);
    assert.equal(repo.list({ workspaceId: "ws_a", limit: -1 }).length, 5);
  });
});

test("list without a limit returns all matching rows", () => {
  runOnBoth((repo) => {
    for (let index = 0; index < 75; index += 1) {
      repo.upsert(
        makeRecord({
          id: `act_${String(index).padStart(2, "0")}`,
          workspaceId: "ws_a",
          occurredAt: `2026-04-26T10:${String(index).padStart(2, "0")}:00.000Z`,
        }),
      );
    }
    assert.equal(repo.list({ workspaceId: "ws_a" }).length, 75);
  });
});

test("upsert replaces an existing record by id", () => {
  runOnBoth((repo) => {
    repo.upsert(
      makeRecord({
        id: "dup",
        workspaceId: "ws_a",
        event: "activity.first",
        occurredAt: "2026-04-26T10:00:00.000Z",
      }),
    );
    const replacement = makeRecord({
      id: "dup",
      workspaceId: "ws_b",
      event: "activity.second",
      occurredAt: "2026-04-26T11:00:00.000Z",
      actor: { type: "user", id: "user_2" },
      data: { changed: true },
    });
    repo.upsert(replacement);
    assert.equal(repo.count(), 1);
    assert.deepEqual(repo.find("dup"), replacement);
    assert.deepEqual(repo.list({ workspaceId: "ws_a" }), []);
    assert.deepEqual(repo.list({ workspaceId: "ws_b" }), [replacement]);
  });
});

test("asyncActivitiesRepositoryFromSync delegates to an existing sync repository", async () => {
  const syncRepo = makeJsonRepo();
  const asyncRepo = asyncActivitiesRepositoryFromSync(syncRepo);
  const record = makeRecord({
    id: "async_delegate",
    workspaceId: "ws_a",
    occurredAt: "2026-04-26T10:00:00.000Z",
  });

  await asyncRepo.upsert(record);

  assert.deepEqual(await asyncRepo.find(record.id), syncRepo.find(record.id));
  assert.deepEqual(await asyncRepo.list({ workspaceId: "ws_a" }), syncRepo.list({ workspaceId: "ws_a" }));
  assert.equal(await asyncRepo.count(), 1);
});

test("createAsyncActivitiesRepository accepts awaitable store dependencies", async () => {
  const prevStore = process.env.PACKETAGENT_STORE;
  try {
    delete process.env.PACKETAGENT_STORE;
    const data = { activities: [] as ActivityRecord[] } as unknown as PacketAgentData;
    let loads = 0;
    let mutations = 0;
    const repo = createAsyncActivitiesRepository({
      loadStore: async () => {
        loads += 1;
        return data;
      },
      mutateStore: async <T,>(mutator: (target: PacketAgentData) => T | Promise<T>) => {
        mutations += 1;
        return mutator(data);
      },
    });

    await repo.upsert(makeRecord({ id: "async_store", workspaceId: "ws_a" }));

    assert.equal(mutations, 1);
    assert.equal(await repo.count(), 1);
    assert.equal((await repo.list({ workspaceId: "ws_a" }))[0]?.id, "async_store");
    assert.equal(loads, 2);
  } finally {
    if (prevStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = prevStore;
  }
});

test("actor and data fields round-trip through JSON and SQLite", () => {
  runOnBoth((repo) => {
    const userActivity = makeRecord({
      id: "user_activity",
      workspaceId: "ws_a",
      actor: { type: "user", id: "user_123", displayName: "Ada Lovelace" },
      data: { subjectId: "agent_1", count: 3, accepted: true, previous: null },
    });
    const systemActivity = makeRecord({
      id: "system_activity",
      workspaceId: "ws_a",
      actor: { type: "system", id: "scheduler" },
      data: { cron: "daily", durationMs: 42, ok: true },
      occurredAt: "2026-04-26T11:00:00.000Z",
    });
    repo.upsert(userActivity);
    repo.upsert(systemActivity);
    assert.deepEqual(repo.find("user_activity"), userActivity);
    assert.deepEqual(repo.find("system_activity"), systemActivity);
  });
});

test("sqlite stores helper columns and full payload JSON", () => {
  withTempSqlite((repo, dbPath) => {
    const record = makeRecord({
      id: "act_helper",
      workspaceId: "ws_a",
      event: "workflow.scope_changed",
      occurredAt: "2026-04-26T10:00:00.000Z",
      actor: { type: "user", id: "user_1", displayName: "Alice" },
      data: { title: "Scope changed" },
    });
    repo.upsert(record);
    const db = new DatabaseSync(dbPath);
    try {
      const row = db.prepare("select * from activities where id = ?").get("act_helper") as
        | {
            workspace_id: string;
            occurred_at: string;
            type: string;
            payload: string;
            user_id: string | null;
            related_subject: string | null;
          }
        | undefined;
      assert.ok(row);
      assert.equal(row?.workspace_id, "ws_a");
      assert.equal(row?.occurred_at, "2026-04-26T10:00:00.000Z");
      assert.equal(row?.type, "workflow.scope_changed");
      assert.deepEqual(JSON.parse(row!.payload), record);
      assert.equal(row?.user_id, "user_1");
      assert.equal(row?.related_subject, null);
    } finally {
      db.close();
    }
  });
});

test("sqlite stores null user_id for system actors", () => {
  withTempSqlite((repo, dbPath) => {
    repo.upsert(makeRecord({ id: "system", actor: { type: "system", id: "worker" } }));
    const db = new DatabaseSync(dbPath);
    try {
      const row = db.prepare("select user_id from activities where id = ?").get("system") as
        | { user_id: string | null }
        | undefined;
      assert.equal(row?.user_id, null);
    } finally {
      db.close();
    }
  });
});

test("a corrupt payload row does not break list() or find()", () => {
  withTempSqlite((repo, dbPath) => {
    repo.upsert(
      makeRecord({ id: "good_1", workspaceId: "ws_a", occurredAt: "2026-04-26T10:00:00.000Z" }),
    );
    repo.upsert(
      makeRecord({ id: "good_2", workspaceId: "ws_a", occurredAt: "2026-04-26T12:00:00.000Z" }),
    );
    // Corrupt the payload of one row directly so JSON.parse will throw.
    // The table has a check(json_valid(payload)) constraint guarding new
    // writes; bypass it here to simulate a row that predates the constraint
    // or was written through another path.
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("pragma ignore_check_constraints = true");
      db.prepare(
        `insert into activities (id, workspace_id, occurred_at, type, payload, user_id, related_subject)
         values (?, ?, ?, ?, ?, ?, ?)`,
      ).run("corrupt", "ws_a", "2026-04-26T11:00:00.000Z", "activity.broken", "{not valid json", null, null);
    } finally {
      db.close();
    }

    // list() must still return every row (corrupt one falls back, not throws).
    const rows = repo.list({ workspaceId: "ws_a" });
    assert.deepEqual(rows.map((entry) => entry.id), ["good_2", "corrupt", "good_1"]);
    const corrupt = rows.find((entry) => entry.id === "corrupt");
    assert.ok(corrupt);
    assert.equal(corrupt?.workspaceId, "ws_a");
    assert.equal(corrupt?.event, "activity.broken");
    assert.equal(corrupt?.occurredAt, "2026-04-26T11:00:00.000Z");
    assert.deepEqual(corrupt?.data, {});

    // find() on the corrupt row also falls back instead of throwing.
    const found = repo.find("corrupt");
    assert.ok(found);
    assert.equal(found?.id, "corrupt");
    assert.equal(found?.event, "activity.broken");
  });
});

test("createActivitiesRepository selects JSON implementation by default", () => {
  const prevStore = process.env.PACKETAGENT_STORE;
  try {
    delete process.env.PACKETAGENT_STORE;
    const data = { activities: [] as ActivityRecord[] } as unknown as PacketAgentData;
    const repo = createActivitiesRepository({
      loadStore: () => data,
      mutateStore: <T,>(mutator: (target: PacketAgentData) => T) => mutator(data),
    });
    repo.upsert(makeRecord({ id: "act_1", workspaceId: "ws_a" }));
    assert.equal(repo.count(), 1);
    assert.equal(data.activities.length, 1);
  } finally {
    if (prevStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = prevStore;
  }
});

test("createActivitiesRepository returns sqlite implementation when env requests it", () => {
  const dir = mkdtempSync(join(tmpdir(), "packetagent-activities-repo-factory-"));
  const dbPath = join(dir, "packetagent.sqlite");
  const prevStore = process.env.PACKETAGENT_STORE;
  const prevDbPath = process.env.PACKETAGENT_DB_PATH;
  process.env.PACKETAGENT_STORE = "sqlite";
  process.env.PACKETAGENT_DB_PATH = dbPath;
  try {
    const repo = createActivitiesRepository({ dbPath });
    repo.upsert(makeRecord({ id: "act_1", workspaceId: "ws_a" }));
    assert.equal(repo.count(), 1);
    assert.equal(repo.list({ workspaceId: "ws_a" })[0]?.id, "act_1");
  } finally {
    if (prevStore === undefined) delete process.env.PACKETAGENT_STORE;
    else process.env.PACKETAGENT_STORE = prevStore;
    if (prevDbPath === undefined) delete process.env.PACKETAGENT_DB_PATH;
    else process.env.PACKETAGENT_DB_PATH = prevDbPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
