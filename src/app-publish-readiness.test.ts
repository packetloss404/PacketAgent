import assert from "node:assert/strict";
import test from "node:test";
import { buildAppPublishReadiness } from "./app-publish-readiness";

test("app publish readiness package contract is deterministic for the same draft input", () => {
  const input = {
    appName: "Release Audit Console!",
    workspaceSlug: "Alpha Workspace",
    localPublishRoot: "exports\\packetagent",
    publicBaseUrl: "https://publish.example.test/apps/",
    privateBaseUrl: "http://localhost:8484/",
    publishId: "Release Publish 42",
    previousPublishId: "Release Publish 41",
    visibility: "public" as const,
    requiredEnv: ["OPENAI_API_KEY", "DATABASE_URL", "OPENAI_API_KEY"],
    optionalEnv: ["PACKETAGENT_ACCESS_LOG_MODE", "SENTRY_DSN"],
    runtimeEnv: {
      NODE_ENV: "production",
      PORT: "8484",
      OPENAI_API_KEY: "",
    },
  };

  const first = buildAppPublishReadiness(input);
  const second = buildAppPublishReadiness(input);

  assert.deepEqual(first, second);
  assert.equal(first.version, "phase-71-lane-5");
  assert.equal(first.packageContract.version, "phase-71-lane-5");
  assert.equal(first.packageContract.packageId, "alpha-workspace/release-audit-console/app");
  assert.equal(first.packageContract.packageName, "alpha-workspace-release-audit-console");
  assert.equal(first.publishId, "release-publish-42");
  assert.equal(first.publishHistory.previousPublishId, "release-publish-41");
  assert.equal(first.workspaceSlug, "alpha-workspace");
  assert.equal(first.draftSlug, "release-audit-console");
  assert.equal(first.localPublishPath, "exports/packetagent/alpha-workspace/release-audit-console");
  assert.equal(
    first.urlHandoff.publicUrl,
    "https://publish.example.test/apps/alpha-workspace/release-audit-console",
  );
  assert.equal(first.urlHandoff.privateUrl, "http://localhost:8484");
  assert.equal(first.envChecklist.find((item) => item.name === "NODE_ENV")?.configured, true);
  assert.equal(
    first.envChecklist.find((item) => item.name === "OPENAI_API_KEY")?.configured,
    false,
  );
  assert.equal(first.publishIntegrations.version, "phase-71-lane-5");
  assert.ok(
    first.publishIntegrations.featureBlockers.some((blocker) => blocker.includes("OPENAI_API_KEY")),
  );
  assert.match(first.rollback.command, /--to release-publish-41$/);
});

test("app publish readiness captures runtime config and generated checks", () => {
  const readiness = buildAppPublishReadiness({
    appName: "Ops Board",
    workspaceSlug: "Beta",
  });

  assert.equal(readiness.packaging.runtime, "packetagent-generated-app-standalone");
  assert.equal(readiness.runtimeConfig.nodeVersion, "22");
  assert.equal(readiness.runtimeConfig.schemaChangePolicy, "reset-and-reseed");
  assert.equal(readiness.runtimeConfig.appRouteBase, "/");
  assert.equal(readiness.runtimeConfig.agentRouteBase, null);
  assert.equal(
    readiness.runtimeConfig.generatedBundlePath,
    "data/published-apps/beta/ops-board/bundle",
  );
  assert.ok(
    readiness.runtimeAssumptions.some((assumption) => assumption.id === "local-self-hosted-urls"),
  );
  assert.ok(readiness.packaging.notes.some((note) => note.includes("multi-stage image")));
  assert.ok(readiness.packaging.notes.some((note) => note.includes("Vite")));
  assert.ok(readiness.packaging.notes.some((note) => note.includes("destructive reset/reseed")));
  assert.deepEqual(readiness.packaging.buildCommands.slice(0, 2), [
    "docker compose -f data/published-apps/beta/ops-board/docker-compose.publish.yml config --quiet",
    "npm run verify:generated-app-publish -- data/published-apps/beta/ops-board",
  ]);
  assert.ok(
    readiness.packageContract.buildCommands.some((step) => step.id === "verify-standalone-package"),
  );
  assert.equal(readiness.healthCheck.livePath, "/health/live");
  assert.equal(readiness.healthCheck.readyPath, "/health/ready");
  assert.match(readiness.healthCheck.command, /\/health\/ready$/);
  assert.ok(
    readiness.packageContract.healthChecks.every((check) => check.failureAction.length > 0),
  );
  assert.ok(readiness.publishChecklist.some((item) => item.id === "health-ready" && item.required));
  assert.ok(
    readiness.packageContract.smokeChecks.some((check) => check.id === "private-handoff-url"),
  );
  assert.ok(readiness.smokeCheck.expected.some((check) => check.includes("private handoff URL")));
  assert.match(readiness.rollbackNote, /last known-good directory/);
});

