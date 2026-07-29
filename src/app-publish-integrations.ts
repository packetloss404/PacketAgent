export type AppPublishIntegrationCategory =
  | "provider_keys"
  | "webhook"
  | "email"
  | "payment"
  | "database"
  | "browser"
  | "github";

export type AppPublishIntegrationStatus = "not_required" | "ready" | "warning" | "blocked";
export type AppPublishIntegrationReadinessStatus = "ready" | "warnings" | "blocked";
export type AppPublishConnectorId =
  | "openai"
  | "anthropic"
  | "ollama"
  | "custom_api"
  | "slack_webhook"
  | "email"
  | "github_webhook"
  | "browser"
  | "stripe"
  | "database";

export interface GeneratedAppPublishIntegrationContext {
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

export interface AppPublishIntegrationsInput {
  draft?: GeneratedAppPublishIntegrationContext;
  env?: Record<string, string | undefined>;
  requiredEnv?: string[];
  optionalEnv?: string[];
  requiredProviderKeys?: string[];
  availableTools?: string[];
  connectedConnectors?: string[];
  connectors?: AppPublishConnectorInput[];
  providers?: {
    configured?: boolean;
    openai?: boolean;
    anthropic?: boolean;
    localModel?: boolean;
  };
  webhook?: {
    required?: boolean;
    publicBaseUrl?: string;
    signingSecretConfigured?: boolean;
  };
  email?: {
    required?: boolean;
    providerConfigured?: boolean;
  };
  payment?: {
    required?: boolean;
    secretKeyConfigured?: boolean;
    webhookSecretConfigured?: boolean;
    priceConfigured?: boolean;
  };
  database?: {
    required?: boolean;
    configured?: boolean;
    migrationsReady?: boolean;
    writable?: boolean;
    store?: string;
  };
  browser?: {
    required?: boolean;
    browserToolAvailable?: boolean;
    scrapingAllowed?: boolean;
  };
  github?: {
    required?: boolean;
    connectorConnected?: boolean;
    tokenConfigured?: boolean;
  };
}

export interface AppPublishConnectorInput {
  id: AppPublishConnectorId | string;
  label?: string;
  feature?: string;
  required?: boolean;
  configured?: boolean;
  connected?: boolean;
  testPassed?: boolean;
  requiredSecrets?: string[];
  missingSetup?: string[];
  warnings?: string[];
  setupGuide?: string[];
}

export interface AppPublishConnectorReadiness {
  id: string;
  label: string;
  feature: string;
  category: AppPublishIntegrationCategory;
  status: AppPublishIntegrationStatus;
  required: boolean;
  ready: boolean;
  configured: boolean;
  connected: boolean;
  requiredSecrets: string[];
  missingSecrets: string[];
  missingSetup: string[];
  warnings: string[];
  setupGuide: string[];
}

export interface AppPublishIntegrationCheck {
  category: AppPublishIntegrationCategory;
  label: string;
  status: AppPublishIntegrationStatus;
  required: boolean;
  ready: boolean;
  sourceSignals: string[];
  requiredSecrets: string[];
  missingSetup: string[];
  warnings: string[];
  setupGuide: string[];
}

export interface AppPublishIntegrationsReadiness {
  version: "phase-71-lane-5";
  status: AppPublishIntegrationReadinessStatus;
  canPublish: boolean;
  canUseAllRequestedIntegrations: boolean;
  blockers: string[];
  featureBlockers: string[];
  warnings: string[];
  checks: AppPublishIntegrationCheck[];
  connectorReadiness: AppPublishConnectorReadiness[];
}

interface CheckDraft {
  category: AppPublishIntegrationCategory;
  label: string;
  required: boolean;
  sourceSignals: string[];
  requiredSecrets?: string[];
  missingSetup?: string[];
  warnings?: string[];
  setupGuide?: string[];
}

const PROVIDER_ENV_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_BASE_URL"];
const EMAIL_ENV_KEYS = ["RESEND_API_KEY", "SENDGRID_API_KEY", "POSTMARK_TOKEN", "SMTP_URL"];
const DATABASE_URL_ENV_KEYS = [
  "DATABASE_URL",
  "PACKETAGENT_DATABASE_URL",
  "PACKETAGENT_MANAGED_DATABASE_URL",
];
const STRIPE_ENV_KEYS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_ID"];
const GITHUB_ENV_KEYS = ["GITHUB_TOKEN", "GH_TOKEN"];
const SLACK_WEBHOOK_ENV_KEYS = ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET", "SLACK_WEBHOOK_URL"];
const CUSTOM_API_ENV_KEYS = ["CUSTOM_API_KEY", "CUSTOM_API_TOKEN", "CUSTOM_API_BASE_URL"];

const CATEGORY_ORDER: AppPublishIntegrationCategory[] = [
  "provider_keys",
  "webhook",
  "email",
  "payment",
  "database",
  "browser",
  "github",
];

const CATEGORY_LABELS: Record<AppPublishIntegrationCategory, string> = {
  provider_keys: "Model provider keys",
  webhook: "Webhook delivery",
  email: "Email delivery",
  payment: "Payment provider",
  database: "Database runtime",
  browser: "Browser automation",
  github: "GitHub connector",
};

export function inspectAppPublishIntegrations(
  input: AppPublishIntegrationsInput = {},
): AppPublishIntegrationsReadiness {
  const env = { ...(input.draft?.env ?? {}), ...(input.env ?? {}) };
  const sourceText = normalizeText(
    flattenText({
      draft: input.draft,
      requiredEnv: input.requiredEnv,
      optionalEnv: input.optionalEnv,
    }),
  );
  const checks = CATEGORY_ORDER.map((category) =>
    checkForCategory(category, input, env, sourceText),
  );
  const connectorReadiness = buildConnectorReadiness(input, env, sourceText, checks);
  const featureBlockers = uniqueSorted(
    connectorReadiness.flatMap((connector) =>
      connector.required
        ? connector.missingSetup.map((message) => `${connector.feature}: ${message}`)
        : [],
    ),
  );
  const blockers: string[] = [];
  const warnings = uniqueSorted([
    ...checks.flatMap((check) => check.warnings),
    ...connectorReadiness.flatMap((connector) =>
      connector.warnings.map((warning) => `${connector.feature}: ${warning}`),
    ),
  ]);

  return {
    version: "phase-71-lane-5",
    status: featureBlockers.length > 0 ? "blocked" : warnings.length > 0 ? "warnings" : "ready",
    canPublish: true,
    canUseAllRequestedIntegrations: featureBlockers.length === 0,
    blockers,
    featureBlockers,
    warnings,
    checks,
    connectorReadiness,
  };
}

function buildConnectorReadiness(
  input: AppPublishIntegrationsInput,
  env: Record<string, string | undefined>,
  sourceText: string,
  checks: AppPublishIntegrationCheck[],
): AppPublishConnectorReadiness[] {
  const availableTools = normalizedSet(input.availableTools);
  const connectedConnectors = normalizedSet(input.connectedConnectors);
  const explicit = new Map(
    (input.connectors ?? []).map((connector) => [normalizeConnectorId(connector.id), connector]),
  );
  const checkByCategory = new Map(checks.map((check) => [check.category, check]));
  const specs: Array<{
    id: AppPublishConnectorId;
    label: string;
    feature: string;
    category: AppPublishIntegrationCategory;
    requiredSecrets: string[];
    inferredRequired: boolean;
    inferredConfigured: boolean;
    setupGuide: string[];
  }> = [
    {
      id: "openai",
      label: "OpenAI",
      feature: "OpenAI model calls",
      category: "provider_keys",
      requiredSecrets: ["OPENAI_API_KEY"],
      inferredRequired:
        hasOpenAiSignal(sourceText) ||
        (input.requiredProviderKeys ?? []).includes("OPENAI_API_KEY") ||
        (input.requiredEnv ?? []).includes("OPENAI_API_KEY"),
      inferredConfigured:
        input.providers?.configured === true ||
        input.providers?.openai === true ||
        hasValue(env.OPENAI_API_KEY) ||
        availableTools.has("openai") ||
        connectedConnectors.has("openai"),
      setupGuide: [
        "Add OPENAI_API_KEY server-side before enabling OpenAI-backed generated features.",
      ],
    },
    {
      id: "anthropic",
      label: "Anthropic",
      feature: "Anthropic model calls",
      category: "provider_keys",
      requiredSecrets: ["ANTHROPIC_API_KEY"],
      inferredRequired:
        hasAnthropicSignal(sourceText) ||
        (input.requiredProviderKeys ?? []).includes("ANTHROPIC_API_KEY") ||
        (input.requiredEnv ?? []).includes("ANTHROPIC_API_KEY"),
      inferredConfigured:
        input.providers?.configured === true ||
        input.providers?.anthropic === true ||
        hasValue(env.ANTHROPIC_API_KEY) ||
        availableTools.has("anthropic") ||
        connectedConnectors.has("anthropic"),
      setupGuide: [
        "Add ANTHROPIC_API_KEY server-side before enabling Anthropic-backed generated features.",
      ],
    },
    {
      id: "ollama",
      label: "Ollama/local model",
      feature: "Local model calls",
      category: "provider_keys",
      requiredSecrets: ["OLLAMA_BASE_URL"],
      inferredRequired:
        /\bollama\b|\blocal model\b/i.test(sourceText) ||
        (input.requiredProviderKeys ?? []).includes("OLLAMA_BASE_URL") ||
        (input.requiredEnv ?? []).includes("OLLAMA_BASE_URL"),
      inferredConfigured:
        input.providers?.configured === true ||
        input.providers?.localModel === true ||
        hasValue(env.OLLAMA_BASE_URL) ||
        availableTools.has("ollama") ||
        connectedConnectors.has("ollama"),
      setupGuide: [
        "Set OLLAMA_BASE_URL or connect the local-model provider before enabling local model features.",
      ],
    },
    {
      id: "custom_api",
      label: "Custom API",
      feature: "Custom API calls",
      category: "provider_keys",
      requiredSecrets: CUSTOM_API_ENV_KEYS,
      inferredRequired:
        /\bcustom api\b|\bexternal api\b|\bapi token\b|\bbearer token\b/i.test(sourceText) ||
        (input.requiredEnv ?? []).some((name) => CUSTOM_API_ENV_KEYS.includes(name)),
      inferredConfigured:
        hasAnyEnv(env, CUSTOM_API_ENV_KEYS) ||
        availableTools.has("custom-api") ||
        connectedConnectors.has("custom-api"),
      setupGuide: [
        "Store custom API credentials server-side and map generated API actions to the configured connector.",
      ],
    },
    {
      id: "slack_webhook",
      label: "Slack/webhook",
      feature: "Slack or webhook delivery",
      category: "webhook",
      requiredSecrets: ["PACKETAGENT_PUBLIC_APP_BASE_URL", "PACKETAGENT_WEBHOOK_SIGNING_SECRET"],
      inferredRequired:
        /\bslack\b/i.test(sourceText) || checkByCategory.get("webhook")?.required === true,
      inferredConfigured:
        ((hasValue(input.webhook?.publicBaseUrl) ||
          hasAnyEnv(env, ["PACKETAGENT_PUBLIC_BASE_URL", "PACKETAGENT_PUBLIC_APP_BASE_URL"])) &&
          (input.webhook?.signingSecretConfigured === true ||
            hasValue(env.PACKETAGENT_WEBHOOK_SIGNING_SECRET) ||
            hasAnyEnv(env, SLACK_WEBHOOK_ENV_KEYS))) ||
        connectedConnectors.has("slack") ||
        connectedConnectors.has("webhook"),
      setupGuide: [
        "Configure Slack/webhook credentials only for generated features that send or receive those events.",
      ],
    },
    {
      id: "email",
      label: "Email",
      feature: "Email delivery",
      category: "email",
      requiredSecrets: EMAIL_ENV_KEYS,
      inferredRequired: checkByCategory.get("email")?.required === true,
      inferredConfigured:
        input.email?.providerConfigured === true ||
        hasAnyEnv(env, EMAIL_ENV_KEYS) ||
        connectedConnectors.has("email"),
      setupGuide: ["Connect one email provider before enabling generated email delivery."],
    },
    {
      id: "github_webhook",
      label: "GitHub webhook",
      feature: "GitHub repository actions",
      category: "github",
      requiredSecrets: GITHUB_ENV_KEYS,
      inferredRequired: checkByCategory.get("github")?.required === true,
      inferredConfigured:
        input.github?.connectorConnected === true ||
        input.github?.tokenConfigured === true ||
        hasAnyEnv(env, GITHUB_ENV_KEYS) ||
        availableTools.has("github") ||
        connectedConnectors.has("github"),
      setupGuide: ["Connect GitHub or provide a scoped token before enabling repository actions."],
    },
    {
      id: "browser",
      label: "Browser scraping",
      feature: "Browser scraping",
      category: "browser",
      requiredSecrets: [],
      inferredRequired: checkByCategory.get("browser")?.required === true,
      inferredConfigured:
        input.browser?.browserToolAvailable === true ||
        availableTools.has("browser") ||
        availableTools.has("browser-use") ||
        availableTools.has("playwright") ||
        connectedConnectors.has("browser") ||
        connectedConnectors.has("browser-use"),
      setupGuide: ["Enable browser-use or Playwright before generated browser extraction runs."],
    },
    {
      id: "stripe",
      label: "Stripe/payments",
      feature: "Stripe payments",
      category: "payment",
      requiredSecrets: STRIPE_ENV_KEYS,
      inferredRequired: checkByCategory.get("payment")?.required === true,
      inferredConfigured:
        (input.payment?.secretKeyConfigured === true || hasValue(env.STRIPE_SECRET_KEY)) &&
        (input.payment?.webhookSecretConfigured === true || hasValue(env.STRIPE_WEBHOOK_SECRET)) &&
        (input.payment?.priceConfigured === true || hasValue(env.STRIPE_PRICE_ID)),
      setupGuide: [
        "Set Stripe secret, webhook secret, and price IDs before enabling payment flows.",
      ],
    },
    {
      id: "database",
      label: "Database",
      feature: "Database persistence",
      category: "database",
      requiredSecrets: DATABASE_URL_ENV_KEYS,
      inferredRequired: checkByCategory.get("database")?.required === true,
      inferredConfigured:
        input.database?.configured === true || hasAnyEnv(env, DATABASE_URL_ENV_KEYS),
      setupGuide: ["Configure a durable database only for generated CRUD or persistence features."],
    },
  ];

  return specs.map((spec) => {
    const override = explicit.get(spec.id);
    const requiredSecrets = uniqueSorted(override?.requiredSecrets ?? spec.requiredSecrets);
    const connected =
      override?.connected === true ||
      connectedConnectors.has(spec.id) ||
      connectedConnectors.has(spec.label.toLowerCase());
    const configured = override?.configured === true || spec.inferredConfigured || connected;
    const required = override?.required ?? spec.inferredRequired;
    const missingSecrets =
      required && !configured ? requiredSecrets.filter((name) => !hasValue(env[name])) : [];
    const categoryCheck = checkByCategory.get(spec.category);
    const missingSetup = uniqueSorted([
      ...(override?.missingSetup ?? []),
      ...(required && !configured && missingSecrets.length > 0
        ? [`Configure ${missingSecrets.join(", ")} before enabling ${spec.feature}.`]
        : []),
      ...(required && !configured && missingSecrets.length === 0
        ? (categoryCheck?.missingSetup ?? [])
        : []),
    ]);
    const warnings = uniqueSorted([
      ...(override?.warnings ?? []),
      ...(required && configured && override?.testPassed === false
        ? [`Run the ${spec.label} connector test before public handoff.`]
        : []),
    ]);
    const status: AppPublishIntegrationStatus = !required
      ? "not_required"
      : missingSetup.length > 0
        ? "blocked"
        : warnings.length > 0
          ? "warning"
          : "ready";

    return {
      id: spec.id,
      label: override?.label ?? spec.label,
      feature: override?.feature ?? spec.feature,
      category: spec.category,
      status,
      required,
      ready: required ? missingSetup.length === 0 : true,
      configured,
      connected,
      requiredSecrets,
      missingSecrets,
      missingSetup: required ? missingSetup : [],
      warnings: required ? warnings : [],
      setupGuide: uniqueSorted([...(override?.setupGuide ?? []), ...spec.setupGuide]),
    };
  });
}

function checkForCategory(
  category: AppPublishIntegrationCategory,
  input: AppPublishIntegrationsInput,
  env: Record<string, string | undefined>,
  sourceText: string,
): AppPublishIntegrationCheck {
  switch (category) {
    case "provider_keys":
      return finalizeCheck(providerCheck(input, env, sourceText));
    case "webhook":
      return finalizeCheck(webhookCheck(input, env, sourceText));
    case "email":
      return finalizeCheck(emailCheck(input, env, sourceText));
    case "payment":
      return finalizeCheck(paymentCheck(input, env, sourceText));
    case "database":
      return finalizeCheck(databaseCheck(input, env, sourceText));
    case "browser":
      return finalizeCheck(browserCheck(input, sourceText));
    case "github":
      return finalizeCheck(githubCheck(input, env, sourceText));
  }
}

function providerCheck(
  input: AppPublishIntegrationsInput,
  env: Record<string, string | undefined>,
  sourceText: string,
): CheckDraft {
  const requiredProviderKeys = uniqueSorted([
    ...(input.requiredProviderKeys ?? []),
    ...(input.requiredEnv ?? []).filter((name) => PROVIDER_ENV_KEYS.includes(name)),
  ]);
  const exactKeys = uniqueSorted([
    ...requiredProviderKeys,
    ...(hasOpenAiSignal(sourceText) ? ["OPENAI_API_KEY"] : []),
    ...(hasAnthropicSignal(sourceText) ? ["ANTHROPIC_API_KEY"] : []),
  ]);
  const genericProviderRequired = exactKeys.length === 0 && hasGenericAiSignal(sourceText);
  const required =
    exactKeys.length > 0 || genericProviderRequired || input.providers?.configured === true;
  const providerReady =
    input.providers?.configured === true ||
    input.providers?.openai === true ||
    input.providers?.anthropic === true ||
    input.providers?.localModel === true ||
    hasAnyEnv(env, PROVIDER_ENV_KEYS);
  const missingExactKeys = exactKeys.filter((key) => !hasValue(env[key]));
  const missingSetup =
    providerReady && exactKeys.length === 0
      ? []
      : [
          ...missingExactKeys.map(
            (key) => `Add ${key} to the publish environment for live model calls.`,
          ),
          ...(genericProviderRequired && !providerReady
            ? [
                "Configure at least one model provider secret such as OPENAI_API_KEY or ANTHROPIC_API_KEY before publish.",
              ]
            : []),
        ];

  return {
    category: "provider_keys",
    label: CATEGORY_LABELS.provider_keys,
    required,
    sourceSignals: sourceSignals([
      ["draft:openai", hasOpenAiSignal(sourceText)],
      ["draft:anthropic", hasAnthropicSignal(sourceText)],
      ["draft:ai", hasGenericAiSignal(sourceText)],
      ["env:provider-key-required", requiredProviderKeys.length > 0],
    ]),
    requiredSecrets:
      exactKeys.length > 0
        ? exactKeys
        : genericProviderRequired
          ? ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]
          : [],
    missingSetup,
    setupGuide: [
      "Store provider secrets in the self-hosted environment, never in generated client code.",
      "Use OPENAI_API_KEY for OpenAI/GPT features or ANTHROPIC_API_KEY for Claude features.",
    ],
  };
}

