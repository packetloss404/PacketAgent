import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("npm start launches the single-process production server without watch mode", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts?: Record<string, string>;
  };

  assert.equal(packageJson.scripts?.start, "npm run start:server");
  assert.doesNotMatch(packageJson.scripts?.start ?? "", /\bdev\b|--watch/);
  assert.doesNotMatch(packageJson.scripts?.["start:server"] ?? "", /--watch/);
});
