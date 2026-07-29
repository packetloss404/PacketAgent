import {
  inspectAppPublishIntegrations,
  type AppPublishIntegrationsInput,
  type AppPublishIntegrationsReadiness,
} from "./app-publish-integrations.js";

export type AppPublishVisibility = "private" | "public";
export type AppPublishBundleKind = "app" | "agent" | "app_agent";
export type AppPublishArtifactKind =
  | "source"
  | "build_output"
  | "generated_bundle"
  | "manifest"
  | "config";
export type AppPublishCheckKind = "health" | "smoke";

export interface AppPublishReadinessInput extends AppPublishIntegrationsInput {
  draftId?: string;
  appName?: string;
  agentName?: string;
  workspaceSlug?: string;
  publishId?: string;
  previousPublishId?: string;
  visibility?: AppPublishVisibility;
  bundleKind?: AppPublishBundleKind;
  localPublishRoot?: string;
  publicBaseUrl?: string;
  privateBaseUrl?: string;
  requiredEnv?: string[];
  optionalEnv?: string[];
  runtimeEnv?: Record<string, string | undefined>;
  runtimeAssumptions?: string[];
  packageVersion?: string;
}

export interface AppPublishEnvChecklistItem {
  name: string;
  required: boolean;
  purpose: string;
  source: "runtime" | "bundle" | "operator";
  configured: boolean | null;
}

export interface AppPublishBuildCommand {
  id: string;
  command: string;
  required: boolean;
  produces: string[];
  description: string;
}

export interface AppPublishGeneratedCheck {
  id: string;
  kind: AppPublishCheckKind;
  label: string;
  path: string;
  command: string;
  expectedStatus: number;
  expected: string[];
  failureAction: string;
}

export interface AppPublishArtifactManifestEntry {
  path: string;
  kind: AppPublishArtifactKind;
  required: boolean;
  description: string;
  mediaType?: string;
  size?: number;
  sha256?: string;
}

export interface AppPublishArtifactManifest {
  fileName: "publish-artifacts.json";
  packageId: string;
  entries: AppPublishArtifactManifestEntry[];
  schemaVersion?: "packetagent.generated-app-artifact-manifest/v2";
  generatedAt?: string;
  subject?: {
    workspaceId: string;
    appId: string;
    checkpointId: string;
  };
  staticAssets?: {
    status: "pass" | "fail";
    entrypoint: string;
    references: Array<{
      sourcePath: string;
      targetPath: string;
      attribute: "src" | "href" | "poster" | "srcset" | "css-url";
    }>;
    issues: Array<{ code: string; path: string; message: string }>;
  };
  integrity?: {
    canonicalization: "packetagent.generated-app-artifact-manifest-canonical-json/v1";
    algorithm: "sha256";
    digest: string;
    signature?: {
      algorithm: "hmac-sha256";
      keyId: string;
      value: string;
    };
  };
}

export interface AppPublishChecklistItem {
  id: string;
  label: string;
  required: boolean;
  expectation: string;
  failureGuidance: string;
}

export interface AppPublishRuntimeAssumption {
  id: string;
  summary: string;
  detail: string;
}

export interface AppPublishRuntimeConfig {
  runtime: "hono-vite";
  nodeVersion: ">=22.5.0";
  workingDirectory: ".";
  startCommand: "npm run start";
  portEnv: "PORT";
  storeEnv: "PACKETAGENT_STORE";
  publishRootEnv: "PACKETAGENT_PUBLISH_ROOT";
  publicBaseUrlEnv: "PACKETAGENT_PUBLIC_APP_BASE_URL";
  privateBaseUrlEnv: "PACKETAGENT_PRIVATE_APP_BASE_URL";
  healthBasePath: "/api/health";
  appRouteBase: string;
  agentRouteBase: string | null;
  generatedBundlePath: string;
  envFileName: ".env.publish";
}

export interface AppPublishDockerComposeService {
  name: string;
  imageHint: string;
  buildContext?: string;
  ports?: string[];
  envFile?: string;
  environment?: Record<string, string>;
  volumes?: string[];
  dependsOn?: string[];
  healthcheck?: {
    test: string;
    interval: "10s";
    timeout: "5s";
    retries: 6;
  };
}