function webhookCheck(
  input: AppPublishIntegrationsInput,
  env: Record<string, string | undefined>,
  sourceText: string,
): CheckDraft {
  const required =
    input.webhook?.required === true || /\bwebhook(s)?\b|\binbound event(s)?\b/i.test(sourceText);
  const publicBaseUrlReady =
    hasValue(input.webhook?.publicBaseUrl) ||
    hasAnyEnv(env, ["PACKETAGENT_PUBLIC_BASE_URL", "PACKETAGENT_PUBLIC_APP_BASE_URL"]);
  const signingReady =
    input.webhook?.signingSecretConfigured === true ||
    hasValue(env.PACKETAGENT_WEBHOOK_SIGNING_SECRET);

  return {
    category: "webhook",
    label: CATEGORY_LABELS.webhook,
    required,
    sourceSignals: sourceSignals([
      ["draft:webhook", /\bwebhook(s)?\b|\binbound event(s)?\b/i.test(sourceText)],
      ["input:webhook-required", input.webhook?.required === true],
    ]),
    requiredSecrets: ["PACKETAGENT_WEBHOOK_SIGNING_SECRET"],
    missingSetup: [
      ...(!publicBaseUrlReady
        ? [
            "Set PACKETAGENT_PUBLIC_APP_BASE_URL or PACKETAGENT_PUBLIC_BASE_URL to the HTTPS origin providers will call.",
          ]
        : []),
      ...(!signingReady
        ? ["Set PACKETAGENT_WEBHOOK_SIGNING_SECRET before accepting signed inbound webhook events."]
        : []),
    ],
    setupGuide: [
      "Register the published HTTPS webhook URL with the upstream provider after smoke checks pass.",
      "Verify webhook signatures server-side before mutating generated app data.",
    ],
  };
}

