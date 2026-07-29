import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGeneratedAppPublishRecord,
  buildGeneratedAppPublishRollbackResult,
  createGeneratedAppPublishRollbackCommand,
  orderGeneratedAppPublishHistory,
} from "./app-publish-history";

test("generated app publish records include local hosting metadata and compose payload", () => {
  const publish = buildGeneratedAppPublishRecord({
    workspaceId: "alpha",
    workspaceSlug: "Alpha Workspace",
    appId: "gapp_booking",
    appName: "Booking App",
    checkpointId: "ckpt_1",
    previewUrl: "/builder/preview/alpha/booking-app",
    buildStatus: "passed",
    smokeStatus: "pass",
    visibility: "public",
    localPublishRoot: "exports\\packetagent",
    publicBaseUrl: "https://apps.example.test/",
    privateBaseUrl: "http://localhost:8484/",
    createdByUserId: "user_alpha",
    createdAt: "2026-05-03T18:00:00.000Z",
  });

  assert.match(publish.id, /^gapp_publish_[a-f0-9]{16}$/);
  assert.equal(publish.status, "published");
  assert.equal(publish.visibility, "public");
  assert.equal(publish.localPublishPath, "exports/packetagent/alpha-workspace/booking-app");
  assert.equal(publish.workspacePath, "exports/packetagent/alpha-workspace/booking-app");
  assert.equal(publish.publicUrl, "https://apps.example.test/alpha-workspace/booking-app");
  assert.equal(publish.privateUrl, "http://localhost:8484");
  assert.equal(publish.dockerComposeExport.fileName, "docker-compose.publish.yml");
  assert.equal(publish.dockerComposeExport.version, "compose-spec");
  assert.deepEqual(publish.dockerComposeExport.services, ["generated-app"]);
  assert.match(publish.dockerComposeExport.yaml, /generated-app:/);
  assert.equal(publish.dockerComposeExport.yaml.includes("packetagent-db"), false);
  assert.equal(
    publish.dockerComposeExport.bundlePath,
    "exports/packetagent/alpha-workspace/booking-app/bundle",
  );
  assert.equal(
    publish.dockerComposeExport.manifestPath,
    "exports/packetagent/alpha-workspace/booking-app/publish-artifacts.json",
  );
  assert.match(publish.dockerComposeExport.yaml, /generated-app-data:\/app\/data/);
  assert.match(publish.dockerComposeExport.yaml, /read_only: true/);
  assert.ok(
    publish.dockerComposeExport.instructions.some((step) =>
      step.includes("standalone generated app"),
    ),
  );
  assert.equal(publish.artifactManifest.fileName, "publish-artifacts.json");
  assert.equal(publish.manifest.fileName, "publish-artifacts.json");
  assert.ok(
    publish.artifactManifest.entries.some(
      (entry) => entry.kind === "generated_bundle" && entry.path.endsWith("/bundle"),
    ),
  );
  assert.ok(publish.artifactPaths.some((path) => path.endsWith("publish-artifacts.json")));
  assert.ok(publish.logs.some((entry) => entry.message.includes("Published artifact manifest")));
});

test("second publish keeps previous publish rollback command and result shape", () => {
  const first = buildGeneratedAppPublishRecord({
    workspaceId: "alpha",
    appId: "gapp_booking",
    appName: "Booking App",
    checkpointId: "ckpt_1",
    buildStatus: "passed",
    smokeStatus: "pass",
    createdByUserId: "user_alpha",
    createdAt: "2026-05-03T18:00:00.000Z",
  });
  const second = buildGeneratedAppPublishRecord({
    workspaceId: "alpha",
    appId: "gapp_booking",
    appName: "Booking App",
    checkpointId: "ckpt_2",
    buildStatus: "passed",
    smokeStatus: "pass",
    previousPublish: first,
    createdByUserId: "user_alpha",
    createdAt: "2026-05-03T19:00:00.000Z",
  });

  assert.equal(second.previousPublishId, first.id);
  assert.equal(second.rollbackCommand?.kind, "generated-app-publish-rollback");
  assert.equal(second.rollbackCommand?.fromPublishId, second.id);
  assert.equal(second.rollbackCommand?.toPublishId, first.id);
  assert.match(second.rollbackCommand?.command ?? "", /packetagent publish rollback/);

  const command = createGeneratedAppPublishRollbackCommand({
    current: second,
    target: first,
    reason: "test",
  });
  const result = buildGeneratedAppPublishRollbackResult({
    command,
    status: "succeeded",
    completedAt: "2026-05-03T19:05:00.000Z",
  });

  assert.equal(result.kind, "generated-app-publish-rollback-result");
  assert.equal(result.rolledBack, true);
  assert.equal(result.restoredPublishId, first.id);
  assert.equal(result.supersededPublishId, second.id);
  assert.match(result.message, /Rolled publish target back/);
});

test("publish history orders newest first", () => {
  const older = buildGeneratedAppPublishRecord({
    workspaceId: "alpha",
    appId: "gapp_booking",
    appName: "Booking App",
    checkpointId: "ckpt_1",
    buildStatus: "passed",
    smokeStatus: "pass",
    createdByUserId: "user_alpha",
    createdAt: "2026-05-03T18:00:00.000Z",
  });
  const newer = buildGeneratedAppPublishRecord({
    workspaceId: "alpha",
    appId: "gapp_booking",
    appName: "Booking App",
    checkpointId: "ckpt_2",
    buildStatus: "passed",
    smokeStatus: "pass",
    createdByUserId: "user_alpha",
    createdAt: "2026-05-03T19:00:00.000Z",
  });

  assert.deepEqual(
    orderGeneratedAppPublishHistory([older, newer]).map((entry) => entry.id),
    [newer.id, older.id],
  );
});
