export type PromptIntegrationId =
  | "openai"
  | "anthropic"
  | "ollama_local"
  | "custom_api"
  | "slack_webhook"
  | "email"
  | "github_webhook"
  | "browser_scraping"
  | "stripe_payments"
  | "database";

export type PromptIntegrationKind = "provider" | "connector" | "runtime_tool" | "infrastructure";
export type PromptIntegrationStatus = "not_requested" | "ready" | "needs_setup";

export interface PromptIntegrationFeatureContext {
  id?: string;
  featureId?: string;
  name?: string;
  title?: string;
  summary?: string;
  description?: string;
  prompt?: string;
  instructions?: string;
  integrations?: unknown[];
  tools?: unknown[];
  env?: Record<string, string | undefined>;
  [key: string]: unknown;
}

export interface PromptIntegrationDraftContext {
  summary?: string;
  description?: string;
  instructions?: string;
  features?: PromptIntegrationFeatureContext[];
  pages?: unknown[];
  apiRoutes?: unknown[];
  dataModels?: unknown[];
  integrations?: unknown[];
  tools?: unknown[];
  env?: Record<string, string | undefined>;
  [key: string]: unknown;
}

export interface IntegrationPromptDetectionInput {
  prompt?: string;
  draft?: PromptIntegrationDraftContext;
  features?: PromptIntegrationFeatureContext[];
  env?: Record<string, string | undefined>;
  availableTools?: string[];
  connectedConnectors?: string[];
  providers?: {
    configured?: boolean;
    openai?: boolean;
    anthropic?: boolean;
    localModel?: boolean;
    customApi?: boolean;
  };
  webhook?: {
    publicBaseUrl?: string;
    signingSecretConfigured?: boolean;
  };
  email?: {
    providerConfigured?: boolean;
  };
  github?: {
    connectorConnected?: boolean;
    webhookSecretConfigured?: boolean;
    tokenConfigured?: boolean;
  };
  browser?: {
    browserToolAvailable?: boolean;
    scrapingAllowed?: boolean;
  };
  stripe?: {
    secretKeyConfigured?: boolean;
    webhookSecretConfigured?: boolean;
    priceConfigured?: boolean;
  };
  database?: {
    configured?: boolean;
    migrationsReady?: boolean;
    writable?: boolean;
  };
}

export interface PromptIntegrationRequest {
  id: PromptIntegrationId;
  kind: PromptIntegrationKind;
  label: string;
  status: PromptIntegrationStatus;
  ready: boolean;
  affectedFeatureIds: string[];
  blockingFeatureIds: string[];
  requiredSecrets: string[];
  missingSetupPrompts: string[];
  sourceSignals: string[];
}

export interface PromptIntegrationFeatureBlock {
  featureId: string;
  integrationIds: PromptIntegrationId[];
  missingSetupPrompts: string[];
}

export interface IntegrationPromptDetectionResult {
  version: "phase-71-lane-1";
  status: PromptIntegrationStatus;
  canContinueDrafting: boolean;
  requestedIntegrationIds: PromptIntegrationId[];
  requestedIntegrations: PromptIntegrationRequest[];
  affectedFeatureIds: string[];
  blockedFeatureIds: string[];
  unblockedFeatureIds: string[];
  missingSetupPrompts: string[];
  featureBlocks: PromptIntegrationFeatureBlock[];
}

interface IntegrationSpec {
  id: PromptIntegrationId;
  kind: PromptIntegrationKind;
  label: string;
  requiredSecrets: string[];
  signals: Array<{ label: string; pattern: RegExp }>;
  readiness: (
    input: IntegrationPromptDetectionInput,
    env: Record<string, string | undefined>,
    combinedText: string,
  ) => string[];
}

const EMAIL_ENV_KEYS = ["RESEND_API_KEY", "SENDGRID_API_KEY", "POSTMARK_TOKEN", "SMTP_URL"];
const DATABASE_ENV_KEYS = [
  "DATABASE_URL",
  "PACKETAGENT_DATABASE_URL",
  "PACKETAGENT_MANAGED_DATABASE_URL",
];
const GITHUB_ENV_KEYS = ["GITHUB_TOKEN", "GH_TOKEN"];
const CUSTOM_API_ENV_KEYS = [
  "CUSTOM_API_BASE_URL",
  "CUSTOM_API_KEY",
  "PACKETAGENT_CUSTOM_API_BASE_URL",
  "PACKETAGENT_CUSTOM_API_KEY",
];
const WEBHOOK_ENV_KEYS = [
  "PACKETAGENT_PUBLIC_APP_BASE_URL",
  "PACKETAGENT_PUBLIC_BASE_URL",
  "PACKETAGENT_WEBHOOK_SIGNING_SECRET",
];
const STRIPE_ENV_KEYS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_ID"];

