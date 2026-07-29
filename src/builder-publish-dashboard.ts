import { orderGeneratedAppPublishHistory } from "./app-publish-history.js";
import {
  buildAppPublishReadiness,
  type AppPublishReadiness,
  type AppPublishReadinessInput,
} from "./app-publish-readiness.js";
import {
  buildAppPublishValidation,
  type AppPublishCheckStatus,
  type AppPublishValidation,
  type AppPublishValidationInput,
} from "./app-publish-service.js";
import { redactSensitiveString } from "./security/redaction.js";
import type {
  GeneratedAppPublishLogEntry,
  GeneratedAppPublishRecord,
} from "./packetagent-store.js";

export type BuilderPublishDashboardStatus = "ready" | "blocked" | "pending";
export type BuilderPublishDashboardActionKind =
  | "configure_env"
  | "configure_integrations"
  | "run_build"
  | "run_health"
  | "run_smoke"
  | "validate_url"
  | "publish"
  | "rollback";

export interface BuilderPublishDashboardInput extends AppPublishReadinessInput {
  previewUrl?: string;
  validation?: AppPublishValidationInput;
  publishHistory?: GeneratedAppPublishRecord[];
  currentPublishId?: string;
  maxLogEntries?: number;
}

export interface BuilderPublishDashboardUrl {
  label: "preview" | "production";
  url: string;
  visibility: "private" | "public";
  status: "available" | "pending" | "blocked";
  description: string;
}

export interface BuilderPublishEnvironmentStatus {
  status: BuilderPublishDashboardStatus;
  configuredRequired: number;
  totalRequired: number;
  missingRequired: string[];
  optionalConfigured: number;
  totalOptional: number;
}

export interface BuilderPublishIntegrationSummary {
  status: AppPublishReadiness["publishIntegrations"]["status"];
  canPublish: boolean;
  canUseAllRequestedIntegrations: boolean;
  ready: number;
  blocked: number;
  warnings: number;
  notRequired: number;
  featureBlockers: string[];
}

export interface BuilderPublishLogLine {
  at: string;
  level: GeneratedAppPublishLogEntry["level"];
  publishId: string;
  message: string;
}

export interface BuilderPublishRollbackDashboard {
  available: boolean;
  targetPublishId: string | null;
  command: string | null;
  message: string;
}

export interface BuilderPublishNextAction {
  id: string;
  kind: BuilderPublishDashboardActionKind;
  label: string;
  required: boolean;
  blocked: boolean;
  detail: string;
}

export interface BuilderPublishDashboard {
  version: "phase-72-lane-5";
  status: BuilderPublishDashboardStatus;
  canPublishProduction: boolean;
  readiness: AppPublishReadiness;
  validation: AppPublishValidation;
  urls: {
    preview: BuilderPublishDashboardUrl;
    production: BuilderPublishDashboardUrl;
  };
  environmentStatus: BuilderPublishEnvironmentStatus;
  integrationReadiness: AppPublishReadiness["publishIntegrations"];
  integrationSummary: BuilderPublishIntegrationSummary;
  publishHistory: GeneratedAppPublishRecord[];
  currentPublish: GeneratedAppPublishRecord | null;
  rollback: BuilderPublishRollbackDashboard;
  logs: BuilderPublishLogLine[];
  nextActions: BuilderPublishNextAction[];
}

const DEFAULT_PREVIEW_URL = "/builder/preview/workspace/generated-app";
const DEFAULT_MAX_LOG_ENTRIES = 8;

export function buildBuilderPublishDashboard(
  input: BuilderPublishDashboardInput = {},
): BuilderPublishDashboard {
  const readiness = buildAppPublishReadiness(input);
  const validation = buildAppPublishValidation({
    ...input.validation,
    url: {
      url:
        readiness.urlHandoff.visibility === "public"
          ? readiness.urlHandoff.publicUrl
          : readiness.urlHandoff.privateUrl,
      visibility: readiness.urlHandoff.visibility,
      ...input.validation?.url,
    },
  });
  const publishHistory = orderGeneratedAppPublishHistory(input.publishHistory ?? []);
  const currentPublish = selectCurrentPublish(publishHistory, input.currentPublishId);
  const rollback = buildRollbackDashboard(readiness, currentPublish, publishHistory);
  const environmentStatus = buildEnvironmentStatus(readiness);
  const integrationSummary = buildIntegrationSummary(readiness);
  const urls = {
    preview: buildPreviewUrl(input.previewUrl, readiness),
    production: buildProductionUrl(readiness, validation),
  };
  const logs = buildLogs(
    publishHistory,
    positiveInteger(input.maxLogEntries) ?? DEFAULT_MAX_LOG_ENTRIES,
  );
  const nextActions = buildNextActions({
    readiness,
    validation,
    environmentStatus,
    integrationSummary,
    rollback,
  });
  const canPublishProduction =
    validation.canPublish &&
    environmentStatus.status !== "blocked" &&
    readiness.publishIntegrations.canPublish &&
    readiness.publishIntegrations.canUseAllRequestedIntegrations;
  const status: BuilderPublishDashboardStatus = canPublishProduction
    ? "ready"
    : nextActions.some((action) => action.blocked)
      ? "blocked"
      : "pending";

  return {
    version: "phase-72-lane-5",
    status,
    canPublishProduction,
    readiness,
    validation,
    urls,
    environmentStatus,
    integrationReadiness: readiness.publishIntegrations,
    integrationSummary,
    publishHistory,
    currentPublish,
    rollback,
    logs,
    nextActions,
  };
}

