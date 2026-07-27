import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupExpiredSessions,
  repairActivationReadModels,
  recomputeActivationReadModels,
  type StoreJobDeps,
} from "./jobs";
import { snapshotForWorkspace, type PacketAgentData } from "./packetagent-store";

test("recomputeActivationReadModels refreshes activation read models for every workspace", async () => {
  const data = makeStore();
  const result = await recomputeActivationReadModels(makeDeps(data));

  assert.equal(result.processed, 2);
  assert.deepEqual(result.workspaceIds, ["alpha", "beta"]);
  assert.equal(data.activationReadModels.alpha.stage, "definition");
  assert.equal(data.activationReadModels.beta.stage, "blocked");
  assert.ok(data.activationMilestones.alpha.length > 0);
  assert.ok(data.activationMilestones.beta.some((milestone) => milestone.key === "blocked" && milestone.reached));
});

test("cleanupExpiredSessions removes expired and invalid sessions", () => {
  const data = makeStore();
  data.sessions = [
    makeSession("expired", "2026-04-22T10:00:00.000Z"),
    makeSession("active", "2026-04-24T10:00:00.000Z"),
    makeSession("invalid", "not-a-date"),
  ];

  const result = cleanupExpiredSessions(makeDeps(data), { now: "2026-04-23T10:00:00.000Z" });

  assert.equal(result.removed, 2);
  assert.deepEqual(result.removedSessionIds, ["expired", "invalid"]);
  assert.deepEqual(data.sessions.map((session) => session.id), ["active"]);
});

test("snapshotForWorkspace derives activation from durable workflow records before legacy facts", () => {
  const data = makeStore();
  delete data.activationFacts.alpha;
  data.workspaceBriefs = {
    alpha: {
      workspaceId: "alpha",
      summary: "Launch workflow",
      createdAt: "2026-04-20T10:00:00.000Z",
      updatedAt: "2026-04-20T10:00:00.000Z",
    },
  };
  data.requirements = [{
    id: "req_alpha",
    workspaceId: "alpha",
    title: "Requirement",
    priority: "must",
    status: "accepted",
    createdAt: "2026-04-20T11:00:00.000Z",
    updatedAt: "2026-04-20T11:00:00.000Z",
  }];
  data.implementationPlanItems = [{
    id: "plan_alpha",
    workspaceId: "alpha",
    requirementIds: ["req_alpha"],
    title: "Build",
    description: "Build the workflow",
    status: "done",
    order: 0,
    startedAt: "2026-04-21T10:00:00.000Z",
    completedAt: "2026-04-21T12:00:00.000Z",
    createdAt: "2026-04-20T12:00:00.000Z",
    updatedAt: "2026-04-21T12:00:00.000Z",
  }];
  data.validationEvidence = [{
    id: "validation_alpha",
    workspaceId: "alpha",
    type: "automated_test",
    title: "Tests passed",
    status: "passed",
    outcome: "passed",
    capturedAt: "2026-04-21T13:00:00.000Z",
    createdAt: "2026-04-21T13:00:00.000Z",
    updatedAt: "2026-04-21T13:00:00.000Z",
  }];
  data.releaseConfirmations = {
    alpha: {
      id: "release_alpha",
      workspaceId: "alpha",
      confirmed: true,
      status: "confirmed",
      confirmedAt: "2026-04-22T10:00:00.000Z",
      createdAt: "2026-04-22T10:00:00.000Z",
      updatedAt: "2026-04-22T10:00:00.000Z",
    },
  };

  const snapshot = snapshotForWorkspace(data, "alpha");

  assert.equal(snapshot.hasBrief, true);
  assert.equal(snapshot.hasRequirements, true);
  assert.equal(snapshot.hasPlan, true);
  assert.equal(snapshot.hasImplementation, true);
  assert.equal(snapshot.hasTests, true);
  assert.equal(snapshot.hasValidationEvidence, true);
  assert.equal(snapshot.hasReleaseEvidence, true);
  assert.equal(snapshot.releasedAt, "2026-04-22T10:00:00.000Z");
});

test("snapshotForWorkspace maps durable retry and scope-change signals before legacy counters", () => {
  const data = makeStore();
  data.activationFacts.alpha = {
    now: "2026-04-23T10:00:00.000Z",
    retryCount: 5,
    scopeChangeCount: 5,
  };
  data.activationSignals = [
    {
      id: "signal_alpha_retry",
      workspaceId: "alpha",
      kind: "retry",
      source: "agent_run",
      sourceId: "run_alpha_failed",
      createdAt: "2026-04-22T10:00:00.000Z",
      updatedAt: "2026-04-22T10:00:00.000Z",
    },
    {
      id: "signal_alpha_scope",
      workspaceId: "alpha",
      kind: "scope_change",
      source: "workflow",
      createdAt: "2026-04-22T11:00:00.000Z",
      updatedAt: "2026-04-22T11:00:00.000Z",
    },
  ];

  const snapshot = snapshotForWorkspace(data, "alpha");

  assert.equal(snapshot.retryCount, 1);
  assert.equal(snapshot.scopeChangeCount, 1);
});

