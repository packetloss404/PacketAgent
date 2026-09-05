import { test } from "node:test";
import assert from "node:assert/strict";
import { STORE_COMPARISON_COLLECTIONS } from "./cli.js";
import { normalizeStore } from "../store/normalize.js";

test("managed-postgres backfill and verify cover every store collection", () => {
  const collections = Object.keys(normalizeStore({})).sort();
  const compared: string[] = [...STORE_COMPARISON_COLLECTIONS].sort();
  assert.deepEqual(
    collections.filter((collection) => !compared.includes(collection)),
    [],
    "collections missing from STORE_COMPARISON_COLLECTIONS are silently dropped by backfill",
  );
});
