import type { AnthropicClientFactory } from "../providers/anthropic.js";
import type { LLMProvider, ProviderStreamChunk } from "../providers/types.js";
import { getDefaultRouter } from "../providers/router.js";
import { registerDefaultProviders } from "../providers/bootstrap.js";
import {
  resolvePresetToProviderModel,
  vaultProviderNamesForWorkspace,
  type ModelPreset,
} from "../providers/preset-resolver.js";
import {
  APP_BUILDER_SYSTEM_PROMPT,
  APP_BUILDER_TOOL_DESCRIPTION,
  APP_BUILDER_TOOL_INPUT_SCHEMA,
  APP_BUILDER_TOOL_NAME,
} from "../app-builder-llm-prompts.js";
import type { ModelRoutingPresetId } from "../model-routing-presets.js";
import type {
  AuthorAndValidateAppOptions,
  AuthorAndValidateAppResult,
  CodegenProgressEmit,
  GeneratedFile,
} from "../codegen/llm-author.js";
import type {
  ApiRouteStub,
  AppDraft,
  AppDraftTemplateId,
  AuthDraft,
  ComponentDraft,
  CrudFlowDraft,
  DataSchemaDraft,
  FieldSchemaDraft,
  PageDraft,
  Phase71IntegrationDraft,
  Phase71IntegrationId,
  Phase71IntegrationMetadata,
  RouteAccess,
  SeedRecord,
} from "./types.js";
import { buildAuth } from "./draft-helpers.js";
import { titleCase } from "./text-helpers.js";

export type AppDraftLLMPreset = ModelRoutingPresetId;

export interface AppDraftLLMOptions {
  preset?: AppDraftLLMPreset;
  /** Explicit model override (e.g. "claude-opus-4-7" for top-tier work). */
  model?: string;
  workspaceId?: string;
  signal?: AbortSignal;
  onFileProgress?: CodegenProgressEmit;
  /**
   * Inject a pre-built provider (used by tests to mock the SDK). When set, the
   * router resolver is bypassed and this provider is used directly.
   */
  provider?: LLMProvider;
  /**
   * Backwards-compat shim for the test fixtures that injected an Anthropic SDK
   * factory directly. When set together with `apiKey`, a one-off
   * AnthropicProvider is instantiated locally (test-only path).
   */
  clientFactory?: AnthropicClientFactory;
  /** Force the API key (test-only when paired with `clientFactory`). */
  apiKey?: string;
  /** Test-only override for the file-tree author/validate loop. */
  fileTreeAuthorFn?: (
    prompt: string,
    options: AuthorAndValidateAppOptions,
    emit: AppDraftEmit,
  ) => Promise<AuthorAndValidateAppResult | null>;
}

export type AppDraftEmit = (text: string) => void | Promise<void>;

export function modelForPreset(preset?: AppDraftLLMPreset, override?: string): string {
  if (override && override.trim().length > 0) return override.trim();
  switch (preset) {
    case "cheap":
      return "claude-haiku-4-5-20251001";
    case "smart":
    case "fast":
      return "claude-sonnet-4-6";
    case "local":
      // Local preset has no Anthropic equivalent; keep generation usable by
      // routing to the smallest hosted model.
      return "claude-haiku-4-5-20251001";
    default:
      return "claude-sonnet-4-6";
  }
}

/**
 * Internal: backwards-compat test path. Constructs a one-off AnthropicProvider
 * when the legacy `apiKey + clientFactory` test options are supplied. The
 * dynamic import keeps the `new AnthropicProvider` callsite out of the file's
 * main code path so the router-only design stays clean.
 */
async function legacyAnthropicProviderForTests(
  apiKey: string,
  clientFactory: AnthropicClientFactory,
): Promise<LLMProvider> {
  const mod = await import("../providers/anthropic.js");
  return new mod.AnthropicProvider({
    apiKeyResolver: async () => apiKey,
    clientFactory,
  }) as unknown as LLMProvider;
}

/**
 * Generates an AppDraft by streaming a structured `submit_app_draft` tool call
 * through whichever provider the preset resolver picks (Anthropic by default,
 * any of the 5 supported BYOK providers once keys are configured). Returns
 * `null` on any error (no key, network, malformed tool input) so the caller
 * can fall back to the template generator.
 */
