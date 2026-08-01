import {
  AppBuilderDraftContract,
  AppPublishRouteRequest,
  GeneratedAppCheckpointWithRuntime,
  GeneratedAppRecordWithRuntime,
} from "./contracts.js";
import { buildAppPublishReadiness } from "../../app-publish-readiness.js";
import {
  buildAppPublishValidation,
  type PublishArtifactObservation,
} from "../../app-publish-service.js";
import { buildGeneratedAppPublishPackageFiles } from "../../generated-app-publish-package.js";
import {
  buildGeneratedAppRuntimeModel,
  GENERATED_APP_SCHEMA_CHANGE_POLICY,
} from "../../generated-app-runtime.js";
import { currentPublishedRecord } from "./generated-apps.js";
import { dirname, relative, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import {
  GENERATED_APP_ARTIFACT_MANIFEST_FILE_NAME,
  type GeneratedAppPublishArtifactFile,
  type GeneratedAppPublishArtifactVerification,
  sealGeneratedAppPublishArtifactManifest,
  verifyGeneratedAppPublishArtifactManifest,
} from "../../generated-app-publish-integrity.js";
import { inspectAppPublishIntegrations } from "../../app-publish-integrations.js";
import { latestPreviewSnapshot } from "./iteration.js";
import { orderGeneratedAppPublishHistory } from "../../app-publish-history.js";
import { type AuthenticatedRouteContext, httpRouteError } from "../shared.js";
import {
  type GeneratedAppCheckpointRecord,
  type GeneratedAppPublishRecord,
  type GeneratedAppRecord,
  loadStoreAsync,
} from "../../packetagent-store.js";

export async function buildPublishPreflight(
  context: AuthenticatedRouteContext,
  record: GeneratedAppRecord,
  checkpoint: GeneratedAppCheckpointRecord,
  body: AppPublishRouteRequest,
  options: { materializeWorkspace?: boolean } = {},
) {
  const draft = checkpoint.draft as unknown as AppBuilderDraftContract;
  const env = publishRuntimeEnv();
  const health = await localPublishHealthObservation();
  const buildStatus = checkpoint.buildStatus ?? record.buildStatus;
  const smokeStatus = checkpoint.smokeStatus ?? record.smokeStatus;
  const readiness = buildAppPublishReadiness({
    appName: record.name,
    draftId: record.slug,
    workspaceSlug: context.workspace.slug,
    visibility: body.visibility ?? "private",
    localPublishRoot: body.localPublishRoot,
    publicBaseUrl: body.publicBaseUrl,
    privateBaseUrl: body.privateBaseUrl,
    runtimeEnv: env,
  });
  let artifactManifest = readiness.publishArtifactManifest;
  let artifactIntegrity: GeneratedAppPublishArtifactVerification | undefined;
  if (options.materializeWorkspace) {
    const materialized = materializeGeneratedAppPublishWorkspace(
      record,
      checkpoint,
      readiness.localPublishPath,
      readiness.publishArtifactManifest,
    );
    if (materialized) {
      artifactManifest = materialized.manifest;
      artifactIntegrity = materialized.verification;
    }
  } else {
    const materialized = readMaterializedGeneratedAppPublishWorkspace(readiness.localPublishPath, {
      workspaceId: record.workspaceId,
      appId: record.id,
      checkpointId: checkpoint.id,
    });
    if (materialized) {
      artifactManifest = materialized.manifest;
      artifactIntegrity = materialized.verification;
    }
  }
  const privateUrl = readiness.urlHandoff.privateUrl;
  const publicUrl = readiness.urlHandoff.publicUrl;
  const expectedArtifacts = readiness.publishArtifactManifest.entries
    .filter((entry) => entry.required)
    .map((entry) => entry.path);
  const validation = buildAppPublishValidation({
    build: {
      phase: buildStatus === "passed" ? "passed" : buildStatus === "failed" ? "failed" : "not_run",
      command: "npm run build:web",
      expectedArtifacts,
    },
    artifacts: {
      expectedArtifacts,
      manifestPath: `${readiness.localPublishPath}/${readiness.publishArtifactManifest.fileName}`,
      artifacts: publishArtifactObservations(
        record,
        checkpoint,
        readiness.localPublishPath,
        buildStatus,
      ),
      integrity: artifactIntegrity,
    },
    health,
    smoke: {
      requiredCheckCount: Math.max(1, draft.smokeBuildStatus?.checks?.length ?? 1),
      checks: (
        draft.smokeBuildStatus?.checks ?? [
          { name: "Generated app URL", status: "pending", detail: "Generated app URL" },
        ]
      ).map((check, index) => ({
        id: `smoke-${index + 1}`,
        label: check.name ?? `Smoke ${index + 1}`,
        status: smokeStatus === "pass" ? "pass" : smokeStatus === "failed" ? "fail" : "pending",
        message:
          smokeStatus === "failed"
            ? `Generated app smoke check failed before publish: ${check.detail}`
            : undefined,
      })),
    },
    url: {
      url: (body.visibility ?? "private") === "public" ? publicUrl : privateUrl,
      visibility: body.visibility ?? "private",
    },
  });
  const integrations = inspectAppPublishIntegrations({
    draft: {
      appName: record.name,
      summary: record.description,
      pages: draft.app.pages,
      apiRoutes: draft.app.apiRoutes,
      dataModels: draft.app.dataSchema,
      env,
    },
    env,
    database: {
      required: draft.app.dataSchema.length > 0,
      store: "generated-sqlite",
      configured: true,
      writable: true,
      schemaChangePolicy: GENERATED_APP_SCHEMA_CHANGE_POLICY,
    },
  });

  return { validation, integrations, artifactManifest };
}

function materializeGeneratedAppPublishWorkspace(
  record: GeneratedAppRecordWithRuntime,
  checkpoint: GeneratedAppCheckpointWithRuntime,
  localPublishPath: string,
  artifactManifest: GeneratedAppPublishRecord["artifactManifest"],
):
  | {
      manifest: GeneratedAppPublishRecord["artifactManifest"];
      verification: GeneratedAppPublishArtifactVerification;
    }
  | undefined {
  const artifact = checkpoint.runtimeArtifact ?? record.runtimeArtifact;
  if (!artifact?.files.length) return;

  const publishRoot = resolve(process.cwd(), localPublishPath);
  const bundleRoot = safePublishPath(publishRoot, "bundle");
  rmSync(bundleRoot, { recursive: true, force: true });
  mkdirSync(bundleRoot, { recursive: true });

  const appManifest = {
    appId: record.id,
    workspaceId: record.workspaceId,
    checkpointId: checkpoint.id,
    slug: record.slug,
    name: record.name,
    entrypoint: artifact.entrypoint,
    renderedAt: artifact.renderedAt,
    files: artifact.files.map((file) => ({
      path: file.path,
      contentType: file.contentType,
      size: file.size,
      sha256: file.sha256,
      role: file.role,
    })),
  };
  const runtimeConfig = {
    runtime: "packetagent-generated-app-standalone",
    schemaChangePolicy: GENERATED_APP_SCHEMA_CHANGE_POLICY,
    workspaceId: record.workspaceId,
    appId: record.id,
    checkpointId: checkpoint.id,
    port: 8080,
    health: {
      live: "/health/live",
      ready: "/health/ready",
    },
    apiBasePath: `/api/app/generated-apps/${encodeURIComponent(record.id)}/api`,
    staticRoot: "/app/static",
    dataRoot: "/app/data",
  };
  const runtimeModel = buildGeneratedAppRuntimeModel(
    checkpoint.draft as unknown as AppBuilderDraftContract,
  );
  const files: GeneratedAppPublishArtifactFile[] = [
    ...artifact.files.map((file) => ({
      path: `bundle/${normalizeSourceFilePath(file.path)}`,
      content: file.content,
      kind: "generated_bundle" as const,
      description: `Generated app ${file.role} file.`,
      mediaType: file.contentType,
    })),
    {
      path: "app-manifest.json",
      content: jsonArtifactContent(appManifest),
      kind: "manifest",
      description: "Generated app identity, entrypoint, and source file map.",
      mediaType: "application/json; charset=utf-8",
    },
    {
      path: "runtime-config.json",
      content: jsonArtifactContent(runtimeConfig),
      kind: "config",
      description: "PacketAgent generated-app runtime configuration.",
      mediaType: "application/json; charset=utf-8",
    },
    ...buildGeneratedAppPublishPackageFiles({
      workspaceId: record.workspaceId,
      appId: record.id,
      checkpointId: checkpoint.id,
      appName: record.name,
      model: runtimeModel,
    }),
  ];
  for (const file of files) {
    writeTextArtifact(
      safePublishPath(publishRoot, normalizeSourceFilePath(file.path)),
      typeof file.content === "string" ? file.content : Buffer.from(file.content),
    );
  }
  const manifest = sealGeneratedAppPublishArtifactManifest({
    packageId: artifactManifest.packageId,
    workspaceId: record.workspaceId,
    appId: record.id,
    checkpointId: checkpoint.id,
    generatedAt: artifact.renderedAt,
    entrypoint: `bundle/${normalizeSourceFilePath(artifact.entrypoint)}`,
    files,
    signing: generatedAppPublishManifestSigningConfig(),
  });
  writeJsonArtifact(
    safePublishPath(publishRoot, GENERATED_APP_ARTIFACT_MANIFEST_FILE_NAME),
    manifest,
  );
  return {
    manifest,
    verification: verifyGeneratedAppPublishArtifactManifest(manifest, {
      rootPath: publishRoot,
      signingKey: generatedAppPublishManifestSigningKey(),
      expectedSubject: {
        workspaceId: record.workspaceId,
        appId: record.id,
        checkpointId: checkpoint.id,
      },
    }),
  };
}

export function readMaterializedGeneratedAppPublishWorkspace(
  localPublishPath: string,
  expectedSubject?: { workspaceId: string; appId: string; checkpointId: string },
):
  | {
      manifest: GeneratedAppPublishRecord["artifactManifest"];
      verification: GeneratedAppPublishArtifactVerification;
    }
  | undefined {
  const publishRoot = resolve(process.cwd(), localPublishPath);
  const manifestPath = safePublishPath(publishRoot, GENERATED_APP_ARTIFACT_MANIFEST_FILE_NAME);
  if (!existsSync(manifestPath)) return undefined;
  try {
    if (statSync(manifestPath).size > 5 * 1024 * 1024) {
      throw new Error("publish artifact manifest exceeds the read limit");
    }
    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    ) as GeneratedAppPublishRecord["artifactManifest"];
    return {
      manifest,
      verification: verifyGeneratedAppPublishArtifactManifest(manifest, {
        rootPath: publishRoot,
        signingKey: generatedAppPublishManifestSigningKey(),
        expectedSubject,
      }),
    };
  } catch {
    return {
      manifest: {
        fileName: GENERATED_APP_ARTIFACT_MANIFEST_FILE_NAME,
        packageId: "invalid",
        entries: [],
      },
      verification: {
        status: "invalid",
        checksumVerified: false,
        signatureStatus: "unsigned",
        checkedFiles: 0,
        checkedBytes: 0,
        issues: [
          {
            code: "manifest.read.invalid",
            path: GENERATED_APP_ARTIFACT_MANIFEST_FILE_NAME,
            message: "The publish artifact manifest could not be parsed or verified.",
          },
        ],
      },
    };
  }
}

