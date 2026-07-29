import { redactSensitiveString } from "./security/redaction.js";

export type AppPublishValidationStage = "build" | "artifact" | "health" | "smoke" | "url";
export type AppPublishValidationStatus = "pending" | "ready" | "blocked";
export type AppPublishCheckStatus = "pending" | "running" | "pass" | "fail";
export type AppPublishCommandPhase = "not_run" | "queued" | "running" | "passed" | "failed";
export type AppPublishVisibility = "private" | "public";
export type AppPublishArtifactValidationKind =
  | "source"
  | "build_output"
  | "generated_bundle"
  | "manifest"
  | "config";

export interface AppPublishFailure {
  stage: AppPublishValidationStage;
  message: string;
  action: string;
}

export interface ProductionBuildValidationInput {
  phase?: AppPublishCommandPhase;
  command?: string;
  exitCode?: number;
  output?: string;
  error?: unknown;
  expectedArtifacts?: string[];
}

export interface ProductionBuildStatus {
  stage: "build";
  status: AppPublishCheckStatus;
  phase: AppPublishCommandPhase;
  command: string;
  expectedArtifacts: string[];
  message: string;
  failures: AppPublishFailure[];
}

export interface PublishArtifactObservation {
  path: string;
  kind?: AppPublishArtifactValidationKind;
  required?: boolean;
  present?: boolean;
  bytes?: number;
  source?:
    | "build"
    | "preview_snapshot"
    | "generated_draft"
    | "publish_manifest"
    | "operator"
    | "disk";
  description?: string;
}

export interface PublishArtifactValidationInput {
  expectedArtifacts?: string[];
  artifacts?: PublishArtifactObservation[];
  manifestPath?: string;
}

export interface PublishArtifactStatus {
  stage: "artifact";
  status: Exclude<AppPublishCheckStatus, "running">;
  manifestPath: string;
  expectedArtifacts: string[];
  observedArtifacts: PublishArtifactObservation[];
  missingArtifacts: string[];
  message: string;
  failures: AppPublishFailure[];
}

export interface AppPublishHttpProbeInput {
  path?: string;
  url?: string;
  statusCode?: number;
  bodyStatus?: string;
  ok?: boolean;
  error?: unknown;
}

export interface HealthCheckValidationInput {
  live?: AppPublishHttpProbeInput;
  ready?: AppPublishHttpProbeInput;
}

export interface HealthProbeStatus {
  path: string;
  url?: string;
  status: AppPublishCheckStatus;
  statusCode?: number;
  bodyStatus?: string;
  message: string;
}

export interface HealthCheckStatus {
  stage: "health";
  status: AppPublishCheckStatus;
  live: HealthProbeStatus;
  ready: HealthProbeStatus;
  message: string;
  failures: AppPublishFailure[];
}

export interface SmokeCheckObservation {
  id: string;
  label?: string;
  status: "pending" | "pass" | "fail" | "skipped";
  message?: string;
}

export interface SmokeCheckValidationInput {
  checks?: SmokeCheckObservation[];
  requiredCheckCount?: number;
}

export interface SmokeCheckStatus {
  stage: "smoke";
  status: Exclude<AppPublishCheckStatus, "running">;
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  pendingChecks: number;
  message: string;
  checks: SmokeCheckObservation[];
  failures: AppPublishFailure[];
}

export interface PublishUrlValidationInput {
  url?: string;
  baseUrl?: string;
  path?: string;
  visibility?: AppPublishVisibility;
  requireHttpsForPublic?: boolean;
}

export interface ValidatedPublishUrlResult {
  stage: "url";
  status: "pending" | "valid" | "blocked" | "invalid";
  visibility: AppPublishVisibility;
  url?: string;
  message: string;
  failures: AppPublishFailure[];
}

export interface AppPublishValidationInput {
  build?: ProductionBuildValidationInput;
  artifacts?: PublishArtifactValidationInput;
  health?: HealthCheckValidationInput;
  smoke?: SmokeCheckValidationInput;
  url?: PublishUrlValidationInput;
}