export interface AppPublishDockerComposeExport {
  fileName: "docker-compose.publish.yml";
  projectName: string;
  services: AppPublishDockerComposeService[];
  networks: string[];
  volumes: string[];
  outline: string[];
}

export interface AppPublishRollbackPlan {
  strategy: "previous_publish_pointer";
  previousPointerPath: string;
  command: string;
  note: string;
}

export interface AppPublishHistorySemantics {
  currentPublishId: string;
  previousPublishId: string | null;
  retention: string;
  semantics: string[];
}

export interface AppPublishRollbackSemantics {
  command: string;
  restores: string[];
  failureGuidance: string[];
}

export interface AppPublishPackageContract {
  version: "phase-71-lane-5";
  packageId: string;
  packageName: string;
  packageVersion: string;
  bundleKind: AppPublishBundleKind;
  runtimeConfig: AppPublishRuntimeConfig;
  buildCommands: AppPublishBuildCommand[];
  envChecklist: AppPublishEnvChecklistItem[];
  healthChecks: AppPublishGeneratedCheck[];
  smokeChecks: AppPublishGeneratedCheck[];
  artifactManifest: AppPublishArtifactManifest;
  dockerComposeExport: AppPublishDockerComposeExport;
  rollback: AppPublishRollbackPlan;
}

export interface AppPublishReadiness {
  version: "phase-71-lane-5";
  draftSlug: string;
  agentSlug: string | null;
  workspaceSlug: string;
  publishId: string;
  localPublishPath: string;
  runtimeAssumptions: AppPublishRuntimeAssumption[];
  publishChecklist: AppPublishChecklistItem[];
  packageContract: AppPublishPackageContract;
  packaging: {
    runtime: "hono-vite";
    notes: string[];
    buildCommands: string[];
    artifactPaths: string[];
  };
  runtimeConfig: AppPublishRuntimeConfig;
  envChecklist: AppPublishEnvChecklistItem[];
  publishIntegrations: AppPublishIntegrationsReadiness;
  publishArtifactManifest: AppPublishArtifactManifest;
  dockerComposeExport: AppPublishDockerComposeExport;
  healthCheck: {
    livePath: "/api/health/live";
    readyPath: "/api/health/ready";
    command: string;
  };
  smokeCheck: {
    command: string;
    expected: string[];
  };
  publishHistory: AppPublishHistorySemantics;
  rollback: AppPublishRollbackSemantics;
  rollbackNote: string;
  urlHandoff: {
    visibility: AppPublishVisibility;
    publicUrl: string;
    privateUrl: string;
    notes: string[];
  };
}

const DEFAULT_LOCAL_PUBLISH_ROOT = "data/published-apps";
const DEFAULT_WORKSPACE_SLUG = "workspace";
const DEFAULT_DRAFT_SLUG = "generated-app";
const DEFAULT_AGENT_SLUG = "generated-agent";
const DEFAULT_PUBLIC_BASE_URL = "https://apps.packetagent.example";
const DEFAULT_PRIVATE_BASE_URL = "http://localhost:8484";
const DEFAULT_PACKAGE_VERSION = "0.1.0";

const BASE_REQUIRED_ENV = ["NODE_ENV", "PORT", "PACKETAGENT_PUBLISH_ROOT", "PACKETAGENT_STORE"];

const BASE_OPTIONAL_ENV = [
  "PACKETAGENT_ACCESS_LOG_MODE",
  "PACKETAGENT_PRIVATE_APP_BASE_URL",
  "PACKETAGENT_PUBLIC_APP_BASE_URL",
  "PACKETAGENT_SCHEDULER_LEADER_MODE",
];

const AGENT_REQUIRED_ENV = ["PACKETAGENT_AGENT_BUNDLE_PATH"];

const AGENT_OPTIONAL_ENV = ["PACKETAGENT_AGENT_RUN_TIMEOUT_MS", "PACKETAGENT_AGENT_TOOL_ALLOWLIST"];

