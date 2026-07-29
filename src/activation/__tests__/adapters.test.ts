import assert from "node:assert/strict";
import test from "node:test";
import { buildSignalSnapshotFromFacts, buildSignalSnapshotFromProductRecords } from "../adapters";

test("buildSignalSnapshotFromFacts maps timestamps to booleans", () => {
  const snapshot = buildSignalSnapshotFromFacts({
    now: "2026-04-22T10:00:00.000Z",
    briefCapturedAt: "2026-04-20T10:00:00.000Z",
    requirementsDefinedAt: "2026-04-20T12:00:00.000Z",
    planDefinedAt: "2026-04-20T13:00:00.000Z",
    implementationStartedAt: "2026-04-21T08:00:00.000Z",
    testsPassedAt: "2026-04-21T16:00:00.000Z",
  });

  assert.equal(snapshot.hasBrief, true);
  assert.equal(snapshot.hasRequirements, true);
  assert.equal(snapshot.hasPlan, true);
  assert.equal(snapshot.hasImplementation, true);
  assert.equal(snapshot.hasTests, true);
});

test("buildSignalSnapshotFromProductRecords maps durable product records to activation signals", () => {
  const snapshot = buildSignalSnapshotFromProductRecords({
    now: "2026-04-22T10:00:00.000Z",
    brief: {
      id: "brief_1",
      capturedAt: "2026-04-20T10:00:00.000Z",
    },
    requirements: [
      {
        id: "req_1",
        definedAt: "2026-04-20T12:00:00.000Z",
      },
    ],
    plan: {
      id: "plan_1",
      status: "in_progress",
      plannedAt: "2026-04-20T13:00:00.000Z",
      startedAt: "2026-04-21T08:00:00.000Z",
    },
    implementation: {
      id: "impl_1",
      status: "completed",
      startedAt: "2026-04-21T08:00:00.000Z",
      completedAt: "2026-04-21T15:00:00.000Z",
    },
    validationEvidence: [
      {
        id: "validation_1",
        status: "passed",
        evidenceType: "test",
        passedAt: "2026-04-21T16:00:00.000Z",
      },
    ],
    releaseConfirmation: {
      id: "release_1",
      status: "confirmed",
      confirmedAt: "2026-04-22T09:00:00.000Z",
    },
    retries: [{ id: "retry_1", createdAt: "2026-04-21T09:00:00.000Z" }],
    scopeChanges: [{ id: "scope_1", createdAt: "2026-04-21T09:30:00.000Z" }],
  });

  assert.equal(snapshot.createdAt, "2026-04-20T10:00:00.000Z");
  assert.equal(snapshot.startedAt, "2026-04-21T08:00:00.000Z");
  assert.equal(snapshot.completedAt, "2026-04-21T15:00:00.000Z");
  assert.equal(snapshot.releasedAt, "2026-04-22T09:00:00.000Z");
  assert.equal(snapshot.hasBrief, true);
  assert.equal(snapshot.hasRequirements, true);
  assert.equal(snapshot.hasPlan, true);
  assert.equal(snapshot.hasImplementation, true);
  assert.equal(snapshot.hasTests, true);
  assert.equal(snapshot.hasValidationEvidence, true);
  assert.equal(snapshot.hasReleaseEvidence, true);
  assert.equal(snapshot.retryCount, 1);
  assert.equal(snapshot.scopeChangeCount, 1);
});

test("buildSignalSnapshotFromProductRecords counts only unresolved blockers and questions", () => {
  const snapshot = buildSignalSnapshotFromProductRecords({
    now: "2026-04-22T10:00:00.000Z",
    blockers: [
      { id: "blocker_1", status: "open", severity: "critical" },
      { id: "blocker_2", status: "active", dependency: true },
      {
        id: "blocker_3",
        status: "resolved",
        dependency: true,
        resolvedAt: "2026-04-21T10:00:00.000Z",
      },
      { id: "blocker_4", status: "cancelled" },
    ],
    questions: [
      { id: "question_1", status: "open" },
      { id: "question_2", status: "answered" },
    ],
    validationEvidence: [
      {
        id: "validation_1",
        status: "failed",
        severity: "critical",
        failedAt: "2026-04-21T11:00:00.000Z",
      },
      { id: "validation_2", status: "passed", passedAt: "2026-04-21T12:00:00.000Z" },
    ],
  });

  assert.equal(snapshot.blockerCount, 2);
  assert.equal(snapshot.dependencyBlockerCount, 1);
  assert.equal(snapshot.openQuestionCount, 1);
  assert.equal(snapshot.criticalIssueCount, 2);
  assert.equal(snapshot.failedValidationCount, 1);
  assert.equal(snapshot.hasValidationEvidence, true);
});

test("buildSignalSnapshotFromProductRecords ignores pending release confirmation as release evidence", () => {
  const snapshot = buildSignalSnapshotFromProductRecords({
    now: "2026-04-22T10:00:00.000Z",
    releaseConfirmation: {
      id: "release_pending",
      status: "pending",
      createdAt: "2026-04-22T09:00:00.000Z",
    },
  });

  assert.equal(snapshot.releasedAt, undefined);
  assert.equal(snapshot.hasReleaseEvidence, false);
});
