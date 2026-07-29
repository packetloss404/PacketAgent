import assert from "node:assert/strict";
import test from "node:test";
import { buildGeneratedAppPublishRecord } from "./app-publish-history";
import { buildBuilderPublishDashboard } from "./builder-publish-dashboard";

test("builder publish dashboard is deterministic and composes preview and production URLs", () => {
  const input = {
    appName: "Release Desk",
    workspaceSlug: "Ops Team",
    previewUrl: "/builder/preview/ops/release-desk",
    visibility: "public" as const,
    publicBaseUrl: "https://apps.example.test",
    privateBaseUrl: "http://localhost:8484",
    runtimeEnv: {
      NODE_ENV: "production",
      PORT: "8484",
      PACKETAGENT_PUBLISH_ROOT: "data/published-apps",
      PACKETAGENT_STORE: "sqlite",
    },
    validation: {
      build: { phase: "passed" as const },
      artifacts: {
        expectedArtifacts: ["web/dist", "data/published-apps/ops-team/release-desk/bundle"],
        manifestPath: "data/published-apps/ops-team/release-desk/publish-artifacts.json",
        artifacts: [
          { path: "web/dist", kind: "build_output" as const, source: "build" as const },
          {
            path: "data/published-apps/ops-team/release-desk/bundle",
            kind: "generated_bundle" as const,
            source: "generated_draft" as const,
            bytes: 4096,
          },
        ],
      },
      health: {
        live: { statusCode: 200, bodyStatus: "live" },
        ready: { statusCode: 200, bodyStatus: "ready" },
      },
      smoke: {
        checks: [{ id: "page:/", label: "Open home", status: "pass" as const }],
      },
    },
  };

  const first = buildBuilderPublishDashboard(input);
  const second = buildBuilderPublishDashboard(input);

  assert.deepEqual(first, second);
  assert.equal(first.version, "phase-72-lane-5");
  assert.equal(first.status, "ready");
  assert.equal(first.canPublishProduction, true);
  assert.equal(first.urls.preview.url, "/builder/preview/ops/release-desk");
  assert.equal(first.urls.preview.visibility, "private");
  assert.equal(first.urls.production.url, "https://apps.example.test/ops-team/release-desk");
  assert.equal(first.urls.production.status, "available");
  assert.equal(first.validation.validatedUrl.status, "valid");
  assert.deepEqual(
    first.nextActions.map((action) => action.kind),
    ["publish"],
  );
});

test("builder publish dashboard reports required env and validation blockers as next actions", () => {
  const dashboard = buildBuilderPublishDashboard({
    appName: "Revenue Desk",
    workspaceSlug: "Ops",
    requiredEnv: ["OPENAI_API_KEY"],
    runtimeEnv: {
      NODE_ENV: "production",
      PORT: "8484",
      PACKETAGENT_PUBLISH_ROOT: "data/published-apps",
      PACKETAGENT_STORE: "sqlite",
      OPENAI_API_KEY: "",
    },
    validation: {
      build: {
        exitCode: 1,
        output: "failed with authorization=Bearer secret-token",
      },
      health: {
        live: { statusCode: 200, bodyStatus: "live" },
        ready: { statusCode: 503, bodyStatus: "not_ready" },
      },
      smoke: {
        checks: [{ id: "page:/", label: "Open home", status: "pending" }],
      },
    },
  });

  assert.equal(dashboard.status, "blocked");
  assert.equal(dashboard.canPublishProduction, false);
  assert.equal(dashboard.environmentStatus.status, "blocked");
  assert.deepEqual(dashboard.environmentStatus.missingRequired, ["OPENAI_API_KEY"]);
  assert.deepEqual(
    dashboard.nextActions.slice(0, 3).map((action) => action.kind),
    ["configure_env", "configure_integrations", "run_build"],
  );
  assert.ok(dashboard.nextActions.some((action) => action.kind === "run_health" && action.blocked));
  assert.equal(JSON.stringify(dashboard).includes("secret-token"), false);
  assert.match(dashboard.validation.productionBuild.message, /authorization=\[redacted\]/);
});

