import { createHash } from "node:crypto";
import {
  buildAppPublishReadiness,
  type AppPublishReadinessInput,
} from "./app-publish-readiness.js";
import {
  generatedAppDockerComposeYaml,
  generatedAppPublishServiceNames,
} from "./generated-app-publish-package.js";
import type {
  GeneratedAppDockerComposeExportPayload,
  GeneratedAppPublishArtifactManifest,
  GeneratedAppPublishRecord,
  GeneratedAppPublishRollbackCommand,
  GeneratedAppPublishRollbackResult,
  GeneratedAppPublishRollbackStatus,
  GeneratedAppPublishStatus,
  GeneratedAppPublishVisibility,
} from "./packetagent-store.js";

export interface GeneratedAppPublishRecordInput extends AppPublishReadinessInput {
  workspaceId: string;
  appId: string;
  checkpointId: string;
  appName: string;
  appSlug?: string;
  workspaceSlug?: string;
  previewUrl?: string;
  buildStatus?: string;
  smokeStatus?: string;
  previousPublish?: GeneratedAppPublishRecord | null;
  artifactManifest?: GeneratedAppPublishArtifactManifest;
  createdByUserId: string;
  createdAt?: string;
}

export interface GeneratedAppPublishRuntimeRouteInput {
  appId: string;
  checkpointId?: string;
}

export interface GeneratedAppPublishRollbackCommandInput {
  current: GeneratedAppPublishRecord;
  target: GeneratedAppPublishRecord;
  requestedByUserId?: string;
  reason?: string;
}

export interface GeneratedAppPublishRollbackResultInput {
  command: GeneratedAppPublishRollbackCommand;
  status?: GeneratedAppPublishRollbackStatus;
  completedAt?: string;
  error?: string;
}

const DEFAULT_TIMESTAMP = "1970-01-01T00:00:00.000Z";

export function buildGeneratedAppPublishRecord(
  input: GeneratedAppPublishRecordInput,
): GeneratedAppPublishRecord {
  const createdAt = normalizeTimestamp(input.createdAt);
  const readiness = buildAppPublishReadiness({
    ...input,
    appName: input.appName,
    draftId: input.appSlug ?? input.appId,
    workspaceSlug: input.workspaceSlug ?? input.workspaceId,
  });
  const versionLabel = `publish-${createdAt.slice(0, 10)}-${stableHash(
    [
      input.workspaceId,
      input.appId,
      input.checkpointId,
      readiness.localPublishPath,
      createdAt,
    ].join(":"),
  ).slice(0, 8)}`;
  const id = `gapp_publish_${stableHash(
    [input.workspaceId, input.appId, input.checkpointId, versionLabel].join(":"),
  ).slice(0, 16)}`;
  const dockerComposeExport = buildDockerComposeExport({
    appSlug: readiness.draftSlug,
    workspaceSlug: readiness.workspaceSlug,
    localPublishPath: readiness.localPublishPath,
    publicUrl: readiness.urlHandoff.publicUrl,
    privateUrl: readiness.urlHandoff.privateUrl,
    manifestPath: `${readiness.localPublishPath}/${readiness.publishArtifactManifest.fileName}`,
    bundlePath: `${readiness.localPublishPath}/bundle`,
  });
  const artifactManifest = input.artifactManifest ?? readiness.publishArtifactManifest;
  const artifactPaths = uniqueSorted([
    ...artifactManifest.entries.map((entry) => entry.path),
    `${readiness.localPublishPath}/${dockerComposeExport.fileName}`,
  ]);
  const status: GeneratedAppPublishStatus = publishReady(input.buildStatus, input.smokeStatus)
    ? "published"
    : "failed";
  const publish: GeneratedAppPublishRecord = removeUndefined({
    id,
    appId: input.appId,
    workspaceId: input.workspaceId,
    checkpointId: input.checkpointId,
    status,
    visibility: readiness.urlHandoff.visibility,
    versionLabel,
    localPublishPath: readiness.localPublishPath,
    workspacePath: readiness.localPublishPath,
    publicUrl: dockerComposeExport.environment.PACKETAGENT_PUBLIC_APP_BASE_URL,
    privateUrl: dockerComposeExport.environment.PACKETAGENT_PRIVATE_APP_BASE_URL,
    previewUrl: cleanString(input.previewUrl) || undefined,
    buildStatus: cleanString(input.buildStatus) || undefined,
    smokeStatus: cleanString(input.smokeStatus) || undefined,
    dockerComposeExport,
    artifactManifest,
    manifest: artifactManifest,
    artifactPaths,
    logs: publishLogs({
      createdAt,
      visibility: readiness.urlHandoff.visibility,
      localPublishPath: readiness.localPublishPath,
      dockerComposeFileName: dockerComposeExport.fileName,
      manifestPath: dockerComposeExport.manifestPath,
      bundlePath: dockerComposeExport.bundlePath,
      buildStatus: input.buildStatus,
      smokeStatus: input.smokeStatus,
      previousPublishId: input.previousPublish?.id,
    }),
    previousPublishId: input.previousPublish?.id,
    createdByUserId: input.createdByUserId,
    createdAt,
    completedAt: createdAt,
  });

  if (input.previousPublish) {
    publish.rollbackCommand = createGeneratedAppPublishRollbackCommand({
      current: publish,
      target: input.previousPublish,
      requestedByUserId: input.createdByUserId,
      reason: "Rollback to previous publish",
    });
  }

  return publish;
}

