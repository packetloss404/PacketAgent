import type { IntegrationReadinessSummary } from "./packetagent-services.js";

export type IntegrationMarketplaceCardId =
  | "openai"
  | "anthropic"
  | "ollama-local"
  | "custom-api-provider"
  | "slack-webhook"
  | "email"
  | "github-webhook"
  | "browser-scraping"
  | "stripe-payments"
  | "database";

export type IntegrationMarketplaceCategory =
  | "model_provider"
  | "notification"
  | "webhook"
  | "automation"
  | "payments"
  | "data";

export type IntegrationMarketplaceReadinessStatus = "ready" | "needs_config" | "available" | "blocked";
export type IntegrationMarketplaceFieldKind = "string" | "secret" | "url" | "boolean" | "select";
export type IntegrationMarketplaceTestMethod = "GET" | "POST";

export interface IntegrationMarketplaceField {
  key: string;
  label: string;
  kind: IntegrationMarketplaceFieldKind;
  required: boolean;
  env?: string;
  placeholder?: string;
  options?: string[];
}

export interface IntegrationMarketplaceConfigPayload {
  mode: "env" | "workspace_provider" | "tool" | "external";
  requiredEnv: string[];
  optionalEnv: string[];
  fields: IntegrationMarketplaceField[];
  secretsRedacted: true;
}

export interface IntegrationMarketplaceTestPayload {
  method: IntegrationMarketplaceTestMethod;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  expected: string[];
}

export interface IntegrationMarketplaceReadiness {
  status: IntegrationMarketplaceReadinessStatus;
  ready: boolean;
  configured: boolean;
  blockers: string[];
  warnings: string[];
}

export interface IntegrationMarketplaceCard {
  id: IntegrationMarketplaceCardId;
  title: string;
  category: IntegrationMarketplaceCategory;
  summary: string;
  useCases: string[];
  config: IntegrationMarketplaceConfigPayload;
  test: IntegrationMarketplaceTestPayload;
  readiness: IntegrationMarketplaceReadiness;
}

export interface IntegrationMarketplaceInput {
  readiness?: IntegrationReadinessSummary;
  env?: Record<string, string | undefined>;
}

export interface IntegrationMarketplaceSurface {
  version: "phase-71-lane-4";
  cards: IntegrationMarketplaceCard[];
  totals: {
    count: number;
    ready: number;
    needsConfig: number;
    available: number;
    blocked: number;
  };
}

interface CardDefinition {
  id: IntegrationMarketplaceCardId;
  title: string;
  category: IntegrationMarketplaceCategory;
  summary: string;
  useCases: string[];
  mode: IntegrationMarketplaceConfigPayload["mode"];
  requiredEnv: string[];
  optionalEnv?: string[];
  fields: IntegrationMarketplaceField[];
  test: IntegrationMarketplaceTestPayload;
  readiness: (input: NormalizedMarketplaceInput, definition: CardDefinition) => IntegrationMarketplaceReadiness;
}

interface NormalizedMarketplaceInput {
  readiness?: IntegrationReadinessSummary;
  env: Record<string, string | undefined>;
  toolNames: Set<string>;
  missingProviderKinds: Set<string>;
  missingApiKeyProviders: Set<string>;
  providerReadyCount: number;
}