function emailCheck(
  input: AppPublishIntegrationsInput,
  env: Record<string, string | undefined>,
  sourceText: string,
): CheckDraft {
  const liveEmailIntent =
    /\b(send|deliver|notify|invite|mail)\b.*\b(email|notification|invite)\b|\bemail(s)?\b.*\b(send|delivery|provider|smtp|resend|sendgrid|postmark|notice|notification|receipt)\b|\b(email notices|email receipts)\b|\bsmtp\b|\bresend\b|\bsendgrid\b|\bpostmark\b|\bnotification(s)?\b/i.test(
      sourceText,
    );
  const required = input.email?.required === true || liveEmailIntent;
  const ready = input.email?.providerConfigured === true || hasAnyEnv(env, EMAIL_ENV_KEYS);

  return {
    category: "email",
    label: CATEGORY_LABELS.email,
    required,
    sourceSignals: sourceSignals([
      [
        "draft:email",
        /\bemail(s)?\b|\bsmtp\b|\bresend\b|\bsendgrid\b|\bpostmark\b/i.test(sourceText),
      ],
      ["draft:notification", /\bnotification(s)?\b|\binvite(s|d)?\b/i.test(sourceText)],
      ["draft:live-email", liveEmailIntent],
      ["input:email-required", input.email?.required === true],
    ]),
    requiredSecrets: EMAIL_ENV_KEYS,
    missingSetup: ready
      ? []
      : [
          "Configure an email provider secret: RESEND_API_KEY, SENDGRID_API_KEY, POSTMARK_TOKEN, or SMTP_URL.",
        ],
    setupGuide: [
      "Use a server-side email provider secret and keep sender/domain verification outside generated client bundles.",
    ],
  };
}

