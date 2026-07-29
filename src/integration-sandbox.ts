export type IntegrationSandboxSurface = "runtime" | "preview";
export type IntegrationSandboxConnectorId =
  | "model_provider"
  | "database"
  | "email"
  | "webhook"
  | "payment"
  | "github"
  | "browser"
  | "preview_renderer"
  | "preview_runtime"
  | "preview_browser";
export type IntegrationSandboxStatus = "pass" | "fail" | "pending";

export interface IntegrationSandboxConnectorOverride {
  required?: boolean;
  configured?: boolean;
  available?: boolean;
  pending?: boolean;
  status?: IntegrationSandboxStatus;
  message?: string;
  observed?: Record<string, unknown>;
  setupGuide?: string[];
}

export interface IntegrationSandboxInput {
  draft?: {
    summary?: string;
    pages?: unknown[];
    apiRoutes?: unknown[];
    dataModels?: unknown[];
    integrations?: unknown[];
    env?: Record<string, string | undefined>;
    [key: string]: unknown;
  };
  env?: Record<string, string | undefined>;
  availableTools?: string[];
  connectedConnectors?: string[];
  runtime?: {
    sandboxEnabled?: boolean;
    connectors?: Partial<
      Record<IntegrationSandboxConnectorId, IntegrationSandboxConnectorOverride>
    >;
  };
  preview?: {
    sandboxEnabled?: boolean;
    previewUrl?: string;
    buildReady?: boolean;
    connectors?: Partial<
      Record<IntegrationSandboxConnectorId, IntegrationSandboxConnectorOverride>
    >;
  };
}

export interface IntegrationSandboxConnectorResult {
  id: IntegrationSandboxConnectorId;
  surface: IntegrationSandboxSurface;
  label: string;
  status: IntegrationSandboxStatus;
  required: boolean;
  deterministic: true;
  liveNetworkCalls: false;
  message: string;
  sourceSignals: string[];
  setupGuide: string[];
  observed: Record<string, unknown>;
}

export interface IntegrationSandboxReport {
  version: "phase-71-lane-3";
  status: IntegrationSandboxStatus;
  canRunRuntimeSandbox: boolean;
  canRunPreviewSandbox: boolean;
  results: IntegrationSandboxConnectorResult[];
  failures: string[];
  pending: string[];
  setupGuide: string[];
}

type EnvKeyMode = "any" | "all";

interface ConnectorSpec {
  id: IntegrationSandboxConnectorId;
  surface: IntegrationSandboxSurface;
  label: string;
  envKeys: string[];
  envKeyMode?: EnvKeyMode;
  connectorNames: string[];
  toolNames: string[];
  signals: Array<{ label: string; pattern: RegExp }>;
  defaultSetupGuide: string[];
}

