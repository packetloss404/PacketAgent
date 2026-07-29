import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGeneratedTestManifest,
  expandBuilderTemplateBeta,
  listBuilderTemplateBetaCategories,
  type GeneratedTestCheckKind,
} from "./builder-template-beta";

test("expandBuilderTemplateBeta expands deterministic app and agent bundles across beta categories", () => {
  const first = expandBuilderTemplateBeta({
    categories: ["sales_crm", "booking_ops", "internal_ops"],
    promptContext: "Phase 72 beta reliability lane.",
  });
  const second = expandBuilderTemplateBeta({
    categories: ["sales_crm", "booking_ops", "internal_ops"],
    promptContext: "Phase 72 beta reliability lane.",
  });

  assert.deepEqual(first, second);
  assert.equal(first.version, "phase-72-lane-2");
  assert.deepEqual(first.categories, ["sales_crm", "booking_ops", "internal_ops"]);
  assert.deepEqual(
    first.bundles.map((bundle) => bundle.appTemplateId),
    ["crm", "booking", "internal_dashboard"],
  );
  assert.ok(first.bundles.every((bundle) => bundle.agents.length >= 2));
  assert.ok(first.bundles.every((bundle) => bundle.app.pageMap.length > 0));
  assert.ok(
    first.bundles.every((bundle) =>
      bundle.agents.every((agent) => agent.agent.playbook.length >= 3),
    ),
  );
});

test("generated manifest covers smoke, unit, access, and integration checks for each bundle", () => {
  const expansion = expandBuilderTemplateBeta({
    categories: ["sales_crm", "booking_ops", "customer_success"],
  });
  const manifest = expansion.generatedTestManifest;
  const expectedKinds: GeneratedTestCheckKind[] = ["smoke", "unit", "access", "integration"];

  assert.deepEqual(manifest.checkKinds, expectedKinds);
  assert.deepEqual(manifest.bundleIds, [
    "beta-sales-crm",
    "beta-booking-ops",
    "beta-customer-success",
  ]);
  assert.equal(manifest.checks.length, expansion.bundles.length * expectedKinds.length);

  for (const bundle of expansion.bundles) {
    assert.deepEqual(
      manifest.checks.filter((check) => check.bundleId === bundle.id).map((check) => check.kind),
      expectedKinds,
    );
    assert.ok(
      manifest.checks.some(
        (check) =>
          check.bundleId === bundle.id &&
          check.kind === "access" &&
          check.assertions.some((assertion) => assertion.includes("Admin routes")),
      ),
    );
    assert.ok(
      manifest.checks.some(
        (check) =>
          check.bundleId === bundle.id && check.kind === "integration" && check.cleanup.length >= 2,
      ),
    );
  }
});

test("manifest helper includes reliability cleanup guidance without leaking secret values", () => {
  const expansion = expandBuilderTemplateBeta({
    categories: ["customer_success"],
    promptContext: "Use env STRIPE_SECRET_KEY and GITHUB_TOKEN names only.",
  });

  const manifest = buildGeneratedTestManifest(expansion.bundles);
  const cleanupText = manifest.reliabilityCleanupGuidance.join("\n");
  const manifestText = JSON.stringify(manifest);

  assert.match(cleanupText, /agent preview runs/);
  assert.match(cleanupText, /provider secrets out of generated manifests/);
  assert.match(cleanupText, /Stripe fixture IDs/);
  assert.ok(
    manifest.checks.some(
      (check) =>
        check.kind === "integration" &&
        check.assertions.some((assertion) => assertion.includes("missing env vars")),
    ),
  );
  assert.ok(manifestText.includes("STRIPE_SECRET_KEY"));
  assert.equal(manifestText.includes("sk_live_"), false);
});

test("category listing is stable and unknown categories are rejected", () => {
  assert.deepEqual(listBuilderTemplateBetaCategories(), [
    "sales_crm",
    "booking_ops",
    "internal_ops",
    "customer_success",
  ]);

  assert.throws(
    () => expandBuilderTemplateBeta({ categories: ["sales_crm", "missing" as never] }),
    /unknown beta template categories: missing/,
  );
});
