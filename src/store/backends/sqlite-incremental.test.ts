import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { openStoreDatabase } from "../sqlite-db.js";
import { loadSqliteStore, mutateSqliteStore } from "./sqlite.js";

// Persisting the store used to delete and re-insert every row of every table on
// each mutation, so one write cost as much as the whole dataset. These tests pin
// the incremental behaviour: a mutation must touch only the rows it changed.

const NOW = "2026-01-01T00:00:00.000Z";

function withDatabase<T>(dbPath: string, run: (db: DatabaseSync) => T): T {
  const db = openStoreDatabase(dbPath);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function installWriteCounters(db: DatabaseSync, table: string, counterTable: string): void {
  db.exec(`create table ${counterTable} (id integer primary key, count integer not null)`);
  db.exec(`insert into ${counterTable} (id, count) values (1, 0)`);
  for (const operation of ["insert", "update"] as const) {
    db.exec(
      `create trigger count_${table}_${operation} after ${operation} on ${table}
       begin update ${counterTable} set count = count + 1 where id = 1; end`,
    );
  }
}

function readCount(db: DatabaseSync, counterTable: string): number {
  const row = db.prepare(`select count from ${counterTable} where id = 1`).get() as
    | { count: number }
    | undefined;
  return row?.count ?? 0;
}

function countJobs(db: DatabaseSync, idPrefix: string): number {
  const row = db
    .prepare("select count(*) as count from jobs where id like ?")
    .get(`${idPrefix}%`) as { count: number } | undefined;
  return row?.count ?? 0;
}

function jobRecord(id: string): Record<string, unknown> {
  return {
    id,
    workspaceId: "ws-1",
    type: "agent.run",
    payload: {},
    status: "queued",
    attempts: 0,
    maxAttempts: 3,
    scheduledAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

test("a mutation rewrites only the rows it changed", () => {
  const dir = mkdtempSync(join(tmpdir(), "packetagent-incremental-"));
  const dbPath = join(dir, "packetagent.sqlite");
  try {
    mutateSqliteStore(dbPath, (data) => {
      for (let index = 0; index < 25; index += 1) {
        data.jobs.push(jobRecord(`bench-${index}`) as never);
      }
      return null;
    });

    withDatabase(dbPath, (db) => installWriteCounters(db, "jobs", "job_write_counter"));

    // A mutation that touches nothing in `jobs` must not rewrite the table.
    mutateSqliteStore(dbPath, (data) => {
      data.rateLimits = [{ id: "rl-1", count: 1, resetAt: NOW, updatedAt: NOW }];
      return null;
    });

    assert.equal(
      withDatabase(dbPath, (db) => readCount(db, "job_write_counter")),
      0,
      "an unrelated mutation rewrote jobs",
    );

    // Changing a single job must rewrite exactly that one row, not all 25.
    mutateSqliteStore(dbPath, (data) => {
      const target = data.jobs.find((job) => job.id === "bench-7");
      assert.ok(target);
      target.status = "failed";
      return null;
    });

    assert.equal(
      withDatabase(dbPath, (db) => readCount(db, "job_write_counter")),
      1,
      "expected exactly one job row write",
    );

    // Adding one job writes one row.
    mutateSqliteStore(dbPath, (data) => {
      data.jobs.push(jobRecord("bench-999") as never);
      return null;
    });

    assert.equal(
      withDatabase(dbPath, (db) => readCount(db, "job_write_counter")),
      2,
      "expected one insert for the new job",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a removed record deletes only its own row", () => {
  const dir = mkdtempSync(join(tmpdir(), "packetagent-incremental-delete-"));
  const dbPath = join(dir, "packetagent.sqlite");
  try {
    mutateSqliteStore(dbPath, (data) => {
      for (let index = 0; index < 5; index += 1) {
        data.jobs.push(jobRecord(`bench-${index}`) as never);
      }
      return null;
    });

    assert.equal(
      withDatabase(dbPath, (db) => countJobs(db, "bench-")),
      5,
    );

    mutateSqliteStore(dbPath, (data) => {
      data.jobs = data.jobs.filter((job) => job.id !== "bench-3");
      return null;
    });

    assert.equal(
      withDatabase(dbPath, (db) => countJobs(db, "bench-")),
      4,
    );

    const reloaded = withDatabase(dbPath, (db) => loadSqliteStore(db));
    assert.ok(reloaded);
    assert.equal(
      reloaded.jobs.some((job) => job.id === "bench-3"),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("app_records are written incrementally too", () => {
  const dir = mkdtempSync(join(tmpdir(), "packetagent-incremental-records-"));
  const dbPath = join(dir, "packetagent.sqlite");
  try {
    mutateSqliteStore(dbPath, (data) => {
      data.agents.push({
        id: "agent-bench",
        workspaceId: "ws-1",
        name: "Agent one",
        status: "active",
        createdAt: NOW,
        updatedAt: NOW,
      } as never);
      return null;
    });

    withDatabase(dbPath, (db) =>
      installWriteCounters(db, "app_records", "app_record_write_counter"),
    );

    // Touching a dedicated table must not rewrite the app_records rows.
    mutateSqliteStore(dbPath, (data) => {
      data.rateLimits = [{ id: "rl-2", count: 2, resetAt: NOW, updatedAt: NOW }];
      return null;
    });

    assert.equal(
      withDatabase(dbPath, (db) => readCount(db, "app_record_write_counter")),
      0,
      "app_records were rewritten needlessly",
    );

    mutateSqliteStore(dbPath, (data) => {
      const agent = data.agents.find((entry) => entry.id === "agent-bench");
      assert.ok(agent);
      agent.name = "Agent renamed";
      return null;
    });

    assert.equal(
      withDatabase(dbPath, (db) => readCount(db, "app_record_write_counter")),
      1,
      "expected one app_records write",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
