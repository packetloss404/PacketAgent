export type AppIterationToolCategory =
  | "openai_provider"
  | "webhook_email"
  | "github"
  | "stripe_payment"
  | "browser_scrape"
  | "database";

export type AppIterationToolRequestKind = "provider" | "connector" | "runtime_tool" | "infrastructure";
export type AppIterationToolReadinessStatus = "not_requested" | "ready" | "needs_setup" | "blocked";

export interface GeneratedAppDraftToolContext {
  appName?: string;
  summary?: string;
  pages?: unknown[];
  apiRoutes?: unknown[];
  dataModels?: unknown[];
  integrations?: unknown[];
  env?: Record<string, string | undefined>;
  notes?: unknown[];
  [key: string]: unknown;
}

export interface AppIterationToolSetupInput {
  env?: Record<string, string | undefined>;
  availableTools?: string[];
  connectedConnectors?: string[];
  providers?: {
    configured?: boolean;
    openai?: boolean;
    anthropic?: boolean;
    localModel?: boolean;
  };
  webhookEmail?: {
    publicBaseUrl?: string;
    signingSecretConfigured?: boolean;
    emailProviderConfigured?: boolean;
  };
  github?: {
    connectorConnected?: boolean;
    tokenConfigured?: boolean;
  };
  stripe?: {
    secretKeyConfigured?: boolean;
    webhookSecretConfigured?: boolean;
    priceConfigured?: boolean;
  };
  browser?: {
    browserToolAvailable?: boolean;
    scrapingAllowed?: boolean;
  };
  database?: {
    configured?: boolean;
    migrationsReady?: boolean;
    writable?: boolean;
  };
}

export interface AppIterationToolsInput extends AppIterationToolSetupInput {
  draft?: GeneratedAppDraftToolContext;
  changePrompt?: string;
}

export interface AppIterationToolRequest {
  category: AppIterationToolCategory;
  requestKind: AppIterationToolRequestKind;
  label: string;
  requestedTool: string;
  readinessStatus: AppIterationToolReadinessStatus;
  ready: boolean;
  missingSetup: string[];
  canProceedWithout: boolean;
  requiresLiveSetup: boolean;
  sourceSignals: string[];
  rationale: string;
}

export interface AppIterationToolsReadiness {
  version: "phase-69-lane-4";
  readinessStatus: AppIterationToolReadinessStatus;
  canProceed: boolean;
  canProceedWithoutRequests: boolean;
  requestedCategories: AppIterationToolCategory[];
  requests: AppIterationToolRequest[];
  missingSetup: string[];
  nextSteps: string[];
}

interface ToolCategorySpec {
  category: AppIterationToolCategory;
  requestKind: AppIterationToolRequestKind;
  label: string;
  requestedTool: string;
  draftableWithoutLiveSetup: boolean;
  signals: Array<{
    label: string;
    pattern: RegExp;
  }>;
  livePatterns: RegExp[];
}

