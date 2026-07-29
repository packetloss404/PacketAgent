import assert from "node:assert/strict";
import test from "node:test";
import { inspectAppPublishIntegrations } from "./app-publish-integrations";

test("publish integrations produce targeted blockers for missing live setup", () => {
  const readiness = inspectAppPublishIntegrations({
    draft: {
      summary:
        "OpenAI triage with signed Stripe checkout webhooks, Resend email receipts, browser scrape import, and GitHub issue sync.",
      dataModels: [{ name: "customer" }],
    },
    env: {
      OPENAI_API_KEY: "sk-live-secret-that-must-not-leak",
      STRIPE_SECRET_KEY: "sk_stripe_secret_that_must_not_leak",
    },
  });

  assert.equal(readiness.version, "phase-71-lane-5");
  assert.equal(readiness.status, "blocked");
  assert.equal(readiness.canPublish, true);
  assert.equal(readiness.canUseAllRequestedIntegrations, false);
  assert.deepEqual(readiness.blockers, []);
  assert.ok(readiness.featureBlockers.some((blocker) => blocker.includes("Email delivery")));
  assert.ok(readiness.featureBlockers.some((blocker) => blocker.includes("Stripe payments")));
  assert.ok(readiness.featureBlockers.some((blocker) => blocker.includes("Database persistence")));
  assert.ok(readiness.featureBlockers.some((blocker) => blocker.includes("Browser scraping")));
  assert.ok(
    readiness.featureBlockers.some((blocker) => blocker.includes("GitHub repository actions")),
  );
  assert.equal(
    readiness.connectorReadiness.find((connector) => connector.id === "openai")?.status,
    "ready",
  );
  assert.equal(
    readiness.connectorReadiness.find((connector) => connector.id === "email")?.status,
    "blocked",
  );
  assert.equal(JSON.stringify(readiness).includes("sk-live-secret-that-must-not-leak"), false);
  assert.equal(JSON.stringify(readiness).includes("sk_stripe_secret_that_must_not_leak"), false);
});

test("publish integrations mark all requested live integrations ready when setup is present", () => {
  const readiness = inspectAppPublishIntegrations({
    draft: {
      summary:
        "GPT summaries, signed webhook receiver, email notices, Stripe subscriptions, browser extraction, GitHub PR sync, and Postgres CRUD.",
      dataModels: [{ name: "subscription" }],
    },
    env: {
      OPENAI_API_KEY: "set",
      PACKETAGENT_PUBLIC_APP_BASE_URL: "https://apps.example.test",
      PACKETAGENT_WEBHOOK_SIGNING_SECRET: "set",
      RESEND_API_KEY: "set",
      STRIPE_SECRET_KEY: "set",
      STRIPE_WEBHOOK_SECRET: "set",
      STRIPE_PRICE_ID: "price_123",
      DATABASE_URL: "postgres://packetagent:secret@db.example.test/packetagent",
      PACKETAGENT_STORE: "postgres",
    },
    availableTools: ["browser-use"],
    connectedConnectors: ["github"],
    browser: { scrapingAllowed: true },
    database: { configured: true, migrationsReady: true, writable: true },
  });

  assert.equal(readiness.status, "ready");
  assert.equal(readiness.canPublish, true);
  assert.equal(readiness.canUseAllRequestedIntegrations, true);
  assert.deepEqual(readiness.blockers, []);
  assert.deepEqual(readiness.featureBlockers, []);
  assert.deepEqual(readiness.warnings, []);
  assert.deepEqual(
    readiness.checks.map((check) => check.status),
    ["ready", "ready", "ready", "ready", "ready", "ready", "ready"],
  );
});

test("publish integrations separate database warnings from publish blockers", () => {
  const readiness = inspectAppPublishIntegrations({
    draft: {
      summary: "Customer CRUD app with persisted records.",
      dataModels: [{ name: "customer" }],
    },
    env: {
      DATABASE_URL: "postgres://packetagent:secret@db.example.test/packetagent",
      PACKETAGENT_STORE: "postgres",
    },
  });

  assert.equal(readiness.status, "warnings");
  assert.equal(readiness.canPublish, true);
  assert.deepEqual(readiness.blockers, []);
  assert.deepEqual(readiness.featureBlockers, []);
  assert.ok(readiness.warnings.some((warning) => warning.includes("db:migrate")));
  assert.ok(readiness.warnings.some((warning) => warning.includes("write smoke check")));
  assert.equal(JSON.stringify(readiness).includes("postgres://packetagent:secret"), false);
});

test("publish integrations stay quiet for static apps without requested integrations", () => {
  const readiness = inspectAppPublishIntegrations({
    draft: { summary: "Static public FAQ with copy and layout only." },
  });

  assert.equal(readiness.status, "ready");
  assert.equal(readiness.canPublish, true);
  assert.equal(readiness.canUseAllRequestedIntegrations, true);
  assert.deepEqual(readiness.blockers, []);
  assert.deepEqual(readiness.featureBlockers, []);
  assert.deepEqual(readiness.warnings, []);
  assert.ok(readiness.checks.every((check) => check.status === "not_required"));
});

test("publish integrations keep missing connector secrets scoped to the affected feature", () => {
  const readiness = inspectAppPublishIntegrations({
    draft: {
      summary: "Send Slack alerts from a custom API lookup and sync GitHub issues.",
    },
    connectors: [
      {
        id: "custom_api",
        required: true,
        feature: "Weather lookup action",
        requiredSecrets: ["WEATHER_API_KEY"],
      },
      {
        id: "github_webhook",
        required: true,
        connected: true,
      },
    ],
  });

  assert.equal(readiness.canPublish, true);
  assert.equal(readiness.canUseAllRequestedIntegrations, false);
  assert.deepEqual(readiness.blockers, []);
  assert.deepEqual(
    readiness.connectorReadiness.find((connector) => connector.id === "custom_api")?.missingSecrets,
    ["WEATHER_API_KEY"],
  );
  assert.equal(
    readiness.connectorReadiness.find((connector) => connector.id === "github_webhook")?.status,
    "ready",
  );
  assert.ok(readiness.featureBlockers.some((blocker) => blocker.includes("Weather lookup action")));
  assert.equal(
    readiness.featureBlockers.some((blocker) => blocker.includes("GitHub repository actions")),
    false,
  );
});
