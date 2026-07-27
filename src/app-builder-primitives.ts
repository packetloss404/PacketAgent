export type AppBuilderPrimitiveKind =
  | "ai_feature"
  | "database_crud"
  | "scheduled_job"
  | "webhook"
  | "payment";

export type AppBuilderPrimitiveReadinessStatus = "ready" | "needs_setup";

export type AppBuilderPrimitiveDraftReference = {
  primitiveId: string;
  kind: AppBuilderPrimitiveKind;
  draftKey: string;
  planLabel: string;
  readinessKey: string;
};

export type AppBuilderPrimitive = {
  id: string;
  kind: AppBuilderPrimitiveKind;
  name: string;
  summary: string;
  generatedAppUse: string;
  supportedBlocks: string[];
  requiredEnv: string[];
  optionalEnv: string[];
  draftReference: AppBuilderPrimitiveDraftReference;
};

export type AppBuilderPrimitiveCatalogInput = {
  requestedKinds?: AppBuilderPrimitiveKind[];
  requestedPrimitiveIds?: string[];
  readiness?: AppBuilderPrimitiveReadinessInput;
};

export type AppBuilderPrimitiveCatalogSummary = {
  version: "phase-68-lane-4";
  primitives: AppBuilderPrimitive[];
  references: AppBuilderPrimitiveDraftReference[];
  readiness: AppBuilderPrimitiveReadinessSummary;
  generationHints: string[];
};

export type AppBuilderPrimitiveReadinessInput = {
  requestedKinds?: AppBuilderPrimitiveKind[];
  requestedPrimitiveIds?: string[];
  env?: Record<string, string | undefined>;
  providers?: Array<{
    kind?: string;
    status?: string;
    apiKeyConfigured?: boolean;
  }>;
  availableTools?: string[];
  database?: {
    configured?: boolean;
    supportsCrud?: boolean;
    mode?: string;
  };
  scheduler?: {
    configured?: boolean;
    supportsRecurringJobs?: boolean;
  };
  webhook?: {
    publicBaseUrl?: string;
    signingSecretConfigured?: boolean;
  };
  payments?: {
    provider?: "stripe" | "manual";
    checkoutEnabled?: boolean;
    secretKeyConfigured?: boolean;
    webhookSecretConfigured?: boolean;
  };
};

export type AppBuilderPrimitiveReadinessEntry = {
  primitiveId: string;
  kind: AppBuilderPrimitiveKind;
  ready: boolean;
  status: AppBuilderPrimitiveReadinessStatus;
  missingSecrets: string[];
  requiredSetup: string[];
  message: string;
  draftReference: AppBuilderPrimitiveDraftReference;
};

export type PaymentBlockReadiness = {
  ready: boolean;
  status: AppBuilderPrimitiveReadinessStatus;
  provider: "stripe" | "manual";
  missingSecrets: string[];
  requiredSetup: string[];
  message: string;
};

export type AppBuilderPrimitiveReadinessSummary = {
  ready: boolean;
  status: AppBuilderPrimitiveReadinessStatus;
  readyCount: number;
  needsSetupCount: number;
  entries: AppBuilderPrimitiveReadinessEntry[];
  byKind: Record<AppBuilderPrimitiveKind, AppBuilderPrimitiveReadinessEntry | null>;
  missingSecrets: string[];
  recommendedSetup: string[];
  unknownPrimitiveIds: string[];
};

