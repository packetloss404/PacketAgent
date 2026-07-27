import { createHash } from "node:crypto";

export type AppPreviewSnapshotBuildStatus = "not_run" | "queued" | "running" | "passed" | "failed" | "canceled";
export type AppPreviewSnapshotSmokeStatus = "not_run" | "pending" | "pass" | "warn" | "fail";
export type AppPreviewSnapshotSource = "builder" | "checkpoint" | "preview" | "smoke" | "publish";
export type AppPreviewSnapshotComparisonRelation = "new" | "unchanged" | "advanced" | "regressed" | "diverged";
export type AppPreviewSnapshotPublishHandoffStatus = "ready" | "blocked";
export type AppPreviewSnapshotRollbackStatus = "pending" | "succeeded" | "failed" | "noop";

export interface AppPreviewSnapshotInput {
  workspaceId?: string;
  appId?: string;
  appSlug?: string;
  appName?: string;
  checkpointId?: string;
  checkpointSavedAt?: string;
  buildId?: string;
  buildStatus?: string;
  smokeStatus?: string;
  previewUrl?: string;
  contentHash?: string;
  artifactPaths?: string[];
  generatedFiles?: string[];
  capturedAt?: string;
  createdByUserId?: string;
  source?: AppPreviewSnapshotSource;
}

export interface AppPreviewSnapshotMetadata {
  version: "phase-69-lane-5";
  id: string;
  workspaceId: string;
  appId: string;
  appSlug: string;
  source: AppPreviewSnapshotSource;
  capturedAt: string;
  createdByUserId?: string;
  checkpoint: {
    id: string;
    savedAt: string;
  };
  build: {
    id: string;
    status: AppPreviewSnapshotBuildStatus;
    smokeStatus: AppPreviewSnapshotSmokeStatus;
    previewUrl?: string;
    contentHash: string;
    artifactPaths: string[];
    generatedFiles: string[];
  };
  publishHandoff: AppPreviewSnapshotPublishHandoffReadiness;
}

export interface AppPreviewSnapshotComparison {
  relation: AppPreviewSnapshotComparisonRelation;
  changed: boolean;
  currentSnapshotId: string;
  previousSnapshotId?: string;
  checkpointChanged: boolean;
  buildStatusChanged: boolean;
  smokeStatusChanged: boolean;
  contentHashChanged: boolean;
  publishReadinessChanged: boolean;
  summary: string;
}

export interface AppPreviewSnapshotRollbackCommandInput {
  current: AppPreviewSnapshotMetadata;
  target: AppPreviewSnapshotMetadata;
  requestedByUserId?: string;
  reason?: string;
}

export interface AppPreviewSnapshotRollbackCommand {
  kind: "preview-snapshot-rollback";
  commandId: string;
  command: string;
  workspaceId: string;
  appId: string;
  currentSnapshotId: string;
  targetSnapshotId: string;
  fromCheckpointId: string;
  toCheckpointId: string;
  requestedByUserId?: string;
  reason?: string;
  requiresConfirmation: true;
  expectedResult: {
    status: "pending";
    restoredCheckpointId: string;
    supersededCheckpointId: string;
    previewUrl?: string;
  };
}

export interface AppPreviewSnapshotRollbackResultInput {
  command: AppPreviewSnapshotRollbackCommand;
  status?: AppPreviewSnapshotRollbackStatus;
  completedAt?: string;
  previewUrl?: string;
  error?: string;
}

export interface AppPreviewSnapshotRollbackResult {
  kind: "preview-snapshot-rollback-result";
  commandId: string;
  status: AppPreviewSnapshotRollbackStatus;
  rolledBack: boolean;
  restoredCheckpointId: string;
  supersededCheckpointId: string;
  targetSnapshotId: string;
  completedAt: string;
  previewUrl?: string;
  message: string;
  error?: string;
}

export interface AppPreviewSnapshotPublishHandoffReadiness {
  status: AppPreviewSnapshotPublishHandoffStatus;
  ready: boolean;
  snapshotId: string;
  checkpointId: string;
  buildId: string;
  previewUrl?: string;
  blockers: string[];
  notes: string[];
}

export interface AppPreviewSnapshotRetentionOptions {
  keepLatest?: number;
  keepPublishReady?: boolean;
}

