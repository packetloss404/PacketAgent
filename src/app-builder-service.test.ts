import assert from "node:assert/strict";
import test from "node:test";
import {
  generateAppSourceArtifactBundle,
  generateAppDraftFromPrompt,
  generateAppDraftWithLLM,
  listAppDraftTemplateIds,
} from "./app-builder-service";

test("generateAppDraftFromPrompt rejects short prompts", () => {
  assert.throws(() => generateAppDraftFromPrompt("tiny"), /at least 8 characters/);
});

test("generateAppDraftFromPrompt returns deterministic CRM draft", () => {
  const prompt = "Build a CRM for boutique sales teams to track leads, accounts, deals, and pipeline follow-up.";

  const first = generateAppDraftFromPrompt(prompt);
  const second = generateAppDraftFromPrompt(prompt);

  assert.deepEqual(first, second);
  assert.equal(first.templateId, "crm");
  assert.ok(first.appName.includes("CRM"));
  assert.ok(first.pageMap.some((page) => page.path === "/crm/deals/:dealId"));
  assert.ok(first.components.some((component) => component.name === "PipelineBoard"));
  assert.ok(first.dataSchema.entities.some((entity) => entity.name === "deal"));
  assert.ok(first.seedData.deal.length > 0);
  assert.ok(first.crudFlows.some((flow) => flow.entity === "lead"));
  assert.ok(first.apiRouteStubs.some((route) => route.method === "POST" && route.path.includes("/api/app/generated/") && route.path.endsWith("/deals")));
});

test("booking heuristic exposes public booking and admin service management", () => {
  const draft = generateAppDraftFromPrompt(
    "Create a booking app for clinics with providers, appointment slots, calendar scheduling, and reservations.",
  );

  assert.equal(draft.templateId, "booking");
  assert.ok(draft.auth.publicRoutes.includes("/book"));
  assert.ok(draft.auth.roleRoutes[0].routes.includes("/settings/services"));
  assert.ok(draft.dataSchema.entities.some((entity) => entity.name === "appointment"));
  assert.ok(draft.apiRouteStubs.some((route) => route.path.includes("/api/app/generated/") && route.path.endsWith("/appointments/:id")));
  assert.ok(draft.acceptanceChecks.some((check) => check.includes("prevents two confirmed appointments")));
});

test("internal dashboard heuristic includes metrics, reports, alerts, and private dashboard", () => {
  const draft = generateAppDraftFromPrompt(
    "Ship an internal dashboard for operations KPIs, reports, monitoring alerts, and weekly analytics.",
  );

  assert.equal(draft.templateId, "internal_dashboard");
  assert.ok(draft.auth.privateRoutes.includes("/dashboard"));
  assert.ok(!draft.auth.publicRoutes.includes("/dashboard"));
  assert.ok(draft.components.some((component) => component.name === "KpiGrid"));
  assert.deepEqual(
    draft.dataSchema.entities.map((entity) => entity.name),
    ["metricSnapshot", "alert", "report"],
  );
});

test("task tracker is the fallback and includes project task comment CRUD", () => {
  const draft = generateAppDraftFromPrompt(
    "Help our product team coordinate weekly launch work, owners, blockers, and release follow-ups.",
  );

  assert.equal(draft.templateId, "task_tracker");
  assert.ok(draft.pageMap.some((page) => page.path === "/boards/:boardId"));
  assert.deepEqual(
    draft.crudFlows.map((flow) => flow.entity),
    ["project", "task", "comment"],
  );
  assert.ok(draft.seedData.task.length >= 2);
});

