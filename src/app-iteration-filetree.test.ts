import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAppIterationViaFileTree,
  buildFileTreeIterationGoal,
  canonicalizeIterationFileTree,
  diffFileTrees,
  reviewFileTrees,
  scopeGeneratedFileTree,
  shouldUseFileTreeIteration,
  type AppIterationFileTreeOptions,
} from "./app-iteration-service.js";
import type { AuthorAppOptions, AuthorAppResult, GeneratedFile } from "./codegen/llm-author.js";
import type { ValidateOptions, ValidationResult } from "./codegen/validate.js";

// ---------------------------------------------------------------------------
// shouldUseFileTreeIteration — pure helper
// ---------------------------------------------------------------------------

test("shouldUseFileTreeIteration: accepts canonical and convertible legacy bundles", () => {
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

  // Structured-tool and template sources use the explicit conversion seam.
  assert.equal(shouldUseFileTreeIteration({ flagOn: true, draftSource: "llm", files }), true);

  assert.equal(shouldUseFileTreeIteration({ flagOn: true, draftSource: "template", files }), true);

  // Right source, undefined files.
  assert.equal(shouldUseFileTreeIteration({ flagOn: true, draftSource: "llm-filetree" }), false);

  // Right source, empty files array.
  assert.equal(
    shouldUseFileTreeIteration({ flagOn: true, draftSource: "llm-filetree", files: [] }),
    false,
  );

  // Historical source-less checkpoints are converted explicitly as unknown.
  assert.equal(shouldUseFileTreeIteration({ flagOn: true, draftSource: undefined, files }), true);
});

test("canonicalizeIterationFileTree normalizes paths and records one-time provenance", () => {
  assert.deepEqual(
    canonicalizeIterationFileTree({
      flagOn: true,
      draftSource: "template",
      files: [{ path: "src\\App.tsx", content: "app" }],
    }),
    {
      source: "llm-filetree",
      convertedFrom: "template",
      files: [{ path: "src/App.tsx", content: "app" }],
    },
  );

  assert.deepEqual(
    canonicalizeIterationFileTree({
      flagOn: true,
      draftSource: "llm-filetree",
      files: [{ path: "src/App.tsx", content: "app" }],
    }),
    {
      source: "llm-filetree",
      files: [{ path: "src/App.tsx", content: "app" }],
    },
  );
});