export interface AppPreviewSnapshotRetentionEntry {
  snapshotId: string;
  checkpointId: string;
  capturedAt: string;
  publishReady: boolean;
  retentionRank: number;
  retain: boolean;
  reason: string;
}

const DEFAULT_WORKSPACE_ID = "workspace";
const DEFAULT_APP_ID = "generated-app";
const DEFAULT_CHECKPOINT_ID = "checkpoint";
const DEFAULT_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const DEFAULT_KEEP_LATEST = 3;

const BUILD_STATUS_ALIASES: Record<string, AppPreviewSnapshotBuildStatus> = {
  not_run: "not_run",
  notrun: "not_run",
  "not-run": "not_run",
  pending: "queued",
  queued: "queued",
  running: "running",
  pass: "passed",
  passed: "passed",
  success: "passed",
  succeeded: "passed",
  fail: "failed",
  failed: "failed",
  error: "failed",
  canceled: "canceled",
  cancelled: "canceled",
};

const SMOKE_STATUS_ALIASES: Record<string, AppPreviewSnapshotSmokeStatus> = {
  not_run: "not_run",
  notrun: "not_run",
  "not-run": "not_run",
  pending: "pending",
  queued: "pending",
  running: "pending",
  pass: "pass",
  passed: "pass",
  success: "pass",
  warn: "warn",
  warning: "warn",
  fail: "fail",
  failed: "fail",
  error: "fail",
};

export function buildAppPreviewSnapshotMetadata(input: AppPreviewSnapshotInput = {}): AppPreviewSnapshotMetadata {
  const workspaceId = stableToken(input.workspaceId) || DEFAULT_WORKSPACE_ID;
  const appSlug = slugify(input.appSlug || input.appName || input.appId) || DEFAULT_APP_ID;
  const appId = stableToken(input.appId) || `gapp_${stableHash(`${workspaceId}:${appSlug}`).slice(0, 12)}`;
  const checkpointId = stableToken(input.checkpointId) || `gapp_ckpt_${stableHash(`${workspaceId}:${appId}:${appSlug}`).slice(0, 12)}`;
  const capturedAt = normalizeTimestamp(input.capturedAt ?? input.checkpointSavedAt);
  const checkpointSavedAt = normalizeTimestamp(input.checkpointSavedAt ?? capturedAt);
  const buildStatus = normalizeBuildStatus(input.buildStatus);
  const smokeStatus = normalizeSmokeStatus(input.smokeStatus);
  const generatedFiles = uniqueSorted(input.generatedFiles ?? []);
  const artifactPaths = uniqueSorted(input.artifactPaths ?? defaultArtifactPaths(workspaceId, appSlug, checkpointId));
  const contentHash = normalizeHash(input.contentHash) || stableHash([
    workspaceId,
    appId,
    appSlug,
    checkpointId,
    generatedFiles.join("|"),
    artifactPaths.join("|"),
  ].join(":"));
  const buildId = stableToken(input.buildId) || `preview_build_${stableHash(`${checkpointId}:${contentHash}`).slice(0, 12)}`;
  const previewUrl = cleanString(input.previewUrl) || undefined;
  const source = input.source ?? "checkpoint";
  const id = `preview_snapshot_${stableHash([
    workspaceId,
    appId,
    checkpointId,
    buildId,
    contentHash,
    capturedAt,
  ].join(":")).slice(0, 16)}`;

  const snapshot: Omit<AppPreviewSnapshotMetadata, "publishHandoff"> = removeUndefined({
    version: "phase-69-lane-5",
    id,
    workspaceId,
    appId,
    appSlug,
    source,
    capturedAt,
    createdByUserId: cleanString(input.createdByUserId) || undefined,
    checkpoint: {
      id: checkpointId,
      savedAt: checkpointSavedAt,
    },
    build: {
      id: buildId,
      status: buildStatus,
      smokeStatus,
      previewUrl,
      contentHash,
      artifactPaths,
      generatedFiles,
    },
  });

  return {
    ...snapshot,
    publishHandoff: buildAppPreviewPublishHandoffReadiness(snapshot),
  };
}