const CONNECTOR_SPECS: readonly ConnectorSpec[] = [
  {
    id: "model_provider",
    surface: "runtime",
    label: "Model provider sandbox",
    envKeys: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_BASE_URL"],
    connectorNames: ["openai", "anthropic", "model-provider"],
    toolNames: ["openai", "anthropic"],
    signals: [
      { label: "openai", pattern: /\bopenai\b|\bgpt[-\w.]*\b/i },
      { label: "anthropic", pattern: /\banthropic\b|\bclaude\b/i },
      { label: "ai", pattern: /\bai\b|\bllm\b|\blanguage model\b/i },
    ],
    defaultSetupGuide: [
      "Configure a model provider secret such as OPENAI_API_KEY, ANTHROPIC_API_KEY, or OLLAMA_BASE_URL for runtime sandbox calls.",
      "Keep model provider secrets server-side and out of generated preview bundles.",
    ],
  },
  {
    id: "database",
    surface: "runtime",
    label: "Database runtime sandbox",
    envKeys: ["DATABASE_URL", "PACKETAGENT_DATABASE_URL", "PACKETAGENT_MANAGED_DATABASE_URL"],
    connectorNames: ["database", "postgres"],
    toolNames: ["database", "postgres"],
    signals: [
      { label: "data-model", pattern: /\bdata model(s)?\b|\bschema\b|\btable(s)?\b/i },
      { label: "database", pattern: /\bdatabase\b|\bpostgres\b|\bsql\b|\bcrud\b/i },
      { label: "persistence", pattern: /\bpersist(s|ed|ence)?\b|\bsave records\b/i },
    ],
    defaultSetupGuide: [
      "Configure DATABASE_URL, PACKETAGENT_DATABASE_URL, or PACKETAGENT_MANAGED_DATABASE_URL before testing persistence in the runtime sandbox.",
      "Run migrations before treating database sandbox checks as publish-ready.",
    ],
  },
  {
    id: "email",
    surface: "runtime",
    label: "Email connector sandbox",
    envKeys: ["RESEND_API_KEY", "SENDGRID_API_KEY", "POSTMARK_TOKEN", "SMTP_URL"],
    connectorNames: ["email", "resend", "sendgrid", "postmark", "smtp"],
    toolNames: ["email", "smtp"],
    signals: [
      { label: "email", pattern: /\bemail(s)?\b|\bsmtp\b|\bresend\b|\bsendgrid\b|\bpostmark\b/i },
      { label: "notification", pattern: /\bnotification(s)?\b|\binvite(s|d)?\b|\breceipt(s)?\b/i },
    ],
    defaultSetupGuide: [
      "Configure RESEND_API_KEY, SENDGRID_API_KEY, POSTMARK_TOKEN, or SMTP_URL before sending sandbox email.",
      "Use sandbox recipients or provider test mode before enabling live delivery.",
    ],
  },
  {
    id: "webhook",
    surface: "runtime",
    label: "Webhook connector sandbox",
    envKeys: [
      "PACKETAGENT_PUBLIC_BASE_URL",
      "PACKETAGENT_PUBLIC_APP_BASE_URL",
      "PACKETAGENT_WEBHOOK_SIGNING_SECRET",
    ],
    envKeyMode: "all",
    connectorNames: ["webhook"],
    toolNames: ["webhook"],
    signals: [
      { label: "webhook", pattern: /\bwebhook(s)?\b|\binbound event(s)?\b/i },
      { label: "signature", pattern: /\bsign(ature|ed|ing)\b/i },
    ],
    defaultSetupGuide: [
      "Set PACKETAGENT_PUBLIC_APP_BASE_URL or PACKETAGENT_PUBLIC_BASE_URL before registering sandbox webhook URLs.",
      "Set PACKETAGENT_WEBHOOK_SIGNING_SECRET before trusting inbound sandbox events.",
    ],
  },
  {
    id: "payment",
    surface: "runtime",
    label: "Payment connector sandbox",
    envKeys: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_ID"],
    envKeyMode: "all",
    connectorNames: ["stripe", "payment"],
    toolNames: ["stripe", "payment"],
    signals: [
      { label: "stripe", pattern: /\bstripe\b/i },
      {
        label: "payment",
        pattern: /\bpayment(s)?\b|\bcheckout\b|\bsubscription(s)?\b|\binvoice(s)?\b|\bbilling\b/i,
      },
    ],
    defaultSetupGuide: [
      "Configure STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, and STRIPE_PRICE_ID before running payment sandbox flows.",
      "Use Stripe test-mode credentials for sandbox checkout and webhook checks.",
    ],
  },
  {
    id: "github",
    surface: "runtime",
    label: "GitHub connector sandbox",
    envKeys: ["GITHUB_TOKEN", "GH_TOKEN"],
    connectorNames: ["github"],
    toolNames: ["github"],
    signals: [
      { label: "github", pattern: /\bgithub\b|\bgh\b/i },
      {
        label: "repository",
        pattern: /\bpull request(s)?\b|\bpr(s)?\b|\brepo(sitory)?\b|\bcommit(s)?\b|\bissue(s)?\b/i,
      },
    ],
    defaultSetupGuide: [
      "Connect the GitHub connector or configure GITHUB_TOKEN/GH_TOKEN before testing repository actions.",
      "Scope GitHub sandbox credentials to the repositories required by the generated app.",
    ],
  },
  {
    id: "browser",
    surface: "runtime",
    label: "Browser automation sandbox",
    envKeys: [],
    connectorNames: ["browser", "browser-use", "playwright"],
    toolNames: ["browser", "browser-use", "playwright"],
    signals: [
      { label: "browser", pattern: /\bbrowser\b|\bplaywright\b|\bpuppeteer\b/i },
      {
        label: "scrape",
        pattern:
          /\bscrap(e|ing|er)\b|\bcrawl(er|ing)?\b|\bscreenshot\b|\bextract from (a )?(site|url|page)\b/i,
      },
    ],
    defaultSetupGuide: [
      "Enable browser-use or Playwright before running runtime sandbox extraction.",
      "Confirm target-site terms and rate limits before sandbox scraping.",
    ],
  },
  {
    id: "preview_renderer",
    surface: "preview",
    label: "Preview renderer sandbox",
    envKeys: [],
    connectorNames: ["preview", "vite"],
    toolNames: ["preview", "vite"],
    signals: [
      { label: "preview", pattern: /\bpreview\b|\brender(er|ing)?\b/i },
      { label: "page", pattern: /\bpage(s)?\b|\bcomponent(s)?\b|\bui\b/i },
    ],
    defaultSetupGuide: [
      "Run the generated app build before marking the preview renderer sandbox ready.",
      "Provide a local preview URL when browser-backed preview checks are required.",
    ],
  },
  {
    id: "preview_runtime",
    surface: "preview",
    label: "Preview runtime sandbox",
    envKeys: ["PACKETAGENT_PREVIEW_SANDBOX"],
    connectorNames: ["preview-runtime"],
    toolNames: ["preview-runtime"],
    signals: [
      { label: "preview-runtime", pattern: /\bpreview runtime\b|\bsandbox preview\b/i },
      { label: "api-route", pattern: /\bapi route(s)?\b|\bendpoint(s)?\b/i },
    ],
    defaultSetupGuide: [
      "Enable PACKETAGENT_PREVIEW_SANDBOX or provide an explicit preview runtime override before exercising preview API routes.",
      "Use stubbed preview data for external integrations until runtime sandbox checks pass.",
    ],
  },
  {
    id: "preview_browser",
    surface: "preview",
    label: "Preview browser sandbox",
    envKeys: [],
    connectorNames: ["browser", "browser-use", "playwright", "preview-browser"],
    toolNames: ["browser", "browser-use", "playwright", "preview-browser"],
    signals: [
      { label: "preview-browser", pattern: /\bpreview\b.*\b(browser|screenshot|smoke)\b/i },
      { label: "browser", pattern: /\bbrowser\b|\bplaywright\b|\bscreenshot\b/i },
    ],
    defaultSetupGuide: [
      "Enable browser-use or Playwright before running preview browser smoke checks.",
      "Point preview browser checks at a local or sandbox preview URL, not production.",
    ],
  },
];