const ENV_PURPOSES: Record<string, string> = {
  NODE_ENV: "Set to production for hosted app and agent bundles.",
  PORT: "Port exposed by the Hono server.",
  PACKETAGENT_PUBLISH_ROOT: "Root directory containing generated publish bundles.",
  PACKETAGENT_STORE: "Selects the runtime store posture for the API.",
  PACKETAGENT_ACCESS_LOG_MODE: "Controls hosted request logging.",
  PACKETAGENT_AGENT_BUNDLE_PATH: "Filesystem path for generated agent bundle metadata and prompts.",
  PACKETAGENT_AGENT_RUN_TIMEOUT_MS: "Caps generated agent execution time during smoke checks.",
  PACKETAGENT_AGENT_TOOL_ALLOWLIST: "Restricts tools exposed to generated agent bundles.",
  PACKETAGENT_PRIVATE_APP_BASE_URL: "Internal operator URL used for admin smoke checks.",
  PACKETAGENT_PUBLIC_APP_BASE_URL: "External URL handed to public users after publish.",
  PACKETAGENT_SCHEDULER_LEADER_MODE:
    "Coordinates background work when more than one app instance runs.",
};

export function buildAppPublishReadiness(
  input: AppPublishReadinessInput = {},
): AppPublishReadiness {
  const workspaceSlug = slugify(input.workspaceSlug) || DEFAULT_WORKSPACE_SLUG;
  const draftSlug = slugify(input.appName || input.draftId) || DEFAULT_DRAFT_SLUG;
  const bundleKind = input.bundleKind ?? "app";
  const agentSlug = includesAgent(bundleKind)
    ? slugify(input.agentName || input.draftId) || DEFAULT_AGENT_SLUG
    : null;
  const localPublishRoot = normalizePath(input.localPublishRoot || DEFAULT_LOCAL_PUBLISH_ROOT);
  const localPublishPath = joinMetadataPath(localPublishRoot, workspaceSlug, draftSlug);
  const packageVersion = cleanString(input.packageVersion) || DEFAULT_PACKAGE_VERSION;
  const packageName = `${workspaceSlug}-${draftSlug}`;
  const packageId = `${workspaceSlug}/${draftSlug}/${bundleKind}`;
  const publishId =
    slugify(input.publishId) || `${workspaceSlug}-${draftSlug}-${bundleKind}-publish`;
  const previousPublishId = slugify(input.previousPublishId) || null;
  const publicUrl = joinUrl(
    input.publicBaseUrl || DEFAULT_PUBLIC_BASE_URL,
    workspaceSlug,
    draftSlug,
  );
  const privateUrl = joinUrl(
    input.privateBaseUrl || DEFAULT_PRIVATE_BASE_URL,
    "app",
    workspaceSlug,
    draftSlug,
  );
  const visibility = input.visibility ?? "private";
  const runtimeConfig = buildRuntimeConfig(localPublishPath, workspaceSlug, draftSlug, agentSlug);
  const envChecklist = buildEnvChecklist(
    bundleKind,
    input.requiredEnv,
    input.optionalEnv,
    input.runtimeEnv,
  );
  const publishIntegrations = inspectAppPublishIntegrations({
    ...input,
    env: { ...(input.runtimeEnv ?? {}), ...(input.env ?? {}) },
    webhook: {
      publicBaseUrl: input.publicBaseUrl,
      ...input.webhook,
    },
  });
  const buildCommands = buildPublishCommands(bundleKind, localPublishPath);
  const artifactManifest = buildArtifactManifest(
    packageId,
    localPublishPath,
    bundleKind,
    agentSlug,
  );
  const healthChecks = buildHealthChecks(privateUrl);
  const smokeChecks = buildSmokeChecks(privateUrl, publicUrl, bundleKind, agentSlug);
  const dockerComposeExport = buildDockerComposeExport(
    workspaceSlug,
    draftSlug,
    localPublishPath,
    includesAgent(bundleKind),
  );
  const rollback = buildRollbackPlan(localPublishPath);
  const packagingNotes = buildPackagingNotes(bundleKind);
  const artifactPaths = artifactManifest.entries.map((entry) => entry.path);

  return {
    version: "phase-71-lane-5",
    draftSlug,
    agentSlug,
    workspaceSlug,
    publishId,
    localPublishPath,
    runtimeAssumptions: buildRuntimeAssumptions(bundleKind, input.runtimeAssumptions),
    publishChecklist: buildPublishChecklist(
      envChecklist,
      publishIntegrations,
      healthChecks,
      smokeChecks,
      dockerComposeExport,
    ),
    packageContract: {
      version: "phase-71-lane-5",
      packageId,
      packageName,
      packageVersion,
      bundleKind,
      runtimeConfig,
      buildCommands,
      envChecklist,
      healthChecks,
      smokeChecks,
      artifactManifest,
      dockerComposeExport,
      rollback,
    },
    packaging: {
      runtime: "hono-vite",
      notes: packagingNotes,
      buildCommands: buildCommands.map((step) => step.command),
      artifactPaths,
    },
    runtimeConfig,
    envChecklist,
    publishIntegrations,
    publishArtifactManifest: artifactManifest,
    dockerComposeExport,
    healthCheck: {
      livePath: "/api/health/live",
      readyPath: "/api/health/ready",
      command:
        healthChecks.find((check) => check.id === "ready")?.command ??
        `curl -fsS ${privateUrl}/api/health/ready`,
    },
    smokeCheck: {
      command: smokeChecks.map((check) => check.command).join(" && "),
      expected: smokeChecks.flatMap((check) => check.expected),
    },
    publishHistory: buildPublishHistorySemantics(publishId, previousPublishId),
    rollback: buildRollbackSemantics(rollback, workspaceSlug, draftSlug, previousPublishId),
    rollbackNote: rollback.note,
    urlHandoff: {
      visibility,
      publicUrl,
      privateUrl,
      notes:
        visibility === "public"
          ? [
              "Share the public URL only after health and smoke checks pass.",
              "Keep the private URL for operators and authenticated workspace review.",
            ]
          : [
              "Hold the public URL until workspace approval changes visibility to public.",
              "Use the private URL for reviewer handoff and smoke verification.",
            ],
    },
  };
}