export interface AppPublishValidation {
  version: "phase-70-lane-3";
  status: AppPublishValidationStatus;
  canPublish: boolean;
  productionBuild: ProductionBuildStatus;
  artifactPresence: PublishArtifactStatus;
  healthCheck: HealthCheckStatus;
  smokeCheck: SmokeCheckStatus;
  validatedUrl: ValidatedPublishUrlResult;
  actionableFailures: AppPublishFailure[];
}

const DEFAULT_BUILD_COMMAND = "npm run build:web";
const DEFAULT_EXPECTED_ARTIFACTS = ["web/dist"];
const DEFAULT_LIVE_PATH = "/api/health/live";
const DEFAULT_READY_PATH = "/api/health/ready";

export function deriveProductionBuildStatus(
  input: ProductionBuildValidationInput = {},
): ProductionBuildStatus {
  const phase = normalizeBuildPhase(input.phase, input.exitCode);
  const command = input.command?.trim() || DEFAULT_BUILD_COMMAND;
  const expectedArtifacts = uniqueSorted(input.expectedArtifacts ?? DEFAULT_EXPECTED_ARTIFACTS);
  const detail = firstFailureDetail(input.error ?? input.output);

  if (phase === "passed") {
    return {
      stage: "build",
      status: "pass",
      phase,
      command,
      expectedArtifacts,
      message: `Production build passed with ${expectedArtifacts.join(", ")} ready for publish.`,
      failures: [],
    };
  }

  if (phase === "failed") {
    return {
      stage: "build",
      status: "fail",
      phase,
      command,
      expectedArtifacts,
      message: detail ? `Production build failed: ${detail}` : "Production build failed.",
      failures: [
        {
          stage: "build",
          message: detail
            ? `Production build failed: ${detail}`
            : "Production build did not complete successfully.",
          action: `Run \`${command}\`, fix the first build error, and retry publish validation.`,
        },
      ],
    };
  }

  if (phase === "queued" || phase === "running") {
    return {
      stage: "build",
      status: "running",
      phase,
      command,
      expectedArtifacts,
      message: phase === "queued" ? "Production build is queued." : "Production build is running.",
      failures: [],
    };
  }

  return {
    stage: "build",
    status: "pending",
    phase: "not_run",
    command,
    expectedArtifacts,
    message: "Production build has not run for this publish attempt.",
    failures: [
      {
        stage: "build",
        message: "Production build has not run.",
        action: `Run \`${command}\` before sharing a self-hosted URL.`,
      },
    ],
  };
}

