import { resolve } from "node:path";

// The server, CLI, and production JavaScript bundle all run from the PacketAgent
// application root. Keeping migrations rooted there makes the same immutable SQL
// assets available when modules are bundled and their individual import.meta URLs
// no longer describe their original source directories.
export const PACKETAGENT_MIGRATIONS_DIR = resolve(process.cwd(), "src", "db", "migrations");