export function generatedAppPublishRuntimePath(
  input: GeneratedAppPublishRuntimeRouteInput,
): string {
  const checkpointId = cleanString(input.checkpointId);
  const path = `/api/app/generated-apps/${encodeURIComponent(cleanString(input.appId) || "generated-app")}/preview`;
  return checkpointId ? `${path}?checkpointId=${encodeURIComponent(checkpointId)}` : path;
}

export function generatedAppPublishUrlForBase(
  url: string,
  input: GeneratedAppPublishRuntimeRouteInput,
): string {
  const parsed = parseUrl(url);
  if (!parsed || !isPacketAgentRuntimeHost(parsed)) return url;
  parsed.pathname = generatedAppPublishRuntimePath(input).split("?")[0];
  parsed.search = cleanString(input.checkpointId)
    ? `?checkpointId=${encodeURIComponent(cleanString(input.checkpointId))}`
    : "";
  parsed.hash = "";
  return parsed.toString();
}

export function buildDockerComposeExport(input: {
  appSlug: string;
  workspaceSlug: string;
  localPublishPath: string;
  publicUrl: string;
  privateUrl: string;
  manifestPath?: string;
  bundlePath?: string;
}): GeneratedAppDockerComposeExportPayload {
  const manifestPath = normalizePath(
    input.manifestPath || `${input.localPublishPath}/publish-artifacts.json`,
  );
  const bundlePath = normalizePath(input.bundlePath || `${input.localPublishPath}/bundle`);
  const environment = {
    NODE_ENV: "production",
    PORT: "8080",
    PACKETAGENT_PUBLIC_APP_BASE_URL: input.publicUrl,
    PACKETAGENT_PRIVATE_APP_BASE_URL: input.privateUrl,
  };
  const instructions = [
    `Open the standalone generated app package at ${input.localPublishPath}.`,
    `Verify the sealed source and runtime package with ${manifestPath}.`,
    "Run docker compose -f docker-compose.publish.yml config --quiet.",
    "Run docker compose -f docker-compose.publish.yml up --build --wait --wait-timeout 180.",
    "Probe /health/live, /health/ready, the app root, and generated CRUD before handoff.",
    "Run docker compose -f docker-compose.publish.yml down --remove-orphans when finished.",
  ];

  return {
    fileName: "docker-compose.publish.yml",
    format: "docker-compose",
    version: "compose-spec",
    services: generatedAppPublishServiceNames(),
    environment,
    volumes: ["generated-app-data:/app/data"],
    bundlePath,
    manifestPath,
    instructions,
    yaml: generatedAppDockerComposeYaml(),
  };
}

