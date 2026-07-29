import type { LLMProvider, ProviderStreamChunk } from "./providers/types.js";
import { getDefaultRouter, type ProviderRouter } from "./providers/router.js";
import { registerDefaultProviders } from "./providers/bootstrap.js";
import { resolvePresetToProviderModel, type ModelPreset } from "./providers/preset-resolver.js";
import {
  authorAndValidateAppViaLLM,
  authorAppViaLLM,
  type AuthorAppOptions,
  type AuthorAppResult,
  type GeneratedFile,
} from "./codegen/llm-author.js";
import { validateFileTree, type ValidationResult } from "./codegen/validate.js";

export type AppIterationTargetKind = "page" | "api" | "data" | "auth" | "config";
export type AppIterationAction = "add" | "update" | "remove";
export type AppIterationRiskSeverity = "low" | "medium" | "high";

export type AppIterationPresetId = "fast" | "smart" | "cheap" | "local";

export interface AppIterationLLMOptions {
  workspaceId: string;
  preset?: AppIterationPresetId;
  signal?: AbortSignal;
  /**
   * Inject a pre-built provider (used by tests to mock the SDK). When set, the
   * router resolver is bypassed and this provider is used directly. Accepts
   * any `LLMProvider` (was previously typed as `AnthropicProvider` only).
   */
  provider?: LLMProvider;
}

export interface AppIterationLLMResult {
  changedSummary: string;
  files: Array<{
    path: string;
    changeType: "added" | "modified" | "deleted" | "renamed";
    summary: string;
    diff: string;
  }>;
  prose: string;
  model: string;
}

const PRESET_TO_MODEL: Record<AppIterationPresetId, string> = {
  cheap: "claude-haiku-4-5-20251001",
  fast: "claude-haiku-4-5-20251001",
  smart: "claude-sonnet-4-6",
  local: "claude-sonnet-4-6",
};
const DEFAULT_LLM_MODEL = "claude-sonnet-4-6";

const ITERATION_SYSTEM_PROMPT = [
  "You are PacketAgent's app-builder iteration assistant.",
  "Given a current app draft (pages, API routes, data entities, auth, config) and a user iteration prompt,",
  "produce a concrete change set as a tool call to `submit_iteration_diff`.",
  "",
  "Constraints:",
  "- Only emit changes that are clearly implied by the user prompt.",
  "- Each file entry must include a stable path under the generated app (e.g. `app/pages/<slug>.tsx`, `app/api/<route>.ts`, `app/data/<entity>.ts`).",
  "- `changeType` is one of: added, modified, deleted, renamed.",
  "- `diff` should be a short unified-diff style snippet describing the intent of the change (it does not need to be byte-perfect).",
  "- `changedSummary` is a single sentence describing the overall change.",
  "",
  "Before calling the tool, narrate what you plan to do as plain prose text (one short paragraph).",
  "Then call `submit_iteration_diff` exactly once.",
].join("\n");

const ITERATION_TOOL_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    changedSummary: {
      type: "string",
      description: "Single-sentence summary of the change.",
    },
    files: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path of the generated source file." },
          changeType: {
            type: "string",
            enum: ["added", "modified", "deleted", "renamed"],
          },
          summary: { type: "string", description: "One-line description of this file change." },
          diff: {
            type: "string",
            description: "Unified-diff style snippet describing the change.",
          },
        },
        required: ["path", "changeType", "summary", "diff"],
      },
    },
  },
  required: ["changedSummary", "files"],
};

const ITERATION_TOOL_NAME = "submit_iteration_diff";

export interface AppIterationTargetInput {
  kind?: AppIterationTargetKind;
  key?: string;
  path?: string;
  name?: string;
}

export interface AppIterationChangeRequest {
  draftId?: string;
  workspaceId?: string;
  target?: AppIterationTargetInput;
  change: string;
}

export interface GeneratedAppDraftLike {
  appName?: string;
  pageMap?: GeneratedPageDraftLike[];
  apiRouteStubs?: GeneratedApiRouteDraftLike[];
  dataSchema?: GeneratedDataSchemaDraftLike;
  auth?: GeneratedAuthDraftLike;
  acceptanceChecks?: string[];
  config?: GeneratedConfigDraftLike;
  [key: string]: unknown;
}

export interface GeneratedPageDraftLike {
  path: string;
  name?: string;
  access?: "public" | "private" | "admin" | string;
  purpose?: string;
  primaryEntity?: string;
  actions?: string[];
  [key: string]: unknown;
}

export interface GeneratedApiRouteDraftLike {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | string;
  path: string;
  access?: "public" | "private" | "admin" | string;
  purpose?: string;
  requestBody?: string;
  responseShape?: string;
  [key: string]: unknown;
}

export interface GeneratedDataSchemaDraftLike {
  database?: string;
  entities?: GeneratedEntityDraftLike[];
  notes?: string[];
  [key: string]: unknown;
}

export interface GeneratedEntityDraftLike {
  name: string;
  primaryKey?: string;
  fields?: GeneratedFieldDraftLike[];
  indexes?: string[];
  relations?: string[];
  [key: string]: unknown;
}

export interface GeneratedFieldDraftLike {
  name: string;
  type?: string;
  required?: boolean;
  enumValues?: string[];
  references?: string;
  [key: string]: unknown;
}

export interface GeneratedAuthDraftLike {
  defaultPolicy?: string;
  publicRoutes?: string[];
  privateRoutes?: string[];
  roleRoutes?: Array<{ role: string; routes: string[]; reason?: string }>;
  decisions?: string[];
  [key: string]: unknown;
}

export interface GeneratedConfigDraftLike {
  env?: string[];
  featureFlags?: Record<string, boolean>;
  notes?: string[];
  [key: string]: unknown;
}

export interface NormalizedAppIterationRequest {
  draftId: string;
  workspaceId?: string;
  requestedChange: string;
  action: AppIterationAction;
  target: SelectedAppIterationTarget;
}

export interface SelectedAppIterationTarget {
  kind: AppIterationTargetKind;
  key: string;
  path?: string;
  name?: string;
  exists: boolean;
  label: string;
}

export interface AppIterationDiffHunk {
  id: string;
  target: SelectedAppIterationTarget;
  action: AppIterationAction;
  summary: string;
  before: string;
  after: string;
}

export interface AppIterationRisk {
  severity: AppIterationRiskSeverity;
  code: string;
  message: string;
}