function buildPreviewUrl(
  previewUrl: string | undefined,
  readiness: AppPublishReadiness,
): BuilderPublishDashboardUrl {
  return {
    label: "preview",
    url:
      cleanString(previewUrl) ||
      `/builder/preview/${readiness.workspaceSlug}/${readiness.draftSlug}` ||
      DEFAULT_PREVIEW_URL,
    visibility: "private",
    status: "available",
    description: "Builder preview URL for draft review before production publish.",
  };
}

function buildProductionUrl(
  readiness: AppPublishReadiness,
  validation: AppPublishValidation,
): BuilderPublishDashboardUrl {
  const url =
    readiness.urlHandoff.visibility === "public"
      ? readiness.urlHandoff.publicUrl
      : readiness.urlHandoff.privateUrl;

  return {
    label: "production",
    url,
    visibility: readiness.urlHandoff.visibility,
    status:
      validation.validatedUrl.status === "valid"
        ? "available"
        : validation.validatedUrl.status === "blocked" ||
            validation.validatedUrl.status === "invalid"
          ? "blocked"
          : "pending",
    description:
      readiness.urlHandoff.visibility === "public"
        ? "Public production URL after build, health, and smoke gates pass."
        : "Private production URL for operator validation before public handoff.",
  };
}

function buildEnvironmentStatus(readiness: AppPublishReadiness): BuilderPublishEnvironmentStatus {
  const required = readiness.envChecklist.filter((item) => item.required);
  const optional = readiness.envChecklist.filter((item) => !item.required);
  const missingRequired = required
    .filter((item) => item.configured === false)
    .map((item) => item.name)
    .sort((left, right) => left.localeCompare(right));

  return {
    status:
      missingRequired.length > 0
        ? "blocked"
        : required.some((item) => item.configured === null)
          ? "pending"
          : "ready",
    configuredRequired: required.filter((item) => item.configured === true).length,
    totalRequired: required.length,
    missingRequired,
    optionalConfigured: optional.filter((item) => item.configured === true).length,
    totalOptional: optional.length,
  };
}

function buildIntegrationSummary(readiness: AppPublishReadiness): BuilderPublishIntegrationSummary {
  const connectors = readiness.publishIntegrations.connectorReadiness;

  return {
    status: readiness.publishIntegrations.status,
    canPublish: readiness.publishIntegrations.canPublish,
    canUseAllRequestedIntegrations: readiness.publishIntegrations.canUseAllRequestedIntegrations,
    ready: connectors.filter((connector) => connector.status === "ready").length,
    blocked: connectors.filter((connector) => connector.status === "blocked").length,
    warnings: connectors.filter((connector) => connector.status === "warning").length,
    notRequired: connectors.filter((connector) => connector.status === "not_required").length,
    featureBlockers: readiness.publishIntegrations.featureBlockers,
  };
}

function selectCurrentPublish(
  publishHistory: GeneratedAppPublishRecord[],
  currentPublishId: string | undefined,
): GeneratedAppPublishRecord | null {
  const requested = cleanString(currentPublishId);
  if (requested) return publishHistory.find((publish) => publish.id === requested) ?? null;
  return (
    publishHistory.find((publish) => publish.status === "published") ?? publishHistory[0] ?? null
  );
}

function buildRollbackDashboard(
  readiness: AppPublishReadiness,
  currentPublish: GeneratedAppPublishRecord | null,
  publishHistory: GeneratedAppPublishRecord[],
): BuilderPublishRollbackDashboard {
  const explicitCommand = currentPublish?.rollbackCommand;
  const target = explicitCommand
    ? (publishHistory.find((publish) => publish.id === explicitCommand.toPublishId) ?? null)
    : findRollbackTarget(currentPublish, publishHistory);
  const targetPublishId =
    explicitCommand?.toPublishId ?? target?.id ?? readiness.publishHistory.previousPublishId;
  const command =
    explicitCommand?.command ??
    (targetPublishId
      ? readiness.rollback.command.replace(/ --to .+$/, ` --to ${targetPublishId}`)
      : null);

  return {
    available: Boolean(targetPublishId),
    targetPublishId: targetPublishId ?? null,
    command,
    message: targetPublishId
      ? `Rollback can repoint hosting to ${targetPublishId}.`
      : "Rollback target is not available; keep production private until a known-good publish exists.",
  };
}

function findRollbackTarget(
  currentPublish: GeneratedAppPublishRecord | null,
  publishHistory: GeneratedAppPublishRecord[],
): GeneratedAppPublishRecord | null {
  return (
    publishHistory.find(
      (publish) => publish.id !== currentPublish?.id && publish.status === "published",
    ) ?? null
  );
}