export const APP_BUILDER_PRIMITIVES: readonly AppBuilderPrimitive[] = [
  {
    id: "ai.feature",
    kind: "ai_feature",
    name: "AI feature block",
    summary: "Adds model-backed generation, classification, extraction, summarization, or chat features.",
    generatedAppUse: "Use for generated app features that call an LLM or produce structured AI output.",
    supportedBlocks: ["chat", "completion", "classification", "extraction", "summarization"],
    requiredEnv: ["OPENAI_API_KEY or ANTHROPIC_API_KEY or OLLAMA_BASE_URL"],
    optionalEnv: ["PACKETAGENT_AI_MODEL"],
    draftReference: {
      primitiveId: "ai.feature",
      kind: "ai_feature",
      draftKey: "aiFeatures",
      planLabel: "AI feature readiness",
      readinessKey: "ai",
    },
  },
  {
    id: "database.crud",
    kind: "database_crud",
    name: "Database CRUD block",
    summary: "Describes data tables, fields, seed rows, and create/read/update/delete flows.",
    generatedAppUse: "Use for generated app drafts with data-backed list, detail, create, edit, and delete screens.",
    supportedBlocks: ["schema", "seed_data", "list", "detail", "create", "update", "delete"],
    requiredEnv: [],
    optionalEnv: ["DATABASE_URL", "PACKETAGENT_DATABASE_URL", "PACKETAGENT_DB_PATH"],
    draftReference: {
      primitiveId: "database.crud",
      kind: "database_crud",
      draftKey: "dataModels",
      planLabel: "Database CRUD readiness",
      readinessKey: "database",
    },
  },
  {
    id: "scheduled.job",
    kind: "scheduled_job",
    name: "Scheduled job block",
    summary: "Defines recurring jobs with cron cadence, payload shape, and retry posture.",
    generatedAppUse: "Use for generated app drafts that need background work on a schedule.",
    supportedBlocks: ["cron", "recurring_job", "retry", "job_payload"],
    requiredEnv: [],
    optionalEnv: ["PACKETAGENT_SCHEDULER_HTTP_LEADER_URL", "PACKETAGENT_SCHEDULER_COORDINATION_EVIDENCE"],
    draftReference: {
      primitiveId: "scheduled.job",
      kind: "scheduled_job",
      draftKey: "scheduledJobs",
      planLabel: "Scheduled job readiness",
      readinessKey: "scheduler",
    },
  },
  {
    id: "webhook.endpoint",
    kind: "webhook",
    name: "Webhook block",
    summary: "Defines inbound HTTP event handlers with payload examples and signing-secret posture.",
    generatedAppUse: "Use for generated app drafts that receive external events from Slack, GitHub, Stripe, or custom systems.",
    supportedBlocks: ["inbound_event", "payload_validation", "signature_check", "event_response"],
    requiredEnv: [],
    optionalEnv: ["PACKETAGENT_PUBLIC_BASE_URL", "PACKETAGENT_WEBHOOK_SIGNING_SECRET"],
    draftReference: {
      primitiveId: "webhook.endpoint",
      kind: "webhook",
      draftKey: "webhooks",
      planLabel: "Webhook readiness",
      readinessKey: "webhook",
    },
  },
  {
    id: "payment.checkout",
    kind: "payment",
    name: "Payment block",
    summary: "Describes checkout, subscription, customer portal, and payment webhook readiness.",
    generatedAppUse: "Use for generated app drafts that need Stripe-style checkout or subscription flows.",
    supportedBlocks: ["checkout", "subscription", "customer_portal", "payment_webhook"],
    requiredEnv: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
    optionalEnv: ["STRIPE_PRICE_ID", "STRIPE_PUBLISHABLE_KEY"],
    draftReference: {
      primitiveId: "payment.checkout",
      kind: "payment",
      draftKey: "payments",
      planLabel: "Payment readiness",
      readinessKey: "payments",
    },
  },
];

const PRIMITIVE_ORDER = new Map(APP_BUILDER_PRIMITIVES.map((primitive, index) => [primitive.id, index]));
const PRIMITIVES_BY_ID = new Map(APP_BUILDER_PRIMITIVES.map((primitive) => [primitive.id, primitive]));
export const APP_BUILDER_PRIMITIVE_KINDS: readonly AppBuilderPrimitiveKind[] = [
  "ai_feature",
  "database_crud",
  "scheduled_job",
  "webhook",
  "payment",
];

