import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAppPreviewPublishHandoffReadiness,
  buildAppPreviewRollbackResult,
  buildAppPreviewSnapshotMetadata,
  compareAppPreviewSnapshots,
  createAppPreviewRollbackCommand,
  orderAppPreviewSnapshotRetention,
} from "./app-preview-snapshots";

test("buildAppPreviewSnapshotMetadata creates deterministic checkpoint-tied metadata", () => {
  const input = {
    workspaceId: "Alpha Team",
    appId: "gapp_booking",
    appName: "Booking Portal",
    checkpointId: "gapp_ckpt_002",
    checkpointSavedAt: "2026-05-03T10:00:00-05:00",
    buildStatus: "success",
    smokeStatus: "passed",
    previewUrl: "http://localhost:5173/builder/preview/alpha/booking",
    generatedFiles: [
      "web/src/generated/Booking.tsx",
      "web/src/generated/Booking.tsx",
      "src/generated/routes.ts",
    ],
    artifactPaths: ["dist/manifest.json", "data/snapshots/booking.json"],
    createdByUserId: "user_alpha",
    source: "builder" as const,
  };

  const first = buildAppPreviewSnapshotMetadata(input);
  const second = buildAppPreviewSnapshotMetadata(input);

  assert.deepEqual(first, second);
  assert.equal(first.version, "phase-69-lane-5");
  assert.equal(first.workspaceId, "alpha-team");
  assert.equal(first.appSlug, "booking-portal");
  assert.equal(first.checkpoint.savedAt, "2026-05-03T15:00:00.000Z");
  assert.equal(first.build.status, "passed");
  assert.equal(first.build.smokeStatus, "pass");
  assert.deepEqual(first.build.generatedFiles, [
    "src/generated/routes.ts",
    "web/src/generated/Booking.tsx",
  ]);
  assert.deepEqual(first.build.artifactPaths, [
    "data/snapshots/booking.json",
    "dist/manifest.json",
  ]);
  assert.equal(first.publishHandoff.ready, true);
});

test("snapshot metadata defaults stable ids and artifact paths when optional fields are omitted", () => {
  const snapshot = buildAppPreviewSnapshotMetadata({
    workspaceId: "Alpha",
    appName: "Ops Board",
    checkpointId: "ckpt-one",
  });

  assert.equal(snapshot.workspaceId, "alpha");
  assert.match(snapshot.appId, /^gapp_[a-f0-9]{12}$/);
  assert.equal(snapshot.checkpoint.id, "ckpt-one");
  assert.equal(snapshot.capturedAt, "1970-01-01T00:00:00.000Z");
  assert.deepEqual(snapshot.build.artifactPaths, [
    "data/generated-apps/alpha/ops-board/checkpoints/ckpt-one/preview-snapshot.json",
  ]);
  assert.equal(snapshot.publishHandoff.ready, false);
  assert.ok(
    snapshot.publishHandoff.blockers.some((blocker) => blocker.includes("Preview build must pass")),
  );
});

test("compareAppPreviewSnapshots classifies new, advanced, regressed, and diverged snapshots", () => {
  const previous = buildAppPreviewSnapshotMetadata({
    workspaceId: "alpha",
    appId: "gapp_crm",
    checkpointId: "ckpt-1",
    capturedAt: "2026-05-03T10:00:00.000Z",
    buildStatus: "failed",
    smokeStatus: "fail",
    previewUrl: "http://localhost:5173/preview/crm",
  });
  const current = buildAppPreviewSnapshotMetadata({
    workspaceId: "alpha",
    appId: "gapp_crm",
    checkpointId: "ckpt-2",
    capturedAt: "2026-05-03T11:00:00.000Z",
    buildStatus: "passed",
    smokeStatus: "pass",
    previewUrl: "http://localhost:5173/preview/crm",
  });
  const regressed = buildAppPreviewSnapshotMetadata({
    workspaceId: "alpha",
    appId: "gapp_crm",
    checkpointId: "ckpt-3",
    capturedAt: "2026-05-03T12:00:00.000Z",
    buildStatus: "passed",
    smokeStatus: "warn",
    previewUrl: "http://localhost:5173/preview/crm",
  });
  const diverged = buildAppPreviewSnapshotMetadata({
    workspaceId: "alpha",
    appId: "gapp_crm",
    checkpointId: "ckpt-2",
    capturedAt: "2026-05-03T11:00:00.000Z",
    buildStatus: "passed",
    smokeStatus: "pass",
    previewUrl: "http://localhost:5173/preview/crm",
    contentHash: "abcdef",
  });

  assert.equal(compareAppPreviewSnapshots(current).relation, "new");

  const advanced = compareAppPreviewSnapshots(current, previous);
  assert.equal(advanced.relation, "advanced");
  assert.equal(advanced.checkpointChanged, true);
  assert.equal(advanced.publishReadinessChanged, true);

  const regression = compareAppPreviewSnapshots(regressed, current);
  assert.equal(regression.relation, "regressed");
  assert.equal(regression.smokeStatusChanged, true);
  assert.match(regression.summary, /rollback target/);

  const divergence = compareAppPreviewSnapshots(diverged, current);
  assert.equal(divergence.relation, "diverged");
  assert.equal(divergence.contentHashChanged, true);
});