function buildLogs(
  publishHistory: GeneratedAppPublishRecord[],
  maxLogEntries: number,
): BuilderPublishLogLine[] {
  return publishHistory
    .flatMap((publish) =>
      publish.logs.map((log) => ({
        at: normalizeTimestamp(log.at),
        level: log.level,
        publishId: publish.id,
        message: redactSensitiveString(log.message),
      })),
    )
    .sort(
      (left, right) =>
        timestampMs(right.at) - timestampMs(left.at) ||
        left.publishId.localeCompare(right.publishId) ||
        left.message.localeCompare(right.message),
    )
    .slice(0, maxLogEntries);
}

function buildNextActions(input: {
  readiness: AppPublishReadiness;
  validation: AppPublishValidation;
  environmentStatus: BuilderPublishEnvironmentStatus;
  integrationSummary: BuilderPublishIntegrationSummary;
  rollback: BuilderPublishRollbackDashboard;
}): BuilderPublishNextAction[] {
  const actions: BuilderPublishNextAction[] = [];

  if (input.environmentStatus.status !== "ready") {
    actions.push({
      id: "configure-env",
      kind: "configure_env",
      label: "Review publish environment",
      required: true,
      blocked: input.environmentStatus.status === "blocked",
      detail:
        input.environmentStatus.missingRequired.length > 0
          ? `Configure required env keys: ${input.environmentStatus.missingRequired.join(", ")}.`
          : "Confirm required env keys are configured in the runtime environment.",
    });
  }

  if (
    !input.integrationSummary.canUseAllRequestedIntegrations ||
    input.integrationSummary.warnings > 0
  ) {
    actions.push({
      id: "configure-integrations",
      kind: "configure_integrations",
      label: "Review integration readiness",
      required: true,
      blocked: !input.integrationSummary.canUseAllRequestedIntegrations,
      detail:
        input.integrationSummary.featureBlockers.length > 0
          ? input.integrationSummary.featureBlockers.join(" ")
          : "Resolve connector warnings before public handoff.",
    });
  }

  actions.push(...validationActions(input.validation));

  if (input.validation.canPublish && input.environmentStatus.status !== "blocked") {
    actions.push({
      id: "publish-production",
      kind: "publish",
      label: "Publish production URL",
      required: true,
      blocked: false,
      detail: `Promote ${input.readiness.urlHandoff.visibility} URL ${input.readiness.urlHandoff.visibility === "public" ? input.readiness.urlHandoff.publicUrl : input.readiness.urlHandoff.privateUrl}.`,
    });
  }

  if (input.rollback.available) {
    actions.push({
      id: "rollback-ready",
      kind: "rollback",
      label: "Keep rollback ready",
      required: false,
      blocked: false,
      detail: input.rollback.command ?? input.rollback.message,
    });
  }

  return actions.sort(
    (left, right) =>
      Number(right.blocked) - Number(left.blocked) ||
      Number(right.required) - Number(left.required) ||
      actionOrder(left.kind) - actionOrder(right.kind) ||
      left.id.localeCompare(right.id),
  );
}

function validationActions(validation: AppPublishValidation): BuilderPublishNextAction[] {
  return [
    ...statusAction(
      "run-build",
      "run_build",
      "Run production build",
      validation.productionBuild.status,
      validation.productionBuild.message,
    ),
    ...statusAction(
      "run-health",
      "run_health",
      "Run health checks",
      validation.healthCheck.status,
      validation.healthCheck.message,
    ),
    ...statusAction(
      "run-smoke",
      "run_smoke",
      "Run smoke checks",
      validation.smokeCheck.status,
      validation.smokeCheck.message,
    ),
    ...(validation.validatedUrl.status === "valid"
      ? []
      : [
          {
            id: "validate-url",
            kind: "validate_url" as const,
            label: "Validate production URL",
            required: true,
            blocked:
              validation.validatedUrl.status === "blocked" ||
              validation.validatedUrl.status === "invalid",
            detail: validation.validatedUrl.message,
          },
        ]),
  ];
}

function statusAction(
  id: string,
  kind: BuilderPublishDashboardActionKind,
  label: string,
  status: AppPublishCheckStatus,
  detail: string,
): BuilderPublishNextAction[] {
  if (status === "pass") return [];

  return [
    {
      id,
      kind,
      label,
      required: true,
      blocked: status === "fail",
      detail,
    },
  ];
}

function actionOrder(kind: BuilderPublishDashboardActionKind): number {
  return [
    "configure_env",
    "configure_integrations",
    "run_build",
    "run_health",
    "run_smoke",
    "validate_url",
    "publish",
    "rollback",
  ].indexOf(kind);
}

function cleanString(value: string | undefined): string {
  return String(value ?? "").trim();
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function normalizeTimestamp(value: string): string {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "1970-01-01T00:00:00.000Z";
}

function timestampMs(value: string): number {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}