export function createGeneratedAppPublishRollbackCommand(
  input: GeneratedAppPublishRollbackCommandInput,
): GeneratedAppPublishRollbackCommand {
  const commandId = `publish_rollback_${stableHash(
    [input.current.id, input.target.id, input.requestedByUserId ?? "", input.reason ?? ""].join(
      ":",
    ),
  ).slice(0, 16)}`;
  const command = [
    "packetagent publish rollback",
    `--workspace=${input.current.workspaceId}`,
    `--app=${input.current.appId}`,
    `--from-publish=${input.current.id}`,
    `--to-publish=${input.target.id}`,
  ].join(" ");

  return removeUndefined({
    kind: "generated-app-publish-rollback" as const,
    commandId,
    command,
    workspaceId: input.current.workspaceId,
    appId: input.current.appId,
    fromPublishId: input.current.id,
    toPublishId: input.target.id,
    fromLocalPublishPath: input.current.localPublishPath,
    toLocalPublishPath: input.target.localPublishPath,
    requestedByUserId: cleanString(input.requestedByUserId) || undefined,
    reason: cleanString(input.reason) || undefined,
    requiresConfirmation: true as const,
    expectedResult: removeUndefined({
      status: "pending" as const,
      restoredPublishId: input.target.id,
      supersededPublishId: input.current.id,
      localPublishPath: input.target.localPublishPath,
      publicUrl: input.target.publicUrl,
      privateUrl: input.target.privateUrl,
    }),
  });
}

export function buildGeneratedAppPublishRollbackResult(
  input: GeneratedAppPublishRollbackResultInput,
): GeneratedAppPublishRollbackResult {
  const status = input.status ?? "pending";
  const rolledBack = status === "succeeded" || status === "noop";
  const error = cleanString(input.error) || undefined;

  return removeUndefined({
    kind: "generated-app-publish-rollback-result" as const,
    commandId: input.command.commandId,
    status,
    rolledBack,
    restoredPublishId: input.command.toPublishId,
    supersededPublishId: input.command.fromPublishId,
    completedAt: normalizeTimestamp(input.completedAt),
    localPublishPath: input.command.toLocalPublishPath,
    publicUrl: input.command.expectedResult.publicUrl,
    privateUrl: input.command.expectedResult.privateUrl,
    message: rollbackMessage(status, input.command.toPublishId, error),
    error,
  });
}

export function orderGeneratedAppPublishHistory(
  history: GeneratedAppPublishRecord[],
): GeneratedAppPublishRecord[] {
  return [...history].sort((left, right) => {
    return (
      timestampMs(right.createdAt) - timestampMs(left.createdAt) || left.id.localeCompare(right.id)
    );
  });
}

function publishReady(buildStatus: string | undefined, smokeStatus: string | undefined): boolean {
  return stableStatus(buildStatus) === "passed" && stableStatus(smokeStatus) === "pass";
}

function publishLogs(input: {
  createdAt: string;
  visibility: GeneratedAppPublishVisibility;
  localPublishPath: string;
  dockerComposeFileName: string;
  manifestPath: string;
  bundlePath: string;
  buildStatus?: string;
  smokeStatus?: string;
  previousPublishId?: string;
}): GeneratedAppPublishRecord["logs"] {
  const ready = publishReady(input.buildStatus, input.smokeStatus);
  return [
    {
      at: input.createdAt,
      level: ready ? "info" : "error",
      message: ready
        ? `Preview build ${input.buildStatus} and smoke ${input.smokeStatus}; local publish can proceed.`
        : `Publish blocked by build ${input.buildStatus ?? "not_run"} and smoke ${input.smokeStatus ?? "not_run"}.`,
    },
    {
      at: input.createdAt,
      level: "info",
      message: `Prepared ${input.dockerComposeFileName} for ${input.visibility} self-hosted handoff using bundle ${input.bundlePath}.`,
    },
    {
      at: input.createdAt,
      level: "info",
      message: `Published artifact manifest ${input.manifestPath} to ${input.localPublishPath}.`,
    },
    ...(input.previousPublishId
      ? [
          {
            at: input.createdAt,
            level: "info" as const,
            message: `Previous publish ${input.previousPublishId} retained as rollback target.`,
          },
        ]
      : []),
  ];
}

function rollbackMessage(
  status: GeneratedAppPublishRollbackStatus,
  publishId: string,
  error: string | undefined,
): string {
  if (status === "succeeded") return `Rolled publish target back to ${publishId}.`;
  if (status === "noop") return `Publish target already points at ${publishId}.`;
  if (status === "failed")
    return `Publish rollback to ${publishId} failed${error ? `: ${error}` : "."}`;
  return `Publish rollback to ${publishId} is pending confirmation.`;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => cleanString(value)).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function stableStatus(value: string | undefined): string {
  return cleanString(value).toLowerCase().replace(/\s+/g, "_");
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isPacketAgentRuntimeHost(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  );
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/g, "") || ".";
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

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function cleanString(value: string | undefined): string {
  return String(value ?? "").trim();
}

function removeUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}