const INTEGRATION_SPECS: readonly IntegrationSpec[] = [
  {
    id: "openai",
    kind: "provider",
    label: "OpenAI",
    requiredSecrets: ["OPENAI_API_KEY"],
    signals: [
      { label: "openai", pattern: /\bopenai\b/i },
      { label: "gpt", pattern: /\bgpt[-\w.]*\b|\bchatgpt\b/i },
      { label: "embedding", pattern: /\bembedding(s)?\b|\btext-embedding[-\w.]*\b/i },
    ],
    readiness: (input, env) =>
      input.providers?.openai === true || hasValue(env.OPENAI_API_KEY)
        ? []
        : ["Add OPENAI_API_KEY before running OpenAI-backed features."],
  },
  {
    id: "anthropic",
    kind: "provider",
    label: "Anthropic",
    requiredSecrets: ["ANTHROPIC_API_KEY"],
    signals: [
      { label: "anthropic", pattern: /\banthropic\b/i },
      { label: "claude", pattern: /\bclaude\b/i },
    ],
    readiness: (input, env) =>
      input.providers?.anthropic === true || hasValue(env.ANTHROPIC_API_KEY)
        ? []
        : ["Add ANTHROPIC_API_KEY before running Anthropic/Claude-backed features."],
  },
  {
    id: "ollama_local",
    kind: "provider",
    label: "Ollama or local model",
    requiredSecrets: ["OLLAMA_BASE_URL"],
    signals: [
      { label: "ollama", pattern: /\bollama\b/i },
      { label: "local-model", pattern: /\blocal (llm|model|ai)\b|\bself-hosted (llm|model)\b/i },
    ],
    readiness: (input, env) =>
      input.providers?.localModel === true || hasValue(env.OLLAMA_BASE_URL)
        ? []
        : [
            "Set OLLAMA_BASE_URL or connect a local model runtime before running local AI features.",
          ],
  },
  {
    id: "custom_api",
    kind: "connector",
    label: "Custom API",
    requiredSecrets: CUSTOM_API_ENV_KEYS,
    signals: [
      {
        label: "custom-api",
        pattern: /\bcustom api\b|\bapi-compatible\b|\bexternal api\b|\bthird[- ]party api\b/i,
      },
      { label: "rest", pattern: /\brest api\b|\bhttp api\b|\bapi key\b|\bbearer token\b/i },
    ],
    readiness: (input, env) =>
      input.providers?.customApi === true || hasAnyEnv(env, CUSTOM_API_ENV_KEYS)
        ? []
        : [
            "Provide the custom API base URL and secret, such as CUSTOM_API_BASE_URL and CUSTOM_API_KEY.",
          ],
  },
  {
    id: "slack_webhook",
    kind: "connector",
    label: "Slack or generic webhook",
    requiredSecrets: WEBHOOK_ENV_KEYS,
    signals: [
      { label: "slack", pattern: /\bslack\b/i },
      { label: "webhook", pattern: /\bwebhook(s)?\b|\binbound event(s)?\b|\boutgoing hook(s)?\b/i },
    ],
    readiness: (input, env) => {
      const publicBaseUrlReady =
        hasValue(input.webhook?.publicBaseUrl) ||
        hasAnyEnv(env, ["PACKETAGENT_PUBLIC_APP_BASE_URL", "PACKETAGENT_PUBLIC_BASE_URL"]);
      const signingReady =
        input.webhook?.signingSecretConfigured === true ||
        hasValue(env.PACKETAGENT_WEBHOOK_SIGNING_SECRET);
      return [
        ...(!publicBaseUrlReady
          ? [
              "Set PACKETAGENT_PUBLIC_APP_BASE_URL or PACKETAGENT_PUBLIC_BASE_URL before exposing webhook URLs.",
            ]
          : []),
        ...(!signingReady
          ? ["Set PACKETAGENT_WEBHOOK_SIGNING_SECRET before accepting signed webhook events."]
          : []),
      ];
    },
  },
  {
    id: "email",
    kind: "connector",
    label: "Email",
    requiredSecrets: EMAIL_ENV_KEYS,
    signals: [
      { label: "email", pattern: /\bemail(s)?\b|\bsmtp\b|\bresend\b|\bsendgrid\b|\bpostmark\b/i },
      {
        label: "notification",
        pattern: /\bemail notification(s)?\b|\binvite(s|d)?\b|\breceipt(s)?\b/i,
      },
    ],
    readiness: (input, env) =>
      input.email?.providerConfigured === true || hasAnyEnv(env, EMAIL_ENV_KEYS)
        ? []
        : [
            "Configure an email provider secret: RESEND_API_KEY, SENDGRID_API_KEY, POSTMARK_TOKEN, or SMTP_URL.",
          ],
  },
  {
    id: "github_webhook",
    kind: "connector",
    label: "GitHub webhook",
    requiredSecrets: ["GITHUB_WEBHOOK_SECRET", ...GITHUB_ENV_KEYS],
    signals: [
      {
        label: "github-webhook",
        pattern: /\bgithub\b.*\bwebhook(s)?\b|\bwebhook(s)?\b.*\bgithub\b/i,
      },
      {
        label: "github-events",
        pattern: /\bgithub\b.*\b(push|pull request|pr|issue|repo|repository|commit)\b/i,
      },
    ],
    readiness: (input, env) => {
      const connected =
        input.github?.connectorConnected === true ||
        input.github?.tokenConfigured === true ||
        hasAnyEnv(env, GITHUB_ENV_KEYS) ||
        normalizedSet(input.connectedConnectors).has("github") ||
        normalizedSet(input.availableTools).has("github");
      const webhookSecretReady =
        input.github?.webhookSecretConfigured === true ||
        hasValue(env.GITHUB_WEBHOOK_SECRET) ||
        hasValue(env.PACKETAGENT_WEBHOOK_SIGNING_SECRET);
      return [
        ...(!connected
          ? ["Connect GitHub or set GITHUB_TOKEN/GH_TOKEN before repository event actions."]
          : []),
        ...(!webhookSecretReady
          ? [
              "Set GITHUB_WEBHOOK_SECRET or PACKETAGENT_WEBHOOK_SIGNING_SECRET before trusting GitHub webhook events.",
            ]
          : []),
      ];
    },
  },
  {
    id: "browser_scraping",
    kind: "runtime_tool",
    label: "Browser scraping",
    requiredSecrets: [],
    signals: [
      { label: "browser", pattern: /\bbrowser\b|\bplaywright\b|\bpuppeteer\b/i },
      {
        label: "scrape",
        pattern:
          /\bscrap(e|ing|er)\b|\bcrawl(er|ing)?\b|\bextract from (a )?(site|url|page)\b|\bscreenshot\b/i,
      },
    ],
    readiness: (input) => {
      const tools = normalizedSet(input.availableTools);
      const connectors = normalizedSet(input.connectedConnectors);
      const toolReady =
        input.browser?.browserToolAvailable === true ||
        tools.has("browser") ||
        tools.has("browser-use") ||
        tools.has("playwright") ||
        connectors.has("browser") ||
        connectors.has("browser-use");
      return [
        ...(!toolReady
          ? [
              "Enable browser-use, Playwright, or another browser automation runtime before live scraping.",
            ]
          : []),
        ...(input.browser?.scrapingAllowed === false
          ? ["Confirm the target site permits scraping before running extraction."]
          : []),
      ];
    },
  },
  {
    id: "stripe_payments",
    kind: "connector",
    label: "Stripe or payments",
    requiredSecrets: STRIPE_ENV_KEYS,
    signals: [
      { label: "stripe", pattern: /\bstripe\b/i },
      {
        label: "payments",
        pattern:
          /\bpayment(s)?\b|\bcheckout\b|\bsubscription(s)?\b|\binvoice(s)?\b|\bbilling\b|\bcustomer portal\b/i,
      },
    ],
    readiness: (input, env) => {
      const secretReady =
        input.stripe?.secretKeyConfigured === true || hasValue(env.STRIPE_SECRET_KEY);
      const webhookReady =
        input.stripe?.webhookSecretConfigured === true || hasValue(env.STRIPE_WEBHOOK_SECRET);
      const priceReady = input.stripe?.priceConfigured === true || hasValue(env.STRIPE_PRICE_ID);
      return [
        ...(!secretReady
          ? ["Set STRIPE_SECRET_KEY before enabling live checkout or payment mutations."]
          : []),
        ...(!webhookReady
          ? ["Set STRIPE_WEBHOOK_SECRET before trusting Stripe payment events."]
          : []),
        ...(!priceReady
          ? ["Set STRIPE_PRICE_ID or map generated pricing plans to Stripe price IDs."]
          : []),
      ];
    },
  },
  {
    id: "database",
    kind: "infrastructure",
    label: "Database",
    requiredSecrets: DATABASE_ENV_KEYS,
    signals: [
      { label: "database", pattern: /\bdatabase\b|\bpostgres\b|\bsql\b|\bsqlite\b/i },
      { label: "crud", pattern: /\bcrud\b|\bcreate\/read\/update\/delete\b/i },
      {
        label: "schema",
        pattern: /\bschema\b|\btable(s)?\b|\bdata model(s)?\b|\bmigration(s)?\b/i,
      },
      {
        label: "persistence",
        pattern: /\bpersist(s|ed|ence)?\b|\bsave records\b|\bstored records\b/i,
      },
    ],
    readiness: (input, env) => {
      const configured = input.database?.configured === true || hasAnyEnv(env, DATABASE_ENV_KEYS);
      return [
        ...(!configured
          ? [
              "Configure DATABASE_URL, PACKETAGENT_DATABASE_URL, or another generated-app database runtime.",
            ]
          : []),
        ...(input.database?.migrationsReady === false
          ? ["Run or confirm generated-app database migrations for affected database features."]
          : []),
        ...(input.database?.writable === false
          ? ["Confirm the generated-app database user can write affected feature records."]
          : []),
      ];
    },
  },
];

