import {
  AppBuilderDraftContract,
  AppIterationApplyRouteRequest,
  AppIterationRouteRequest,
  AppIterationRouteResult,
} from "./contracts.js";
import {
  appIterationFileTreeTarget,
  appIterationResponse,
  appIterationTargetForService,
  diffGeneratedAppSourceFiles,
  fromGeneratedAppDraftLike,
  mergeIterationDiffFiles,
  routeLog,
  toGeneratedAppDraftLike,
} from "./iteration-transforms.js";
import {
  buildAppBuilderDraft,
  persistGeneratedAppDraft,
  promptFromBody,
  stableGeneratedAppId,
  writeGeneratedAppWorkspace,
} from "./draft.js";
import {
  buildAppPreviewSnapshotMetadata,
  compareAppPreviewSnapshots,
} from "../../app-preview-snapshots.js";
import {
  buildAppSmokeStatusFromDraft,
  previewUrlForDraft,
  runAppSmokeViaSandbox,
} from "./smoke.js";
import {
  buildGeneratedAppRuntimeArtifact,
  buildGeneratedAppRuntimeArtifactFromFiles,
  summarizeGeneratedAppSourceFiles,
} from "../../generated-app-runtime.js";
import {
  checkpointForPublish,
  fileTreeForIteration,
  findGeneratedAppRecord,
  generatedAppRuntimeArtifact,
  generatedFilesFromSourceRecords,
  generatedFilesFromUnknown,
} from "./generated-apps.js";
import { deriveDraftFromFiles } from "../../codegen/derived-draft.js";
import { derivePreviewRefreshState } from "../../app-preview-iteration.js";
import {
  getIntegrationReadinessAsync,
  requireAuthenticatedContextAsync,
} from "../../packetagent-services.js";
import { inspectAppIterationTools } from "../../app-iteration-tools.js";
import {
  type AppIterationChangeRequest,
  type AppIterationFileTreeOptions,
  type AppIterationLLMResult,
  type AppIterationPresetId,
  applyAppIterationToDraft,
  applyAppIterationViaFileTree,
  applyAppIterationViaLLM,
  buildAppIterationPlan,
  canonicalizeIterationFileTree,
} from "../../app-iteration-service.js";
import {
  type AuthenticatedRouteContext,
  errorResponse,
  httpRouteError,
  requireWorkspacePermission,
  stableAppId,
} from "../shared.js";
import { type Context } from "hono";
import { type GeneratedAppRecord, mutateStoreAsync } from "../../packetagent-store.js";
import { buildGeneratedAppSmokeTranscript } from "../../generated-app-smoke-transcript.js";