export function listAppBuilderPrimitives(input: AppBuilderPrimitiveCatalogInput = {}): AppBuilderPrimitive[] {
  return selectPrimitives(input).map(copyPrimitive);
}

export function findAppBuilderPrimitive(id: string): AppBuilderPrimitive | null {
  const primitive = PRIMITIVES_BY_ID.get(id);
  return primitive ? copyPrimitive(primitive) : null;
}

export function buildAppBuilderPrimitiveCatalog(input: AppBuilderPrimitiveCatalogInput = {}): AppBuilderPrimitiveCatalogSummary {
  const primitives = listAppBuilderPrimitives(input);
  const readiness = buildAppBuilderPrimitiveReadinessSummary({
    ...input.readiness,
    requestedKinds: input.readiness?.requestedKinds ?? input.requestedKinds,
    requestedPrimitiveIds: input.readiness?.requestedPrimitiveIds ?? input.requestedPrimitiveIds,
  });

  return {
    version: "phase-68-lane-4",
    primitives,
    references: primitives.map((primitive) => ({ ...primitive.draftReference })),
    readiness,
    generationHints: primitives.map(
      (primitive) => `${primitive.draftReference.draftKey}: ${primitive.generatedAppUse}`,
    ),
  };
}

export function buildAppBuilderPrimitiveReadinessSummary(
  input: AppBuilderPrimitiveReadinessInput = {},
): AppBuilderPrimitiveReadinessSummary {
  const primitives = selectPrimitives(input);
  const unknownPrimitiveIds = unknownRequestedPrimitiveIds(input);
  const entries = primitives.map((primitive) => buildPrimitiveReadinessEntry(primitive, input));
  const byKind = Object.fromEntries(APP_BUILDER_PRIMITIVE_KINDS.map((kind) => [kind, null])) as Record<
    AppBuilderPrimitiveKind,
    AppBuilderPrimitiveReadinessEntry | null
  >;

  for (const entry of entries) {
    byKind[entry.kind] = entry;
  }

  const missingSecrets = uniqueSorted(entries.flatMap((entry) => entry.missingSecrets));
  const recommendedSetup = uniqueSorted([
    ...entries.flatMap((entry) => entry.requiredSetup),
    ...unknownPrimitiveIds.map((id) => `Remove or register unknown app builder primitive ${id}.`),
  ]);
  const needsSetupCount = entries.filter((entry) => !entry.ready).length + unknownPrimitiveIds.length;
  const readyCount = entries.filter((entry) => entry.ready).length;
  const ready = needsSetupCount === 0;

  return {
    ready,
    status: ready ? "ready" : "needs_setup",
    readyCount,
    needsSetupCount,
    entries,
    byKind,
    missingSecrets,
    recommendedSetup,
    unknownPrimitiveIds,
  };
}

export function buildPrimitiveReadinessSummary(input: AppBuilderPrimitiveReadinessInput = {}) {
  return buildAppBuilderPrimitiveReadinessSummary(input);
}

export function listAppBuilderPrimitiveCatalog(input: AppBuilderPrimitiveCatalogInput = {}) {
  return buildAppBuilderPrimitiveCatalog(input);
}

export function buildPaymentBlockReadiness(input: AppBuilderPrimitiveReadinessInput = {}): PaymentBlockReadiness {
  const env = input.env ?? {};
  const provider = input.payments?.provider ?? "stripe";
  const secretKeyConfigured = input.payments?.secretKeyConfigured ?? hasEnv(env, "STRIPE_SECRET_KEY");
  const webhookSecretConfigured = input.payments?.webhookSecretConfigured ?? hasEnv(env, "STRIPE_WEBHOOK_SECRET");
  const checkoutEnabled = input.payments?.checkoutEnabled ?? provider === "stripe";
  const missingSecrets = [
    ...(!secretKeyConfigured ? ["STRIPE_SECRET_KEY"] : []),
    ...(!webhookSecretConfigured ? ["STRIPE_WEBHOOK_SECRET"] : []),
  ];
  const requiredSetup = [
    ...(!checkoutEnabled ? ["Enable checkout in the payment provider configuration."] : []),
    ...(missingSecrets.length > 0 ? [`Configure payment secrets: ${missingSecrets.join(", ")}.`] : []),
  ];
  const ready = checkoutEnabled && missingSecrets.length === 0;

  return {
    ready,
    status: ready ? "ready" : "needs_setup",
    provider,
    missingSecrets,
    requiredSetup,
    message: ready
      ? "Payment blocks can reference checkout and payment webhook readiness."
      : "Payment blocks can be drafted, but checkout should stay disabled until provider secrets are configured.",
  };
}

