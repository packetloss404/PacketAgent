export type PreviewVisibility = "public" | "private";
export type PreviewDevice = "desktop" | "mobile";
export type PreviewBuildPhase =
  | "not-started"
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "canceled";
export type PreviewBuildTone = "neutral" | "working" | "success" | "danger";
export type SmokeCheckKind = "page" | "api" | "crud";
export type SmokeCheckRunMode = "browser" | "http";
export type CrudOperation = "list" | "create" | "read" | "update" | "delete";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export interface GeneratedAppPageMapEntry {
  key: string;
  title?: string;
  path?: string;
  visibility?: PreviewVisibility;
  supportsMobilePreview?: boolean;
}

export interface GeneratedAppApiRoute {
  key?: string;
  method: HttpMethod;
  path: string;
  label?: string;
  authRequired?: boolean;
  smoke?: boolean;
  expectedStatus?: number;
}

export interface GeneratedAppCrudFlow {
  key: string;
  resource: string;
  apiBasePath?: string;
  listPath?: string;
  createPath?: string;
  detailPath?: string;
  operations?: CrudOperation[];
  authRequired?: boolean;
}

export interface AppPreviewTargetInput {
  appId: string;
  workspaceId?: string;
  baseUrl?: string;
  previewBasePath?: string;
  preferredPath?: string;
  pageMap?: GeneratedAppPageMapEntry[];
}

export interface AppPreviewTarget {
  path: string;
  url?: string;
  entryPath: string;
  mobilePath?: string;
  qrPath?: string;
}

export interface AppSmokeCheck {
  id: string;
  kind: SmokeCheckKind;
  label: string;
  method: HttpMethod;
  path: string;
  runMode: SmokeCheckRunMode;
  requiredAuth: boolean;
  expectedStatus: number;
  sourceKey: string;
  assertions: string[];
}

export interface AppSmokeCheckInput {
  pageMap?: GeneratedAppPageMapEntry[];
  apiRoutes?: GeneratedAppApiRoute[];
  crudFlows?: GeneratedAppCrudFlow[];
}

export interface PreviewBuildStatusInput {
  phase?: PreviewBuildPhase;
  checkCount?: number;
  passedChecks?: number;
  failedChecks?: number;
  message?: string;
}

export interface PreviewBuildStatus {
  phase: PreviewBuildPhase;
  label: string;
  tone: PreviewBuildTone;
  canPreview: boolean;
  canPublish: boolean;
  summary: string;
}

export interface RuntimeErrorHandoffInput {
  appId: string;
  workspaceId?: string;
  routePath?: string;
  source?: "preview" | "build" | "smoke" | "runtime";
  buildId?: string;
  smokeCheckId?: string;
  capturedAt?: string;
  error: unknown;
}

export interface RuntimeErrorHandoff {
  kind: "runtime-error-fix";
  title: string;
  prompt: string;
  metadata: {
    appId: string;
    workspaceId?: string;
    routePath?: string;
    source: "preview" | "build" | "smoke" | "runtime";
    buildId?: string;
    smokeCheckId?: string;
    capturedAt?: string;
    message: string;
    name?: string;
    stack?: string;
  };
}

export interface AppPreviewReadinessInput extends AppPreviewTargetInput, AppSmokeCheckInput {
  build?: PreviewBuildStatusInput;
  runtimeError?: RuntimeErrorHandoffInput;
}

export interface AppPreviewReadiness {
  preview: AppPreviewTarget;
  smokeChecks: AppSmokeCheck[];
  buildStatus: PreviewBuildStatus;
  runtimeErrorHandoff?: RuntimeErrorHandoff;
}