function paymentCheck(
  input: AppPublishIntegrationsInput,
  env: Record<string, string | undefined>,
  sourceText: string,
): CheckDraft {
  const required =
    input.payment?.required === true ||
    /\bstripe\b|\bpayment(s)?\b|\bcheckout\b|\bsubscription(s)?\b|\binvoice(s)?\b|\bbilling\b/i.test(
      sourceText,
    );
  const secretReady =
    input.payment?.secretKeyConfigured === true || hasValue(env.STRIPE_SECRET_KEY);
  const webhookReady =
    input.payment?.webhookSecretConfigured === true || hasValue(env.STRIPE_WEBHOOK_SECRET);
  const priceReady = input.payment?.priceConfigured === true || hasValue(env.STRIPE_PRICE_ID);

  return {
    category: "payment",
    label: CATEGORY_LABELS.payment,
    required,
    sourceSignals: sourceSignals([
      ["draft:stripe", /\bstripe\b/i.test(sourceText)],
      [
        "draft:payment",
        /\bpayment(s)?\b|\bcheckout\b|\bsubscription(s)?\b|\binvoice(s)?\b|\bbilling\b/i.test(
          sourceText,
        ),
      ],
      ["input:payment-required", input.payment?.required === true],
    ]),
    requiredSecrets: STRIPE_ENV_KEYS,
    missingSetup: [
      ...(!secretReady
        ? ["Set STRIPE_SECRET_KEY before enabling live checkout or payment mutations."]
        : []),
      ...(!webhookReady
        ? ["Set STRIPE_WEBHOOK_SECRET before trusting Stripe payment events."]
        : []),
      ...(!priceReady
        ? ["Set STRIPE_PRICE_ID or map generated pricing plans to Stripe price IDs before publish."]
        : []),
    ],
    setupGuide: [
      "Keep Stripe secret keys server-side and use webhook verification for subscription or invoice state changes.",
    ],
  };
}

