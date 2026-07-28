import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentRecord,
  ImplementationPlanItemRecord,
  RequirementRecord,
  ValidationEvidenceRecord,
  WorkflowConcernRecord,
  WorkspaceBriefRecord,
  WorkspaceRecord,
} from "../../packetagent-store.js";
import { projectLegacyAgentToWorker, projectLegacyWorkflowToWorker } from "../projections.js";
import { assertValidWorkerDefinition, assertValidWorkerVersion } from "../validation.js";
import { TEST_LATER, TEST_NOW } from "./fixtures.js";

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-1",
    workspaceId: "workspace-1",
    name: "Release watcher",
    description: "Checks release readiness evidence.",
    instructions: "Review the release evidence and report any blocking gaps.",
    tools: ["http_fetch", "github_api"],
    enabledTools: ["http_fetch", "github_api"],
    routeKey: "smart",
    webhookToken: "secret-webhook-token-that-must-not-project",
    schedule: "0 9 * * 1-5",
    triggerKind: "schedule",
    status: "active",
    createdByUserId: "user-1",
    inputSchema: [
      {
        key: "release_id",
        label: "Release ID",
        type: "string",
        required: true,
      },
    ],
    createdAt: TEST_NOW,
    updatedAt: TEST_LATER,
    ...overrides,
  };
}

test("legacy Agent projection is deterministic, bounded, and remains draft", () => {
  const agent = makeAgent();
  const original = structuredClone(agent);
  const first = projectLegacyAgentToWorker(agent);
  const second = projectLegacyAgentToWorker(agent);

  assert.deepEqual(first, second);
  assert.deepEqual(agent, original, "projection must not mutate the legacy API record");
  assert.equal(first.definition.status, "draft");
  assert.equal(first.version.status, "draft");
  assert.equal(first.version.source.kind, "legacy_agent");
  assert.equal(first.version.source.sourceId, agent.id);
  assert.equal(first.version.content.triggers[0].kind, "cron");
  assert.equal(first.version.content.policy.budgets.maxIterations, 8);
  assert.equal(first.version.content.policy.permissions.default, "deny");
  assert.ok(first.warnings.some((entry) => entry.code === "projection.requires_validation"));
  assert.doesNotThrow(() => assertValidWorkerDefinition(first.definition));
  assert.doesNotThrow(() => assertValidWorkerVersion(first.version));
});

test("legacy projection never carries a webhook token or credential value", () => {
  const projection = projectLegacyAgentToWorker(makeAgent({ triggerKind: "webhook" }));
  const serialized = JSON.stringify(projection);
  assert.equal(serialized.includes("secret-webhook-token-that-must-not-project"), false);
  assert.equal(projection.version.content.credentialRefs.length, 0);
  assert.equal(projection.version.content.triggers[0].kind, "webhook");
  if (projection.version.content.triggers[0].kind === "webhook") {
    assert.equal(projection.version.content.triggers[0].webhookRef, "legacy-agent:agent-1:webhook");
  }
});

test("legacy email Agent maps to an email-adapted webhook trigger", () => {
  const projection = projectLegacyAgentToWorker(
    makeAgent({
      triggerKind: "email",
      schedule: undefined,
    }),
  );
  const trigger = projection.version.content.triggers[0];
  assert.equal(trigger.kind, "webhook");
  if (trigger.kind === "webhook") {
    assert.equal(trigger.adapter, "email");
    assert.equal(trigger.eventType, "packetagent.legacy.email.received");
  }
});

test("invalid legacy schedule becomes a manual draft with an explicit warning", () => {
  const projection = projectLegacyAgentToWorker(makeAgent({ schedule: "not cron" }));
  assert.equal(projection.version.content.triggers[0].kind, "manual");
  assert.ok(projection.warnings.some((entry) => entry.code === "projection.invalid_schedule"));
  assert.doesNotThrow(() => assertValidWorkerVersion(projection.version));
});

