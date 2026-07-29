import {
  type AppSmokeCheck,
  type PreviewBuildPhase,
  type PreviewBuildStatusInput,
  type RuntimeErrorHandoff,
  type RuntimeErrorHandoffInput,
  buildRuntimeErrorHandoff,
  derivePreviewBuildStatus,
} from "./app-preview-readiness";

export type PreviewRefreshStatus = "idle" | "stale" | "refreshing" | "ready" | "blocked";
export type PreviewIterationTone = "neutral" | "working" | "success" | "warning" | "danger";
export type PreviewIterationErrorSource = "build" | "runtime" | "preview" | "smoke";
export type PreviewIterationErrorSeverity = "warning" | "error";
export type SmokeRerunReason = "manual" | "after-refresh" | "after-fix" | "ci-retry";
export type SmokeRerunOutcomeStatus = "passed" | "failed" | "skipped" | "timed-out";
export type SmokeRerunCheckStatus = SmokeRerunOutcomeStatus | "not-run";
export type SmokeRerunResultStatus = "passed" | "failed" | "partial" | "blocked";

export interface PreviewRefreshStateInput {
  appId: string;
  workspaceId?: string;
  previewPath?: string;
  previewUrl?: string;
  build?: PreviewBuildStatusInput & {
    buildId?: string;
    revision?: string;
  };
  lastRendered?: {
    buildId?: string;
    revision?: string;
    refreshedAt?: string;
    previewUrl?: string;
  };
  refreshRequest?: {
    requestId?: string;
    buildId?: string;
    revision?: string;
    requestedAt?: string;
  };
  error?: PreviewErrorCapture;
}

export interface PreviewRefreshState {
  kind: "preview-refresh-state";
  appId: string;
  workspaceId?: string;
  status: PreviewRefreshStatus;
  label: string;
  tone: PreviewIterationTone;
  needsRefresh: boolean;
  canRequestRefresh: boolean;
  canUsePreview: boolean;
  reason: string;
  buildPhase: PreviewBuildPhase;
  target: {
    buildId?: string;
    revision?: string;
  };
  current: {
    buildId?: string;
    revision?: string;
    refreshedAt?: string;
  };
  refreshRequest?: {
    requestId?: string;
    buildId?: string;
    revision?: string;
    requestedAt?: string;
  };
  previewPath?: string;
  previewUrl?: string;
  errorFingerprint?: string;
}

export interface SmokeRerunRequestInput {
  appId: string;
  workspaceId?: string;
  buildId?: string;
  reason?: SmokeRerunReason;
  attempt?: number;
  requestedAt?: string;
  requestedBy?: string;
  checks: AppSmokeCheck[];
  checkIds?: string[];
}

export interface SmokeRerunRequest {
  kind: "smoke-rerun-request";
  requestId: string;
  appId: string;
  workspaceId?: string;
  buildId?: string;
  reason: SmokeRerunReason;
  attempt: number;
  requestedAt?: string;
  requestedBy?: string;
  checkIds: string[];
  checks: AppSmokeCheck[];
  unknownCheckIds: string[];
  canRun: boolean;
  message: string;
}

export interface SmokeRerunOutcomeInput {
  checkId: string;
  status: SmokeRerunOutcomeStatus;
  durationMs?: number;
  startedAt?: string;
  completedAt?: string;
  error?: unknown;
  notes?: string[];
}

export interface SmokeRerunCheckResult {
  checkId: string;
  status: SmokeRerunCheckStatus;
  durationMs?: number;
  startedAt?: string;
  completedAt?: string;
  message?: string;
  notes: string[];
}

export interface SmokeRerunResultInput {
  request: SmokeRerunRequest;
  completedAt?: string;
  outcomes: SmokeRerunOutcomeInput[];
}

