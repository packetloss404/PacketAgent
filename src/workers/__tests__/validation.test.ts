import assert from "node:assert/strict";
import test from "node:test";
import {
  assertValidWorkerCheckpoint,
  assertValidWorkerDefinition,
  assertValidWorkerDeployment,
  assertValidWorkerPolicy,
  assertValidWorkerRun,
  assertValidWorkerTrigger,
  assertValidWorkerVersion,
  validateWorkerRecordSet,
  validateWorkerPolicy,
  validateWorkerRun,
  validateWorkerTrigger,
  validateWorkerVersion,
  WorkerContractValidationError,
} from "../validation.js";
import {
  makeWorkerCheckpoint,
  makeWorkerDefinition,
  makeWorkerDeployment,
  makeWorkerRun,
  makeWorkerVersion,
  makeWorkerVersionContent,
} from "./fixtures.js";

test("all seven canonical Worker schemas accept valid records", () => {
  const definition = makeWorkerDefinition();
  const version = makeWorkerVersion();
  const deployment = makeWorkerDeployment();
  const trigger = version.content.triggers[0];
  const policy = version.content.policy;
  const run = makeWorkerRun();
  const checkpoint = makeWorkerCheckpoint();

  assert.doesNotThrow(() => assertValidWorkerDefinition(definition));
  assert.doesNotThrow(() => assertValidWorkerVersion(version));
  assert.doesNotThrow(() => assertValidWorkerDeployment(deployment));
  assert.doesNotThrow(() => assertValidWorkerTrigger(trigger));
  assert.doesNotThrow(() => assertValidWorkerPolicy(policy, version.content.tools));
  assert.doesNotThrow(() => assertValidWorkerRun(run));
  assert.doesNotThrow(() => assertValidWorkerCheckpoint(checkpoint));
});

test("WorkerPolicy rejects every missing required bound", () => {
  const boundNames = [
    "maxElapsedMs",
    "maxIterations",
    "maxProviderCostUsd",
    "maxConsecutiveFailures",
    "maxToolCalls",
  ];

  for (const boundName of boundNames) {
    const content = structuredClone(makeWorkerVersionContent());
    const budgets = content.policy.budgets as unknown as Record<string, unknown>;
    delete budgets[boundName];
    const version = makeWorkerVersion({ content });
    const result = validateWorkerVersion(version);
    assert.equal(result.ok, false, `${boundName} should be required`);
    if (!result.ok) {
      assert.ok(
        result.issues.some((entry) => entry.path === `$.content.policy.budgets.${boundName}`),
      );
    }
  }
});

test("WorkerPolicy rejects zero and unbounded limits", () => {
  const content = makeWorkerVersionContent({
    policy: {
      ...makeWorkerVersionContent().policy,
      budgets: {
        maxElapsedMs: 0,
        maxIterations: Number.POSITIVE_INFINITY,
        maxProviderCostUsd: 0,
        maxConsecutiveFailures: 0,
        maxToolCalls: 0,
      },
    },
  });
  const result = validateWorkerVersion({ ...makeWorkerVersion(), content });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.issues.filter((entry) => entry.path.startsWith("$.content.policy.budgets.")).length >=
        5,
    );
  }
});

test("WorkerPolicy validates explicit rolling ceilings and accepts legacy omission", () => {
  const legacyContent = structuredClone(makeWorkerVersionContent());
  delete (legacyContent.policy.budgets as { rolling?: unknown }).rolling;
  assert.equal(validateWorkerVersion(makeWorkerVersion({ content: legacyContent })).ok, true);

  const content = structuredClone(makeWorkerVersionContent());
  const mutableBudgets = content.policy.budgets as unknown as {
    rolling: typeof content.policy.budgets.rolling;
  };
  mutableBudgets.rolling = {
    windowMs: 0,
    workspace: {
      maxProviderCostUsd: Number.POSITIVE_INFINITY,
      maxBillableActions: 0,
    },
    deployment: {
      maxProviderCostUsd: 0,
      maxBillableActions: 0,
    },
  };
  const result = validateWorkerPolicy(content.policy, content.tools);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(
      result.issues.filter((entry) =>
        entry.path.startsWith("$.budgets.rolling"),
      ).length,
      5,
    );
  }
});

test("WorkerPolicy requires a bounded explicit attention expiration policy", () => {
  const missing = structuredClone(makeWorkerVersionContent());
  delete (missing.policy as { attention?: unknown }).attention;
  const missingResult = validateWorkerVersion(
    makeWorkerVersion({ content: missing }),
  );
  assert.equal(missingResult.ok, false);

  const invalid = structuredClone(makeWorkerVersionContent());
  const mutableAttention = invalid.policy.attention as {
    approvalTimeoutMs: number;
    escalationAfterMs?: number;
  };
  mutableAttention.approvalTimeoutMs = 10_000;
  mutableAttention.escalationAfterMs = 10_000;
  const invalidResult = validateWorkerVersion(
    makeWorkerVersion({ content: invalid }),
  );
  assert.equal(invalidResult.ok, false);
  if (!invalidResult.ok) {
    assert.ok(
      invalidResult.issues.some(
        (issue) => issue.code === "attention.escalation_order",
      ),
    );
  }
});