function buildRuntimeConfig(
  localPublishPath: string,
  workspaceSlug: string,
  draftSlug: string,
  agentSlug: string | null,
): AppPublishRuntimeConfig {
  return {
    runtime: "hono-vite",
    nodeVersion: ">=22.5.0",
    workingDirectory: ".",
    startCommand: "npm run start",
    portEnv: "PORT",
    storeEnv: "PACKETAGENT_STORE",
    publishRootEnv: "PACKETAGENT_PUBLISH_ROOT",
    publicBaseUrlEnv: "PACKETAGENT_PUBLIC_APP_BASE_URL",
    privateBaseUrlEnv: "PACKETAGENT_PRIVATE_APP_BASE_URL",
    healthBasePath: "/api/health",
    appRouteBase: `/app/${workspaceSlug}/${draftSlug}`,
    agentRouteBase: agentSlug ? `/agent/${workspaceSlug}/${agentSlug}` : null,
    generatedBundlePath: localPublishPath,
    envFileName: ".env.publish",
  };
}

function buildPublishCommands(
  bundleKind: AppPublishBundleKind,
  localPublishPath: string,
): AppPublishBuildCommand[] {
  return [
    {
      id: "install",
      command: "npm ci",
      required: true,
      produces: ["node_modules"],
      description: "Install locked dependencies before building the publish bundle.",
    },
    {
      id: "build-web",
      command: "npm run build:web",
      required: true,
      produces: ["web/dist"],
      description: "Compile the Vite generated app shell served by Hono.",
    },
    {
      id: "typecheck",
      command: "npm run typecheck",
      required: true,
      produces: [],
      description: "Verify TypeScript contracts for the app and generated package metadata.",
    },
    {
      id: "write-publish-manifest",
      command: `packetagent internal write-publish-manifest --output ${localPublishPath}/publish-artifacts.json`,
      required: true,
      produces: [`${localPublishPath}/publish-artifacts.json`],
      description: "Record the deterministic publish artifact manifest used by one-click hosting.",
    },
    ...(includesAgent(bundleKind)
      ? [
          {
            id: "validate-agent-bundle",
            command: `packetagent internal validate-agent-bundle --bundle ${localPublishPath}/agent`,
            required: true,
            produces: [`${localPublishPath}/agent/agent-manifest.json`],
            description:
              "Validate generated agent prompts, tool policy, and runtime metadata before publish.",
          },
        ]
      : []),
  ];
}

