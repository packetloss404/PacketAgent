import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PACKETAGENT_MIGRATIONS_DIR } from "./migrations-path.js";

// Shared SQLite open + migration runner for every runtime database consumer
// (store backend, dedicated repositories, sandbox store). The migration files
// are immutable application assets, so their names and contents are read from
// disk once per process and cached. A warm open therefore only consults
// `schema_migrations` — the database stays the source of truth for what has been
// applied — instead of re-reading the directory and every migration file on each
// connection, which previously happened on every scheduler poll.

interface SqliteMigration {
  name: string;
  sql: string;
}

let cachedMigrations: SqliteMigration[] | null = null;

function loadSqliteMigrations(): SqliteMigration[] {
  if (cachedMigrations) return cachedMigrations;
  cachedMigrations = readdirSync(PACKETAGENT_MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(resolve(PACKETAGENT_MIGRATIONS_DIR, name), "utf8"),
    }));
  return cachedMigrations;
}

/**
 * Apply every pending migration inside its own transaction. Idempotent: an
 * already-migrated database runs no migration and writes no rows. Exposed for
 * consumers that already hold an open connection.
 */
export function applySqliteMigrations(db: DatabaseSync): void {
  db.exec(
    "create table if not exists schema_migrations (name text primary key, applied_at text not null default (datetime('now')))",
  );
  const appliedRows = db
    .prepare("select name from schema_migrations order by name")
    .all() as Array<{ name: string }>;
  const alreadyApplied = new Set(appliedRows.map((row) => row.name));

  for (const migration of loadSqliteMigrations()) {
    if (alreadyApplied.has(migration.name)) continue;
    db.exec("begin");
    try {
      db.exec(migration.sql);
      db.prepare("insert into schema_migrations (name) values (?)").run(migration.name);
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  }
}

/**
 * Open a SQLite database with the runtime pragmas and every migration applied.
 * The caller owns the returned connection and must close it.
 */
export function openSqliteDatabase(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("pragma busy_timeout = 5000");
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  applySqliteMigrations(db);
  return db;
}

/** Drop the in-process migration cache so a test can observe a fresh read. */
export function resetSqliteMigrationCacheForTests(): void {
  cachedMigrations = null;
}