const SECRET_KEY_PATTERN =
  /(secret|token|key|password|credential|authorization|database_url|smtp_url)$/i;

export function inspectIntegrationSandbox(
  input: IntegrationSandboxInput = {},
): IntegrationSandboxReport {
  const env = { ...(input.draft?.env ?? {}), ...(input.env ?? {}) };
  const sourceText = normalizeText(flattenText(input.draft));
  const results = CONNECTOR_SPECS.map((spec) => buildConnectorResult(spec, input, env, sourceText));
  const requiredResults = results.filter((result) => result.required);
  const failures = requiredResults
    .filter((result) => result.status === "fail")
    .map((result) => result.label);
  const pending = requiredResults
    .filter((result) => result.status === "pending")
    .map((result) => result.label);
  const setupGuide = uniqueSorted(
    requiredResults.flatMap((result) => (result.status === "pass" ? [] : result.setupGuide)),
  );
  const runtimeResults = results.filter((result) => result.surface === "runtime");
  const previewResults = results.filter((result) => result.surface === "preview");

  return {
    version: "phase-71-lane-3",
    status: failures.length > 0 ? "fail" : pending.length > 0 ? "pending" : "pass",
    canRunRuntimeSandbox: runtimeResults.every(
      (result) => result.status === "pass" || !result.required,
    ),
    canRunPreviewSandbox: previewResults.every(
      (result) => result.status === "pass" || !result.required,
    ),
    results,
    failures,
    pending,
    setupGuide,
  };
}