const CATEGORY_SPECS: readonly ToolCategorySpec[] = [
  {
    category: "openai_provider",
    requestKind: "provider",
    label: "OpenAI or model provider",
    requestedTool: "model-provider",
    draftableWithoutLiveSetup: true,
    signals: [
      { label: "openai", pattern: /\bopenai\b/i },
      { label: "gpt", pattern: /\bgpt[-\w.]*\b/i },
      { label: "llm", pattern: /\bllm\b|\blanguage model\b/i },
      { label: "ai", pattern: /\bai\b|\bartificial intelligence\b/i },
      { label: "embedding", pattern: /\bembedding(s)?\b|\bvector search\b/i },
      { label: "anthropic", pattern: /\banthropic\b|\bclaude\b/i },
    ],
    livePatterns: [
      /\b(call|invoke|stream|generate|embed|classify|summari[sz]e|moderate)\b.*\b(model|openai|gpt|llm|ai|provider)\b/i,
      /\b(real|live|production)\b.*\b(model|openai|gpt|llm|ai)\b/i,
    ],
  },
  {
    category: "webhook_email",
    requestKind: "connector",
    label: "Webhook or email delivery",
    requestedTool: "webhook-email-connector",
    draftableWithoutLiveSetup: true,
    signals: [
      { label: "webhook", pattern: /\bwebhook(s)?\b|\binbound event(s)?\b/i },
      { label: "email", pattern: /\bemail(s)?\b|\bsmtp\b|\bresend\b|\bsendgrid\b|\bpostmark\b/i },
      { label: "notification", pattern: /\bnotification(s)?\b|\binvite(s|d)?\b/i },
    ],
    livePatterns: [
      /\b(send|deliver|receive|verify|sign|publish)\b.*\b(email|webhook|notification|invite)\b/i,
      /\b(real|live|production)\b.*\b(email|webhook|notification)\b/i,
    ],
  },
  {
    category: "github",
    requestKind: "connector",
    label: "GitHub connector",
    requestedTool: "github-connector",
    draftableWithoutLiveSetup: true,
    signals: [
      { label: "github", pattern: /\bgithub\b|\bgh\b/i },
      { label: "pull-request", pattern: /\bpull request(s)?\b|\bpr(s)?\b/i },
      { label: "issue", pattern: /\bissue(s)?\b|\brepo(sitory)?\b|\bcommit(s)?\b/i },
    ],
    livePatterns: [
      /\b(create|open|comment|sync|merge|push|clone|fetch|read|list)\b.*\b(github|issue|pull request|pr|repo|commit)\b/i,
      /\b(real|live)\b.*\b(github|repo|issue|pull request|pr)\b/i,
    ],
  },
  {
    category: "stripe_payment",
    requestKind: "connector",
    label: "Stripe payment connector",
    requestedTool: "stripe-connector",
    draftableWithoutLiveSetup: true,
    signals: [
      { label: "stripe", pattern: /\bstripe\b/i },
      { label: "payment", pattern: /\bpayment(s)?\b|\bcheckout\b|\bsubscription(s)?\b|\binvoice(s)?\b|\bbilling\b/i },
      { label: "price", pattern: /\bprice id\b|\bpricing\b|\bcustomer portal\b/i },
    ],
    livePatterns: [
      /\b(charge|checkout|subscribe|invoice|bill|refund|collect)\b/i,
      /\b(real|live|production)\b.*\b(payment|stripe|checkout|subscription|billing)\b/i,
    ],
  },
  {
    category: "browser_scrape",
    requestKind: "runtime_tool",
    label: "Browser or scraping tool",
    requestedTool: "browser-scrape-tool",
    draftableWithoutLiveSetup: true,
    signals: [
      { label: "browser", pattern: /\bbrowser\b|\bplaywright\b|\bpuppeteer\b/i },
      { label: "scrape", pattern: /\bscrap(e|ing|er)\b|\bcrawl(er|ing)?\b|\bextract from (a )?(site|url|page)\b/i },
      { label: "website", pattern: /\bwebsite\b|\bweb page\b|\burl\b|\bscreenshot\b/i },
    ],
    livePatterns: [
      /\b(scrape|crawl|extract|open|visit|screenshot|read)\b.*\b(site|url|page|website|browser)\b/i,
      /\b(real|live)\b.*\b(scrape|crawl|browser|website)\b/i,
    ],
  },
  {
    category: "database",
    requestKind: "infrastructure",
    label: "Database runtime",
    requestedTool: "database-runtime",
    draftableWithoutLiveSetup: false,
    signals: [
      { label: "database", pattern: /\bdatabase\b|\bpostgres\b|\bsql\b|\bsqlite\b/i },
      { label: "crud", pattern: /\bcrud\b|\bcreate\/read\/update\/delete\b/i },
      { label: "data-model", pattern: /\bdata model(s)?\b|\bschema\b|\btable(s)?\b|\bmigration(s)?\b/i },
      { label: "persistence", pattern: /\bpersist(s|ed|ence)?\b|\bsave records\b|\bstored records\b/i },
    ],
    livePatterns: [
      /\b(create|read|update|delete|persist|save|query|migrate|seed)\b.*\b(record(s)?|row(s)?|table(s)?|database|schema|model(s)?)\b/i,
      /\b(real|live|production|persistent)\b.*\b(data|database|crud|record)\b/i,
    ],
  },
];

const EMAIL_SIGNAL_PATTERN = /\bemail(s)?\b|\bsmtp\b|\bresend\b|\bsendgrid\b|\bpostmark\b|\binvite(s|d)?\b/i;
const WEBHOOK_SIGNAL_PATTERN = /\bwebhook(s)?\b|\binbound event(s)?\b/i;