function buildPrimitiveReadinessEntry(
  primitive: AppBuilderPrimitive,
  input: AppBuilderPrimitiveReadinessInput,
): AppBuilderPrimitiveReadinessEntry {
  if (primitive.kind === "ai_feature") return buildAiReadinessEntry(primitive, input);
  if (primitive.kind === "database_crud") return buildDatabaseReadinessEntry(primitive, input);
  if (primitive.kind === "scheduled_job") return buildSchedulerReadinessEntry(primitive, input);
  if (primitive.kind === "webhook") return buildWebhookReadinessEntry(primitive, input);
  return buildPaymentReadinessEntry(primitive, input);
}

function buildAiReadinessEntry(
  primitive: AppBuilderPrimitive,
  input: AppBuilderPrimitiveReadinessInput,
): AppBuilderPrimitiveReadinessEntry {
  const env = input.env ?? {};
  const providerReady = (input.providers ?? []).some(
    (provider) => provider.status === "connected" && provider.apiKeyConfigured !== false,
  );
  const envReady = hasEnv(env, "OPENAI_API_KEY")
    || hasEnv(env, "ANTHROPIC_API_KEY")
    || hasEnv(env, "OLLAMA_BASE_URL")
    || envFlag(env, "PACKETAGENT_AI_PROVIDER_READY");
  const ready = providerReady || envReady;
  const missingSecrets = ready ? [] : ["OPENAI_API_KEY or ANTHROPIC_API_KEY or OLLAMA_BASE_URL"];

  return readinessEntry(primitive, ready, missingSecrets, ready
    ? []
    : ["Connect an AI provider or configure a local Ollama endpoint before enabling AI feature blocks."],
  ready
    ? "AI feature blocks can reference configured model execution."
    : "AI feature blocks can be planned, but generated runtime calls need a configured model provider.");
}

function buildDatabaseReadinessEntry(
  primitive: AppBuilderPrimitive,
  input: AppBuilderPrimitiveReadinessInput,
): AppBuilderPrimitiveReadinessEntry {
  const supportsCrud = input.database?.supportsCrud ?? true;
  const configured = input.database?.configured ?? true;
  const ready = supportsCrud && configured;

  return readinessEntry(primitive, ready, [], ready
    ? []
    : ["Choose a supported generated-app data store before enabling CRUD flows."],
  ready
    ? "Database CRUD blocks can describe schema metadata, seed data, and CRUD flows."
    : "Database CRUD blocks need a supported store before generated routes should mutate data.");
}

function buildSchedulerReadinessEntry(
  primitive: AppBuilderPrimitive,
  input: AppBuilderPrimitiveReadinessInput,
): AppBuilderPrimitiveReadinessEntry {
  const supportsRecurringJobs = input.scheduler?.supportsRecurringJobs ?? true;
  const configured = input.scheduler?.configured ?? true;
  const ready = supportsRecurringJobs && configured;

  return readinessEntry(primitive, ready, [], ready
    ? []
    : ["Enable recurring job support before generated scheduled job blocks run automatically."],
  ready
    ? "Scheduled job blocks can reference cron cadence, payload, and retry metadata."
    : "Scheduled job blocks can be drafted, but automatic execution needs scheduler support.");
}