export interface SmokeRerunResult {
  kind: "smoke-rerun-result";
  requestId: string;
  appId: string;
  workspaceId?: string;
  buildId?: string;
  status: SmokeRerunResultStatus;
  completedAt?: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    timedOut: number;
    notRun: number;
  };
  results: SmokeRerunCheckResult[];
  unknownOutcomeCheckIds: string[];
  failedCheckIds: string[];
  errorCaptures: PreviewErrorCapture[];
}

export interface PreviewErrorCaptureInput {
  appId: string;
  workspaceId?: string;
  source: PreviewIterationErrorSource;
  severity?: PreviewIterationErrorSeverity;
  buildId?: string;
  smokeCheckId?: string;
  routePath?: string;
  capturedAt?: string;
  error: unknown;
  logs?: string | string[];
  location?: {
    filePath?: string;
    line?: number;
    column?: number;
  };
}

export interface PreviewErrorCapture {
  kind: "preview-error-capture";
  appId: string;
  workspaceId?: string;
  source: PreviewIterationErrorSource;
  severity: PreviewIterationErrorSeverity;
  buildId?: string;
  smokeCheckId?: string;
  routePath?: string;
  capturedAt?: string;
  message: string;
  name?: string;
  stack?: string;
  logExcerpt?: string;
  location?: {
    filePath?: string;
    line?: number;
    column?: number;
  };
  fingerprint: string;
  fixable: boolean;
}

export interface PreviewFixPromptHandoffInput {
  capture: PreviewErrorCapture;
  appName?: string;
  originalPrompt?: string;
  routeMap?: Array<{ path: string; title?: string }>;
  smokeResult?: SmokeRerunResult;
  builderContext?: string[];
}

export interface PreviewFixPromptHandoff {
  kind: "builder-fix-prompt-handoff";
  title: string;
  prompt: string;
  readinessHandoff: RuntimeErrorHandoff;
  metadata: {
    appId: string;
    workspaceId?: string;
    appName?: string;
    source: PreviewIterationErrorSource;
    buildId?: string;
    smokeCheckId?: string;
    routePath?: string;
    fingerprint: string;
    capturedAt?: string;
    failedCheckIds: string[];
  };
}