function buildArtifactManifest(
  packageId: string,
  localPublishPath: string,
  bundleKind: AppPublishBundleKind,
  agentSlug: string | null,
): AppPublishArtifactManifest {
  const agentEntries: AppPublishArtifactManifestEntry[] = includesAgent(bundleKind)
    ? [
        {
          path: `${localPublishPath}/agent/agent-manifest.json`,
          kind: "manifest",
          required: true,
          description: `Generated agent manifest for ${agentSlug ?? DEFAULT_AGENT_SLUG}.`,
        },
        {
          path: `${localPublishPath}/agent/prompts`,
          kind: "generated_bundle",
          required: true,
          description: "Generated agent instructions, tool policy, and prompt assets.",
        },
      ]
    : [];

  return {
    fileName: "publish-artifacts.json",
    packageId,
    entries: [
      {
        path: "src/server.ts",
        kind: "source",
        required: true,
        description: "Hono server entrypoint for health checks, app routes, and static hosting.",
      },
      {
        path: "web/dist",
        kind: "build_output",
        required: true,
        description: "Built Vite assets for generated app pages.",
      },
      {
        path: `${localPublishPath}/bundle`,
        kind: "generated_bundle",
        required: true,
        description: "Concrete generated app bundle directory mounted by self-hosted publish.",
      },
      {
        path: `${localPublishPath}/app-manifest.json`,
        kind: "manifest",
        required: true,
        description: "Generated app package metadata and route map.",
      },
      {
        path: `${localPublishPath}/runtime-config.json`,
        kind: "config",
        required: true,
        description: "Runtime config consumed by one-click self-hosted publish.",
      },
      ...agentEntries,
      {
        path: `${localPublishPath}/publish-artifacts.json`,
        kind: "manifest",
        required: true,
        description: "Deterministic publish artifact manifest.",
      },
      {
        path: "docker-compose.publish.yml",
        kind: "config",
        required: true,
        description: "Self-hosted Docker Compose export generated from the package contract.",
      },
    ],
  };
}

function buildHealthChecks(privateUrl: string): AppPublishGeneratedCheck[] {
  return [
    {
      id: "live",
      kind: "health",
      label: "Liveness",
      path: "/api/health/live",
      command: `curl -fsS ${privateUrl}/api/health/live`,
      expectedStatus: 200,
      expected: ["GET /api/health/live returns 200 with status live."],
      failureAction:
        "Keep the previous publish pointer active and inspect the app container start logs.",
    },
    {
      id: "ready",
      kind: "health",
      label: "Readiness",
      path: "/api/health/ready",
      command: `curl -fsS ${privateUrl}/api/health/ready`,
      expectedStatus: 200,
      expected: ["GET /api/health/ready returns 200 with status ready."],
      failureAction:
        "Do not shift public traffic; verify env, store connectivity, and publish artifact mounts.",
    },
  ];
}

function buildSmokeChecks(
  privateUrl: string,
  publicUrl: string,
  bundleKind: AppPublishBundleKind,
  agentSlug: string | null,
): AppPublishGeneratedCheck[] {
  return [
    {
      id: "private-handoff-url",
      kind: "smoke",
      label: "Private handoff URL",
      path: "/",
      command: `curl -fsS ${privateUrl}`,
      expectedStatus: 200,
      expected: [
        "The generated app draft is reachable at the private handoff URL before public DNS is shared.",
      ],
      failureAction:
        "Return an actionable failure with the private URL, publish package id, and failing status code.",
    },
    {
      id: "public-url-preflight",
      kind: "smoke",
      label: "Public URL preflight",
      path: "/",
      command: `curl -fsS ${publicUrl}`,
      expectedStatus: 200,
      expected: ["The public URL resolves after publish when visibility is public."],
      failureAction: "Keep the URL private and verify DNS or reverse-proxy routing before sharing.",
    },
    ...(includesAgent(bundleKind)
      ? [
          {
            id: "agent-manifest",
            kind: "smoke" as const,
            label: "Agent manifest",
            path: `/agent/${agentSlug ?? DEFAULT_AGENT_SLUG}/manifest`,
            command: `curl -fsS ${privateUrl}/agent/${agentSlug ?? DEFAULT_AGENT_SLUG}/manifest`,
            expectedStatus: 200,
            expected: ["The generated agent manifest is reachable from the private operator URL."],
            failureAction:
              "Block publish handoff and return the missing agent manifest path as an actionable failure.",
          },
        ]
      : []),
  ];
}