test("legacy whole-tool grants become coarse approval-required capabilities", () => {
  const projection = projectLegacyAgentToWorker(makeAgent());
  assert.deepEqual(
    projection.version.content.tools.map((tool) => ({
      id: tool.id,
      verbs: tool.verbs,
      resources: tool.resources,
      approval: tool.approval,
    })),
    [
      { id: "legacy-tool:http_fetch", verbs: ["execute"], resources: ["*"], approval: "always" },
      { id: "legacy-tool:github_api", verbs: ["execute"], resources: ["*"], approval: "always" },
    ],
  );
  assert.deepEqual(projection.version.content.policy.permissions.allowedCapabilityIds, [
    "legacy-tool:http_fetch",
    "legacy-tool:github_api",
  ]);
  assert.ok(
    projection.warnings.some((entry) => entry.code === "projection.coarse_tool_capabilities"),
  );
});

function makeWorkspace(): WorkspaceRecord {
  return {
    id: "workspace-1",
    slug: "packet",
    name: "Packet",
    website: "https://packet.example.test",
    automationGoal: "Ship safely.",
    createdAt: TEST_NOW,
    updatedAt: TEST_LATER,
  };
}

function makeBrief(): WorkspaceBriefRecord {
  return {
    workspaceId: "workspace-1",
    summary: "Prepare and validate the next Packet release.",
    goals: ["Keep validation evidence attached to the release."],
    desiredOutcome: "Produce a release decision backed by evidence.",
    successMetrics: ["All must-have checks pass", "No critical blocker remains"],
    updatedByUserId: "user-1",
    createdAt: TEST_NOW,
    updatedAt: TEST_LATER,
  };
}

function makeRequirement(): RequirementRecord {
  return {
    id: "requirement-1",
    workspaceId: "workspace-1",
    title: "Run the release gate",
    detail: "Execute the deterministic validation commands.",
    priority: "must",
    status: "approved",
    acceptanceCriteria: ["The test suite passes."],
    createdAt: TEST_NOW,
    updatedAt: TEST_LATER,
  };
}

function makePlanItem(): ImplementationPlanItemRecord {
  return {
    id: "plan-1",
    workspaceId: "workspace-1",
    requirementIds: ["requirement-1"],
    title: "Validate release",
    description: "Run tests and review the resulting evidence.",
    status: "in_progress",
    order: 1,
    startedAt: TEST_NOW,
    createdAt: TEST_NOW,
    updatedAt: TEST_LATER,
  };
}

function makeConcern(): WorkflowConcernRecord {
  return {
    id: "concern-1",
    workspaceId: "workspace-1",
    kind: "blocker",
    title: "Missing approval",
    description: "The final operator approval has not been recorded.",
    status: "open",
    severity: "high",
    createdAt: TEST_NOW,
    updatedAt: TEST_LATER,
  };
}

function makeEvidence(): ValidationEvidenceRecord {
  return {
    id: "evidence-1",
    workspaceId: "workspace-1",
    title: "API tests",
    detail: "The API suite passed.",
    type: "automated_test",
    status: "passed",
    createdAt: TEST_NOW,
    updatedAt: TEST_LATER,
  };
}

test("workspace workflow records project into manual tool-less authoring context", () => {
  const workspace = makeWorkspace();
  const brief = makeBrief();
  const requirement = makeRequirement();
  const planItem = makePlanItem();
  const concern = makeConcern();
  const evidence = makeEvidence();
  const projection = projectLegacyWorkflowToWorker({
    workspace,
    brief,
    requirements: [requirement],
    planItems: [planItem],
    concerns: [concern],
    validationEvidence: [evidence],
  });

  assert.equal(projection.definition.status, "draft");
  assert.equal(projection.version.status, "draft");
  assert.equal(projection.version.source.kind, "legacy_workflow");
  assert.equal(projection.version.content.triggers[0].kind, "manual");
  assert.deepEqual(projection.version.content.tools, []);
  assert.match(projection.version.content.instructions, /Run the release gate/);
  assert.match(projection.version.content.instructions, /Missing approval/);
  assert.match(projection.version.content.instructions, /API tests/);
  assert.ok(
    projection.warnings.some((entry) => entry.code === "projection.workflow_authoring_context"),
  );
  assert.doesNotThrow(() => assertValidWorkerDefinition(projection.definition));
  assert.doesNotThrow(() => assertValidWorkerVersion(projection.version));
});
