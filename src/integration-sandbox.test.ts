import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectIntegrationSandbox,
  redactIntegrationSandboxValue,
} from "./integration-sandbox";

test("integration sandbox reports deterministic runtime and preview failures without leaking secrets", () => {
  const report = inspectIntegrationSandbox({
    draft: {
      summary: "GPT support app with Stripe checkout, webhook receipts, GitHub issue sync, browser scrape import, preview API routes, and Postgres records.",
      pages: ["Dashboard", "Preview smoke page"],
      apiRoutes: [{ path: "/api/webhooks/stripe" }, { path: "/api/preview/run" }],
      dataModels: [{ name: "customer" }],
      env: {
        OPENAI_API_KEY: "sk-live-secret-that-must-not-leak",
      },
    },
    env: {
      DATABASE_URL: "postgres://packetagent:secret@db.example.test/packetagent",
      STRIPE_SECRET_KEY: "sk_stripe_secret_that_must_not_leak",
    },
    preview: {
      sandboxEnabled: false,
    },
  });

  assert.equal(report.version, "phase-71-lane-3");
  assert.equal(report.status, "fail");
  assert.equal(report.canRunRuntimeSandbox, false);
  assert.equal(report.canRunPreviewSandbox, false);
  assert.ok(report.failures.includes("Payment connector sandbox"));
  assert.ok(report.failures.includes("GitHub connector sandbox"));
  assert.ok(report.failures.includes("Preview runtime sandbox"));
  assert.ok(report.setupGuide.some((guide) => guide.includes("STRIPE_WEBHOOK_SECRET")));
  assert.ok(report.setupGuide.some((guide) => guide.includes("GitHub connector")));
  assert.ok(report.results.every((result) => result.deterministic));
  assert.ok(report.results.every((result) => result.liveNetworkCalls === false));
  assert.equal(JSON.stringify(report).includes("sk-live-secret-that-must-not-leak"), false);
  assert.equal(JSON.stringify(report).includes("postgres://packetagent:secret"), false);
  assert.equal(JSON.stringify(report).includes("sk_stripe_secret_that_must_not_leak"), false);
});

test("integration sandbox passes requested connectors when sandbox setup is present", () => {
  const report = inspectIntegrationSandbox({
    draft: {
      summary: "OpenAI email notifications, signed webhooks, Stripe subscriptions, GitHub PR sync, browser scrape import, and preview runtime endpoints.",
      pages: ["Previewed app"],
      apiRoutes: [{ path: "/api/preview/run" }, { path: "/api/webhooks/github" }],
      dataModels: [{ name: "subscription" }],
    },
    env: {
      OPENAI_API_KEY: "set",
      DATABASE_URL: "postgres://set",
      RESEND_API_KEY: "set",
      PACKETAGENT_PUBLIC_APP_BASE_URL: "https://apps.example.test",
      PACKETAGENT_WEBHOOK_SIGNING_SECRET: "set",
      STRIPE_SECRET_KEY: "set",
      STRIPE_WEBHOOK_SECRET: "set",
      STRIPE_PRICE_ID: "price_123",
      PACKETAGENT_PREVIEW_SANDBOX: "1",
    },
    availableTools: ["browser-use", "preview-runtime"],
    connectedConnectors: ["github"],
    preview: {
      buildReady: true,
      previewUrl: "http://localhost:5173/preview/app-123",
    },
  });

  assert.equal(report.status, "pass");
  assert.equal(report.canRunRuntimeSandbox, true);
  assert.equal(report.canRunPreviewSandbox, true);
  assert.deepEqual(report.failures, []);
  assert.ok(report.results
    .filter((result) => result.required)
    .every((result) => result.status === "pass"));
});

test("integration sandbox supports explicit pending connector results and setup guidance", () => {
  const report = inspectIntegrationSandbox({
    draft: {
      summary: "Static app with an upcoming GitHub issue sync.",
      integrations: ["GitHub"],
    },
    runtime: {
      connectors: {
        github: {
          required: true,
          pending: true,
          observed: {
            token: "github_pat_secretvalue1234567890",
            account: "octo-org",
          },
          setupGuide: ["Approve the GitHub connector installation for the sandbox workspace."],
        },
      },
    },
  });

  const github = report.results.find((result) => result.id === "github");
  assert.equal(report.status, "pending");
  assert.equal(github?.status, "pending");
  assert.equal(github?.observed.account, "octo-org");
  assert.notEqual(github?.observed.token, "github_pat_secretvalue1234567890");
  assert.deepEqual(report.setupGuide, [
    "Approve the GitHub connector installation for the sandbox workspace.",
  ]);
});

test("redactIntegrationSandboxValue masks common credentials and keeps safe context", () => {
  const redacted = redactIntegrationSandboxValue({
    headers: {
      authorization: "Bearer abcdefghijklmnopqrstuvwxyz123456",
      accept: "application/json",
    },
    databaseUrl: "postgres://user:password@localhost/packetagent",
    previewUrl: "http://localhost:5173/preview/app-123",
    note: "safe diagnostic text",
  });

  assert.deepEqual(redacted, {
    headers: {
      authorization: "Be...[redacted]...56",
      accept: "application/json",
    },
    databaseUrl: "po...[redacted]...nt",
    previewUrl: "http://localhost:5173/preview/app-123",
    note: "safe diagnostic text",
  });
});