const SECRET_PATTERN =
  /\b(api[_-]?key|authorization|bearer|secret|token|password)\b\s*[:=]\s*["']?(?:Bearer\s+)?[^"',\s)]+/gi;
const MAX_LOG_EXCERPT_LENGTH = 1_200;

export function derivePreviewRefreshState(input: PreviewRefreshStateInput): PreviewRefreshState {
  const buildStatus = derivePreviewBuildStatus(input.build);
  const target = {
    buildId: cleanString(input.build?.buildId),
    revision: cleanString(input.build?.revision),
  };
  const current = {
    buildId: cleanString(input.lastRendered?.buildId),
    revision: cleanString(input.lastRendered?.revision),
    refreshedAt: cleanString(input.lastRendered?.refreshedAt),
  };
  const requestedAt = cleanString(input.refreshRequest?.requestedAt);
  const refreshRequest = removeUndefined({
    requestId: cleanString(input.refreshRequest?.requestId),
    buildId: cleanString(input.refreshRequest?.buildId),
    revision: cleanString(input.refreshRequest?.revision),
    requestedAt,
  });
  const hasPendingRequest =
    Boolean(requestedAt) && compareTimestamp(requestedAt, current.refreshedAt) > 0;
  const hasBuildTarget = Boolean(target.buildId || target.revision);
  const targetChanged = Boolean(
    (target.buildId && target.buildId !== current.buildId) ||
    (target.revision && target.revision !== current.revision),
  );
  const missingRefresh = buildStatus.canPreview && hasBuildTarget && !current.refreshedAt;
  const needsRefresh = targetChanged || missingRefresh;
  const previewUrl = cleanString(input.previewUrl) ?? cleanString(input.lastRendered?.previewUrl);

  if (input.error) {
    return refreshState(input, {
      status: "blocked",
      label: "Fix required",
      tone: "danger",
      needsRefresh,
      canRequestRefresh: false,
      canUsePreview: false,
      reason: `${capitalize(input.error.source)} error captured: ${input.error.message}`,
      buildPhase: buildStatus.phase,
      target,
      current,
      refreshRequest,
      previewUrl,
      errorFingerprint: input.error.fingerprint,
    });
  }

  if (buildStatus.phase === "failed" || buildStatus.phase === "canceled") {
    return refreshState(input, {
      status: "blocked",
      label: buildStatus.label,
      tone: buildStatus.tone === "danger" ? "danger" : "neutral",
      needsRefresh,
      canRequestRefresh: false,
      canUsePreview: false,
      reason: buildStatus.summary,
      buildPhase: buildStatus.phase,
      target,
      current,
      refreshRequest,
      previewUrl,
    });
  }

  if (hasPendingRequest || buildStatus.phase === "queued" || buildStatus.phase === "running") {
    return refreshState(input, {
      status: "refreshing",
      label: buildStatus.phase === "queued" ? "Queued" : "Refreshing preview",
      tone: "working",
      needsRefresh: true,
      canRequestRefresh: false,
      canUsePreview: false,
      reason: hasPendingRequest
        ? "Preview refresh has been requested and has not completed."
        : buildStatus.summary,
      buildPhase: buildStatus.phase,
      target,
      current,
      refreshRequest,
      previewUrl,
    });
  }

  if (needsRefresh) {
    return refreshState(input, {
      status: "stale",
      label: "Refresh available",
      tone: "warning",
      needsRefresh: true,
      canRequestRefresh: buildStatus.canPreview,
      canUsePreview: Boolean(current.refreshedAt && previewUrl),
      reason: targetChanged
        ? "Generated app build changed since the preview was rendered."
        : "Preview has not rendered the current build yet.",
      buildPhase: buildStatus.phase,
      target,
      current,
      refreshRequest,
      previewUrl,
    });
  }

  if (buildStatus.canPreview) {
    return refreshState(input, {
      status: "ready",
      label: "Preview current",
      tone: "success",
      needsRefresh: false,
      canRequestRefresh: false,
      canUsePreview: true,
      reason: "Preview is rendering the current generated app build.",
      buildPhase: buildStatus.phase,
      target,
      current,
      refreshRequest,
      previewUrl,
    });
  }

  return refreshState(input, {
    status: "idle",
    label: buildStatus.label,
    tone: "neutral",
    needsRefresh: false,
    canRequestRefresh: false,
    canUsePreview: false,
    reason: buildStatus.summary,
    buildPhase: buildStatus.phase,
    target,
    current,
    refreshRequest,
    previewUrl,
  });
}

export function buildSmokeRerunRequest(input: SmokeRerunRequestInput): SmokeRerunRequest {
  const attempt = positiveInteger(input.attempt) ?? 1;
  const reason = input.reason ?? "manual";
  const checksById = new Map(input.checks.map((check) => [check.id, check]));
  const requestedIds = input.checkIds
    ? uniqueSorted(input.checkIds.map(stableCheckId))
    : uniqueSorted(input.checks.map((check) => check.id));
  const unknownCheckIds = requestedIds.filter((id) => !checksById.has(id));
  const selectedChecks = requestedIds
    .map((id) => checksById.get(id))
    .filter((check): check is AppSmokeCheck => Boolean(check))
    .sort(compareSmokeChecks);
  const checkIds = selectedChecks.map((check) => check.id);
  const canRun = checkIds.length > 0 && unknownCheckIds.length === 0;
  const appKey = stableKey(input.appId);
  const buildKey = stableKey(input.buildId ?? "no-build");
  const requestId = `smoke-rerun:${appKey}:${buildKey}:${attempt}:${shortHash(checkIds.join("|"))}`;

  return removeUndefined({
    kind: "smoke-rerun-request" as const,
    requestId,
    appId: input.appId,
    workspaceId: cleanString(input.workspaceId),
    buildId: cleanString(input.buildId),
    reason,
    attempt,
    requestedAt: cleanString(input.requestedAt),
    requestedBy: cleanString(input.requestedBy),
    checkIds,
    checks: selectedChecks.map(copySmokeCheck),
    unknownCheckIds,
    canRun,
    message: canRun
      ? `Ready to rerun ${checkIds.length} smoke check${checkIds.length === 1 ? "" : "s"}.`
      : unknownCheckIds.length > 0
        ? `Unknown smoke check ids: ${unknownCheckIds.join(", ")}.`
        : "No smoke checks selected for rerun.",
  });
}

export function buildSmokeRerunResult(input: SmokeRerunResultInput): SmokeRerunResult {
  const outcomesById = new Map<string, SmokeRerunOutcomeInput>();
  for (const outcome of input.outcomes) {
    outcomesById.set(stableCheckId(outcome.checkId), outcome);
  }

  const requestIds = new Set(input.request.checkIds);
  const results = input.request.checks.map((check) => {
    const outcome = outcomesById.get(check.id);
    if (!outcome) {
      return {
        checkId: check.id,
        status: "not-run" as const,
        notes: [],
      };
    }

    const normalizedError =
      outcome.status === "failed" || outcome.status === "timed-out"
        ? normalizeError(outcome.error ?? `${check.label} ${outcome.status}`)
        : undefined;

    return removeUndefined({
      checkId: check.id,
      status: outcome.status,
      durationMs: nonNegativeInteger(outcome.durationMs),
      startedAt: cleanString(outcome.startedAt),
      completedAt: cleanString(outcome.completedAt),
      message: normalizedError?.message,
      notes: uniqueSorted((outcome.notes ?? []).map((note) => redact(String(note)))),
    });
  });
  const summary = {
    total: results.length,
    passed: countStatus(results, "passed"),
    failed: countStatus(results, "failed"),
    skipped: countStatus(results, "skipped"),
    timedOut: countStatus(results, "timed-out"),
    notRun: countStatus(results, "not-run"),
  };
  const failedCheckIds = results
    .filter((result) => result.status === "failed" || result.status === "timed-out")
    .map((result) => result.checkId);
  const unknownOutcomeCheckIds = uniqueSorted(
    [...outcomesById.keys()].filter((checkId) => !requestIds.has(checkId)),
  );
  const status: SmokeRerunResultStatus = !input.request.canRun
    ? "blocked"
    : failedCheckIds.length > 0
      ? "failed"
      : summary.notRun > 0
        ? "partial"
        : "passed";

  return removeUndefined({
    kind: "smoke-rerun-result" as const,
    requestId: input.request.requestId,
    appId: input.request.appId,
    workspaceId: input.request.workspaceId,
    buildId: input.request.buildId,
    status,
    completedAt: cleanString(input.completedAt),
    summary,
    results,
    unknownOutcomeCheckIds,
    failedCheckIds,
    errorCaptures: buildSmokeErrorCaptures(input.request, input.outcomes),
  });
}

export function capturePreviewError(input: PreviewErrorCaptureInput): PreviewErrorCapture {
  const normalized = normalizeError(input.error);
  const logExcerpt = normalizeLogs(input.logs);
  const location = normalizeLocation(input.location);
  const routePath = normalizePath(input.routePath);
  const smokeCheckId = cleanString(input.smokeCheckId);
  const buildId = cleanString(input.buildId);
  const capturedAt = cleanString(input.capturedAt);
  const fingerprint = shortHash(
    [
      input.source,
      input.appId,
      buildId,
      smokeCheckId,
      routePath,
      location?.filePath,
      location?.line,
      normalized.name,
      normalized.message,
    ]
      .filter((value) => value !== undefined)
      .join("|"),
  );

  return removeUndefined({
    kind: "preview-error-capture" as const,
    appId: input.appId,
    workspaceId: cleanString(input.workspaceId),
    source: input.source,
    severity: input.severity ?? "error",
    buildId,
    smokeCheckId,
    routePath,
    capturedAt,
    message: normalized.message,
    name: normalized.name,
    stack: normalized.stack,
    logExcerpt,
    location,
    fingerprint,
    fixable: input.severity !== "warning",
  });
}

export function capturePreviewBuildError(
  input: Omit<PreviewErrorCaptureInput, "source">,
): PreviewErrorCapture {
  return capturePreviewError({ ...input, source: "build" });
}

export function capturePreviewRuntimeError(
  input: Omit<PreviewErrorCaptureInput, "source">,
): PreviewErrorCapture {
  return capturePreviewError({ ...input, source: "runtime" });
}

export function buildPreviewFixPromptHandoff(
  input: PreviewFixPromptHandoffInput,
): PreviewFixPromptHandoff {
  const capture = input.capture;
  const readinessHandoff = buildRuntimeErrorHandoff({
    appId: capture.appId,
    workspaceId: capture.workspaceId,
    routePath: capture.routePath,
    source: capture.source,
    buildId: capture.buildId,
    smokeCheckId: capture.smokeCheckId,
    capturedAt: capture.capturedAt,
    error: {
      name: capture.name,
      message: capture.message,
      stack: capture.stack,
    },
  } satisfies RuntimeErrorHandoffInput);
  const routeContext = (input.routeMap ?? [])
    .map(
      (route) =>
        `${normalizePath(route.path) ?? route.path}${route.title ? ` (${route.title.trim()})` : ""}`,
    )
    .sort()
    .join(", ");
  const failedCheckIds =
    input.smokeResult?.failedCheckIds ?? (capture.smokeCheckId ? [capture.smokeCheckId] : []);
  const contextLines = [
    input.appName ? `App name: ${input.appName.trim()}` : undefined,
    input.originalPrompt ? `Original prompt: ${redact(input.originalPrompt.trim())}` : undefined,
    routeContext ? `Routes: ${routeContext}` : undefined,
    capture.routePath ? `Failing route: ${capture.routePath}` : undefined,
    failedCheckIds.length > 0 ? `Failing smoke checks: ${failedCheckIds.join(", ")}` : undefined,
    capture.location ? `Location: ${formatLocation(capture.location)}` : undefined,
    capture.logExcerpt ? `Log excerpt: ${capture.logExcerpt}` : undefined,
    ...(input.builderContext ?? []).map((line) => redact(line.trim())).filter(Boolean),
  ].filter((line): line is string => Boolean(line));

  const prompt = [
    `Repair the generated app after a ${capture.source} failure.`,
    `App id: ${capture.appId}`,
    `Failure fingerprint: ${capture.fingerprint}`,
    `Error: ${capture.message}`,
    contextLines.length > 0
      ? `Context:\n${contextLines.map((line) => `- ${line}`).join("\n")}`
      : undefined,
    "Return a minimal generated-app patch, preserve the original app intent, and include the smoke or build verification to rerun.",
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    kind: "builder-fix-prompt-handoff",
    title: `Send ${capture.source} fix to builder`,
    prompt,
    readinessHandoff,
    metadata: removeUndefined({
      appId: capture.appId,
      workspaceId: capture.workspaceId,
      appName: input.appName?.trim() || undefined,
      source: capture.source,
      buildId: capture.buildId,
      smokeCheckId: capture.smokeCheckId,
      routePath: capture.routePath,
      fingerprint: capture.fingerprint,
      capturedAt: capture.capturedAt,
      failedCheckIds,
    }),
  };
}

function refreshState(
  input: PreviewRefreshStateInput,
  state: Omit<PreviewRefreshState, "kind" | "appId" | "workspaceId" | "previewPath">,
): PreviewRefreshState {
  return removeUndefined({
    kind: "preview-refresh-state" as const,
    appId: input.appId,
    workspaceId: cleanString(input.workspaceId),
    previewPath: normalizePath(input.previewPath),
    ...state,
  });
}

function buildSmokeErrorCaptures(
  request: SmokeRerunRequest,
  outcomes: SmokeRerunOutcomeInput[],
): PreviewErrorCapture[] {
  const checksById = new Map(request.checks.map((check) => [check.id, check]));
  return outcomes
    .filter((outcome) => outcome.status === "failed" || outcome.status === "timed-out")
    .map((outcome) => {
      const checkId = stableCheckId(outcome.checkId);
      const check = checksById.get(checkId);
      return capturePreviewError({
        appId: request.appId,
        workspaceId: request.workspaceId,
        source: "smoke",
        buildId: request.buildId,
        smokeCheckId: checkId,
        routePath: check?.path,
        capturedAt: outcome.completedAt,
        error: outcome.error ?? `${check?.label ?? checkId} ${outcome.status}`,
      });
    })
    .sort((left, right) => left.smokeCheckId?.localeCompare(right.smokeCheckId ?? "") ?? 0);
}

function compareSmokeChecks(left: AppSmokeCheck, right: AppSmokeCheck): number {
  return (
    left.id.localeCompare(right.id) ||
    left.path.localeCompare(right.path) ||
    left.method.localeCompare(right.method)
  );
}

function copySmokeCheck(check: AppSmokeCheck): AppSmokeCheck {
  return {
    ...check,
    assertions: [...check.assertions],
  };
}

function normalizeError(error: unknown): { message: string; name?: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: redact(error.message || "unknown preview error"),
      name: error.name || undefined,
      stack: error.stack ? redact(error.stack) : undefined,
    };
  }

  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    return {
      message: redact(String(record.message ?? "unknown preview error")),
      name: typeof record.name === "string" ? record.name : undefined,
      stack: typeof record.stack === "string" ? redact(record.stack) : undefined,
    };
  }

  return { message: redact(String(error || "unknown preview error")) };
}