export function inspectIntegrationPromptDetection(
  input: IntegrationPromptDetectionInput = {},
): IntegrationPromptDetectionResult {
  const env = { ...(input.draft?.env ?? {}), ...(input.env ?? {}) };
  const promptText = normalizeText(input.prompt);
  const draftText = normalizeText(flattenText(input.draft));
  const featureContexts = collectFeatureContexts(input);
  const combinedText = `${promptText}\n${draftText}`;
  const requestedIntegrations = INTEGRATION_SPECS.map((spec) =>
    buildIntegrationRequest(spec, input, env, promptText, draftText, featureContexts, combinedText),
  ).filter((request): request is PromptIntegrationRequest => Boolean(request));
  const featureBlocks = buildFeatureBlocks(requestedIntegrations);
  const blockedFeatureIds = uniqueSorted(featureBlocks.map((block) => block.featureId));
  const affectedFeatureIds = uniqueSorted(
    requestedIntegrations.flatMap((request) => request.affectedFeatureIds),
  );
  const allFeatureIds = uniqueSorted(featureContexts.map((feature) => feature.id));
  const missingSetupPrompts = uniqueSorted(
    requestedIntegrations.flatMap((request) => request.missingSetupPrompts),
  );
  const needsSetup = requestedIntegrations.some((request) => request.status === "needs_setup");

  return {
    version: "phase-71-lane-1",
    status:
      requestedIntegrations.length === 0 ? "not_requested" : needsSetup ? "needs_setup" : "ready",
    canContinueDrafting: true,
    requestedIntegrationIds: requestedIntegrations.map((request) => request.id),
    requestedIntegrations,
    affectedFeatureIds,
    blockedFeatureIds,
    unblockedFeatureIds: allFeatureIds.filter(
      (featureId) => !blockedFeatureIds.includes(featureId),
    ),
    missingSetupPrompts,
    featureBlocks,
  };
}