function publishArtifactObservations(
  record: GeneratedAppRecordWithRuntime,
  checkpoint: GeneratedAppCheckpointWithRuntime,
  localPublishPath: string,
  _buildStatus: string | undefined,
): PublishArtifactObservation[] {
  const artifact = checkpoint.runtimeArtifact ?? record.runtimeArtifact;
  const snapshot = latestPreviewSnapshot(record);
  const snapshotPaths =
    snapshot?.checkpoint.id === checkpoint.id ? snapshot.build.artifactPaths : [];
  const generatedBundlePresent = Boolean(artifact?.files.length);
  const bundleObservation = diskArtifactObservation(
    `${localPublishPath}/bundle`,
    "generated_bundle",
    "generated_draft",
    `Generated runtime bundle with ${artifact?.files.length ?? 0} source files.`,
  );
  const appManifestObservation = diskArtifactObservation(
    `${localPublishPath}/app-manifest.json`,
    "manifest",
    "publish_manifest",
    "Generated app manifest derived from the runtime artifact.",
  );
  const runtimeConfigObservation = diskArtifactObservation(
    `${localPublishPath}/runtime-config.json`,
    "config",
    "publish_manifest",
    "Runtime config for mounting the generated bundle.",
  );
  const publishManifestObservation = diskArtifactObservation(
    `${localPublishPath}/publish-artifacts.json`,
    "manifest",
    "publish_manifest",
    "Publish artifact manifest generated from readiness metadata.",
  );

  return [
    { ...bundleObservation, present: bundleObservation.present && generatedBundlePresent },
    {
      ...appManifestObservation,
      present: appManifestObservation.present && generatedBundlePresent,
    },
    {
      ...runtimeConfigObservation,
      present: runtimeConfigObservation.present && generatedBundlePresent,
    },
    {
      ...publishManifestObservation,
      present: publishManifestObservation.present && generatedBundlePresent,
    },
    {
      ...diskArtifactObservation(
        `${localPublishPath}/Dockerfile.publish`,
        "config",
        "publish_manifest",
        "Standalone generated-app image definition.",
      ),
    },
    {
      ...diskArtifactObservation(
        `${localPublishPath}/docker-compose.publish.yml`,
        "config",
        "publish_manifest",
        "Single-service self-hosted compose export.",
      ),
    },
    {
      ...diskArtifactObservation(
        `${localPublishPath}/runtime/server.mjs`,
        "source",
        "publish_manifest",
        "Standalone Node static and SQLite runtime.",
      ),
    },
    {
      ...diskArtifactObservation(
        `${localPublishPath}/runtime/runtime-model.json`,
        "config",
        "publish_manifest",
        "Generated standalone runtime schema and seed model.",
      ),
    },
    {
      ...diskArtifactObservation(
        `${localPublishPath}/RUNBOOK.md`,
        "config",
        "publish_manifest",
        "Standalone generated-app operator runbook.",
      ),
    },
    {
      ...diskArtifactObservation(
        `${localPublishPath}/deploy/Caddyfile.example`,
        "config",
        "publish_manifest",
        "Caddy automatic-HTTPS reverse-proxy example.",
      ),
    },
    {
      ...diskArtifactObservation(
        `${localPublishPath}/deploy/nginx.generated-app.conf.example`,
        "config",
        "publish_manifest",
        "nginx TLS reverse-proxy example.",
      ),
    },
    {
      ...diskArtifactObservation(
        `${localPublishPath}/deploy/TAILSCALE.md`,
        "config",
        "publish_manifest",
        "Tailscale private VPN and optional public Funnel guidance.",
      ),
    },
    ...snapshotPaths.map((path) => ({
      path,
      kind: "generated_bundle" as const,
      present: true,
      source: "preview_snapshot" as const,
      description: "Preview snapshot artifact captured for this checkpoint.",
    })),
  ];
}