function buildDockerComposeExport(
  workspaceSlug: string,
  draftSlug: string,
  localPublishPath: string,
  withAgent: boolean,
): AppPublishDockerComposeExport {
  return {
    fileName: "docker-compose.publish.yml",
    projectName: `packetagent-${workspaceSlug}-${draftSlug}`,
    services: [
      {
        name: "packetagent-app",
        imageHint: "node:22-alpine",
        buildContext: ".",
        ports: ["${PORT:-8484}:8484"],
        envFile: ".env.publish",
        environment: {
          PACKETAGENT_APP_BUNDLE_PATH: `/app/${localPublishPath}/bundle`,
          PACKETAGENT_PUBLISH_MANIFEST_PATH: `/app/${localPublishPath}/publish-artifacts.json`,
          PACKETAGENT_PUBLISH_ROOT: `/app/${localPublishPath}`,
        },
        volumes: [`${localPublishPath}:/app/${localPublishPath}:ro`],
        dependsOn: ["packetagent-db"],
        healthcheck: {
          test: "CMD-SHELL curl -fsS http://localhost:${PORT:-8484}/api/health/ready || exit 1",
          interval: "10s",
          timeout: "5s",
          retries: 6,
        },
      },
      {
        name: "packetagent-db",
        imageHint: "postgres:16-alpine",
        volumes: ["packetagent-db-data:/var/lib/postgresql/data"],
      },
      ...(withAgent
        ? [
            {
              name: "packetagent-agent",
              imageHint: "node:22-alpine",
              buildContext: ".",
              envFile: ".env.publish",
              volumes: [`${localPublishPath}/agent:/app/${localPublishPath}/agent:ro`],
              dependsOn: ["packetagent-app"],
            },
          ]
        : []),
    ],
    networks: ["packetagent-publish"],
    volumes: ["packetagent-db-data"],
    outline: [
      "Build packetagent-app from the repository root with Node 22 or newer.",
      `Mount ${localPublishPath} read-only; the generated app bundle is expected at ${localPublishPath}/bundle.`,
      `Set PACKETAGENT_PUBLISH_MANIFEST_PATH to ${localPublishPath}/publish-artifacts.json inside the app container.`,
      "Expose PORT from the app service and route it through the hosting load balancer.",
      "Attach packetagent-db only when the selected PACKETAGENT_STORE posture needs managed Postgres.",
      ...(withAgent
        ? ["Start packetagent-agent with the same read-only generated agent bundle metadata."]
        : []),
      "Run the ready health check before shifting public traffic.",
    ],
  };
}

function buildRollbackPlan(localPublishPath: string): AppPublishRollbackPlan {
  const previousPointerPath = `${localPublishPath}.previous`;

  return {
    strategy: "previous_publish_pointer",
    previousPointerPath,
    command: `packetagent publish rollback --from ${localPublishPath} --to ${previousPointerPath}`,
    note: `Keep the previous publish directory until smoke checks pass; rollback by repointing hosting to the last known-good directory beside ${localPublishPath}.`,
  };
}