test("builder publish dashboard summarizes integration readiness without blocking package publish", () => {
  const dashboard = buildBuilderPublishDashboard({
    appName: "Customer Portal",
    workspaceSlug: "Northwind",
    draft: {
      summary: "Send Stripe payment receipts over email and sync GitHub issues.",
    },
    connectedConnectors: ["github"],
    runtimeEnv: {
      NODE_ENV: "production",
      PORT: "8484",
      PACKETAGENT_PUBLISH_ROOT: "data/published-apps",
      PACKETAGENT_STORE: "sqlite",
    },
    validation: {
      build: { phase: "passed" },
      health: {
        live: { statusCode: 200, bodyStatus: "live" },
        ready: { statusCode: 200, bodyStatus: "ready" },
      },
      smoke: {
        checks: [{ id: "page:/", label: "Open home", status: "pass" }],
      },
    },
  });

  assert.equal(dashboard.status, "blocked");
  assert.equal(dashboard.canPublishProduction, false);
  assert.equal(dashboard.integrationSummary.canPublish, true);
  assert.equal(dashboard.integrationSummary.canUseAllRequestedIntegrations, false);
  assert.ok(dashboard.integrationSummary.blocked >= 2);
  assert.ok(
    dashboard.integrationSummary.featureBlockers.some((blocker) =>
      blocker.includes("Email delivery"),
    ),
  );
  assert.ok(
    dashboard.integrationSummary.featureBlockers.some((blocker) =>
      blocker.includes("Stripe payments"),
    ),
  );
  assert.equal(
    dashboard.integrationSummary.featureBlockers.some((blocker) =>
      blocker.includes("GitHub repository actions"),
    ),
    false,
  );
  assert.ok(
    dashboard.nextActions.some(
      (action) =>
        action.kind === "configure_integrations" &&
        action.blocked &&
        action.detail.includes("Stripe payments"),
    ),
  );
});

test("builder publish dashboard orders history, redacts logs, and exposes rollback target", () => {
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
    buildStatus: "failed",
    smokeStatus: "fail",
    previousPublish: older,
    createdByUserId: "user_alpha",
    createdAt: "2026-05-03T19:00:00.000Z",
  });
  newer.logs = [
    ...newer.logs,
    {
      at: "2026-05-03T19:01:00.000Z",
      level: "error",
      message: "Deploy failed with token=super-secret-token",
    },
  ];

  const dashboard = buildBuilderPublishDashboard({
    appName: "Booking App",
    workspaceSlug: "alpha",
    publishHistory: [older, newer],
    currentPublishId: newer.id,
    previousPublishId: older.id,
    maxLogEntries: 3,
  });

  assert.deepEqual(
    dashboard.publishHistory.map((publish) => publish.id),
    [newer.id, older.id],
  );
  assert.equal(dashboard.currentPublish?.id, newer.id);
  assert.equal(dashboard.rollback.available, true);
  assert.equal(dashboard.rollback.targetPublishId, older.id);
  assert.match(
    dashboard.rollback.command ?? "",
    new RegExp(`--to-publish=${older.id}|--to ${older.id}`),
  );
  assert.equal(dashboard.logs.length, 3);
  assert.equal(dashboard.logs[0]?.publishId, newer.id);
  assert.match(dashboard.logs[0]?.message ?? "", /token=\[redacted\]/);
  assert.equal(JSON.stringify(dashboard.logs).includes("super-secret-token"), false);
  assert.ok(dashboard.nextActions.some((action) => action.kind === "rollback" && !action.blocked));
});

test("builder publish dashboard falls back to pending private production handoff", () => {
  const dashboard = buildBuilderPublishDashboard();

  assert.equal(dashboard.status, "pending");
  assert.equal(dashboard.urls.preview.url, "/builder/preview/workspace/generated-app");
  assert.equal(dashboard.urls.production.url, "http://localhost:8484/app/workspace/generated-app");
  assert.equal(dashboard.urls.production.visibility, "private");
  assert.equal(dashboard.urls.production.status, "pending");
  assert.equal(dashboard.rollback.available, false);
  assert.deepEqual(
    dashboard.nextActions.map((action) => action.kind),
    ["configure_env", "run_build", "run_health", "run_smoke", "validate_url"],
  );
});