function databaseCheck(
  input: AppPublishIntegrationsInput,
  env: Record<string, string | undefined>,
  sourceText: string,
): CheckDraft {
  const required =
    input.database?.required === true ||
    hasDataModels(input.draft) ||
    /\bdatabase\b|\bpostgres\b|\bsql\b|\bcrud\b|\bschema\b|\btable(s)?\b|\bmigration(s)?\b|\bpersist(s|ed|ence)?\b|\bsave records\b/i.test(
      sourceText,
    );
  const store = normalizeText(input.database?.store ?? env.PACKETAGENT_STORE);
  const hasDatabaseUrl = hasAnyEnv(env, DATABASE_URL_ENV_KEYS);
  const configured =
    input.database?.configured ?? (hasDatabaseUrl || Boolean(store && store !== "memory"));
  const migrationsReady = input.database?.migrationsReady;
  const writable = input.database?.writable;
  const memoryStore = store === "memory";

  return {
    category: "database",
    label: CATEGORY_LABELS.database,
    required,
    sourceSignals: sourceSignals([
      ["draft:data-model", hasDataModels(input.draft)],
      [
        "draft:database",
        /\bdatabase\b|\bpostgres\b|\bsql\b|\bschema\b|\btable(s)?\b/i.test(sourceText),
      ],
      ["draft:crud", /\bcrud\b|\bpersist(s|ed|ence)?\b|\bsave records\b/i.test(sourceText)],
      ["input:database-required", input.database?.required === true],
    ]),
    requiredSecrets: hasDatabaseUrl ? [] : DATABASE_URL_ENV_KEYS,
    missingSetup: [
      ...(!configured || memoryStore
        ? ["Configure a non-memory database runtime for published CRUD or persistence."]
        : []),
      ...(migrationsReady === false
        ? ["Run generated-app database migrations before publishing."]
        : []),
      ...(writable === false
        ? ["Confirm the publish database user can write generated app records."]
        : []),
    ],
    warnings: [
      ...(required && configured && migrationsReady === undefined
        ? [
            "Run npm run db:migrate or confirm migrations are already applied for the publish database.",
          ]
        : []),
      ...(required && configured && writable === undefined
        ? ["Run a write smoke check against the publish database before public handoff."]
        : []),
      ...(required && store === "file"
        ? [
            "File-backed storage is acceptable for one local instance, but use Postgres for multi-instance self-hosting.",
          ]
        : []),
    ],
    setupGuide: [
      "Use PACKETAGENT_STORE=postgres with DATABASE_URL or PACKETAGENT_DATABASE_URL for durable self-hosted publish.",
      "Run database migration and ready checks before shifting traffic.",
    ],
  };
}