export function detectRequestedIntegrationIds(
  input: IntegrationPromptDetectionInput = {},
): PromptIntegrationId[] {
  return inspectIntegrationPromptDetection(input).requestedIntegrationIds;
}

function buildIntegrationRequest(
  spec: IntegrationSpec,
  input: IntegrationPromptDetectionInput,
  env: Record<string, string | undefined>,
  promptText: string,
  draftText: string,
  featureContexts: Array<{ id: string; text: string }>,
  combinedText: string,
): PromptIntegrationRequest | null {
  const sourceSignals = collectSignals(spec, promptText, draftText);
  const affectedFeatureIds = collectAffectedFeatureIds(
    spec,
    featureContexts,
    sourceSignals.length > 0,
  );
  if (sourceSignals.length === 0 && affectedFeatureIds.length === 0) return null;

  const missingSetupPrompts = uniqueSorted(spec.readiness(input, env, combinedText));
  const ready = missingSetupPrompts.length === 0;

  return {
    id: spec.id,
    kind: spec.kind,
    label: spec.label,
    status: ready ? "ready" : "needs_setup",
    ready,
    affectedFeatureIds,
    blockingFeatureIds: ready ? [] : affectedFeatureIds,
    requiredSecrets: spec.requiredSecrets,
    missingSetupPrompts,
    sourceSignals: uniqueSorted(sourceSignals),
  };
}

