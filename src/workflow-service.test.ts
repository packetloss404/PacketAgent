import assert from "node:assert/strict";
import test from "node:test";
import { login } from "./packetagent-services";
import { loadStore, resetStoreForTests, snapshotForWorkspace } from "./packetagent-store";
import {
  applyWorkspaceBriefTemplate,
  getWorkflowOverview,
  listWorkspaceBriefHistory,
  listWorkspaceBriefTemplates,
  readWorkspaceBrief,
  replaceBlockersAndQuestions,
  replacePlanItems,
  replaceRequirements,
  replaceValidationEvidence,
  restoreWorkspaceBriefVersion,
  updateReleaseConfirmation,
  updateWorkspaceBrief,
} from "./workflow-service";

test("workflow brief updates workspace brief facts and activity", () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });

  const brief = updateWorkspaceBrief(auth.context, {
    summary: "Ship the roadmap workflow service.",
    targetCustomers: ["Integrators"],
    successMetrics: ["Capture brief", "Validate release"],
  });

  assert.equal(brief.summary, "Ship the roadmap workflow service.");
  assert.deepEqual(brief.successMetrics, ["Capture brief", "Validate release"]);
  assert.equal(readWorkspaceBrief(auth.context).summary, brief.summary);

  const store = loadStore();
  const workspace = store.workspaces.find((entry) => entry.id === auth.context.workspace.id);
  assert.equal(workspace?.automationGoal, brief.summary);
  assert.ok(store.activationFacts[auth.context.workspace.id].briefCapturedAt);
  assert.equal(store.activities[0].event, "workflow.brief_updated");
});

test("workflow surfaces update activation facts and overview", () => {
  resetStoreForTests();
  const auth = login({ email: "beta@packetagent.local", password: "demo12345" });

  replaceRequirements(auth.context, [
    { title: "Track workflow requirements", priority: "must", status: "accepted" },
  ]);
  replacePlanItems(auth.context, [
    { title: "Create service module", status: "done" },
    { title: "Wire routes later", status: "todo" },
  ]);
  replaceBlockersAndQuestions(auth.context, {
    blockers: [{ title: "Await integration route", severity: "high", relatedRequirementId: "req-route" }],
    questions: [{ title: "Which route owns workflow reads?" }],
  });
  replaceValidationEvidence(auth.context, [
    { title: "Service tests pass", outcome: "passed", type: "automated_test", evidenceUrl: "node --test" },
  ]);
  const release = updateReleaseConfirmation(auth.context, {
    confirmed: true,
    summary: "Ready for integration wiring.",
  });

  const overview = getWorkflowOverview(auth.context);
  assert.equal(overview.requirements.length, 1);
  assert.equal(overview.planItems.length, 2);
  assert.equal(overview.blockersAndQuestions.blockers.length, 1);
  assert.equal(overview.validationEvidence[0].outcome, "passed");
  assert.equal(release.status, "confirmed");

  const facts = loadStore().activationFacts[auth.context.workspace.id];
  assert.ok(facts.requirementsDefinedAt);
  assert.ok(facts.planDefinedAt);
  assert.ok(facts.validationPassedAt);
  assert.ok(facts.releaseConfirmedAt);
  assert.equal(facts.blockerCount, 1);
  assert.equal(facts.dependencyBlockerCount, 1);
  assert.equal(facts.openQuestionCount, 1);
});

test("brief saves snapshot a version with manual source", () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });

  updateWorkspaceBrief(auth.context, {
    summary: "First brief draft.",
    goals: ["initial goal"],
  });
  updateWorkspaceBrief(auth.context, {
    summary: "Second brief draft.",
    goals: ["refined goal"],
  });

  const versions = listWorkspaceBriefHistory(auth.context);
  assert.equal(versions.length, 2);
  assert.equal(versions[0].versionNumber, 2);
  assert.equal(versions[0].summary, "Second brief draft.");
  assert.equal(versions[0].source, "manual");
  assert.equal(versions[1].versionNumber, 1);
  assert.equal(versions[1].summary, "First brief draft.");
});

test("brief scope changes emit durable activation signals idempotently by version", () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });

  updateWorkspaceBrief(auth.context, {
    summary: "Ship the roadmap workflow service with a revised scope.",
    goals: ["capture revised scope"],
  });

  const store = loadStore();
  const signals = store.activationSignals.filter((entry) =>
    entry.workspaceId === "alpha" && entry.kind === "scope_change" && entry.source === "workflow"
  );
  const activities = store.activities.filter((entry) =>
    entry.workspaceId === "alpha" && entry.event === "workflow.scope_changed" && entry.data.activationSignalId === signals[0]?.id
  );

  assert.equal(signals.length, 1);
  assert.equal(signals[0].origin, "user_entered");
  assert.ok(signals[0].stableKey);
  assert.equal(activities.length, 1);
  assert.equal(activities[0].data.origin, "user_entered");
  assert.equal(snapshotForWorkspace(store, "alpha").scopeChangeCount, store.activationSignals.filter((entry) => entry.workspaceId === "alpha" && entry.kind === "scope_change").length);
});

