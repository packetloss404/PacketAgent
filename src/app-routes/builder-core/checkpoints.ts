import {
  AppBuilderDraftContract,
  GeneratedAppCheckpointWithRuntime,
  GeneratedAppRecordWithRuntime,
} from "./contracts.js";
import {
  branchDraftForGeneratedApp,
  cloneGeneratedAppRuntimeArtifact,
  findGeneratedAppRecord,
  generatedAppRuntimeArtifact,
  generatedFilesFromSourceRecords,
  runtimeArtifactFromSourceFiles,
} from "./generated-apps.js";
import {
  buildAppPreviewSnapshotMetadata,
  createAppPreviewRollbackCommand,
} from "../../app-preview-snapshots.js";
import {
  buildGeneratedAppRuntimeArtifact,
  summarizeGeneratedAppSourceFiles,
} from "../../generated-app-runtime.js";
import {
  errorResponse,
  httpRouteError,
  requireWorkspacePermission,
  stableHash,
} from "../shared.js";
import { loadStoreAsync, mutateStoreAsync, recordActivity } from "../../packetagent-store.js";
import { previewUrlForDraft } from "./smoke.js";
import { requireAuthenticatedContextAsync } from "../../packetagent-services.js";
import { type Context } from "hono";
import { buildGeneratedAppSmokeTranscript } from "../../generated-app-smoke-transcript.js";

export async function listAppCheckpoints(c: Context) {
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
          smokeTranscript: checkpoint.smokeTranscript,
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

export async function rollbackAppCheckpoint(c: Context) {
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
        smokeTranscript: buildDerivedSmokeTranscript({
          workspaceId: context.workspace.id,
          appId: app.id,
          checkpointId: restoredCheckpointId,
          source: "rollback",
          transcript: target.smokeTranscript,
          fallbackStatus: target.smokeStatus,
          recordedAt: timestamp,
        }),
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

export async function branchAppCheckpoint(c: Context) {
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
        smokeTranscript: buildDerivedSmokeTranscript({
          workspaceId: context.workspace.id,
          appId: newAppId,
          checkpointId: newCheckpointId,
          source: "branch",
          transcript: sourceCheckpoint.smokeTranscript,
          fallbackStatus: sourceCheckpoint.smokeStatus,
          recordedAt: timestamp,
        }),
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

function buildDerivedSmokeTranscript(input: {
  workspaceId: string;
  appId: string;
  checkpointId: string;
  source: "rollback" | "branch";
  transcript: GeneratedAppCheckpointWithRuntime["smokeTranscript"];
  fallbackStatus?: string;
  recordedAt: string;
}) {
  const prior = input.transcript;
  return buildGeneratedAppSmokeTranscript({
    workspaceId: input.workspaceId,
    appId: input.appId,
    checkpointId: input.checkpointId,
    source: input.source,
    recordedAt: input.recordedAt,
    ...(prior ? { derivedFromTranscriptId: prior.id } : {}),
    result: prior
      ? {
          status: prior.status,
          message: prior.summary,
          checks: prior.checks,
          blockers: prior.blockers,
          execution: {
            startedAt: prior.startedAt,
            completedAt: prior.completedAt,
            durationMs: prior.durationMs,
            runner: prior.runner,
            ...(prior.validatorSource ? { validatorSource: prior.validatorSource } : {}),
          },
        }
      : {
          status: input.fallbackStatus ?? "pending",
          message: "This checkpoint predates persisted smoke transcripts.",
          checks: [],
          blockers: [],
        },
  });
}
