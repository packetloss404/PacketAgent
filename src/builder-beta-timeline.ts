import { createHash } from "node:crypto";

export type BuilderBetaTimelineEventKind =
  | "prompt_turn"
  | "generation_change"
  | "preview_result"
  | "build_result"
  | "smoke_result"
  | "publish_event"
  | "integration_check"
  | "failure"
  | "next_action";

export type BuilderBetaTimelineEntryStatus =
  | "info"
  | "pending"
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "warning"
  | "blocked"
  | "published"
  | "completed"
  | "skipped";

export type BuilderBetaTimelineSeverity = "info" | "warning" | "error";
export type BuilderBetaTimelineStatus = "ready" | "attention" | "blocked";
export type BuilderBetaPromptRole = "system" | "user" | "assistant" | "tool";
export type BuilderBetaGenerationChangeType = "create" | "update" | "delete" | "rename";
export type BuilderBetaFailureSource =
  | "prompt"
  | "generation"
  | "preview"
  | "build"
  | "smoke"
  | "publish"
  | "integration";
export type BuilderBetaNextActionStatus = "pending" | "completed" | "skipped";

export interface BuilderBetaTimelineInput {
  appId: string;
  workspaceId?: string;
  generatedAt?: string;
  promptTurns?: BuilderBetaPromptTurnInput[];
  generationChanges?: BuilderBetaGenerationChangeInput[];
  previewResults?: BuilderBetaPreviewResultInput[];
  buildResults?: BuilderBetaBuildResultInput[];
  smokeResults?: BuilderBetaSmokeResultInput[];
  publishEvents?: BuilderBetaPublishEventInput[];
  integrationChecks?: BuilderBetaIntegrationCheckInput[];
  failures?: BuilderBetaFailureInput[];
  nextActions?: BuilderBetaNextActionInput[];
}

export interface BuilderBetaPromptTurnInput {
  id?: string;
  at?: string;
  role: BuilderBetaPromptRole;
  actor?: string;
  content: string;
}

export interface BuilderBetaGenerationChangeInput {
  id?: string;
  at?: string;
  changeType?: BuilderBetaGenerationChangeType;
  summary: string;
  filePath?: string;
  routePath?: string;
  checkpointId?: string;
  diffStat?: {
    files?: number;
    additions?: number;
    deletions?: number;
  };
}

export interface BuilderBetaPreviewResultInput {
  id?: string;
  at?: string;
  status: BuilderBetaTimelineEntryStatus | "ready" | "stale" | "refreshing";
  previewUrl?: string;
  buildId?: string;
  message?: string;
}

export interface BuilderBetaBuildResultInput {
  id?: string;
  at?: string;
  buildId?: string;
  status: BuilderBetaTimelineEntryStatus | "canceled";
  durationMs?: number;
  message?: string;
  logs?: string | string[];
}

export interface BuilderBetaSmokeResultInput {
  id?: string;
  at?: string;
  status: BuilderBetaTimelineEntryStatus | "partial";
  passed?: number;
  failed?: number;
  skipped?: number;
  notRun?: number;
  checkIds?: string[];
  failedCheckIds?: string[];
  message?: string;
}

export interface BuilderBetaPublishEventInput {
  id?: string;
  at?: string;
  publishId?: string;
  status: BuilderBetaTimelineEntryStatus;
  versionLabel?: string;
  publicUrl?: string;
  privateUrl?: string;
  message?: string;
}

export interface BuilderBetaIntegrationCheckInput {
  id?: string;
  at?: string;
  provider: string;
  status: BuilderBetaTimelineEntryStatus;
  capability?: string;
  message?: string;
  requiredSetup?: string[];
}

export interface BuilderBetaFailureInput {
  id?: string;
  at?: string;
  source: BuilderBetaFailureSource;
  message: string;
  severity?: BuilderBetaTimelineSeverity;
  fingerprint?: string;
  routePath?: string;
  filePath?: string;
  nextActionId?: string;
}