function browserCheck(input: AppPublishIntegrationsInput, sourceText: string): CheckDraft {
  const required =
    input.browser?.required === true ||
    /\bbrowser\b|\bplaywright\b|\bpuppeteer\b|\bscrap(e|ing|er)\b|\bcrawl(er|ing)?\b|\bscreenshot\b|\bextract from (a )?(site|url|page)\b/i.test(
      sourceText,
    );
  const availableTools = normalizedSet(input.availableTools);
  const connectedConnectors = normalizedSet(input.connectedConnectors);
  const browserReady =
    input.browser?.browserToolAvailable === true ||
    availableTools.has("browser") ||
    availableTools.has("browser-use") ||
    availableTools.has("playwright") ||
    connectedConnectors.has("browser") ||
    connectedConnectors.has("browser-use");

  return {
    category: "browser",
    label: CATEGORY_LABELS.browser,
    required,
    sourceSignals: sourceSignals([
      ["draft:browser", /\bbrowser\b|\bplaywright\b|\bpuppeteer\b/i.test(sourceText)],
      [
        "draft:scrape",
        /\bscrap(e|ing|er)\b|\bcrawl(er|ing)?\b|\bextract from (a )?(site|url|page)\b/i.test(
          sourceText,
        ),
      ],
      ["input:browser-required", input.browser?.required === true],
    ]),
    missingSetup: [
      ...(!browserReady
        ? [
            "Enable a browser automation runtime such as browser-use or Playwright before live extraction.",
          ]
        : []),
      ...(input.browser?.scrapingAllowed === false
        ? ["Confirm the target site permits scraping before publishing live extraction."]
        : []),
    ],
    warnings: [
      ...(required && browserReady && input.browser?.scrapingAllowed === undefined
        ? [
            "Confirm target-site terms and rate limits before enabling browser extraction in publish.",
          ]
        : []),
    ],
    setupGuide: [
      "Keep scraping and browser automation server-side and record per-site rate limits in the publish checklist.",
    ],
  };
}

