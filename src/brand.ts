import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const APP_NAME = "PacketAgent";
export const PACKAGE_NAME = "packetagent";
export const ENV_PREFIX = "PACKETAGENT_";
export const LEGACY_ENV_PREFIX = "TASKLOOM_";

export const DEFAULT_DATA_FILES = {
  json: "data/packetagent.json",
  sqlite: "data/packetagent.sqlite",
} as const;

export const LEGACY_DATA_FILES = {
  json: "data/taskloom.json",
  sqlite: "data/taskloom.sqlite",
} as const;

/**
 * Keep existing TaskLoom deployments bootable during the PacketAgent rename.
 * New PACKETAGENT_* values always win; a legacy value is copied only when the
 * canonical key is absent.
 */
export function applyLegacyEnvironmentAliases(env: NodeJS.ProcessEnv = process.env): string[] {
  const applied: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(LEGACY_ENV_PREFIX) || value === undefined) continue;
    const canonical = `${ENV_PREFIX}${key.slice(LEGACY_ENV_PREFIX.length)}`;
    if (env[canonical] !== undefined) continue;
    env[canonical] = value;
    applied.push(canonical);
  }
  return applied.sort();
}

/**
 * Copy legacy default stores into their PacketAgent paths on first boot.
 * The TaskLoom files remain untouched as a recovery copy. Explicit
 * PACKETAGENT_DB_PATH / CLI paths bypass this default-path migration.
 */
export function migrateLegacyDefaultDataFiles(root = process.cwd()): string[] {
  const copied: string[] = [];
  for (const kind of ["json", "sqlite"] as const) {
    const legacy = resolve(root, LEGACY_DATA_FILES[kind]);
    const canonical = resolve(root, DEFAULT_DATA_FILES[kind]);
    if (!existsSync(legacy) || existsSync(canonical)) continue;
    mkdirSync(dirname(canonical), { recursive: true });
    copyFileSync(legacy, canonical);
    copied.push(DEFAULT_DATA_FILES[kind]);
  }
  return copied;
}

// Most runtime configuration is read lazily, so installing aliases as the
// first imported module keeps legacy environments working without spreading
// fallback expressions throughout the codebase.
applyLegacyEnvironmentAliases();