function buildWebhookReadinessEntry(
  primitive: AppBuilderPrimitive,
  input: AppBuilderPrimitiveReadinessInput,
): AppBuilderPrimitiveReadinessEntry {
  const env = input.env ?? {};
  const hasPublicBaseUrl = Boolean(cleanString(input.webhook?.publicBaseUrl)) || hasEnv(env, "PACKETAGENT_PUBLIC_BASE_URL");
  const hasSigningSecret = input.webhook?.signingSecretConfigured === true || hasEnv(env, "PACKETAGENT_WEBHOOK_SIGNING_SECRET");
  const missingSecrets = hasSigningSecret ? [] : ["PACKETAGENT_WEBHOOK_SIGNING_SECRET"];
  const requiredSetup = [
    ...(!hasPublicBaseUrl ? ["Set PACKETAGENT_PUBLIC_BASE_URL before publishing external webhook URLs."] : []),
    ...(!hasSigningSecret ? ["Configure PACKETAGENT_WEBHOOK_SIGNING_SECRET for signed inbound webhook blocks."] : []),
  ];
  const ready = requiredSetup.length === 0;

  return readinessEntry(primitive, ready, missingSecrets, requiredSetup, ready
    ? "Webhook blocks can reference public URL and signing-secret readiness."
    : "Webhook blocks can be drafted, but publishing should wait for public URL and signing-secret setup.");
}

function buildPaymentReadinessEntry(
  primitive: AppBuilderPrimitive,
  input: AppBuilderPrimitiveReadinessInput,
): AppBuilderPrimitiveReadinessEntry {
  const payment = buildPaymentBlockReadiness(input);
  return readinessEntry(primitive, payment.ready, payment.missingSecrets, payment.requiredSetup, payment.message);
}

function readinessEntry(
  primitive: AppBuilderPrimitive,
  ready: boolean,
  missingSecrets: string[],
  requiredSetup: string[],
  message: string,
): AppBuilderPrimitiveReadinessEntry {
  return {
    primitiveId: primitive.id,
    kind: primitive.kind,
    ready,
    status: ready ? "ready" : "needs_setup",
    missingSecrets,
    requiredSetup,
    message,
    draftReference: { ...primitive.draftReference },
  };
}

function selectPrimitives(input: AppBuilderPrimitiveCatalogInput | AppBuilderPrimitiveReadinessInput): AppBuilderPrimitive[] {
  const requestedIds = new Set(input.requestedPrimitiveIds ?? []);
  const requestedKinds = new Set(input.requestedKinds ?? []);

  return APP_BUILDER_PRIMITIVES
    .filter((primitive) => {
      const idSelected = requestedIds.size === 0 || requestedIds.has(primitive.id);
      const kindSelected = requestedKinds.size === 0 || requestedKinds.has(primitive.kind);
      return idSelected && kindSelected;
    })
    .sort((left, right) => (PRIMITIVE_ORDER.get(left.id) ?? 0) - (PRIMITIVE_ORDER.get(right.id) ?? 0));
}

function unknownRequestedPrimitiveIds(input: AppBuilderPrimitiveCatalogInput | AppBuilderPrimitiveReadinessInput): string[] {
  return uniqueSorted((input.requestedPrimitiveIds ?? []).filter((id) => !PRIMITIVES_BY_ID.has(id)));
}

function copyPrimitive(primitive: AppBuilderPrimitive): AppBuilderPrimitive {
  return {
    ...primitive,
    supportedBlocks: [...primitive.supportedBlocks],
    requiredEnv: [...primitive.requiredEnv],
    optionalEnv: [...primitive.optionalEnv],
    draftReference: { ...primitive.draftReference },
  };
}

function hasEnv(env: Record<string, string | undefined>, key: string): boolean {
  return cleanString(env[key]).length > 0;
}

function envFlag(env: Record<string, string | undefined>, key: string): boolean {
  return ["1", "true", "yes"].includes(cleanString(env[key]).toLowerCase());
}

function cleanString(value: string | undefined): string {
  return String(value ?? "").trim();
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