test("customer portal heuristic keeps portal pages private and admin customer controls role-gated", () => {
  const draft = generateAppDraftFromPrompt(
    "Create a customer portal with self-service requests, documents, invoices, and customer login.",
  );

  assert.equal(draft.templateId, "customer_portal");
  assert.ok(draft.auth.publicRoutes.includes("/"));
  assert.ok(draft.auth.privateRoutes.includes("/portal/documents"));
  assert.ok(draft.auth.roleRoutes.some((entry) => entry.routes.includes("/admin/customers")));
  assert.ok(draft.dataSchema.entities.some((entity) => entity.name === "document"));
  assert.ok(draft.acceptanceChecks.some((check) => check.includes("own account")));
});

test("phase 71 integration prompts add setup metadata without changing core app generation", () => {
  const draft = generateAppDraftFromPrompt(
    "Build a customer portal with Stripe checkout, GitHub issue sync, Slack webhook alerts, email receipts, and Postgres persistence.",
  );

  assert.equal(draft.templateId, "customer_portal");
  assert.ok(draft.pageMap.some((page) => page.path === "/portal/requests"));
  assert.deepEqual(
    draft.integrationMetadata.requested.map((integration) => integration.id),
    ["slack_webhook", "email", "github", "stripe", "database"],
  );
  assert.ok(draft.integrationMetadata.setupGuidance.some((entry) => entry.includes("STRIPE_SECRET_KEY")));
  assert.ok(draft.components.some((component) => component.name === "IntegrationSetupPanel"));
  assert.ok(draft.apiRouteStubs.some((route) => route.path.endsWith("/integrations/github/setup") && route.purpose.includes("GITHUB_TOKEN")));
  assert.ok(draft.apiRouteStubs.some((route) => route.path.endsWith("/integrations/stripe/actions") && route.purpose.includes("Stripe")));
  assert.ok(draft.dataSchema.notes.some((note) => note.includes("PACKETAGENT_DATABASE_URL")));
  assert.ok(draft.acceptanceChecks.some((check) => check.includes("without blocking unrelated app features")));
});

test("phase 71 custom API prompts add generated setup routes and env guidance", () => {
  const draft = generateAppDraftFromPrompt(
    "Build an internal dashboard that calls a custom external REST API with an API key and stores returned records.",
  );

  assert.ok(draft.integrationMetadata.requested.some((integration) => integration.id === "custom_api"));
  assert.ok(draft.integrationMetadata.setupGuidance.some((entry) => entry.includes("CUSTOM_API_BASE_URL")));
  assert.ok(draft.apiRouteStubs.some((route) => route.path.endsWith("/integrations/custom_api/setup") && route.purpose.includes("CUSTOM_API_KEY")));
  assert.ok(draft.acceptanceChecks.some((check) => check.includes("Custom API provider setup guidance")));
});

test("generateAppSourceArtifactBundle creates a deterministic minimal app source tree", () => {
  const draft = generateAppDraftFromPrompt(
    "Create a booking app for clinics with providers, appointment slots, calendar scheduling, and reservations.",
  );

  const first = generateAppSourceArtifactBundle(draft);
  const second = generateAppSourceArtifactBundle(draft);

  assert.deepEqual(first, second);
  assert.equal(first.appName, draft.appName);
  assert.equal(first.templateId, "booking");
  assert.equal(first.entrypoint, "src/App.tsx");
  assert.deepEqual(
    first.files.map((file) => file.path),
    [
      "package.json",
      "index.html",
      "tsconfig.json",
      "vite.config.ts",
      "src/main.tsx",
      "src/App.tsx",
      "src/styles.css",
      "src/routes/page-data.ts",
      "src/api/generated-api.ts",
      "src/data/seed-data.json",
      "README.md",
    ],
  );
  assert.ok(first.files.every((file) => file.sizeBytes > 0));
  assert.ok(first.files.every((file) => /^[a-f0-9]{64}$/.test(file.checksum)));
});

