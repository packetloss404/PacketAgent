import { AppPublishRollbackRouteRequest, AppPublishRouteRequest } from "./contracts.js";
import { buildAgentPublishPayload, rollbackAgentPublish } from "./publish-agents.js";
import {
  builderPublishState,
  buildPublishPreflight,
  integrationsReadyForPublish,
  publishRuntimeEnv,
  readMaterializedGeneratedAppPublishWorkspace,
} from "./publish-artifacts.js";
import {
  buildGeneratedAppPublishRecord,
  buildGeneratedAppPublishRollbackResult,
  createGeneratedAppPublishRollbackCommand,
  orderGeneratedAppPublishHistory,
} from "../../app-publish-history.js";
import {
  checkpointForPublish,
  currentPublishedRecord,
  findGeneratedAppRecord,
  findGeneratedAppRecordForPublish,
  latestPublishRollbackCommand,
  publishedAppSummary,
} from "./generated-apps.js";
import {
  errorResponse,
  httpRouteError,
  requireWorkspacePermission,
  stableHash,
} from "../shared.js";
import { mutateStoreAsync, recordActivity } from "../../packetagent-store.js";
import { requireAuthenticatedContextAsync } from "../../packetagent-services.js";
import { type Context } from "hono";

export async function prepareGeneratedAppPublish(c: Context) {
  try {
    const context = await requireAuthenticatedContextAsync(c);
    await requireWorkspacePermission(context, "manageWorkspace");
    const body = (await c.req.json().catch(() => ({}))) as AppPublishRouteRequest;
    if (body.agentId && !body.appId) return c.json(await buildAgentPublishPayload(context, body));
    const record = await findGeneratedAppRecord(context, body.appId, body.checkpointId);
    if (!record) throw httpRouteError(404, "generated app not found");
    const checkpoint = checkpointForPublish(record, body.checkpointId);
    if (!checkpoint) throw httpRouteError(404, "checkpoint not found");
    const { validation, integrations, artifactManifest } = await buildPublishPreflight(
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
      artifactManifest,
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

export async function getGeneratedAppPublishState(c: Context) {
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
    const { validation, integrations, artifactManifest } = await buildPublishPreflight(
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
      artifactManifest,
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

export async function listAppPublishHistory(c: Context) {
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

export async function getGeneratedAppPublishIntegrity(c: Context) {
  try {
    const context = await requireAuthenticatedContextAsync(c);
    await requireWorkspacePermission(context, "viewWorkspace");
    const record = await findGeneratedAppRecord(context, c.req.param("appId"));
    if (!record) throw httpRouteError(404, "generated app not found");
    const requestedPublishId = c.req.query("publishId")?.trim();
    const publish = requestedPublishId
      ? (record.publishHistory ?? []).find((entry) => entry.id === requestedPublishId)
      : currentPublishedRecord(record);
    if (!publish) throw httpRouteError(404, "generated app publish not found");
    const materialized = readMaterializedGeneratedAppPublishWorkspace(publish.localPublishPath, {
      workspaceId: context.workspace.id,
      appId: record.id,
      checkpointId: publish.checkpointId,
    });
    if (!materialized) throw httpRouteError(404, "generated app publish manifest not found");
    c.header("Cache-Control", "private, no-store");
    return c.json({
      appId: record.id,
      publishId: publish.id,
      checkpointId: publish.checkpointId,
      localPublishPath: publish.localPublishPath,
      manifest: materialized.manifest,
      verification: materialized.verification,
    });
  } catch (error) {
    return errorResponse(c, error);
  }
}

export async function publishGeneratedApp(c: Context) {
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
    const { validation, integrations, artifactManifest } = await buildPublishPreflight(
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
      artifactManifest,
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

export async function rollbackGeneratedAppPublish(c: Context) {
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

export async function exportGeneratedAppDockerCompose(c: Context) {
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
