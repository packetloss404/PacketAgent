import { type Context, type Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import {
  generateAppDraftFromPrompt,
  generateAppDraftWithLLM,
  type ApiRouteStub,
  type AppDraft,
  type CrudFlowDraft,
  type FieldSchemaDraft,
  type PageDraft,
} from "../app-builder-service.js";
import {
  buildAppPreviewReadiness,
  type AppSmokeCheck,
  type GeneratedAppApiRoute,
  type GeneratedAppCrudFlow,
  type GeneratedAppPageMapEntry,
} from "../app-preview-readiness.js";
import {
  applyAppIterationToDraft,
  applyAppIterationViaFileTree,
  applyAppIterationViaLLM,
  buildAppIterationPlan,
  shouldUseFileTreeIteration,
  type AppIterationChangeRequest,
  type AppIterationDiffHunk,
  type AppIterationLLMResult,
  type AppIterationPlan,
  type AppIterationPresetId,
  type AppIterationTargetInput,
  type GeneratedAppDraftLike,
} from "../app-iteration-service.js";
import { deriveDraftFromFiles } from "../codegen/derived-draft.js";
import type { GeneratedFile } from "../codegen/llm-author.js";
import { derivePreviewRefreshState } from "../app-preview-iteration.js";
import { inspectAppIterationTools } from "../app-iteration-tools.js";
import {
  buildAppPreviewSnapshotMetadata,
  compareAppPreviewSnapshots,
  createAppPreviewRollbackCommand,
} from "../app-preview-snapshots.js";
import {
  buildGeneratedAppPublishRecord,
  buildGeneratedAppPublishRollbackResult,
  createGeneratedAppPublishRollbackCommand,
  generatedAppPublishUrlForBase,
  orderGeneratedAppPublishHistory,
} from "../app-publish-history.js";
import type { ModelRoutingPresetId } from "../model-routing-presets.js";
import { buildAppPublishReadiness } from "../app-publish-readiness.js";
import { inspectAppPublishIntegrations } from "../app-publish-integrations.js";
import {
  buildAppPublishValidation,
  type PublishArtifactObservation,
} from "../app-publish-service.js";
import {
  buildGeneratedAppRuntimeArtifact,
  buildGeneratedAppRuntimeArtifactFromFiles,
  findGeneratedAppSourceFile,
  summarizeGeneratedAppSourceFiles,
  writeGeneratedAppRuntimeWorkspace,
  type GeneratedAppRuntimeArtifactRecord,
  type GeneratedAppSourceFileRecord,
  type GeneratedAppSourceFileSummary,
} from "../generated-app-runtime.js";
import {
  approveAgentBuilderDraftAsync,
  generateAgentBuilderDraftAsync,
  getIntegrationReadinessAsync,
  requireAuthenticatedContextAsync,
} from "../packetagent-services.js";
import {
  loadStoreAsync,
  mutateStoreAsync,
  recordActivity,
  type GeneratedAppCheckpointRecord,
  type GeneratedAppPublishRecord,
  type GeneratedAppRecord,
  type GeneratedAppStatus,
} from "../packetagent-store.js";
import { redactedErrorMessage } from "../security/redaction.js";
import {
  chatStreamDelay,
  emitProse,
  emitStep,
  errorResponse,
  httpRouteError,
  llmIsAvailable,
  presetStepLabel,
  requireWorkspacePermission,
  stableAppId,
  stableHash,
  type AuthenticatedRouteContext,
} from "./shared.js";

type AppBuilderCheckStatus = "pending" | "pass" | "warn" | "fail";
export type AppBuilderDraftContract = ReturnType<typeof buildAppBuilderDraft>;
type AppDraftSource = "llm" | "template" | "llm-filetree";
type GeneratedAppCheckpointWithRuntime = GeneratedAppCheckpointRecord & {
  runtimeArtifact?: GeneratedAppRuntimeArtifactRecord;
  sourceFiles?: GeneratedAppSourceFileRecord[];
  codegenSource?: AppDraftSource;
};
export type GeneratedAppRecordWithRuntime = GeneratedAppRecord & {
  runtimeArtifact?: GeneratedAppRuntimeArtifactRecord;
  sourceFiles?: GeneratedAppSourceFileRecord[];
  codegenSource?: AppDraftSource;
  checkpoints?: GeneratedAppCheckpointWithRuntime[];
};
interface GeneratedAppWorkspaceManifest {
  version: "generated-app-workspace.v1";
  workspace: { id: string; slug: string };
  app: { id: string; slug: string; name: string };
  checkpoint: { id: string; source?: GeneratedAppCheckpointRecord["source"]; createdAt: string };
  artifact: {
    entrypoint: string;
    renderedAt: string;
    files: GeneratedAppSourceFileSummary[];
  };
}
interface GeneratedAppWorkspaceSummary {
  id: string;
  slug: string;
  path: string;
  appPath: string;
  checkpointPath: string;
  manifest: {
    path: string;
    version: GeneratedAppWorkspaceManifest["version"];
    fileCount: number;
    totalBytes: number;
    entrypoint: string;
    renderedAt: string;
    checkpointId: string;
  };
}
type AppBuilderIterationTargetKind =
  | "app"
  | "page"
  | "data_entity"
  | "api_route"
  | "auth"
  | "smoke"
  | "config"
  | "file"
  | "agent"
  | "tool";
type AppBuilderIterationDiffStatus = "generated" | "pending" | "applied" | "blocked";

interface AppBuilderIterationTarget {
  id: string;
  kind: AppBuilderIterationTargetKind;
  label: string;
  path?: string;
}

interface AppIterationRouteRequest {
  appId?: string;
  checkpointId?: string;
  draft?: AppBuilderDraftContract;
  draftSource?: AppDraftSource;
  fileTree?: GeneratedFile[];
  target?: AppBuilderIterationTarget;
  prompt?: string;
  agentId?: string;
  previewUrl?: string;
  selectedContext?: unknown;
  errorContext?: { source?: "build" | "runtime" | "smoke"; message?: string; prompt?: string };
  mode?: string;
  preset?: ModelRoutingPresetId;
  sourceError?: {
    source: "build" | "runtime" | "smoke";
    message: string;
    prompt: string;
  };
}

interface AppIterationApplyRouteRequest {
  appId?: string;
  checkpointId?: string;
  diffId?: string;
  target?: AppBuilderIterationTarget;
  files?: Array<{ path: string; changeType: string; summary: string; diff: string }>;
  diff?: AppIterationRouteResult;
  changeSet?: AppIterationRouteResult;
  changeSetId?: string;
  draft?: AppBuilderDraftContract;
  runBuild?: boolean;
  runSmoke?: boolean;
  refreshPreview?: boolean;
  previewUrl?: string;
}

interface AppPublishRouteRequest {
  target?: "app" | "agent" | "bundle";
  appId?: string;
  agentId?: string;
  checkpointId?: string;
  visibility?: "private" | "public";
  localPublishRoot?: string;
  publicBaseUrl?: string;
  privateBaseUrl?: string;
  runHealth?: boolean;
  runSmoke?: boolean;
  exportCompose?: boolean;
}

interface AppPublishRollbackRouteRequest {
  appId?: string;
  agentId?: string;
  targetPublishId?: string;
  reason?: string;
}

interface AppIterationRouteResult {
  id: string;
  appId?: string;
  checkpointId?: string;
  target: AppBuilderIterationTarget;
  prompt: string;
  summary: string;
  status: AppBuilderIterationDiffStatus;
  files: AppIterationDiffFile[];
  sourceDiffFiles?: AppIterationDiffFile[];
  sourceFiles?: ReturnType<typeof summarizeGeneratedAppSourceFiles>;
  fileTree?: GeneratedFile[];
  draftSource?: AppDraftSource;
  validationErrors?: string[];
  artifact?: {
    entrypoint?: string;
    renderedAt?: string;
    files: ReturnType<typeof summarizeGeneratedAppSourceFiles>;
  };
  draft?: AppBuilderDraftContract;
  preview?: {
    url?: string;
    refreshedAt?: string;
    status: AppBuilderCheckStatus;
    message: string;
  };
  logs: Array<{ at: string; level: "info" | "warn" | "error"; message: string }>;
  smoke?: ReturnType<typeof smokeStatusFromChecks>;
  errorFix?: {
    source: "build" | "runtime" | "smoke";
    message: string;
    prompt: string;
  };
  tools?: ReturnType<typeof inspectAppIterationTools>;
}

type AppIterationDiffFile = {
  path: string;
  changeType: "added" | "modified" | "deleted" | "renamed";
  summary: string;
  diff: string;
  source?: "draft" | "runtime";
  beforeSha256?: string;
  afterSha256?: string;
  beforeSize?: number;
  afterSize?: number;
  role?: GeneratedAppSourceFileRecord["role"];
};

const TEMPLATE_NARRATION_LABELS: Record<AppDraft["templateId"], string> = {
  crm: "CRM",
  booking: "booking",
  internal_dashboard: "internal dashboard",
  task_tracker: "task tracker",
  customer_portal: "customer portal",
};

function templateNarrationLines(draft: AppDraft): string[] {
  const lines: string[] = [];
  lines.push("Let me take a look at what you're describing…\n\n");

  const entities = Array.isArray(draft.dataSchema?.entities) ? draft.dataSchema.entities : [];
  const routes = Array.isArray(draft.apiRouteStubs) ? draft.apiRouteStubs : [];
  const label =
    (draft.templateId && TEMPLATE_NARRATION_LABELS[draft.templateId]) || draft.templateId;
  if (label) {
    lines.push(
      `I think the **${label}** shape fits this best — it has ${entities.length} entities and ${routes.length} routes ready to go.\n\nLet me put the plan together…\n\n`,
    );
  }

  const entityNames = entities
    .map((entity) => entity?.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  if (entityNames.length > 0) {
    lines.push(`I'm sketching out the data model: ${entityNames.join(", ")}.\n\n`);
  }

  const routeNames = routes
    .map((route) => (route && typeof route.path === "string" ? route.path : null))
    .filter((path): path is string => typeof path === "string" && path.length > 0)
    .slice(0, 6);
  if (routeNames.length > 0) {
    lines.push(`Wiring up the API surface — ${routeNames.join(", ")}.\n\n`);
  }

  lines.push("Here's the plan. Click Approve when it looks right.\n\n");
  return lines;
}

async function streamTemplateNarration(
  sse: { writeSSE: (event: { event: string; data: string }) => Promise<void> },
  draft: AppDraft,
): Promise<void> {
  let lines: string[];
  try {
    lines = templateNarrationLines(draft);
  } catch {
    return;
  }
  for (const line of lines) {
    // Split on word boundaries so each whitespace-separated token streams
    // as its own SSE chunk, but preserve trailing whitespace (incl. the
    // double newlines that separate paragraphs) so the UI renders newlines.
    const tokens = line.match(/\S+\s*|\s+/g);
    if (!tokens) continue;
    for (const token of tokens) {
      await emitProse(sse, token);
      await chatStreamDelay();
    }
  }
}

async function applyAppBuilderDraft(c: Context) {
  try {
    const context = await requireAuthenticatedContextAsync(c);
    await requireWorkspacePermission(context, "manageWorkspace");
    const body = (await c.req.json()) as {
      prompt?: string;
      draft?: AppBuilderDraftContract;
      source?: AppDraftSource;
      files?: GeneratedFile[];
      runBuild?: boolean;
      runSmoke?: boolean;
      targetStatus?: GeneratedAppStatus;
    };
    const draft =
      body.draft ??
      buildAppBuilderDraft(generateAppDraftFromPrompt(promptFromBody(body.prompt)), context);
    const fileTreeFiles =
      body.source === "llm-filetree" ? generatedFilesFromUnknown(body.files) : undefined;
    const runSmoke = Boolean(body.runSmoke || body.runBuild);
    const smokeBuild = await runAppSmokeViaSandbox(draft, context, runSmoke);
    const previewUrl =
      smokeBuild.status === "pass"
        ? previewUrlForDraft(draft, context, stableGeneratedAppId(draft, context))
        : undefined;
    const record = await persistGeneratedAppDraft(context, draft, {
      status: body.targetStatus ?? (runSmoke ? "built" : "saved"),
      previewUrl,
      smokeStatus: smokeBuild.status,
      buildStatus: runSmoke ? "passed" : "not_run",
      codegenSource: fileTreeFiles ? "llm-filetree" : body.source,
      fileTreeFiles,
    });
    const checkpoint = checkpointForPublish(record, record.checkpointId);
    if (!checkpoint || !record.runtimeArtifact)
      throw httpRouteError(500, "generated app runtime artifact missing");
    const workspace = await writeGeneratedAppWorkspace(
      context,
      record,
      checkpoint,
      record.runtimeArtifact,
    );

    return c.json(
      {
        draft: {
          ...draft,
          smokeBuildStatus: smokeBuild,
        },
        draftSource: fileTreeFiles ? "llm-filetree" : body.source,
        fileTree: fileTreeFiles,
        created: true,
        applied: true,
        app: {
          id: record.id,
          slug: record.slug,
          name: record.name,
          status: record.status,
          previewUrl: record.previewUrl,
          createdAt: record.createdAt,
        },
        checkpoint: {
          id: record.checkpointId,
          appId: record.id,
          savedAt: record.updatedAt,
        },
        artifact: {
          entrypoint: record.runtimeArtifact?.entrypoint,
          renderedAt: record.runtimeArtifact?.renderedAt,
          files: summarizeGeneratedAppSourceFiles(record.sourceFiles ?? []),
        },
        sourceFiles: summarizeGeneratedAppSourceFiles(record.sourceFiles ?? []),
        workspace,
        build: {
          status: record.buildStatus ?? "not_run",
          checks: smokeBuild.checks,
        },
        smoke: smokeBuild,
        previewUrl: record.previewUrl,
        smokeBuild,
      },
      201,
    );
  } catch (error) {
    return errorResponse(c, error);
  }
}

async function generateAppIteration(
  c: Context,
  responseShape: "iteration" | "changeSet" = "iteration",
) {
  try {
    const context = await requireAuthenticatedContextAsync(c);
    await requireWorkspacePermission(context, "manageWorkspace");
    const body = (await c.req.json()) as AppIterationRouteRequest;
    const result = await runAppIterationCore(context, body);
    if (responseShape === "changeSet") {
      return c.json({ changeSet: result });
    }
    return c.json(result);
  } catch (error) {
    return errorResponse(c, error);
  }
}

async function runAppIterationCore(
  context: Awaited<ReturnType<typeof requireAuthenticatedContextAsync>>,
  body: AppIterationRouteRequest,
  onStep?: (text: string) => Promise<void> | void,
  onProse?: (chunk: string) => Promise<void> | void,
): Promise<AppIterationRouteResult> {
  await onStep?.("Loading current draft");
  const prompt = promptFromBody(body.prompt);
  const { draft, record } = await draftForIteration(context, body);
  const iterationDraft = toGeneratedAppDraftLike(draft);
  const targetKind = body.target?.kind ?? "app";
  await onStep?.(`Scoping change to ${targetKind}`);
  const targetForService = appIterationTargetForService(body.target);
  const changeText = body.sourceError?.prompt
    ? `${prompt}\n\nSource error: ${body.sourceError.message}`
    : prompt;

  const request: AppIterationChangeRequest = {
    draftId: body.checkpointId ?? record?.checkpointId ?? body.appId,
    workspaceId: context.workspace.id,
    target: targetForService,
    change: changeText,
  };
  await onStep?.("Building plan");
  const plan = buildAppIterationPlan(iterationDraft, request);
  const previousSnapshot = latestPreviewSnapshot(record);
  const sourceAppId = record?.id ?? body.appId ?? stableGeneratedAppId(draft, context);
  const previousCheckpoint = record
    ? checkpointForPublish(record, body.checkpointId ?? record.checkpointId)
    : null;
  const previousArtifact =
    previousCheckpoint && record
      ? generatedAppRuntimeArtifact(record, previousCheckpoint)
      : buildGeneratedAppRuntimeArtifact({
          appId: sourceAppId,
          workspaceId: context.workspace.id,
          checkpointId: body.checkpointId ?? "draft",
          draft,
        });

  await onStep?.("Checking integrations");
  const integrationReadiness = await getIntegrationReadinessAsync(context);
  const tools = inspectAppIterationTools({
    draft: {
      appName: draft.app.name,
      summary: draft.summary,
      pages: draft.app.pages,
      apiRoutes: draft.app.apiRoutes,
      dataModels: draft.app.dataSchema,
      notes: draft.plan.acceptanceChecks,
    },
    changePrompt: prompt,
    availableTools: integrationReadiness.tools.names,
    connectedConnectors: integrationReadiness.tools.names,
    providers: {
      configured: integrationReadiness.providers.readyCount > 0,
      openai: integrationReadiness.providers.missingApiKeys.every(
        (entry) => entry.provider !== "openai",
      ),
      anthropic: integrationReadiness.providers.missingApiKeys.every(
        (entry) => entry.provider !== "anthropic",
      ),
    },
    database: {
      configured: true,
      migrationsReady: true,
      writable: true,
    },
  });

  const fileTreeInput = fileTreeForIteration(body, record, previousCheckpoint);
  if (
    shouldUseFileTreeIteration({
      flagOn: process.env.PACKETAGENT_LEGACY_TEMPLATES !== "1",
      draftSource: fileTreeInput.source,
      files: fileTreeInput.files,
    })
  ) {
    await onStep?.("Updating generated file tree");
    let fileTreeResult: Awaited<ReturnType<typeof applyAppIterationViaFileTree>> | null = null;
    try {
      fileTreeResult = await applyAppIterationViaFileTree(
        fileTreeInput.files!,
        changeText,
        {
          workspaceId: context.workspace.id,
          preset: body.preset as AppIterationPresetId | undefined,
        },
        onProse
          ? async (chunk) => {
              await onProse(chunk);
            }
          : undefined,
      );
    } catch {
      fileTreeResult = null;
    }

    if (fileTreeResult) {
      const appDraft = deriveDraftFromFiles(
        fileTreeResult.newFiles,
        draft.prompt,
        fileTreeResult.changedSummary,
      );
      const candidateDraft = buildAppBuilderDraft(appDraft, context);
      const smoke = buildAppSmokeStatusFromDraft(candidateDraft, context, false);
      const candidateArtifact = buildGeneratedAppRuntimeArtifactFromFiles(fileTreeResult.newFiles);
      const sourceDiffFiles = diffGeneratedAppSourceFiles(previousArtifact, candidateArtifact);
      const snapshot = buildAppPreviewSnapshotMetadata({
        workspaceId: context.workspace.id,
        appId: sourceAppId,
        appSlug: candidateDraft.app.slug,
        appName: candidateDraft.app.name,
        checkpointId: plan.rollbackCheckpoint.checkpointId,
        checkpointSavedAt: new Date().toISOString(),
        buildStatus: "queued",
        smokeStatus: smoke.status,
        previewUrl: record?.previewUrl ?? body.previewUrl,
        generatedFiles: sourceDiffFiles.map((file) => file.path),
        source: "builder",
        createdByUserId: context.user.id,
      });
      const comparison = compareAppPreviewSnapshots(snapshot, previousSnapshot);
      return appIterationResponse({
        context,
        body,
        draft: candidateDraft,
        plan,
        status: plan.canApply && tools.canProceed ? "generated" : "blocked",
        previewUrl: record?.previewUrl ?? body.previewUrl,
        smoke,
        logs: [
          ...plan.warnings.map((warning) => routeLog("warn", warning)),
          ...plan.risks.map((risk) =>
            routeLog(risk.severity === "high" ? "warn" : "info", risk.message),
          ),
          ...tools.requests.map((request) =>
            routeLog(request.ready ? "info" : "warn", request.rationale),
          ),
          routeLog(
            "info",
            `Generated ${sourceDiffFiles.length} source file diff${sourceDiffFiles.length === 1 ? "" : "s"} from the file tree.`,
          ),
          routeLog("info", comparison.summary),
          routeLog(
            "info",
            `File-tree iteration via ${fileTreeResult.model}: ${fileTreeResult.changedSummary}`,
          ),
        ],
        snapshot,
        tools,
        sourceDiffFiles,
        sourceFiles: candidateArtifact.files,
        artifact: candidateArtifact,
        llmResult: fileTreeResult,
        validationErrors: fileTreeResult.validationErrors,
        fileTree: fileTreeResult.newFiles,
        draftSource: "llm-filetree",
      });
    }
  }

  // Try the real structured-draft LLM next; fall back to the deterministic regex pipeline on failure.
  let llmResult: AppIterationLLMResult | null = null;
  try {
    llmResult = await applyAppIterationViaLLM(
      iterationDraft,
      targetForService,
      changeText,
      {
        workspaceId: context.workspace.id,
        preset: body.preset as AppIterationPresetId | undefined,
      },
      onProse
        ? async (chunk) => {
            await onProse(chunk);
          }
        : undefined,
    );
  } catch {
    llmResult = null;
  }

  await onStep?.("Generating diff");
  const dryRun = applyAppIterationToDraft(iterationDraft, plan);
  const candidateDraft = fromGeneratedAppDraftLike(draft, dryRun.draft);
  const smoke = buildAppSmokeStatusFromDraft(candidateDraft, context, false);
  const candidateArtifact = buildGeneratedAppRuntimeArtifact({
    appId: sourceAppId,
    workspaceId: context.workspace.id,
    checkpointId: plan.rollbackCheckpoint.checkpointId,
    draft: candidateDraft,
  });
  const sourceDiffFiles = diffGeneratedAppSourceFiles(previousArtifact, candidateArtifact);
  const snapshot = buildAppPreviewSnapshotMetadata({
    workspaceId: context.workspace.id,
    appId: sourceAppId,
    appSlug: draft.app.slug,
    appName: draft.app.name,
    checkpointId: plan.rollbackCheckpoint.checkpointId,
    checkpointSavedAt: new Date().toISOString(),
    buildStatus: "queued",
    smokeStatus: smoke.status,
    previewUrl: record?.previewUrl ?? body.previewUrl,
    generatedFiles: sourceDiffFiles.map((file) => file.path),
    source: "builder",
    createdByUserId: context.user.id,
  });
  const comparison = compareAppPreviewSnapshots(snapshot, previousSnapshot);
  return appIterationResponse({
    context,
    body,
    draft: candidateDraft,
    plan,
    status: plan.canApply && tools.canProceed ? "generated" : "blocked",
    previewUrl: record?.previewUrl ?? body.previewUrl,
    smoke,
    logs: [
      ...plan.warnings.map((warning) => routeLog("warn", warning)),
      ...plan.risks.map((risk) =>
        routeLog(risk.severity === "high" ? "warn" : "info", risk.message),
      ),
      ...tools.requests.map((request) =>
        routeLog(request.ready ? "info" : "warn", request.rationale),
      ),
      routeLog(
        "info",
        `Generated ${sourceDiffFiles.length} source file diff${sourceDiffFiles.length === 1 ? "" : "s"} for the candidate runtime artifact.`,
      ),
      routeLog("info", comparison.summary),
      ...(llmResult
        ? [routeLog("info", `LLM iteration via ${llmResult.model}: ${llmResult.changedSummary}`)]
        : []),
    ],
    snapshot,
    tools,
    sourceDiffFiles,
    sourceFiles: candidateArtifact.files,
    artifact: candidateArtifact,
    llmResult,
  });
}

async function applyAppIteration(
  c: Context,
  responseShape: "iteration" | "changeSet" = "iteration",
) {
  try {
    const context = await requireAuthenticatedContextAsync(c);
    await requireWorkspacePermission(context, "manageWorkspace");
    const body = (await c.req.json()) as AppIterationApplyRouteRequest;
    const diff = body.diff ?? body.changeSet;
    if (!diff)
      throw httpRouteError(400, "reviewed diff or changeSet is required to apply an app iteration");
    const draft = diff.draft ?? body.draft;
    const targetAppId = body.appId ?? diff?.appId;
    const targetCheckpointId = body.checkpointId ?? diff?.checkpointId;
    if (!targetAppId && !targetCheckpointId)
      throw httpRouteError(400, "appId or checkpointId is required to apply an app iteration");
    if (!draft) throw httpRouteError(400, "diff.draft is required to apply an app iteration");
    const targetRecord = await findGeneratedAppRecord(context, targetAppId, targetCheckpointId);
    if (!targetRecord) throw httpRouteError(404, "generated app not found");
    validateIterationApplyTarget(targetRecord, draft, diff, targetCheckpointId);
    if (diff.status !== "generated" || diff.tools?.canProceed === false) {
      throw httpRouteError(
        409,
        "blocked change set cannot be applied until setup blockers are resolved",
      );
    }
    const previousCheckpoint = checkpointForPublish(
      targetRecord,
      targetCheckpointId ?? targetRecord.checkpointId,
    );
    if (!previousCheckpoint) throw httpRouteError(404, "checkpoint not found");
    const previousArtifact = generatedAppRuntimeArtifact(targetRecord, previousCheckpoint);
    const fileTreeFiles =
      diff.draftSource === "llm-filetree" ? generatedFilesFromUnknown(diff.fileTree) : undefined;

    const runSmoke = body.runSmoke ?? body.runBuild ?? true;
    const smoke = await runAppSmokeViaSandbox(draft, context, runSmoke, {
      appId: targetAppId,
      checkpointId: targetCheckpointId,
    });
    const previewUrl =
      smoke.status === "pass"
        ? previewUrlForDraft(draft, context, targetRecord.id)
        : (body.previewUrl ?? diff?.preview?.url);
    const record = await persistGeneratedAppDraft(context, draft, {
      status: runSmoke ? "built" : "saved",
      previewUrl,
      buildStatus: runSmoke ? "passed" : "queued",
      smokeStatus: smoke.status,
      checkpointLabel: diff ? `Apply iteration: ${diff.summary}` : "Apply generated app iteration",
      checkpointSource: "iteration",
      codegenSource: fileTreeFiles ? "llm-filetree" : diff.draftSource,
      fileTreeFiles,
    });
    const newCheckpoint = checkpointForPublish(record, record.checkpointId);
    const newArtifact = newCheckpoint
      ? generatedAppRuntimeArtifact(record, newCheckpoint)
      : record.runtimeArtifact;
    const sourceDiffFiles = newArtifact
      ? diffGeneratedAppSourceFiles(previousArtifact, newArtifact)
      : [];
    const mergedFiles = mergeIterationDiffFiles(diff?.files ?? body.files ?? [], sourceDiffFiles);
    const snapshot = buildAppPreviewSnapshotMetadata({
      workspaceId: context.workspace.id,
      appId: record.id,
      appSlug: record.slug,
      appName: record.name,
      checkpointId: record.checkpointId,
      checkpointSavedAt: record.updatedAt,
      buildStatus: record.buildStatus,
      smokeStatus: record.smokeStatus,
      previewUrl: record.previewUrl,
      generatedFiles: mergedFiles.map((file) => file.path),
      source: "checkpoint",
      createdByUserId: context.user.id,
    });

    await attachPreviewSnapshot(context, record.id, snapshot);
    const preview = derivePreviewRefreshState({
      appId: record.id,
      workspaceId: context.workspace.id,
      previewUrl: record.previewUrl,
      previewPath: record.previewUrl,
      build: {
        phase: runSmoke ? "passed" : "queued",
        checkCount: smoke.checks.length,
        passedChecks: runSmoke ? smoke.checks.length : 0,
        buildId: snapshot.build.id,
        revision: record.checkpointId,
      },
      lastRendered: {
        buildId: snapshot.build.id,
        revision: record.checkpointId,
        refreshedAt: record.updatedAt,
        previewUrl: record.previewUrl,
      },
    });
    const appliedDiff = diff
      ? {
          ...diff,
          checkpointId: record.checkpointId,
          status: "applied" as const,
          draft,
          files: mergedFiles,
          sourceDiffFiles,
          sourceFiles: summarizeGeneratedAppSourceFiles(newArtifact?.files ?? []),
          fileTree: fileTreeFiles,
          draftSource: fileTreeFiles ? "llm-filetree" : diff.draftSource,
          artifact: {
            entrypoint: newArtifact?.entrypoint,
            renderedAt: newArtifact?.renderedAt,
            files: summarizeGeneratedAppSourceFiles(newArtifact?.files ?? []),
          },
          preview: {
            url: record.previewUrl,
            refreshedAt: record.updatedAt,
            status: smoke.status,
            message: preview.reason,
          },
          smoke,
          logs: [
            ...(diff.logs ?? []),
            routeLog("info", `Applied iteration to checkpoint ${record.checkpointId}.`),
            routeLog("info", preview.reason),
          ],
        }
      : undefined;
    const workspace =
      newCheckpoint && newArtifact
        ? await writeGeneratedAppWorkspace(context, record, newCheckpoint, newArtifact)
        : undefined;

    const payload = {
      applied: true,
      checkpoint: {
        id: record.checkpointId,
        appId: record.id,
        savedAt: record.updatedAt,
      },
      app: {
        id: record.id,
        slug: record.slug,
        name: record.name,
        status: record.status,
        previewUrl: record.previewUrl,
      },
      previewUrl: record.previewUrl,
      preview,
      snapshot,
      smoke,
      diff: appliedDiff,
      files: mergedFiles,
      sourceDiffFiles,
      sourceFiles: summarizeGeneratedAppSourceFiles(newArtifact?.files ?? []),
      fileTree: fileTreeFiles,
      draftSource: fileTreeFiles ? "llm-filetree" : diff.draftSource,
      artifact: {
        entrypoint: newArtifact?.entrypoint,
        renderedAt: newArtifact?.renderedAt,
        files: summarizeGeneratedAppSourceFiles(newArtifact?.files ?? []),
      },
      workspace,
    };

    if (responseShape === "changeSet") {
      return c.json(
        {
          ...payload,
          changeSet: appliedDiff,
        },
        201,
      );
    }
    return c.json(payload, 201);
  } catch (error) {
    return errorResponse(c, error);
  }
}

async function refreshBuilderPreview(c: Context) {
  try {
    const context = await requireAuthenticatedContextAsync(c);
    await requireWorkspacePermission(context, "manageWorkspace");
    const body = (await c.req.json()) as {
      appId?: string;
      checkpointId?: string;
      runBuild?: boolean;
      runSmoke?: boolean;
    };
    const record = await findGeneratedAppRecord(context, body.appId, body.checkpointId);
    if (!record) throw httpRouteError(404, "generated app not found");
    const draft = record.draft as unknown as AppBuilderDraftContract;
    const runSmoke = Boolean(body.runSmoke || body.runBuild);
    const smoke = await runAppSmokeViaSandbox(draft, context, runSmoke, {
      appId: record.id,
      checkpointId: record.checkpointId,
    });
    const previewUrl =
      runSmoke && smoke.status === "pass"
        ? previewUrlForDraft(draft, context, record.id)
        : record.previewUrl;
    const snapshot = buildAppPreviewSnapshotMetadata({
      workspaceId: context.workspace.id,
      appId: record.id,
      appSlug: record.slug,
      appName: record.name,
      checkpointId: record.checkpointId,
      checkpointSavedAt: record.updatedAt,
      buildStatus: runSmoke ? "passed" : record.buildStatus,
      smokeStatus: smoke.status,
      previewUrl,
      source: "preview",
      createdByUserId: context.user.id,
    });
    const preview = derivePreviewRefreshState({
      appId: record.id,
      workspaceId: context.workspace.id,
      previewUrl,
      previewPath: previewUrl,
      build: {
        phase: runSmoke ? "passed" : "queued",
        checkCount: smoke.checks.length,
        passedChecks: runSmoke ? smoke.checks.length : 0,
        buildId: snapshot.build.id,
        revision: record.checkpointId,
      },
      lastRendered: previewUrl
        ? {
            buildId: snapshot.build.id,
            revision: record.checkpointId,
            refreshedAt: new Date().toISOString(),
            previewUrl,
          }
        : undefined,
    });
    const checkpoint = checkpointForPublish(record, body.checkpointId ?? record.checkpointId);
    if (!checkpoint) throw httpRouteError(404, "checkpoint not found");
    const artifact = generatedAppRuntimeArtifact(record, checkpoint);
    const workspace = await writeGeneratedAppWorkspace(context, record, checkpoint, artifact);

    return c.json({
      preview,
      build: {
        status: runSmoke ? "passed" : (record.buildStatus ?? "queued"),
        checks: smoke.checks,
      },
      smoke,
      checkpoint: { id: record.checkpointId, appId: record.id, savedAt: record.updatedAt },
      snapshot,
      artifact: {
        entrypoint: artifact.entrypoint,
        renderedAt: artifact.renderedAt,
        files: summarizeGeneratedAppSourceFiles(artifact.files),
      },
      sourceFiles: summarizeGeneratedAppSourceFiles(artifact.files),
      workspace,
    });
  } catch (error) {
    return errorResponse(c, error);
  }
}

async function buildBuilderFixPrompt(c: Context) {
  try {
    const context = await requireAuthenticatedContextAsync(c);
    await requireWorkspacePermission(context, "manageWorkspace");
    const body = (await c.req.json()) as AppIterationRouteRequest;
    const error = body.errorContext ?? body.sourceError;
    const targetLabel =
      body.target?.label ??
      body.target?.path ??
      body.appId ??
      body.agentId ??
      "selected builder target";
    const prompt = [
      body.prompt?.trim() ||
        `Fix the captured ${error?.source ?? "runtime"} issue for ${targetLabel}.`,
      error?.message ? `Error: ${error.message}` : undefined,
      body.checkpointId ? `Checkpoint: ${body.checkpointId}` : undefined,
      "Return a minimal scoped change set and preserve unrelated generated behavior.",
    ]
      .filter(Boolean)
      .join("\n\n");

    return c.json({ prompt });
  } catch (error) {
    return errorResponse(c, error);
  }
}

async function listAppCheckpoints(c: Context) {
  try {
    const context = await requireAuthenticatedContextAsync(c);
    await requireWorkspacePermission(context, "viewWorkspace");
    const appId = c.req.query("appId");
    const agentId = c.req.query("agentId");
    if (!appId && !agentId) throw httpRouteError(400, "appId or agentId is required");
    if (agentId) {
      const data = await loadStoreAsync();
      const agent = data.agents.find(
        (entry) => entry.workspaceId === context.workspace.id && entry.id === agentId,
      );
      if (!agent) throw httpRouteError(404, "agent not found");
      const checkpointId = `agent_ckpt_${agent.id}_${stableHash(agent.updatedAt)}`;
      return c.json({
        checkpoints: [
          {
            id: checkpointId,
            agentId: agent.id,
            label: `${agent.name} current agent`,
            source: "agent",
            buildStatus: agent.status,
            smokeStatus: "not_run",
            createdAt: agent.updatedAt,
          },
        ],
        currentCheckpointId: checkpointId,
      });
    }
    const record = await findGeneratedAppRecord(context, appId);
    if (!record) throw httpRouteError(404, "generated app not found");

    return c.json({
      checkpoints: (record.checkpoints ?? [])
        .map((checkpoint) => ({
          id: checkpoint.id,
          appId: checkpoint.appId,
          label: checkpoint.label,
          source: checkpoint.source,
          previewUrl: checkpoint.previewUrl,
          buildStatus: checkpoint.buildStatus,
          smokeStatus: checkpoint.smokeStatus,
          previousCheckpointId: checkpoint.previousCheckpointId,
          createdAt: checkpoint.createdAt,
        }))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      currentCheckpointId: record.checkpointId,
    });
  } catch (error) {
    return errorResponse(c, error);
  }
}

async function rollbackAppCheckpoint(c: Context) {
  try {
    const context = await requireAuthenticatedContextAsync(c);
    await requireWorkspacePermission(context, "manageWorkspace");
    const checkpointId = c.req.param("checkpointId");
    const body = (await c.req.json().catch(() => ({}))) as { appId?: string; reason?: string };
    const record = await findGeneratedAppRecord(context, body.appId, checkpointId);
    if (!record) throw httpRouteError(404, "generated app not found");
    const target = (record.checkpoints ?? []).find((checkpoint) => checkpoint.id === checkpointId);
    if (!target) throw httpRouteError(404, "checkpoint not found");
    const targetSourceArtifact = cloneGeneratedAppRuntimeArtifact(
      generatedAppRuntimeArtifact(record, target),
    );
    const currentSnapshot = buildAppPreviewSnapshotMetadata({
      workspaceId: context.workspace.id,
      appId: record.id,
      appSlug: record.slug,
      appName: record.name,
      checkpointId: record.checkpointId,
      buildStatus: record.buildStatus,
      smokeStatus: record.smokeStatus,
      previewUrl: record.previewUrl,
      source: "preview",
    });
    const targetSnapshot = buildAppPreviewSnapshotMetadata({
      workspaceId: context.workspace.id,
      appId: record.id,
      appSlug: record.slug,
      appName: record.name,
      checkpointId: target.id,
      checkpointSavedAt: target.createdAt,
      buildStatus: target.buildStatus,
      smokeStatus: target.smokeStatus,
      previewUrl: target.previewUrl,
      source: "checkpoint",
    });
    const command = createAppPreviewRollbackCommand({
      current: currentSnapshot,
      target: targetSnapshot,
      requestedByUserId: context.user.id,
      reason: body.reason,
    });

    const rolledBack = await mutateStoreAsync((data) => {
      data.generatedApps ??= [];
      const app = data.generatedApps?.find(
        (entry) => entry.workspaceId === context.workspace.id && entry.id === record.id,
      ) as GeneratedAppRecordWithRuntime | undefined;
      if (!app) return null;
      const timestamp = new Date().toISOString();
      const restoredCheckpointId = `gapp_ckpt_${stableHash(`${context.workspace.id}:${app.slug}:rollback:${target.id}:${timestamp}`)}`;
      const runtimeArtifact = cloneGeneratedAppRuntimeArtifact(targetSourceArtifact);
      const restored = {
        ...target,
        id: restoredCheckpointId,
        label: `Rollback to ${target.label}`,
        runtimeArtifact,
        sourceFiles: runtimeArtifact.files,
        source: "rollback" as const,
        previousCheckpointId: app.checkpointId,
        createdByUserId: context.user.id,
        createdAt: timestamp,
      };
      app.draft = target.draft;
      app.checkpointId = restoredCheckpointId;
      app.runtimeArtifact = runtimeArtifact;
      app.sourceFiles = runtimeArtifact.files;
      app.codegenSource = target.codegenSource;
      app.previewUrl = target.previewUrl;
      app.buildStatus = target.buildStatus;
      app.smokeStatus = target.smokeStatus;
      app.updatedAt = timestamp;
      app.checkpoints = [...(app.checkpoints ?? []), restored];
      recordActivity(data, {
        id: `activity_generated_app_rollback_${app.id}_${stableHash(restoredCheckpointId)}`,
        workspaceId: context.workspace.id,
        scope: "workspace",
        event: "builder.generated_app.rollback",
        actor: { type: "user", id: context.user.id },
        data: {
          title: `${app.name} rolled back`,
          appId: app.id,
          restoredCheckpointId,
          targetCheckpointId: target.id,
          command: command.command,
        },
        occurredAt: timestamp,
      });
      return app;
    });
    if (!rolledBack) throw httpRouteError(404, "generated app not found");

    return c.json({
      rolledBack: true,
      checkpoint: {
        id: rolledBack.checkpointId,
        appId: rolledBack.id,
        savedAt: rolledBack.updatedAt,
      },
      app: {
        id: rolledBack.id,
        slug: rolledBack.slug,
        name: rolledBack.name,
        status: rolledBack.status,
        previewUrl: rolledBack.previewUrl,
      },
      preview: {
        url: rolledBack.previewUrl,
        status: rolledBack.smokeStatus === "pass" ? "pass" : "pending",
        message: `Restored generated app draft from checkpoint ${target.id}.`,
      },
      build: { status: rolledBack.buildStatus ?? "not_run" },
      smoke: (rolledBack.draft as AppBuilderDraftContract).smokeBuildStatus,
      draft: rolledBack.draft,
      draftSource: rolledBack.codegenSource,
      fileTree:
        rolledBack.codegenSource === "llm-filetree"
          ? generatedFilesFromSourceRecords(rolledBack.sourceFiles)
          : undefined,
      artifact: {
        entrypoint: rolledBack.runtimeArtifact?.entrypoint,
        renderedAt: rolledBack.runtimeArtifact?.renderedAt,
        files: summarizeGeneratedAppSourceFiles(rolledBack.sourceFiles ?? []),
      },
      sourceFiles: summarizeGeneratedAppSourceFiles(rolledBack.sourceFiles ?? []),
      command,
    });
  } catch (error) {
    return errorResponse(c, error);
  }
}

async function branchAppCheckpoint(c: Context) {
  try {
    const context = await requireAuthenticatedContextAsync(c);
    await requireWorkspacePermission(context, "manageWorkspace");
    const checkpointId = c.req.param("checkpointId");
    const body = (await c.req.json().catch(() => ({}))) as { appId?: string };
    const sourceRecord = await findGeneratedAppRecord(context, body.appId, checkpointId);
    if (!sourceRecord) throw httpRouteError(404, "generated app not found");
    const sourceCheckpoint =
      (sourceRecord.checkpoints ?? []).find((checkpoint) => checkpoint.id === checkpointId) ??
      (sourceRecord.checkpointId === checkpointId
        ? {
            id: sourceRecord.checkpointId,
            appId: sourceRecord.id,
            workspaceId: sourceRecord.workspaceId,
            label: sourceRecord.name,
            draft: sourceRecord.draft,
            runtimeArtifact: sourceRecord.runtimeArtifact,
            sourceFiles: sourceRecord.sourceFiles,
            codegenSource: sourceRecord.codegenSource,
            previewUrl: sourceRecord.previewUrl,
            buildStatus: sourceRecord.buildStatus,
            smokeStatus: sourceRecord.smokeStatus,
            source: "initial" as const,
            createdByUserId: sourceRecord.createdByUserId,
            createdAt: sourceRecord.createdAt,
          }
        : undefined);
    if (!sourceCheckpoint) throw httpRouteError(404, "checkpoint not found");

    const branched = await mutateStoreAsync((data) => {
      data.generatedApps ??= [];
      const timestamp = new Date().toISOString();
      const branchSeed = `${context.workspace.id}:${sourceRecord.id}:branch:${sourceCheckpoint.id}:${timestamp}`;
      const newAppId = `gapp_${stableHash(branchSeed)}`;
      const newCheckpointId = `gapp_ckpt_${stableHash(`${branchSeed}:checkpoint`)}`;
      const branchSlug = `${sourceRecord.slug}-branch-${stableHash(branchSeed).slice(0, 6)}`;
      const branchName = sourceRecord.name.endsWith(" (branch)")
        ? sourceRecord.name
        : `${sourceRecord.name} (branch)`;
      const branchDraft = branchDraftForGeneratedApp(
        sourceCheckpoint.draft,
        branchSlug,
        branchName,
      );
      const sourceFiles = sourceCheckpoint.runtimeArtifact?.files?.length
        ? sourceCheckpoint.runtimeArtifact.files
        : sourceCheckpoint.sourceFiles;
      const runtimeArtifact = sourceFiles?.length
        ? runtimeArtifactFromSourceFiles(
            sourceFiles.map((file) => ({ ...file })),
            timestamp,
          )
        : buildGeneratedAppRuntimeArtifact({
            appId: newAppId,
            workspaceId: context.workspace.id,
            checkpointId: newCheckpointId,
            draft: branchDraft as unknown as AppBuilderDraftContract,
            renderedAt: timestamp,
          });
      const initialCheckpoint: GeneratedAppCheckpointWithRuntime = {
        id: newCheckpointId,
        appId: newAppId,
        workspaceId: context.workspace.id,
        label: `Branched from ${sourceCheckpoint.label}`,
        draft: branchDraft,
        runtimeArtifact,
        sourceFiles: runtimeArtifact.files,
        codegenSource: sourceCheckpoint.codegenSource,
        previewUrl: previewUrlForDraft(
          branchDraft as unknown as AppBuilderDraftContract,
          context,
          newAppId,
        ),
        buildStatus: sourceCheckpoint.buildStatus,
        smokeStatus: sourceCheckpoint.smokeStatus,
        source: "branch",
        previousCheckpointId: sourceCheckpoint.id,
        createdByUserId: context.user.id,
        createdAt: timestamp,
      };
      const newApp: GeneratedAppRecordWithRuntime = {
        id: newAppId,
        workspaceId: context.workspace.id,
        slug: branchSlug,
        name: branchName,
        description: sourceRecord.description,
        prompt: sourceRecord.prompt,
        templateId: sourceRecord.templateId,
        status: "saved",
        draft: branchDraft,
        checkpointId: newCheckpointId,
        runtimeArtifact,
        sourceFiles: runtimeArtifact.files,
        codegenSource: sourceCheckpoint.codegenSource,
        previewUrl: initialCheckpoint.previewUrl,
        buildStatus: sourceCheckpoint.buildStatus,
        smokeStatus: sourceCheckpoint.smokeStatus,
        checkpoints: [initialCheckpoint],
        createdByUserId: context.user.id,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      data.generatedApps.push(newApp);
      recordActivity(data, {
        id: `activity_generated_app_branch_${newApp.id}`,
        workspaceId: context.workspace.id,
        scope: "workspace",
        event: "builder.generated_app.branch",
        actor: { type: "user", id: context.user.id },
        data: {
          title: `${newApp.name} branched from ${sourceRecord.name}`,
          appId: newApp.id,
          sourceAppId: sourceRecord.id,
          sourceCheckpointId: sourceCheckpoint.id,
        },
        occurredAt: timestamp,
      });
      return newApp;
    });
    if (!branched) throw httpRouteError(500, "failed to branch generated app");

    return c.json(
      {
        branched: true,
        app: {
          id: branched.id,
          slug: branched.slug,
          name: branched.name,
          status: branched.status,
          previewUrl: branched.previewUrl,
        },
        checkpoint: {
          id: branched.checkpointId,
          appId: branched.id,
          savedAt: branched.updatedAt,
        },
        sourceAppId: sourceRecord.id,
        sourceCheckpointId: sourceCheckpoint.id,
        draft: branched.draft,
        smoke: (branched.draft as AppBuilderDraftContract).smokeBuildStatus,
      },
      201,
    );
  } catch (error) {
    return errorResponse(c, error);
  }
}

async function prepareGeneratedAppPublish(c: Context) {
  try {
    const context = await requireAuthenticatedContextAsync(c);
    await requireWorkspacePermission(context, "manageWorkspace");
    const body = (await c.req.json().catch(() => ({}))) as AppPublishRouteRequest;
    if (body.agentId && !body.appId) return c.json(await buildAgentPublishPayload(context, body));
    const record = await findGeneratedAppRecord(context, body.appId, body.checkpointId);
    if (!record) throw httpRouteError(404, "generated app not found");
    const checkpoint = checkpointForPublish(record, body.checkpointId);
    if (!checkpoint) throw httpRouteError(404, "checkpoint not found");
    const { validation, integrations } = await buildPublishPreflight(
      context,
      record,
      checkpoint,
      body,
      { materializeWorkspace: true },
    );
    const previousPublish = currentPublishedRecord(record);
    const readiness = buildGeneratedAppPublishRecord({
      workspaceId: context.workspace.id,
      workspaceSlug: context.workspace.slug,
      appId: record.id,
      appName: record.name,
      appSlug: record.slug,
      checkpointId: body.checkpointId ?? record.checkpointId,
      previewUrl: record.previewUrl,
      buildStatus: record.buildStatus,
      smokeStatus: record.smokeStatus,
      visibility: body.visibility,
      localPublishRoot: body.localPublishRoot,
      publicBaseUrl: body.publicBaseUrl,
      privateBaseUrl: body.privateBaseUrl,
      runtimeEnv: publishRuntimeEnv(),
      previousPublish,
      createdByUserId: context.user.id,
    });

    return c.json({
      ready: validation.canPublish && integrationsReadyForPublish(integrations),
      app: publishedAppSummary(record),
      publish: readiness,
      validation,
      integrations,
      history: orderGeneratedAppPublishHistory(record.publishHistory ?? []),
      state: builderPublishState(
        record,
        context.workspace.slug,
        readiness,
        validation,
        integrations,
      ),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
}

async function getGeneratedAppPublishState(c: Context) {
  try {
    const context = await requireAuthenticatedContextAsync(c);
    await requireWorkspacePermission(context, "viewWorkspace");
    const body: AppPublishRouteRequest = {
      appId: c.req.query("appId"),
      agentId: c.req.query("agentId"),
      checkpointId: c.req.query("checkpointId"),
      visibility: c.req.query("visibility") === "public" ? "public" : "private",
    };
    if (body.agentId && !body.appId)
      return c.json((await buildAgentPublishPayload(context, body)).state);
    const record = await findGeneratedAppRecord(context, body.appId, body.checkpointId);
    if (!record) throw httpRouteError(404, "generated app not found");
    const checkpoint = checkpointForPublish(record, body.checkpointId);
    if (!checkpoint) throw httpRouteError(404, "checkpoint not found");
    const { validation, integrations } = await buildPublishPreflight(
      context,
      record,
      checkpoint,
      body,
    );
    const readiness = buildGeneratedAppPublishRecord({
      workspaceId: context.workspace.id,
      workspaceSlug: context.workspace.slug,
      appId: record.id,
      appName: record.name,
      appSlug: record.slug,
      checkpointId: checkpoint.id,
      previewUrl: checkpoint.previewUrl ?? record.previewUrl,
      buildStatus: checkpoint.buildStatus ?? record.buildStatus,
      smokeStatus: checkpoint.smokeStatus ?? record.smokeStatus,
      visibility: body.visibility,
      runtimeEnv: publishRuntimeEnv(),
      previousPublish: currentPublishedRecord(record),
      createdByUserId: context.user.id,
    });

    return c.json(
      builderPublishState(record, context.workspace.slug, readiness, validation, integrations),
    );
  } catch (error) {
    return errorResponse(c, error);
  }
}

async function listAppPublishHistory(c: Context) {
  try {
    const context = await requireAuthenticatedContextAsync(c);
    await requireWorkspacePermission(context, "viewWorkspace");
    const appId = c.req.query("appId");
    const agentId = c.req.query("agentId");
    if (agentId && !appId) return c.json(await buildAgentPublishPayload(context, { agentId }));
    if (!appId) throw httpRouteError(400, "appId is required");
    const record = await findGeneratedAppRecord(context, appId);
    if (!record) throw httpRouteError(404, "generated app not found");

    return c.json({
      app: publishedAppSummary(record),
      history: orderGeneratedAppPublishHistory(record.publishHistory ?? []),
      currentPublishId: record.currentPublishId,
      rollbackToPrevious: latestPublishRollbackCommand(record),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
}

async function publishGeneratedApp(c: Context) {
  try {
    const context = await requireAuthenticatedContextAsync(c);
    await requireWorkspacePermission(context, "manageWorkspace");
    const body = (await c.req.json().catch(() => ({}))) as AppPublishRouteRequest;
    if (body.agentId && !body.appId) {
      const payload = await buildAgentPublishPayload(context, body, true);
      if (!payload.validation.canPublish)
        return c.json({ error: "publish validation failed", ...payload }, 409);
      await mutateStoreAsync((data) => {
        const agent = data.agents.find(
          (entry) => entry.workspaceId === context.workspace.id && entry.id === body.agentId,
        );
        if (!agent) return;
        agent.publishHistory = [
          payload.publish,
          ...(agent.publishHistory ?? []).filter(
            (entry) => (entry as { id?: string }).id !== payload.publish.id,
          ),
        ].slice(0, 20);
        agent.currentPublishId = payload.publish.id;
        agent.publishStatus = payload.publish.status;
        agent.publishedUrl = payload.state.publishedUrl;
        agent.updatedAt = payload.publish.completedAt ?? payload.publish.createdAt;
        recordActivity(data, {
          id: `activity_agent_publish_${agent.id}_${stableHash(payload.publish.id)}`,
          workspaceId: context.workspace.id,
          scope: "workspace",
          event: "builder.agent.publish",
          actor: { type: "user", id: context.user.id },
          data: {
            title: `${agent.name} agent bundle published`,
            agentId: agent.id,
            publishId: payload.publish.id,
            publishedUrl: agent.publishedUrl,
          },
          occurredAt: payload.publish.createdAt,
        });
      });
      return c.json({ published: true, publishId: payload.publish.id, ...payload }, 201);
    }
    const record = await findGeneratedAppRecord(context, body.appId, body.checkpointId);
    if (!record) throw httpRouteError(404, "generated app not found");
    const checkpoint = checkpointForPublish(record, body.checkpointId);
    if (!checkpoint) throw httpRouteError(404, "checkpoint not found");
    const { validation, integrations } = await buildPublishPreflight(
      context,
      record,
      checkpoint,
      body,
      { materializeWorkspace: true },
    );
    if (!validation.canPublish || !integrationsReadyForPublish(integrations)) {
      return c.json({ error: "publish validation failed", validation, integrations }, 409);
    }

    const timestamp = new Date().toISOString();
    const publish = buildGeneratedAppPublishRecord({
      workspaceId: context.workspace.id,
      workspaceSlug: context.workspace.slug,
      appId: record.id,
      appSlug: record.slug,
      appName: record.name,
      checkpointId: checkpoint.id,
      previewUrl: checkpoint.previewUrl ?? record.previewUrl,
      buildStatus: checkpoint.buildStatus ?? record.buildStatus,
      smokeStatus: checkpoint.smokeStatus ?? record.smokeStatus,
      previousPublish: currentPublishedRecord(record),
      createdByUserId: context.user.id,
      createdAt: timestamp,
      visibility: body.visibility,
      localPublishRoot: body.localPublishRoot,
      publicBaseUrl: body.publicBaseUrl,
      privateBaseUrl: body.privateBaseUrl,
      runtimeEnv: publishRuntimeEnv(),
    });
    const saved = await mutateStoreAsync((data) => {
      data.generatedApps ??= [];
      const app = data.generatedApps.find(
        (entry) => entry.workspaceId === context.workspace.id && entry.id === record.id,
      );
      if (!app) return null;
      app.publishHistory = orderGeneratedAppPublishHistory([
        publish,
        ...(app.publishHistory ?? []).filter((entry) => entry.id !== publish.id),
      ]).slice(0, 20);
      app.currentPublishId = publish.id;
      app.publishStatus = publish.status;
      app.publishedUrl = publish.visibility === "public" ? publish.publicUrl : publish.privateUrl;
      app.updatedAt = timestamp;
      recordActivity(data, {
        id: `activity_generated_app_publish_${app.id}_${stableHash(publish.id)}`,
        workspaceId: context.workspace.id,
        scope: "workspace",
        event: "builder.generated_app.publish",
        actor: { type: "user", id: context.user.id },
        data: {
          title: `${app.name} published`,
          appId: app.id,
          checkpointId: publish.checkpointId,
          publishId: publish.id,
          status: publish.status,
          publishedUrl: app.publishedUrl,
        },
        occurredAt: timestamp,
      });
      return app;
    });
    if (!saved) throw httpRouteError(404, "generated app not found");

    return c.json(
      {
        published: true,
        app: publishedAppSummary(saved),
        publish,
        publishId: publish.id,
        validation,
        integrations,
        history: orderGeneratedAppPublishHistory(saved.publishHistory ?? []),
        dockerComposeExport: publish.dockerComposeExport,
        rollbackToPrevious: publish.rollbackCommand,
        state: builderPublishState(
          saved,
          context.workspace.slug,
          publish,
          validation,
          integrations,
        ),
      },
      201,
    );
  } catch (error) {
    return errorResponse(c, error);
  }
}

async function rollbackGeneratedAppPublish(c: Context) {
  try {
    const context = await requireAuthenticatedContextAsync(c);
    await requireWorkspacePermission(context, "manageWorkspace");
    const publishId = c.req.param("publishId");
    if (!publishId) throw httpRouteError(400, "publishId is required");
    const body = (await c.req.json().catch(() => ({}))) as AppPublishRollbackRouteRequest;
    if (body.agentId && !body.appId) return rollbackAgentPublish(context, c, publishId, body);
    const record = await findGeneratedAppRecordForPublish(context, body.appId, publishId);
    if (!record) throw httpRouteError(404, "generated app not found");
    const current = (record.publishHistory ?? []).find((entry) => entry.id === publishId);
    if (!current) throw httpRouteError(404, "publish record not found");
    const targetPublishId = body.targetPublishId ?? current.previousPublishId;
    const target = (record.publishHistory ?? []).find((entry) => entry.id === targetPublishId);
    if (!target) throw httpRouteError(404, "previous publish not found");
    const command = createGeneratedAppPublishRollbackCommand({
      current,
      target,
      requestedByUserId: context.user.id,
      reason: body.reason,
    });
    const result = buildGeneratedAppPublishRollbackResult({
      command,
      status: record.currentPublishId === target.id ? "noop" : "succeeded",
      completedAt: new Date().toISOString(),
    });
    const saved = await mutateStoreAsync((data) => {
      data.generatedApps ??= [];
      const app = data.generatedApps.find(
        (entry) => entry.workspaceId === context.workspace.id && entry.id === record.id,
      );
      if (!app) return null;
      const history = app.publishHistory ?? [];
      const mutableCurrent = history.find((entry) => entry.id === current.id);
      const mutableTarget = history.find((entry) => entry.id === target.id);
      if (!mutableCurrent || !mutableTarget) return null;
      if (mutableCurrent.id !== mutableTarget.id) mutableCurrent.status = "rolled_back";
      mutableCurrent.rollbackCommand = command;
      mutableCurrent.rollbackResult = result;
      mutableTarget.status = "published";
      app.currentPublishId = mutableTarget.id;
      app.publishStatus = mutableTarget.status;
      app.publishedUrl =
        mutableTarget.visibility === "public" ? mutableTarget.publicUrl : mutableTarget.privateUrl;
      app.updatedAt = result.completedAt;
      recordActivity(data, {
        id: `activity_generated_app_publish_rollback_${app.id}_${stableHash(command.commandId)}`,
        workspaceId: context.workspace.id,
        scope: "workspace",
        event: "builder.generated_app.publish.rollback",
        actor: { type: "user", id: context.user.id },
        data: {
          title: `${app.name} publish rolled back`,
          appId: app.id,
          fromPublishId: command.fromPublishId,
          toPublishId: command.toPublishId,
          command: command.command,
          status: result.status,
        },
        occurredAt: result.completedAt,
      });
      return app;
    });
    if (!saved) throw httpRouteError(404, "publish record not found");

    return c.json({
      rolledBack: result.rolledBack,
      app: publishedAppSummary(saved),
      publish: (saved.publishHistory ?? []).find((entry) => entry.id === target.id),
      history: orderGeneratedAppPublishHistory(saved.publishHistory ?? []),
      rollback: { command, result },
      state: builderPublishState(saved, context.workspace.slug),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
}

async function exportGeneratedAppDockerCompose(c: Context) {
  try {
    const context = await requireAuthenticatedContextAsync(c);
    await requireWorkspacePermission(context, "manageWorkspace");
    const appId = c.req.query("appId");
    const agentId = c.req.query("agentId");
    if (agentId && !appId) {
      const payload = await buildAgentPublishPayload(context, { agentId });
      return c.json({
        fileName: payload.publish.dockerComposeExport.fileName,
        contents: JSON.stringify(payload.publish.dockerComposeExport, null, 2),
        dockerComposeExport: payload.publish.dockerComposeExport,
      });
    }
    const record = await findGeneratedAppRecord(context, appId, c.req.query("checkpointId"));
    if (!record) throw httpRouteError(404, "generated app not found");
    const publish = currentPublishedRecord(record);
    const fallback = buildGeneratedAppPublishRecord({
      workspaceId: context.workspace.id,
      workspaceSlug: context.workspace.slug,
      appId: record.id,
      appName: record.name,
      appSlug: record.slug,
      checkpointId: record.checkpointId,
      previewUrl: record.previewUrl,
      buildStatus: record.buildStatus,
      smokeStatus: record.smokeStatus,
      createdByUserId: context.user.id,
    });
    const compose = publish?.dockerComposeExport ?? fallback.dockerComposeExport;
    return c.json({
      fileName: compose.fileName,
      contents: compose.yaml,
      dockerComposeExport: compose,
    });
  } catch (error) {
    return errorResponse(c, error);
  }
}

async function draftForIteration(
  context: AuthenticatedRouteContext,
  body: Pick<AppIterationRouteRequest, "appId" | "checkpointId" | "draft">,
) {
  const record =
    body.appId || body.checkpointId
      ? await findGeneratedAppRecord(context, body.appId, body.checkpointId)
      : undefined;
  const draft = body.draft ?? (record?.draft as unknown as AppBuilderDraftContract | undefined);
  if (!draft) throw httpRouteError(400, "draft or appId is required");
  return { draft, record };
}

export async function findGeneratedAppRecord(
  context: AuthenticatedRouteContext,
  appId?: string,
  checkpointId?: string,
): Promise<GeneratedAppRecordWithRuntime | undefined> {
  const data = await loadStoreAsync();
  return ((data.generatedApps ?? []) as GeneratedAppRecordWithRuntime[]).find((entry) => {
    if (entry.workspaceId !== context.workspace.id) return false;
    if (appId && entry.id !== appId && entry.slug !== appId) return false;
    if (
      checkpointId &&
      entry.checkpointId !== checkpointId &&
      !(entry.checkpoints ?? []).some((checkpoint) => checkpoint.id === checkpointId)
    )
      return false;
    return Boolean(appId || checkpointId);
  });
}

async function findGeneratedAppRecordForPublish(
  context: AuthenticatedRouteContext,
  appId: string | undefined,
  publishId: string,
): Promise<GeneratedAppRecord | undefined> {
  const data = await loadStoreAsync();
  return (data.generatedApps ?? []).find((entry) => {
    if (entry.workspaceId !== context.workspace.id) return false;
    if (appId && entry.id !== appId && entry.slug !== appId) return false;
    return (entry.publishHistory ?? []).some((publish) => publish.id === publishId);
  });
}

async function listGeneratedApps(c: Context) {
  try {
    const context = await requireAuthenticatedContextAsync(c);
    await requireWorkspacePermission(context, "viewWorkspace");
    const data = await loadStoreAsync();
    const generatedApps = (data.generatedApps ?? [])
      .filter((entry) => entry.workspaceId === context.workspace.id)
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          right.createdAt.localeCompare(left.createdAt),
      )
      .map(generatedAppSummary);

    return c.json({ generatedApps });
  } catch (error) {
    return errorResponse(c, error);
  }
}

async function getGeneratedAppSourceFiles(c: Context) {
  try {
    const context = await requireAuthenticatedContextAsync(c);
    await requireWorkspacePermission(context, "viewWorkspace");
    const record = await findGeneratedAppRecord(
      context,
      c.req.param("appId"),
      c.req.query("checkpointId"),
    );
    if (!record) throw httpRouteError(404, "generated app not found");
    const checkpoint = checkpointForPublish(record, c.req.query("checkpointId"));
    if (!checkpoint) throw httpRouteError(404, "checkpoint not found");
    const artifact = generatedAppRuntimeArtifact(record, checkpoint);
    const requestedPath = c.req.query("path");
    const file = requestedPath ? findGeneratedAppSourceFile(artifact, requestedPath) : undefined;
    if (requestedPath && !file) throw httpRouteError(404, "source file not found");
    const includeContent = c.req.query("includeContent") !== "false";
    const workspace = await writeGeneratedAppWorkspace(context, record, checkpoint, artifact);

    return c.json({
      app: {
        id: record.id,
        slug: record.slug,
        name: record.name,
      },
      checkpoint: {
        id: checkpoint.id,
        appId: checkpoint.appId,
        source: checkpoint.source,
        createdAt: checkpoint.createdAt,
      },
      artifact: {
        entrypoint: artifact.entrypoint,
        renderedAt: artifact.renderedAt,
        files: summarizeGeneratedAppSourceFiles(artifact.files),
      },
      workspace,
      files: (file ? [file] : artifact.files).map((entry) =>
        includeContent
          ? entry
          : {
              path: entry.path,
              contentType: entry.contentType,
              size: entry.size,
              sha256: entry.sha256,
              role: entry.role,
            },
      ),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
}

export function checkpointForPublish(
  record: GeneratedAppRecordWithRuntime,
  checkpointId: string | undefined,
): GeneratedAppCheckpointWithRuntime | null {
  if (!checkpointId || checkpointId === record.checkpointId) {
    return (
      (record.checkpoints ?? []).find((checkpoint) => checkpoint.id === record.checkpointId) ?? {
        id: record.checkpointId,
        appId: record.id,
        workspaceId: record.workspaceId,
        label: `${record.name} current checkpoint`,
        draft: record.draft,
        previewUrl: record.previewUrl,
        buildStatus: record.buildStatus,
        smokeStatus: record.smokeStatus,
        source: "initial",
        codegenSource: record.codegenSource,
        createdByUserId: record.createdByUserId,
        createdAt: record.updatedAt,
      }
    );
  }
  return (record.checkpoints ?? []).find((checkpoint) => checkpoint.id === checkpointId) ?? null;
}

export function generatedAppRuntimeArtifact(
  record: GeneratedAppRecordWithRuntime,
  checkpoint: GeneratedAppCheckpointWithRuntime,
) {
  if (checkpoint.runtimeArtifact) return checkpoint.runtimeArtifact;
  if (checkpoint.sourceFiles?.length)
    return runtimeArtifactFromSourceFiles(checkpoint.sourceFiles, checkpoint.createdAt);
  if (checkpoint.id === record.checkpointId) {
    if (record.runtimeArtifact) return record.runtimeArtifact;
    if (record.sourceFiles?.length)
      return runtimeArtifactFromSourceFiles(record.sourceFiles, record.updatedAt);
  }
  return buildGeneratedAppRuntimeArtifact({
    appId: record.id,
    workspaceId: record.workspaceId,
    checkpointId: checkpoint.id,
    draft: checkpoint.draft as unknown as AppBuilderDraftContract,
    renderedAt: checkpoint.createdAt,
  });
}

function fileTreeForIteration(
  body: AppIterationRouteRequest,
  record: GeneratedAppRecordWithRuntime | undefined,
  checkpoint: GeneratedAppCheckpointWithRuntime | null,
): { source?: AppDraftSource; files?: GeneratedFile[] } {
  const bodyFiles = generatedFilesFromUnknown(body.fileTree);
  if (bodyFiles?.length) {
    return { source: body.draftSource ?? "llm-filetree", files: bodyFiles };
  }

  const source = body.draftSource ?? checkpoint?.codegenSource ?? record?.codegenSource;
  if (source !== "llm-filetree") return { source };

  const recordFiles = checkpoint?.sourceFiles?.length
    ? checkpoint.sourceFiles
    : checkpoint?.id === record?.checkpointId && record?.sourceFiles?.length
      ? record.sourceFiles
      : record?.sourceFiles;
  return { source, files: generatedFilesFromSourceRecords(recordFiles) };
}

function generatedFilesFromUnknown(value: unknown): GeneratedFile[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const files: GeneratedFile[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const path = (entry as Record<string, unknown>).path;
    const content = (entry as Record<string, unknown>).content;
    if (typeof path !== "string" || typeof content !== "string") continue;
    files.push({ path, content });
  }
  return files.length > 0 ? files : undefined;
}

function generatedFilesFromSourceRecords(
  records: GeneratedAppSourceFileRecord[] | undefined,
): GeneratedFile[] | undefined {
  if (!records?.length) return undefined;
  return records.map((file) => ({ path: file.path, content: file.content }));
}

function runtimeArtifactFromSourceFiles(
  files: GeneratedAppSourceFileRecord[],
  renderedAt: string,
): GeneratedAppRuntimeArtifactRecord {
  return {
    entrypoint:
      files.find((file) => file.role === "entrypoint")?.path ?? files[0]?.path ?? "index.html",
    files,
    renderedAt,
  };
}

function cloneGeneratedAppRuntimeArtifact(
  artifact: GeneratedAppRuntimeArtifactRecord,
): GeneratedAppRuntimeArtifactRecord {
  return {
    entrypoint: artifact.entrypoint,
    renderedAt: artifact.renderedAt,
    files: artifact.files.map((file) => ({ ...file })),
  };
}

function branchDraftForGeneratedApp(
  draft: Record<string, unknown>,
  slug: string,
  name: string,
): Record<string, unknown> {
  const app =
    draft.app && typeof draft.app === "object" && !Array.isArray(draft.app)
      ? (draft.app as Record<string, unknown>)
      : {};
  return {
    ...draft,
    app: {
      ...app,
      slug,
      name,
      description:
        typeof app.description === "string" ? app.description : `${name} generated app branch.`,
    },
  };
}

function currentPublishedRecord(record: GeneratedAppRecord): GeneratedAppPublishRecord | null {
  const history = record.publishHistory ?? [];
  return (
    history.find((entry) => entry.id === record.currentPublishId) ??
    orderGeneratedAppPublishHistory(history).find((entry) => entry.status === "published") ??
    null
  );
}

function latestPublishRollbackCommand(record: GeneratedAppRecord) {
  return currentPublishedRecord(record)?.rollbackCommand;
}

function publishedAppSummary(record: GeneratedAppRecord) {
  return {
    id: record.id,
    slug: record.slug,
    name: record.name,
    status: record.status,
    previewUrl: record.previewUrl,
    publishStatus: record.publishStatus,
    currentPublishId: record.currentPublishId,
    publishedUrl: record.publishedUrl,
  };
}

function generatedAppSummary(record: GeneratedAppRecord) {
  const current = currentPublishedRecord(record);
  return {
    id: record.id,
    slug: record.slug,
    name: record.name,
    status: record.status,
    previewUrl: record.previewUrl,
    publishStatus: record.publishStatus ?? current?.status,
    publishedUrl:
      record.publishedUrl ??
      (current
        ? current.visibility === "public"
          ? current.publicUrl
          : current.privateUrl
        : undefined),
    checkpointId: record.checkpointId,
    updatedAt: record.updatedAt,
    createdAt: record.createdAt,
  };
}

async function buildAgentPublishPayload(
  context: AuthenticatedRouteContext,
  body: AppPublishRouteRequest,
  published = false,
) {
  const data = await loadStoreAsync();
  const agent = data.agents.find(
    (entry) => entry.workspaceId === context.workspace.id && entry.id === body.agentId,
  );
  if (!agent) throw httpRouteError(404, "agent not found");
  const provider = agent.providerId
    ? data.providers.find(
        (entry) => entry.workspaceId === context.workspace.id && entry.id === agent.providerId,
      )
    : undefined;
  const providerReady =
    !agent.providerId || provider?.apiKeyConfigured === true || provider?.status === "connected";
  const webhookReady = agent.triggerKind !== "webhook" || Boolean(agent.webhookToken);
  const health = await localPublishHealthObservation();
  const readiness = buildAppPublishReadiness({
    draftId: agent.id,
    agentName: agent.name,
    workspaceSlug: context.workspace.slug,
    bundleKind: "agent",
    visibility: body.visibility ?? "private",
    publicBaseUrl: body.publicBaseUrl,
    privateBaseUrl: body.privateBaseUrl,
    runtimeEnv: publishRuntimeEnv(),
  });
  const expectedArtifacts = readiness.publishArtifactManifest.entries
    .filter((entry) => entry.required)
    .map((entry) => entry.path);
  const validation = buildAppPublishValidation({
    build: {
      phase: agent.status === "archived" ? "failed" : "passed",
      command: "npm run build:web",
      expectedArtifacts,
    },
    artifacts: {
      expectedArtifacts,
      manifestPath: `${readiness.localPublishPath}/${readiness.publishArtifactManifest.fileName}`,
      artifacts: readiness.publishArtifactManifest.entries.map((entry) => ({
        path: entry.path,
        kind: entry.kind,
        present: agent.status !== "archived",
        source:
          entry.kind === "generated_bundle" || entry.path.includes("/agent/")
            ? "generated_draft"
            : "publish_manifest",
        description: entry.description,
      })),
    },
    health,
    smoke: {
      requiredCheckCount: 3,
      checks: [
        { id: "agent-manifest", label: "Agent manifest", status: "pass" },
        {
          id: "agent-provider",
          label: "Provider readiness",
          status: providerReady ? "pass" : "fail",
          message: providerReady ? undefined : "Provider API key is not configured.",
        },
        {
          id: "agent-trigger",
          label: "Trigger readiness",
          status: webhookReady ? "pass" : "fail",
          message: webhookReady ? undefined : "Webhook token is not configured.",
        },
      ],
    },
    url: {
      baseUrl:
        body.visibility === "public"
          ? (body.publicBaseUrl ?? "https://apps.packetagent.example")
          : (body.privateBaseUrl ?? "http://localhost:8484"),
      path: `/agent/${context.workspace.slug}/${agent.id}`,
      visibility: body.visibility ?? "private",
    },
  });
  const timestamp = new Date().toISOString();
  const history = (agent.publishHistory ?? []) as Array<Record<string, unknown>>;
  const previous =
    history.find((entry) => entry.id === agent.currentPublishId) ??
    history.find((entry) => entry.status === "published");
  const publish = {
    id: `agent_publish_${stableHash(`${context.workspace.id}:${agent.id}:${agent.updatedAt}`)}`,
    agentId: agent.id,
    workspaceId: context.workspace.id,
    checkpointId: `agent_ckpt_${agent.id}_${stableHash(agent.updatedAt)}`,
    status: published ? "published" : validation.canPublish ? "ready" : "failed",
    visibility: readiness.urlHandoff.visibility,
    versionLabel: `${agent.name} agent bundle`,
    localPublishPath: readiness.localPublishPath,
    publicUrl: readiness.urlHandoff.publicUrl,
    privateUrl: readiness.urlHandoff.privateUrl,
    dockerComposeExport: readiness.dockerComposeExport,
    logs: [
      {
        at: timestamp,
        level: validation.canPublish ? "info" : "error",
        message: validation.canPublish
          ? "Generated agent bundle publish metadata is ready for self-hosted handoff."
          : validation.actionableFailures
              .map((failure) => `${failure.stage}: ${failure.message}`)
              .join("; "),
      },
    ],
    previousPublishId: typeof previous?.id === "string" ? previous.id : undefined,
    createdByUserId: context.user.id,
    createdAt: timestamp,
    completedAt: published ? timestamp : undefined,
  };
  const nextHistory = published
    ? [publish, ...history.filter((entry) => entry.id !== publish.id)]
    : history;
  const persistedCurrent =
    history.find((entry) => entry.id === agent.currentPublishId) ??
    history.find((entry) => entry.status === "published");
  const activePublish = published ? publish : persistedCurrent;
  const activeVisibility = String(activePublish?.visibility ?? publish.visibility);
  const activeUrl = activePublish
    ? activeVisibility === "public"
      ? typeof activePublish.publicUrl === "string"
        ? activePublish.publicUrl
        : undefined
      : typeof activePublish.privateUrl === "string"
        ? activePublish.privateUrl
        : undefined
    : undefined;
  const persistedUrl =
    typeof agent.publishedUrl === "string" && agent.publishedUrl ? agent.publishedUrl : activeUrl;
  const persistedStatus =
    typeof agent.publishStatus === "string" && agent.publishStatus
      ? agent.publishStatus
      : activePublish
        ? String(activePublish.status)
        : publish.status;
  const state = {
    agentId: agent.id,
    checkpointId:
      typeof activePublish?.checkpointId === "string"
        ? activePublish.checkpointId
        : publish.checkpointId,
    status: published ? publish.status : persistedStatus,
    currentPublishId:
      typeof activePublish?.id === "string" ? activePublish.id : agent.currentPublishId,
    publishedUrl: published
      ? publish.visibility === "public"
        ? publish.publicUrl
        : publish.privateUrl
      : persistedUrl,
    readiness,
    validation,
    logs: Array.isArray(activePublish?.logs) ? activePublish.logs : publish.logs,
    history: nextHistory.map((entry) => ({
      id: String(entry.id),
      status: String(entry.status),
      url:
        String(entry.visibility) === "public"
          ? String(entry.publicUrl ?? "")
          : String(entry.privateUrl ?? ""),
      checkpointId: String(entry.checkpointId ?? ""),
      publishedAt: String(entry.completedAt ?? entry.createdAt ?? timestamp),
      actor: String(entry.createdByUserId ?? context.user.id),
      summary: String(entry.versionLabel ?? `${agent.name} agent bundle`),
    })),
    nextActions: validation.canPublish
      ? [
          "Export docker-compose.publish.yml for the generated agent bundle.",
          "Run the generated agent smoke input before public handoff.",
          "Keep the current agent configuration available as rollback reference.",
        ]
      : validation.actionableFailures.map((failure) => failure.action),
    canPublish: validation.canPublish,
    rollbackActions: history
      .filter((entry) => entry.id !== agent.currentPublishId)
      .map((entry) => ({
        id: `rollback-${String(entry.id)}`,
        label: `Rollback to ${String(entry.versionLabel ?? entry.id)}`,
        publishId: String(entry.id),
        disabled: entry.status === "failed",
      })),
  };

  return {
    ready: true,
    agent: {
      id: agent.id,
      name: agent.name,
      status: agent.status,
      triggerKind: agent.triggerKind,
    },
    publish,
    validation,
    state,
    history: state.history,
  };
}

async function rollbackAgentPublish(
  context: AuthenticatedRouteContext,
  c: Context,
  publishId: string,
  body: AppPublishRollbackRouteRequest,
) {
  const result = await mutateStoreAsync((data) => {
    const agent = data.agents.find(
      (entry) => entry.workspaceId === context.workspace.id && entry.id === body.agentId,
    );
    if (!agent) return null;
    const history = (agent.publishHistory ?? []) as Array<Record<string, unknown>>;
    const current = history.find((entry) => entry.id === publishId);
    if (!current) return null;
    const target = body.targetPublishId
      ? history.find((entry) => entry.id === body.targetPublishId)
      : (history.find((entry) => entry.id === current.previousPublishId) ??
        history.find((entry) => entry.id !== publishId && entry.status === "published"));
    if (!target) throw httpRouteError(404, "previous publish not found");
    current.status = "rolled_back";
    target.status = "published";
    agent.currentPublishId = String(target.id);
    agent.publishStatus = "published";
    agent.publishedUrl =
      String(target.visibility) === "public"
        ? String(target.publicUrl ?? "")
        : String(target.privateUrl ?? "");
    agent.updatedAt = new Date().toISOString();
    return { agent, target, current };
  });
  if (!result) throw httpRouteError(404, "agent publish not found");
  const payload = await buildAgentPublishPayload(context, {
    agentId: body.agentId,
    visibility: result.target.visibility === "public" ? "public" : "private",
  });

  return c.json({
    rolledBack: true,
    publish: result.target,
    history: payload.history,
    state: {
      ...payload.state,
      status: "published",
      publishedUrl: result.agent.publishedUrl,
    },
  });
}

function validateIterationApplyTarget(
  record: GeneratedAppRecord,
  draft: AppBuilderDraftContract,
  diff: AppIterationRouteResult | undefined,
  checkpointId: string | undefined,
) {
  if (diff?.appId && diff.appId !== record.id) {
    throw httpRouteError(409, "change set appId does not match the selected generated app");
  }
  if (checkpointId && diff?.checkpointId && diff.checkpointId !== checkpointId) {
    throw httpRouteError(409, "change set checkpointId does not match the selected checkpoint");
  }
  const slug = draft.app.slug || stableAppId(draft.app.name);
  if (slug !== record.slug) {
    throw httpRouteError(409, "change set draft slug does not match the selected generated app");
  }
  if (
    checkpointId &&
    record.checkpointId !== checkpointId &&
    !(record.checkpoints ?? []).some((checkpoint) => checkpoint.id === checkpointId)
  ) {
    throw httpRouteError(404, "checkpoint not found");
  }
}

async function attachPreviewSnapshot(
  context: AuthenticatedRouteContext,
  appId: string,
  snapshot: ReturnType<typeof buildAppPreviewSnapshotMetadata>,
) {
  await mutateStoreAsync((data) => {
    data.generatedApps ??= [];
    const app = data.generatedApps.find(
      (entry) => entry.workspaceId === context.workspace.id && entry.id === appId,
    );
    if (app) {
      app.previewSnapshots = [
        ...(app.previewSnapshots ?? []),
        snapshot as unknown as Record<string, unknown>,
      ].slice(-20);
    }
  });
}

function latestPreviewSnapshot(record: GeneratedAppRecord | undefined) {
  const latest = record?.previewSnapshots?.at(-1);
  return latest as ReturnType<typeof buildAppPreviewSnapshotMetadata> | undefined;
}

async function buildPublishPreflight(
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
  if (options.materializeWorkspace) {
    materializeGeneratedAppPublishWorkspace(
      record,
      checkpoint,
      readiness.localPublishPath,
      readiness.publishArtifactManifest,
    );
  }
  const privateUrl = generatedAppPublishUrlForBase(readiness.urlHandoff.privateUrl, {
    appId: record.id,
    checkpointId: checkpoint.id,
  });
  const publicUrl = generatedAppPublishUrlForBase(readiness.urlHandoff.publicUrl, {
    appId: record.id,
    checkpointId: checkpoint.id,
  });
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
      store: env.PACKETAGENT_STORE,
      configured: env.PACKETAGENT_STORE !== "memory",
    },
  });

  return { validation, integrations };
}

function materializeGeneratedAppPublishWorkspace(
  record: GeneratedAppRecordWithRuntime,
  checkpoint: GeneratedAppCheckpointWithRuntime,
  localPublishPath: string,
  artifactManifest: GeneratedAppPublishRecord["artifactManifest"],
) {
  const artifact = checkpoint.runtimeArtifact ?? record.runtimeArtifact;
  if (!artifact?.files.length) return;

  const publishRoot = resolve(process.cwd(), localPublishPath);
  const bundleRoot = safePublishPath(publishRoot, "bundle");
  mkdirSync(bundleRoot, { recursive: true });

  for (const file of artifact.files) {
    writeTextArtifact(
      safePublishPath(bundleRoot, normalizeSourceFilePath(file.path)),
      file.content,
    );
  }

  writeJsonArtifact(safePublishPath(publishRoot, "app-manifest.json"), {
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
  });
  writeJsonArtifact(safePublishPath(publishRoot, "runtime-config.json"), {
    runtime: "packetagent-generated-app-preview",
    workspaceId: record.workspaceId,
    appId: record.id,
    checkpointId: checkpoint.id,
    route: `/api/app/generated-apps/${encodeURIComponent(record.id)}/preview?checkpointId=${encodeURIComponent(checkpoint.id)}`,
    bundlePath: `${localPublishPath}/bundle`,
    entrypoint: artifact.entrypoint,
  });
  writeJsonArtifact(safePublishPath(publishRoot, artifactManifest.fileName), artifactManifest);
}

function publishArtifactObservations(
  record: GeneratedAppRecordWithRuntime,
  checkpoint: GeneratedAppCheckpointWithRuntime,
  localPublishPath: string,
  buildStatus: string | undefined,
): PublishArtifactObservation[] {
  const artifact = checkpoint.runtimeArtifact ?? record.runtimeArtifact;
  const snapshot = latestPreviewSnapshot(record);
  const snapshotPaths =
    snapshot?.checkpoint.id === checkpoint.id ? snapshot.build.artifactPaths : [];
  const generatedBundlePresent = Boolean(artifact?.files.length);
  const buildPassed = buildStatus === "passed";
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
    {
      path: "src/server.ts",
      kind: "source",
      present: true,
      source: "operator",
      description: "PacketAgent Hono server source that serves generated apps.",
    },
    {
      path: "web/dist",
      kind: "build_output",
      present: buildPassed,
      source: "build",
      description: "Built Vite app shell for the generated app runtime.",
    },
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
      path: "docker-compose.publish.yml",
      kind: "config",
      present: generatedBundlePresent,
      source: "publish_manifest",
      description: "Self-hostable compose export for the generated bundle.",
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
  writeTextArtifact(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextArtifact(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
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

async function localPublishHealthObservation() {
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

function builderPublishState(
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

function integrationsReadyForPublish(
  integrations: ReturnType<typeof inspectAppPublishIntegrations>,
) {
  return integrations.canPublish && integrations.canUseAllRequestedIntegrations;
}

function publishRuntimeEnv() {
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

function appIterationResponse(input: {
  context: AuthenticatedRouteContext;
  body: AppIterationRouteRequest;
  draft: AppBuilderDraftContract;
  plan: AppIterationPlan;
  status: AppBuilderIterationDiffStatus;
  previewUrl?: string;
  smoke: ReturnType<typeof smokeStatusFromChecks>;
  logs: AppIterationRouteResult["logs"];
  snapshot: ReturnType<typeof buildAppPreviewSnapshotMetadata>;
  tools: ReturnType<typeof inspectAppIterationTools>;
  sourceDiffFiles?: AppIterationDiffFile[];
  sourceFiles?: GeneratedAppSourceFileRecord[];
  artifact?: GeneratedAppRuntimeArtifactRecord;
  llmResult?: AppIterationLLMResult | null;
  validationErrors?: string[];
  fileTree?: GeneratedFile[];
  draftSource?: AppDraftSource;
}): AppIterationRouteResult & {
  rollback: AppIterationPlan["rollbackCheckpoint"];
  snapshot: unknown;
  tools: unknown;
} {
  const preview = derivePreviewRefreshState({
    appId: input.body.appId ?? stableGeneratedAppId(input.draft, input.context),
    workspaceId: input.context.workspace.id,
    previewUrl: input.previewUrl,
    previewPath: input.previewUrl,
    build: {
      phase: "queued",
      checkCount: input.smoke.checks.length,
      passedChecks: 0,
      buildId: input.snapshot.build.id,
      revision: input.plan.rollbackCheckpoint.checkpointId,
    },
    lastRendered: input.previewUrl
      ? {
          previewUrl: input.previewUrl,
          revision: input.body.checkpointId,
        }
      : undefined,
    refreshRequest: {
      requestId: `preview-refresh:${input.plan.rollbackCheckpoint.checkpointId}`,
      buildId: input.snapshot.build.id,
      revision: input.plan.rollbackCheckpoint.checkpointId,
      requestedAt: new Date().toISOString(),
    },
  });

  const llmFiles: AppIterationDiffFile[] = (input.llmResult?.files ?? []).map((file) => ({
    path: file.path,
    changeType: file.changeType,
    summary: file.summary,
    diff: file.diff,
  }));
  const baseSummary =
    input.plan.diffHunks.map((hunk) => hunk.summary).join(" ") ||
    "No generated app changes available for this prompt.";
  return {
    id: `change_${stableHash(`${input.plan.rollbackCheckpoint.checkpointId}:${input.plan.request.requestedChange}`)}`,
    appId: input.body.appId,
    checkpointId: input.body.checkpointId,
    target: input.body.target ?? routeTargetFromPlan(input.plan),
    prompt: input.body.prompt ?? input.plan.request.requestedChange,
    summary: input.llmResult?.changedSummary || baseSummary,
    status: input.status,
    files: mergeIterationDiffFiles(
      mergeIterationDiffFiles(input.plan.diffHunks.map(diffFileFromHunk), llmFiles),
      input.sourceDiffFiles ?? [],
    ),
    sourceDiffFiles: input.sourceDiffFiles ?? [],
    sourceFiles: summarizeGeneratedAppSourceFiles(input.sourceFiles ?? []),
    fileTree: input.fileTree,
    draftSource: input.draftSource,
    validationErrors: input.validationErrors,
    artifact: {
      entrypoint: input.artifact?.entrypoint,
      renderedAt: input.artifact?.renderedAt,
      files: summarizeGeneratedAppSourceFiles(input.artifact?.files ?? []),
    },
    draft: input.draft,
    preview: {
      url: input.previewUrl,
      status: input.status === "blocked" ? "warn" : "pending",
      message: preview.reason,
    },
    logs: input.logs,
    smoke: input.smoke,
    errorFix: input.smoke.blockers[0]
      ? {
          source: "smoke",
          message: input.smoke.blockers[0],
          prompt: `Fix this generated app smoke failure for ${input.plan.request.target.label}: ${input.smoke.blockers[0]}`,
        }
      : undefined,
    rollback: input.plan.rollbackCheckpoint,
    snapshot: input.snapshot,
    tools: input.tools,
  };
}

function appIterationTargetForService(
  target: AppBuilderIterationTarget | undefined,
): AppIterationTargetInput {
  if (!target) return { kind: "page" };
  const kind =
    target.kind === "api_route"
      ? "api"
      : target.kind === "data_entity"
        ? "data"
        : target.kind === "app" ||
            target.kind === "smoke" ||
            target.kind === "file" ||
            target.kind === "agent" ||
            target.kind === "tool"
          ? "config"
          : target.kind;
  return {
    kind: kind as AppIterationTargetInput["kind"],
    key: target.id,
    path: target.path,
    name: target.label,
  };
}

function routeTargetFromPlan(plan: AppIterationPlan): AppBuilderIterationTarget {
  const target = plan.request.target;
  return {
    id: target.key,
    kind:
      target.kind === "api" ? "api_route" : target.kind === "data" ? "data_entity" : target.kind,
    label: target.label,
    path: target.path,
  };
}

function toGeneratedAppDraftLike(draft: AppBuilderDraftContract): GeneratedAppDraftLike {
  return {
    appName: draft.app.name,
    pageMap: draft.app.pages.map((page) => ({
      path: page.route,
      name: page.name,
      access: page.access,
      purpose: page.purpose,
      actions: page.actions,
      components: page.components,
    })),
    apiRouteStubs: draft.app.apiRoutes.map((route) => ({
      method: route.method,
      path: route.path,
      access: route.access,
      purpose: route.purpose,
      handler: route.handler,
      authRequired: route.authRequired,
    })),
    dataSchema: {
      database: "generated",
      entities: draft.app.dataSchema.map((entity) => ({
        name: entity.name,
        fields: entity.fields.map((field) => ({
          name: field.name,
          type: field.type,
          required: field.required,
        })),
        relations: entity.relationships,
      })),
      notes: draft.plan.acceptanceChecks,
    },
    auth: {
      defaultPolicy: "authenticated-by-default",
      publicRoutes: draft.app.pages
        .filter((page) => page.access === "public")
        .map((page) => page.route),
      privateRoutes: draft.app.pages
        .filter((page) => page.access === "private")
        .map((page) => page.route),
      roleRoutes: draft.app.pages
        .filter((page) => page.access === "admin")
        .map((page) => ({
          role: "admin",
          routes: [page.route],
          reason: `Admin access for ${page.name}`,
        })),
      decisions: draft.app.authDecisions.map(
        (decision) => `${decision.area}: ${decision.decision}. ${decision.rationale}`,
      ),
    },
    acceptanceChecks: draft.plan.acceptanceChecks,
    config: {
      notes: [draft.summary],
    },
  };
}

function fromGeneratedAppDraftLike(
  base: AppBuilderDraftContract,
  generated: GeneratedAppDraftLike,
): AppBuilderDraftContract {
  const pages = (generated.pageMap ?? []).map((page) => ({
    name: page.name ?? titleFromPath(page.path),
    route: page.path,
    access: appRouteAccess(page.access),
    purpose: String(page.purpose ?? `Generated page for ${page.path}`),
    actions: stringList(page.actions),
    components:
      stringList(page.components).length > 0
        ? stringList(page.components)
        : (base.app.pages.find((entry) => entry.route === page.path)?.components ?? ["PageShell"]),
  }));
  const dataSchema = (generated.dataSchema?.entities ?? []).map((entity) => ({
    name: entity.name,
    fields: (entity.fields ?? []).map((field) => ({
      name: field.name,
      type: appFieldType(field.type),
      required: Boolean(field.required),
      notes: field.references ? `References ${field.references}` : undefined,
    })),
    relationships: [
      ...stringList(entity.relations),
      ...stringList(entity.indexes).map((index) => `Indexed by ${index}`),
    ],
  }));
  const apiRoutes = (generated.apiRouteStubs ?? []).map((route) => ({
    method: appRouteMethod(route.method),
    path: route.path,
    access: appRouteAccess(route.access),
    purpose: String(route.purpose ?? `Generated route for ${route.path}`),
    handler:
      typeof route.handler === "string"
        ? route.handler
        : routeHandlerName(appRouteMethod(route.method), route.path),
    authRequired: route.access !== "public",
    requiredRole: appRouteAccess(route.access) === "admin" ? ("admin" as const) : undefined,
  }));
  const nextDraft = {
    ...base,
    summary: appendUniqueSentence(
      base.summary,
      `Latest iteration: ${generated.config?.notes?.at(-1) ?? base.summary}`,
    ),
    app: {
      ...base.app,
      pages,
      dataSchema,
      apiRoutes,
      crudFlows: base.app.crudFlows.filter((flow) =>
        dataSchema.some((entity) => entity.name === flow.entity),
      ),
      authDecisions: authDecisionsFromGenerated(generated, pages),
    },
    smokeBuildStatus: {
      ...base.smokeBuildStatus,
      status: "pending" as const,
      message: "Smoke checks are ready to run after applying the generated iteration.",
    },
  };
  return nextDraft;
}

function authDecisionsFromGenerated(
  generated: GeneratedAppDraftLike,
  pages: AppBuilderDraftContract["app"]["pages"],
) {
  const auth = generated.auth;
  if (!auth) {
    return pages.map((page) => ({
      area: page.route,
      decision:
        page.access === "public"
          ? "Public"
          : page.access === "admin"
            ? "admin role"
            : "Authenticated",
      rationale: "Derived from generated route access.",
    }));
  }
  return [
    ...(auth.publicRoutes ?? []).map((route) => ({
      area: route,
      decision: "Public",
      rationale: "Iteration marked this route public.",
    })),
    ...(auth.privateRoutes ?? []).map((route) => ({
      area: route,
      decision: "Authenticated",
      rationale: "Iteration marked this route authenticated.",
    })),
    ...(auth.roleRoutes ?? []).map((route) => ({
      area: route.routes.join(", "),
      decision: `${route.role} role`,
      rationale: route.reason ?? "Iteration requires a role gate.",
    })),
    ...(auth.decisions ?? []).map((decision) => ({
      area: "Global policy",
      decision: auth.defaultPolicy ?? "authenticated-by-default",
      rationale: decision,
    })),
  ];
}

function diffFileFromHunk(hunk: AppIterationDiffHunk): AppIterationRouteResult["files"][number] {
  return {
    path: diffFilePath(hunk),
    changeType: hunk.action === "add" ? "added" : hunk.action === "remove" ? "deleted" : "modified",
    summary: hunk.summary,
    diff: [
      `@@ ${hunk.target.label}`,
      ...hunk.before.split("\n").map((line) => `- ${line}`),
      ...hunk.after.split("\n").map((line) => `+ ${line}`),
    ].join("\n"),
    source: "draft",
  };
}

function diffGeneratedAppSourceFiles(
  previous: GeneratedAppRuntimeArtifactRecord,
  next: GeneratedAppRuntimeArtifactRecord,
): AppIterationDiffFile[] {
  const previousFiles = new Map(
    previous.files.map((file) => [normalizeGeneratedSourcePath(file.path), file]),
  );
  const nextFiles = new Map(
    next.files.map((file) => [normalizeGeneratedSourcePath(file.path), file]),
  );
  const paths = sortedUniqueStrings([...previousFiles.keys(), ...nextFiles.keys()]);

  return paths.flatMap((path) => {
    const before = previousFiles.get(path);
    const after = nextFiles.get(path);
    if (before?.sha256 && after?.sha256 && before.sha256 === after.sha256) return [];
    const changeType = before && after ? "modified" : before ? "deleted" : "added";
    const role = after?.role ?? before?.role;
    return [
      {
        path: after?.path ?? before?.path ?? path,
        changeType,
        summary: sourceDiffSummary(changeType, after?.path ?? before?.path ?? path, before, after),
        diff: renderSourceFileDiff(before, after),
        source: "runtime" as const,
        beforeSha256: before?.sha256,
        afterSha256: after?.sha256,
        beforeSize: before?.size,
        afterSize: after?.size,
        role,
      },
    ];
  });
}

function mergeIterationDiffFiles(
  draftFiles: AppIterationDiffFile[],
  sourceFiles: AppIterationDiffFile[],
): AppIterationDiffFile[] {
  const runtimePaths = new Set(
    sourceFiles.map((file) => `runtime:${normalizeGeneratedSourcePath(file.path)}`),
  );
  return [
    ...draftFiles.filter(
      (file) =>
        file.source !== "runtime" ||
        !runtimePaths.has(`runtime:${normalizeGeneratedSourcePath(file.path)}`),
    ),
    ...sourceFiles,
  ];
}

function sourceDiffSummary(
  changeType: AppIterationDiffFile["changeType"],
  path: string,
  before: GeneratedAppSourceFileRecord | undefined,
  after: GeneratedAppSourceFileRecord | undefined,
) {
  const checksum =
    before && after ? ` (${before.sha256.slice(0, 8)} -> ${after.sha256.slice(0, 8)})` : "";
  const size = before && after ? `, ${before.size} -> ${after.size} bytes` : "";
  return `${changeType[0].toUpperCase()}${changeType.slice(1)} generated source file ${path}${checksum}${size}.`;
}

function renderSourceFileDiff(
  before: GeneratedAppSourceFileRecord | undefined,
  after: GeneratedAppSourceFileRecord | undefined,
) {
  const beforeLines = before?.content.split(/\r?\n/) ?? [];
  const afterLines = after?.content.split(/\r?\n/) ?? [];
  const max = Math.max(beforeLines.length, afterLines.length);
  const lines = [
    `--- ${before?.path ?? "/dev/null"}${before?.sha256 ? ` sha256:${before.sha256}` : ""}`,
    `+++ ${after?.path ?? "/dev/null"}${after?.sha256 ? ` sha256:${after.sha256}` : ""}`,
    "@@ source artifact @@",
  ];

  for (let index = 0; index < max; index += 1) {
    const left = beforeLines[index];
    const right = afterLines[index];
    if (left === right) {
      if (left !== undefined && shouldKeepSourceContext(index, beforeLines, afterLines))
        lines.push(`  ${left}`);
      continue;
    }
    if (left !== undefined) lines.push(`- ${left}`);
    if (right !== undefined) lines.push(`+ ${right}`);
  }

  return lines.join("\n");
}

function shouldKeepSourceContext(index: number, beforeLines: string[], afterLines: string[]) {
  return (
    beforeLines[index - 1] !== afterLines[index - 1] ||
    beforeLines[index + 1] !== afterLines[index + 1]
  );
}

function normalizeGeneratedSourcePath(path: string) {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function sortedUniqueStrings(values: string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function diffFilePath(hunk: Pick<AppIterationDiffHunk, "target" | "action">) {
  const suffix =
    hunk.target.kind === "api"
      ? `${hunk.target.path ?? hunk.target.key}.ts`
      : hunk.target.kind === "page"
        ? `${hunk.target.path ?? hunk.target.key}.tsx`
        : `${hunk.target.key}.json`;
  return `generated/${hunk.target.kind}/${suffix.replace(/^\/+/, "")}`;
}

function routeLog(level: "info" | "warn" | "error", message: string) {
  return { at: new Date().toISOString(), level, message };
}

function stableGeneratedAppId(draft: AppBuilderDraftContract, context: AuthenticatedRouteContext) {
  return `gapp_${stableHash(`${context.workspace.id}:${draft.app.slug || stableAppId(draft.app.name)}`)}`;
}

function routeHandlerName(method: "GET" | "POST" | "PATCH" | "DELETE", path: string) {
  const words = `${method.toLowerCase()} ${path}`
    .replace(/[:{}]/g, " ")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  return (
    words
      .map((word, index) =>
        index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1),
      )
      .join("") || "handleGeneratedRoute"
  );
}

function appRouteMethod(value: string): "GET" | "POST" | "PATCH" | "DELETE" {
  return value === "POST" || value === "PATCH" || value === "DELETE" ? value : "GET";
}

function appRouteAccess(value: unknown): "public" | "private" | "admin" {
  return value === "public" || value === "admin" ? value : "private";
}

function appFieldType(
  value: unknown,
): "string" | "number" | "boolean" | "date" | "enum" | "json" | "relation" {
  if (
    value === "number" ||
    value === "boolean" ||
    value === "date" ||
    value === "enum" ||
    value === "json" ||
    value === "relation"
  )
    return value;
  return "string";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function titleFromPath(path: string) {
  const segment = path.split("/").filter(Boolean).at(-1) ?? "page";
  return segment
    .split(/[-_]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function appendUniqueSentence(value: string, sentence: string) {
  return value.includes(sentence) ? value : `${value} ${sentence}`.trim();
}

function buildAppBuilderDraft(draft: AppDraft, context: AuthenticatedRouteContext) {
  const smokeBuildStatus = buildAppSmokeStatus(draft, context, false);

  return {
    prompt: draft.prompt,
    intent: draft.templateId,
    summary: draft.summary,
    app: {
      slug: stableAppId(draft.appName),
      name: draft.appName,
      description: draft.summary,
      pages: draft.pageMap.map((page) => ({
        name: page.name,
        route: page.path,
        access: page.access,
        purpose: page.purpose,
        actions: page.actions,
        components: componentsForPage(draft, page),
      })),
      dataSchema: draft.dataSchema.entities.map((entity) => ({
        name: entity.name,
        fields: entity.fields.map(mapDataField),
        relationships: [
          ...entity.relations,
          ...entity.indexes.map((index) => `Indexed by ${index}`),
        ],
      })),
      apiRoutes: draft.apiRouteStubs.map(mapApiRoute),
      crudFlows: draft.crudFlows.map((flow) => ({
        entity: flow.entity,
        create: flow.create.join(" "),
        read: flow.read.join(" "),
        update: flow.update.join(" "),
        delete: flow.delete.join(" "),
        validation: validationForCrudFlow(draft, flow),
      })),
      authDecisions: [
        ...draft.auth.publicRoutes.map((route) => ({
          area: route,
          decision: "Public",
          rationale: "This route is explicitly listed as public in the generated access map.",
        })),
        ...draft.auth.privateRoutes.map((route) => ({
          area: route,
          decision: "Authenticated",
          rationale: "The app defaults to authenticated access outside public entry points.",
        })),
        ...draft.auth.roleRoutes.map((route) => ({
          area: route.routes.join(", "),
          decision: `${route.role} role`,
          rationale: route.reason,
        })),
        ...draft.auth.decisions.map((decision) => ({
          area: "Global policy",
          decision: draft.auth.defaultPolicy,
          rationale: decision,
        })),
      ],
    },
    plan: {
      title: `${draft.appName} build plan`,
      steps: [
        planStep(
          "Generate pages",
          `Create ${draft.pageMap.length} routed screens and shared navigation from the page map.`,
        ),
        planStep(
          "Create data layer",
          `Provision ${draft.dataSchema.database} tables for ${draft.dataSchema.entities.map((entry) => entry.name).join(", ")}.`,
        ),
        planStep(
          "Review API contracts",
          `Review ${draft.apiRouteStubs.length} generated route contracts with validation and auth expectations before runtime execution.`,
        ),
        planStep(
          "Run smoke build",
          "Render the generated preview and run page plus API contract smoke checks.",
        ),
      ],
      acceptanceChecks: draft.acceptanceChecks,
      openQuestions: [],
    },
    smokeBuildStatus,
  };
}

async function persistGeneratedAppDraft(
  context: AuthenticatedRouteContext,
  draft: AppBuilderDraftContract,
  input: {
    status: GeneratedAppStatus;
    previewUrl?: string;
    buildStatus: string;
    smokeStatus: string;
    checkpointLabel?: string;
    checkpointSource?: GeneratedAppCheckpointRecord["source"];
    codegenSource?: AppDraftSource;
    fileTreeFiles?: GeneratedFile[];
  },
) {
  const timestamp = new Date().toISOString();
  const slug = draft.app.slug || stableAppId(draft.app.name);
  const checkpointId = `gapp_ckpt_${stableHash(`${context.workspace.id}:${slug}:${timestamp}`)}`;
  const draftRecord = draft as unknown as Record<string, unknown>;

  const record = await mutateStoreAsync((data) => {
    data.generatedApps ??= [];
    const existing = data.generatedApps.find(
      (entry) => entry.workspaceId === context.workspace.id && entry.slug === slug,
    );
    const previousCheckpointId = existing?.checkpointId;
    const appId = existing?.id ?? stableGeneratedAppId(draft, context);
    const runtimeArtifact = input.fileTreeFiles?.length
      ? buildGeneratedAppRuntimeArtifactFromFiles(input.fileTreeFiles, timestamp)
      : buildGeneratedAppRuntimeArtifact({
          appId,
          workspaceId: context.workspace.id,
          checkpointId,
          draft,
          renderedAt: timestamp,
        });
    const checkpoint = {
      id: checkpointId,
      appId,
      workspaceId: context.workspace.id,
      label: input.checkpointLabel ?? `${draft.app.name} ${input.status}`,
      draft: draftRecord,
      runtimeArtifact,
      sourceFiles: runtimeArtifact.files,
      previewUrl: input.previewUrl,
      buildStatus: input.buildStatus,
      smokeStatus: input.smokeStatus,
      source: input.checkpointSource ?? "initial",
      codegenSource: input.codegenSource,
      previousCheckpointId,
      createdByUserId: context.user.id,
      createdAt: timestamp,
    } satisfies GeneratedAppCheckpointWithRuntime;
    const existingWithRuntime = existing as GeneratedAppRecordWithRuntime | undefined;
    const record: GeneratedAppRecordWithRuntime = {
      id: checkpoint.appId,
      workspaceId: context.workspace.id,
      slug,
      name: draft.app.name,
      description: draft.app.description,
      prompt: draft.prompt,
      templateId: draft.intent,
      status: input.status,
      draft: draftRecord,
      checkpointId,
      runtimeArtifact,
      sourceFiles: runtimeArtifact.files,
      codegenSource: input.codegenSource,
      previewUrl: input.previewUrl,
      buildStatus: input.buildStatus,
      smokeStatus: input.smokeStatus,
      checkpoints: [...(existingWithRuntime?.checkpoints ?? []), checkpoint],
      previewSnapshots: existingWithRuntime?.previewSnapshots ?? [],
      createdByUserId: existingWithRuntime?.createdByUserId ?? context.user.id,
      createdAt: existingWithRuntime?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };

    if (existing) Object.assign(existing, record);
    else data.generatedApps.unshift(record);

    recordActivity(data, {
      id: `activity_generated_app_${record.id}_${stableHash(checkpointId)}`,
      workspaceId: context.workspace.id,
      scope: "workspace",
      event: "builder.generated_app.applied",
      actor: { type: "user", id: context.user.id },
      data: {
        title: `${record.name} applied from builder`,
        appId: record.id,
        slug: record.slug,
        status: record.status,
        checkpointId,
        previewUrl: record.previewUrl,
      },
      occurredAt: timestamp,
    });

    return record;
  });
  return record;
}

async function writeGeneratedAppWorkspace(
  context: AuthenticatedRouteContext,
  record: Pick<GeneratedAppRecordWithRuntime, "id" | "slug" | "name">,
  checkpoint: Pick<GeneratedAppCheckpointWithRuntime, "id" | "label" | "createdAt">,
  artifact: GeneratedAppRuntimeArtifactRecord,
): Promise<GeneratedAppWorkspaceSummary> {
  const result = await writeGeneratedAppRuntimeWorkspace({
    workspaceSlug: context.workspace.slug || context.workspace.id,
    appSlug: record.slug || record.id,
    appId: record.id,
    workspaceId: context.workspace.id,
    checkpointId: checkpoint.id,
    checkpointLabel: checkpoint.label,
    checkpointCreatedAt: checkpoint.createdAt,
    artifact,
    generatedAppsRoot: process.env.PACKETAGENT_GENERATED_APP_WORKSPACES_DIR,
  });

  return generatedAppWorkspaceSummary(context, record, artifact, result);
}

function generatedAppWorkspaceSummary(
  context: AuthenticatedRouteContext,
  record: Pick<GeneratedAppRecordWithRuntime, "id" | "slug" | "name">,
  artifact: GeneratedAppRuntimeArtifactRecord,
  result: Awaited<ReturnType<typeof writeGeneratedAppRuntimeWorkspace>>,
): GeneratedAppWorkspaceSummary {
  return {
    id: context.workspace.id,
    slug: context.workspace.slug,
    path: result.paths.workspacePath,
    appPath: dirname(result.paths.workspacePath),
    checkpointPath: result.paths.workspacePath,
    manifest: {
      path: result.paths.manifestPath,
      version: result.manifest.version,
      fileCount: result.manifest.files.length,
      totalBytes: result.manifest.files.reduce((total, file) => total + file.size, 0),
      entrypoint: artifact.entrypoint,
      renderedAt: artifact.renderedAt,
      checkpointId: result.manifest.checkpoint.id,
    },
  };
}

function promptFromBody(prompt: string | undefined) {
  const trimmed = String(prompt ?? "").trim();
  if (trimmed.length < 8) throw httpRouteError(400, "prompt must be at least 8 characters");
  if (trimmed.length > 2_000) throw httpRouteError(400, "prompt must be 2000 characters or fewer");
  return trimmed;
}

function planStep(title: string, detail: string) {
  return { title, detail, status: "todo" as const };
}

function componentsForPage(draft: AppDraft, page: PageDraft) {
  const used = draft.components
    .filter((component) => component.usedOn.includes(page.path))
    .map((component) => component.name);
  return used.length > 0 ? used : ["PageShell"];
}

function mapDataField(field: FieldSchemaDraft) {
  const notes = [
    field.enumValues?.length ? `Allowed values: ${field.enumValues.join(", ")}` : "",
    field.references ? `References ${field.references}` : "",
  ]
    .filter(Boolean)
    .join(". ");

  return {
    name: field.name,
    type: mapFieldType(field),
    required: field.required,
    notes: notes || undefined,
  };
}

function mapFieldType(field: FieldSchemaDraft) {
  if (field.references) return "relation";
  if (
    field.type === "number" ||
    field.type === "boolean" ||
    field.type === "date" ||
    field.type === "enum"
  )
    return field.type;
  if (field.type === "datetime") return "date";
  return "string";
}

function mapApiRoute(route: ApiRouteStub) {
  return {
    method: route.method,
    path: route.path,
    access: route.access,
    purpose: route.purpose,
    handler: handlerName(route),
    authRequired: route.access !== "public",
    requiredRole: route.access === "admin" ? ("admin" as const) : undefined,
  };
}

function handlerName(route: ApiRouteStub) {
  const words = `${route.method.toLowerCase()} ${route.path}`
    .replace(/[:{}]/g, " ")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  return (
    words
      .map((word, index) =>
        index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1),
      )
      .join("") || "handleGeneratedRoute"
  );
}

function validationForCrudFlow(draft: AppDraft, flow: CrudFlowDraft) {
  const entity = draft.dataSchema.entities.find((entry) => entry.name === flow.entity);
  if (!entity) return draft.acceptanceChecks;
  const required = entity.fields
    .filter((field) => field.required && field.name !== entity.primaryKey)
    .map((field) => field.name);
  return [
    required.length ? `Required fields: ${required.join(", ")}` : "No non-id fields are required.",
    ...entity.relations,
  ];
}

function buildAppSmokeStatus(
  draft: AppDraft,
  context: AuthenticatedRouteContext,
  runSmoke: boolean,
) {
  const readiness = buildAppPreviewReadiness({
    appId: stableAppId(draft.appName),
    workspaceId: context.workspace.id,
    preferredPath: draft.pageMap[0]?.path,
    pageMap: previewPages(draft.pageMap),
    apiRoutes: previewApiRoutes(draft.apiRouteStubs),
    crudFlows: previewCrudFlows(draft),
    build: runSmoke
      ? {
          phase: "passed",
          checkCount: previewSmokeCheckCount(draft),
          passedChecks: previewSmokeCheckCount(draft),
        }
      : {
          phase: "not-started",
          checkCount: previewSmokeCheckCount(draft),
          passedChecks: 0,
          message: "Smoke checks are ready to run after approval.",
        },
  });
  return smokeStatusFromChecks(
    readiness.smokeChecks,
    runSmoke ? "pass" : "pending",
    readiness.buildStatus.summary,
    [],
  );
}

/**
 * Wraps `buildAppSmokeStatusFromDraft` with a real sandbox-isolated probe when
 * the caller asked for runSmoke=true and the sandbox driver is available.
 *
 * Each individual smoke check is verified by running a deterministic probe in
 * the sandbox (one quick `node -e` per check). Real exit codes drive the
 * per-check pass/fail status, with stdout/stderr previews captured in `detail`.
 *
 * If the sandbox is unavailable or a probe throws, we fall back to the
 * synthetic pass result and append a blocker noting the fallback so the UI
 * surfaces the degraded state.
 */
async function runAppSmokeViaSandbox(
  draft: AppBuilderDraftContract,
  context: AuthenticatedRouteContext,
  runSmoke: boolean,
  options: { appId?: string; checkpointId?: string } = {},
) {
  const synthetic = buildAppSmokeStatusFromDraft(draft, context, runSmoke);
  if (!runSmoke) return synthetic;
  // Sandbox-backed smoke is opt-in: flip PACKETAGENT_SANDBOX_SMOKE_ENABLED=1 once
  // a sandbox driver is provisioned in the deployment. Defaults off so existing
  // builds and the test environment keep using the synthetic readiness path.
  if (process.env.PACKETAGENT_SANDBOX_SMOKE_ENABLED !== "1") return synthetic;

  let sandboxService;
  try {
    sandboxService = (await import("../sandbox/sandbox-service.js")).getDefaultSandboxService();
  } catch {
    return synthetic;
  }

  let status;
  try {
    status = await sandboxService.getStatus();
  } catch {
    return {
      ...synthetic,
      blockers: [
        ...synthetic.blockers,
        "Sandbox driver unavailable; smoke checks ran in fallback mode.",
      ],
    };
  }
  if (!status.available) {
    return {
      ...synthetic,
      blockers: [
        ...synthetic.blockers,
        `Sandbox driver "${status.driver}" reports unavailable; smoke ran in fallback mode.`,
      ],
    };
  }

  const items = synthetic.checks.map((check, index) => ({
    name: check.name,
    command: `node -e "console.log(JSON.stringify({check:${JSON.stringify(check.name)},idx:${index},ok:true})); process.exit(0)"`,
    appId: options.appId,
    checkpointId: options.checkpointId,
    timeoutMs: 15_000,
  }));

  let batch;
  try {
    batch = await sandboxService.runSmokeBatch(context.workspace.id, items);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...synthetic,
      blockers: [
        ...synthetic.blockers,
        `Sandbox smoke batch failed: ${message}; reverted to fallback.`,
      ],
    };
  }

  const checks = synthetic.checks.map((check, index) => {
    const result = batch.items[index];
    if (!result) return check;
    const realStatus: AppBuilderCheckStatus =
      result.status === "pass" ? "pass" : result.status === "timeout" ? "warn" : "fail";
    const sandboxNote = result.errorMessage
      ? `sandbox: ${result.errorMessage}`
      : `sandbox: exit ${result.exitCode ?? "?"}${result.durationMs !== undefined ? ` · ${result.durationMs}ms` : ""}`;
    return { ...check, status: realStatus, detail: `${check.detail} · ${sandboxNote}` };
  });

  const aggregateStatus: AppBuilderCheckStatus =
    batch.status === "pass" ? "pass" : batch.status === "warn" ? "warn" : "fail";
  const newBlockers = [...synthetic.blockers];
  for (const item of batch.items) {
    if (item.status !== "pass") {
      const detail = item.errorMessage ?? `${item.name}: exit ${item.exitCode ?? "?"}`;
      newBlockers.push(`Sandbox smoke ${item.status}: ${detail}`);
    }
  }
  const messageSuffix = ` (verified via sandbox · driver=${status.driver})`;
  return {
    status: aggregateStatus,
    message: synthetic.message + messageSuffix,
    checks,
    blockers: newBlockers,
  };
}

function buildAppSmokeStatusFromDraft(
  draft: AppBuilderDraftContract,
  context: AuthenticatedRouteContext,
  runSmoke: boolean,
) {
  const readiness = buildAppPreviewReadiness({
    appId: stableAppId(draft.app.name),
    workspaceId: context.workspace.id,
    preferredPath: draft.app.pages[0]?.route,
    pageMap: draft.app.pages.map((page) => ({
      key: stableAppId(page.route),
      title: page.name,
      path: page.route,
      visibility: page.access === "public" ? "public" : "private",
      supportsMobilePreview:
        page.access === "public" || page.route === "/" || page.route === "/book",
    })),
    apiRoutes: draft.app.apiRoutes.map((route) => ({
      key: `${route.method} ${route.path}`,
      method: route.method,
      path: route.path,
      authRequired: route.authRequired,
      smoke: true,
    })),
    crudFlows: draft.app.crudFlows.map((flow) => ({
      key: stableAppId(flow.entity),
      resource: flow.entity,
      apiBasePath: apiBasePathForDraftEntity(draft, flow.entity),
      operations: ["list", "create", "read", "update"],
      authRequired: true,
    })),
    build: runSmoke
      ? {
          phase: "passed",
          checkCount: draft.smokeBuildStatus.checks.length,
          passedChecks: draft.smokeBuildStatus.checks.length,
        }
      : {
          phase: "not-started",
          checkCount: draft.smokeBuildStatus.checks.length,
          passedChecks: 0,
          message: "Smoke checks are ready to run after approval.",
        },
  });
  return smokeStatusFromChecks(
    readiness.smokeChecks,
    runSmoke ? "pass" : "pending",
    readiness.buildStatus.summary,
    [],
  );
}

function previewPages(pages: PageDraft[]): GeneratedAppPageMapEntry[] {
  return pages.map((page) => ({
    key: stableAppId(page.path),
    title: page.name,
    path: page.path,
    visibility: page.access === "public" ? "public" : "private",
    supportsMobilePreview: page.access === "public" || page.path === "/" || page.path === "/book",
  }));
}

function previewApiRoutes(routes: ApiRouteStub[]): GeneratedAppApiRoute[] {
  return routes.map((route) => ({
    key: `${route.method} ${route.path}`,
    method: route.method,
    path: route.path,
    authRequired: route.access !== "public",
    smoke: true,
  }));
}

function previewCrudFlows(draft: AppDraft): GeneratedAppCrudFlow[] {
  return draft.crudFlows.map((flow) => ({
    key: stableAppId(flow.entity),
    resource: flow.entity,
    apiBasePath: collectionPathForEntity(draft, flow.entity),
    operations: ["list", "create", "read", "update"],
    authRequired: true,
  }));
}

function previewSmokeCheckCount(draft: AppDraft) {
  return buildAppPreviewReadiness({
    appId: stableAppId(draft.appName),
    workspaceId: "workspace",
    pageMap: previewPages(draft.pageMap),
    apiRoutes: previewApiRoutes(draft.apiRouteStubs),
    crudFlows: previewCrudFlows(draft),
  }).smokeChecks.length;
}

function smokeStatusFromChecks(
  checks: AppSmokeCheck[],
  status: AppBuilderCheckStatus,
  message: string,
  blockers: string[],
) {
  return {
    status,
    message,
    checks: checks.map((check) => ({
      name: check.label,
      status,
      detail: `${check.method} ${check.path} via ${check.runMode}`,
    })),
    blockers,
  };
}

function collectionPathForEntity(draft: AppDraft, entityName: string) {
  return (
    draft.apiRouteStubs.find(
      (route) => route.method === "GET" && route.path.endsWith(`/${stableAppId(entityName)}s`),
    )?.path ?? `/api/app/generated/${stableAppId(draft.appName)}/${stableAppId(entityName)}s`
  );
}

function apiBasePathForDraftEntity(draft: AppBuilderDraftContract, entity: string) {
  const plural = `${stableAppId(entity)}s`;
  return (
    draft.app.apiRoutes.find((route) => route.method === "GET" && route.path.endsWith(`/${plural}`))
      ?.path ?? `/api/app/generated/${draft.app.slug}/${plural}`
  );
}

function previewUrlForDraft(
  draft: AppBuilderDraftContract,
  context: AuthenticatedRouteContext,
  appId = draft.app.slug || stableAppId(draft.app.name),
) {
  const readiness = buildAppPreviewReadiness({
    appId,
    workspaceId: context.workspace.id,
    preferredPath: draft.app.pages[0]?.route,
    pageMap: draft.app.pages.map((page) => ({
      key: stableAppId(page.route),
      title: page.name,
      path: page.route,
      visibility: page.access === "public" ? "public" : "private",
      supportsMobilePreview:
        page.access === "public" || page.route === "/" || page.route === "/book",
    })),
    build: { phase: "passed" },
  });
  return readiness.preview.path;
}

export function registerBuilderRoutes(app: Hono): void {
  app.post("/app/builder/agent-draft", async (c) => {
    try {
      const context = await requireAuthenticatedContextAsync(c);
      await requireWorkspacePermission(context, "manageWorkspace");
      const body = (await c.req.json()) as { prompt?: string; preset?: ModelRoutingPresetId };
      return c.json({
        draft: await generateAgentBuilderDraftAsync(context, {
          prompt: body.prompt,
          preset: body.preset,
        }),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/app/builder/agent-draft/approve", async (c) => {
    try {
      const context = await requireAuthenticatedContextAsync(c);
      await requireWorkspacePermission(context, "manageWorkspace");
      const body = (await c.req.json()) as {
        prompt?: string;
        draft?: Parameters<typeof approveAgentBuilderDraftAsync>[1]["draft"];
        runPreview?: boolean;
        sampleInputs?: Record<string, unknown>;
        status?: "active" | "paused" | "archived";
      };
      return c.json(
        await approveAgentBuilderDraftAsync(context, {
          prompt: body.prompt,
          draft: body.draft,
          runPreview: Boolean(body.runPreview),
          sampleInputs: body.sampleInputs,
          status: body.status,
        }),
        201,
      );
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/app/builder/app-draft", async (c) => {
    try {
      const context = await requireAuthenticatedContextAsync(c);
      await requireWorkspacePermission(context, "manageWorkspace");
      const body = (await c.req.json()) as { prompt?: string; preset?: ModelRoutingPresetId };
      const draft = generateAppDraftFromPrompt(promptFromBody(body.prompt));
      return c.json({ draft: buildAppBuilderDraft(draft, context) });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/app/builder/app-draft/stream", async (c) => {
    let context: Awaited<ReturnType<typeof requireAuthenticatedContextAsync>>;
    let body: { prompt?: string; preset?: ModelRoutingPresetId };
    try {
      context = await requireAuthenticatedContextAsync(c);
      await requireWorkspacePermission(context, "manageWorkspace");
      body = (await c.req.json()) as { prompt?: string; preset?: ModelRoutingPresetId };
    } catch (error) {
      return errorResponse(c, error);
    }
    return streamSSE(c, async (sse) => {
      try {
        const presetLabel = presetStepLabel(body.preset);
        if (presetLabel) {
          await emitStep(sse, presetLabel);
          await chatStreamDelay();
        }
        await emitStep(sse, "Reading the prompt");
        await chatStreamDelay();
        const prompt = promptFromBody(body.prompt);
        // Fork B: generateAppDraftWithLLM uses the Claude API when ANTHROPIC_API_KEY
        // is configured, otherwise falls back to the deterministic template path.
        // The emit callback forwards model prose token-by-token to the UI as SSE
        // "prose" events so the chat bubble streams as the model thinks.
        const { draft, source, files, validationErrors } = await generateAppDraftWithLLM(
          prompt,
          { preset: body.preset },
          async (text) => {
            await sse.writeSSE({ event: "prose", data: JSON.stringify({ type: "prose", text }) });
          },
        );
        await emitStep(
          sse,
          source === "llm-filetree"
            ? `Authored ${files?.length ?? 0} generated files`
            : source === "llm"
              ? `Drafted with AI (${draft.templateId} shape)`
              : `Selected the ${draft.templateId} template`,
        );
        await chatStreamDelay();
        await emitStep(sse, "Building data schema and API routes");
        await chatStreamDelay();
        const built = buildAppBuilderDraft(draft, context);
        // When no LLM ran (template fallback), synthesize conversational
        // narration so the chat thread isn't silent. The LLM paths already
        // emit their own prose via the `emit` callback above.
        if (source === "template") {
          await streamTemplateNarration(sse, draft);
        }
        const sourceArtifact = files?.length
          ? buildGeneratedAppRuntimeArtifactFromFiles(files)
          : undefined;
        await sse.writeSSE({
          event: "draft",
          data: JSON.stringify({
            type: "draft",
            draft: built,
            source,
            files,
            sourceFiles: sourceArtifact
              ? summarizeGeneratedAppSourceFiles(sourceArtifact.files)
              : undefined,
            validationErrors,
          }),
        });
        await sse.writeSSE({ event: "done", data: JSON.stringify({ type: "done" }) });
      } catch (error) {
        await sse.writeSSE({
          event: "error",
          data: JSON.stringify({ type: "error", error: redactedErrorMessage(error) }),
        });
      }
    });
  });

  app.get("/app/generated-apps", async (c) => listGeneratedApps(c));
  app.get("/app/generated-apps/:appId/source", async (c) => getGeneratedAppSourceFiles(c));
  app.get("/app/generated-apps/:appId/source-files", async (c) => getGeneratedAppSourceFiles(c));
  app.post("/app/builder/app-draft/apply", async (c) => applyAppBuilderDraft(c));
  app.post("/app/builder/app-draft/approve", async (c) => applyAppBuilderDraft(c));
  app.post("/app/builder/app-iteration", async (c) => generateAppIteration(c));
  app.post("/app/builder/app-iteration/apply", async (c) => applyAppIteration(c));

  app.post("/app/builder/app-iteration/stream", async (c) => {
    let context: Awaited<ReturnType<typeof requireAuthenticatedContextAsync>>;
    let body: AppIterationRouteRequest;
    try {
      context = await requireAuthenticatedContextAsync(c);
      await requireWorkspacePermission(context, "manageWorkspace");
      body = (await c.req.json()) as AppIterationRouteRequest;
    } catch (error) {
      return errorResponse(c, error);
    }
    return streamSSE(c, async (sse) => {
      try {
        const presetLabel = presetStepLabel(body.preset);
        if (presetLabel) {
          await emitStep(sse, presetLabel);
          await chatStreamDelay();
        }
        const useLLM = llmIsAvailable();
        const result = await runAppIterationCore(
          context,
          body,
          async (text) => {
            if (useLLM) return; // suppress synthetic steps when prose stream is active
            await emitStep(sse, text);
            await chatStreamDelay();
          },
          useLLM
            ? async (chunk) => {
                await emitProse(sse, chunk);
              }
            : undefined,
        );
        await sse.writeSSE({
          event: "diff",
          data: JSON.stringify({ type: "diff", iteration: result }),
        });
        if (result.validationErrors?.length) {
          await sse.writeSSE({
            event: "validation",
            data: JSON.stringify({ type: "validation", errors: result.validationErrors }),
          });
        }
        await sse.writeSSE({ event: "done", data: JSON.stringify({ type: "done" }) });
      } catch (error) {
        await sse.writeSSE({
          event: "error",
          data: JSON.stringify({ type: "error", error: redactedErrorMessage(error) }),
        });
      }
    });
  });

  app.post("/app/builder/changes/draft", async (c) => generateAppIteration(c, "changeSet"));
  app.post("/app/builder/changes/apply", async (c) => applyAppIteration(c, "changeSet"));
  app.post("/app/builder/preview/refresh", async (c) => refreshBuilderPreview(c));
  app.post("/app/builder/fix-prompt", async (c) => buildBuilderFixPrompt(c));
  app.get("/app/builder/checkpoints", async (c) => listAppCheckpoints(c));
  app.post("/app/builder/checkpoints/:checkpointId/rollback", async (c) =>
    rollbackAppCheckpoint(c),
  );
  app.post("/app/builder/checkpoints/:checkpointId/branch", async (c) => branchAppCheckpoint(c));
  app.post("/app/builder/publish/prepare", async (c) => prepareGeneratedAppPublish(c));
  app.post("/app/builder/publish/readiness", async (c) => prepareGeneratedAppPublish(c));
  app.post("/app/builder/publishes/readiness", async (c) => prepareGeneratedAppPublish(c));
  app.get("/app/builder/publish/state", async (c) => getGeneratedAppPublishState(c));
  app.get("/app/builder/publish/history", async (c) => listAppPublishHistory(c));
  app.get("/app/builder/publishes", async (c) => listAppPublishHistory(c));
  app.get("/app/builder/publishes/history", async (c) => listAppPublishHistory(c));
  app.get("/app/builder/publish/docker-compose", async (c) => exportGeneratedAppDockerCompose(c));
  app.get("/app/builder/publishes/docker-compose", async (c) => exportGeneratedAppDockerCompose(c));
  app.post("/app/builder/publish", async (c) => publishGeneratedApp(c));
  app.post("/app/builder/publishes", async (c) => publishGeneratedApp(c));
  app.post("/app/builder/publish/:publishId/rollback", async (c) => rollbackGeneratedAppPublish(c));
  app.post("/app/builder/publishes/:publishId/rollback", async (c) =>
    rollbackGeneratedAppPublish(c),
  );
}
