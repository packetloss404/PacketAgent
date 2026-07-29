import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBuilderBetaTimeline,
  renderBuilderBetaTimelineTranscript,
} from "./builder-beta-timeline";

test("builder beta timeline consolidates runtime and preview events in deterministic order", () => {
  const timeline = buildBuilderBetaTimeline({
    appId: "task-board",
    workspaceId: "alpha",
    generatedAt: "2026-05-03T20:00:00.000Z",
    promptTurns: [
      {
        id: "prompt-2",
        at: "2026-05-03T20:00:02.000Z",
        role: "assistant",
        content: "Generated a board with preview smoke coverage.",
      },
      {
        id: "prompt-1",
        at: "2026-05-03T20:00:00.000Z",
        role: "user",
        actor: "ian",
        content: "Build a kanban board.",
      },
    ],
    generationChanges: [
      {
        id: "change-1",
        at: "2026-05-03T20:00:04.000Z",
        changeType: "update",
        summary: "Added generated task board route.",
        filePath: "web/src/generated/TaskBoard.tsx",
        routePath: "board",
        checkpointId: "ckpt_1",
        diffStat: { files: 2.9, additions: 42.4, deletions: 1 },
      },
    ],
    previewResults: [
      {
        id: "preview-1",
        at: "2026-05-03T20:00:05.000Z",
        status: "ready",
        previewUrl: "http://localhost:5173/builder/preview/task-board",
        buildId: "build_1",
      },
    ],
    buildResults: [
      {
        id: "build-1",
        at: "2026-05-03T20:00:05.000Z",
        buildId: "build_1",
        status: "passed",
        durationMs: 1500.8,
      },
    ],
    smokeResults: [
      {
        id: "smoke-1",
        at: "2026-05-03T20:00:06.000Z",
        status: "passed",
        passed: 3,
        failed: 0,
        checkIds: ["page:board", "api:tasks", "page:board"],
      },
    ],
    publishEvents: [
      {
        id: "publish-1",
        at: "2026-05-03T20:00:07.000Z",
        publishId: "pub_1",
        status: "published",
        versionLabel: "publish-2026-05-03",
        publicUrl: "https://apps.example.test/alpha/task-board",
      },
    ],
    integrationChecks: [
      {
        id: "integration-1",
        at: "2026-05-03T20:00:08.000Z",
        provider: "GitHub",
        capability: "issues",
        status: "passed",
      },
    ],
    nextActions: [
      {
        id: "action-1",
        at: "2026-05-03T20:00:09.000Z",
        status: "completed",
        owner: "builder",
        action: "Archive preview evidence.",
      },
    ],
  });

  assert.equal(timeline.kind, "builder-beta-consolidated-timeline");
  assert.equal(timeline.version, "phase-72-lane-3");
  assert.equal(timeline.status, "ready");
  assert.deepEqual(
    timeline.entries.map((entry) => entry.id),
    [
      "prompt-1",
      "prompt-2",
      "change-1",
      "preview-1",
      "build-1",
      "smoke-1",
      "publish-1",
      "integration-1",
      "action-1",
    ],
  );
  assert.deepEqual(
    timeline.entries.map((entry) => entry.order),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.equal(timeline.summary.total, 9);
  assert.equal(timeline.summary.prompts, 2);
  assert.equal(timeline.summary.generationChanges, 1);
  assert.equal(timeline.summary.previewResults, 1);
  assert.equal(timeline.summary.buildResults, 1);
  assert.equal(timeline.summary.smokeResults, 1);
  assert.equal(timeline.summary.publishEvents, 1);
  assert.equal(timeline.summary.integrationChecks, 1);
  assert.equal(timeline.summary.nextActions, 1);
  assert.equal(timeline.entries[2]?.references.routePath, "/board");
  assert.equal(timeline.entries[2]?.details.additions, 42);
  assert.deepEqual(timeline.entries[5]?.details.checkIds, ["api:tasks", "page:board"]);
});

test("builder beta timeline reports blocked failures and redacts transcript secrets", () => {
  const first = buildBuilderBetaTimeline({
    appId: "crm",
    workspaceId: "alpha",
    buildResults: [
      {
        at: "2026-05-03T21:00:00.000Z",
        buildId: "build_9",
        status: "failed",
        message: "Vite failed authorization=Bearer abc123",
        logs: ["api_key=sk-test-123", "Stack line"],
      },
    ],
    previewResults: [
      {
        at: "2026-05-03T21:00:01.000Z",
        status: "blocked",
        buildId: "build_9",
        message: "Preview blocked by build failure.",
      },
    ],
    failures: [
      {
        at: "2026-05-03T21:00:02.000Z",
        source: "build",
        message: "Missing import token=super-secret",
        fingerprint: "fp_build_9",
        filePath: "web/src/generated/Crm.tsx",
        nextActionId: "action-fix-build",
      },
    ],
    nextActions: [
      {
        id: "action-fix-build",
        dueAt: "2026-05-03T22:00:00.000Z",
        action: "Fix missing import before publish.",
      },
    ],
  });
  const second = buildBuilderBetaTimeline({
    appId: "crm",
    workspaceId: "alpha",
    buildResults: [
      {
        at: "2026-05-03T21:00:00.000Z",
        buildId: "build_9",
        status: "failed",
        message: "Vite failed authorization=Bearer abc123",
        logs: "api_key=sk-test-123\nStack line",
      },
    ],
    previewResults: [
      {
        at: "2026-05-03T21:00:01.000Z",
        status: "blocked",
        buildId: "build_9",
        message: "Preview blocked by build failure.",
      },
    ],
    failures: [
      {
        at: "2026-05-03T21:00:02.000Z",
        source: "build",
        message: "Missing import token=super-secret",
        fingerprint: "fp_build_9",
        filePath: "web/src/generated/Crm.tsx",
        nextActionId: "action-fix-build",
      },
    ],
    nextActions: [
      {
        id: "action-fix-build",
        dueAt: "2026-05-03T22:00:00.000Z",
        action: "Fix missing import before publish.",
      },
    ],
  });

  assert.equal(first.status, "blocked");
  assert.equal(first.summary.errors, 3);
  assert.equal(first.summary.openNextActions, 1);
  assert.equal(first.entries[0]?.severity, "error");
  assert.match(first.entries[0]?.summary ?? "", /authorization=\[redacted\]/);
  assert.match(String(first.entries[0]?.details.logExcerpt), /api_key=\[redacted\]/);
  assert.match(first.entries[2]?.summary ?? "", /token=\[redacted\]/);
  assert.equal(first.entries[2]?.references.nextActionId, "action-fix-build");
  assert.deepEqual(
    first.entries.map((entry) => entry.id),
    second.entries.map((entry) => entry.id),
  );
  assert.doesNotMatch(
    renderBuilderBetaTimelineTranscript(first),
    /abc123|sk-test-123|super-secret/,
  );
});

test("builder beta timeline surfaces integration setup and invalid timestamps deterministically", () => {
  const timeline = buildBuilderBetaTimeline({
    appId: "booking",
    generatedAt: "not-a-date",
    integrationChecks: [
      {
        provider: "Stripe",
        status: "passed",
        requiredSetup: ["Configure STRIPE_SECRET_KEY", "Configure STRIPE_SECRET_KEY"],
        message: "Checkout can draft, but secret=local should be configured before publish.",
      },
    ],
    smokeResults: [
      {
        status: "partial",
        passed: 1,
        failed: 0,
        notRun: 2,
      },
    ],
  });

  assert.equal(timeline.generatedAt, "1970-01-01T00:00:00.000Z");
  assert.equal(timeline.status, "attention");
  assert.equal(timeline.summary.warnings, 2);
  assert.equal(timeline.entries[0]?.at, "1970-01-01T00:00:00.000Z");
  assert.equal(timeline.entries[0]?.kind, "smoke_result");
  assert.equal(timeline.entries[0]?.status, "warning");
  assert.equal(timeline.entries[1]?.kind, "integration_check");
  assert.equal(timeline.entries[1]?.references.provider, "Stripe");
  assert.deepEqual(timeline.entries[1]?.details.requiredSetup, ["Configure STRIPE_SECRET_KEY"]);
  assert.match(timeline.entries[1]?.summary ?? "", /secret=\[redacted\]/);
});