const CARDS: CardDefinition[] = [
  {
    id: "openai",
    title: "OpenAI",
    category: "model_provider",
    summary: "Use OpenAI models for agent reasoning, drafting, extraction, and embeddings.",
    useCases: ["agent runs", "workflow drafting", "summaries", "embeddings"],
    mode: "workspace_provider",
    requiredEnv: ["OPENAI_API_KEY"],
    fields: [
      secretField("OPENAI_API_KEY", "API key"),
      stringField("OPENAI_MODEL", "Default model", false, "gpt-4o-mini"),
    ],
    test: providerTest("openai", "gpt-4o-mini"),
    readiness: providerReadiness("openai", ["OPENAI_API_KEY"]),
  },
  {
    id: "anthropic",
    title: "Anthropic",
    category: "model_provider",
    summary: "Use Claude models for agent reasoning, review, and long-context planning.",
    useCases: ["agent runs", "draft review", "long-context analysis"],
    mode: "workspace_provider",
    requiredEnv: ["ANTHROPIC_API_KEY"],
    fields: [
      secretField("ANTHROPIC_API_KEY", "API key"),
      stringField("ANTHROPIC_MODEL", "Default model", false, "claude-3-5-sonnet-latest"),
    ],
    test: providerTest("anthropic", "claude-3-5-sonnet-latest"),
    readiness: providerReadiness("anthropic", ["ANTHROPIC_API_KEY"]),
  },
  {
    id: "ollama-local",
    title: "Ollama/local",
    category: "model_provider",
    summary: "Route local development and private model calls to an Ollama runtime.",
    useCases: ["local agents", "private prototyping", "offline model tests"],
    mode: "workspace_provider",
    requiredEnv: ["OLLAMA_BASE_URL"],
    optionalEnv: ["OLLAMA_MODEL"],
    fields: [
      urlField("OLLAMA_BASE_URL", "Base URL", true, "http://localhost:11434"),
      stringField("OLLAMA_MODEL", "Default model", false, "llama3.2"),
    ],
    test: providerTest("ollama", "llama3.2"),
    readiness: providerReadiness("ollama", ["OLLAMA_BASE_URL"]),
  },
  {
    id: "custom-api-provider",
    title: "Custom API provider",
    category: "model_provider",
    summary: "Connect an OpenAI-compatible or internal model API without adding a first-class provider.",
    useCases: ["private gateways", "OpenAI-compatible APIs", "vendor pilots"],
    mode: "workspace_provider",
    requiredEnv: ["CUSTOM_PROVIDER_BASE_URL"],
    optionalEnv: ["CUSTOM_PROVIDER_API_KEY", "CUSTOM_PROVIDER_MODEL"],
    fields: [
      urlField("CUSTOM_PROVIDER_BASE_URL", "Base URL", true, "https://models.example.test/v1"),
      secretField("CUSTOM_PROVIDER_API_KEY", "API key", false),
      stringField("CUSTOM_PROVIDER_MODEL", "Default model", false, "custom-chat"),
    ],
    test: providerTest("custom", "custom-chat"),
    readiness: envReadiness(["CUSTOM_PROVIDER_BASE_URL"], ["CUSTOM_PROVIDER_API_KEY"]),
  },
  {
    id: "slack-webhook",
    title: "Slack/webhook",
    category: "notification",
    summary: "Send agent alerts and workflow notifications to Slack or compatible incoming webhooks.",
    useCases: ["team alerts", "incident handoff", "approval notifications"],
    mode: "external",
    requiredEnv: ["SLACK_WEBHOOK_URL"],
    fields: [
      urlField("SLACK_WEBHOOK_URL", "Webhook URL", true, "https://hooks.slack.com/services/..."),
      stringField("SLACK_DEFAULT_CHANNEL", "Default channel", false, "#alerts"),
    ],
    test: webhookTest("slack-webhook", { text: "PacketAgent test notification" }),
    readiness: envReadiness(["SLACK_WEBHOOK_URL"]),
  },
  {
    id: "email",
    title: "Email",
    category: "notification",
    summary: "Deliver invitations, receipts, reports, and generated-app notifications through an email provider.",
    useCases: ["invites", "receipts", "reports", "notifications"],
    mode: "env",
    requiredEnv: ["RESEND_API_KEY", "SENDGRID_API_KEY", "POSTMARK_TOKEN", "SMTP_URL"],
    fields: [
      selectField("EMAIL_PROVIDER", "Provider", true, ["resend", "sendgrid", "postmark", "smtp"]),
      secretField("EMAIL_PROVIDER_SECRET", "Provider secret"),
      stringField("EMAIL_FROM", "From address", false, "PacketAgent <notify@example.test>"),
    ],
    test: webhookTest("email", { to: "ops@example.test", subject: "PacketAgent email test" }),
    readiness: anyEnvReadiness(["RESEND_API_KEY", "SENDGRID_API_KEY", "POSTMARK_TOKEN", "SMTP_URL"]),
  },
  {
    id: "github-webhook",
    title: "GitHub webhook",
    category: "webhook",
    summary: "Receive GitHub events and connect repository actions to generated agents and apps.",
    useCases: ["PR triage", "issue sync", "release checks", "repository events"],
    mode: "external",
    requiredEnv: ["GITHUB_WEBHOOK_SECRET"],
    optionalEnv: ["GITHUB_TOKEN", "GH_TOKEN"],
    fields: [
      secretField("GITHUB_WEBHOOK_SECRET", "Webhook secret"),
      secretField("GITHUB_TOKEN", "Repository token", false),
    ],
    test: webhookTest("github-webhook", { action: "opened", repository: { full_name: "example/repo" } }),
    readiness: envReadiness(["GITHUB_WEBHOOK_SECRET"], ["GITHUB_TOKEN", "GH_TOKEN"]),
  },
  {
    id: "browser-scraping",
    title: "Browser scraping",
    category: "automation",
    summary: "Use browser tools for authenticated scraping, screenshots, and site extraction.",
    useCases: ["site extraction", "screenshots", "QA checks", "data import"],
    mode: "tool",
    requiredEnv: [],
    optionalEnv: ["BROWSER_SCRAPING_ALLOWED_DOMAINS"],
    fields: [
      stringField("BROWSER_SCRAPING_ALLOWED_DOMAINS", "Allowed domains", false, "example.test, docs.example.test"),
      booleanField("BROWSER_SCRAPING_RESPECT_ROBOTS", "Respect robots.txt", false),
    ],
    test: {
      method: "POST",
      path: "/api/app/tools/browser/test",
      headers: { "content-type": "application/json" },
      body: { url: "https://example.test", mode: "metadata" },
      expected: ["tool is available", "URL is allowed", "page metadata is returned"],
    },
    readiness: browserReadiness,
  },
  {
    id: "stripe-payments",
    title: "Stripe/payments",
    category: "payments",
    summary: "Enable checkout, subscription state, invoices, and payment webhook handling.",
    useCases: ["checkout", "subscriptions", "invoices", "payment events"],
    mode: "external",
    requiredEnv: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
    optionalEnv: ["STRIPE_PRICE_ID"],
    fields: [
      secretField("STRIPE_SECRET_KEY", "Secret key"),
      secretField("STRIPE_WEBHOOK_SECRET", "Webhook secret"),
      stringField("STRIPE_PRICE_ID", "Default price ID", false, "price_..."),
    ],
    test: webhookTest("stripe-payments", { type: "checkout.session.completed", data: { object: { id: "cs_test_123" } } }),
    readiness: envReadiness(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"], ["STRIPE_PRICE_ID"]),
  },
  {
    id: "database",
    title: "Database",
    category: "data",
    summary: "Back generated apps, workflow state, and durable records with a managed database.",
    useCases: ["CRUD apps", "agent state", "audit logs", "workspace data"],
    mode: "env",
    requiredEnv: ["DATABASE_URL", "PACKETAGENT_DATABASE_URL", "PACKETAGENT_MANAGED_DATABASE_URL"],
    optionalEnv: ["PACKETAGENT_STORE"],
    fields: [
      selectField("PACKETAGENT_STORE", "Store", true, ["postgres", "sqlite", "file", "memory"]),
      secretField("DATABASE_URL", "Database URL"),
    ],
    test: {
      method: "POST",
      path: "/api/app/integrations/database/test",
      headers: { "content-type": "application/json" },
      body: { dryRun: true, check: "database" },
      expected: ["store loads", "migrations are reachable", "write smoke can run"],
    },
    readiness: databaseReadiness,
  },
];

export function buildIntegrationMarketplace(input: IntegrationMarketplaceInput = {}): IntegrationMarketplaceSurface {
  const normalized = normalizeInput(input);
  const cards = CARDS.map((definition) => cardFromDefinition(definition, normalized));
  return {
    version: "phase-71-lane-4",
    cards,
    totals: {
      count: cards.length,
      ready: cards.filter((card) => card.readiness.status === "ready").length,
      needsConfig: cards.filter((card) => card.readiness.status === "needs_config").length,
      available: cards.filter((card) => card.readiness.status === "available").length,
      blocked: cards.filter((card) => card.readiness.status === "blocked").length,
    },
  };
}

function cardFromDefinition(definition: CardDefinition, input: NormalizedMarketplaceInput): IntegrationMarketplaceCard {
  return {
    id: definition.id,
    title: definition.title,
    category: definition.category,
    summary: definition.summary,
    useCases: definition.useCases,
    config: {
      mode: definition.mode,
      requiredEnv: definition.requiredEnv,
      optionalEnv: definition.optionalEnv ?? [],
      fields: definition.fields,
      secretsRedacted: true,
    },
    test: definition.test,
    readiness: definition.readiness(input, definition),
  };
}

function normalizeInput(input: IntegrationMarketplaceInput): NormalizedMarketplaceInput {
  return {
    readiness: input.readiness,
    env: input.env ?? {},
    toolNames: new Set(input.readiness?.tools.names.map((name) => name.toLowerCase()) ?? []),
    missingProviderKinds: new Set(input.readiness?.providers.missingProviderKinds.map((name) => name.toLowerCase()) ?? []),
    missingApiKeyProviders: new Set(input.readiness?.providers.missingApiKeys.map((entry) => entry.provider.toLowerCase()) ?? []),
    providerReadyCount: input.readiness?.providers.readyCount ?? 0,
  };
}

function providerReadiness(provider: string, requiredEnv: string[]) {
  return (input: NormalizedMarketplaceInput): IntegrationMarketplaceReadiness => {
    const missingEnv = requiredEnv.filter((name) => !hasValue(input.env[name]));
    const missingProviderRecord = input.missingProviderKinds.has(provider);
    const missingApiKey = input.missingApiKeyProviders.has(provider);
    const ready = !missingProviderRecord && !missingApiKey && (missingEnv.length === 0 || input.providerReadyCount > 0);
    const blockers = [
      ...(missingProviderRecord ? [`Add a ${provider} workspace provider record.`] : []),
      ...(missingApiKey ? [`Store or confirm the ${provider} API key for this workspace.`] : []),
      ...(missingEnv.length > 0 && input.providerReadyCount === 0 ? missingEnv.map((name) => `Set ${name} or configure a workspace provider.`) : []),
    ];
    return readinessResult(ready ? "ready" : "needs_config", blockers, []);
  };
}

function envReadiness(requiredEnv: string[], optionalEnv: string[] = []) {
  return (input: NormalizedMarketplaceInput): IntegrationMarketplaceReadiness => {
    const missing = requiredEnv.filter((name) => !hasValue(input.env[name]));
    const warnings = optionalEnv.filter((name) => !hasValue(input.env[name])).map((name) => `${name} is optional but recommended for live tests.`);
    return readinessResult(missing.length === 0 ? "ready" : "needs_config", missing.map((name) => `Set ${name}.`), missing.length === 0 ? warnings : []);
  };
}

function anyEnvReadiness(envNames: string[]) {
  return (input: NormalizedMarketplaceInput): IntegrationMarketplaceReadiness => {
    const ready = envNames.some((name) => hasValue(input.env[name]));
    return readinessResult(ready ? "ready" : "needs_config", ready ? [] : [`Set one of ${envNames.join(", ")}.`], []);
  };
}

function browserReadiness(input: NormalizedMarketplaceInput): IntegrationMarketplaceReadiness {
  const ready = ["browser", "browser-use", "playwright"].some((name) => input.toolNames.has(name));
  return readinessResult(ready ? "ready" : "available", [], ready ? [] : ["Enable browser-use or Playwright before live scraping."]);
}

function databaseReadiness(input: NormalizedMarketplaceInput): IntegrationMarketplaceReadiness {
  const store = String(input.env.PACKETAGENT_STORE ?? "").trim().toLowerCase();
  const hasDatabaseUrl = ["DATABASE_URL", "PACKETAGENT_DATABASE_URL", "PACKETAGENT_MANAGED_DATABASE_URL"].some((name) => hasValue(input.env[name]));
  const ready = hasDatabaseUrl || (store.length > 0 && store !== "memory");
  const blockers = ready ? [] : ["Set a database URL or use a non-memory PACKETAGENT_STORE."];
  const warnings = ready && store === "file" ? ["File-backed storage is local-only; use Postgres for multi-instance deployments."] : [];
  return readinessResult(ready ? "ready" : "needs_config", blockers, warnings);
}

function readinessResult(
  status: IntegrationMarketplaceReadinessStatus,
  blockers: string[],
  warnings: string[],
): IntegrationMarketplaceReadiness {
  return {
    status,
    ready: status === "ready",
    configured: status === "ready" || status === "blocked",
    blockers,
    warnings,
  };
}

function providerTest(provider: string, model: string): IntegrationMarketplaceTestPayload {
  return {
    method: "POST",
    path: "/api/app/llm/test",
    headers: { "content-type": "application/json" },
    body: { provider, model, prompt: "Reply with ok." },
    expected: ["provider resolves", "credentials are present", "test completion succeeds"],
  };
}

function webhookTest(kind: string, sample: Record<string, unknown>): IntegrationMarketplaceTestPayload {
  return {
    method: "POST",
    path: `/api/app/integrations/${kind}/test`,
    headers: { "content-type": "application/json" },
    body: { dryRun: true, sample },
    expected: ["payload validates", "secret is configured", "dry run avoids external mutation"],
  };
}

function secretField(env: string, label: string, required = true): IntegrationMarketplaceField {
  return { key: env.toLowerCase(), label, kind: "secret", required, env, placeholder: "stored server-side" };
}

function stringField(env: string, label: string, required: boolean, placeholder: string): IntegrationMarketplaceField {
  return { key: env.toLowerCase(), label, kind: "string", required, env, placeholder };
}

function urlField(env: string, label: string, required: boolean, placeholder: string): IntegrationMarketplaceField {
  return { key: env.toLowerCase(), label, kind: "url", required, env, placeholder };
}

function booleanField(key: string, label: string, required: boolean): IntegrationMarketplaceField {
  return { key: key.toLowerCase(), label, kind: "boolean", required, env: key };
}

function selectField(env: string, label: string, required: boolean, options: string[]): IntegrationMarketplaceField {
  return { key: env.toLowerCase(), label, kind: "select", required, env, options };
}

function hasValue(value: string | undefined): boolean {
  return String(value ?? "").trim().length > 0;
}
