import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAppIterationViaFileTree,
  buildFileTreeIterationGoal,
  diffFileTrees,
  shouldUseFileTreeIteration,
  type AppIterationFileTreeOptions,
} from "./app-iteration-service.js";
import type { AuthorAppOptions, AuthorAppResult, GeneratedFile } from "./codegen/llm-author.js";
import type { ValidateOptions, ValidationResult } from "./codegen/validate.js";

// ---------------------------------------------------------------------------
// shouldUseFileTreeIteration — pure helper
// ---------------------------------------------------------------------------

test("shouldUseFileTreeIteration: true only when flag + source + non-empty files", () => {
  const files: GeneratedFile[] = [{ path: "src/App.tsx", content: "x" }];

  // Happy path.
  assert.equal(
    shouldUseFileTreeIteration({ flagOn: true, draftSource: "llm-filetree", files }),
    true,
  );

  // Flag off.
  assert.equal(
    shouldUseFileTreeIteration({ flagOn: false, draftSource: "llm-filetree", files }),
    false,
  );

  // Wrong source — "llm" (structured tool) path.
  assert.equal(shouldUseFileTreeIteration({ flagOn: true, draftSource: "llm", files }), false);

  // Wrong source — "template" path.
  assert.equal(shouldUseFileTreeIteration({ flagOn: true, draftSource: "template", files }), false);

  // Right source, undefined files.
  assert.equal(shouldUseFileTreeIteration({ flagOn: true, draftSource: "llm-filetree" }), false);

  // Right source, empty files array.
  assert.equal(
    shouldUseFileTreeIteration({ flagOn: true, draftSource: "llm-filetree", files: [] }),
    false,
  );

  // Source undefined.
  assert.equal(shouldUseFileTreeIteration({ flagOn: true, draftSource: undefined, files }), false);
});

// ---------------------------------------------------------------------------
// diffFileTrees — pure helper
// ---------------------------------------------------------------------------

test("diffFileTrees: added / modified / deleted / unchanged", () => {
  const oldFiles: GeneratedFile[] = [
    { path: "src/App.tsx", content: "old app" },
    { path: "src/util.ts", content: "shared" },
    { path: "src/legacy.ts", content: "obsolete" },
  ];
  const newFiles: GeneratedFile[] = [
    { path: "src/App.tsx", content: "new app" }, // modified
    { path: "src/util.ts", content: "shared" }, // unchanged
    { path: "src/pages/Home.tsx", content: "new page" }, // added
    // src/legacy.ts removed → deleted
  ];

  const entries = diffFileTrees(oldFiles, newFiles);
  const byPath = new Map(entries.map((e) => [e.path, e]));

  assert.equal(entries.length, 3, "expected 3 diff entries (unchanged file excluded)");

  assert.equal(byPath.get("src/App.tsx")?.changeType, "modified");
  assert.equal(byPath.get("src/pages/Home.tsx")?.changeType, "added");
  assert.equal(byPath.get("src/legacy.ts")?.changeType, "deleted");
  assert.equal(byPath.has("src/util.ts"), false, "unchanged file must be omitted");

  // Every entry should have a non-empty diff string and a sensible summary.
  for (const entry of entries) {
    assert.ok(entry.diff.length > 0, `entry ${entry.path} should have a diff`);
    assert.ok(entry.summary.length > 0, `entry ${entry.path} should have a summary`);
  }
});

// ---------------------------------------------------------------------------
// buildFileTreeIterationGoal — sanity
// ---------------------------------------------------------------------------

test("buildFileTreeIterationGoal embeds file contents and change request", () => {
  const files: GeneratedFile[] = [{ path: "src/App.tsx", content: "function App(){}" }];
  const goal = buildFileTreeIterationGoal(files, "Add a settings page");
  assert.ok(goal.includes("src/App.tsx"));
  assert.ok(goal.includes("function App(){}"));
  assert.ok(goal.includes("Add a settings page"));
  assert.ok(goal.includes("write_file"));
});

// ---------------------------------------------------------------------------
// applyAppIterationViaFileTree — happy path with injected fakes
// ---------------------------------------------------------------------------

function makeAuthorFn(
  result: AuthorAppResult | null,
): typeof import("./codegen/llm-author.js").authorAppViaLLM {
  return async (_userGoal: string, _options: AuthorAppOptions, _emit) => result;
}

function makeValidateFn(
  result: ValidationResult,
): typeof import("./codegen/validate.js").validateFileTree {
  return async (_files: GeneratedFile[], _options: ValidateOptions = {}) => result;
}

const VALID_OK: ValidationResult = {
  ok: true,
  source: "skipped",
  errors: [],
  warnings: [],
  durationMs: 0,
  phases: { typecheck: "skipped", build: "skipped" },
};