function buildRuntimeAssumptions(
  bundleKind: AppPublishBundleKind,
  extraAssumptions: string[] = [],
): AppPublishRuntimeAssumption[] {
  return [
    {
      id: "hono-vite-runtime",
      summary: "Existing PacketAgent runtime hosts generated publishes.",
      detail:
        "The publish package uses the existing Hono API/static server and Vite web build instead of introducing a separate generated-app runtime.",
    },
    {
      id: "local-self-hosted-urls",
      summary: "Private local URL is validated before public URL handoff.",
      detail:
        "The builder runs health and smoke checks against the private self-hosted URL first, then exposes the public URL only after validation and workspace approval.",
    },
    {
      id: "env-secret-boundary",
      summary: "Publish metadata names env requirements but never stores secret values.",
      detail:
        "Provider keys, webhook secrets, payment secrets, email credentials, and generated tokens stay in the existing environment/API-key surfaces and logs remain redacted.",
    },
    {
      id: "immutable-publish-bundle",
      summary: "Each publish bundle is treated as immutable.",
      detail:
        "Rollback repoints hosting to the previous known-good bundle instead of mutating the failed bundle in place.",
    },
    ...(includesAgent(bundleKind)
      ? [
          {
            id: "agent-smoke-readiness",
            summary: "Generated agent publishes require trigger and tool readiness.",
            detail:
              "Agent smoke checks validate the generated manifest, provider readiness, enabled tools, trigger/webhook posture, and a safe sample input before public handoff.",
          },
        ]
      : []),
    ...extraAssumptions
      .map((detail, index) => ({
        id: `custom-assumption-${index + 1}`,
        summary: "Generated publish assumption.",
        detail: cleanString(detail),
      }))
      .filter((assumption) => assumption.detail.length > 0),
  ];
}

function buildPublishChecklist(
  envChecklist: AppPublishEnvChecklistItem[],
  publishIntegrations: AppPublishIntegrationsReadiness,
  healthChecks: AppPublishGeneratedCheck[],
  smokeChecks: AppPublishGeneratedCheck[],
  dockerComposeExport: AppPublishDockerComposeExport,
): AppPublishChecklistItem[] {
  const missingRequiredEnv = envChecklist
    .filter((item) => item.required && item.configured === false)
    .map((item) => item.name);

  return [
    {
      id: "env-ready",
      label: "Environment checklist reviewed",
      required: true,
      expectation: "All required env vars are present through configured secret/env surfaces.",
      failureGuidance:
        missingRequiredEnv.length > 0
          ? `Missing required env keys: ${missingRequiredEnv.join(", ")}. Show key names and affected features without printing secret values.`
          : "List missing env names and the feature they block without printing secret values.",
    },
    {
      id: "integration-readiness",
      label: "Integration readiness reviewed",
      required: true,
      expectation:
        "Requested connectors are ready or their generated features are disabled before public handoff.",
      failureGuidance:
        publishIntegrations.featureBlockers.length > 0
          ? `Feature-scoped connector blockers: ${publishIntegrations.featureBlockers.join(" ")}`
          : "Show connector names, missing secret names, affected generated features, and setup guidance without printing secret values.",
    },
    {
      id: "production-build",
      label: "Production build completed",
      required: true,
      expectation: "Required package build commands complete before publish handoff.",
      failureGuidance:
        "Show the failed command, redacted logs, and the generated file or config most likely involved.",
    },
    {
      id: "health-ready",
      label: "Health checks passed",
      required: true,
      expectation: healthChecks.map((check) => check.command).join(" && "),
      failureGuidance:
        "Keep the previous publish current and show readiness diagnostics when a required health check fails.",
    },
    {
      id: "smoke-passed",
      label: "Smoke checks passed",
      required: true,
      expectation: smokeChecks.map((check) => check.label).join(", "),
      failureGuidance:
        "Show failed check names, route/method, redacted response, and retry or rollback guidance.",
    },
    {
      id: "compose-exported",
      label: "Docker Compose export exists",
      required: true,
      expectation: `${dockerComposeExport.fileName} is exported for project ${dockerComposeExport.projectName}.`,
      failureGuidance:
        "Keep publish blocked until the compose file can be regenerated or exported.",
    },
    {
      id: "history-recorded",
      label: "Publish history recorded",
      required: true,
      expectation:
        "The publish entry records URL, status, logs, checks, compose export, and rollback target.",
      failureGuidance:
        "Do not mark publish current when history cannot record the rollback target.",
    },
    {
      id: "rollback-ready",
      label: "Rollback target available",
      required: true,
      expectation:
        "The last known-good publish remains available until the new publish passes validation.",
      failureGuidance:
        "Show missing rollback target details and keep the URL private until an operator resolves it.",
    },
  ];
}

