import assert from "node:assert/strict";
import test from "node:test";
import { login } from "./packetagent-services";
import { loadStore, resetStoreForTests } from "./packetagent-store";
import { getWorkflowOverview } from "./workflow-service";
import {
  applyWorkflowTemplate,
  generateAndApplyWorkflowDraft,
  generateWorkflowDraftFromPrompt,
  getWorkflowTemplate,
  listWorkflowTemplates,
} from "./workflow-prompt-service";

test("generateWorkflowDraftFromPrompt rejects short prompts", () => {
  assert.throws(() => generateWorkflowDraftFromPrompt("hi"), /at least 8 characters/);
});

test("generateWorkflowDraftFromPrompt extracts brief, requirements, and plan items", () => {
  const draft = generateWorkflowDraftFromPrompt(
    "Build a daily support inbox triage for customer success managers. Classify urgent tickets, draft replies, and notify on-call within 15 minutes.",
  );

  assert.ok(draft.brief.summary.length > 0);
  assert.ok(draft.brief.targetCustomers.length > 0, "should detect customers");
  assert.ok(draft.requirements.length > 0, "should produce requirements");
  assert.ok(draft.planItems.length > 0, "should produce plan items");
  assert.ok(draft.planItems[0].title.length > 0);
  assert.equal(draft.requirements[0].status, "accepted");
  assert.equal(draft.planItems[0].status, "todo");
});

test("generateAndApplyWorkflowDraft writes records and bumps activation facts when apply=true", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });

  const result = await generateAndApplyWorkflowDraft(auth.context, {
    prompt: "Activate new vendors with structured intake, contract validation, and release confirmation for procurement leads.",
    apply: true,
  });

  assert.equal(result.applied, true);
  assert.ok(result.brief, "brief should be persisted");
  assert.ok(result.requirements && result.requirements.length > 0);
  assert.ok(result.planItems && result.planItems.length > 0);

  const overview = getWorkflowOverview(auth.context);
  assert.equal(overview.brief.summary, result.brief?.summary);
  assert.equal(overview.requirements.length, result.requirements?.length);
  assert.equal(overview.planItems.length, result.planItems?.length);

  const facts = loadStore().activationFacts[auth.context.workspace.id];
  assert.ok(facts.briefCapturedAt);
  assert.ok(facts.requirementsDefinedAt);
  assert.ok(facts.planDefinedAt);
});

test("generateAndApplyWorkflowDraft returns draft only when apply=false", async () => {
  resetStoreForTests();
  const auth = login({ email: "beta@packetagent.local", password: "demo12345" });
  const before = getWorkflowOverview(auth.context);

  const result = await generateAndApplyWorkflowDraft(auth.context, {
    prompt: "Triage support requests for the operations team and capture resolution evidence within one hour.",
    apply: false,
  });

  assert.equal(result.applied, false);
  assert.equal(result.brief, undefined);
  assert.equal(result.requirements, undefined);
  assert.equal(result.planItems, undefined);

  const after = getWorkflowOverview(auth.context);
  assert.equal(after.requirements.length, before.requirements.length);
  assert.equal(after.planItems.length, before.planItems.length);
});

test("listWorkflowTemplates and getWorkflowTemplate expose the seed catalog", () => {
  const all = listWorkflowTemplates();
  assert.ok(all.length >= 3, "expect at least three templates");
  for (const template of all) {
    assert.ok(template.id);
    assert.ok(template.name);
    assert.ok(template.requirements.length > 0);
    assert.ok(template.planItems.length > 0);
  }
  assert.ok(getWorkflowTemplate(all[0].id));
  assert.equal(getWorkflowTemplate("does_not_exist"), null);
});

test("applyWorkflowTemplate replaces brief, requirements, and plan items", () => {
  resetStoreForTests();
  const auth = login({ email: "gamma@packetagent.local", password: "demo12345" });

  const result = applyWorkflowTemplate(auth.context, "internal_support_triage");
  assert.equal(result.template.id, "internal_support_triage");
  assert.ok(result.brief.summary.includes("Triage"));
  assert.equal(result.requirements.length, result.template.requirements.length);
  assert.equal(result.planItems.length, result.template.planItems.length);
  for (const item of result.planItems) {
    assert.equal(item.status, "todo");
  }

  const overview = getWorkflowOverview(auth.context);
  assert.equal(overview.requirements.length, result.requirements.length);
  assert.equal(overview.planItems.length, result.planItems.length);
});

test("applyWorkflowTemplate throws for unknown template id", () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  assert.throws(() => applyWorkflowTemplate(auth.context, "unknown_template"), /not found/);
});
