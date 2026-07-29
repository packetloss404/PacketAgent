import assert from "node:assert/strict";
import test from "node:test";
import type { AppBuilderFileProgress } from "@/lib/types";
import { upsertFileProgress } from "./builder/helpers";

function progress(
  phase: AppBuilderFileProgress["phase"],
  path: string,
  status: AppBuilderFileProgress["status"],
  attempt = 0,
): AppBuilderFileProgress {
  return { phase, path, status, attempt, completed: status === "completed" ? 1 : 0, total: 1 };
}

test("file progress replaces one phase/file attempt without hiding other phases", () => {
  const planned = progress("plan", "src/App.tsx", "completed");
  const writing = progress("write", "src/App.tsx", "started");
  const written = progress("write", "src/App.tsx", "completed");

  const current = upsertFileProgress(upsertFileProgress([planned], writing), written);
  assert.deepEqual(current, [planned, written]);
});

test("repair attempts remain independently visible", () => {
  const initial = progress("validate", "src/App.tsx", "failed", 0);
  const repaired = progress("validate", "src/App.tsx", "completed", 1);
  assert.deepEqual(upsertFileProgress([initial], repaired), [initial, repaired]);
});
