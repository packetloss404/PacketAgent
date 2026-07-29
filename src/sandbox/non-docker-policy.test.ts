import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const SOURCE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const FORBIDDEN_VM_IMPORT = /(?:from\s*|import\s*\(|require\s*\()\s*["'](?:node:)?vm["']/;

test("production source never treats node:vm as an untrusted-code boundary", async () => {
  const entries = await readdir(SOURCE_ROOT, { recursive: true });
  const violations: string[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    const source = await readFile(join(SOURCE_ROOT, entry), "utf8");
    if (FORBIDDEN_VM_IMPORT.test(source)) violations.push(entry.replaceAll("\\", "/"));
  }

  assert.deepEqual(
    violations,
    [],
    `node:vm imports are forbidden in production source: ${violations.join(", ")}`,
  );
});
