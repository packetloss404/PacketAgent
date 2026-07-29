import assert from "node:assert/strict";
import test from "node:test";
import { buildValidationRepairGoal, classifyValidationFailures } from "./repair-strategy.js";
import type { ValidationError, ValidationResult } from "./validate.js";

function error(
  file: string,
  message: string,
  phase: ValidationError["phase"] = "typecheck",
): ValidationError {
  return { file, message, phase, severity: "error", line: 4, column: 2 };
}

function validation(errors: ValidationError[]): ValidationResult {
  return {
    ok: false,
    source: "real",
    errors,
    warnings: [],
    durationMs: 1,
    phases: { typecheck: "failed", build: "skipped" },
  };
}

test("classifies captured TypeScript and Vite failure families deterministically", () => {
  const strategy = classifyValidationFailures(
    validation([
      error("src/App.tsx", "Cannot find module './components/Board' or its type declarations."),
      error("src/App.tsx", "Type 'string' is not assignable to type 'number'."),
      error("src/Board.tsx", "JSX element 'section' has no corresponding closing tag."),
      error("vite.config.ts", "failed to load config from vite.config.ts", "build"),
      error("postcss.config.js", "Cannot find module 'autoprefixer'", "build"),
    ]),
  );

  assert.deepEqual(strategy.clusters, [
    "entry-config",
    "styling-config",
    "module-graph",
    "jsx-syntax",
    "type-contract",
  ]);
  assert.deepEqual(strategy.focusFiles, [
    "src/App.tsx",
    "src/Board.tsx",
    "vite.config.ts",
    "postcss.config.js",
  ]);
  assert.ok(strategy.instructions.every((instruction) => instruction.length > 40));
});

test("unknown validator failures stay conservative", () => {
  const strategy = classifyValidationFailures(
    validation([error("<validator>", "Sandbox command exited without diagnostics.")]),
  );
  assert.deepEqual(strategy.clusters, ["generic"]);
  assert.deepEqual(strategy.focusFiles, []);
  assert.match(strategy.instructions[0]!, /smallest deterministic source change/);
});

test("repair goal prioritizes focus files and bounds diagnostics", () => {
  const errors = Array.from({ length: 24 }, (_, index) =>
    error(
      index % 2 === 0 ? "src/App.tsx" : "src/types.ts",
      `Type 'value-${index}' is not assignable to type 'Expected'.`,
    ),
  );
  const goal = buildValidationRepairGoal(
    "Build a release tracker.",
    [
      { path: "package.json", content: "{}" },
      { path: "src/types.ts", content: "export type Row = { id: number };" },
      { path: "src/App.tsx", content: "export default function App(){ return null; }" },
    ],
    validation(errors),
    1,
  );

  assert.match(goal, /Failure clusters: type-contract/);
  assert.match(goal, /Do not hide errors with `any`/);
  assert.match(goal, /4 additional diagnostic\(s\) omitted/);
  assert.ok(goal.indexOf("--- src/App.tsx") < goal.indexOf("--- package.json"));
  assert.ok(goal.indexOf("--- src/types.ts") < goal.indexOf("--- package.json"));
});

test("repair goal strips terminal control sequences from diagnostics", () => {
  const goal = buildValidationRepairGoal(
    "Build an app.",
    [{ path: "src/App.tsx", content: "broken" }],
    validation([error("src/App.tsx", "\u001b[31mCannot find name 'broken'.\u001b[0m")]),
    2,
  );
  assert.equal(goal.includes("\u001b"), false);
  assert.match(goal, /Cannot find name 'broken'/);
});