export function derivePublishArtifactStatus(
  input: PublishArtifactValidationInput = {},
  build: ProductionBuildStatus = deriveProductionBuildStatus(),
): PublishArtifactStatus {
  const expectedArtifacts = uniqueSorted(input.expectedArtifacts ?? build.expectedArtifacts);
  const manifestPath = input.manifestPath?.trim() || "publish-artifacts.json";
  const observedArtifacts = uniqueArtifacts(input.artifacts ?? []);
  const observedByPath = new Map(
    observedArtifacts.map((artifact) => [normalizeArtifactPath(artifact.path), artifact]),
  );
  const requiredExpected = expectedArtifacts.map(normalizeArtifactPath).filter(Boolean);
  const missingArtifacts = requiredExpected.filter((path) => {
    const observed = observedByPath.get(path);
    return !observed || observed.present === false;
  });
  const hasGeneratedArtifact = observedArtifacts.some(
    (artifact) =>
      artifact.present !== false &&
      (artifact.kind === "generated_bundle" ||
        artifact.source === "generated_draft" ||
        artifact.source === "preview_snapshot"),
  );
  const failures: AppPublishFailure[] = [];

  if (build.status !== "pass") {
    return {
      stage: "artifact",
      status: "pending",
      manifestPath,
      expectedArtifacts,
      observedArtifacts,
      missingArtifacts: [],
      message: "Publish artifact validation is waiting on the production build.",
      failures: [],
    };
  }

  if (expectedArtifacts.length === 0) {
    failures.push({
      stage: "artifact",
      message: "No publish artifacts were declared.",
      action: "Declare the generated app bundle and publish manifest paths before publish handoff.",
    });
  }

  if (missingArtifacts.length > 0) {
    failures.push({
      stage: "artifact",
      message: `Missing required publish artifacts: ${missingArtifacts.join(", ")}.`,
      action: `Regenerate the app bundle and ${manifestPath}, then rerun publish validation.`,
    });
  }

  if (!hasGeneratedArtifact) {
    failures.push({
      stage: "artifact",
      message: "No generated app bundle artifact was observed for this publish.",
      action:
        "Run the generated app build/preview step that emits the bundle artifact before publishing.",
    });
  }

  const status: PublishArtifactStatus["status"] = failures.length > 0 ? "fail" : "pass";

  return {
    stage: "artifact",
    status,
    manifestPath,
    expectedArtifacts,
    observedArtifacts,
    missingArtifacts,
    message:
      status === "pass"
        ? `Publish artifact manifest ${manifestPath} includes ${observedArtifacts.length} observed artifact${observedArtifacts.length === 1 ? "" : "s"}.`
        : "Publish artifact validation is blocked.",
    failures,
  };
}

export function deriveHealthCheckStatus(input: HealthCheckValidationInput = {}): HealthCheckStatus {
  const live = deriveProbeStatus(input.live, DEFAULT_LIVE_PATH, "live");
  const ready = deriveProbeStatus(input.ready, DEFAULT_READY_PATH, "ready");
  const probes = [live, ready];
  const status = probes.some((probe) => probe.status === "fail")
    ? "fail"
    : probes.every((probe) => probe.status === "pass")
      ? "pass"
      : "pending";
  const failures = [
    ...probeFailures(live, "health", "Start the published app and retry the live health check."),
    ...probeFailures(
      ready,
      "health",
      "Fix readiness dependencies, then retry GET /api/health/ready.",
    ),
  ];

  return {
    stage: "health",
    status,
    live,
    ready,
    message:
      status === "pass"
        ? "Live and ready health checks passed."
        : status === "fail"
          ? "Health validation is blocked."
          : "Health validation has not completed.",
    failures,
  };
}

export function deriveSmokeCheckStatus(input: SmokeCheckValidationInput = {}): SmokeCheckStatus {
  const checks = [...(input.checks ?? [])].sort((left, right) => left.id.localeCompare(right.id));
  const requiredCheckCount = positiveInteger(input.requiredCheckCount);
  const totalChecks = checks.length;
  const passedChecks = checks.filter((check) => check.status === "pass").length;
  const failed = checks.filter((check) => check.status === "fail");
  const pendingChecks = checks.filter(
    (check) => check.status === "pending" || check.status === "skipped",
  ).length;
  const missingChecks = requiredCheckCount !== undefined && totalChecks < requiredCheckCount;
  const status =
    failed.length > 0
      ? "fail"
      : totalChecks > 0 && pendingChecks === 0 && !missingChecks
        ? "pass"
        : "pending";
  const failures = failed.map((check) => ({
    stage: "smoke" as const,
    message: `${check.label?.trim() || check.id} failed${check.message ? `: ${redactSensitiveString(check.message)}` : "."}`,
    action: "Fix the generated app route or UI assertion, then rerun smoke checks.",
  }));

  if (status === "pending") {
    failures.push({
      stage: "smoke",
      message: missingChecks
        ? `Smoke validation needs ${requiredCheckCount} checks but only ${totalChecks} were reported.`
        : "Smoke checks have not all passed.",
      action: "Run the generated app smoke suite before marking the publish URL ready.",
    });
  }

  return {
    stage: "smoke",
    status,
    totalChecks,
    passedChecks,
    failedChecks: failed.length,
    pendingChecks,
    checks,
    message:
      status === "pass"
        ? `Smoke checks passed (${passedChecks}/${totalChecks}).`
        : status === "fail"
          ? `Smoke checks failed (${failed.length}/${totalChecks}).`
          : "Smoke checks are pending.",
    failures,
  };
}