export function compareAppPreviewSnapshots(
  current: AppPreviewSnapshotMetadata,
  previous?: AppPreviewSnapshotMetadata | null,
): AppPreviewSnapshotComparison {
  if (!previous) {
    return {
      relation: "new",
      changed: true,
      currentSnapshotId: current.id,
      checkpointChanged: true,
      buildStatusChanged: true,
      smokeStatusChanged: true,
      contentHashChanged: true,
      publishReadinessChanged: true,
      summary: `Created preview snapshot ${current.id} for checkpoint ${current.checkpoint.id}.`,
    };
  }

  const checkpointChanged = current.checkpoint.id !== previous.checkpoint.id;
  const buildStatusChanged = current.build.status !== previous.build.status;
  const smokeStatusChanged = current.build.smokeStatus !== previous.build.smokeStatus;
  const contentHashChanged = current.build.contentHash !== previous.build.contentHash;
  const publishReadinessChanged = current.publishHandoff.ready !== previous.publishHandoff.ready;
  const changed = checkpointChanged || buildStatusChanged || smokeStatusChanged || contentHashChanged || publishReadinessChanged;

  if (!changed && current.id === previous.id) {
    return comparison(current, previous, "unchanged", false, "Preview snapshot is unchanged.");
  }

  const relation = currentRegressed(current, previous)
    ? "regressed"
    : currentAdvanced(current, previous)
      ? "advanced"
      : changed
        ? "diverged"
        : "unchanged";

  return {
    relation,
    changed,
    currentSnapshotId: current.id,
    previousSnapshotId: previous.id,
    checkpointChanged,
    buildStatusChanged,
    smokeStatusChanged,
    contentHashChanged,
    publishReadinessChanged,
    summary: comparisonSummary(relation, current, previous),
  };
}

export function createAppPreviewRollbackCommand(
  input: AppPreviewSnapshotRollbackCommandInput,
): AppPreviewSnapshotRollbackCommand {
  const commandId = `preview_rollback_${stableHash([
    input.current.id,
    input.target.id,
    input.reason ?? "",
    input.requestedByUserId ?? "",
  ].join(":")).slice(0, 16)}`;
  const command = [
    "packetagent preview rollback",
    `--workspace=${input.current.workspaceId}`,
    `--app=${input.current.appId}`,
    `--from-checkpoint=${input.current.checkpoint.id}`,
    `--to-checkpoint=${input.target.checkpoint.id}`,
  ].join(" ");

  return removeUndefined({
    kind: "preview-snapshot-rollback",
    commandId,
    command,
    workspaceId: input.current.workspaceId,
    appId: input.current.appId,
    currentSnapshotId: input.current.id,
    targetSnapshotId: input.target.id,
    fromCheckpointId: input.current.checkpoint.id,
    toCheckpointId: input.target.checkpoint.id,
    requestedByUserId: cleanString(input.requestedByUserId) || undefined,
    reason: cleanString(input.reason) || undefined,
    requiresConfirmation: true,
    expectedResult: removeUndefined({
      status: "pending",
      restoredCheckpointId: input.target.checkpoint.id,
      supersededCheckpointId: input.current.checkpoint.id,
      previewUrl: input.target.build.previewUrl,
    }),
  } satisfies AppPreviewSnapshotRollbackCommand);
}

export function buildAppPreviewRollbackResult(
  input: AppPreviewSnapshotRollbackResultInput,
): AppPreviewSnapshotRollbackResult {
  const status = input.status ?? "pending";
  const rolledBack = status === "succeeded" || status === "noop";
  const previewUrl = cleanString(input.previewUrl) || input.command.expectedResult.previewUrl;
  const error = cleanString(input.error) || undefined;

  return removeUndefined({
    kind: "preview-snapshot-rollback-result",
    commandId: input.command.commandId,
    status,
    rolledBack,
    restoredCheckpointId: input.command.toCheckpointId,
    supersededCheckpointId: input.command.fromCheckpointId,
    targetSnapshotId: input.command.targetSnapshotId,
    completedAt: normalizeTimestamp(input.completedAt),
    previewUrl,
    message: rollbackMessage(status, input.command.toCheckpointId, error),
    error,
  } satisfies AppPreviewSnapshotRollbackResult);
}

