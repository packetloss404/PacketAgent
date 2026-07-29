import {
  generateAppDraftFromPrompt,
  type AppDraft,
  type AppDraftTemplateId,
} from "./app-builder-service";
import { generateAgentDraftFromPrompt, type AgentDraft } from "./packetagent-services";

export type BuilderTemplateBetaCategory =
  | "sales_crm"
  | "booking_ops"
  | "internal_ops"
  | "customer_success";

export type GeneratedTestCheckKind = "smoke" | "unit" | "access" | "integration";

export type GeneratedTestCheck = {
  id: string;
  kind: GeneratedTestCheckKind;
  bundleId: string;
  target: "app" | "agent" | "bundle";
  title: string;
  assertions: string[];
  cleanup: string[];
};

export type GeneratedTestManifest = {
  version: "phase-72-lane-2";
  bundleIds: string[];
  checkKinds: GeneratedTestCheckKind[];
  checks: GeneratedTestCheck[];
  reliabilityCleanupGuidance: string[];
};

export type BuilderTemplateBetaBundle = {
  id: string;
  category: BuilderTemplateBetaCategory;
  appTemplateId: AppDraftTemplateId;
  app: AppDraft;
  agents: AgentDraft[];
  manifestTags: string[];
  reliabilityCleanupGuidance: string[];
};

export type BuilderTemplateBetaExpansionInput = {
  categories?: BuilderTemplateBetaCategory[];
  promptContext?: string;
};

export type BuilderTemplateBetaExpansion = {
  version: "phase-72-lane-2";
  categories: BuilderTemplateBetaCategory[];
  bundles: BuilderTemplateBetaBundle[];
  generatedTestManifest: GeneratedTestManifest;
};

type BuilderTemplateBetaDefinition = {
  id: BuilderTemplateBetaCategory;
  bundleId: string;
  appPrompt: string;
  appTemplateId: AppDraftTemplateId;
  agentPrompts: string[];
  manifestTags: string[];
  cleanupGuidance: string[];
};

const REQUIRED_CHECK_KINDS: readonly GeneratedTestCheckKind[] = [
  "smoke",
  "unit",
  "access",
  "integration",
];

const BETA_TEMPLATE_DEFINITIONS: readonly BuilderTemplateBetaDefinition[] = [
  {
    id: "sales_crm",
    bundleId: "beta-sales-crm",
    appTemplateId: "crm",
    appPrompt:
      "Build a CRM for sales teams to manage leads, accounts, deals, pipeline follow-up, and Slack webhook handoffs.",
    agentPrompts: [
      "Build an agent that reviews CRM deal changes each morning, summarizes stalled opportunities, and sends Slack webhook alerts to sales operators.",
      "Build an agent that monitors new CRM leads, scores urgency, and emails owners with the next best follow-up.",
    ],
    manifestTags: ["crm", "sales", "webhook", "email"],
    cleanupGuidance: [
      "Delete generated CRM seed leads, accounts, and deals after each integration run.",
      "Clear queued CRM alert deliveries before rerunning webhook or email checks.",
    ],
  },
  {
    id: "booking_ops",
    bundleId: "beta-booking-ops",
    appTemplateId: "booking",
    appPrompt:
      "Create a booking app for clinics with providers, appointment slots, public booking, calendar scheduling, and email confirmations.",
    agentPrompts: [
      "Build an agent that scans tomorrow's bookings, flags double-booking risks, and emails the clinic operations owner.",
      "Build a webhook agent that receives booking changes, verifies the appointment payload, and records a concise status summary.",
    ],
    manifestTags: ["booking", "calendar", "webhook", "email"],
    cleanupGuidance: [
      "Cancel generated appointment records and release reserved slots after smoke checks.",
      "Remove booking webhook replay payloads so repeated runs do not duplicate confirmations.",
    ],
  },
  {
    id: "internal_ops",
    bundleId: "beta-internal-ops",
    appTemplateId: "internal_dashboard",
    appPrompt:
      "Ship an internal dashboard for operations KPIs, reports, monitoring alerts, analytics, custom API pulls, and database persistence.",
    agentPrompts: [
      "Create a daily operations agent that calls a custom external API, summarizes KPI drift, and opens escalation notes for critical alerts.",
      "Create an agent that prepares a weekly internal dashboard brief from reports, alerts, and resolved incidents.",
    ],
    manifestTags: ["dashboard", "custom_api", "database", "reports"],
    cleanupGuidance: [
      "Reset generated metric snapshots, reports, and alert acknowledgements between reliability runs.",
      "Purge custom API fixture responses before changing mocked provider payloads.",
    ],
  },
  {
    id: "customer_success",
    bundleId: "beta-customer-success",
    appTemplateId: "customer_portal",
    appPrompt:
      "Create a customer portal with self-service requests, documents, invoices, customer login, Stripe checkout, and GitHub issue sync.",
    agentPrompts: [
      "Build an agent that watches customer portal requests, creates GitHub issues for bugs, sends Slack alerts, and emails owners.",
      "Build an agent that reviews Stripe billing notes and customer documents before summarizing account risks.",
    ],
    manifestTags: ["portal", "stripe", "github", "access"],
    cleanupGuidance: [
      "Delete generated customer portal requests, uploaded document fixtures, and invoice records after each test pass.",
      "Remove generated GitHub issue links and Stripe fixture IDs from bundle state before publishing.",
    ],
  },
];

export function listBuilderTemplateBetaCategories(): BuilderTemplateBetaCategory[] {
  return BETA_TEMPLATE_DEFINITIONS.map((definition) => definition.id);
}

