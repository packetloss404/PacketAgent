import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAppBuilderPrimitiveCatalog,
  buildAppBuilderPrimitiveReadinessSummary,
  buildPaymentBlockReadiness,
  findAppBuilderPrimitive,
  listAppBuilderPrimitives,
} from "./app-builder-primitives";

test("app builder primitive catalog exposes deterministic generated-app references", () => {
  const catalog = buildAppBuilderPrimitiveCatalog({
    readiness: {
      env: {
        OPENAI_API_KEY: "sk-test",
        PACKETAGENT_PUBLIC_BASE_URL: "https://apps.example.test",
        PACKETAGENT_WEBHOOK_SIGNING_SECRET: "whsec_local",
        STRIPE_SECRET_KEY: "sk_test_stripe",
        STRIPE_WEBHOOK_SECRET: "whsec_stripe",
      },
    },
  });

  assert.equal(catalog.version, "phase-68-lane-4");
  assert.deepEqual(
    catalog.primitives.map((primitive) => primitive.id),
    ["ai.feature", "database.crud", "scheduled.job", "webhook.endpoint", "payment.checkout"],
  );
  assert.deepEqual(
    catalog.references.map((reference) => reference.draftKey),
    ["aiFeatures", "dataModels", "scheduledJobs", "webhooks", "payments"],
  );
  assert.equal(catalog.readiness.ready, true);
  assert.ok(catalog.generationHints.some((hint) => hint.includes("dataModels")));
});

test("primitive listing can be filtered without mutating catalog entries", () => {
  const paymentOnly = listAppBuilderPrimitives({ requestedKinds: ["payment"] });
  assert.equal(paymentOnly.length, 1);
  assert.equal(paymentOnly[0]?.id, "payment.checkout");

  paymentOnly[0]?.supportedBlocks.push("mutated");

  const freshPayment = findAppBuilderPrimitive("payment.checkout");
  assert.ok(freshPayment);
  assert.equal(freshPayment.supportedBlocks.includes("mutated"), false);
});

test("readiness summary keeps unrelated generated app primitives usable", () => {
  const summary = buildAppBuilderPrimitiveReadinessSummary({
    requestedPrimitiveIds: ["ai.feature", "database.crud", "payment.checkout"],
    env: {},
    database: { configured: true, supportsCrud: true },
  });

  assert.equal(summary.status, "needs_setup");
  assert.equal(summary.ready, false);
  assert.equal(summary.byKind.database_crud?.ready, true);
  assert.equal(summary.byKind.ai_feature?.ready, false);
  assert.equal(summary.byKind.payment?.ready, false);
  assert.deepEqual(summary.missingSecrets, [
    "OPENAI_API_KEY or ANTHROPIC_API_KEY or OLLAMA_BASE_URL",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
  ]);
  assert.ok(summary.recommendedSetup.some((step) => step.includes("AI provider")));
  assert.ok(summary.recommendedSetup.some((step) => step.includes("STRIPE_SECRET_KEY")));
});

test("webhook and payment readiness become ready from explicit deterministic inputs", () => {
  const summary = buildAppBuilderPrimitiveReadinessSummary({
    requestedKinds: ["webhook", "payment"],
    webhook: {
      publicBaseUrl: "https://preview.example.test",
      signingSecretConfigured: true,
    },
    payments: {
      provider: "stripe",
      checkoutEnabled: true,
      secretKeyConfigured: true,
      webhookSecretConfigured: true,
    },
  });

  assert.equal(summary.ready, true);
  assert.equal(summary.byKind.webhook?.ready, true);
  assert.equal(summary.byKind.payment?.ready, true);
  assert.equal(summary.missingSecrets.length, 0);
});

test("payment block readiness reports checkout secret requirements", () => {
  const missing = buildPaymentBlockReadiness({
    payments: {
      provider: "stripe",
      checkoutEnabled: true,
      secretKeyConfigured: true,
      webhookSecretConfigured: false,
    },
  });

  assert.equal(missing.ready, false);
  assert.equal(missing.status, "needs_setup");
  assert.deepEqual(missing.missingSecrets, ["STRIPE_WEBHOOK_SECRET"]);
  assert.match(missing.message, /checkout should stay disabled/);

  const ready = buildPaymentBlockReadiness({
    env: {
      STRIPE_SECRET_KEY: "sk_test",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
    },
  });

  assert.equal(ready.ready, true);
  assert.equal(ready.status, "ready");
});

test("unknown primitive ids are surfaced as setup work", () => {
  const summary = buildAppBuilderPrimitiveReadinessSummary({
    requestedPrimitiveIds: ["database.crud", "not.real"],
  });

  assert.deepEqual(summary.unknownPrimitiveIds, ["not.real"]);
  assert.equal(summary.ready, false);
  assert.ok(summary.recommendedSetup.some((step) => step.includes("not.real")));
});