test("WorkerTrigger rejects ambiguous kind-specific fields", () => {
  const result = validateWorkerTrigger({
    id: "mixed-trigger",
    kind: "cron",
    enabled: true,
    expression: "0 9 * * 1-5",
    timezone: "UTC",
    webhookRef: "webhook:unexpected",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(
      result.issues.map((entry) => entry.path),
      ["$.webhookRef"],
    );
    assert.equal(result.issues[0].code, "object.unexpected_field");
  }
});

test("WorkerTrigger rejects invalid cron expressions and timezones", () => {
  const result = validateWorkerTrigger({
    id: "cron-trigger",
    kind: "cron",
    enabled: true,
    expression: "not cron",
    timezone: "Mars/Olympus_Mons",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((entry) => entry.code === "trigger.cron"));
    assert.ok(result.issues.some((entry) => entry.code === "trigger.timezone"));
  }
});

test("WorkerVersion verifies its canonical content digest", () => {
  const result = validateWorkerVersion(
    makeWorkerVersion({ contentDigest: "sha256:not-the-content" }),
  );
  assert.equal(result.ok, false);
  if (!result.ok)
    assert.ok(result.issues.some((entry) => entry.code === "version.digest_mismatch"));
});

test("validated WorkerVersion rejects capabilities that cannot compile", () => {
  const content = makeWorkerVersionContent({
    tools: [
      {
        ...makeWorkerVersionContent().tools[0],
        verbs: ["TRACE"],
      },
    ],
  });
  const result = validateWorkerVersion(
    makeWorkerVersion({
      status: "validated",
      content,
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((entry) => entry.code === "capability.unknown_verb"));
  }
});

test("PacketADE provenance records supplied source coordinates", () => {
  const version = makeWorkerVersion({
    source: {
      product: "PacketADE",
      kind: "packetade",
      sourceId: "package-1",
      flightId: "flight-1",
      projectId: "project-1",
      conversationId: "conversation-1",
      repository: "https://github.com/example/packet.git",
      revision: "abc123",
    },
  });
  assert.doesNotThrow(() => assertValidWorkerVersion(version));
  assert.equal(version.source.flightId, "flight-1");
  assert.equal(version.source.projectId, "project-1");
  assert.equal(version.source.conversationId, "conversation-1");
  assert.equal(version.source.repository, "https://github.com/example/packet.git");
  assert.equal(version.source.revision, "abc123");
});

test("source revision requires a repository identity", () => {
  const result = validateWorkerVersion(
    makeWorkerVersion({
      source: {
        product: "PacketADE",
        kind: "packetade",
        revision: "abc123",
      },
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok)
    assert.ok(result.issues.some((entry) => entry.code === "provenance.repository_required"));
});

test("terminal WorkerRun requires a matching reason and completion timestamp", () => {
  const invalid = {
    ...makeWorkerRun({ status: "failed" }),
    terminalReason: "objective_satisfied",
    completedAt: undefined,
  };
  const result = validateWorkerRun(invalid);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((entry) => entry.code === "run.terminal_reason_mismatch"));
    assert.ok(result.issues.some((entry) => entry.code === "run.completed_at_required"));
  }
});

test("WorkerRun rejects ambiguous inline and referenced inputs", () => {
  const result = validateWorkerRun(makeWorkerRun({ inputReference: "artifact:input-1" }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.issues.some((entry) => entry.code === "run.ambiguous_input"));
});

test("record-set validation pins deployments, runs, and checkpoints to one version", () => {
  const definition = makeWorkerDefinition();
  const version = makeWorkerVersion({ status: "validated" });
  const deployment = makeWorkerDeployment({ status: "deployed" });
  const run = makeWorkerRun({ status: "running" });
  const checkpoint = makeWorkerCheckpoint();

  assert.deepEqual(
    validateWorkerRecordSet({
      definition,
      versions: [version],
      deployments: [deployment],
      runs: [run],
      checkpoints: [checkpoint],
    }),
    [],
  );

  const issues = validateWorkerRecordSet({
    definition,
    versions: [version],
    deployments: [deployment],
    runs: [{ ...run, workerVersionId: "worker-version-2" }],
    checkpoints: [checkpoint],
  });
  assert.ok(issues.some((entry) => entry.code === "run.version_pin"));
  assert.ok(issues.some((entry) => entry.code === "checkpoint.version_pin"));
});

test("draft deployments may reference drafts, but validated or deployed records may not", () => {
  const definition = makeWorkerDefinition();
  const version = makeWorkerVersion();
  assert.deepEqual(
    validateWorkerRecordSet({
      definition,
      versions: [version],
      deployments: [makeWorkerDeployment()],
    }),
    [],
  );

  const issues = validateWorkerRecordSet({
    definition,
    versions: [version],
    deployments: [makeWorkerDeployment({ status: "deployed" })],
  });
  assert.ok(issues.some((entry) => entry.code === "deployment.version_not_validated"));
});

test("assertion helpers expose path-addressable validation issues", () => {
  assert.throws(
    () => assertValidWorkerVersion({}),
    (error: unknown) => {
      assert.ok(error instanceof WorkerContractValidationError);
      assert.ok(error.issues.some((entry) => entry.path === "$.schemaVersion"));
      return true;
    },
  );
});