export function buildAppPreviewPublishHandoffReadiness(
  snapshot: Pick<AppPreviewSnapshotMetadata, "id" | "checkpoint" | "build">,
): AppPreviewSnapshotPublishHandoffReadiness {
  const blockers = [
    ...(!stableToken(snapshot.checkpoint.id) ? ["A generated app checkpoint is required before publish handoff."] : []),
    ...(snapshot.build.status !== "passed" ? [`Preview build must pass before publish handoff; current status is ${snapshot.build.status}.`] : []),
    ...(snapshot.build.smokeStatus !== "pass" ? [`Smoke checks must pass before publish handoff; current status is ${snapshot.build.smokeStatus}.`] : []),
    ...(!snapshot.build.previewUrl ? ["A preview URL is required for reviewer and publish handoff."] : []),
    ...(snapshot.build.artifactPaths.length === 0 ? ["At least one preview snapshot artifact path is required."] : []),
  ];
  const ready = blockers.length === 0;

  return removeUndefined({
    status: ready ? "ready" : "blocked",
    ready,
    snapshotId: snapshot.id,
    checkpointId: snapshot.checkpoint.id,
    buildId: snapshot.build.id,
    previewUrl: snapshot.build.previewUrl,
    blockers,
    notes: ready
      ? [
        "Snapshot is tied to a generated app checkpoint.",
        "Preview build and smoke checks passed; publish handoff can use this checkpoint.",
      ]
      : [
        "Keep publish disabled until blockers are resolved.",
        "Use rollback metadata to return to the last publish-ready checkpoint if a newer preview regresses.",
      ],
  } satisfies AppPreviewSnapshotPublishHandoffReadiness);
}

export function orderAppPreviewSnapshotRetention(
  snapshots: AppPreviewSnapshotMetadata[],
  options: AppPreviewSnapshotRetentionOptions = {},
): AppPreviewSnapshotRetentionEntry[] {
  const keepLatest = nonNegativeInteger(options.keepLatest) ?? DEFAULT_KEEP_LATEST;
  const keepPublishReady = options.keepPublishReady ?? true;
  const ordered = [...snapshots].sort(compareSnapshotsForRetention);

  return ordered.map((snapshot, index) => {
    const retainedByLatest = index < keepLatest;
    const retainedByPublishReady = keepPublishReady && snapshot.publishHandoff.ready;
    const retain = retainedByLatest || retainedByPublishReady;
    const reason = retainedByLatest
      ? `latest-${index + 1}`
      : retainedByPublishReady
        ? "publish-ready"
        : "outside-retention-window";

    return {
      snapshotId: snapshot.id,
      checkpointId: snapshot.checkpoint.id,
      capturedAt: snapshot.capturedAt,
      publishReady: snapshot.publishHandoff.ready,
      retentionRank: index + 1,
      retain,
      reason,
    };
  });
}

export const createAppPreviewSnapshotMetadata = buildAppPreviewSnapshotMetadata;
export const createPreviewSnapshotMetadata = buildAppPreviewSnapshotMetadata;
export const comparePreviewSnapshots = compareAppPreviewSnapshots;
export const createPreviewSnapshotRollbackCommand = createAppPreviewRollbackCommand;
export const buildPreviewSnapshotRollbackResult = buildAppPreviewRollbackResult;
export const deriveAppPreviewPublishHandoffReadiness = buildAppPreviewPublishHandoffReadiness;
export const derivePreviewSnapshotPublishHandoffReadiness = buildAppPreviewPublishHandoffReadiness;
export const orderPreviewSnapshotRetention = orderAppPreviewSnapshotRetention;

function comparison(
  current: AppPreviewSnapshotMetadata,
  previous: AppPreviewSnapshotMetadata,
  relation: AppPreviewSnapshotComparisonRelation,
  changed: boolean,
  summary: string,
): AppPreviewSnapshotComparison {
  return {
    relation,
    changed,
    currentSnapshotId: current.id,
    previousSnapshotId: previous.id,
    checkpointChanged: false,
    buildStatusChanged: false,
    smokeStatusChanged: false,
    contentHashChanged: false,
    publishReadinessChanged: false,
    summary,
  };
}

function currentRegressed(current: AppPreviewSnapshotMetadata, previous: AppPreviewSnapshotMetadata): boolean {
  return (previous.publishHandoff.ready && !current.publishHandoff.ready)
    || buildRank(current.build.status) < buildRank(previous.build.status)
    || smokeRank(current.build.smokeStatus) < smokeRank(previous.build.smokeStatus);
}