test("brief templates populate the brief and snapshot a template version", () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const templates = listWorkspaceBriefTemplates();
  assert.ok(templates.length > 0);

  const template = templates[0];
  const brief = applyWorkspaceBriefTemplate(auth.context, { templateId: template.id });

  assert.equal(brief.summary, template.brief.summary);
  const versions = listWorkspaceBriefHistory(auth.context);
  assert.equal(versions[0].source, "template");
  assert.equal(versions[0].sourceLabel, template.name);
  assert.equal(versions[0].summary, template.brief.summary);

  assert.throws(
    () => applyWorkspaceBriefTemplate(auth.context, { templateId: "nope" }),
    /brief template not found/,
  );
});

test("restoring a brief version updates the brief and adds a restore version", () => {
  resetStoreForTests();
  const auth = login({ email: "beta@packetagent.local", password: "demo12345" });

  updateWorkspaceBrief(auth.context, { summary: "Original brief." });
  updateWorkspaceBrief(auth.context, { summary: "Pivoted brief direction." });
  const history = listWorkspaceBriefHistory(auth.context);
  const original = history.find((entry) => entry.summary === "Original brief.");
  assert.ok(original);

  const restored = restoreWorkspaceBriefVersion(auth.context, { versionId: original!.id });
  assert.equal(restored.summary, "Original brief.");

  const updated = listWorkspaceBriefHistory(auth.context);
  assert.equal(updated[0].source, "restore");
  assert.equal(updated[0].summary, "Original brief.");
  assert.equal(updated.length, 3);

  assert.throws(
    () => restoreWorkspaceBriefVersion(auth.context, { versionId: "missing" }),
    /brief version not found/,
  );
});

test("workflow validation rejects invalid surface input", () => {
  resetStoreForTests();
  const auth = login({ email: "gamma@packetagent.local", password: "demo12345" });

  assert.throws(
    () => updateWorkspaceBrief(auth.context, { summary: "x" }),
    /brief summary must be at least 2 characters/,
  );
  assert.throws(
    () => replaceRequirements(auth.context, [{ title: "ok", priority: "urgent" as never }]),
    /unknown requirement priority/,
  );
});

test("workflow read paths preserve workspace isolation and ordering", () => {
  resetStoreForTests();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const timestamp = new Date().toISOString();
  const store = loadStore();

  store.requirements.unshift({
    id: "req_beta_only_test",
    workspaceId: "beta",
    title: "Beta-only requirement",
    detail: "",
    description: "",
    priority: "must",
    status: "accepted",
    acceptanceCriteria: [],
    source: "team",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  store.requirements.push({
    id: "req_alpha_only_test",
    workspaceId: "alpha",
    title: "Alpha-only requirement",
    detail: "",
    description: "",
    priority: "should",
    status: "proposed",
    acceptanceCriteria: [],
    source: "team",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  store.implementationPlanItems.push(
    {
      id: "plan_alpha_second_test",
      workspaceId: "alpha",
      requirementIds: [],
      title: "Second alpha step",
      description: "",
      status: "todo",
      order: 2,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: "plan_alpha_first_test",
      workspaceId: "alpha",
      requirementIds: [],
      title: "First alpha step",
      description: "",
      status: "todo",
      order: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: "plan_beta_only_test",
      workspaceId: "beta",
      requirementIds: [],
      title: "Beta-only step",
      description: "",
      status: "todo",
      order: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  );
  store.workspaceBriefVersions.push(
    {
      id: "brief_alpha_v1_test",
      workspaceId: "alpha",
      versionNumber: 1,
      summary: "Alpha v1",
      goals: [],
      audience: "",
      constraints: "",
      problemStatement: "",
      targetCustomers: [],
      desiredOutcome: "",
      successMetrics: [],
      source: "manual",
      createdAt: timestamp,
    },
    {
      id: "brief_alpha_v3_test",
      workspaceId: "alpha",
      versionNumber: 3,
      summary: "Alpha v3",
      goals: [],
      audience: "",
      constraints: "",
      problemStatement: "",
      targetCustomers: [],
      desiredOutcome: "",
      successMetrics: [],
      source: "manual",
      createdAt: timestamp,
    },
    {
      id: "brief_beta_v9_test",
      workspaceId: "beta",
      versionNumber: 9,
      summary: "Beta v9",
      goals: [],
      audience: "",
      constraints: "",
      problemStatement: "",
      targetCustomers: [],
      desiredOutcome: "",
      successMetrics: [],
      source: "manual",
      createdAt: timestamp,
    },
  );

  const overview = getWorkflowOverview(alpha.context);
  assert.ok(overview.requirements.some((entry) => entry.id === "req_alpha_only_test"));
  assert.ok(!overview.requirements.some((entry) => entry.workspaceId === "beta"));
  const planIds = overview.planItems.map((entry) => entry.id);
  assert.ok(planIds.indexOf("plan_alpha_first_test") < planIds.indexOf("plan_alpha_second_test"));
  assert.ok(!overview.planItems.some((entry) => entry.workspaceId === "beta"));

  const history = listWorkspaceBriefHistory(alpha.context);
  assert.deepEqual(history.map((entry) => entry.id).slice(0, 2), ["brief_alpha_v3_test", "brief_alpha_v1_test"]);
  assert.ok(!history.some((entry) => entry.workspaceId === "beta"));
});