export function redactIntegrationSandboxValue(value: unknown): unknown {
  return redactValue(value, undefined);
}

function buildConnectorResult(
  spec: ConnectorSpec,
  input: IntegrationSandboxInput,
  env: Record<string, string | undefined>,
  sourceText: string,
): IntegrationSandboxConnectorResult {
  const override = overrideForSpec(spec, input);
  const sourceSignals = sourceSignalsForSpec(spec, sourceText, input);
  const required = override?.required ?? sourceSignals.length > 0;
  const available = override?.available ?? isAvailable(spec, input, env);
  const configured = override?.configured ?? isConfigured(spec, env, input);
  const observed = redactRecord({
    ...(override?.observed ?? {}),
    configured,
    available,
    envKeysPresent: spec.envKeys.filter((key) => hasValue(env[key])),
    connected: spec.connectorNames.filter((name) =>
      normalizedSet(input.connectedConnectors).has(name),
    ),
    tools: spec.toolNames.filter((name) => normalizedSet(input.availableTools).has(name)),
  });

  const status =
    override?.status ??
    deriveStatus({ required, configured, available, pending: override?.pending });

  return {
    id: spec.id,
    surface: spec.surface,
    label: spec.label,
    status,
    required,
    deterministic: true,
    liveNetworkCalls: false,
    message: override?.message ?? messageForStatus(spec, status, required),
    sourceSignals,
    setupGuide: uniqueSorted(override?.setupGuide ?? spec.defaultSetupGuide),
    observed,
  };
}

function overrideForSpec(
  spec: ConnectorSpec,
  input: IntegrationSandboxInput,
): IntegrationSandboxConnectorOverride | undefined {
  return spec.surface === "runtime"
    ? input.runtime?.connectors?.[spec.id]
    : input.preview?.connectors?.[spec.id];
}

function deriveStatus(input: {
  required: boolean;
  configured: boolean;
  available: boolean;
  pending?: boolean;
}): IntegrationSandboxStatus {
  if (input.pending) return "pending";
  if (!input.required) return "pending";
  if (!input.available || !input.configured) return "fail";
  return "pass";
}

function messageForStatus(
  spec: ConnectorSpec,
  status: IntegrationSandboxStatus,
  required: boolean,
): string {
  if (!required) return `${spec.label} is not requested by the current generated app context.`;
  if (status === "pass") return `${spec.label} has deterministic sandbox setup available.`;
  if (status === "pending")
    return `${spec.label} is waiting on an explicit sandbox result or setup confirmation.`;
  return `${spec.label} is required but sandbox setup is incomplete.`;
}

function isAvailable(
  spec: ConnectorSpec,
  input: IntegrationSandboxInput,
  env: Record<string, string | undefined>,
): boolean {
  if (spec.surface === "runtime" && input.runtime?.sandboxEnabled === false) return false;
  if (spec.surface === "preview" && input.preview?.sandboxEnabled === false) return false;
  if (spec.id === "preview_renderer")
    return input.preview?.buildReady === true || hasValue(input.preview?.previewUrl);
  if (spec.id === "preview_runtime")
    return (
      input.preview?.sandboxEnabled === true || hasAnyEnv(env, ["PACKETAGENT_PREVIEW_SANDBOX"])
    );
  return (
    intersects(normalizedSet(input.availableTools), spec.toolNames) ||
    intersects(normalizedSet(input.connectedConnectors), spec.connectorNames) ||
    spec.envKeys.length > 0
  );
}

