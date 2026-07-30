import { redactSensitiveString, redactSensitiveValue } from "../security/redaction.js";
import type {
  AgentEvaluationSpec,
  AgentFirstRunEvaluation,
  AgentRunRecord,
} from "../store/types.js";

const MAX_OUTPUT_CHARS = 2_000;
const MAX_EXPECTATION_CHARS = 1_200;

export interface BuildAgentFirstRunEvaluationInput {
  readonly run: AgentRunRecord;
  readonly expectedInputs: Record<string, string | number | boolean>;
  readonly spec: AgentEvaluationSpec;
  readonly evaluatedAt?: string;
}

export function buildAgentFirstRunEvaluation(
  input: BuildAgentFirstRunEvaluationInput,
): AgentFirstRunEvaluation {
  const expectedInputs = sanitizedInputs(input.expectedInputs);
  const actualInputs = sanitizedInputs(input.run.inputs ?? {});
  const expectedOutput = redactSensitiveString(input.spec.expectedOutput)
    .trim()
    .slice(0, MAX_EXPECTATION_CHARS);
  const requiredTools = uniqueStrings(input.spec.requiredTools);
  const actualToolCalls = (input.run.toolCalls ?? []).map((call) => ({
    name: call.toolName,
    status: call.status,
  }));
  const inputMatch = stableInputJson(expectedInputs) === stableInputJson(actualInputs);
  const runPassed = input.run.status === "success";
  const output = redactSensitiveString(input.run.output ?? "")
    .trim()
    .slice(0, MAX_OUTPUT_CHARS);
  const outputPassed = output.length > 0;
  const missingTools = requiredTools.filter(
    (tool) => !actualToolCalls.some((call) => call.name === tool && call.status === "ok"),
  );
  const toolCallsPassed = missingTools.length === 0;
  const checks: AgentFirstRunEvaluation["checks"] = [
    {
      id: "inputs",
      label: "Expected input example",
      status: inputMatch ? "passed" : "failed",
      note: inputMatch
        ? "The run used the saved input example."
        : "The run inputs differ from the saved input example.",
    },
    {
      id: "run_status",
      label: "Run completed",
      status: runPassed ? "passed" : "failed",
      note: runPassed
        ? "The bounded Agent run completed successfully."
        : `The bounded Agent run ended with status ${input.run.status}.`,
    },
    {
      id: "output",
      label: "Actual output captured",
      status: outputPassed ? "passed" : "failed",
      note: outputPassed
        ? "A non-empty redacted output was captured."
        : "The run did not produce a non-empty output.",
    },
    {
      id: "tool_calls",
      label: "Required tool calls",
      status: toolCallsPassed ? "passed" : "failed",
      note:
        requiredTools.length === 0
          ? "No tool call was required by the evaluation contract."
          : toolCallsPassed
            ? `All required tools completed: ${requiredTools.join(", ")}.`
            : `Required tools did not complete successfully: ${missingTools.join(", ")}.`,
    },
  ];
  const failed = checks.filter((check) => check.status === "failed");
  const notes = [
    ...(failed.length === 0
      ? ["All deterministic first-run checks passed."]
      : failed.map((check) => check.note)),
    ...(expectedOutput
      ? [
          "The expected-output description is operator review context; PacketAgent does not fabricate a semantic score with a second model call.",
        ]
      : []),
  ];

  return {
    schemaVersion: "packetagent.agent-first-run-evaluation/v1",
    kind: "first_run",
    status: failed.length === 0 ? "passed" : "failed",
    expected: {
      inputs: expectedInputs,
      output: expectedOutput,
      toolCalls: requiredTools,
    },
    actual: {
      inputs: actualInputs,
      ...(output ? { output } : {}),
      toolCalls: actualToolCalls,
      runStatus: input.run.status,
      ...(input.run.modelUsed ? { model: input.run.modelUsed } : {}),
    },
    checks,
    notes,
    evaluatedAt: input.evaluatedAt ?? new Date().toISOString(),
  };
}

function sanitizedInputs(
  inputs: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const redacted = redactSensitiveValue(inputs) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(redacted)
      .filter(
        (entry): entry is [string, string | number | boolean] =>
          typeof entry[1] === "string" ||
          typeof entry[1] === "number" ||
          typeof entry[1] === "boolean",
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 24),
    ),
  );
}

function stableInputJson(inputs: Record<string, string | number | boolean>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b))),
  );
}