export async function generateAppIteration(
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

export async function runAppIterationCore(
  context: Awaited<ReturnType<typeof requireAuthenticatedContextAsync>>,
  body: AppIterationRouteRequest,
  onStep?: (text: string) => Promise<void> | void,
  onProse?: (chunk: string) => Promise<void> | void,
  onFileProgress?: NonNullable<AppIterationFileTreeOptions["onFileProgress"]>,
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

  const fileTreeInput = fileTreeForIteration(
    body,
    record,
    previousCheckpoint,
    previousArtifact.files,
  );
  const canonicalFileTree = canonicalizeIterationFileTree({
    flagOn: process.env.PACKETAGENT_LEGACY_TEMPLATES !== "1",
    draftSource: fileTreeInput.source,
    files: fileTreeInput.files,
  });
  if (canonicalFileTree && integrationReadiness.providers.readyCount > 0) {
    await onStep?.("Updating generated file tree");
    let fileTreeResult: Awaited<ReturnType<typeof applyAppIterationViaFileTree>> | null = null;
    try {
      fileTreeResult = await applyAppIterationViaFileTree(
        canonicalFileTree.files,
        changeText,
        {
          workspaceId: context.workspace.id,
          preset: body.preset as AppIterationPresetId | undefined,
          target: appIterationFileTreeTarget(body.target),
          ...(onFileProgress ? { onFileProgress } : {}),
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
          ...(fileTreeResult.outOfScopePaths.length > 0
            ? [
                routeLog(
                  "info",
                  `Restored ${fileTreeResult.outOfScopePaths.length} out-of-scope model change${fileTreeResult.outOfScopePaths.length === 1 ? "" : "s"} before review.`,
                ),
              ]
            : []),
          ...(canonicalFileTree.convertedFrom
            ? [
                routeLog(
                  "info",
                  `Converted the ${canonicalFileTree.convertedFrom} source bundle to the canonical file-tree path.`,
                ),
              ]
            : []),
        ],
        snapshot,
        tools,
        sourceDiffFiles,
        sourceFiles: candidateArtifact.files,
        artifact: candidateArtifact,
        llmResult: fileTreeResult,
        fileReview: fileTreeResult.reviewFiles,
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
  const convertedFallbackFiles = canonicalFileTree
    ? generatedFilesFromSourceRecords(candidateArtifact.files)
    : undefined;
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
      ...(canonicalFileTree?.convertedFrom
        ? [
            routeLog(
              "info",
              `Converted the ${canonicalFileTree.convertedFrom} source bundle to the canonical file-tree path after deterministic iteration.`,
            ),
          ]
        : []),
    ],
    snapshot,
    tools,
    sourceDiffFiles,
    sourceFiles: candidateArtifact.files,
    artifact: candidateArtifact,
    llmResult,
    fileTree: convertedFallbackFiles,
    draftSource: canonicalFileTree ? "llm-filetree" : undefined,
  });
}

export async function applyAppIteration(
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
      smokeResult: smoke,
      smokeSource: "iteration",
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

export async function refreshBuilderPreview(c: Context) {
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
    const targetCheckpoint = checkpointForPublish(record, body.checkpointId ?? record.checkpointId);
    if (!targetCheckpoint) throw httpRouteError(404, "checkpoint not found");
    const targetCheckpointId = targetCheckpoint.id;
    const draft = targetCheckpoint.draft as unknown as AppBuilderDraftContract;
    const runSmoke = Boolean(body.runSmoke || body.runBuild);
    const smoke = await runAppSmokeViaSandbox(draft, context, runSmoke, {
      appId: record.id,
      checkpointId: targetCheckpointId,
    });
    const previewUrl =
      runSmoke && smoke.status === "pass"
        ? previewUrlForDraft(draft, context, record.id)
        : (targetCheckpoint.previewUrl ?? record.previewUrl);
    const recordedAt = new Date().toISOString();
    const smokeTranscript = buildGeneratedAppSmokeTranscript({
      workspaceId: context.workspace.id,
      appId: record.id,
      checkpointId: targetCheckpointId,
      source: "preview-refresh",
      result: smoke,
      recordedAt,
    });
    const persisted = await mutateStoreAsync((data) => {
      const app = data.generatedApps?.find(
        (entry) => entry.workspaceId === context.workspace.id && entry.id === record.id,
      );
      const checkpoint = app?.checkpoints?.find((entry) => entry.id === targetCheckpointId);
      if (!app || !checkpoint) return false;
      checkpoint.smokeTranscript = smokeTranscript;
      checkpoint.smokeStatus = smoke.status;
      checkpoint.buildStatus = runSmoke
        ? smoke.status === "pass"
          ? "passed"
          : "failed"
        : checkpoint.buildStatus;
      if (app.checkpointId === targetCheckpointId) {
        app.smokeStatus = checkpoint.smokeStatus;
        app.buildStatus = checkpoint.buildStatus;
        app.previewUrl = previewUrl;
        app.updatedAt = recordedAt;
      }
      return true;
    });
    if (!persisted) throw httpRouteError(409, "checkpoint changed during smoke refresh");
    const snapshot = buildAppPreviewSnapshotMetadata({
      workspaceId: context.workspace.id,
      appId: record.id,
      appSlug: record.slug,
      appName: record.name,
      checkpointId: targetCheckpointId,
      checkpointSavedAt: targetCheckpoint.createdAt,
      buildStatus: runSmoke
        ? smoke.status === "pass"
          ? "passed"
          : "failed"
        : targetCheckpoint.buildStatus,
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
        phase: runSmoke ? (smoke.status === "pass" ? "passed" : "failed") : "queued",
        checkCount: smoke.checks.length,
        passedChecks: smoke.checks.filter((check) => check.status === "pass").length,
        buildId: snapshot.build.id,
        revision: targetCheckpointId,
      },
      lastRendered: previewUrl
        ? {
            buildId: snapshot.build.id,
            revision: targetCheckpointId,
            refreshedAt: new Date().toISOString(),
            previewUrl,
          }
        : undefined,
    });
    const artifact = generatedAppRuntimeArtifact(record, targetCheckpoint);
    const workspace = await writeGeneratedAppWorkspace(context, record, targetCheckpoint, artifact);

    return c.json({
      preview,
      build: {
        status: runSmoke ? "passed" : (record.buildStatus ?? "queued"),
        checks: smoke.checks,
      },
      smoke,
      checkpoint: { id: targetCheckpointId, appId: record.id, savedAt: targetCheckpoint.createdAt },
      smokeTranscript,
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

export async function buildBuilderFixPrompt(c: Context) {
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

export function latestPreviewSnapshot(record: GeneratedAppRecord | undefined) {
  const latest = record?.previewSnapshots?.at(-1);
  return latest as ReturnType<typeof buildAppPreviewSnapshotMetadata> | undefined;
}
