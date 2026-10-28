import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PACKETAGENT_MIGRATIONS_DIR } from "./migrations-path.js";
import { openSqliteDatabase, resetSqliteMigrationCacheForTests } from "./sqlite-database.js";

function expectedMigrationNames(): string[] {
  return readdirSync(PACKETAGENT_MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

function appliedMigrationNames(db: ReturnType<typeof openSqliteDatabase>): string[] {
  return (
    db.prepare("select name from schema_migrations order by name").all() as Array<{ name: string }>
  ).map((row) => row.name);
}

test("openSqliteDatabase applies every migration exactly once", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-sqlite-open-"));
  const dbPath = join(tempDir, "packetagent.sqlite");
  try {
    const db = openSqliteDatabase(dbPath);
    try {
      assert.deepEqual(appliedMigrationNames(db), expectedMigrationNames());
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("reopening an already-migrated database is a no-op", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-sqlite-reopen-"));
  const dbPath = join(tempDir, "packetagent.sqlite");
  try {
    const first = openSqliteDatabase(dbPath);
    const firstApplied = appliedMigrationNames(first);
    first.close();

    // Warm the cache path: a second open must not re-run any migration or
    // duplicate rows in schema_migrations.
    const second = openSqliteDatabase(dbPath);
    try {
      assert.deepEqual(appliedMigrationNames(second), firstApplied);
      const count = second.prepare("select count(*) as count from schema_migrations").get() as {
        count: number;
      };
      assert.equal(count.count, expectedMigrationNames().length);
    } finally {
      second.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a fresh migration cache still applies every migration", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-sqlite-cache-"));
  const dbPath = join(tempDir, "packetagent.sqlite");
  try {
    const warm = openSqliteDatabase(dbPath);
    warm.close();

    resetSqliteMigrationCacheForTests();

    const reopened = openSqliteDatabase(dbPath);
    try {
      assert.deepEqual(appliedMigrationNames(reopened), expectedMigrationNames());
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the runtime pragmas are applied on every open", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-sqlite-pragma-"));
  const dbPath = join(tempDir, "packetagent.sqlite");
  try {
    const db = openSqliteDatabase(dbPath);
    try {
      const journal = db.prepare("pragma journal_mode").get() as { journal_mode: string };
      const foreignKeys = db.prepare("pragma foreign_keys").get() as { foreign_keys: number };
      assert.equal(journal.journal_mode, "wal");
      assert.equal(foreignKeys.foreign_keys, 1);
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolve(process.cwd(), ...) still anchors the migrations directory", () => {
  // Guards the shared runner against a cwd-relative path regression.
  assert.equal(PACKETAGENT_MIGRATIONS_DIR, resolve(process.cwd(), "src", "db", "migrations"));
});