test("snapshotForWorkspace maps activation retry and scope-change activities as durable signals", () => {
  const data = makeStore();
  delete data.activationFacts.alpha;
  data.activities = [
    {
      id: "activity_retry",
      workspaceId: "alpha",
      scope: "activation",
      event: "agent.run.retry",
      actor: { type: "user", id: "user_alpha" },
      data: { activationSignalKind: "retry" },
      occurredAt: "2026-04-22T10:00:00.000Z",
    },
    {
      id: "activity_scope",
      workspaceId: "alpha",
      scope: "activation",
      event: "workflow.scope_changed",
      actor: { type: "user", id: "user_alpha" },
      data: { activationSignalKind: "scope_change" },
      occurredAt: "2026-04-22T11:00:00.000Z",
    },
  ];

  const snapshot = snapshotForWorkspace(data, "alpha");

  assert.equal(snapshot.retryCount, 1);
  assert.equal(snapshot.scopeChangeCount, 1);
});

test("recomputeActivationReadModels normalizes legacy retry and scope-change counters idempotently", async () => {
  const data = makeStore();
  data.activationFacts.alpha.retryCount = 2;
  data.activationFacts.alpha.scopeChangeCount = 1;

  await recomputeActivationReadModels(makeDeps(data), { workspaceIds: ["alpha"] });
  await recomputeActivationReadModels(makeDeps(data), { workspaceIds: ["alpha"] });

  const signals = data.activationSignals.filter((entry) => entry.workspaceId === "alpha");
  assert.equal(signals.filter((entry) => entry.kind === "retry").length, 2);
  assert.equal(signals.filter((entry) => entry.kind === "scope_change").length, 1);
  assert.equal(signals.every((entry) => entry.source === "user_fact" && entry.origin === "user_entered" && entry.data?.origin === "legacy_fact"), true);
  assert.equal(snapshotForWorkspace(data, "alpha").retryCount, 2);
  assert.equal(snapshotForWorkspace(data, "alpha").scopeChangeCount, 1);
});

test("repairActivationReadModels repairs stale activation read models", async () => {
  const data = makeStore();
  data.activationReadModels.alpha = {
    subject: { workspaceId: "alpha", subjectType: "workspace", subjectId: "alpha" },
    stage: "not_started",
    risk: { score: 5, level: "low", reasons: [] },
    milestones: [],
    checklist: [],
  };

  const result = await repairActivationReadModels(makeDeps(data), { workspaceIds: ["alpha"] });

  assert.equal(result.processed, 1);
  assert.equal(result.repaired, 1);
  assert.deepEqual(result.repairedWorkspaceIds, ["alpha"]);
  assert.equal(data.activationReadModels.alpha.stage, "definition");
});

function makeDeps(data: PacketAgentData): StoreJobDeps {
  return {
    loadStore: () => data,
    mutateStore: (mutator) => mutator(data),
  };
}

function makeStore(): PacketAgentData {
  return {
    users: [],
    sessions: [],
    rateLimits: [],
    workspaces: [
      {
        id: "alpha",
        slug: "alpha",
        name: "Alpha",
        website: "",
        automationGoal: "",
        createdAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:00:00.000Z",
      },
      {
        id: "beta",
        slug: "beta",
        name: "Beta",
        website: "",
        automationGoal: "",
        createdAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:00:00.000Z",
      },
    ],
    memberships: [],
    workspaceBriefs: [],
    workspaceBriefVersions: [],
    requirements: [],
    implementationPlanItems: [],
    workflowConcerns: [],
    validationEvidence: [],
    releaseConfirmations: [],
    onboardingStates: [],
    activities: [],
    activationSignals: [],
    activationFacts: {
      alpha: {
        now: "2026-04-23T10:00:00.000Z",
        briefCapturedAt: "2026-04-20T10:00:00.000Z",
        requirementsDefinedAt: "2026-04-21T10:00:00.000Z",
        planDefinedAt: "2026-04-22T10:00:00.000Z",
      },
      beta: {
        now: "2026-04-23T10:00:00.000Z",
        briefCapturedAt: "2026-04-20T10:00:00.000Z",
        blockerCount: 2,
        criticalIssueCount: 1,
      },
    },
    agents: [],
    providers: [],
    agentRuns: [],
    workspaceEnvVars: [],
    apiKeys: [],
    providerCalls: [],
    jobs: [],
    jobMetricSnapshots: [],
    alertEvents: [],
    shareTokens: [],
    workspaceInvitations: [],
    invitationEmailDeliveries: [],
    activationMilestones: {},
    activationReadModels: {},
  };
}

function makeSession(id: string, expiresAt: string) {
  return {
    id,
    userId: "user_1",
    secretHash: "secret",
    createdAt: "2026-04-20T10:00:00.000Z",
    lastAccessedAt: "2026-04-20T10:00:00.000Z",
    expiresAt,
  };
}