test("app publish readiness sorts and deduplicates environment checklist entries", () => {
  const readiness = buildAppPublishReadiness({
    requiredEnv: ["Z_REQUIRED", "DATABASE_URL", "DATABASE_URL"],
    optionalEnv: ["A_OPTIONAL", "PORT", "Z_REQUIRED"],
  });

  const requiredNames = readiness.envChecklist
    .filter((item) => item.required)
    .map((item) => item.name);
  const optionalNames = readiness.envChecklist
    .filter((item) => !item.required)
    .map((item) => item.name);

  assert.deepEqual(requiredNames, ["DATABASE_URL", "NODE_ENV", "PORT", "Z_REQUIRED"]);
  assert.equal(optionalNames.includes("PORT"), false);
  assert.equal(optionalNames.includes("Z_REQUIRED"), false);
  assert.deepEqual(optionalNames, ["A_OPTIONAL", "PACKETAGENT_GENERATED_APP_PORT"]);
});

test("app publish readiness includes publish artifact manifest and docker compose metadata", () => {
  const readiness = buildAppPublishReadiness({
    appName: "Ops Board",
    workspaceSlug: "Beta",
  });

  assert.equal(readiness.publishArtifactManifest.fileName, "publish-artifacts.json");
  assert.equal(readiness.publishArtifactManifest.packageId, "beta/ops-board/app");
  assert.ok(
    readiness.publishArtifactManifest.entries.some((entry) =>
      entry.path.endsWith("/runtime/server.mjs"),
    ),
  );
  assert.ok(
    readiness.publishArtifactManifest.entries.some(
      (entry) =>
        entry.path === "data/published-apps/beta/ops-board/bundle" &&
        entry.kind === "generated_bundle",
    ),
  );
  assert.ok(
    readiness.publishArtifactManifest.entries.some((entry) =>
      entry.path.endsWith("/runtime-config.json"),
    ),
  );
  assert.equal(readiness.dockerComposeExport.fileName, "docker-compose.publish.yml");
  assert.equal(readiness.dockerComposeExport.projectName, "packetagent-beta-ops-board");
  assert.deepEqual(readiness.dockerComposeExport.networks, ["default"]);
  assert.ok(
    readiness.dockerComposeExport.services.some(
      (service) => service.name === "generated-app" && service.healthcheck,
    ),
  );
  assert.equal(
    readiness.dockerComposeExport.services.find((service) => service.name === "generated-app")
      ?.environment?.PORT,
    "8080",
  );
  assert.deepEqual(readiness.dockerComposeExport.volumes, ["generated-app-data"]);
  assert.ok(
    readiness.dockerComposeExport.outline.some((step) =>
      step.includes("data/published-apps/beta/ops-board"),
    ),
  );
});

test("app publish readiness includes lane 1 checklist assumptions and publish history", () => {
  const readiness = buildAppPublishReadiness({
    appName: "Customer Portal",
    workspaceSlug: "Northwind",
    previousPublishId: "Last Good",
    runtimeAssumptions: [
      "The customer portal is routed through an operator-managed reverse proxy.",
    ],
    runtimeEnv: {
      NODE_ENV: "production",
      PORT: "8484",
      PACKETAGENT_STORE: "sqlite",
      PACKETAGENT_PUBLISH_ROOT: "data/published-apps",
    },
  });

  assert.deepEqual(
    readiness.publishChecklist.map((item) => item.id),
    [
      "env-ready",
      "integration-readiness",
      "production-build",
      "health-ready",
      "smoke-passed",
      "compose-exported",
      "history-recorded",
      "rollback-ready",
    ],
  );
  assert.equal(
    readiness.publishChecklist.every((item) => item.required),
    true,
  );
  assert.ok(
    readiness.runtimeAssumptions.some((assumption) => assumption.detail.includes("reverse proxy")),
  );
  assert.equal(readiness.publishHistory.currentPublishId, "northwind-customer-portal-app-publish");
  assert.equal(readiness.publishHistory.previousPublishId, "last-good");
  assert.ok(
    readiness.publishHistory.semantics.some((semantic) => semantic.includes("rollback target")),
  );
  assert.ok(readiness.rollback.restores.includes("last known-good publish bundle"));
  assert.match(
    readiness.rollback.command,
    /packetagent publish rollback --workspace northwind --app customer-portal --to last-good$/,
  );
});

