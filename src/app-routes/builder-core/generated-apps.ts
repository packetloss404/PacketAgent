import {
  AppBuilderDraftContract,
  AppDraftSource,
  AppIterationRouteRequest,
  GeneratedAppCheckpointWithRuntime,
  GeneratedAppRecordWithRuntime,
} from "./contracts.js";
import {
  buildGeneratedAppRuntimeArtifact,
  findGeneratedAppSourceFile,
  type GeneratedAppRuntimeArtifactRecord,
  type GeneratedAppSourceFileRecord,
  summarizeGeneratedAppSourceFiles,
} from "../../generated-app-runtime.js";
import { buildGeneratedAppWorkspaceExport } from "../../codegen/workspace-export.js";
import { orderGeneratedAppPublishHistory } from "../../app-publish-history.js";
import { planGeneratedAppPackageInstall } from "../../codegen/package-plan.js";
import { requireAuthenticatedContextAsync } from "../../packetagent-services.js";
import {
  type AuthenticatedRouteContext,
  errorResponse,
  httpRouteError,
  requireWorkspacePermission,
} from "../shared.js";
import { type Context } from "hono";
import {
  type GeneratedAppPublishRecord,
  type GeneratedAppRecord,
  loadStoreAsync,
} from "../../packetagent-store.js";
import { type GeneratedFile } from "../../codegen/llm-author.js";
import { writeGeneratedAppWorkspace } from "./draft.js";

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

export async function findGeneratedAppRecordForPublish(
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

export async function listGeneratedApps(c: Context) {
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

export async function getGeneratedAppSourceFiles(c: Context) {
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

export async function getGeneratedAppPackagePlan(c: Context) {
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
    const files = generatedFilesFromSourceRecords(artifact.files) ?? [];
    return c.json({
      app: { id: record.id, slug: record.slug, name: record.name },
      checkpoint: { id: checkpoint.id, createdAt: checkpoint.createdAt },
      plan: planGeneratedAppPackageInstall(files),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
}

export async function exportGeneratedAppWorkspace(c: Context) {
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
    const files = generatedFilesFromSourceRecords(artifact.files) ?? [];
    const packagePlan = planGeneratedAppPackageInstall(files);
    const exported = buildGeneratedAppWorkspaceExport({
      appId: record.id,
      appSlug: record.slug,
      workspaceId: context.workspace.id,
      checkpointId: checkpoint.id,
      checkpointCreatedAt: checkpoint.createdAt,
      files,
      packagePlan,
    });
    const responseBytes = Uint8Array.from(exported.bytes);
    return c.body(responseBytes, 200, {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="${exported.fileName}"`,
      "Content-Length": String(exported.bytes.byteLength),
      "Content-Type": "application/zip",
      "X-PacketAgent-Checkpoint": checkpoint.id,
      "X-PacketAgent-Package-Plan": packagePlan.status,
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

export function fileTreeForIteration(
  body: AppIterationRouteRequest,
  record: GeneratedAppRecordWithRuntime | undefined,
  checkpoint: GeneratedAppCheckpointWithRuntime | null,
  fallbackFiles: GeneratedAppSourceFileRecord[],
): { source?: AppDraftSource; files?: GeneratedFile[] } {
  const bodyFiles = generatedFilesFromUnknown(body.fileTree);
  if (bodyFiles?.length) {
    return { source: body.draftSource ?? "llm-filetree", files: bodyFiles };
  }

  const source = body.draftSource ?? checkpoint?.codegenSource ?? record?.codegenSource;
  const recordFiles = checkpoint?.sourceFiles?.length
    ? checkpoint.sourceFiles
    : checkpoint?.id === record?.checkpointId && record?.sourceFiles?.length
      ? record.sourceFiles
      : record?.sourceFiles?.length
        ? record.sourceFiles
        : fallbackFiles;
  return { source, files: generatedFilesFromSourceRecords(recordFiles) };
}

export function generatedFilesFromUnknown(value: unknown): GeneratedFile[] | undefined {
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

export function generatedFilesFromSourceRecords(
  records: GeneratedAppSourceFileRecord[] | undefined,
): GeneratedFile[] | undefined {
  if (!records?.length) return undefined;
  return records.map((file) => ({ path: file.path, content: file.content }));
}

export function runtimeArtifactFromSourceFiles(
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

export function cloneGeneratedAppRuntimeArtifact(
  artifact: GeneratedAppRuntimeArtifactRecord,
): GeneratedAppRuntimeArtifactRecord {
  return {
    entrypoint: artifact.entrypoint,
    renderedAt: artifact.renderedAt,
    files: artifact.files.map((file) => ({ ...file })),
  };
}

export function branchDraftForGeneratedApp(
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

export function currentPublishedRecord(
  record: GeneratedAppRecord,
): GeneratedAppPublishRecord | null {
  const history = record.publishHistory ?? [];
  return (
    history.find((entry) => entry.id === record.currentPublishId) ??
    orderGeneratedAppPublishHistory(history).find((entry) => entry.status === "published") ??
    null
  );
}

export function latestPublishRollbackCommand(record: GeneratedAppRecord) {
  return currentPublishedRecord(record)?.rollbackCommand;
}

export function publishedAppSummary(record: GeneratedAppRecord) {
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