test("canonicalizeIterationFileTree rejects unsafe and case-colliding bundles", () => {
  assert.equal(
    canonicalizeIterationFileTree({
      flagOn: true,
      draftSource: "template",
      files: [{ path: "../escape.ts", content: "bad" }],
    }),
    null,
  );
  assert.equal(
    canonicalizeIterationFileTree({
      flagOn: true,
      draftSource: "template",
      files: [
        { path: "src/App.tsx", content: "one" },
        { path: "SRC/app.tsx", content: "two" },
      ],
    }),
    null,
  );
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

test("reviewFileTrees includes unchanged files with digest and size evidence", () => {
  const review = reviewFileTrees(
    [
      { path: "src/App.tsx", content: "old" },
      { path: "src/shared.ts", content: "same" },
      { path: "src/deleted.ts", content: "gone" },
    ],
    [
      { path: "src/App.tsx", content: "new" },
      { path: "src/shared.ts", content: "same" },
      { path: "src/added.ts", content: "added" },
    ],
  );
  const byPath = new Map(review.map((entry) => [entry.path, entry]));

  assert.deepEqual(review.map((entry) => entry.changeType).sort(), [
    "added",
    "deleted",
    "modified",
    "unchanged",
  ]);
  assert.equal(byPath.get("src/shared.ts")?.beforeSha256, byPath.get("src/shared.ts")?.afterSha256);
  assert.equal(byPath.get("src/shared.ts")?.beforeSize, 4);
  assert.equal(byPath.get("src/shared.ts")?.diff, "No content changes.");
});

test("scopeGeneratedFileTree restores mutations outside a page target", () => {
  const scoped = scopeGeneratedFileTree(
    [
      { path: "src/pages/Settings.tsx", content: "old settings" },
      { path: "src/util.ts", content: "stable util" },
      { path: "src/legacy.ts", content: "keep me" },
    ],
    [
      { path: "src/pages/Settings.tsx", content: "new settings" },
      { path: "src/components/SettingsForm.tsx", content: "new form" },
      { path: "src/util.ts", content: "unrelated mutation" },
    ],
    { kind: "page", path: "/settings", name: "Settings" },
  );
  const byPath = new Map(scoped.files.map((file) => [file.path, file.content]));

  assert.equal(byPath.get("src/pages/Settings.tsx"), "new settings");
  assert.equal(byPath.get("src/components/SettingsForm.tsx"), "new form");
  assert.equal(byPath.get("src/util.ts"), "stable util");
  assert.equal(byPath.get("src/legacy.ts"), "keep me");
  assert.deepEqual(scoped.outOfScopePaths, ["src/legacy.ts", "src/util.ts"]);
});

test("scopeGeneratedFileTree isolates route, entity, and component targets", () => {
  const current = [
    { path: "src/api/orders.ts", content: "old api" },
    { path: "src/data/Order.ts", content: "old entity" },
    { path: "src/pages/Orders.tsx", content: "old page" },
    { path: "src/components/OrderCard.tsx", content: "old card" },
    { path: "src/util.ts", content: "stable" },
  ];
  const proposed = current.map((file) => ({ ...file, content: `new ${file.path}` }));

  const api = scopeGeneratedFileTree(current, proposed, {
    kind: "api",
    path: "/api/orders",
  });
  assert.deepEqual(
    api.files.filter((file) => file.content.startsWith("new ")).map((file) => file.path),
    ["src/api/orders.ts"],
  );

  const data = scopeGeneratedFileTree(current, proposed, {
    kind: "data",
    name: "Order",
  });
  assert.deepEqual(
    data.files.filter((file) => file.content.startsWith("new ")).map((file) => file.path),
    ["src/data/Order.ts"],
  );

  const component = scopeGeneratedFileTree(current, proposed, {
    kind: "component",
    path: "/orders",
    selector: "article.order-card",
  });
  assert.deepEqual(
    component.files.filter((file) => file.content.startsWith("new ")).map((file) => file.path),
    ["src/components/OrderCard.tsx", "src/pages/Orders.tsx"],
  );
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

test("buildFileTreeIterationGoal records route and component target boundaries", () => {
  const goal = buildFileTreeIterationGoal(
    [{ path: "src/pages/Settings.tsx", content: "function Settings(){}" }],
    "Change the save button",
    {
      kind: "component",
      path: "/settings",
      name: "Settings",
      selector: "form.settings > button.primary",
    },
  );
  assert.match(goal, /kind: component/);
  assert.match(goal, /route\/path: \/settings/);
  assert.match(goal, /selected component: form\.settings > button\.primary/);
  assert.match(goal, /Preserve every unrelated file byte-for-byte/);
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
  source: "real",
  errors: [],
  warnings: [],
  durationMs: 0,
  phases: { typecheck: "passed", build: "passed" },
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
  assert.equal(out!.reviewFiles.length, 5);
  assert.equal(
    out!.reviewFiles.find((entry) => entry.path === "src/util.ts")?.changeType,
    "unchanged",
  );
  assert.deepEqual(out!.outOfScopePaths, []);

  // changedSummary should mention counts.
  assert.match(out!.changedSummary, /File-tree iteration/);
  assert.match(out!.changedSummary, /modified/);
  assert.match(out!.changedSummary, /added/);
  assert.match(out!.changedSummary, /deleted/);
});

test("applyAppIterationViaFileTree enforces targeted page regeneration", async () => {
  const oldFiles: GeneratedFile[] = [
    { path: "src/pages/Settings.tsx", content: "old settings" },
    { path: "src/util.ts", content: "stable util" },
  ];
  const proposedFiles: GeneratedFile[] = [
    { path: "src/pages/Settings.tsx", content: "new settings" },
    { path: "src/util.ts", content: "unrelated rewrite" },
  ];

  const out = await applyAppIterationViaFileTree(oldFiles, "Update settings", {
    workspaceId: "ws-1",
    target: { kind: "page", path: "/settings", name: "Settings" },
    authorFn: makeAuthorFn({ files: proposedFiles, summary: "updated", source: "llm" }),
    validateFn: makeValidateFn(VALID_OK),
  });

  assert.ok(out);
  assert.deepEqual(out.outOfScopePaths, ["src/util.ts"]);
  assert.deepEqual(
    out.files.map((entry) => entry.path),
    ["src/pages/Settings.tsx"],
  );
  assert.equal(
    out.reviewFiles.find((entry) => entry.path === "src/util.ts")?.changeType,
    "unchanged",
  );
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