function buildPublishHistorySemantics(
  publishId: string,
  previousPublishId: string | null,
): AppPublishHistorySemantics {
  return {
    currentPublishId: publishId,
    previousPublishId,
    retention:
      "Keep at least the current publish and the last known-good publish until the new health and smoke checks pass.",
    semantics: [
      "A publish becomes current only after required health and smoke checks pass or the user explicitly accepts a private failed preview.",
      "The previous publish remains the rollback target until the new publish is marked current.",
      "Publish logs must be redacted and attached to the publish history entry.",
    ],
  };
}

function buildRollbackSemantics(
  rollback: AppPublishRollbackPlan,
  workspaceSlug: string,
  draftSlug: string,
  previousPublishId: string | null,
): AppPublishRollbackSemantics {
  return {
    command: previousPublishId
      ? `packetagent publish rollback --workspace ${workspaceSlug} --app ${draftSlug} --to ${previousPublishId}`
      : rollback.command,
    restores: [
      "hosting pointer",
      "URL handoff state",
      "last known-good publish bundle",
      "health and smoke metadata",
    ],
    failureGuidance: [
      "If rollback cannot find a previous publish, keep the current URL private and show the missing publish id.",
      "If rollback health checks fail, keep traffic on the last URL that still passes readiness and show both failing commands.",
    ],
  };
}

function buildPackagingNotes(bundleKind: AppPublishBundleKind): string[] {
  return [
    "Use the existing Hono server as the API host; do not create a second HTTP runtime for drafts.",
    "Build the Vite client with npm run build:web and serve web/dist through the existing Hono static fallback.",
    "Keep generated app draft assets under the local publish path so package exports are deterministic.",
    ...(includesAgent(bundleKind)
      ? [
          "Package generated agent prompts, tool policy, and manifest beside the app bundle for one-click self-hosted export.",
        ]
      : []),
  ];
}

function buildEnvChecklist(
  bundleKind: AppPublishBundleKind,
  requiredEnv: string[] = [],
  optionalEnv: string[] = [],
  runtimeEnv: Record<string, string | undefined> = {},
): AppPublishEnvChecklistItem[] {
  const required = uniqueSorted([
    ...BASE_REQUIRED_ENV,
    ...(includesAgent(bundleKind) ? AGENT_REQUIRED_ENV : []),
    ...requiredEnv,
  ]);
  const optional = uniqueSorted([
    ...BASE_OPTIONAL_ENV,
    ...(includesAgent(bundleKind) ? AGENT_OPTIONAL_ENV : []),
    ...optionalEnv,
  ]).filter((name) => !required.includes(name));

  return [
    ...required.map((name) => envChecklistItem(name, true, runtimeEnv)),
    ...optional.map((name) => envChecklistItem(name, false, runtimeEnv)),
  ];
}

function envChecklistItem(
  name: string,
  required: boolean,
  runtimeEnv: Record<string, string | undefined>,
): AppPublishEnvChecklistItem {
  return {
    name,
    required,
    purpose:
      ENV_PURPOSES[name] ??
      `${required ? "Required" : "Optional"} publish setting for the generated app draft.`,
    source: envSource(name),
    configured: Object.prototype.hasOwnProperty.call(runtimeEnv, name)
      ? cleanString(runtimeEnv[name]).length > 0
      : null,
  };
}

function envSource(name: string): AppPublishEnvChecklistItem["source"] {
  if (name.startsWith("PACKETAGENT_AGENT_")) return "bundle";
  if (name.startsWith("PACKETAGENT_") || name === "NODE_ENV" || name === "PORT") return "runtime";
  return "operator";
}

function includesAgent(bundleKind: AppPublishBundleKind): boolean {
  return bundleKind === "agent" || bundleKind === "app_agent";
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function slugify(value?: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/g, "") || ".";
}

function joinMetadataPath(...parts: string[]): string {
  return parts
    .map((part) => normalizePath(part).replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}

function joinUrl(baseUrl: string, ...parts: string[]): string {
  const normalizedBase = baseUrl.replace(/\/+$/g, "");
  const normalizedParts = parts
    .map((part) => encodeURIComponent(slugify(part) || part))
    .filter(Boolean);
  return [normalizedBase, ...normalizedParts].join("/");
}

function cleanString(value: string | undefined): string {
  return String(value ?? "").trim();
}