export function inspectAppIterationTools(input: AppIterationToolsInput = {}): AppIterationToolsReadiness {
  const env = { ...(input.draft?.env ?? {}), ...(input.env ?? {}) };
  const promptText = normalizeText(input.changePrompt);
  const draftText = normalizeText(flattenDraftText(input.draft));
  const requests = CATEGORY_SPECS
    .map((spec) => buildToolRequest(spec, input, env, draftText, promptText))
    .filter((request): request is AppIterationToolRequest => Boolean(request));
  const missingSetup = uniqueSorted(requests.flatMap((request) => request.missingSetup));
  const nextSteps = uniqueSorted(requests.flatMap((request) => request.ready ? [] : request.missingSetup));
  const canProceed = requests.every((request) => request.ready || request.canProceedWithout);
  const canProceedWithoutRequests = requests.every((request) => request.canProceedWithout);
  const blocked = requests.some((request) => request.readinessStatus === "blocked");
  const needsSetup = requests.some((request) => request.readinessStatus === "needs_setup");

  return {
    version: "phase-69-lane-4",
    readinessStatus: requests.length === 0 ? "not_requested" : blocked ? "blocked" : needsSetup ? "needs_setup" : "ready",
    canProceed,
    canProceedWithoutRequests,
    requestedCategories: requests.map((request) => request.category),
    requests,
    missingSetup,
    nextSteps,
  };
}

export function detectAppIterationToolCategories(input: AppIterationToolsInput = {}): AppIterationToolCategory[] {
  return inspectAppIterationTools(input).requestedCategories;
}

function buildToolRequest(
  spec: ToolCategorySpec,
  input: AppIterationToolsInput,
  env: Record<string, string | undefined>,
  draftText: string,
  promptText: string,
): AppIterationToolRequest | null {
  const sourceSignals = collectSourceSignals(spec, draftText, promptText);
  if (sourceSignals.length === 0) return null;

  const readiness = readinessForSpec(spec.category, input, env, `${draftText}\n${promptText}`);
  const requiresLiveSetup = spec.livePatterns.some((pattern) => pattern.test(promptText));
  const ready = readiness.missingSetup.length === 0;
  const canProceedWithout = ready || (spec.draftableWithoutLiveSetup && !requiresLiveSetup);
  const readinessStatus: AppIterationToolReadinessStatus = ready
    ? "ready"
    : canProceedWithout ? "needs_setup" : "blocked";

  return {
    category: spec.category,
    requestKind: spec.requestKind,
    label: spec.label,
    requestedTool: spec.requestedTool,
    readinessStatus,
    ready,
    missingSetup: readiness.missingSetup,
    canProceedWithout,
    requiresLiveSetup,
    sourceSignals,
    rationale: ready
      ? `${spec.label} setup is available for this iteration.`
      : canProceedWithout
        ? `${spec.label} is requested, but this scoped iteration can continue with draft-safe placeholders.`
        : `${spec.label} is required by the scoped prompt before the iteration can run safely.`,
  };
}

function readinessForSpec(
  category: AppIterationToolCategory,
  input: AppIterationToolsInput,
  env: Record<string, string | undefined>,
  combinedText: string,
): { missingSetup: string[] } {
  switch (category) {
    case "openai_provider":
      return {
        missingSetup: hasModelProvider(input, env) ? [] : [
          "Configure OPENAI_API_KEY, ANTHROPIC_API_KEY, OLLAMA_BASE_URL, or connect a model provider.",
        ],
      };
    case "webhook_email":
      return webhookEmailReadiness(input, env, combinedText);
    case "github":
      return {
        missingSetup: hasGitHubConnector(input, env) ? [] : [
          "Connect the GitHub connector or configure GITHUB_TOKEN before live repository actions.",
        ],
      };
    case "stripe_payment":
      return stripeReadiness(input, env);
    case "browser_scrape":
      return browserReadiness(input);
    case "database":
      return databaseReadiness(input);
  }
}

function webhookEmailReadiness(
  input: AppIterationToolsInput,
  env: Record<string, string | undefined>,
  combinedText: string,
): { missingSetup: string[] } {
  const needsEmail = EMAIL_SIGNAL_PATTERN.test(combinedText);
  const needsWebhook = WEBHOOK_SIGNAL_PATTERN.test(combinedText);
  const emailReady = input.webhookEmail?.emailProviderConfigured === true
    || hasAnyEnv(env, ["RESEND_API_KEY", "SENDGRID_API_KEY", "POSTMARK_TOKEN", "SMTP_URL", "PACKETAGENT_EMAIL_PROVIDER_READY"]);
  const publicBaseUrlReady = hasValue(input.webhookEmail?.publicBaseUrl) || hasAnyEnv(env, ["PACKETAGENT_PUBLIC_BASE_URL", "PACKETAGENT_PUBLIC_APP_BASE_URL"]);
  const signingReady = input.webhookEmail?.signingSecretConfigured === true || hasAnyEnv(env, ["PACKETAGENT_WEBHOOK_SIGNING_SECRET"]);
  const missingSetup = [
    ...(needsEmail && !emailReady ? ["Configure an email delivery provider such as RESEND_API_KEY, SENDGRID_API_KEY, POSTMARK_TOKEN, or SMTP_URL."] : []),
    ...(needsWebhook && !publicBaseUrlReady ? ["Set PACKETAGENT_PUBLIC_BASE_URL before publishing external webhook URLs."] : []),
    ...(needsWebhook && !signingReady ? ["Configure PACKETAGENT_WEBHOOK_SIGNING_SECRET for signed inbound webhook requests."] : []),
  ];

  return { missingSetup };
}

