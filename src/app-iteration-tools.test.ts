import assert from "node:assert/strict";
import test from "node:test";
import {
  detectAppIterationToolCategories,
  inspectAppIterationTools,
} from "./app-iteration-tools";

test("detectAppIterationToolCategories inspects draft and scoped prompt in stable category order", () => {
  const categories = detectAppIterationToolCategories({
    draft: {
      summary: "Customer portal with OpenAI summaries, Stripe checkout, and Postgres persistence.",
      integrations: ["GitHub issue sync", "Resend invitation email"],
    },
    changePrompt: "Add a browser scrape import from a website and receive signed webhooks.",
  });

  assert.deepEqual(categories, [
    "openai_provider",
    "webhook_email",
    "github",
    "stripe_payment",
    "browser_scrape",
    "database",
  ]);
});

test("inspectAppIterationTools reports missing setup and blocks live connector work", () => {
  const readiness = inspectAppIterationTools({
    draft: {
      integrations: ["OpenAI triage", "GitHub issue sync", "Stripe subscription checkout"],
      dataModels: [{ table: "customers" }],
    },
    changePrompt: "Call the live OpenAI model, create GitHub issues, charge checkout, and save records.",
    database: { configured: false, migrationsReady: false, writable: false },
  });

  assert.equal(readiness.version, "phase-69-lane-4");
  assert.equal(readiness.readinessStatus, "blocked");
  assert.equal(readiness.canProceed, false);
  assert.equal(readiness.canProceedWithoutRequests, false);
  assert.deepEqual(readiness.requestedCategories, [
    "openai_provider",
    "github",
    "stripe_payment",
    "database",
  ]);
  assert.ok(readiness.missingSetup.some((setup) => setup.includes("OPENAI_API_KEY")));
  assert.ok(readiness.missingSetup.some((setup) => setup.includes("GitHub connector")));
  assert.ok(readiness.missingSetup.some((setup) => setup.includes("STRIPE_SECRET_KEY")));
  assert.ok(readiness.missingSetup.some((setup) => setup.includes("database runtime")));
  assert.equal(readiness.requests.find((request) => request.category === "openai_provider")?.readinessStatus, "blocked");
  assert.equal(readiness.requests.find((request) => request.category === "database")?.requiresLiveSetup, true);
});

test("inspectAppIterationTools allows draft-only iteration when live setup is missing", () => {
  const readiness = inspectAppIterationTools({
    draft: {
      pages: ["AI recommendation mockup", "Stripe pricing screen", "GitHub activity view"],
      integrations: ["email notification settings", "browser scrape configuration"],
    },
    changePrompt: "Sketch the settings UI and placeholder states for provider setup.",
  });

  assert.equal(readiness.readinessStatus, "needs_setup");
  assert.equal(readiness.canProceed, true);
  assert.equal(readiness.canProceedWithoutRequests, true);
  assert.deepEqual(readiness.requestedCategories, [
    "openai_provider",
    "webhook_email",
    "github",
    "stripe_payment",
    "browser_scrape",
  ]);
  assert.ok(readiness.requests.every((request) => request.canProceedWithout));
  assert.ok(readiness.requests.every((request) => request.rationale.includes("draft-safe placeholders")));
});

test("inspectAppIterationTools marks requested integrations ready from env and connector context", () => {
  const readiness = inspectAppIterationTools({
    draft: {
      summary: "OpenAI assist, webhook email flow, GitHub pull request handoff, Stripe checkout, browser scrape import, and database CRUD.",
      apiRoutes: [{ path: "/api/webhooks/stripe" }],
    },
    changePrompt: "Run the live integrations after the app updates.",
    env: {
      OPENAI_API_KEY: "set",
      RESEND_API_KEY: "set",
      PACKETAGENT_PUBLIC_BASE_URL: "https://apps.example.test",
      PACKETAGENT_WEBHOOK_SIGNING_SECRET: "set",
      STRIPE_SECRET_KEY: "set",
      STRIPE_WEBHOOK_SECRET: "set",
      STRIPE_PRICE_ID: "price_123",
    },
    connectedConnectors: ["github"],
    availableTools: ["browser-use"],
    database: { configured: true, migrationsReady: true, writable: true },
  });

  assert.equal(readiness.readinessStatus, "ready");
  assert.equal(readiness.canProceed, true);
  assert.equal(readiness.canProceedWithoutRequests, true);
  assert.deepEqual(readiness.missingSetup, []);
  assert.deepEqual(readiness.nextSteps, []);
  assert.deepEqual(readiness.requests.map((request) => request.readinessStatus), [
    "ready",
    "ready",
    "ready",
    "ready",
    "ready",
    "ready",
  ]);
});

test("inspectAppIterationTools separates webhook and email setup requirements", () => {
  const emailOnly = inspectAppIterationTools({
    draft: { integrations: ["SendGrid email receipts"] },
    changePrompt: "Deliver a live email receipt after submit.",
    webhookEmail: { emailProviderConfigured: true },
  });
  assert.equal(emailOnly.readinessStatus, "ready");
  assert.deepEqual(emailOnly.missingSetup, []);

  const webhookOnly = inspectAppIterationTools({
    draft: { apiRoutes: [{ path: "/api/webhooks/github", summary: "GitHub webhook receiver" }] },
    changePrompt: "Receive the live webhook and verify the signature.",
    webhookEmail: { publicBaseUrl: "https://hooks.example.test" },
  });
  assert.equal(webhookOnly.readinessStatus, "blocked");
  assert.deepEqual(webhookOnly.missingSetup, [
    "Configure PACKETAGENT_WEBHOOK_SIGNING_SECRET for signed inbound webhook requests.",
    "Connect the GitHub connector or configure GITHUB_TOKEN before live repository actions.",
  ]);
});

test("inspectAppIterationTools is quiet when the scoped iteration has no integration request", () => {
  const readiness = inspectAppIterationTools({
    draft: { summary: "Static landing page with local copy updates." },
    changePrompt: "Tighten the empty-state wording and layout spacing.",
  });

  assert.equal(readiness.readinessStatus, "not_requested");
  assert.equal(readiness.canProceed, true);
  assert.deepEqual(readiness.requestedCategories, []);
  assert.deepEqual(readiness.requests, []);
});
