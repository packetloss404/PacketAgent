import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAppPublishValidation,
  derivePublishArtifactStatus,
  deriveProductionBuildStatus,
  deriveValidatedPublishUrl,
} from "./app-publish-service";

const READY_ARTIFACTS = {
  expectedArtifacts: ["web/dist", "data/published-apps/alpha/ops-board/bundle"],
  manifestPath: "data/published-apps/alpha/ops-board/publish-artifacts.json",
  artifacts: [
    { path: "web/dist", kind: "build_output" as const, source: "build" as const },
    {
      path: "data/published-apps/alpha/ops-board/bundle",
      kind: "generated_bundle" as const,
      source: "generated_draft" as const,
      bytes: 4096,
    },
  ],
};

test("buildAppPublishValidation marks a self-hosted URL ready when build, health, and smoke pass", () => {
  const validation = buildAppPublishValidation({
    build: {
      phase: "passed",
      command: "npm run build:web",
      expectedArtifacts: ["web/dist", "data/published-apps/alpha/ops-board"],
    },
    artifacts: READY_ARTIFACTS,
    health: {
      live: { statusCode: 200, bodyStatus: "live" },
      ready: { statusCode: 200, bodyStatus: "ready" },
    },
    smoke: {
      checks: [
        { id: "page:/", label: "Open home", status: "pass" },
        { id: "api:get:appointments", label: "GET appointments", status: "pass" },
      ],
    },
    url: {
      baseUrl: "http://localhost:8484",
      path: "/app/alpha/ops-board",
      visibility: "private",
    },
  });

  assert.equal(validation.version, "phase-70-lane-3");
  assert.equal(validation.status, "ready");
  assert.equal(validation.canPublish, true);
  assert.equal(validation.productionBuild.status, "pass");
  assert.equal(validation.artifactPresence.status, "pass");
  assert.equal(validation.healthCheck.status, "pass");
  assert.equal(validation.smokeCheck.status, "pass");
  assert.equal(validation.validatedUrl.status, "valid");
  assert.equal(validation.validatedUrl.url, "http://localhost:8484/app/alpha/ops-board");
  assert.deepEqual(validation.actionableFailures, []);
});

test("publish validation blocks without generated app artifact presence", () => {
  const validation = buildAppPublishValidation({
    build: {
      phase: "passed",
      expectedArtifacts: ["web/dist", "data/published-apps/alpha/missing-app/bundle"],
    },
    artifacts: {
      manifestPath: "data/published-apps/alpha/missing-app/publish-artifacts.json",
      artifacts: [{ path: "web/dist", kind: "build_output", source: "build" }],
    },
    health: {
      live: { statusCode: 200, bodyStatus: "live" },
      ready: { statusCode: 200, bodyStatus: "ready" },
    },
    smoke: {
      checks: [{ id: "page:/", label: "Open home", status: "pass" }],
    },
    url: { url: "http://localhost:8484/app/alpha/missing-app", visibility: "private" },
  });

  assert.equal(validation.canPublish, false);
  assert.equal(validation.status, "blocked");
  assert.equal(validation.artifactPresence.status, "fail");
  assert.deepEqual(validation.artifactPresence.missingArtifacts, [
    "data/published-apps/alpha/missing-app/bundle",
  ]);
  assert.ok(
    validation.actionableFailures.some(
      (failure) =>
        failure.stage === "artifact" && failure.message.includes("No generated app bundle"),
    ),
  );
});

test("production build failures are deterministic, redacted, and actionable", () => {
  const validation = buildAppPublishValidation({
    build: {
      command: "npm run build:web",
      exitCode: 1,
      output: "vite failed authorization=Bearer abc123\nsrc/App.tsx: CalendarWidget is not defined",
    },
    health: {
      live: { statusCode: 200, bodyStatus: "live" },
      ready: { statusCode: 200, bodyStatus: "ready" },
    },
    smoke: {
      checks: [{ id: "page:/", label: "Open home", status: "pass" }],
    },
    url: { url: "http://localhost:8484/app/alpha/calendar", visibility: "private" },
  });

  assert.equal(validation.status, "blocked");
  assert.equal(validation.canPublish, false);
  assert.equal(validation.productionBuild.status, "fail");
  assert.match(validation.productionBuild.message, /authorization=\[redacted\]/);
  assert.doesNotMatch(validation.productionBuild.message, /abc123/);
  assert.equal(validation.validatedUrl.status, "blocked");
  assert.deepEqual(
    validation.actionableFailures.map((failure) => failure.stage),
    ["build", "url"],
  );
  assert.match(validation.actionableFailures[0]?.action ?? "", /npm run build:web/);
});