function normalizeLogs(logs: string | string[] | undefined): string | undefined {
  const joined = Array.isArray(logs) ? logs.join("\n") : logs;
  const redacted = redact(String(joined ?? "").trim());
  if (!redacted) return undefined;
  return redacted.length > MAX_LOG_EXCERPT_LENGTH
    ? `${redacted.slice(0, MAX_LOG_EXCERPT_LENGTH).trim()}...`
    : redacted;
}

function normalizeLocation(
  location: PreviewErrorCaptureInput["location"],
): PreviewErrorCapture["location"] | undefined {
  if (!location) return undefined;
  return removeUndefined({
    filePath: cleanString(location.filePath),
    line: positiveInteger(location.line),
    column: positiveInteger(location.column),
  });
}

function normalizePath(path: string | undefined): string | undefined {
  const trimmed = cleanString(path);
  if (!trimmed) return undefined;
  const [pathname, query = ""] = trimmed.split("?", 2);
  const normalized = pathname.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/g, "");
  const prefixed = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `${prefixed || "/"}${query ? `?${query}` : ""}`;
}

function formatLocation(location: NonNullable<PreviewErrorCapture["location"]>): string {
  return [
    location.filePath,
    location.line ? `line ${location.line}` : undefined,
    location.column ? `column ${location.column}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
}

function countStatus(results: SmokeRerunCheckResult[], status: SmokeRerunCheckStatus): number {
  return results.filter((result) => result.status === status).length;
}

function compareTimestamp(left: string | undefined, right: string | undefined): number {
  if (!left && !right) return 0;
  if (left && !right) return 1;
  if (!left && right) return -1;
  const leftTime = Date.parse(left ?? "");
  const rightTime = Date.parse(right ?? "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime;
  return String(left).localeCompare(String(right));
}

function stableCheckId(value: string): string {
  return value.trim();
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

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function nonNegativeInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function cleanString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function redact(value: string): string {
  return value.replace(SECRET_PATTERN, "$1=[redacted]");
}

function removeUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}