test("rollback command and result expose stable command/result shapes", () => {
  const current = buildAppPreviewSnapshotMetadata({
    workspaceId: "alpha",
    appId: "gapp_booking",
    checkpointId: "ckpt-bad",
    buildStatus: "failed",
    smokeStatus: "fail",
    capturedAt: "2026-05-03T12:00:00.000Z",
  });
  const target = buildAppPreviewSnapshotMetadata({
    workspaceId: "alpha",
    appId: "gapp_booking",
    checkpointId: "ckpt-good",
    buildStatus: "passed",
    smokeStatus: "pass",
    previewUrl: "http://localhost:5173/preview/booking",
    capturedAt: "2026-05-03T11:00:00.000Z",
  });

  const command = createAppPreviewRollbackCommand({
    current,
    target,
    requestedByUserId: "user_alpha",
    reason: "new preview smoke failed",
  });

  assert.equal(command.kind, "preview-snapshot-rollback");
  assert.match(command.commandId, /^preview_rollback_[a-f0-9]{16}$/);
  assert.equal(
    command.command,
    "packetagent preview rollback --workspace=alpha --app=gapp_booking --from-checkpoint=ckpt-bad --to-checkpoint=ckpt-good",
  );
  assert.equal(command.requiresConfirmation, true);
  assert.equal(command.expectedResult.restoredCheckpointId, "ckpt-good");
  assert.equal(command.expectedResult.previewUrl, "http://localhost:5173/preview/booking");

  const result = buildAppPreviewRollbackResult({
    command,
    status: "succeeded",
    completedAt: "2026-05-03T12:05:00.000Z",
  });

  assert.equal(result.kind, "preview-snapshot-rollback-result");
  assert.equal(result.status, "succeeded");
  assert.equal(result.rolledBack, true);
  assert.equal(result.restoredCheckpointId, "ckpt-good");
  assert.equal(result.supersededCheckpointId, "ckpt-bad");
  assert.equal(result.completedAt, "2026-05-03T12:05:00.000Z");
  assert.match(result.message, /Rolled preview back/);
});

test("publish handoff readiness blocks incomplete snapshots", () => {
  const snapshot = buildAppPreviewSnapshotMetadata({
    workspaceId: "alpha",
    appId: "gapp_ops",
    checkpointId: "ckpt-ops",
    buildStatus: "passed",
    smokeStatus: "warn",
  });
  const handoff = buildAppPreviewPublishHandoffReadiness(snapshot);

  assert.equal(handoff.ready, false);
  assert.equal(handoff.status, "blocked");
  assert.deepEqual(handoff.blockers, [
    "Smoke checks must pass before publish handoff; current status is warn.",
    "A preview URL is required for reviewer and publish handoff.",
  ]);
  assert.ok(handoff.notes.some((note) => note.includes("publish disabled")));
});

test("retention ordering is newest first and keeps publish-ready snapshots", () => {
  const snapshots = [
    buildAppPreviewSnapshotMetadata({
      workspaceId: "alpha",
      appId: "gapp_ops",
      checkpointId: "ckpt-old-ready",
      capturedAt: "2026-05-03T09:00:00.000Z",
      buildStatus: "passed",
      smokeStatus: "pass",
      previewUrl: "http://localhost:5173/preview/ops",
    }),
    buildAppPreviewSnapshotMetadata({
      workspaceId: "alpha",
      appId: "gapp_ops",
      checkpointId: "ckpt-new-fail",
      capturedAt: "2026-05-03T12:00:00.000Z",
      buildStatus: "failed",
      smokeStatus: "fail",
    }),
    buildAppPreviewSnapshotMetadata({
      workspaceId: "alpha",
      appId: "gapp_ops",
      checkpointId: "ckpt-mid-warn",
      capturedAt: "2026-05-03T11:00:00.000Z",
      buildStatus: "passed",
      smokeStatus: "warn",
      previewUrl: "http://localhost:5173/preview/ops",
    }),
  ];

  const retention = orderAppPreviewSnapshotRetention(snapshots, { keepLatest: 1 });

  assert.deepEqual(
    retention.map((entry) => entry.checkpointId),
    ["ckpt-new-fail", "ckpt-mid-warn", "ckpt-old-ready"],
  );
  assert.deepEqual(
    retention.map((entry) => entry.reason),
    ["latest-1", "outside-retention-window", "publish-ready"],
  );
  assert.deepEqual(
    retention.map((entry) => entry.retain),
    [true, false, true],
  );
  assert.deepEqual(
    retention.map((entry) => entry.retentionRank),
    [1, 2, 3],
  );
});