function collectSignals(spec: IntegrationSpec, promptText: string, draftText: string): string[] {
  const signals: string[] = [];
  for (const signal of spec.signals) {
    if (signal.pattern.test(promptText)) signals.push(`prompt:${signal.label}`);
    if (signal.pattern.test(draftText)) signals.push(`draft:${signal.label}`);
  }
  return signals;
}

function collectAffectedFeatureIds(
  spec: IntegrationSpec,
  featureContexts: Array<{ id: string; text: string }>,
  includePromptOnlyFallback: boolean,
): string[] {
  const matchedFeatureIds = featureContexts
    .filter((feature) => spec.signals.some((signal) => signal.pattern.test(feature.text)))
    .map((feature) => feature.id);

  if (matchedFeatureIds.length > 0) return uniqueSorted(matchedFeatureIds);
  return includePromptOnlyFallback ? ["draft"] : [];
}

function buildFeatureBlocks(requests: PromptIntegrationRequest[]): PromptIntegrationFeatureBlock[] {
  const blocksByFeature = new Map<string, PromptIntegrationFeatureBlock>();
  for (const request of requests) {
    if (request.ready) continue;
    for (const featureId of request.blockingFeatureIds) {
      const existing = blocksByFeature.get(featureId) ?? {
        featureId,
        integrationIds: [],
        missingSetupPrompts: [],
      };
      existing.integrationIds.push(request.id);
      existing.missingSetupPrompts.push(...request.missingSetupPrompts);
      blocksByFeature.set(featureId, existing);
    }
  }

  return [...blocksByFeature.values()]
    .map((block) => ({
      featureId: block.featureId,
      integrationIds: uniqueSorted(block.integrationIds) as PromptIntegrationId[],
      missingSetupPrompts: uniqueSorted(block.missingSetupPrompts),
    }))
    .sort((left, right) => left.featureId.localeCompare(right.featureId));
}

function collectFeatureContexts(
  input: IntegrationPromptDetectionInput,
): Array<{ id: string; text: string }> {
  const features = [...(input.draft?.features ?? []), ...(input.features ?? [])];
  if (
    features.length === 0 &&
    Array.isArray(input.draft?.dataModels) &&
    input.draft.dataModels.length > 0
  ) {
    return [{ id: "data-models", text: normalizeText(flattenText(input.draft.dataModels)) }];
  }

  return features.map((feature, index) => ({
    id: normalizeFeatureId(feature, index),
    text: normalizeText(flattenText(feature)),
  }));
}

function normalizeFeatureId(feature: PromptIntegrationFeatureContext, index: number): string {
  const candidate = feature.id ?? feature.featureId;
  return hasValue(candidate) ? String(candidate).trim() : `feature-${index + 1}`;
}

function flattenText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) return value.map(flattenText).filter(Boolean).join(" ");
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${key} ${flattenText((value as Record<string, unknown>)[key])}`)
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedSet(values: string[] | undefined): Set<string> {
  return new Set((values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean));
}

function hasAnyEnv(env: Record<string, string | undefined>, keys: string[]): boolean {
  return keys.some((key) => hasValue(env[key]));
}

function hasValue(value: unknown): boolean {
  return String(value ?? "").trim().length > 0;
}

function uniqueSorted<T extends string>(values: T[]): T[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean) as T[])].sort(
    (left, right) => left.localeCompare(right),
  );
}