const SAFE_API_METHODS = new Set<HttpMethod>(["GET", "HEAD", "OPTIONS"]);
const DEFAULT_PREVIEW_BASE_PATH = "/builder/preview";
const DEFAULT_ENTRY_PATH = "/";
const DEFAULT_EXPECTED_STATUS = 200;
const SECRET_PATTERN =
  /\b(api[_-]?key|authorization|bearer|secret|token|password)\b\s*[:=]\s*["']?(?:Bearer\s+)?[^"',\s)]+/gi;

export function deriveAppPreviewTarget(input: AppPreviewTargetInput): AppPreviewTarget {
  const previewRoot = joinPaths(
    input.previewBasePath ?? DEFAULT_PREVIEW_BASE_PATH,
    input.workspaceId ? encodePathSegment(input.workspaceId) : undefined,
    encodePathSegment(input.appId),
  );
  const entryPath =
    normalizeAppPath(input.preferredPath) ??
    firstPreviewPagePath(input.pageMap) ??
    DEFAULT_ENTRY_PATH;
  const path = joinPaths(previewRoot, entryPath);
  const mobilePage = (input.pageMap ?? [])
    .filter((page) => page.supportsMobilePreview)
    .sort(comparePages)[0];
  const mobilePath = mobilePage
    ? joinPaths(previewRoot, normalizeAppPath(mobilePage.path) ?? DEFAULT_ENTRY_PATH)
    : undefined;
  const qrPath = mobilePath ? `${mobilePath}?device=mobile` : undefined;
  const url = input.baseUrl ? absoluteUrl(input.baseUrl, path) : undefined;

  return { path, url, entryPath, mobilePath, qrPath };
}

export function deriveAppSmokeChecks(input: AppSmokeCheckInput): AppSmokeCheck[] {
  const checks = [
    ...pageSmokeChecks(input.pageMap ?? []),
    ...apiSmokeChecks(input.apiRoutes ?? []),
    ...crudSmokeChecks(input.crudFlows ?? []),
  ];
  return uniqueChecks(checks).sort(compareChecks);
}

export function derivePreviewBuildStatus(input: PreviewBuildStatusInput = {}): PreviewBuildStatus {
  const phase = input.phase ?? "not-started";
  const checkCount = positiveInteger(input.checkCount);
  const passedChecks = positiveInteger(input.passedChecks) ?? 0;
  const failedChecks = positiveInteger(input.failedChecks) ?? 0;
  const totalChecks = checkCount ?? passedChecks + failedChecks;
  const checkSummary = totalChecks > 0 ? ` ${passedChecks}/${totalChecks} checks passed.` : "";

  if (phase === "passed" && failedChecks === 0) {
    return {
      phase,
      label: "Ready to preview",
      tone: "success",
      canPreview: true,
      canPublish: true,
      summary: input.message ?? `Build passed.${checkSummary}`.trim(),
    };
  }

  if (phase === "failed" || failedChecks > 0) {
    return {
      phase: "failed",
      label: "Needs fix",
      tone: "danger",
      canPreview: false,
      canPublish: false,
      summary: input.message ?? `Build or smoke checks failed.${checkSummary}`.trim(),
    };
  }

  if (phase === "running" || phase === "queued") {
    return {
      phase,
      label: phase === "queued" ? "Queued" : "Running checks",
      tone: "working",
      canPreview: false,
      canPublish: false,
      summary:
        input.message ??
        `${phase === "queued" ? "Preview build is queued" : "Preview build is running"}.${checkSummary}`.trim(),
    };
  }

  if (phase === "canceled") {
    return {
      phase,
      label: "Canceled",
      tone: "neutral",
      canPreview: false,
      canPublish: false,
      summary: input.message ?? "Preview build was canceled.",
    };
  }

  return {
    phase: "not-started",
    label: "Not built",
    tone: "neutral",
    canPreview: false,
    canPublish: false,
    summary: input.message ?? "Preview build has not run yet.",
  };
}

export function buildRuntimeErrorHandoff(input: RuntimeErrorHandoffInput): RuntimeErrorHandoff {
  const normalized = normalizeError(input.error);
  const source = input.source ?? "runtime";
  const title = `Fix ${source} error`;
  const routeLine = input.routePath
    ? `Route: ${normalizeAppPath(input.routePath) ?? input.routePath}\n`
    : "";
  const prompt = [
    `Fix the generated app ${source} error for app ${input.appId}.`,
    `${routeLine}Error: ${normalized.message}`,
    "Use the current generated app plan, route map, and smoke-check context. Return a minimal patch and explain the verification step.",
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    kind: "runtime-error-fix",
    title,
    prompt,
    metadata: removeUndefined({
      appId: input.appId,
      workspaceId: input.workspaceId,
      routePath: input.routePath
        ? (normalizeAppPath(input.routePath) ?? input.routePath)
        : undefined,
      source,
      buildId: input.buildId,
      smokeCheckId: input.smokeCheckId,
      capturedAt: input.capturedAt,
      message: normalized.message,
      name: normalized.name,
      stack: normalized.stack,
    }),
  };
}

export function buildAppPreviewReadiness(input: AppPreviewReadinessInput): AppPreviewReadiness {
  return removeUndefined({
    preview: deriveAppPreviewTarget(input),
    smokeChecks: deriveAppSmokeChecks(input),
    buildStatus: derivePreviewBuildStatus(input.build),
    runtimeErrorHandoff: input.runtimeError
      ? buildRuntimeErrorHandoff(input.runtimeError)
      : undefined,
  });
}

function pageSmokeChecks(pageMap: GeneratedAppPageMapEntry[]): AppSmokeCheck[] {
  return pageMap
    .map((page) => ({ page, path: normalizeAppPath(page.path) }))
    .filter((entry): entry is { page: GeneratedAppPageMapEntry; path: string } =>
      Boolean(entry.path),
    )
    .sort((left, right) => comparePages(left.page, right.page))
    .map(({ page, path }) => ({
      id: `page:${stableKey(page.key || path)}`,
      kind: "page",
      label: `Open ${page.title?.trim() || page.key}`,
      method: "GET",
      path,
      runMode: "browser",
      requiredAuth: page.visibility !== "public",
      expectedStatus: DEFAULT_EXPECTED_STATUS,
      sourceKey: page.key,
      assertions: [
        "page renders without a runtime error",
        "document title or main content is present",
      ],
    }));
}

function apiSmokeChecks(apiRoutes: GeneratedAppApiRoute[]): AppSmokeCheck[] {
  return apiRoutes
    .filter(
      (route) =>
        route.smoke === true || (route.smoke !== false && SAFE_API_METHODS.has(route.method)),
    )
    .map((route) => ({ route, path: normalizeAppPath(route.path) }))
    .filter((entry): entry is { route: GeneratedAppApiRoute; path: string } => Boolean(entry.path))
    .map(({ route, path }) => ({
      id: `api:${route.method.toLowerCase()}:${stableKey(route.key || path)}`,
      kind: "api",
      label: route.label?.trim() || `${route.method} ${path}`,
      method: route.method,
      path,
      runMode: "http",
      requiredAuth: route.authRequired !== false,
      expectedStatus: route.expectedStatus ?? DEFAULT_EXPECTED_STATUS,
      sourceKey: route.key ?? `${route.method} ${path}`,
      assertions: [
        "response status matches the generated route contract",
        "response body is valid for the route contract",
      ],
    }));
}

function crudSmokeChecks(crudFlows: GeneratedAppCrudFlow[]): AppSmokeCheck[] {
  const checks: AppSmokeCheck[] = [];
  for (const flow of [...crudFlows].sort((left, right) => left.key.localeCompare(right.key))) {
    const operations = flow.operations ?? ["list", "create", "read", "update"];
    for (const operation of operations) {
      const check = crudCheck(flow, operation);
      if (check) checks.push(check);
    }
  }
  return checks;
}

function crudCheck(flow: GeneratedAppCrudFlow, operation: CrudOperation): AppSmokeCheck | null {
  const resource = flow.resource.trim() || flow.key;
  const sourceKey = `${flow.key}:${operation}`;
  const authRequired = flow.authRequired !== false;
  const apiBasePath = normalizeAppPath(flow.apiBasePath);
  const listPath = normalizeAppPath(flow.listPath) ?? apiBasePath;
  const detailPath =
    normalizeAppPath(flow.detailPath) ?? (apiBasePath ? joinPaths(apiBasePath, ":id") : undefined);

  switch (operation) {
    case "list":
      return listPath
        ? crudCheckRecord(sourceKey, `List ${resource}`, "GET", listPath, authRequired, [
            "collection endpoint returns records",
          ])
        : null;
    case "create":
      return (normalizeAppPath(flow.createPath) ?? apiBasePath)
        ? crudCheckRecord(
            sourceKey,
            `Create ${resource}`,
            "POST",
            normalizeAppPath(flow.createPath) ?? apiBasePath ?? "",
            authRequired,
            ["create endpoint accepts generated seed-shaped payload"],
          )
        : null;
    case "read":
      return detailPath
        ? crudCheckRecord(sourceKey, `Read ${resource}`, "GET", detailPath, authRequired, [
            "detail endpoint returns one seeded record",
          ])
        : null;
    case "update":
      return detailPath
        ? crudCheckRecord(sourceKey, `Update ${resource}`, "PATCH", detailPath, authRequired, [
            "update endpoint persists a generated field change",
          ])
        : null;
    case "delete":
      return detailPath
        ? crudCheckRecord(sourceKey, `Delete ${resource}`, "DELETE", detailPath, authRequired, [
            "delete endpoint removes or archives a generated record",
          ])
        : null;
  }
}

function crudCheckRecord(
  sourceKey: string,
  label: string,
  method: HttpMethod,
  path: string,
  requiredAuth: boolean,
  assertions: string[],
): AppSmokeCheck {
  return {
    id: `crud:${method.toLowerCase()}:${stableKey(sourceKey)}`,
    kind: "crud",
    label,
    method,
    path,
    runMode: "http",
    requiredAuth,
    expectedStatus: method === "POST" ? 201 : DEFAULT_EXPECTED_STATUS,
    sourceKey,
    assertions,
  };
}

function firstPreviewPagePath(pageMap: GeneratedAppPageMapEntry[] | undefined): string | undefined {
  return (
    (pageMap ?? [])
      .filter((page) => page.visibility === "public")
      .sort(comparePages)
      .map((page) => normalizeAppPath(page.path))
      .find((path): path is string => Boolean(path)) ??
    (pageMap ?? [])
      .sort(comparePages)
      .map((page) => normalizeAppPath(page.path))
      .find((path): path is string => Boolean(path))
  );
}

function comparePages(left: GeneratedAppPageMapEntry, right: GeneratedAppPageMapEntry): number {
  return (
    (normalizeAppPath(left.path) ?? left.key).localeCompare(
      normalizeAppPath(right.path) ?? right.key,
    ) || left.key.localeCompare(right.key)
  );
}

function compareChecks(left: AppSmokeCheck, right: AppSmokeCheck): number {
  if (left.kind === "crud" && right.kind === "crud") {
    const [leftFlow, leftOperation] = left.sourceKey.split(":");
    const [rightFlow, rightOperation] = right.sourceKey.split(":");
    return (
      (leftFlow ?? "").localeCompare(rightFlow ?? "") ||
      crudOperationRank(leftOperation) - crudOperationRank(rightOperation) ||
      left.path.localeCompare(right.path) ||
      left.id.localeCompare(right.id)
    );
  }

  return (
    kindRank(left.kind) - kindRank(right.kind) ||
    left.path.localeCompare(right.path) ||
    left.method.localeCompare(right.method) ||
    left.id.localeCompare(right.id)
  );
}

function kindRank(kind: SmokeCheckKind): number {
  return kind === "page" ? 0 : kind === "api" ? 1 : 2;
}

function crudOperationRank(operation: string | undefined): number {
  const order: Record<CrudOperation, number> = {
    list: 0,
    create: 1,
    read: 2,
    update: 3,
    delete: 4,
  };
  return operation && operation in order ? order[operation as CrudOperation] : 99;
}

function uniqueChecks(checks: AppSmokeCheck[]): AppSmokeCheck[] {
  const seen = new Set<string>();
  const result: AppSmokeCheck[] = [];
  for (const check of checks) {
    const key = `${check.kind}:${check.method}:${check.path}:${check.sourceKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(check);
  }
  return result;
}

function normalizeAppPath(path: string | undefined): string | undefined {
  const trimmed = path?.trim();
  if (!trimmed) return undefined;
  const [pathname, query = ""] = trimmed.split("?", 2);
  const normalized = pathname.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/g, "");
  const prefixed = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `${prefixed === "" ? "/" : prefixed}${query ? `?${query}` : ""}`;
}

function joinPaths(...parts: Array<string | undefined>): string {
  const [first, ...rest] = parts.filter((part): part is string => Boolean(part));
  if (!first) return "/";
  const joined = [first, ...rest]
    .map((part, index) =>
      index === 0 ? part.replace(/\/+$/g, "") : part.replace(/^\/+|\/+$/g, ""),
    )
    .filter(Boolean)
    .join("/");
  return joined.startsWith("/") ? joined : `/${joined}`;
}

function absoluteUrl(baseUrl: string, path: string): string | undefined {
  try {
    return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
  } catch {
    return undefined;
  }
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value.trim().replace(/\s+/g, "-").toLowerCase());
}

function stableKey(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9:_/-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "generated"
  );
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function normalizeError(error: unknown): { message: string; name?: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: redact(error.message || "unknown runtime error"),
      name: error.name || undefined,
      stack: error.stack ? redact(error.stack) : undefined,
    };
  }
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    return {
      message: redact(String(record.message ?? "unknown runtime error")),
      name: typeof record.name === "string" ? record.name : undefined,
      stack: typeof record.stack === "string" ? redact(record.stack) : undefined,
    };
  }
  return { message: redact(String(error || "unknown runtime error")) };
}

function redact(value: string): string {
  return value.replace(SECRET_PATTERN, "$1=[redacted]");
}

function removeUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}
