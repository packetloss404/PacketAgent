import assert from "node:assert/strict";
import test from "node:test";
import type { AgentInputField, AgentPlaybookStep } from "@/lib/types";
import {
  buildRunInputPayload,
  formatStepList,
  isApprovalResult,
  lines,
  missingPlaybookTitleIndexes,
  riskForApprovalTool,
  runFromAgentResult,
  seedRunInputs,
} from "./helpers";

const schema: AgentInputField[] = [
  {
    key: "count",
    label: "Count",
    type: "number",
    required: false,
    exampleValue: "3",
  },
  {
    key: "enabled",
    label: "Enabled",
    type: "boolean",
    required: false,
  },
  {
    key: "note",
    label: "Note",
    type: "string",
    required: false,
    defaultValue: "saved",
  },
];

test("Agent editor input helpers preserve examples and typed launch values", () => {
  assert.deepEqual(seedRunInputs(schema), {
    count: "3",
    enabled: "false",
    note: "saved",
  });
  assert.deepEqual(
    buildRunInputPayload(schema, {
      count: "12.5",
      enabled: "true",
      note: "",
    }),
    {
      count: 12.5,
      enabled: true,
    },
  );
  assert.deepEqual(buildRunInputPayload(schema, { count: "not-a-number" }), {});
});

test("Agent editor list and playbook validation helpers stay deterministic", () => {
  assert.deepEqual(lines(" one, two\nthree ,, "), ["one", "two", "three"]);
  const steps = [
    { id: "1", title: "", instruction: "First" },
    { id: "2", title: "Second", instruction: "Second" },
    { id: "3", title: " ", instruction: "Third" },
  ] as AgentPlaybookStep[];
  assert.deepEqual(missingPlaybookTitleIndexes(steps), [0, 2]);
  assert.equal(formatStepList([0, 2]), "01, 03");
  assert.equal(formatStepList([0, 1, 2, 3, 4]), "01, 02, 03, 04 +1 more");
});

test("Agent editor run-result and approval-risk helpers preserve compatibility", () => {
  const run = { id: "run-1" };
  assert.equal(runFromAgentResult({ run } as never), run);
  assert.equal(runFromAgentResult({ approval: { id: "approval-1" } } as never), null);
  assert.equal(isApprovalResult({ approval: { id: "approval-1" } } as never), true);
  assert.equal(riskForApprovalTool({ side: "exec" } as never), "high");
  assert.equal(riskForApprovalTool({ side: "write" } as never), "medium");
  assert.equal(riskForApprovalTool({ side: "read" } as never), "low");
});