test("generated app source includes pages, app name, and seed data", () => {
  const draft = generateAppDraftFromPrompt(
    "Build a CRM for boutique sales teams to track leads, accounts, deals, and pipeline follow-up.",
  );
  const bundle = generateAppSourceArtifactBundle(draft);
  const appFile = bundle.files.find((file) => file.path === "src/App.tsx");
  const pageDataFile = bundle.files.find((file) => file.path === "src/routes/page-data.ts");
  const seedFile = bundle.files.find((file) => file.path === "src/data/seed-data.json");
  const readme = bundle.files.find((file) => file.path === "README.md");

  assert.ok(appFile?.contents.includes(draft.appName));
  assert.ok(pageDataFile?.contents.includes("\"route\": \"/crm/deals/:dealId\""));
  assert.ok(pageDataFile?.contents.includes("\"components\""));
  assert.ok(seedFile?.contents.includes("\"deal_001\""));
  assert.ok(readme?.contents.includes(`# ${draft.appName}`));
  assert.ok(readme?.contents.includes("Pipeline"));
});

test("generated app source includes API and data contracts without route-stub wording", () => {
  const draft = generateAppDraftFromPrompt(
    "Build an internal dashboard for operations KPIs, reports, monitoring alerts, and weekly analytics.",
  );
  const bundle = generateAppSourceArtifactBundle(draft);
  const apiFile = bundle.files.find((file) => file.path === "src/api/generated-api.ts");
  const allGeneratedText = bundle.files.map((file) => file.contents).join("\n");

  assert.ok(apiFile?.contents.includes("export const apiRoutes"));
  assert.ok(apiFile?.contents.includes("export const dataContracts"));
  assert.ok(apiFile?.contents.includes("handleGeneratedApiRequest"));
  assert.ok(apiFile?.contents.includes("\"name\": \"metricSnapshot\""));
  assert.ok(apiFile?.contents.includes("\"requiredFields\""));
  assert.ok(apiFile?.contents.includes("/api/app/generated/"));
  assert.equal(/route[-\s]?stub|stub/i.test(allGeneratedText), false);
});

test("listAppDraftTemplateIds exposes the supported heuristics", () => {
  assert.deepEqual(listAppDraftTemplateIds(), [
    "crm",
    "booking",
    "internal_dashboard",
    "task_tracker",
    "customer_portal",
  ]);
});

// ---------------------------------------------------------------------------
// Track B default-on behaviour for `generateAppDraftWithLLM`.
//
// File-tree codegen is now tried by default. These tests verify:
//   1. With NO provider keys and no env flags set, the new default path is
//      exercised and falls through to the template generator without
//      throwing.
//   2. Setting `PACKETAGENT_LEGACY_TEMPLATES=1` skips the file-tree path
//      entirely (legacy escape hatch / kill switch).
//   3. Setting the legacy `PACKETAGENT_FILETREE_CODEGEN=1` flag is a harmless
//      no-op — the path is on by default now anyway.
// ---------------------------------------------------------------------------

const PROVIDER_KEY_ENV_FOR_DEFAULT_ON = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "MINIMAX_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "PACKETAGENT_PROVIDER_PRIORITY",
  "PACKETAGENT_LEGACY_TEMPLATES",
  "PACKETAGENT_FILETREE_CODEGEN",
] as const;

