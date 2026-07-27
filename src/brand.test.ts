import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { applyLegacyEnvironmentAliases, migrateLegacyDefaultDataFiles } from "./brand.js";

test("legacy TaskLoom environment values fill only missing PacketAgent keys", () => {
  const env: NodeJS.ProcessEnv = {
    TASKLOOM_STORE: "sqlite",
    TASKLOOM_DB_PATH: "legacy.sqlite",
    PACKETAGENT_DB_PATH: "canonical.sqlite",
  };

  assert.deepEqual(applyLegacyEnvironmentAliases(env), ["PACKETAGENT_STORE"]);
  assert.equal(env.PACKETAGENT_STORE, "sqlite");
  assert.equal(env.PACKETAGENT_DB_PATH, "canonical.sqlite");
});

test("legacy default data files copy once and preserve the originals", () => {
  const root = mkdtempSync(join(tmpdir(), "packetagent-brand-"));
  const legacyJson = join(root, "data", "taskloom.json");
  const legacySqlite = join(root, "data", "taskloom.sqlite");
  mkdirSync(dirname(legacyJson), { recursive: true });
  writeFileSync(legacyJson, '{"source":"legacy"}', "utf8");
  writeFileSync(legacySqlite, "legacy-sqlite", "utf8");

  assert.deepEqual(migrateLegacyDefaultDataFiles(root), [
    "data/packetagent.json",
    "data/packetagent.sqlite",
  ]);
  assert.equal(readFileSync(legacyJson, "utf8"), '{"source":"legacy"}');
  assert.equal(readFileSync(join(root, "data", "packetagent.json"), "utf8"), '{"source":"legacy"}');

  writeFileSync(join(root, "data", "packetagent.json"), '{"source":"new"}', "utf8");
  assert.deepEqual(migrateLegacyDefaultDataFiles(root), []);
  assert.equal(readFileSync(join(root, "data", "packetagent.json"), "utf8"), '{"source":"new"}');
});