test("health check failures identify the failing probe and next action", () => {
  const validation = buildAppPublishValidation({
    build: { phase: "passed" },
    artifacts: READY_ARTIFACTS,
    health: {
      live: { path: "/api/health/live", statusCode: 200, bodyStatus: "live" },
      ready: { path: "/api/health/ready", statusCode: 503, bodyStatus: "not_ready" },
    },
    smoke: {
      checks: [{ id: "page:/", label: "Open home", status: "pass" }],
    },
    url: { url: "http://localhost:8484/app/alpha/ops", visibility: "private" },
  });

  assert.equal(validation.status, "blocked");
  assert.equal(validation.healthCheck.status, "fail");
  assert.equal(validation.healthCheck.live.status, "pass");
  assert.equal(validation.healthCheck.ready.status, "fail");
  assert.match(validation.healthCheck.ready.message, /HTTP 503/);
  assert.ok(
    validation.actionableFailures.some(
      (failure) => failure.stage === "health" && failure.action.includes("/api/health/ready"),
    ),
  );
});

test("smoke validation reports failed and pending checks without running external commands", () => {
  const validation = buildAppPublishValidation({
    build: { phase: "passed" },
    artifacts: READY_ARTIFACTS,
    health: {
      live: { statusCode: 200, bodyStatus: "live" },
      ready: { statusCode: 200, bodyStatus: "ready" },
    },
    smoke: {
      requiredCheckCount: 3,
      checks: [
        { id: "page:/settings", label: "Open settings", status: "pending" },
        {
          id: "api:get:accounts",
          label: "GET accounts",
          status: "fail",
          message: "token=secret-value returned 500",
        },
        { id: "page:/", label: "Open home", status: "pass" },
      ],
    },
    url: { url: "http://localhost:8484/app/alpha/crm", visibility: "private" },
  });

  assert.equal(validation.status, "blocked");
  assert.equal(validation.smokeCheck.status, "fail");
  assert.equal(validation.smokeCheck.totalChecks, 3);
  assert.equal(validation.smokeCheck.passedChecks, 1);
  assert.equal(validation.smokeCheck.failedChecks, 1);
  assert.deepEqual(
    validation.smokeCheck.checks.map((check) => check.id),
    ["api:get:accounts", "page:/", "page:/settings"],
  );
  assert.match(
    validation.actionableFailures.find((failure) => failure.stage === "smoke")?.message ?? "",
    /token=\[redacted\]/,
  );
});

test("publish URL validation builds URLs and rejects non-HTTPS public handoff", () => {
  const privateUrl = deriveValidatedPublishUrl(
    { baseUrl: "http://localhost:8484/", path: "app/alpha/booking", visibility: "private" },
    ["pass", "pass", "pass"],
  );
  const nestedBaseUrl = deriveValidatedPublishUrl(
    { baseUrl: "https://publish.example.test/apps/", path: "alpha/booking", visibility: "public" },
    ["pass", "pass", "pass"],
  );
  const publicUrl = deriveValidatedPublishUrl(
    { url: "http://apps.example.test/alpha/booking", visibility: "public" },
    ["pass", "pass", "pass"],
  );

  assert.equal(privateUrl.status, "valid");
  assert.equal(privateUrl.url, "http://localhost:8484/app/alpha/booking");
  assert.equal(nestedBaseUrl.status, "valid");
  assert.equal(nestedBaseUrl.url, "https://publish.example.test/apps/alpha/booking");
  assert.equal(publicUrl.status, "invalid");
  assert.match(publicUrl.message, /HTTPS/);
  assert.match(publicUrl.failures[0]?.action ?? "", /TLS/);
});

test("deriveProductionBuildStatus defaults to a pending production build gate", () => {
  const status = deriveProductionBuildStatus();

  assert.equal(status.status, "pending");
  assert.equal(status.phase, "not_run");
  assert.deepEqual(status.expectedArtifacts, ["web/dist"]);
  assert.match(status.failures[0]?.action ?? "", /npm run build:web/);
});

test("derivePublishArtifactStatus records manifest details for concrete bundle handoff", () => {
  const build = deriveProductionBuildStatus({
    phase: "passed",
    expectedArtifacts: ["web/dist", "exports/packetagent/alpha/booking/bundle"],
  });
  const status = derivePublishArtifactStatus(
    {
      manifestPath: "exports/packetagent/alpha/booking/publish-artifacts.json",
      artifacts: [
        {
          path: "exports\\packetagent\\alpha\\booking\\bundle\\",
          kind: "generated_bundle",
          source: "generated_draft",
          bytes: 2048,
        },
        { path: "web/dist", kind: "build_output", source: "build" },
      ],
    },
    build,
  );

  assert.equal(status.status, "pass");
  assert.equal(status.manifestPath, "exports/packetagent/alpha/booking/publish-artifacts.json");
  assert.deepEqual(status.expectedArtifacts, [
    "exports/packetagent/alpha/booking/bundle",
    "web/dist",
  ]);
  assert.equal(
    status.observedArtifacts.find((artifact) => artifact.kind === "generated_bundle")?.bytes,
    2048,
  );
});