export interface BuilderBetaNextActionInput {
  id?: string;
  at?: string;
  status?: BuilderBetaNextActionStatus;
  owner?: string;
  action: string;
  dueAt?: string;
  sourceEventId?: string;
}

export interface BuilderBetaTimelineEntry {
  id: string;
  kind: BuilderBetaTimelineEventKind;
  at: string;
  order: number;
  title: string;
  summary: string;
  status: BuilderBetaTimelineEntryStatus;
  severity: BuilderBetaTimelineSeverity;
  actor?: string;
  references: {
    appId: string;
    workspaceId?: string;
    buildId?: string;
    checkpointId?: string;
    publishId?: string;
    previewUrl?: string;
    publicUrl?: string;
    privateUrl?: string;
    filePath?: string;
    routePath?: string;
    provider?: string;
    sourceEventId?: string;
    nextActionId?: string;
    fingerprint?: string;
  };
  details: Record<string, string | number | boolean | string[]>;
}

export interface BuilderBetaTimeline {
  kind: "builder-beta-consolidated-timeline";
  version: "phase-72-lane-3";
  appId: string;
  workspaceId?: string;
  generatedAt: string;
  status: BuilderBetaTimelineStatus;
  summary: {
    total: number;
    prompts: number;
    generationChanges: number;
    previewResults: number;
    buildResults: number;
    smokeResults: number;
    publishEvents: number;
    integrationChecks: number;
    failures: number;
    nextActions: number;
    openNextActions: number;
    warnings: number;
    errors: number;
  };
  entries: BuilderBetaTimelineEntry[];
}