function isConfigured(
  spec: ConnectorSpec,
  env: Record<string, string | undefined>,
  input: IntegrationSandboxInput,
): boolean {
  if (spec.id === "preview_renderer")
    return input.preview?.buildReady === true || hasValue(input.preview?.previewUrl);
  if (spec.id === "preview_browser")
    return (
      hasValue(input.preview?.previewUrl) &&
      (intersects(normalizedSet(input.availableTools), spec.toolNames) ||
        intersects(normalizedSet(input.connectedConnectors), spec.connectorNames))
    );
  if (spec.id === "webhook") {
    return (
      hasAnyEnv(env, ["PACKETAGENT_PUBLIC_BASE_URL", "PACKETAGENT_PUBLIC_APP_BASE_URL"]) &&
      hasValue(env.PACKETAGENT_WEBHOOK_SIGNING_SECRET)
    );
  }
  if (spec.envKeys.length === 0) {
    return (
      intersects(normalizedSet(input.availableTools), spec.toolNames) ||
      intersects(normalizedSet(input.connectedConnectors), spec.connectorNames)
    );
  }
  return (
    hasEnvByMode(env, spec.envKeys, spec.envKeyMode ?? "any") ||
    intersects(normalizedSet(input.availableTools), spec.toolNames) ||
    intersects(normalizedSet(input.connectedConnectors), spec.connectorNames)
  );
}

function sourceSignalsForSpec(
  spec: ConnectorSpec,
  sourceText: string,
  input: IntegrationSandboxInput,
): string[] {
  const signals = spec.signals
    .filter((signal) => signal.pattern.test(sourceText))
    .map((signal) => `draft:${signal.label}`);
  if (
    spec.id === "database" &&
    Array.isArray(input.draft?.dataModels) &&
    input.draft.dataModels.length > 0
  ) {
    signals.push("draft:data-model");
  }
  if (
    spec.id === "webhook" &&
    Array.isArray(input.draft?.apiRoutes) &&
    /webhook/i.test(flattenText(input.draft.apiRoutes))
  ) {
    signals.push("draft:webhook-route");
  }
  if (
    spec.id === "preview_renderer" &&
    (Array.isArray(input.draft?.pages) || input.preview?.previewUrl)
  ) {
    signals.push("input:preview");
  }
  if (
    spec.id === "preview_runtime" &&
    Array.isArray(input.draft?.apiRoutes) &&
    input.draft.apiRoutes.length > 0
  ) {
    signals.push("draft:api-route");
  }
  return uniqueSorted(signals);
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

function hasEnvByMode(
  env: Record<string, string | undefined>,
  keys: string[],
  mode: EnvKeyMode,
): boolean {
  return mode === "all" ? keys.every((key) => hasValue(env[key])) : hasAnyEnv(env, keys);
}

function hasValue(value: string | undefined): boolean {
  return String(value ?? "").trim().length > 0;
}

function intersects(values: Set<string>, candidates: string[]): boolean {
  return candidates.some((candidate) => values.has(candidate));
}

function redactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return redactValue(value, undefined) as Record<string, unknown>;
}

function redactValue(value: unknown, key: string | undefined): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === "string") return shouldRedact(key, value) ? redactString(value) : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, key));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        redactValue(entryValue, entryKey),
      ]),
    );
  }
  return "[redacted]";
}

function shouldRedact(key: string | undefined, value: string): boolean {
  const normalizedKey = key ?? "";
  return (
    SECRET_KEY_PATTERN.test(normalizedKey) ||
    /^database_?url$/i.test(normalizedKey) ||
    /^smtp_?url$/i.test(normalizedKey) ||
    /\b(bearer|basic)\s+[a-z0-9._~+/-]+=*/i.test(value) ||
    /^(sk-|sk_|pk_live_|rk_live_|ghp_|github_pat_|xox[baprs]-)/i.test(value) ||
    /^[a-z0-9+/]{32,}={0,2}$/i.test(value) ||
    /^[a-z][a-z0-9+.-]*:\/\/[^:\s/]+:[^@\s/]+@/i.test(value)
  );
}

function redactString(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) return "[redacted]";
  return `${trimmed.slice(0, 2)}...[redacted]...${trimmed.slice(-2)}`;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
}
