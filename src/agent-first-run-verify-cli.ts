import { buildAgentFirstRunEvaluation } from "./agent-builder/first-run-evaluation.js";
import type { AgentRunRecord } from "./store/types.js";

const timestamp = "2026-07-29T16:00:00.000Z";
const passing = buildAgentFirstRunEvaluation({
  run: agentRun({
    inputs: { release_label: "2026.07" },
    output: "Release evidence reviewed; no blocker was found.",
    toolCalls: [
      {
        id: "call_first_run_verify",
        toolName: "http_fetch",
        input: { url: "https://example.com/evidence" },
        output: { status: 200 },
        durationMs: 8,
        startedAt: timestamp,
        completedAt: timestamp,
        status: "ok",
      },
    ],
    modelUsed: "agent-first-run-verifier-model",
  }),
  expectedInputs: { release_label: "2026.07" },
  spec: {
    expectedOutput: "A concise release blocker summary.",
    requiredTools: ["http_fetch"],
  },
  evaluatedAt: timestamp,
});

const failing = buildAgentFirstRunEvaluation({
  run: agentRun({
    status: "failed",
    inputs: { release_label: "2026.08" },
    output: "",
    toolCalls: [],
  }),
  expectedInputs: { release_label: "2026.07" },
  spec: {
    expectedOutput: "A concise release blocker summary.",
    requiredTools: ["http_fetch"],
  },
  evaluatedAt: timestamp,
});

const verifierSecret = "agent_first_run_verifier_secret_12345";
const redacted = buildAgentFirstRunEvaluation({
  run: agentRun({
    inputs: { api_key: verifierSecret },
    output: `authorization=${verifierSecret}`,
  }),
  expectedInputs: { api_key: verifierSecret },
  spec: {
    expectedOutput: `token=${verifierSecret}`,
    requiredTools: [],
  },
  evaluatedAt: timestamp,
});

const assertions = {
  versionedEvidence:
    passing.schemaVersion === "packetagent.agent-first-run-evaluation/v1" &&
    passing.kind === "first_run",
  savedInputsCompared:
    passing.expected.inputs.release_label === "2026.07" &&
    passing.actual.inputs.release_label === "2026.07" &&
    passing.checks.find((check) => check.id === "inputs")?.status === "passed",
  actualOutputCaptured:
    passing.actual.output === "Release evidence reviewed; no blocker was found." &&
    passing.checks.find((check) => check.id === "output")?.status === "passed",
  requiredToolEvidence:
    passing.expected.toolCalls[0] === "http_fetch" &&
    passing.actual.toolCalls[0]?.name === "http_fetch" &&
    passing.checks.find((check) => check.id === "tool_calls")?.status === "passed",
  deterministicPass:
    passing.status === "passed" && passing.checks.every((check) => check.status === "passed"),
  failuresCloseTheGate:
    failing.status === "failed" && failing.checks.every((check) => check.status === "failed"),
  reviewContextWithoutSecretLeak:
    passing.notes.some((note) => note.includes("does not fabricate a semantic score")) &&
    !JSON.stringify(redacted).includes(verifierSecret) &&
    JSON.stringify(redacted).includes("[redacted]"),
};

const result = {
  ok: Object.values(assertions).every(Boolean),
  assertions,
  passing: {
    status: passing.status,
    checkStatuses: Object.fromEntries(passing.checks.map((check) => [check.id, check.status])),
    model: passing.actual.model,
  },
  failing: {
    status: failing.status,
    checkStatuses: Object.fromEntries(failing.checks.map((check) => [check.id, check.status])),
  },
};
const serialized = JSON.stringify(result, null, 2);
check(!serialized.includes(verifierSecret), "First-run verifier output exposed a secret.");
process.stdout.write(`${serialized}\n`);
if (!result.ok) process.exitCode = 1;

function agentRun(overrides: Partial<AgentRunRecord>): AgentRunRecord {
  return {
    id: "run_agent_first_run_verifier",
    workspaceId: "agent-first-run-verifier",
    agentId: "agent-first-run-verifier",
    title: "Agent first-run verifier",
    status: "success",
    logs: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