test("applyAppIterationViaFileTree: happy path diffs old vs new tree", async () => {
  const oldFiles: GeneratedFile[] = [
    { path: "src/App.tsx", content: "old app" },
    { path: "src/util.ts", content: "shared" },
    { path: "src/legacy.ts", content: "obsolete" },
  ];
  const newFiles: GeneratedFile[] = [
    { path: "src/App.tsx", content: "new app" },
    { path: "src/util.ts", content: "shared" },
    { path: "src/pages/Home.tsx", content: "new page" },
    { path: "src/pages/Settings.tsx", content: "settings" },
  ];

  const options: AppIterationFileTreeOptions = {
    workspaceId: "ws-1",
    preset: "fast",
    authorFn: makeAuthorFn({ files: newFiles, summary: "Added settings + home", source: "llm" }),
    validateFn: makeValidateFn(VALID_OK),
  };

  const out = await applyAppIterationViaFileTree(oldFiles, "Add settings + home pages", options);
  assert.ok(out, "expected a non-null result");
  assert.equal(out!.newFiles.length, 4);
  assert.equal(out!.validationErrors, undefined);

  const byPath = new Map(out!.files.map((e) => [e.path, e]));
  assert.equal(byPath.get("src/App.tsx")?.changeType, "modified");
  assert.equal(byPath.get("src/pages/Home.tsx")?.changeType, "added");
  assert.equal(byPath.get("src/pages/Settings.tsx")?.changeType, "added");
  assert.equal(byPath.get("src/legacy.ts")?.changeType, "deleted");
  assert.equal(byPath.has("src/util.ts"), false);

  // changedSummary should mention counts.
  assert.match(out!.changedSummary, /File-tree iteration/);
  assert.match(out!.changedSummary, /modified/);
  assert.match(out!.changedSummary, /added/);
  assert.match(out!.changedSummary, /deleted/);
});

// ---------------------------------------------------------------------------
// applyAppIterationViaFileTree: validator errors are surfaced
// ---------------------------------------------------------------------------

test("applyAppIterationViaFileTree: validation errors propagate", async () => {
  const oldFiles: GeneratedFile[] = [{ path: "src/App.tsx", content: "old" }];
  const newFiles: GeneratedFile[] = [{ path: "src/App.tsx", content: "new" }];

  const validation: ValidationResult = {
    ok: false,
    source: "real",
    errors: [
      {
        file: "src/App.tsx",
        line: 3,
        message: "Cannot find name 'foo'.",
        severity: "error",
        phase: "typecheck",
      },
      { file: "<tsconfig>", message: "missing include", severity: "error", phase: "typecheck" },
    ],
    warnings: [],
    durationMs: 42,
    phases: { typecheck: "failed", build: "skipped" },
  };

  const out = await applyAppIterationViaFileTree(oldFiles, "Tweak app", {
    workspaceId: "ws-1",
    authorFn: makeAuthorFn({ files: newFiles, summary: "tweaked", source: "llm" }),
    validateFn: makeValidateFn(validation),
  });

  assert.ok(out);
  assert.ok(Array.isArray(out!.validationErrors));
  assert.equal(out!.validationErrors!.length, 2);
  assert.match(out!.validationErrors![0]!, /src\/App\.tsx:3/);
  assert.match(out!.validationErrors![1]!, /<tsconfig>/);

  // changedSummary should still be sensible even when validation failed.
  assert.ok(out!.changedSummary.length > 0);
});

// ---------------------------------------------------------------------------
// applyAppIterationViaFileTree: orchestrator returns null → null result
// ---------------------------------------------------------------------------

test("applyAppIterationViaFileTree: orchestrator null → null", async () => {
  const out = await applyAppIterationViaFileTree(
    [{ path: "src/App.tsx", content: "a" }],
    "anything",
    {
      workspaceId: "ws-1",
      authorFn: makeAuthorFn(null),
      validateFn: makeValidateFn(VALID_OK),
    },
  );
  assert.equal(out, null);
});

test("applyAppIterationViaFileTree: empty files from orchestrator → null", async () => {
  const out = await applyAppIterationViaFileTree(
    [{ path: "src/App.tsx", content: "a" }],
    "anything",
    {
      workspaceId: "ws-1",
      authorFn: makeAuthorFn({ files: [], summary: "nope", source: "llm" }),
      validateFn: makeValidateFn(VALID_OK),
    },
  );
  assert.equal(out, null);
});

test("applyAppIterationViaFileTree: empty currentFiles → null (no fallback)", async () => {
  const out = await applyAppIterationViaFileTree([], "anything", {
    workspaceId: "ws-1",
    authorFn: makeAuthorFn({ files: [{ path: "x", content: "y" }], summary: "s", source: "llm" }),
    validateFn: makeValidateFn(VALID_OK),
  });
  assert.equal(out, null);
});

test("applyAppIterationViaFileTree: empty change request → null", async () => {
  const out = await applyAppIterationViaFileTree([{ path: "src/App.tsx", content: "a" }], "   ", {
    workspaceId: "ws-1",
    authorFn: makeAuthorFn({ files: [{ path: "x", content: "y" }], summary: "s", source: "llm" }),
    validateFn: makeValidateFn(VALID_OK),
  });
  assert.equal(out, null);
});