export async function generateAppDraftViaLLM(
  prompt: string,
  options: AppDraftLLMOptions = {},
  emit?: AppDraftEmit,
): Promise<AppDraft | null> {
  const trimmed = (prompt ?? "").trim();
  if (trimmed.length < 8) return null;

  let provider: LLMProvider;
  let model: string;

  if (options.provider) {
    // Explicit provider injection (tests + future advanced callers).
    provider = options.provider;
    model = options.model ?? modelForPreset(options.preset);
  } else if (options.apiKey && options.clientFactory) {
    // Legacy test path: caller supplied an Anthropic SDK factory + key.
    provider = await legacyAnthropicProviderForTests(options.apiKey, options.clientFactory);
    model = options.model ?? modelForPreset(options.preset);
  } else {
    // Default runtime path: resolve preset → (provider, model) via the router.
    registerDefaultProviders();
    const workspaceId = options.workspaceId ?? "app-builder";
    const resolved = resolvePresetToProviderModel(options.preset as ModelPreset | undefined, {
      ...(options.model ? { modelOverride: options.model } : {}),
      vaultProviders: await vaultProviderNamesForWorkspace(workspaceId),
    });
    if (!resolved) return null;
    const router = getDefaultRouter();
    const candidate = router.get(resolved.provider);
    if (!candidate) return null;
    provider = candidate;
    model = resolved.model;
  }

  let toolInput: Record<string, unknown> | null = null;
  let proseLength = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    let stream: AsyncIterable<ProviderStreamChunk>;
    const correction =
      attempt === 1
        ? {
            role: "user" as const,
            content: [
              `Your previous ${APP_BUILDER_TOOL_NAME} call had malformed JSON arguments.`,
              "This is the single correction attempt.",
              "Call the tool again with one valid JSON object matching its schema.",
            ].join(" "),
          }
        : null;
    try {
      stream = provider.stream({
        model,
        workspaceId: options.workspaceId ?? "app-builder",
        routeKey: "workflow.draft",
        maxTokens: 4096,
        temperature: 0.2,
        ...(options.signal ? { signal: options.signal } : {}),
        messages: [
          // System message is large + reused; provider adapters that support
          // prompt-caching will attach cache_control automatically.
          { role: "system", content: APP_BUILDER_SYSTEM_PROMPT },
          { role: "user", content: trimmed },
          ...(correction ? [correction] : []),
        ],
        tools: [
          {
            name: APP_BUILDER_TOOL_NAME,
            description: APP_BUILDER_TOOL_DESCRIPTION,
            inputSchema: APP_BUILDER_TOOL_INPUT_SCHEMA,
          },
        ],
      });
    } catch (error) {
      console.warn(`[app-builder-llm] stream init failed: ${(error as Error).message}`);
      return null;
    }

    let malformedInput = false;
    try {
      for await (const chunk of stream) {
        if (chunk.error) {
          console.warn(`[app-builder-llm] stream error: ${chunk.error}`);
          return null;
        }
        if (chunk.delta && emit) {
          try {
            await emit(chunk.delta);
          } catch {
            /* emit must not break generation */
          }
          proseLength += chunk.delta.length;
        }
        if (chunk.toolCall && chunk.toolCall.name === APP_BUILDER_TOOL_NAME) {
          if (chunk.toolCall.inputError) malformedInput = true;
          else toolInput = chunk.toolCall.input ?? {};
        }
      }
    } catch (error) {
      console.warn(`[app-builder-llm] stream consume failed: ${(error as Error).message}`);
      return null;
    }

    if (!malformedInput) break;
    toolInput = null;
    if (attempt === 1) {
      console.warn("[app-builder-llm] malformed tool input after one correction attempt");
      return null;
    }
  }

  if (!toolInput) {
    console.warn(
      `[app-builder-llm] model did not call ${APP_BUILDER_TOOL_NAME} (prose=${proseLength}b)`,
    );
    return null;
  }

  try {
    return coerceLLMResultToAppDraft(trimmed, toolInput);
  } catch (error) {
    console.warn(`[app-builder-llm] coercion failed: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Result of the high-level draft generation entry point. The `source` field is
 * the discriminator:
 *   - `"template"` — fell back to the deterministic template generator.
 *   - `"llm"` — the structured tool-call path returned a draft.
 *   - `"llm-filetree"` — the opt-in Track B file-tree path returned a tree;
 *     the `files` array is the canonical source and `draft` is a derived view.
 *
 * Callers that only care about the AppDraft can keep ignoring `files`. The
 * Files / Smoke / publish surfaces that *do* care can switch on `source` to
 * decide whether to render the file tree directly.
 */
export type GenerateAppDraftResult = {
  draft: AppDraft;
  source: "llm" | "template" | "llm-filetree";
  files?: GeneratedFile[];
  /**
   * Populated when the opt-in Track B path ran and the build validator found
   * errors. Undefined otherwise. UI surfaces can render these inline so the
   * user can decide whether to ship or regenerate.
   */
  validationErrors?: string[];
};

// --- Coercion of the streamed tool input into a strict AppDraft -------------

function coerceLLMResultToAppDraft(prompt: string, raw: Record<string, unknown>): AppDraft {
  const templateId = coerceTemplateId(raw.templateId);
  const pageMap = coercePageMap(raw.pageMap);
  const components = coerceComponents(raw.components);
  const apiRouteStubs = coerceApiRouteStubs(raw.apiRouteStubs);
  const dataSchema = coerceDataSchema(raw.dataSchema);
  const seedData = coerceSeedData(raw.seedData);
  const crudFlows = coerceCrudFlows(raw.crudFlows);
  const auth = coerceAuth(raw.auth, pageMap);
  const acceptanceChecks = coerceStringArray(raw.acceptanceChecks);
  const integrationMetadata = coerceIntegrationMetadata(raw.integrationMetadata);
  const appName =
    asString(raw.appName) ||
    `${titleCase(prompt.split(/\s+/).slice(0, 2).join(" ") || "Workspace")} App`;
  const summary = asString(raw.summary) || `${appName} draft for: ${prompt}`;

  return {
    prompt,
    templateId,
    appName,
    summary,
    integrationMetadata,
    pageMap,
    components,
    apiRouteStubs,
    dataSchema,
    seedData,
    crudFlows,
    auth,
    acceptanceChecks,
  };
}

const TEMPLATE_IDS: AppDraftTemplateId[] = [
  "crm",
  "booking",
  "internal_dashboard",
  "task_tracker",
  "customer_portal",
];

function coerceTemplateId(value: unknown): AppDraftTemplateId {
  return TEMPLATE_IDS.includes(value as AppDraftTemplateId)
    ? (value as AppDraftTemplateId)
    : "task_tracker";
}

function coerceAccess(value: unknown): RouteAccess {
  return value === "public" || value === "admin" ? value : "private";
}

function coercePageMap(value: unknown): PageDraft[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("pageMap must be a non-empty array");
  return value.map((entry) => {
    const obj = (entry ?? {}) as Record<string, unknown>;
    const draft: PageDraft = {
      path: asString(obj.path) || "/",
      name: asString(obj.name) || "Page",
      access: coerceAccess(obj.access),
      purpose: asString(obj.purpose) || "Page purpose.",
      actions: coerceStringArray(obj.actions),
    };
    const primary = asString(obj.primaryEntity);
    if (primary) draft.primaryEntity = primary;
    return draft;
  });
}

function coerceComponents(value: unknown): ComponentDraft[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const obj = (entry ?? {}) as Record<string, unknown>;
    const typeValue = asString(obj.type);
    const type: ComponentDraft["type"] =
      typeValue === "layout" ||
      typeValue === "list" ||
      typeValue === "form" ||
      typeValue === "detail" ||
      typeValue === "chart" ||
      typeValue === "navigation"
        ? typeValue
        : "list";
    return {
      name: asString(obj.name) || "Component",
      type,
      usedOn: coerceStringArray(obj.usedOn),
      responsibilities: coerceStringArray(obj.responsibilities),
    };
  });
}

function coerceApiRouteStubs(value: unknown): ApiRouteStub[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const obj = (entry ?? {}) as Record<string, unknown>;
    const methodValue = asString(obj.method).toUpperCase();
    const method: ApiRouteStub["method"] =
      methodValue === "GET" ||
      methodValue === "POST" ||
      methodValue === "PATCH" ||
      methodValue === "DELETE"
        ? methodValue
        : "GET";
    const stub: ApiRouteStub = {
      method,
      path: asString(obj.path) || "/api/app/generated/unknown",
      access: coerceAccess(obj.access),
      purpose: asString(obj.purpose) || "API route purpose.",
      responseShape: asString(obj.responseShape) || "{ ok: true }",
    };
    const body = asString(obj.requestBody);
    if (body) stub.requestBody = body;
    return stub;
  });
}

function coerceDataSchema(value: unknown): DataSchemaDraft {
  const obj = (value ?? {}) as Record<string, unknown>;
  const entities = Array.isArray(obj.entities) ? obj.entities : [];
  return {
    database: "postgres",
    entities: entities.map((entry) => {
      const e = (entry ?? {}) as Record<string, unknown>;
      return {
        name: asString(e.name) || "entity",
        primaryKey: asString(e.primaryKey) || "id",
        fields: coerceFields(e.fields),
        indexes: coerceStringArray(e.indexes),
        relations: coerceStringArray(e.relations),
      };
    }),
    notes: coerceStringArray(obj.notes),
  };
}

function coerceFields(value: unknown): FieldSchemaDraft[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const obj = (entry ?? {}) as Record<string, unknown>;
    const typeValue = asString(obj.type);
    const type: FieldSchemaDraft["type"] =
      typeValue === "uuid" ||
      typeValue === "string" ||
      typeValue === "text" ||
      typeValue === "number" ||
      typeValue === "boolean" ||
      typeValue === "date" ||
      typeValue === "datetime" ||
      typeValue === "enum"
        ? typeValue
        : "string";
    const field: FieldSchemaDraft = {
      name: asString(obj.name) || "field",
      type,
      required: obj.required === true,
    };
    if (Array.isArray(obj.enumValues)) {
      field.enumValues = (obj.enumValues as unknown[])
        .map((entryValue) => asString(entryValue))
        .filter((v) => v.length > 0);
    }
    const ref = asString(obj.references);
    if (ref) field.references = ref;
    return field;
  });
}

function coerceSeedData(value: unknown): Record<string, SeedRecord[]> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, SeedRecord[]> = {};
  for (const [key, rows] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(rows)) continue;
    out[key] = rows.map((row) => {
      const record: SeedRecord = {};
      if (row && typeof row === "object") {
        for (const [field, raw] of Object.entries(row as Record<string, unknown>)) {
          if (raw === null) {
            record[field] = null;
            continue;
          }
          if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
            record[field] = raw;
          } else {
            record[field] = JSON.stringify(raw);
          }
        }
      }
      return record;
    });
  }
  return out;
}

function coerceCrudFlows(value: unknown): CrudFlowDraft[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const obj = (entry ?? {}) as Record<string, unknown>;
    return {
      entity: asString(obj.entity) || "entity",
      create: coerceStringArray(obj.create),
      read: coerceStringArray(obj.read),
      update: coerceStringArray(obj.update),
      delete: coerceStringArray(obj.delete),
    };
  });
}

function coerceAuth(value: unknown, pages: PageDraft[]): AuthDraft {
  const obj = (value ?? {}) as Record<string, unknown>;
  const publicRoutes = coerceStringArray(obj.publicRoutes);
  const privateRoutes = coerceStringArray(obj.privateRoutes);
  const roleRoutesRaw = Array.isArray(obj.roleRoutes) ? obj.roleRoutes : [];
  const decisions = coerceStringArray(obj.decisions);

  const roleRoutes = roleRoutesRaw
    .map((entry) => {
      const r = (entry ?? {}) as Record<string, unknown>;
      return {
        role: "admin" as const,
        routes: coerceStringArray(r.routes),
        reason: asString(r.reason) || "Administrative pages require an admin role.",
      };
    })
    .filter((entry) => entry.routes.length > 0);

  // If the model omitted auth bucketing entirely, derive from pageMap so the
  // downstream generator does not see an empty auth surface.
  const hasAny = publicRoutes.length + privateRoutes.length + roleRoutes.length > 0;
  if (!hasAny) {
    return buildAuth(pages);
  }
  return {
    defaultPolicy: "authenticated-by-default",
    publicRoutes,
    privateRoutes,
    roleRoutes,
    decisions:
      decisions.length > 0
        ? decisions
        : [
            "Only explicitly public pages can be viewed without a session.",
            "Private API routes require an authenticated workspace user.",
            "Admin routes require an admin role in addition to authentication.",
          ],
  };
}

function coerceIntegrationMetadata(value: unknown): Phase71IntegrationMetadata {
  const obj = (value ?? {}) as Record<string, unknown>;
  const requestedRaw = Array.isArray(obj.requested) ? obj.requested : [];
  const validIds: Phase71IntegrationId[] = [
    "openai",
    "anthropic",
    "ollama",
    "custom_api",
    "slack_webhook",
    "email",
    "github",
    "browser",
    "stripe",
    "database",
  ];
  const requested = requestedRaw
    .map((entry) => {
      const r = (entry ?? {}) as Record<string, unknown>;
      const id = asString(r.id) as Phase71IntegrationId;
      if (!validIds.includes(id)) return null;
      return {
        id,
        label: asString(r.label) || id,
        envVars: coerceStringArray(r.envVars),
        flows: coerceStringArray(r.flows),
        setupGuidance: coerceStringArray(r.setupGuidance),
      } satisfies Phase71IntegrationDraft;
    })
    .filter((entry): entry is Phase71IntegrationDraft => entry !== null);
  const setupGuidance = coerceStringArray(obj.setupGuidance);
  return {
    requested,
    setupGuidance:
      setupGuidance.length > 0 ? setupGuidance : requested.flatMap((entry) => entry.setupGuidance),
  };
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => asString(entry)).filter((entry) => entry.length > 0);
}

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}
