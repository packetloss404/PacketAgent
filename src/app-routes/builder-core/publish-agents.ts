import { AppPublishRollbackRouteRequest, AppPublishRouteRequest } from "./contracts.js";
import { buildAppPublishReadiness } from "../../app-publish-readiness.js";
import { buildAppPublishValidation } from "../../app-publish-service.js";
import { loadStoreAsync, mutateStoreAsync } from "../../packetagent-store.js";
import { localPublishHealthObservation, publishRuntimeEnv } from "./publish-artifacts.js";
import { type AuthenticatedRouteContext, httpRouteError, stableHash } from "../shared.js";
import { type Context } from "hono";

export async function buildAgentPublishPayload(
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
    privateBaseUrl: body.privateBaseUrl ?? "http://localhost:8484",
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

export async function rollbackAgentPublish(
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