const DEFAULT_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const MAX_TEXT_LENGTH = 240;
const MAX_LOG_EXCERPT_LENGTH = 800;
const SECRET_PATTERN =
  /\b(api[_-]?key|authorization|bearer|secret|token|password)\b\s*[:=]\s*["']?(?:Bearer\s+)?[^"',\s)]+/gi;
const KIND_ORDER = new Map<BuilderBetaTimelineEventKind, number>([
  ["prompt_turn", 10],
  ["generation_change", 20],
  ["preview_result", 30],
  ["build_result", 40],
  ["smoke_result", 50],
  ["publish_event", 60],
  ["integration_check", 70],
  ["failure", 80],
  ["next_action", 90],
]);

export function buildBuilderBetaTimeline(input: BuilderBetaTimelineInput): BuilderBetaTimeline {
  const context = {
    appId: input.appId,
    workspaceId: cleanString(input.workspaceId) || undefined,
  };
  const entries = [
    ...(input.promptTurns ?? []).map((turn) => promptTurnEntry(context, turn)),
    ...(input.generationChanges ?? []).map((change) => generationChangeEntry(context, change)),
    ...(input.previewResults ?? []).map((result) => previewResultEntry(context, result)),
    ...(input.buildResults ?? []).map((result) => buildResultEntry(context, result)),
    ...(input.smokeResults ?? []).map((result) => smokeResultEntry(context, result)),
    ...(input.publishEvents ?? []).map((event) => publishEventEntry(context, event)),
    ...(input.integrationChecks ?? []).map((check) => integrationCheckEntry(context, check)),
    ...(input.failures ?? []).map((failure) => failureEntry(context, failure)),
    ...(input.nextActions ?? []).map((action) => nextActionEntry(context, action)),
  ]
    .sort(compareEntries)
    .map((entry, index) => ({ ...entry, order: index + 1 }));
  const summary = summarizeEntries(entries);
  const status: BuilderBetaTimelineStatus =
    summary.errors > 0
      ? "blocked"
      : summary.warnings > 0 || summary.openNextActions > 0
        ? "attention"
        : "ready";

  return removeUndefined({
    kind: "builder-beta-consolidated-timeline" as const,
    version: "phase-72-lane-3" as const,
    appId: input.appId,
    workspaceId: context.workspaceId,
    generatedAt: normalizeTimestamp(input.generatedAt),
    status,
    summary,
    entries,
  });
}

export function renderBuilderBetaTimelineTranscript(timeline: BuilderBetaTimeline): string {
  return timeline.entries
    .map((entry) => {
      const prefix = `${entry.order}. [${entry.at}] ${entry.kind}/${entry.status}`;
      return `${prefix} - ${entry.title}: ${entry.summary}`;
    })
    .join("\n");
}

function promptTurnEntry(
  context: Pick<BuilderBetaTimelineInput, "appId" | "workspaceId">,
  input: BuilderBetaPromptTurnInput,
): BuilderBetaTimelineEntry {
  const actor = cleanString(input.actor) || input.role;
  return entry(context, {
    idSeed: [input.id, input.at, input.role, actor, input.content],
    explicitId: input.id,
    kind: "prompt_turn",
    at: input.at,
    title: `${capitalize(input.role)} prompt turn`,
    summary: truncate(redact(input.content)),
    status: "info",
    severity: "info",
    actor,
    details: { role: input.role },
  });
}

function generationChangeEntry(
  context: Pick<BuilderBetaTimelineInput, "appId" | "workspaceId">,
  input: BuilderBetaGenerationChangeInput,
): BuilderBetaTimelineEntry {
  const changeType = input.changeType ?? "update";
  const diff = input.diffStat;
  const diffSummary = diff
    ? ` (${nonNegativeInteger(diff.files) ?? 0} files, +${nonNegativeInteger(diff.additions) ?? 0}/-${nonNegativeInteger(diff.deletions) ?? 0})`
    : "";
  return entry(context, {
    idSeed: [
      input.id,
      input.at,
      changeType,
      input.summary,
      input.filePath,
      input.routePath,
      input.checkpointId,
    ],
    explicitId: input.id,
    kind: "generation_change",
    at: input.at,
    title: `${capitalize(changeType)} generated app`,
    summary: `${truncate(redact(input.summary))}${diffSummary}`,
    status: "info",
    severity: "info",
    references: {
      filePath: cleanString(input.filePath) || undefined,
      routePath: normalizePath(input.routePath),
      checkpointId: cleanString(input.checkpointId) || undefined,
    },
    details: removeUndefined({
      changeType,
      files: nonNegativeInteger(diff?.files),
      additions: nonNegativeInteger(diff?.additions),
      deletions: nonNegativeInteger(diff?.deletions),
    }),
  });
}

function previewResultEntry(
  context: Pick<BuilderBetaTimelineInput, "appId" | "workspaceId">,
  input: BuilderBetaPreviewResultInput,
): BuilderBetaTimelineEntry {
  const status = normalizeStatus(input.status);
  return entry(context, {
    idSeed: [input.id, input.at, status, input.previewUrl, input.buildId, input.message],
    explicitId: input.id,
    kind: "preview_result",
    at: input.at,
    title: previewTitle(status),
    summary: truncate(redact(input.message ?? previewSummary(status))),
    status,
    severity: severityForStatus(status),
    references: {
      previewUrl: cleanString(input.previewUrl) || undefined,
      buildId: cleanString(input.buildId) || undefined,
    },
    details: {},
  });
}

function buildResultEntry(
  context: Pick<BuilderBetaTimelineInput, "appId" | "workspaceId">,
  input: BuilderBetaBuildResultInput,
): BuilderBetaTimelineEntry {
  const status = normalizeStatus(input.status);
  const logExcerpt = normalizeLogs(input.logs);
  return entry(context, {
    idSeed: [input.id, input.at, input.buildId, status, input.message, logExcerpt],
    explicitId: input.id,
    kind: "build_result",
    at: input.at,
    title: `Build ${status}`,
    summary: truncate(redact(input.message ?? `Build ${status}.`)),
    status,
    severity: severityForStatus(status),
    references: { buildId: cleanString(input.buildId) || undefined },
    details: removeUndefined({
      durationMs: nonNegativeInteger(input.durationMs),
      logExcerpt,
    }),
  });
}

function smokeResultEntry(
  context: Pick<BuilderBetaTimelineInput, "appId" | "workspaceId">,
  input: BuilderBetaSmokeResultInput,
): BuilderBetaTimelineEntry {
  const status = normalizeStatus(input.status);
  const passed = nonNegativeInteger(input.passed) ?? 0;
  const failed = nonNegativeInteger(input.failed) ?? 0;
  const skipped = nonNegativeInteger(input.skipped) ?? 0;
  const notRun = nonNegativeInteger(input.notRun) ?? 0;
  return entry(context, {
    idSeed: [
      input.id,
      input.at,
      status,
      passed,
      failed,
      skipped,
      notRun,
      input.checkIds?.join("|"),
    ],
    explicitId: input.id,
    kind: "smoke_result",
    at: input.at,
    title: `Smoke ${status}`,
    summary: truncate(
      redact(
        input.message ??
          `${passed} passed, ${failed} failed, ${skipped} skipped, ${notRun} not run.`,
      ),
    ),
    status,
    severity:
      status === "failed" || status === "blocked"
        ? "error"
        : status === "warning"
          ? "warning"
          : "info",
    details: removeUndefined({
      passed,
      failed,
      skipped,
      notRun,
      checkIds: uniqueSorted(input.checkIds ?? []),
      failedCheckIds: uniqueSorted(input.failedCheckIds ?? []),
    }),
  });
}

function publishEventEntry(
  context: Pick<BuilderBetaTimelineInput, "appId" | "workspaceId">,
  input: BuilderBetaPublishEventInput,
): BuilderBetaTimelineEntry {
  const status = normalizeStatus(input.status);
  return entry(context, {
    idSeed: [
      input.id,
      input.at,
      input.publishId,
      input.versionLabel,
      status,
      input.publicUrl,
      input.privateUrl,
    ],
    explicitId: input.id,
    kind: "publish_event",
    at: input.at,
    title: status === "published" ? "Published app" : `Publish ${status}`,
    summary: truncate(
      redact(
        input.message ??
          (input.versionLabel
            ? `Publish ${input.versionLabel} is ${status}.`
            : `Publish is ${status}.`),
      ),
    ),
    status,
    severity: severityForStatus(status),
    references: {
      publishId: cleanString(input.publishId) || undefined,
      publicUrl: cleanString(input.publicUrl) || undefined,
      privateUrl: cleanString(input.privateUrl) || undefined,
    },
    details: removeUndefined({ versionLabel: cleanString(input.versionLabel) || undefined }),
  });
}

function integrationCheckEntry(
  context: Pick<BuilderBetaTimelineInput, "appId" | "workspaceId">,
  input: BuilderBetaIntegrationCheckInput,
): BuilderBetaTimelineEntry {
  const status = normalizeStatus(input.status);
  const provider = cleanString(input.provider) || "integration";
  return entry(context, {
    idSeed: [
      input.id,
      input.at,
      provider,
      input.capability,
      status,
      input.message,
      input.requiredSetup?.join("|"),
    ],
    explicitId: input.id,
    kind: "integration_check",
    at: input.at,
    title: `${provider} integration ${status}`,
    summary: truncate(
      redact(
        input.message ??
          `${provider} ${cleanString(input.capability) || "integration"} check is ${status}.`,
      ),
    ),
    status,
    severity:
      status === "failed" || status === "blocked"
        ? "error"
        : input.requiredSetup?.length
          ? "warning"
          : severityForStatus(status),
    references: { provider },
    details: removeUndefined({
      capability: cleanString(input.capability) || undefined,
      requiredSetup: uniqueSorted((input.requiredSetup ?? []).map(redact)),
    }),
  });
}

function failureEntry(
  context: Pick<BuilderBetaTimelineInput, "appId" | "workspaceId">,
  input: BuilderBetaFailureInput,
): BuilderBetaTimelineEntry {
  const severity = input.severity ?? "error";
  return entry(context, {
    idSeed: [
      input.id,
      input.at,
      input.source,
      severity,
      input.message,
      input.fingerprint,
      input.routePath,
      input.filePath,
    ],
    explicitId: input.id,
    kind: "failure",
    at: input.at,
    title: `${capitalize(input.source)} failure`,
    summary: truncate(redact(input.message)),
    status: severity === "error" ? "failed" : "warning",
    severity,
    references: {
      routePath: normalizePath(input.routePath),
      filePath: cleanString(input.filePath) || undefined,
      fingerprint: cleanString(input.fingerprint) || undefined,
      nextActionId: cleanString(input.nextActionId) || undefined,
    },
    details: { source: input.source },
  });
}

function nextActionEntry(
  context: Pick<BuilderBetaTimelineInput, "appId" | "workspaceId">,
  input: BuilderBetaNextActionInput,
): BuilderBetaTimelineEntry {
  const status = normalizeStatus(input.status ?? "pending");
  const actionId =
    cleanString(input.id) ||
    `next_action_${stableHash([input.at, input.owner, input.action].join(":")).slice(0, 12)}`;
  return entry(context, {
    idSeed: [actionId],
    explicitId: actionId,
    kind: "next_action",
    at: input.at ?? input.dueAt,
    title: status === "completed" ? "Completed next action" : "Next action",
    summary: truncate(redact(input.action)),
    status,
    severity: status === "pending" ? "warning" : "info",
    actor: cleanString(input.owner) || undefined,
    references: { sourceEventId: cleanString(input.sourceEventId) || undefined },
    details: removeUndefined({
      owner: cleanString(input.owner) || undefined,
      dueAt: normalizeOptionalTimestamp(input.dueAt),
    }),
  });
}

function entry(
  context: Pick<BuilderBetaTimelineInput, "appId" | "workspaceId">,
  input: {
    explicitId?: string;
    idSeed: unknown[];
    kind: BuilderBetaTimelineEventKind;
    at?: string;
    title: string;
    summary: string;
    status: BuilderBetaTimelineEntryStatus;
    severity: BuilderBetaTimelineSeverity;
    actor?: string;
    references?: Partial<BuilderBetaTimelineEntry["references"]>;
    details: Record<string, string | number | boolean | string[] | undefined>;
  },
): BuilderBetaTimelineEntry {
  const at = normalizeTimestamp(input.at);
  const id =
    cleanString(input.explicitId) ||
    `${input.kind}_${stableHash(input.idSeed.map((value) => String(value ?? "")).join(":")).slice(0, 16)}`;
  return removeUndefined({
    id,
    kind: input.kind,
    at,
    order: 0,
    title: input.title,
    summary: input.summary,
    status: input.status,
    severity: input.severity,
    actor: cleanString(input.actor) || undefined,
    references: removeUndefined({
      appId: context.appId,
      workspaceId: cleanString(context.workspaceId) || undefined,
      ...(input.references ?? {}),
    }),
    details: removeUndefined(input.details) as Record<string, string | number | boolean | string[]>,
  });
}

function summarizeEntries(entries: BuilderBetaTimelineEntry[]): BuilderBetaTimeline["summary"] {
  return {
    total: entries.length,
    prompts: countKind(entries, "prompt_turn"),
    generationChanges: countKind(entries, "generation_change"),
    previewResults: countKind(entries, "preview_result"),
    buildResults: countKind(entries, "build_result"),
    smokeResults: countKind(entries, "smoke_result"),
    publishEvents: countKind(entries, "publish_event"),
    integrationChecks: countKind(entries, "integration_check"),
    failures: countKind(entries, "failure"),
    nextActions: countKind(entries, "next_action"),
    openNextActions: entries.filter(
      (entry) => entry.kind === "next_action" && entry.status === "pending",
    ).length,
    warnings: entries.filter((entry) => entry.severity === "warning").length,
    errors: entries.filter((entry) => entry.severity === "error").length,
  };
}

function compareEntries(left: BuilderBetaTimelineEntry, right: BuilderBetaTimelineEntry): number {
  return (
    timestampMs(left.at) - timestampMs(right.at) ||
    (KIND_ORDER.get(left.kind) ?? 100) - (KIND_ORDER.get(right.kind) ?? 100) ||
    left.id.localeCompare(right.id) ||
    left.title.localeCompare(right.title)
  );
}

function countKind(
  entries: BuilderBetaTimelineEntry[],
  kind: BuilderBetaTimelineEventKind,
): number {
  return entries.filter((entry) => entry.kind === kind).length;
}

function previewTitle(status: BuilderBetaTimelineEntryStatus): string {
  if (status === "passed") return "Preview ready";
  if (status === "running") return "Preview refreshing";
  if (status === "warning") return "Preview stale";
  if (status === "blocked") return "Preview blocked";
  return `Preview ${status}`;
}

function previewSummary(status: BuilderBetaTimelineEntryStatus): string {
  if (status === "passed") return "Preview is ready for the current generated app.";
  if (status === "running") return "Preview refresh is still running.";
  if (status === "warning") return "Preview is stale and should be refreshed.";
  if (status === "blocked") return "Preview is blocked by a runtime or build issue.";
  return `Preview result is ${status}.`;
}

function normalizeStatus(
  status:
    | BuilderBetaTimelineEntryStatus
    | "ready"
    | "stale"
    | "refreshing"
    | "partial"
    | "canceled",
): BuilderBetaTimelineEntryStatus {
  if (status === "ready") return "passed";
  if (status === "stale" || status === "partial") return "warning";
  if (status === "refreshing") return "running";
  if (status === "canceled") return "skipped";
  return status;
}

function severityForStatus(status: BuilderBetaTimelineEntryStatus): BuilderBetaTimelineSeverity {
  if (status === "failed" || status === "blocked") return "error";
  if (status === "warning") return "warning";
  return "info";
}

function normalizeLogs(logs: string | string[] | undefined): string | undefined {
  const joined = Array.isArray(logs) ? logs.join("\n") : logs;
  const redacted = redact(cleanString(joined));
  if (!redacted) return undefined;
  return redacted.length > MAX_LOG_EXCERPT_LENGTH
    ? `${redacted.slice(0, MAX_LOG_EXCERPT_LENGTH).trim()}...`
    : redacted;
}

function normalizePath(path: string | undefined): string | undefined {
  const trimmed = cleanString(path);
  if (!trimmed) return undefined;
  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/g, "");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function normalizeTimestamp(value: string | undefined): string {
  const cleaned = cleanString(value);
  if (!cleaned) return DEFAULT_TIMESTAMP;
  const ms = Date.parse(cleaned);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : DEFAULT_TIMESTAMP;
}

function normalizeOptionalTimestamp(value: string | undefined): string | undefined {
  return cleanString(value) ? normalizeTimestamp(value) : undefined;
}

function timestampMs(value: string): number {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function truncate(value: string): string {
  const cleaned = cleanString(value);
  return cleaned.length > MAX_TEXT_LENGTH
    ? `${cleaned.slice(0, MAX_TEXT_LENGTH).trim()}...`
    : cleaned;
}

function redact(value: string): string {
  return value.replace(SECRET_PATTERN, "$1=[redacted]");
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => cleanString(value)).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function nonNegativeInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function cleanString(value: string | undefined): string {
  return String(value ?? "").trim();
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function removeUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}
