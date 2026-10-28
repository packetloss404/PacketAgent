import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openSqliteDatabase } from "../db/sqlite-database.js";

// LEAF module: store-facing SQLite open. The pragmas and the cached migration
// runner live in ../db/sqlite-database.js so every runtime database consumer
// (store backend, dedicated repositories, sandbox store) shares one
// implementation instead of re-reading the migrations directory on each open.
export const DEFAULT_DB_FILE = resolve(process.cwd(), "data", "packetagent.sqlite");

export function openStoreDatabase(dbPath: string): DatabaseSync {
  return openSqliteDatabase(dbPath);
}