test("app publish readiness includes feature-scoped connector blockers in the publish checklist", () => {
  const readiness = buildAppPublishReadiness({
    appName: "Ops Alerts",
    workspaceSlug: "Ops",
    draft: {
      summary: "Send Stripe payment receipts over email and sync GitHub issues.",
    },
    connectedConnectors: ["github"],
  });

  const integrationItem = readiness.publishChecklist.find(
    (item) => item.id === "integration-readiness",
  );

  assert.equal(readiness.publishIntegrations.canPublish, true);
  assert.equal(readiness.publishIntegrations.canUseAllRequestedIntegrations, false);
  assert.ok(integrationItem);
  assert.equal(integrationItem?.required, true);
  assert.match(integrationItem?.failureGuidance ?? "", /Feature-scoped connector blockers/);
  assert.match(integrationItem?.failureGuidance ?? "", /Email delivery|Stripe payments/);
  assert.equal(
    (integrationItem?.failureGuidance ?? "").includes("GitHub repository actions"),
    false,
  );
});

test("app publish readiness wires runtime env into integration publish checks without leaking values", () => {
  const readiness = buildAppPublishReadiness({
    appName: "Revenue Desk",
    workspaceSlug: "Ops",
    publicBaseUrl: "https://publish.example.test",
    requiredEnv: ["OPENAI_API_KEY"],
    runtimeEnv: {
      OPENAI_API_KEY: "sk-secret-value",
      PACKETAGENT_PUBLIC_APP_BASE_URL: "https://publish.example.test",
      PACKETAGENT_WEBHOOK_SIGNING_SECRET: "webhook-secret-value",
      RESEND_API_KEY: "email-secret-value",
      DATABASE_URL: "postgres://packetagent:secret@db.example.test/packetagent",
      PACKETAGENT_STORE: "postgres",
    },
    draft: {
      summary:
        "OpenAI assistant that sends email webhook notifications and persists customer records.",
      dataModels: [{ name: "customer" }],
    },
    email: { providerConfigured: true },
    database: { configured: true, migrationsReady: true, writable: true },
  });

  assert.equal(
    readiness.publishIntegrations.checks.find((check) => check.category === "provider_keys")
      ?.status,
    "ready",
  );
  assert.equal(
    readiness.publishIntegrations.checks.find((check) => check.category === "webhook")?.status,
    "ready",
  );
  assert.equal(
    readiness.publishIntegrations.checks.find((check) => check.category === "email")?.status,
    "ready",
  );
  assert.equal(
    readiness.publishIntegrations.checks.find((check) => check.category === "database")?.status,
    "ready",
  );
  assert.equal(JSON.stringify(readiness.publishIntegrations).includes("sk-secret-value"), false);
  assert.equal(
    JSON.stringify(readiness.publishIntegrations).includes("webhook-secret-value"),
    false,
  );
  assert.equal(
    JSON.stringify(readiness.publishIntegrations).includes("postgres://packetagent:secret"),
    false,
  );
});

test("app publish readiness expands app agent bundle contract", () => {
  const readiness = buildAppPublishReadiness({
    appName: "Ops Copilot",
    agentName: "Incident Helper",
    workspaceSlug: "Ops Team",
    bundleKind: "app_agent",
  });

  assert.equal(readiness.packageContract.bundleKind, "app_agent");
  assert.equal(readiness.agentSlug, "incident-helper");
  assert.equal(readiness.runtimeConfig.agentRouteBase, "/agent/ops-team/incident-helper");
  assert.ok(
    readiness.envChecklist.some(
      (item) => item.name === "PACKETAGENT_AGENT_BUNDLE_PATH" && item.required,
    ),
  );
  assert.ok(
    readiness.envChecklist.some(
      (item) => item.name === "PACKETAGENT_AGENT_TOOL_ALLOWLIST" && !item.required,
    ),
  );
  assert.ok(
    readiness.packageContract.buildCommands.some((step) => step.id === "validate-agent-bundle"),
  );
  assert.ok(
    readiness.publishArtifactManifest.entries.some((entry) =>
      entry.path.endsWith("/agent/agent-manifest.json"),
    ),
  );
  assert.ok(readiness.packageContract.smokeChecks.some((check) => check.id === "agent-manifest"));
  assert.ok(
    readiness.dockerComposeExport.outline.some((step) =>
      step.includes("permissioned PacketAgent Worker runtime"),
    ),
  );
});

test("app publish readiness defaults to private URL handoff", () => {
  const readiness = buildAppPublishReadiness();

  assert.equal(readiness.urlHandoff.visibility, "private");
  assert.equal(readiness.localPublishPath, "data/published-apps/workspace/generated-app");
  assert.equal(
    readiness.urlHandoff.publicUrl,
    "https://apps.packetagent.example/workspace/generated-app",
  );
  assert.equal(readiness.urlHandoff.privateUrl, "http://localhost:8787");
  assert.ok(readiness.urlHandoff.notes.some((note) => note.includes("Hold the public URL")));
});
