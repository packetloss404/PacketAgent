import { test } from "node:test";
import assert from "node:assert/strict";
import { safeNextPath } from "./safe-next-path";

test("safeNextPath keeps same-origin paths and rejects everything else", () => {
  assert.equal(safeNextPath("/builder/apps?x=1", "/"), "/builder/apps?x=1");
  assert.equal(safeNextPath(null, "/builder"), "/builder");
  assert.equal(safeNextPath("", "/builder"), "/builder");
  assert.equal(safeNextPath("https://evil.example", "/"), "/");
  assert.equal(safeNextPath("//evil.example/path", "/"), "/");
  assert.equal(safeNextPath("/\\evil.example", "/"), "/");
});