function withScrubbedEnv(
  overrides: Record<string, string>,
  body: () => Promise<void>,
): Promise<void> {
  const originals: Partial<Record<string, string | undefined>> = {};
  for (const key of PROVIDER_KEY_ENV_FOR_DEFAULT_ON) {
    originals[key] = process.env[key];
    delete process.env[key];
  }
  // Exclude the keyless ollama provider so a fresh dev machine without
  // any API keys configured behaves identically to CI: the resolver
  // returns null, and `authorAppViaLLM` returns null in turn.
  process.env.PACKETAGENT_PROVIDER_PRIORITY =
    "anthropic,openai,minimax,gemini,openrouter";
  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }
  return body().finally(() => {
    for (const key of PROVIDER_KEY_ENV_FOR_DEFAULT_ON) {
      const original = originals[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
    // Clean up overrides that weren't in the scrub list.
    for (const key of Object.keys(overrides)) {
      if (
        !(PROVIDER_KEY_ENV_FOR_DEFAULT_ON as readonly string[]).includes(key)
      ) {
        delete process.env[key];
      }
    }
  });
}

test("generateAppDraftWithLLM default-on: file-tree path tried first, falls through to template when no key is configured", async () => {
  await withScrubbedEnv({}, async () => {
    const emitted: string[] = [];
    // The new default tries `tryFileTreeCodegen` first. With no provider
    // key configured, the orchestrator returns null, then the structured
    // tool path also returns null, then the template generator wins. The
    // important thing this test pins down is: NOTHING THROWS.
    const { draft, source } = await generateAppDraftWithLLM(
      "Build a CRM for sales teams to track leads and deals.",
      {},
      (text) => {
        emitted.push(text);
      },
    );
    assert.equal(source, "template");
    assert.equal(draft.templateId, "crm");
    assert.equal(
      emitted.length,
      0,
      "no prose should be emitted when every path declined and the template fallback ran",
    );
  });
});

test("generateAppDraftWithLLM legacy escape hatch: PACKETAGENT_LEGACY_TEMPLATES=1 skips the file-tree path", async () => {
  await withScrubbedEnv(
    { PACKETAGENT_LEGACY_TEMPLATES: "1" },
    async () => {
      const emitted: string[] = [];
      // With the kill switch set, behaviour reverts to the pre-Track-B
      // contract: structured-tool path → template fallback. No file-tree
      // path runs, so no codegen prose is emitted even with a provider
      // key (and certainly not without one).
      const { draft, source } = await generateAppDraftWithLLM(
        "Build a CRM for sales teams to track leads and deals.",
        {},
        (text) => {
          emitted.push(text);
        },
      );
      assert.equal(source, "template");
      assert.equal(draft.templateId, "crm");
      assert.equal(
        emitted.length,
        0,
        "legacy template path emits no prose deltas",
      );
    },
  );
});

test("generateAppDraftWithLLM backward compat: PACKETAGENT_FILETREE_CODEGEN=1 is a no-op", async () => {
  // Setting the old opt-in flag must not change behaviour now that the
  // path is on by default. With no provider key the result is the same
  // template fallback as the default-on test above.
  await withScrubbedEnv(
    { PACKETAGENT_FILETREE_CODEGEN: "1" },
    async () => {
      const { draft, source } = await generateAppDraftWithLLM(
        "Build a CRM for sales teams to track leads and deals.",
        {},
      );
      assert.equal(source, "template");
      assert.equal(draft.templateId, "crm");
    },
  );
});

test("generateAppDraftWithLLM file-tree path returns files and validation errors", async () => {
  await withScrubbedEnv({}, async () => {
    const result = await generateAppDraftWithLLM(
      "Build a focused dashboard for shop-floor maintenance tasks.",
      {
        fileTreeAuthorFn: async () => ({
          files: [
            { path: "index.html", content: "<div id=\"root\"></div>" },
            { path: "src/App.tsx", content: "export default function App(){ return <main>Maintenance</main>; }" },
          ],
          summary: "Maintenance dashboard",
          source: "llm",
          validation: {
            ok: false,
            source: "real",
            errors: [{ file: "src/App.tsx", line: 1, message: "JSX namespace missing", severity: "error", phase: "typecheck" }],
            warnings: [],
            durationMs: 15,
            phases: { typecheck: "failed", build: "skipped" },
          },
          repairAttempts: 2,
          stoppedReason: "max-attempts",
        }),
      },
    );

    assert.equal(result.source, "llm-filetree");
    assert.equal(result.files?.length, 2);
    assert.deepEqual(result.validationErrors, ["src/App.tsx:1: JSX namespace missing"]);
    assert.equal(result.draft.appName.length > 0, true);
  });
});