function currentAdvanced(current: AppPreviewSnapshotMetadata, previous: AppPreviewSnapshotMetadata): boolean {
  return (!previous.publishHandoff.ready && current.publishHandoff.ready)
    || buildRank(current.build.status) > buildRank(previous.build.status)
    || smokeRank(current.build.smokeStatus) > smokeRank(previous.build.smokeStatus)
    || current.checkpoint.id !== previous.checkpoint.id;
}

function comparisonSummary(
  relation: AppPreviewSnapshotComparisonRelation,
  current: AppPreviewSnapshotMetadata,
  previous: AppPreviewSnapshotMetadata,
): string {
  if (relation === "advanced") {
    return `Preview snapshot advanced from checkpoint ${previous.checkpoint.id} to ${current.checkpoint.id}.`;
  }
  if (relation === "regressed") {
    return `Preview snapshot regressed from checkpoint ${previous.checkpoint.id}; rollback target ${previous.id} is available.`;
  }
  if (relation === "diverged") {
    return `Preview snapshot content changed without improving readiness from ${previous.id}.`;
  }
  return "Preview snapshot is unchanged.";
}

function compareSnapshotsForRetention(left: AppPreviewSnapshotMetadata, right: AppPreviewSnapshotMetadata): number {
  return timestampMs(right.capturedAt) - timestampMs(left.capturedAt)
    || Number(right.publishHandoff.ready) - Number(left.publishHandoff.ready)
    || left.workspaceId.localeCompare(right.workspaceId)
    || left.appId.localeCompare(right.appId)
    || left.checkpoint.id.localeCompare(right.checkpoint.id)
    || left.id.localeCompare(right.id);
}

function defaultArtifactPaths(workspaceId: string, appSlug: string, checkpointId: string): string[] {
  return [`data/generated-apps/${workspaceId}/${appSlug}/checkpoints/${checkpointId}/preview-snapshot.json`];
}

function normalizeBuildStatus(value: string | undefined): AppPreviewSnapshotBuildStatus {
  return BUILD_STATUS_ALIASES[stableStatus(value)] ?? "not_run";
}

function normalizeSmokeStatus(value: string | undefined): AppPreviewSnapshotSmokeStatus {
  return SMOKE_STATUS_ALIASES[stableStatus(value)] ?? "not_run";
}

function buildRank(status: AppPreviewSnapshotBuildStatus): number {
  const ranks: Record<AppPreviewSnapshotBuildStatus, number> = {
    not_run: 0,
    queued: 1,
    canceled: 1,
    running: 2,
    failed: 2,
    passed: 3,
  };
  return ranks[status];
}

function smokeRank(status: AppPreviewSnapshotSmokeStatus): number {
  const ranks: Record<AppPreviewSnapshotSmokeStatus, number> = {
    not_run: 0,
    pending: 1,
    fail: 1,
    warn: 2,
    pass: 3,
  };
  return ranks[status];
}

function rollbackMessage(status: AppPreviewSnapshotRollbackStatus, checkpointId: string, error: string | undefined): string {
  if (status === "succeeded") return `Rolled preview back to checkpoint ${checkpointId}.`;
  if (status === "noop") return `Preview already points at checkpoint ${checkpointId}.`;
  if (status === "failed") return `Preview rollback to checkpoint ${checkpointId} failed${error ? `: ${error}` : "."}`;
  return `Preview rollback to checkpoint ${checkpointId} is pending confirmation.`;
}

function normalizeTimestamp(value: string | undefined): string {
  const cleaned = cleanString(value);
  if (!cleaned) return DEFAULT_TIMESTAMP;
  const ms = Date.parse(cleaned);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : DEFAULT_TIMESTAMP;
}

function timestampMs(value: string): number {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function stableStatus(value: string | undefined): string {
  return cleanString(value).toLowerCase().replace(/\s+/g, "_");
}

function normalizeHash(value: string | undefined): string {
  return cleanString(value).toLowerCase().replace(/[^a-f0-9]/g, "");
}

function stableToken(value: string | undefined): string {
  return cleanString(value).toLowerCase().replace(/[^a-z0-9:_./-]+/g, "-").replace(/^-+|-+$/g, "");
}

function slugify(value?: string): string {
  return cleanString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => cleanString(value)).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function nonNegativeInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function cleanString(value: string | undefined): string {
  return String(value ?? "").trim();
}

function removeUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}