function stripeReadiness(input: AppIterationToolsInput, env: Record<string, string | undefined>): { missingSetup: string[] } {
  const secretReady = input.stripe?.secretKeyConfigured === true || hasAnyEnv(env, ["STRIPE_SECRET_KEY"]);
  const webhookReady = input.stripe?.webhookSecretConfigured === true || hasAnyEnv(env, ["STRIPE_WEBHOOK_SECRET"]);
  const priceReady = input.stripe?.priceConfigured === true || hasAnyEnv(env, ["STRIPE_PRICE_ID"]);
  return {
    missingSetup: [
      ...(!secretReady ? ["Configure STRIPE_SECRET_KEY before creating live checkout or payment actions."] : []),
      ...(!webhookReady ? ["Configure STRIPE_WEBHOOK_SECRET before trusting Stripe payment events."] : []),
      ...(!priceReady ? ["Configure STRIPE_PRICE_ID or map generated plans to Stripe prices."] : []),
    ],
  };
}

function browserReadiness(input: AppIterationToolsInput): { missingSetup: string[] } {
  const availableTools = normalizedSet(input.availableTools);
  const connectorNames = normalizedSet(input.connectedConnectors);
  const browserToolReady = input.browser?.browserToolAvailable === true
    || availableTools.has("browser")
    || availableTools.has("browser-use")
    || availableTools.has("playwright")
    || connectorNames.has("browser")
    || connectorNames.has("browser-use");
  const scrapingAllowed = input.browser?.scrapingAllowed !== false;

  return {
    missingSetup: [
      ...(!browserToolReady ? ["Enable a browser automation or scraping tool before live page extraction."] : []),
      ...(!scrapingAllowed ? ["Confirm scraping is allowed for the target site before running extraction."] : []),
    ],
  };
}

function databaseReadiness(input: AppIterationToolsInput): { missingSetup: string[] } {
  const database = input.database;
  const configured = database?.configured ?? true;
  const migrationsReady = database?.migrationsReady ?? configured;
  const writable = database?.writable ?? configured;

  return {
    missingSetup: [
      ...(!configured ? ["Configure a generated-app database runtime before persistence or CRUD changes."] : []),
      ...(!migrationsReady ? ["Run or confirm generated-app database migrations before this iteration."] : []),
      ...(!writable ? ["Confirm the generated-app database is writable before mutating records."] : []),
    ],
  };
}

function hasModelProvider(input: AppIterationToolsInput, env: Record<string, string | undefined>): boolean {
  const availableTools = normalizedSet(input.availableTools);
  const connectors = normalizedSet(input.connectedConnectors);
  return input.providers?.configured === true
    || input.providers?.openai === true
    || input.providers?.anthropic === true
    || input.providers?.localModel === true
    || hasAnyEnv(env, ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_BASE_URL", "PACKETAGENT_AI_PROVIDER_READY"])
    || availableTools.has("openai")
    || connectors.has("openai")
    || connectors.has("anthropic");
}

function hasGitHubConnector(input: AppIterationToolsInput, env: Record<string, string | undefined>): boolean {
  const availableTools = normalizedSet(input.availableTools);
  const connectors = normalizedSet(input.connectedConnectors);
  return input.github?.connectorConnected === true
    || input.github?.tokenConfigured === true
    || hasAnyEnv(env, ["GITHUB_TOKEN", "GH_TOKEN"])
    || availableTools.has("github")
    || connectors.has("github");
}

function collectSourceSignals(spec: ToolCategorySpec, draftText: string, promptText: string): string[] {
  const signals: string[] = [];
  for (const signal of spec.signals) {
    if (signal.pattern.test(draftText)) signals.push(`draft:${signal.label}`);
    if (signal.pattern.test(promptText)) signals.push(`prompt:${signal.label}`);
  }
  return uniqueSorted(signals);
}

function flattenDraftText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(flattenDraftText).filter(Boolean).join(" ");
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${key} ${flattenDraftText((value as Record<string, unknown>)[key])}`)
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

function normalizeText(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizedSet(values: string[] | undefined): Set<string> {
  return new Set((values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean));
}

function hasAnyEnv(env: Record<string, string | undefined>, keys: string[]): boolean {
  return keys.some((key) => hasValue(env[key]));
}

function hasValue(value: string | undefined): boolean {
  return String(value ?? "").trim().length > 0;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
