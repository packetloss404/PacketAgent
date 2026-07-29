import assert from "node:assert/strict";
import test from "node:test";
import { buildBuilderSessionMemory, deriveBuilderNextAction } from "./builder-session-memory";

test("buildBuilderSessionMemory captures saved prompt session state deterministically", () => {
  const memory = buildBuilderSessionMemory({
    sessionId: "session_123",
    title: "  Support portal builder  ",
    promptTurns: [
      {
        id: "turn-b",
        role: "assistant",
        content: "I can draft that.",
        createdAt: "2026-05-03T10:01:00.000Z",
      },
      {
        id: "turn-a",
        role: "user",
        content: "Build a support portal with ticket triage.",
        createdAt: "2026-05-03T10:00:00.000Z",
      },
      { id: "empty", role: "user", content: "   ", createdAt: "2026-05-03T10:02:00.000Z" },
    ],
    decisions: [
      {
        id: "decision-private",
        label: "Route privacy",
        value: "private workspace routes",
        status: "accepted",
      },
      { id: "decision-model", label: "Model preset", value: "smart", status: "pending" },
    ],
    projectMemoryFacts: [
      { id: "older", key: "Audience", value: "Support managers", confidence: 0.7 },
      {
        id: "newer",
        key: "audience",
        value: "Support leads and agents",
        confidence: 0.9,
        pinned: true,
      },
      { id: "sla", key: "SLA", value: "Flag tickets older than 24 hours", confidence: 0.8 },
    ],
    candidate: { id: "candidate_1", status: "ready", summary: "Support portal plan" },
  });

  assert.equal(memory.version, "phase-72-lane-1");
  assert.equal(memory.session.id, "session_123");
  assert.equal(memory.session.title, "Support portal builder");
  assert.equal(memory.session.promptTurnCount, 2);
  assert.equal(memory.session.latestTurnId, "turn-b");
  assert.deepEqual(
    memory.promptTurns.map((turn) => turn.id),
    ["turn-a", "turn-b"],
  );
  assert.deepEqual(
    memory.decisions.map((decision) => decision.id),
    ["decision-model", "decision-private"],
  );
  assert.deepEqual(
    memory.projectMemoryFacts.map((fact) => `${fact.key}:${fact.value}`),
    ["audience:Support leads and agents", "SLA:Flag tickets older than 24 hours"],
  );
  assert.equal(memory.nextAction.kind, "review_decisions");
  assert.match(memory.promptContext, /Session: Support portal builder/);
  assert.match(memory.promptContext, /Project memory:/);
  assert.match(memory.promptContext, /Audience|audience/);
});

test("open clarifying questions block regenerate and are capped at three", () => {
  const memory = buildBuilderSessionMemory({
    sessionId: "session_clarify",
    promptTurns: [{ role: "user", content: "Build me a CRM" }],
    clarifyQuestions: [
      { id: "q4", question: "Should records be public?", askedAt: "2026-05-03T10:04:00.000Z" },
      { id: "q2", question: "Which users need access?", askedAt: "2026-05-03T10:02:00.000Z" },
      { id: "q1", question: "What objects should it track?", askedAt: "2026-05-03T10:01:00.000Z" },
      { id: "q3", question: "Do you need Stripe?", askedAt: "2026-05-03T10:03:00.000Z" },
      { id: "answered", question: "What is the name?", answer: "Deal Desk", status: "answered" },
    ],
    regenerateOptions: [{ id: "regen-app", label: "Regenerate app", selected: true }],
    candidate: { status: "needs_clarification" },
  });

  assert.deepEqual(
    memory.clarifyQuestions.map((question) => question.id),
    ["q1", "q2", "q3"],
  );
  assert.equal(memory.nextAction.kind, "answer_clarifications");
  assert.deepEqual(memory.nextAction.blockingQuestionIds, ["q1", "q2", "q3"]);
  assert.deepEqual(memory.nextAction.selectedRegenerateOptionIds, []);
  assert.match(memory.nextAction.guidance, /Collect answers/);
});

test("selected regenerate options guide a scoped regenerate loop", () => {
  const memory = buildBuilderSessionMemory({
    sessionId: "session_regen",
    promptTurns: [{ role: "user", content: "Make a booking app." }],
    regenerateOptions: [
      {
        id: "checks",
        label: "Acceptance checks",
        scope: "acceptance_checks",
        instruction: "Make checks more concrete.",
        selected: true,
      },
      { id: "pages", label: "Page map", scope: "page", instruction: "Try a simpler page map." },
      {
        id: "data",
        label: "Data model",
        scope: "data_model",
        instruction: "Use fewer entities.",
        selected: true,
      },
    ],
    candidate: { id: "candidate_ready", status: "ready" },
  });

  assert.deepEqual(
    memory.regenerateOptions.map((option) => option.id),
    ["checks", "data", "pages"],
  );
  assert.equal(memory.nextAction.kind, "regenerate_candidate");
  assert.deepEqual(memory.nextAction.selectedRegenerateOptionIds, ["checks", "data"]);
  assert.match(memory.promptContext, /checks \[acceptance_checks, selected\]/);
  assert.match(memory.promptContext, /data \[data_model, selected\]/);
});

test("next action covers empty, failed, ready, and applied session states", () => {
  assert.equal(deriveBuilderNextAction().kind, "collect_prompt");

  assert.equal(
    deriveBuilderNextAction({
      promptTurns: [{ id: "turn-1", role: "user", content: "Build a dashboard", kind: "prompt" }],
      candidate: { status: "failed" },
    }).kind,
    "retry_or_regenerate",
  );

  assert.equal(
    deriveBuilderNextAction({
      promptTurns: [{ id: "turn-1", role: "user", content: "Build a dashboard", kind: "prompt" }],
      candidate: { status: "ready" },
    }).kind,
    "approve_or_refine",
  );

  assert.equal(
    deriveBuilderNextAction({
      promptTurns: [{ id: "turn-1", role: "user", content: "Build a dashboard", kind: "prompt" }],
      candidate: { status: "applied" },
    }).kind,
    "continue_iteration",
  );
});

test("missing titles fall back to first user prompt and generated ids", () => {
  const memory = buildBuilderSessionMemory({
    sessionId: "",
    promptTurns: [
      { role: "system", content: "Builder started" },
      { role: "user", content: "Create a lightweight inventory tracker for laptops and monitors." },
    ],
    decisions: [{ value: "Use private pages" }],
    projectMemoryFacts: [{ key: "Primary object", value: "Asset" }],
    clarifyQuestions: [{ question: "Who can archive assets?", answer: "Admins only" }],
    regenerateOptions: [{ instruction: "Try a version with a scanner workflow.", selected: true }],
  });

  assert.equal(memory.session.id, "builder-session");
  assert.equal(
    memory.session.title,
    "Create a lightweight inventory tracker for laptops and monitors.",
  );
  assert.deepEqual(
    memory.promptTurns.map((turn) => turn.id),
    ["turn-1", "turn-2"],
  );
  assert.equal(memory.decisions[0]?.id, "decision-1");
  assert.equal(memory.decisions[0]?.label, "Builder decision");
  assert.equal(memory.projectMemoryFacts[0]?.id, "memory-primary-object");
  assert.equal(memory.clarifyQuestions[0]?.status, "answered");
  assert.equal(memory.regenerateOptions[0]?.label, "Regenerate candidate");
  assert.equal(memory.nextAction.kind, "regenerate_candidate");
});