export function expandBuilderTemplateBeta(
  input: BuilderTemplateBetaExpansionInput = {},
): BuilderTemplateBetaExpansion {
  const definitions = selectDefinitions(input.categories);
  const context = cleanPromptContext(input.promptContext);
  const bundles = definitions.map((definition) => expandDefinition(definition, context));
  const categories = definitions.map((definition) => definition.id);

  return {
    version: "phase-72-lane-2",
    categories,
    bundles,
    generatedTestManifest: buildGeneratedTestManifest(bundles),
  };
}

export function buildGeneratedTestManifest(
  bundles: BuilderTemplateBetaBundle[],
): GeneratedTestManifest {
  const checks = bundles.flatMap((bundle) => buildBundleChecks(bundle));
  const reliabilityCleanupGuidance = uniqueSorted([
    ...bundles.flatMap((bundle) => bundle.reliabilityCleanupGuidance),
    "Use isolated workspace IDs or deterministic fixture prefixes for generated app and agent beta runs.",
    "Clear generated agent preview runs, transcripts, tool-call fixtures, and pending deliveries before retrying failed checks.",
    "Keep provider secrets out of generated manifests; assert setup guidance by env var name only.",
  ]);

  return {
    version: "phase-72-lane-2",
    bundleIds: bundles.map((bundle) => bundle.id),
    checkKinds: [...REQUIRED_CHECK_KINDS],
    checks,
    reliabilityCleanupGuidance,
  };
}

function expandDefinition(
  definition: BuilderTemplateBetaDefinition,
  promptContext: string,
): BuilderTemplateBetaBundle {
  const appPrompt = withContext(definition.appPrompt, promptContext);
  const app = generateAppDraftFromPrompt(appPrompt);
  const agents = definition.agentPrompts.map((prompt) =>
    generateAgentDraftFromPrompt(withContext(prompt, promptContext)),
  );

  return {
    id: definition.bundleId,
    category: definition.id,
    appTemplateId: definition.appTemplateId,
    app,
    agents,
    manifestTags: [...definition.manifestTags],
    reliabilityCleanupGuidance: [...definition.cleanupGuidance],
  };
}

function buildBundleChecks(bundle: BuilderTemplateBetaBundle): GeneratedTestCheck[] {
  const integrationEnvVars = uniqueSorted([
    ...bundle.app.integrationMetadata.requested.flatMap((integration) => integration.envVars),
    ...bundle.agents.flatMap((agent) =>
      agent.integrationMetadata.requested.flatMap((integration) => integration.envVars),
    ),
  ]);
  const integrationEnvSummary =
    integrationEnvVars.length > 0 ? integrationEnvVars.join(", ") : "no provider env vars";

  return [
    {
      id: `${bundle.id}:smoke`,
      kind: "smoke",
      bundleId: bundle.id,
      target: "bundle",
      title: `Render ${bundle.app.appName} and save generated agents`,
      assertions: [
        "Generated app draft includes at least one page, component, entity, and API route.",
        "Every generated agent has instructions, a trigger, and a playbook with at least three steps.",
        "Generated seed data can render the primary private page without empty-state-only output.",
      ],
      cleanup: [
        "Remove generated app draft snapshots and preview agent run records for this bundle.",
      ],
    },
    {
      id: `${bundle.id}:unit`,
      kind: "unit",
      bundleId: bundle.id,
      target: "app",
      title: `Validate deterministic ${bundle.category} template expansion`,
      assertions: [
        `App template id remains ${bundle.appTemplateId}.`,
        "Repeating expansion with the same prompt returns identical app and agent bundle data.",
        "CRUD route contracts cover create, read, update, and delete for generated entities.",
      ],
      cleanup: ["Reset in-memory draft mutations before comparing repeated expansions."],
    },
    {
      id: `${bundle.id}:access`,
      kind: "access",
      bundleId: bundle.id,
      target: "app",
      title: `Check access policy for ${bundle.app.appName}`,
      assertions: [
        "Only routes listed as public are reachable without a session.",
        "Private pages and generated API routes require an authenticated workspace user.",
        "Admin routes require an admin role in addition to authentication.",
      ],
      cleanup: [
        "Delete generated sessions, test users, and role grants created for access checks.",
      ],
    },
    {
      id: `${bundle.id}:integration`,
      kind: "integration",
      bundleId: bundle.id,
      target: "bundle",
      title: `Exercise integration guidance for ${bundle.id}`,
      assertions: [
        `App integration setup routes describe missing env vars (${integrationEnvSummary}) without blocking unrelated draft features.`,
        `Agent integration playbook steps reference provider setup (${integrationEnvSummary}) before live tool execution.`,
        "Webhook, email, provider, payment, or database fixtures are isolated by bundle id.",
      ],
      cleanup: [
        ...bundle.reliabilityCleanupGuidance,
        "Clear generated env readiness overrides and external provider fixtures for this bundle.",
      ],
    },
  ];
}

function selectDefinitions(
  categories: BuilderTemplateBetaCategory[] | undefined,
): BuilderTemplateBetaDefinition[] {
  if (!categories || categories.length === 0) return [...BETA_TEMPLATE_DEFINITIONS];

  const requested = new Set(categories);
  const selected = BETA_TEMPLATE_DEFINITIONS.filter((definition) => requested.has(definition.id));
  const unknown = categories.filter(
    (category) => !BETA_TEMPLATE_DEFINITIONS.some((definition) => definition.id === category),
  );
  if (unknown.length > 0) {
    throw new Error(`unknown beta template categories: ${uniqueSorted(unknown).join(", ")}`);
  }
  return selected;
}

function cleanPromptContext(value: string | undefined): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function withContext(prompt: string, context: string): string {
  return context ? `${prompt} Context: ${context}` : prompt;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