function diskArtifactObservation(
  path: string,
  kind: NonNullable<PublishArtifactObservation["kind"]>,
  source: NonNullable<PublishArtifactObservation["source"]>,
  description: string,
): PublishArtifactObservation {
  const stats = publishArtifactDiskStats(path);
  return {
    path,
    kind,
    present: stats.present,
    bytes: stats.bytes,
    source,
    description: stats.present
      ? `${description} Observed on disk.`
      : `${description} Missing on disk.`,
  };
}

function publishArtifactDiskStats(path: string): { present: boolean; bytes?: number } {
  try {
    const absolutePath = resolve(process.cwd(), path);
    if (!existsSync(absolutePath)) return { present: false };
    const stats = statSync(absolutePath);
    return {
      present: true,
      bytes: stats.isFile() ? stats.size : undefined,
    };
  } catch {
    return { present: false };
  }
}

function writeJsonArtifact(path: string, value: unknown) {
  writeTextArtifact(path, jsonArtifactContent(value));
}

function jsonArtifactContent(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeTextArtifact(path: string, content: string | Uint8Array) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function safePublishPath(root: string, path: string) {
  const target = resolve(root, path);
  const relativePath = relative(root, target);
  if (relativePath.startsWith("..") || resolve(relativePath) === relativePath) {
    throw httpRouteError(400, "publish artifact path escapes workspace");
  }
  return target;
}

function normalizeSourceFilePath(path: string) {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function generatedAppPublishManifestSigningKey(): string | undefined {
  const value = process.env.PACKETAGENT_PUBLISH_MANIFEST_SIGNING_KEY;
  return value && value.trim() ? value : undefined;
}

function generatedAppPublishManifestSigningConfig(): { key: string; keyId: string } | undefined {
  const key = generatedAppPublishManifestSigningKey();
  if (!key) return undefined;
  const keyId =
    process.env.PACKETAGENT_PUBLISH_MANIFEST_SIGNING_KEY_ID?.trim().slice(0, 128) ||
    "packetagent-local";
  return { key, keyId };
}

export async function localPublishHealthObservation() {
  try {
    await loadStoreAsync();
    return {
      live: { path: "/api/health/live", statusCode: 200, bodyStatus: "live" },
      ready: { path: "/api/health/ready", statusCode: 200, bodyStatus: "ready" },
    };
  } catch (error) {
    return {
      live: { path: "/api/health/live", statusCode: 200, bodyStatus: "live" },
      ready: { path: "/api/health/ready", statusCode: 503, bodyStatus: "not_ready", error },
    };
  }
}

export function builderPublishState(
  record: GeneratedAppRecord,
  workspaceSlug: string,
  publish?: GeneratedAppPublishRecord,
  validation?: ReturnType<typeof buildAppPublishValidation>,
  integrations?: ReturnType<typeof inspectAppPublishIntegrations>,
) {
  const history = orderGeneratedAppPublishHistory(record.publishHistory ?? []);
  const current = publish ?? currentPublishedRecord(record) ?? history[0];
  const readiness = buildAppPublishReadiness({
    draftId: record.slug,
    workspaceSlug,
    visibility: current?.visibility ?? "private",
    runtimeEnv: publishRuntimeEnv(),
  });
  const blockers = [
    ...(validation?.actionableFailures ?? []).map(
      (failure) => `${failure.stage}: ${failure.message}`,
    ),
    ...(integrations?.blockers ?? []),
    ...(integrations?.featureBlockers ?? []),
  ];

  return {
    appId: record.id,
    checkpointId: current?.checkpointId ?? record.checkpointId,
    status: current?.status ?? (blockers.length > 0 ? "failed" : "ready"),
    publishedUrl:
      record.publishedUrl ??
      (current
        ? current.visibility === "public"
          ? current.publicUrl
          : current.privateUrl
        : undefined),
    readiness,
    validation,
    integrations,
    logs: current?.logs ?? [],
    history: history.map((entry) => ({
      id: entry.id,
      status: entry.status,
      url: entry.visibility === "public" ? entry.publicUrl : entry.privateUrl,
      checkpointId: entry.checkpointId,
      workspacePath: entry.workspacePath ?? entry.localPublishPath,
      manifest: entry.manifest ?? entry.artifactManifest,
      publishedAt: entry.completedAt ?? entry.createdAt,
      actor: entry.createdByUserId,
      summary: `${entry.versionLabel} ${entry.status}`,
    })),
    nextActions:
      blockers.length > 0
        ? blockers
        : [
            "Share the private URL with workspace reviewers.",
            "Export docker-compose.publish.yml for self-hosted handoff.",
            "Keep the previous publish available until the new URL is verified.",
          ],
    canPublish: validation
      ? validation.canPublish && (integrations ? integrationsReadyForPublish(integrations) : true)
      : true,
    rollbackActions: history
      .filter((entry) => entry.id !== record.currentPublishId)
      .map((entry) => ({
        id: `rollback-${entry.id}`,
        label: `Rollback to ${entry.versionLabel}`,
        checkpointId: entry.checkpointId,
        publishId: entry.id,
        disabled: entry.status === "failed",
      })),
  };
}

export function integrationsReadyForPublish(
  integrations: ReturnType<typeof inspectAppPublishIntegrations>,
) {
  return integrations.canPublish && integrations.canUseAllRequestedIntegrations;
}

export function publishRuntimeEnv() {
  const defaults: Record<string, string> = {
    NODE_ENV: "production",
    PORT: "8484",
    PACKETAGENT_STORE: "json",
    PACKETAGENT_PUBLISH_ROOT: "data/published-apps",
  };
  const keys = [
    "NODE_ENV",
    "PORT",
    "PACKETAGENT_STORE",
    "PACKETAGENT_PUBLISH_ROOT",
    "PACKETAGENT_PUBLIC_APP_BASE_URL",
    "PACKETAGENT_PRIVATE_APP_BASE_URL",
    "DATABASE_URL",
    "PACKETAGENT_DATABASE_URL",
    "PACKETAGENT_MANAGED_DATABASE_URL",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "PACKETAGENT_WEBHOOK_SIGNING_SECRET",
    "RESEND_API_KEY",
    "SENDGRID_API_KEY",
    "POSTMARK_TOKEN",
    "SMTP_URL",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_ID",
    "GITHUB_TOKEN",
    "GH_TOKEN",
  ];

  return Object.fromEntries(keys.map((key) => [key, process.env[key] ?? defaults[key]])) as Record<
    string,
    string | undefined
  >;
}