export function deriveValidatedPublishUrl(
  input: PublishUrlValidationInput = {},
  gates: AppPublishCheckStatus[] = [],
): ValidatedPublishUrlResult {
  const visibility = input.visibility ?? "private";
  const candidate = candidatePublishUrl(input);
  const requireHttpsForPublic = input.requireHttpsForPublic ?? true;

  if (!candidate) {
    return {
      stage: "url",
      status: "pending",
      visibility,
      message: "Publish URL has not been assigned.",
      failures: [
        {
          stage: "url",
          message: "Publish URL is missing.",
          action: "Provide the self-hosted base URL or generated publish URL before handoff.",
        },
      ],
    };
  }

  const parsed = parseHttpUrl(candidate);
  if (!parsed) {
    return {
      stage: "url",
      status: "invalid",
      visibility,
      url: candidate,
      message: "Publish URL must be an absolute HTTP or HTTPS URL.",
      failures: [
        {
          stage: "url",
          message: `Publish URL is invalid: ${redactSensitiveString(candidate)}`,
          action: "Use an absolute http:// or https:// URL for the self-hosted app.",
        },
      ],
    };
  }

  if (visibility === "public" && requireHttpsForPublic && parsed.protocol !== "https:") {
    return {
      stage: "url",
      status: "invalid",
      visibility,
      url: parsed.toString(),
      message: "Public publish URLs must use HTTPS.",
      failures: [
        {
          stage: "url",
          message: "Public publish URL is not HTTPS.",
          action: "Configure TLS for the public host, then validate the HTTPS URL.",
        },
      ],
    };
  }

  if (gates.some((status) => status === "fail")) {
    return {
      stage: "url",
      status: "blocked",
      visibility,
      url: parsed.toString(),
      message: "Publish URL is formed, but validation blockers remain.",
      failures: [
        {
          stage: "url",
          message: "Publish URL cannot be marked valid until build, health, and smoke checks pass.",
          action: "Resolve the validation blockers above, then rerun publish validation.",
        },
      ],
    };
  }

  if (gates.length === 0 || gates.some((status) => status === "pending" || status === "running")) {
    return {
      stage: "url",
      status: "pending",
      visibility,
      url: parsed.toString(),
      message: "Publish URL is waiting on validation checks.",
      failures: [],
    };
  }

  return {
    stage: "url",
    status: "valid",
    visibility,
    url: parsed.toString(),
    message: "Publish URL is validated for handoff.",
    failures: [],
  };
}

export function buildAppPublishValidation(
  input: AppPublishValidationInput = {},
): AppPublishValidation {
  const productionBuild = deriveProductionBuildStatus(input.build);
  const artifactPresence = derivePublishArtifactStatus(
    {
      expectedArtifacts: input.artifacts?.expectedArtifacts ?? productionBuild.expectedArtifacts,
      artifacts: input.artifacts?.artifacts,
      manifestPath: input.artifacts?.manifestPath,
    },
    productionBuild,
  );
  const healthCheck = deriveHealthCheckStatus(input.health);
  const smokeCheck = deriveSmokeCheckStatus(input.smoke);
  const validatedUrl = deriveValidatedPublishUrl(input.url, [
    productionBuild.status,
    artifactPresence.status,
    healthCheck.status,
    smokeCheck.status,
  ]);
  const actionableFailures = [
    ...productionBuild.failures,
    ...artifactPresence.failures,
    ...healthCheck.failures,
    ...smokeCheck.failures,
    ...validatedUrl.failures,
  ];
  const canPublish =
    productionBuild.status === "pass" &&
    artifactPresence.status === "pass" &&
    healthCheck.status === "pass" &&
    smokeCheck.status === "pass" &&
    validatedUrl.status === "valid";
  const status = canPublish
    ? "ready"
    : actionableFailures.length > 0 &&
        actionableFailures.some(
          (failure) => failure.stage !== "smoke" || smokeCheck.status === "fail",
        )
      ? "blocked"
      : "pending";

  return {
    version: "phase-70-lane-3",
    status,
    canPublish,
    productionBuild,
    artifactPresence,
    healthCheck,
    smokeCheck,
    validatedUrl,
    actionableFailures,
  };
}

