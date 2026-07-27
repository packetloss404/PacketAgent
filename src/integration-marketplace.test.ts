import assert from "node:assert/strict";
import test from "node:test";
import { buildIntegrationMarketplace } from "./integration-marketplace";
import type { IntegrationReadinessSummary } from "./packetagent-services";

const baseReadiness: IntegrationReadinessSummary = {
  status: "needs_setup",
  tools: {
    availableCount: 0,
    readCount: 0,
    writeCount: 0,
    execCount: 0,
    names: [],
    missingForGeneratedPlans: [],
  },
  providers: {
    configuredCount: 0,
    readyCount: 0,
    missingProviderKinds: ["openai", "anthropic", "ollama"],
    missingApiKeys: [],
  },
  recommendedSetup: [],
};

test("integration marketplace exposes the phase 71 card set and safe payload surfaces", () => {
  const marketplace = buildIntegrationMarketplace({ readiness: baseReadiness });

  assert.equal(marketplace.version, "phase-71-lane-4");
  assert.deepEqual(marketplace.cards.map((card) => card.id), [
    "openai",
    "anthropic",
    "ollama-local",
    "custom-api-provider",
    "slack-webhook",
    "email",
    "github-webhook",
    "browser-scraping",
    "stripe-payments",
    "database",
  ]);
  assert.equal(marketplace.totals.count, 10);
  assert.ok(marketplace.cards.every((card) => card.config.secretsRedacted));
  assert.ok(marketplace.cards.every((card) => card.test.path.startsWith("/api/")));
  assert.equal(marketplace.cards.some((card) => card.test.path === "/api/health/ready"), false);
  assert.ok(marketplace.cards.every((card) => /\/test$/.test(card.test.path)));
  assert.equal(JSON.stringify(marketplace).includes("sk-test-secret"), false);
});

test("integration marketplace marks configured providers, tools, payments, and database as ready", () => {
  const marketplace = buildIntegrationMarketplace({
    readiness: {
      ...baseReadiness,
      status: "ready",
      tools: {
        ...baseReadiness.tools,
        names: ["browser-use", "read_file"],
      },
      providers: {
        configuredCount: 3,
        readyCount: 3,
        missingProviderKinds: [],
        missingApiKeys: [],
      },
    },
    env: {
      OPENAI_API_KEY: "sk-test-secret",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      OLLAMA_BASE_URL: "http://localhost:11434",
      CUSTOM_PROVIDER_BASE_URL: "https://models.example.test/v1",
      SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/test",
      SMTP_URL: "smtp://localhost",
      GITHUB_WEBHOOK_SECRET: "github-secret",
      STRIPE_SECRET_KEY: "sk_stripe",
      STRIPE_WEBHOOK_SECRET: "whsec_stripe",
      DATABASE_URL: "postgres://packetagent:secret@example.test/packetagent",
      PACKETAGENT_STORE: "postgres",
    },
  });

  const byId = Object.fromEntries(marketplace.cards.map((card) => [card.id, card]));

  assert.equal(byId.openai.readiness.status, "ready");
  assert.equal(byId["browser-scraping"].readiness.status, "ready");
  assert.equal(byId["stripe-payments"].readiness.status, "ready");
  assert.equal(byId.database.readiness.status, "ready");
  assert.ok(marketplace.totals.ready >= 9);
  assert.equal(JSON.stringify(marketplace).includes("postgres://packetagent:secret"), false);
  assert.equal(JSON.stringify(marketplace).includes("sk-test-secret"), false);
});

test("integration marketplace reports precise setup blockers without requiring optional tools", () => {
  const marketplace = buildIntegrationMarketplace({
    readiness: baseReadiness,
    env: {
      STRIPE_SECRET_KEY: "sk_stripe",
    },
  });

  const stripe = marketplace.cards.find((card) => card.id === "stripe-payments");
  const browser = marketplace.cards.find((card) => card.id === "browser-scraping");

  assert.equal(stripe?.readiness.status, "needs_config");
  assert.deepEqual(stripe?.readiness.blockers, ["Set STRIPE_WEBHOOK_SECRET."]);
  assert.equal(browser?.readiness.status, "available");
  assert.deepEqual(browser?.readiness.blockers, []);
  assert.ok(browser?.readiness.warnings.some((warning) => warning.includes("browser-use")));
});
