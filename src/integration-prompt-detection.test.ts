import assert from "node:assert/strict";
import test from "node:test";
import {
  detectRequestedIntegrationIds,
  inspectIntegrationPromptDetection,
} from "./integration-prompt-detection";

test("detects Phase 71 requested integrations from prompt and draft text", () => {
  const result = inspectIntegrationPromptDetection({
    prompt:
      "Build with OpenAI GPT summaries, Claude fallback, Ollama local mode, custom API enrichment, Slack webhook alerts, email receipts, GitHub webhook issue sync, browser scraping, Stripe payments, and database CRUD.",
    draft: {
      features: [
        {
          id: "ai-summary",
          summary: "Use GPT and Claude to summarize tickets with Ollama fallback.",
        },
        { id: "billing", summary: "Stripe checkout and payment subscription screens." },
        {
          id: "ops",
          summary:
            "Slack webhook alerts, GitHub webhook events, email receipts, and custom API enrichment.",
        },
        { id: "research", summary: "Browser scrape vendor websites." },
        { id: "records", summary: "Database tables for customer CRUD." },
      ],
    },
  });

  assert.equal(result.version, "phase-71-lane-1");
  assert.equal(result.status, "needs_setup");
  assert.deepEqual(result.requestedIntegrationIds, [
    "openai",
    "anthropic",
    "ollama_local",
    "custom_api",
    "slack_webhook",
    "email",
    "github_webhook",
    "browser_scraping",
    "stripe_payments",
    "database",
  ]);
  assert.deepEqual(result.affectedFeatureIds, [
    "ai-summary",
    "billing",
    "ops",
    "records",
    "research",
  ]);
  assert.ok(result.missingSetupPrompts.some((prompt) => prompt.includes("OPENAI_API_KEY")));
  assert.ok(result.missingSetupPrompts.some((prompt) => prompt.includes("ANTHROPIC_API_KEY")));
  assert.ok(result.missingSetupPrompts.some((prompt) => prompt.includes("OLLAMA_BASE_URL")));
  assert.ok(result.missingSetupPrompts.some((prompt) => prompt.includes("STRIPE_SECRET_KEY")));
  assert.equal(JSON.stringify(result).includes("secret-that-must-not-leak"), false);
});

test("missing setup blocks only affected feature ids", () => {
  const result = inspectIntegrationPromptDetection({
    prompt: "Add Stripe checkout to billing and keep the public FAQ static.",
    draft: {
      features: [
        { id: "billing", summary: "Stripe checkout for paid plans." },
        { id: "faq", summary: "Static FAQ page with product copy only." },
      ],
    },
    env: {
      STRIPE_SECRET_KEY: "secret-that-must-not-leak",
    },
  });

  assert.deepEqual(result.requestedIntegrationIds, ["stripe_payments"]);
  assert.deepEqual(result.affectedFeatureIds, ["billing"]);
  assert.deepEqual(result.blockedFeatureIds, ["billing"]);
  assert.deepEqual(result.unblockedFeatureIds, ["faq"]);
  assert.deepEqual(
    result.featureBlocks.map((block) => block.featureId),
    ["billing"],
  );
  assert.ok(
    result.featureBlocks[0]?.missingSetupPrompts.some((prompt) =>
      prompt.includes("STRIPE_WEBHOOK_SECRET"),
    ),
  );
  assert.equal(JSON.stringify(result).includes("secret-that-must-not-leak"), false);
});

test("ready setup returns requested integrations without setup prompts", () => {
  const result = inspectIntegrationPromptDetection({
    prompt:
      "Use OpenAI for classification, send email notifications, scrape a URL, and save records to Postgres.",
    draft: {
      features: [
        { id: "classify", summary: "OpenAI classification." },
        { id: "notify", summary: "Email notifications." },
        { id: "import", summary: "Browser scrape a URL." },
        { id: "storage", summary: "Postgres database records." },
      ],
    },
    env: {
      OPENAI_API_KEY: "set",
      RESEND_API_KEY: "set",
      DATABASE_URL: "postgres://user:password@example.test/db",
    },
    availableTools: ["browser-use"],
    browser: { scrapingAllowed: true },
    database: { configured: true, migrationsReady: true, writable: true },
  });

  assert.equal(result.status, "ready");
  assert.deepEqual(result.missingSetupPrompts, []);
  assert.deepEqual(result.blockedFeatureIds, []);
  assert.ok(result.requestedIntegrations.every((integration) => integration.ready));
  assert.equal(JSON.stringify(result).includes("postgres://user:password"), false);
});

test("static prompts do not request integrations", () => {
  const result = inspectIntegrationPromptDetection({
    prompt: "Create a static onboarding checklist page with sections and acceptance criteria.",
    draft: {
      features: [{ id: "checklist", summary: "Static checklist content." }],
    },
  });

  assert.equal(result.status, "not_requested");
  assert.deepEqual(result.requestedIntegrationIds, []);
  assert.deepEqual(result.missingSetupPrompts, []);
  assert.deepEqual(result.blockedFeatureIds, []);
  assert.deepEqual(result.unblockedFeatureIds, ["checklist"]);
  assert.deepEqual(detectRequestedIntegrationIds({ prompt: "No external systems." }), []);
});