function githubCheck(
  input: AppPublishIntegrationsInput,
  env: Record<string, string | undefined>,
  sourceText: string,
): CheckDraft {
  const required =
    input.github?.required === true ||
    /\bgithub\b|\bgh\b|\bpull request(s)?\b|\bpr(s)?\b|\brepo(sitory)?\b|\bcommit(s)?\b|\bissue(s)?\b/i.test(
      sourceText,
    );
  const availableTools = normalizedSet(input.availableTools);
  const connectedConnectors = normalizedSet(input.connectedConnectors);
  const ready =
    input.github?.connectorConnected === true ||
    input.github?.tokenConfigured === true ||
    hasAnyEnv(env, GITHUB_ENV_KEYS) ||
    availableTools.has("github") ||
    connectedConnectors.has("github");

  return {
    category: "github",
    label: CATEGORY_LABELS.github,
    required,
    sourceSignals: sourceSignals([
      ["draft:github", /\bgithub\b|\bgh\b/i.test(sourceText)],
      [
        "draft:repository",
        /\bpull request(s)?\b|\bpr(s)?\b|\brepo(sitory)?\b|\bcommit(s)?\b|\bissue(s)?\b/i.test(
          sourceText,
        ),
      ],
      ["input:github-required", input.github?.required === true],
    ]),
    requiredSecrets: GITHUB_ENV_KEYS,
    missingSetup: ready
      ? []
      : [
          "Connect the GitHub connector or set GITHUB_TOKEN/GH_TOKEN before publishing repository actions.",
        ],
    setupGuide: [
      "Scope GitHub credentials to the repositories and actions the generated app needs.",
    ],
  };
}