export interface AppIterationRollbackCheckpoint {
  checkpointId: string;
  draftHash: string;
  requestHash: string;
  targetKey: string;
  label: string;
}

export interface AppIterationPlan {
  version: "phase-69-lane-2";
  request: NormalizedAppIterationRequest;
  diffHunks: AppIterationDiffHunk[];
  warnings: string[];
  risks: AppIterationRisk[];
  rollbackCheckpoint: AppIterationRollbackCheckpoint;
  canApply: boolean;
}

export interface AppIterationApplyResult {
  applied: boolean;
  draft: GeneratedAppDraftLike;
  plan: AppIterationPlan;
  rollbackCheckpoint: AppIterationRollbackCheckpoint;
  afterDraftHash: string;
}

const DEFAULT_DRAFT_ID = "generated-app-draft";
const VERSION = "phase-69-lane-2";
const SECRET_PATTERN =
  /\b((?:[A-Z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*)|authorization|bearer)\b\s*[:=]\s*["']?(?:Bearer\s+)?[^"',\s)]+/i;
const SECRET_PATTERN_GLOBAL =
  /\b((?:[A-Z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*)|authorization|bearer)\b\s*[:=]\s*["']?(?:Bearer\s+)?[^"',\s)]+/gi;

export function buildAppIterationPlan(
  draft: GeneratedAppDraftLike,
  request: AppIterationChangeRequest,
): AppIterationPlan {
  const normalized = normalizeAppIterationRequest(draft, request);
  const diffHunks = generateAppIterationDiffHunks(draft, normalized);
  const warnings = buildAppIterationWarnings(draft, normalized);
  const risks = assessAppIterationRisk(normalized);

  return {
    version: VERSION,
    request: normalized,
    diffHunks,
    warnings,
    risks,
    rollbackCheckpoint: buildRollbackCheckpoint(draft, normalized),
    canApply: normalized.requestedChange.length > 0 && diffHunks.length > 0,
  };
}

export function normalizeAppIterationRequest(
  draft: GeneratedAppDraftLike,
  request: AppIterationChangeRequest,
): NormalizedAppIterationRequest {
  const requestedChange = cleanText(request.change);
  const action = inferAction(requestedChange);
  const target = selectAppIterationTarget(draft, request.target, requestedChange);

  return {
    draftId: cleanText(request.draftId) || DEFAULT_DRAFT_ID,
    workspaceId: cleanText(request.workspaceId) || undefined,
    requestedChange,
    action,
    target,
  };
}

export function selectAppIterationTarget(
  draft: GeneratedAppDraftLike,
  target: AppIterationTargetInput | undefined,
  requestedChange: string,
): SelectedAppIterationTarget {
  const kind = target?.kind ?? inferTargetKind(requestedChange);
  if (kind === "page") return selectPageTarget(draft, target, requestedChange);
  if (kind === "api") return selectApiTarget(draft, target, requestedChange);
  if (kind === "data") return selectDataTarget(draft, target, requestedChange);
  if (kind === "auth") return selectAuthTarget(draft, target, requestedChange);
  return selectConfigTarget(target, requestedChange);
}

export function generateAppIterationDiffHunks(
  draft: GeneratedAppDraftLike,
  request: NormalizedAppIterationRequest,
): AppIterationDiffHunk[] {
  const before = readTargetSnapshot(draft, request.target);
  const after = buildTargetAfterSnapshot(draft, request);

  if (request.action === "remove" && !request.target.exists) return [];

  return [
    {
      id: `${request.target.kind}:${request.action}:${stableKey(request.target.key)}`,
      target: request.target,
      action: request.action,
      summary: buildHunkSummary(request),
      before: stableStringify(before),
      after: stableStringify(after),
    },
  ];
}

export function assessAppIterationRisk(request: NormalizedAppIterationRequest): AppIterationRisk[] {
  const risks: AppIterationRisk[] = [];
  const change = request.requestedChange.toLowerCase();

  if (request.action === "remove") {
    risks.push({
      severity: request.target.kind === "page" ? "medium" : "high",
      code: "destructive-change",
      message: "Removal requests should keep a rollback checkpoint until smoke checks pass.",
    });
  }

  if (request.target.kind === "auth" || /\b(public|admin|permission|role|auth)\b/i.test(change)) {
    risks.push({
      severity: request.target.kind === "auth" ? "high" : "medium",
      code: "access-control",
      message: "Access-control changes can expose or hide generated app surfaces.",
    });
  }

  if (request.target.kind === "data") {
    risks.push({
      severity: request.action === "remove" ? "high" : "medium",
      code: "data-contract",
      message: "Data schema changes may require seed, CRUD, and API contract updates.",
    });
  }

  if (request.target.kind === "config" || SECRET_PATTERN.test(request.requestedChange)) {
    risks.push({
      severity: SECRET_PATTERN.test(request.requestedChange) ? "high" : "low",
      code: "configuration",
      message:
        "Configuration changes should avoid embedding literal secrets in generated draft metadata.",
    });
  }

  return uniqueRisks(risks);
}

export function buildRollbackCheckpoint(
  draft: GeneratedAppDraftLike,
  request: NormalizedAppIterationRequest,
): AppIterationRollbackCheckpoint {
  const draftHash = shortHash(stableStringify(draft));
  const requestHash = shortHash(
    stableStringify({
      action: request.action,
      target: request.target,
      requestedChange: request.requestedChange,
    }),
  );

  return {
    checkpointId: `app-iteration-${draftHash}-${requestHash}`,
    draftHash,
    requestHash,
    targetKey: request.target.key,
    label: `${request.action} ${request.target.label}`,
  };
}

export function applyAppIterationToDraft(
  draft: GeneratedAppDraftLike,
  request: AppIterationChangeRequest | AppIterationPlan,
): AppIterationApplyResult {
  const plan = "diffHunks" in request ? request : buildAppIterationPlan(draft, request);
  const nextDraft = cloneDraft(draft);

  if (!plan.canApply) {
    return {
      applied: false,
      draft: nextDraft,
      plan,
      rollbackCheckpoint: plan.rollbackCheckpoint,
      afterDraftHash: shortHash(stableStringify(nextDraft)),
    };
  }

  applyTargetMutation(nextDraft, plan.request);

  return {
    applied: true,
    draft: nextDraft,
    plan,
    rollbackCheckpoint: plan.rollbackCheckpoint,
    afterDraftHash: shortHash(stableStringify(nextDraft)),
  };
}

function buildAppIterationWarnings(
  draft: GeneratedAppDraftLike,
  request: NormalizedAppIterationRequest,
): string[] {
  const warnings = [
    ...(request.requestedChange.length === 0 ? ["Requested change is empty."] : []),
    ...(!request.target.exists && request.action !== "add"
      ? [
          `Selected ${request.target.kind} target does not exist; applying will create a scoped draft entry instead.`,
        ]
      : []),
    ...(request.action === "remove"
      ? ["Removal request should be reviewed before publishing generated app changes."]
      : []),
    ...(SECRET_PATTERN.test(request.requestedChange)
      ? [
          "Requested change appears to include a literal secret; store secrets in environment configuration instead.",
        ]
      : []),
    ...(request.target.kind === "auth" && !draft.auth
      ? ["Draft has no auth block; applying will create one."]
      : []),
  ];

  return uniqueSorted(warnings);
}

function applyTargetMutation(
  draft: GeneratedAppDraftLike,
  request: NormalizedAppIterationRequest,
): void {
  if (request.target.kind === "page") applyPageMutation(draft, request);
  if (request.target.kind === "api") applyApiMutation(draft, request);
  if (request.target.kind === "data") applyDataMutation(draft, request);
  if (request.target.kind === "auth") applyAuthMutation(draft, request);
  if (request.target.kind === "config") applyConfigMutation(draft, request);
}

function applyPageMutation(
  draft: GeneratedAppDraftLike,
  request: NormalizedAppIterationRequest,
): void {
  const pages = [...(draft.pageMap ?? [])];
  const index = pages.findIndex((page) => pageTargetKey(page) === request.target.key);

  if (request.action === "remove") {
    draft.pageMap = index >= 0 ? pages.filter((_, pageIndex) => pageIndex !== index) : pages;
    return;
  }

  const nextPage = pageAfterSnapshot(draft, request);
  draft.pageMap =
    index >= 0
      ? pages.map((page, pageIndex) => (pageIndex === index ? nextPage : page))
      : [...pages, nextPage].sort(comparePages);
}

function applyApiMutation(
  draft: GeneratedAppDraftLike,
  request: NormalizedAppIterationRequest,
): void {
  const routes = [...(draft.apiRouteStubs ?? [])];
  const index = routes.findIndex((route) => apiTargetKey(route) === request.target.key);

  if (request.action === "remove") {
    draft.apiRouteStubs =
      index >= 0 ? routes.filter((_, routeIndex) => routeIndex !== index) : routes;
    return;
  }

  const nextRoute = apiAfterSnapshot(draft, request);
  draft.apiRouteStubs =
    index >= 0
      ? routes.map((route, routeIndex) => (routeIndex === index ? nextRoute : route))
      : [...routes, nextRoute].sort(compareApiRoutes);
}

function applyDataMutation(
  draft: GeneratedAppDraftLike,
  request: NormalizedAppIterationRequest,
): void {
  const dataSchema = cloneDataSchema(draft.dataSchema);
  const entities = [...(dataSchema.entities ?? [])];
  const index = entities.findIndex((entity) => dataTargetKey(entity) === request.target.key);

  if (request.action === "remove") {
    dataSchema.entities =
      index >= 0 ? entities.filter((_, entityIndex) => entityIndex !== index) : entities;
    draft.dataSchema = dataSchema;
    return;
  }

  const nextEntity = dataAfterSnapshot(draft, request);
  dataSchema.entities =
    index >= 0
      ? entities.map((entity, entityIndex) => (entityIndex === index ? nextEntity : entity))
      : [...entities, nextEntity].sort((left, right) => left.name.localeCompare(right.name));
  draft.dataSchema = dataSchema;
}

function applyAuthMutation(
  draft: GeneratedAppDraftLike,
  request: NormalizedAppIterationRequest,
): void {
  draft.auth = authAfterSnapshot(draft, request);
}

function applyConfigMutation(
  draft: GeneratedAppDraftLike,
  request: NormalizedAppIterationRequest,
): void {
  draft.config = configAfterSnapshot(draft, request);
}

function readTargetSnapshot(
  draft: GeneratedAppDraftLike,
  target: SelectedAppIterationTarget,
): unknown {
  if (target.kind === "page")
    return (draft.pageMap ?? []).find((page) => pageTargetKey(page) === target.key) ?? null;
  if (target.kind === "api")
    return (draft.apiRouteStubs ?? []).find((route) => apiTargetKey(route) === target.key) ?? null;
  if (target.kind === "data")
    return (
      (draft.dataSchema?.entities ?? []).find((entity) => dataTargetKey(entity) === target.key) ??
      null
    );
  if (target.kind === "auth") return draft.auth ?? null;
  return draft.config ?? null;
}

function buildTargetAfterSnapshot(
  draft: GeneratedAppDraftLike,
  request: NormalizedAppIterationRequest,
): unknown {
  if (request.action === "remove") return null;
  if (request.target.kind === "page") return pageAfterSnapshot(draft, request);
  if (request.target.kind === "api") return apiAfterSnapshot(draft, request);
  if (request.target.kind === "data") return dataAfterSnapshot(draft, request);
  if (request.target.kind === "auth") return authAfterSnapshot(draft, request);
  return configAfterSnapshot(draft, request);
}

function pageAfterSnapshot(
  draft: GeneratedAppDraftLike,
  request: NormalizedAppIterationRequest,
): GeneratedPageDraftLike {
  const existing = readTargetSnapshot(draft, request.target) as GeneratedPageDraftLike | null;
  const path =
    normalizePath(request.target.path) ??
    normalizePath(pathFromText(request.requestedChange)) ??
    "/iteration";
  const name = request.target.name ?? existing?.name ?? titleCase(lastPathSegment(path));
  const action = actionPhrase(request.requestedChange);

  return removeUndefined({
    ...(existing ?? {}),
    path,
    name,
    access: inferAccess(request.requestedChange, existing?.access ?? "private"),
    purpose: appendSentence(existing?.purpose, `Iteration request: ${request.requestedChange}`),
    primaryEntity: existing?.primaryEntity,
    actions: uniqueSorted([...(existing?.actions ?? []), action]),
  });
}

function apiAfterSnapshot(
  draft: GeneratedAppDraftLike,
  request: NormalizedAppIterationRequest,
): GeneratedApiRouteDraftLike {
  const existing = readTargetSnapshot(draft, request.target) as GeneratedApiRouteDraftLike | null;
  const path =
    normalizePath(request.target.path) ??
    normalizePath(pathFromText(request.requestedChange)) ??
    "/api/generated/iteration";
  const method = inferMethod(request.requestedChange, existing?.method ?? "GET");

  return removeUndefined({
    ...(existing ?? {}),
    method,
    path,
    access: inferAccess(request.requestedChange, existing?.access ?? "private"),
    purpose: appendSentence(existing?.purpose, `Iteration request: ${request.requestedChange}`),
    requestBody:
      method === "GET" || method === "DELETE"
        ? existing?.requestBody
        : (existing?.requestBody ?? "generated iteration payload"),
    responseShape: existing?.responseShape ?? "{ ok: true }",
  });
}

function dataAfterSnapshot(
  draft: GeneratedAppDraftLike,
  request: NormalizedAppIterationRequest,
): GeneratedEntityDraftLike {
  const existing = readTargetSnapshot(draft, request.target) as GeneratedEntityDraftLike | null;
  const name =
    request.target.name ?? existing?.name ?? entityNameFromChange(request.requestedChange);

  return removeUndefined({
    ...(existing ?? {}),
    name,
    primaryKey: existing?.primaryKey ?? "id",
    fields: existing?.fields ?? [
      { name: "id", type: "uuid", required: true },
      { name: "name", type: "string", required: true },
      { name: "status", type: "string", required: false },
      { name: "createdAt", type: "datetime", required: true },
    ],
    indexes: uniqueSorted([...(existing?.indexes ?? []), "status"]),
    relations: existing?.relations ?? [],
    notes: uniqueSorted([
      ...arrayValue(existing?.notes),
      `Iteration request: ${request.requestedChange}`,
    ]),
  });
}

function authAfterSnapshot(
  draft: GeneratedAppDraftLike,
  request: NormalizedAppIterationRequest,
): GeneratedAuthDraftLike {
  const existing = cloneAuth(draft.auth);
  const routePath =
    normalizePath(request.target.path) ?? normalizePath(pathFromText(request.requestedChange));
  const access = inferAccess(
    request.requestedChange,
    routePath ? routeAccess(existing, routePath) : "private",
  );
  const publicRoutes = new Set(existing.publicRoutes ?? []);
  const privateRoutes = new Set(existing.privateRoutes ?? []);
  const roleRoutes = cloneRoleRoutes(existing.roleRoutes);

  if (routePath) {
    publicRoutes.delete(routePath);
    privateRoutes.delete(routePath);
    for (const roleRoute of roleRoutes) {
      roleRoute.routes = roleRoute.routes.filter((route) => route !== routePath);
    }

    if (access === "public") publicRoutes.add(routePath);
    else if (access === "admin") {
      const admin = roleRoutes.find((roleRoute) => roleRoute.role === "admin");
      if (admin) admin.routes = uniqueSorted([...admin.routes, routePath]);
      else
        roleRoutes.push({
          role: "admin",
          routes: [routePath],
          reason: "Iteration request requires role-gated generated app access.",
        });
    } else privateRoutes.add(routePath);
  }

  return {
    ...existing,
    defaultPolicy: existing.defaultPolicy ?? "authenticated-by-default",
    publicRoutes: uniqueSorted([...publicRoutes]),
    privateRoutes: uniqueSorted([...privateRoutes]),
    roleRoutes: roleRoutes
      .map((roleRoute) => ({ ...roleRoute, routes: uniqueSorted(roleRoute.routes) }))
      .filter((roleRoute) => roleRoute.routes.length > 0)
      .sort((left, right) => left.role.localeCompare(right.role)),
    decisions: uniqueSorted([
      ...(existing.decisions ?? []),
      `Iteration request: ${request.requestedChange}`,
    ]),
  };
}

function configAfterSnapshot(
  draft: GeneratedAppDraftLike,
  request: NormalizedAppIterationRequest,
): GeneratedConfigDraftLike {
  const existing = cloneConfig(draft.config);
  const flagKey = stableKey(request.target.name ?? request.target.key).replace(/[:/]+/g, "-");

  return {
    ...existing,
    env: uniqueSorted(existing.env ?? []),
    featureFlags: {
      ...(existing.featureFlags ?? {}),
      [flagKey]: request.action !== "remove",
    },
    notes: uniqueSorted([
      ...(existing.notes ?? []),
      `Iteration request: ${redactSecrets(request.requestedChange)}`,
    ]),
  };
}

function selectPageTarget(
  draft: GeneratedAppDraftLike,
  target: AppIterationTargetInput | undefined,
  requestedChange: string,
): SelectedAppIterationTarget {
  const pages = draft.pageMap ?? [];
  const requestedPath = normalizePath(target?.path) ?? normalizePath(pathFromText(requestedChange));
  const requestedName = cleanText(target?.name ?? target?.key);
  const matched = requestedPath
    ? pages.find((page) => normalizePath(page.path) === requestedPath)
    : (pages.find(
        (page) =>
          requestedName && cleanText(page.name).toLowerCase() === requestedName.toLowerCase(),
      ) ??
      pages.find(
        (page) =>
          cleanText(page.name).length > 0 &&
          requestedChange.toLowerCase().includes(cleanText(page.name).toLowerCase()),
      ));
  const selected = matched ?? (!requestedPath && !requestedName ? pages[0] : undefined);
  const path = requestedPath ?? normalizePath(selected?.path);
  const name =
    requestedName || selected?.name || (path ? titleCase(lastPathSegment(path)) : "Generated page");
  const key = selected ? pageTargetKey(selected) : stableKey(path ?? name);

  return {
    kind: "page",
    key,
    path,
    name,
    exists: Boolean(matched && pageTargetKey(matched) === key),
    label: path ? `page ${path}` : `page ${name}`,
  };
}

function selectApiTarget(
  draft: GeneratedAppDraftLike,
  target: AppIterationTargetInput | undefined,
  requestedChange: string,
): SelectedAppIterationTarget {
  const routes = draft.apiRouteStubs ?? [];
  const requestedPath = normalizePath(target?.path) ?? normalizePath(pathFromText(requestedChange));
  const matched = requestedPath
    ? routes.find((route) => normalizePath(route.path) === requestedPath)
    : routes.find((route) => requestedChange.toLowerCase().includes(route.path.toLowerCase()));
  const selected =
    matched ?? (!requestedPath && !target?.key && !target?.name ? routes[0] : undefined);
  const path = requestedPath ?? normalizePath(selected?.path);
  const key = selected ? apiTargetKey(selected) : stableKey(path ?? target?.key ?? "api");

  return {
    kind: "api",
    key,
    path,
    name: target?.name,
    exists: Boolean(matched && apiTargetKey(matched) === key),
    label: path ? `API route ${path}` : "API route",
  };
}

function selectDataTarget(
  draft: GeneratedAppDraftLike,
  target: AppIterationTargetInput | undefined,
  requestedChange: string,
): SelectedAppIterationTarget {
  const entities = draft.dataSchema?.entities ?? [];
  const requestedName =
    cleanText(target?.name ?? target?.key) || entityNameFromChange(requestedChange);
  const matched =
    entities.find((entity) => entity.name.toLowerCase() === requestedName.toLowerCase()) ??
    entities.find((entity) => requestedChange.toLowerCase().includes(entity.name.toLowerCase()));
  const selected = matched;
  const name = requestedName || selected?.name || "iterationItem";
  const key = selected ? dataTargetKey(selected) : stableKey(name);

  return {
    kind: "data",
    key,
    name,
    exists: Boolean(matched && dataTargetKey(matched) === key),
    label: `data entity ${name}`,
  };
}

function selectAuthTarget(
  draft: GeneratedAppDraftLike,
  target: AppIterationTargetInput | undefined,
  requestedChange: string,
): SelectedAppIterationTarget {
  const path =
    normalizePath(target?.path) ??
    normalizePath(pathFromText(requestedChange)) ??
    firstRoutePath(draft);
  return {
    kind: "auth",
    key: stableKey(path ?? "auth"),
    path,
    name: target?.name ?? "Auth policy",
    exists: Boolean(draft.auth),
    label: path ? `auth policy for ${path}` : "auth policy",
  };
}

function selectConfigTarget(
  target: AppIterationTargetInput | undefined,
  requestedChange: string,
): SelectedAppIterationTarget {
  const name = cleanText(target?.name ?? target?.key) || configNameFromChange(requestedChange);
  return {
    kind: "config",
    key: stableKey(name),
    name,
    exists: Boolean(target?.key || target?.name),
    label: `config ${name}`,
  };
}

function inferTargetKind(change: string): AppIterationTargetKind {
  const lower = change.toLowerCase();
  if (/\b(auth|login|permission|role|admin|public|private)\b/.test(lower)) return "auth";
  if (/\/api\b|\b(api|endpoint|webhook|route handler)\b/.test(lower)) return "api";
  if (/\b(data|database|schema|table|entity|field|crud|seed)\b/.test(lower)) return "data";
  if (/\b(config|setting|env|environment|feature flag|toggle)\b/.test(lower)) return "config";
  return "page";
}

function inferAction(change: string): AppIterationAction {
  const lower = change.toLowerCase();
  if (/\b(remove|delete|drop|disable|deprecate|archive)\b/.test(lower)) return "remove";
  if (/\b(add|create|introduce|include|enable|support)\b/.test(lower)) return "add";
  return "update";
}

function inferAccess(change: string, fallback: string): string {
  const lower = change.toLowerCase();
  if (/\badmin|role-gated|role gated\b/.test(lower)) return "admin";
  if (/\bpublic|unauthenticated|anonymous\b/.test(lower)) return "public";
  if (/\bprivate|authenticated|signed in|sign-in|login\b/.test(lower)) return "private";
  return fallback;
}

function inferMethod(change: string, fallback: string): string {
  const upper = change.toUpperCase();
  const match = upper.match(/\b(GET|POST|PUT|PATCH|DELETE)\b/);
  if (match?.[1]) return match[1];
  if (/\b(create|submit|add)\b/i.test(change)) return "POST";
  if (/\b(update|edit|change)\b/i.test(change)) return "PATCH";
  if (/\b(remove|delete|archive)\b/i.test(change)) return "DELETE";
  return fallback;
}

function routeAccess(auth: GeneratedAuthDraftLike, path: string): string {
  if ((auth.publicRoutes ?? []).includes(path)) return "public";
  if ((auth.privateRoutes ?? []).includes(path)) return "private";
  if ((auth.roleRoutes ?? []).some((roleRoute) => roleRoute.routes.includes(path))) return "admin";
  return "private";
}

function firstRoutePath(draft: GeneratedAppDraftLike): string | undefined {
  return normalizePath(draft.pageMap?.[0]?.path) ?? normalizePath(draft.apiRouteStubs?.[0]?.path);
}

function pathFromText(value: string): string | undefined {
  const match = value.match(/(?:^|\s)(\/[a-zA-Z0-9_:/?.-]+)/);
  return match?.[1]?.replace(/[.,;]+$/g, "");
}

function entityNameFromChange(value: string): string {
  const lower = value.toLowerCase();
  const named =
    lower.match(/\b(?:entity|table|schema|model)\s+([a-z][a-z0-9_-]*)/i)?.[1] ??
    lower.match(/\bfor\s+([a-z][a-z0-9_-]*)\b/i)?.[1];
  return camelCase(named ?? "iteration item");
}

function configNameFromChange(value: string): string {
  const named = value.match(/\b(?:config|setting|env|flag)\s+([A-Z0-9_a-z-]+)/)?.[1];
  return named ?? "iteration setting";
}

function actionPhrase(value: string): string {
  const cleaned = cleanText(value).replace(/[.]+$/g, "");
  return cleaned.length > 80
    ? `${cleaned.slice(0, 77).trim()}...`
    : cleaned || "review iteration request";
}

function buildHunkSummary(request: NormalizedAppIterationRequest): string {
  return `${request.action} ${request.target.label}: ${request.requestedChange}`;
}

function appendSentence(existing: string | undefined, sentence: string): string {
  const current = cleanText(existing);
  if (!current) return sentence;
  if (current.includes(sentence)) return current;
  return `${current} ${sentence}`;
}

function pageTargetKey(page: GeneratedPageDraftLike): string {
  return stableKey(normalizePath(page.path) ?? page.name ?? "page");
}

function apiTargetKey(route: GeneratedApiRouteDraftLike): string {
  return stableKey(`${route.method}:${normalizePath(route.path) ?? route.path}`);
}

function dataTargetKey(entity: GeneratedEntityDraftLike): string {
  return stableKey(entity.name);
}

function comparePages(left: GeneratedPageDraftLike, right: GeneratedPageDraftLike): number {
  return (
    (normalizePath(left.path) ?? "").localeCompare(normalizePath(right.path) ?? "") ||
    cleanText(left.name).localeCompare(cleanText(right.name))
  );
}

function compareApiRoutes(
  left: GeneratedApiRouteDraftLike,
  right: GeneratedApiRouteDraftLike,
): number {
  return (
    (normalizePath(left.path) ?? "").localeCompare(normalizePath(right.path) ?? "") ||
    left.method.localeCompare(right.method)
  );
}

function normalizePath(value: string | undefined): string | undefined {
  const trimmed = cleanText(value);
  if (!trimmed) return undefined;
  const [pathname, query = ""] = trimmed.split("?", 2);
  const normalized = pathname.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/g, "");
  const prefixed = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `${prefixed || "/"}${query ? `?${query}` : ""}`;
}

function cleanText(value: string | undefined): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function stableKey(value: string): string {
  return (
    cleanText(value)
      .toLowerCase()
      .replace(/[^a-z0-9:_/-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "generated"
  );
}

function titleCase(value: string): string {
  return (
    value
      .split(/[\s_-]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(" ") || "Generated"
  );
}

function lastPathSegment(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1)?.replace(/^:/, "") || "page";
}

function camelCase(value: string): string {
  const words = value.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  return (
    words
      .map((word, index) => {
        const lower = word.toLowerCase();
        return index === 0 ? lower : `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
      })
      .join("") || "iterationItem"
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortValue(entry)]),
  );
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map(cleanText).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function uniqueRisks(risks: AppIterationRisk[]): AppIterationRisk[] {
  const byCode = new Map<string, AppIterationRisk>();
  for (const risk of risks) byCode.set(risk.code, risk);
  return [...byCode.values()].sort(
    (left, right) =>
      severityRank(right.severity) - severityRank(left.severity) ||
      left.code.localeCompare(right.code),
  );
}

function severityRank(severity: AppIterationRiskSeverity): number {
  return severity === "high" ? 2 : severity === "medium" ? 1 : 0;
}

function cloneDraft(draft: GeneratedAppDraftLike): GeneratedAppDraftLike {
  return sortValue(draft) as GeneratedAppDraftLike;
}

function cloneDataSchema(
  schema: GeneratedDataSchemaDraftLike | undefined,
): GeneratedDataSchemaDraftLike {
  return {
    ...(schema ?? {}),
    entities: (schema?.entities ?? []).map((entity) => ({
      ...entity,
      fields: entity.fields?.map((field) => ({
        ...field,
        enumValues: field.enumValues ? [...field.enumValues] : undefined,
      })),
      indexes: entity.indexes ? [...entity.indexes] : undefined,
      relations: entity.relations ? [...entity.relations] : undefined,
    })),
    notes: schema?.notes ? [...schema.notes] : undefined,
  };
}

function cloneAuth(auth: GeneratedAuthDraftLike | undefined): GeneratedAuthDraftLike {
  return {
    ...(auth ?? {}),
    publicRoutes: auth?.publicRoutes ? [...auth.publicRoutes] : [],
    privateRoutes: auth?.privateRoutes ? [...auth.privateRoutes] : [],
    roleRoutes: cloneRoleRoutes(auth?.roleRoutes),
    decisions: auth?.decisions ? [...auth.decisions] : [],
  };
}

function cloneRoleRoutes(
  roleRoutes: GeneratedAuthDraftLike["roleRoutes"],
): Array<{ role: string; routes: string[]; reason?: string }> {
  return (roleRoutes ?? []).map((roleRoute) => ({
    ...roleRoute,
    routes: [...roleRoute.routes],
  }));
}

function cloneConfig(config: GeneratedConfigDraftLike | undefined): GeneratedConfigDraftLike {
  return {
    ...(config ?? {}),
    env: config?.env ? [...config.env] : [],
    featureFlags: { ...(config?.featureFlags ?? {}) },
    notes: config?.notes ? [...config.notes] : [],
  };
}

function arrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function redactSecrets(value: string): string {
  return value.replace(SECRET_PATTERN_GLOBAL, "$1=[redacted]");
}

function removeUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

function resolveIterationModel(preset: AppIterationPresetId | undefined): string {
  if (!preset) return DEFAULT_LLM_MODEL;
  return PRESET_TO_MODEL[preset] ?? DEFAULT_LLM_MODEL;
}

function buildIterationUserMessage(
  draft: GeneratedAppDraftLike,
  target: AppIterationTargetInput | undefined,
  prompt: string,
): string {
  const draftSummary = JSON.stringify(draft, null, 2);
  const targetSummary = target ? JSON.stringify(target) : "null";
  return [
    "Current app draft (truncated/normalized):",
    "```json",
    draftSummary.length > 8000 ? `${draftSummary.slice(0, 8000)}\n…[truncated]` : draftSummary,
    "```",
    "",
    `Target (may be null): ${targetSummary}`,
    "",
    `User iteration prompt: ${prompt}`,
  ].join("\n");
}

/**
 * Streams a real Anthropic Messages call to produce an iteration diff.
 * Returns `null` if no API key is available or the LLM produced no tool call,
 * so callers can fall back to the deterministic regex pipeline.
 *
 * `emit` receives text-delta chunks as plain prose; it is invoked many times
 * during streaming.
 */
export async function applyAppIterationViaLLM(
  draft: GeneratedAppDraftLike,
  target: AppIterationTargetInput | undefined,
  prompt: string,
  options: AppIterationLLMOptions,
  emit?: (chunk: string) => void | Promise<void>,
): Promise<AppIterationLLMResult | null> {
  let provider: LLMProvider;
  let model: string;

  if (options.provider) {
    provider = options.provider;
    model = resolveIterationModel(options.preset);
  } else {
    // Route through the preset resolver so BYOK keys for any of the supported
    // providers (Anthropic, OpenAI, Minimax, OpenRouter, Gemini, Ollama) drive
    // the iteration LLM, not just Anthropic.
    registerDefaultProviders();
    const resolved = resolvePresetToProviderModel(options.preset as ModelPreset | undefined);
    if (!resolved) return null;
    const router = getDefaultRouter();
    const candidate = router.get(resolved.provider);
    if (!candidate) return null;
    provider = candidate;
    model = resolved.model;
  }

  const userMessage = buildIterationUserMessage(draft, target, prompt);

  const stream = provider.stream({
    model,
    workspaceId: options.workspaceId,
    routeKey: "workflow.draft",
    maxTokens: 4096,
    temperature: 0.2,
    signal: options.signal,
    messages: [
      { role: "system", content: ITERATION_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    tools: [
      {
        name: ITERATION_TOOL_NAME,
        description: "Emit the final iteration diff with file-level changes.",
        inputSchema: ITERATION_TOOL_SCHEMA,
      },
    ],
  });

  const proseChunks: string[] = [];
  let toolInput: Record<string, unknown> | null = null;
  let errored = false;

  try {
    for await (const chunk of stream as AsyncIterable<ProviderStreamChunk>) {
      if (chunk.error) {
        errored = true;
        break;
      }
      if (chunk.delta) {
        proseChunks.push(chunk.delta);
        if (emit) {
          try {
            await emit(chunk.delta);
          } catch {
            /* swallow emit errors */
          }
        }
      }
      if (chunk.toolCall && chunk.toolCall.name === ITERATION_TOOL_NAME) {
        toolInput = chunk.toolCall.input;
      }
    }
  } catch {
    errored = true;
  }

  if (errored || !toolInput) return null;

  const files = Array.isArray(toolInput.files)
    ? (toolInput.files as Array<Record<string, unknown>>)
        .map((entry) => normalizeLLMFile(entry))
        .filter((entry): entry is AppIterationLLMResult["files"][number] => entry !== null)
    : [];

  if (files.length === 0) return null;

  return {
    changedSummary:
      typeof toolInput.changedSummary === "string" && toolInput.changedSummary.trim().length > 0
        ? toolInput.changedSummary.trim()
        : `LLM iteration for ${target?.kind ?? "app"}`,
    files,
    prose: proseChunks.join(""),
    model,
  };
}

function normalizeLLMFile(
  entry: Record<string, unknown>,
): AppIterationLLMResult["files"][number] | null {
  const path = typeof entry.path === "string" ? entry.path.trim() : "";
  if (!path) return null;
  const allowedTypes = new Set(["added", "modified", "deleted", "renamed"]);
  const changeType =
    typeof entry.changeType === "string" && allowedTypes.has(entry.changeType)
      ? (entry.changeType as AppIterationLLMResult["files"][number]["changeType"])
      : "modified";
  return {
    path,
    changeType,
    summary: typeof entry.summary === "string" ? entry.summary : `Update ${path}`,
    diff: typeof entry.diff === "string" ? entry.diff : "",
  };
}

// =============================================================================
// File-tree iteration path (Track B, Round 2)
// =============================================================================
//
// Mirror of `applyAppIterationViaLLM` for the file-tree codegen path. When the
// draft being iterated on was generated via the file-tree path, the HTTP route
// should prefer this entry point. The orchestrator is asked to re-emit the FULL
// new tree; we then diff the old and new trees to produce
// `AppIterationLLMResult`-shaped entries suitable for the existing UI/storage
// layer.
// =============================================================================

/** Default budget for inlining file contents in the iteration prompt. */
const FILE_TREE_PROMPT_CONTENT_BUDGET_BYTES = 40_000;

/** Test-only seam: pluggable orchestrator entry point. */
export type AuthorFileTreeFn = typeof authorAppViaLLM;

/** Test-only seam: pluggable validator. */
export type ValidateFileTreeFn = typeof validateFileTree;

export interface AppIterationFileTreeOptions {
  workspaceId: string;
  preset?: AppIterationPresetId;
  signal?: AbortSignal;
  /** Optional override of the registered router (for tests). */
  router?: ProviderRouter;
  /**
   * Test-only override of the orchestrator entry point. Production callers
   * should leave this undefined so the real `authorAppViaLLM` is used.
   */
  authorFn?: AuthorFileTreeFn;
  /**
   * Test-only override of the validator. Production callers should leave this
   * undefined so the real `validateFileTree` is used.
   */
  validateFn?: ValidateFileTreeFn;
}

export interface AppIterationFileTreeResult {
  changedSummary: string;
  files: AppIterationLLMResult["files"];
  prose: string;
  model: string;
  /** Full new file tree, for derived-draft projection by callers. */
  newFiles: GeneratedFile[];
  /** Populated when the validator reported issues. */
  validationErrors?: string[];
}

/**
 * Returns true when the HTTP route layer should use the file-tree iteration
 * path. The three required conditions are:
 *   1. The file-tree path has not been disabled by the legacy escape hatch.
 *   2. The draft being iterated was generated via the file-tree path (so the
 *      caller has the canonical file tree, not just a derived `AppDraft`).
 *   3. The caller actually passes a non-empty `files` array alongside the
 *      draft. Without that we have nothing to diff against.
 */
export function shouldUseFileTreeIteration(input: {
  flagOn: boolean;
  draftSource: string | undefined;
  files?: GeneratedFile[] | undefined;
}): boolean {
  if (!input.flagOn) return false;
  if (input.draftSource !== "llm-filetree") return false;
  if (!Array.isArray(input.files) || input.files.length === 0) return false;
  return true;
}

/**
 * Builds the iteration user goal string. The orchestrator's default prompts
 * already split this into plan + write phases; we just embed the existing tree
 * and the user's change request into a single goal string so the model has all
 * the context it needs.
 *
 * When the total file content would exceed `FILE_TREE_PROMPT_CONTENT_BUDGET_BYTES`,
 * the longest files are replaced with a short summary line (path + byte count)
 * to keep the prompt within a sensible token budget.
 */
export function buildFileTreeIterationGoal(files: GeneratedFile[], changeRequest: string): string {
  const safe = Array.isArray(files)
    ? files.filter((f) => f && typeof f.path === "string" && typeof f.content === "string")
    : [];

  // Greedy budget: include full contents until we exceed the budget; then
  // switch to summary lines for the remaining (largest) files.
  const sortedByContentLength = [...safe].sort((a, b) => a.content.length - b.content.length);
  let used = 0;
  const fullPaths = new Set<string>();
  for (const file of sortedByContentLength) {
    const cost = file.path.length + file.content.length + 32; // markdown framing overhead
    if (used + cost > FILE_TREE_PROMPT_CONTENT_BUDGET_BYTES) break;
    used += cost;
    fullPaths.add(file.path);
  }

  const sections: string[] = [];
  sections.push("You are iterating on an existing app's file tree.");
  sections.push("");
  sections.push("Current file tree:");
  for (const file of safe) {
    if (fullPaths.has(file.path)) {
      sections.push("```");
      sections.push(`// path: ${file.path}`);
      sections.push(file.content);
      sections.push("```");
    } else {
      sections.push(`- ${file.path} (${file.content.length} bytes, omitted for brevity)`);
    }
  }
  sections.push("");
  sections.push("User change request:");
  sections.push(changeRequest.trim() || "(no change requested)");
  sections.push("");
  sections.push(
    "Re-emit the FULL new file tree via `write_file` tool calls. Any file " +
      "that you do NOT re-emit will be treated as DELETED. Include every file " +
      "that should remain in the app, even if unchanged.",
  );

  return sections.join("\n");
}

/**
 * Compute a structured diff between `oldFiles` and `newFiles`. Files added,
 * modified, or deleted are returned in the same shape as
 * `AppIterationLLMResult["files"]`. Unchanged files are omitted.
 */
export function diffFileTrees(
  oldFiles: GeneratedFile[],
  newFiles: GeneratedFile[],
): AppIterationLLMResult["files"] {
  const oldByPath = new Map<string, string>();
  for (const file of oldFiles) {
    if (file && typeof file.path === "string" && typeof file.content === "string") {
      oldByPath.set(file.path, file.content);
    }
  }
  const newByPath = new Map<string, string>();
  for (const file of newFiles) {
    if (file && typeof file.path === "string" && typeof file.content === "string") {
      newByPath.set(file.path, file.content);
    }
  }

  const entries: AppIterationLLMResult["files"] = [];

  for (const [path, content] of newByPath.entries()) {
    if (!oldByPath.has(path)) {
      entries.push({
        path,
        changeType: "added",
        summary: `Added ${path}`,
        diff: buildSimpleDiff("", content),
      });
    } else if (oldByPath.get(path) !== content) {
      entries.push({
        path,
        changeType: "modified",
        summary: `Modified ${path}`,
        diff: buildSimpleDiff(oldByPath.get(path) ?? "", content),
      });
    }
  }
  for (const [path, content] of oldByPath.entries()) {
    if (!newByPath.has(path)) {
      entries.push({
        path,
        changeType: "deleted",
        summary: `Removed ${path}`,
        diff: buildSimpleDiff(content, ""),
      });
    }
  }

  return entries;
}

/** Produce a short unified-diff-style snippet. Not byte-perfect; informational. */
function buildSimpleDiff(before: string, after: string): string {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const maxPreview = 6;
  const beforePreview = beforeLines.slice(0, maxPreview);
  const afterPreview = afterLines.slice(0, maxPreview);
  const parts: string[] = [];
  if (before.length === 0 && after.length === 0) return "";
  parts.push("--- before");
  parts.push("+++ after");
  for (const line of beforePreview) parts.push(`-${line}`);
  if (beforeLines.length > maxPreview)
    parts.push(`-... (${beforeLines.length - maxPreview} more lines)`);
  for (const line of afterPreview) parts.push(`+${line}`);
  if (afterLines.length > maxPreview)
    parts.push(`+... (${afterLines.length - maxPreview} more lines)`);
  return parts.join("\n");
}

/**
 * Iterate on an existing app via the file-tree codegen path. The orchestrator
 * is asked to re-emit the FULL new tree; we diff against the input and return
 * `AppIterationLLMResult`-shaped entries so the existing UI/storage layer keeps
 * working unchanged.
 *
 * Returns `null` on any failure (orchestrator returned null, zero files, etc.)
 * so the caller can fall back to the regex/structured-tool path.
 *
 * `emit` receives prose deltas during the plan/write phases so the chat UI can
 * show what the model is doing in real time.
 */
export async function applyAppIterationViaFileTree(
  currentFiles: GeneratedFile[],
  changeRequest: string,
  options: AppIterationFileTreeOptions,
  emit?: (chunk: string) => void | Promise<void>,
): Promise<AppIterationFileTreeResult | null> {
  if (!Array.isArray(currentFiles) || currentFiles.length === 0) return null;
  const trimmedRequest = (changeRequest ?? "").trim();
  if (trimmedRequest.length === 0) return null;

  const author = options.authorFn ?? authorAppViaLLM;
  const validate = options.validateFn ?? validateFileTree;
  const noopEmit = async (_: string) => {};
  const emitFn = emit ?? noopEmit;

  const userGoal = buildFileTreeIterationGoal(currentFiles, trimmedRequest);

  const authorOptions: AuthorAppOptions = { workspaceId: options.workspaceId };
  if (options.preset) authorOptions.preset = options.preset;
  if (options.signal) authorOptions.signal = options.signal;
  if (options.router) authorOptions.router = options.router;

  let result: (AuthorAppResult & { validation: ValidationResult; repairAttempts: number }) | null;
  try {
    result = await authorAndValidateAppViaLLM(
      userGoal,
      {
        ...authorOptions,
        authorFn: author,
        validateFn: validate,
      },
      emitFn,
    );
  } catch (error) {
    console.warn(`[app-iteration-filetree] orchestrator threw: ${(error as Error).message}`);
    return null;
  }
  if (!result || !Array.isArray(result.files) || result.files.length === 0) {
    return null;
  }

  const validation = result.validation;

  const diffEntries = diffFileTrees(currentFiles, result.files);

  const model = resolveIterationModel(options.preset);

  const validationErrors =
    !validation.ok && validation.errors.length > 0
      ? validation.errors.map((e) => `${e.file}${e.line ? `:${e.line}` : ""}: ${e.message}`)
      : undefined;

  const changedSummary = buildFileTreeChangedSummary(diffEntries, result.summary);

  const out: AppIterationFileTreeResult = {
    changedSummary,
    files: diffEntries,
    prose: result.summary ?? "",
    model,
    newFiles: result.files,
  };
  if (validationErrors) out.validationErrors = validationErrors;
  return out;
}

function buildFileTreeChangedSummary(
  diffEntries: AppIterationLLMResult["files"],
  orchestratorSummary: string | undefined,
): string {
  const added = diffEntries.filter((e) => e.changeType === "added").length;
  const modified = diffEntries.filter((e) => e.changeType === "modified").length;
  const deleted = diffEntries.filter((e) => e.changeType === "deleted").length;
  if (added === 0 && modified === 0 && deleted === 0) {
    return orchestratorSummary?.trim() || "No file changes detected.";
  }
  const parts: string[] = [];
  if (added) parts.push(`${added} added`);
  if (modified) parts.push(`${modified} modified`);
  if (deleted) parts.push(`${deleted} deleted`);
  return `File-tree iteration: ${parts.join(", ")}.`;
}