function normalizeBuildPhase(
  phase: AppPublishCommandPhase | undefined,
  exitCode: number | undefined,
): AppPublishCommandPhase {
  if (typeof exitCode === "number") return exitCode === 0 ? "passed" : "failed";
  return phase ?? "not_run";
}

function deriveProbeStatus(
  input: AppPublishHttpProbeInput | undefined,
  defaultPath: string,
  expectedBodyStatus: string,
): HealthProbeStatus {
  const path = input?.path?.trim() || defaultPath;
  const statusCode = input?.statusCode;
  const bodyStatus = input?.bodyStatus;
  const detail = firstFailureDetail(input?.error);
  const status =
    input?.ok === false ||
    detail ||
    (typeof statusCode === "number" && (statusCode < 200 || statusCode >= 300)) ||
    (bodyStatus !== undefined && bodyStatus !== expectedBodyStatus)
      ? "fail"
      : typeof statusCode === "number" || input?.ok === true
        ? "pass"
        : "pending";

  return {
    path,
    url: input?.url,
    status,
    statusCode,
    bodyStatus,
    message: probeMessage(status, path, statusCode, bodyStatus, expectedBodyStatus, detail),
  };
}

function probeMessage(
  status: AppPublishCheckStatus,
  path: string,
  statusCode: number | undefined,
  bodyStatus: string | undefined,
  expectedBodyStatus: string,
  detail: string | undefined,
): string {
  if (status === "pass")
    return `${path} returned healthy status${statusCode ? ` ${statusCode}` : ""}.`;
  if (detail) return `${path} failed: ${detail}`;
  if (typeof statusCode === "number" && (statusCode < 200 || statusCode >= 300))
    return `${path} returned HTTP ${statusCode}.`;
  if (bodyStatus !== undefined && bodyStatus !== expectedBodyStatus)
    return `${path} returned status ${bodyStatus}; expected ${expectedBodyStatus}.`;
  return `${path} has not been checked.`;
}

function probeFailures(
  probe: HealthProbeStatus,
  stage: AppPublishValidationStage,
  action: string,
): AppPublishFailure[] {
  return probe.status === "fail" || probe.status === "pending"
    ? [{ stage, message: probe.message, action }]
    : [];
}

function candidatePublishUrl(input: PublishUrlValidationInput): string | undefined {
  if (input.url?.trim()) return input.url.trim();
  if (!input.baseUrl?.trim()) return undefined;
  const baseUrl = input.baseUrl.trim().replace(/\/+$/g, "");
  const path = normalizeUrlPath(input.path ?? "/").replace(/^\/+|\/+$/g, "");
  return path ? `${baseUrl}/${path}` : baseUrl;
}

function parseHttpUrl(value: string): URL | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeUrlPath(path: string): string {
  const trimmed = path.trim() || "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function firstFailureDetail(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = value instanceof Error ? value.message : String(value);
  return redactSensitiveString(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function uniqueArtifacts(values: PublishArtifactObservation[]): PublishArtifactObservation[] {
  const artifacts = new Map<string, PublishArtifactObservation>();
  for (const value of values) {
    const path = normalizeArtifactPath(value.path);
    if (!path) continue;
    artifacts.set(path, {
      ...value,
      path,
      present: value.present ?? true,
    });
  }
  return [...artifacts.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeArtifactPath(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/g, "");
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
}