function finalizeCheck(draft: CheckDraft): AppPublishIntegrationCheck {
  const missingSetup = uniqueSorted(draft.missingSetup ?? []);
  const warnings = uniqueSorted(draft.warnings ?? []);
  const required = draft.required;
  const status: AppPublishIntegrationStatus = !required
    ? "not_required"
    : missingSetup.length > 0
      ? "blocked"
      : warnings.length > 0
        ? "warning"
        : "ready";

  return {
    category: draft.category,
    label: draft.label,
    status,
    required,
    ready: required ? missingSetup.length === 0 : true,
    sourceSignals: uniqueSorted(draft.sourceSignals),
    requiredSecrets: uniqueSorted(draft.requiredSecrets ?? []),
    missingSetup: required ? missingSetup : [],
    warnings: required ? warnings : [],
    setupGuide: uniqueSorted(draft.setupGuide ?? []),
  };
}

function hasOpenAiSignal(value: string): boolean {
  return /\bopenai\b|\bgpt[-\w.]*\b|\bembedding(s)?\b/i.test(value);
}

function hasAnthropicSignal(value: string): boolean {
  return /\banthropic\b|\bclaude\b/i.test(value);
}

function hasGenericAiSignal(value: string): boolean {
  return /\bai\b|\bllm\b|\blanguage model\b|\bartificial intelligence\b/i.test(value);
}

function hasDataModels(draft: GeneratedAppPublishIntegrationContext | undefined): boolean {
  return Array.isArray(draft?.dataModels) && draft.dataModels.length > 0;
}

function sourceSignals(values: Array<[string, boolean]>): string[] {
  return uniqueSorted(values.filter(([, active]) => active).map(([label]) => label));
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

function normalizeConnectorId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function hasAnyEnv(env: Record<string, string | undefined>, keys: string[]): boolean {
  return keys.some((key) => hasValue(env[key]));
}

function hasValue(value: string | undefined): boolean {
  return String(value ?? "").trim().length > 0;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
}
