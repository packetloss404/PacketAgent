import { migrateLegacyDefaultDataFiles } from "./brand.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  archiveAgentAsync,
  cancelAgentRunAsync,
  createAgentAsync,
  createAgentFromTemplateAsync,
  createProviderAsync,
  createWorkspaceEnvVarAsync,
  deleteWorkspaceEnvVarByIdAsync,
  exportAgentBundleAsync,
  generateAgentFromPromptAsync,
  getAgentAsync,
  getAgentRunDetailAsync,
  getIntegrationReadinessAsync,
  getPublicActivationSummary,
  handleInvitationEmailJob,
  INVITATION_EMAIL_JOB_TYPE,
  listPublicActivationSummaries,
  listAgentRunsAsync,
  listAgentTemplates,
  listAgentsAsync,
  listProvidersAsync,
  listReleaseHistoryAsync,
  listWorkspaceEnvVarsForUserAsync,
  importAgentBundleAsync,
  retryAgentRun,
  recordRunAsPlaybookAsync,
  runAgent,
  type RunAgentInput,
  updateAgentAsync,
  updateProviderAsync,
  updateWorkspaceEnvVarAsync,
  validateAgentBundleImportAsync,
} from "./packetagent-services.js";
import { requirePrivateWorkspaceRoleAsync } from "./rbac.js";
import { appRoutes } from "./app-routes.js";
import { workflowRoutes } from "./workflow-routes.js";
import { apiKeyRoutes } from "./api-key-routes.js";
import { usageRoutes } from "./usage-routes.js";
import { llmStreamRoutes } from "./llm-stream-routes.js";
import { jobRoutes } from "./job-routes.js";
import { JobScheduler } from "./jobs/scheduler.js";
import { selectSchedulerLeaderLock } from "./jobs/scheduler-leader-selection.js";
import {
  ensureMetricsSnapshotCronJobAsync,
  handleMetricsSnapshotJob,
  METRICS_SNAPSHOT_JOB_TYPE,
  type MetricsSnapshotJobPayload,
} from "./jobs/metrics-snapshot-handler.js";
import {
  createWorkerRetentionJobHandler,
  ensureWorkerRetentionJobs,
  WORKER_RETENTION_JOB_TYPE,
} from "./jobs/worker-retention-handler.js";
import { registerDefaultProviders } from "./providers/bootstrap.js";
import { registerDefaultTools } from "./tools/bootstrap.js";
import { getDefaultToolRegistry } from "./tools/registry.js";
import { shareRoutes, publicShareRoutes } from "./share-routes.js";
import { agentWebhookRoutes, publicWebhookRoutes } from "./webhook-routes.js";
import { invitationEmailWebhookRoutes } from "./invitation-email-webhook-routes.js";
import { enforcePrivateAppMutationSecurity } from "./route-security.js";
import { redactedErrorMessage } from "./security/redaction.js";
import { accessLogMiddleware } from "./security/access-log.js";
import {
  assertPreviewIsolationConfigured,
  isGeneratedPreviewSurfacePath,
  isPacketAgentPreviewOriginRequest,
  resolvePacketAgentPreviewOrigin,
} from "./app-preview-isolation.js";
import { healthRoutes } from "./health-routes.js";
import { operationsStatusRoutes } from "./operations-status-routes.js";
import { operationsHealthRoutes } from "./operations-health-routes.js";
import { operationsJobMetricsRoutes } from "./operations-job-metrics-routes.js";
import { operationsAlertsRoutes } from "./operations-alerts-routes.js";
import { sandboxRoutes } from "./sandbox-routes.js";
import { workerRoutes } from "./worker-routes.js";
import { workerObservabilityRoutes } from "./worker-observability-routes.js";
import { workerOperatorRoutes } from "./worker-operator-routes.js";
import { workerPackageRoutes } from "./worker-package-routes.js";
import { workerPackageEventRoutes } from "./worker-package-event-routes.js";
import { packetProductCallbackRoutes } from "./packet-product-callback-routes.js";
import { AGENT_WORKER_BUNDLE_MAX_BYTES } from "./agents/portable-bundle.js";
import {
  ALERTS_EVALUATE_JOB_TYPE,
  ensureAlertsCronJobAsync,
  handleAlertsEvaluateJob,
  type AlertsEvaluateJobPayload,
} from "./alerts/alerts-evaluate-handler.js";
import {
  ALERTS_DELIVER_JOB_TYPE,
  handleAlertsDeliverJob,
  type AlertsDeliverJobPayload,
} from "./alerts/alerts-deliver-handler.js";
import { assertManagedDatabaseRuntimeSupported } from "./deployment/managed-database-runtime-guard.js";
import { WORKER_EXECUTION_JOB_TYPE } from "./workers/activation.js";
import {
  WORKER_ATTENTION_DEADLINE_JOB_TYPE,
  createWorkerAttentionDeadlineJobHandler,
} from "./workers/attention-service.js";
import {
  WORKER_NOTIFICATION_DELIVERY_JOB_TYPE,
  createDefaultWorkerNotificationTransport,
  createWorkerNotificationDeliveryJobHandler,
  createWorkerNotificationService,
} from "./workers/notifications.js";
import { createPacketChatNotificationTransport } from "./workers/packetchat.js";
import { createPacketPhoneNotificationTransport } from "./workers/packetphone.js";
import { createWorkerExecutionJobHandler } from "./workers/runtime/job-handler.js";
import { reconcileLegacyAgentWorkers } from "./agents/canonical-reconciliation.js";
import { refreshLegacyAgentRunFromCanonical } from "./agents/canonical-run-compatibility.js";
import { createWorkerRecoveryCoordinator } from "./workers/runtime/recovery.js";
import {
  WORKER_CRON_ACTIVATION_JOB_TYPE,
  WORKER_CRON_PROJECTION_JOB_TYPE,
  ensureWorkerCronProjectionJob,
  handleWorkerCronActivationJob,
  projectWorkerCronTriggers,
} from "./workers/adapters.js";

export const app = new Hono();

const standardSecurityHeaders = secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    connectSrc: ["'self'"],
    fontSrc: ["'self'", "data:"],
    formAction: ["'self'"],
    frameAncestors: ["'self'"],
    frameSrc: [
      "'self'",
      () => {
        try {
          return resolvePacketAgentPreviewOrigin();
        } catch {
          return "'self'";
        }
      },
    ],
    imgSrc: ["'self'", "data:", "blob:"],
    objectSrc: ["'none'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    workerSrc: ["'self'", "blob:"],
  },
  permissionsPolicy: {
    camera: false,
    geolocation: false,
    microphone: false,
    payment: false,
    usb: false,
  },
});
const generatedAppPreviewSecurityHeaders = secureHeaders({
  crossOriginOpenerPolicy: false,
  xFrameOptions: false,
  permissionsPolicy: {
    camera: false,
    geolocation: false,
    microphone: false,
    payment: false,
    usb: false,
  },
});

app.use("*", async (c, next) => {
  const previewOriginRequest = isPacketAgentPreviewOriginRequest(c);
  const previewSurfacePath = isGeneratedPreviewSurfacePath(c.req.path);
  if (previewOriginRequest !== previewSurfacePath) {
    return c.text("not found", 404);
  }
  await next();
});
app.use("*", (c, next) =>
  isGeneratedPreviewSurfacePath(c.req.path)
    ? generatedAppPreviewSecurityHeaders(c, next)
    : standardSecurityHeaders(c, next),
);
app.use("*", accessLogMiddleware());

app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api/health", healthRoutes);

app.get("/api/activation", async (c) => {
  const summaries = await listPublicActivationSummaries();
  return c.json({ summaries });
});

app.get("/api/activation/:workspaceId", async (c) => {
  const summary = await getPublicActivationSummary(c.req.param("workspaceId"));
  if (!summary) {
    return c.json({ error: "not found" }, 404);
  }
  return c.json(summary);
});

app.use("/api/app/*", (c, next) =>
  isPacketAgentPreviewOriginRequest(c) && isGeneratedPreviewSurfacePath(c.req.path)
    ? next()
    : enforcePrivateAppMutationSecurity(c, next),
);

app.route("/api", appRoutes);

app.get("/api/app/agents", async (c) => {
  try {
    return c.json(await listAgentsAsync(await requirePrivateWorkspaceRoleAsync(c, "viewer")));
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post("/api/app/agents", async (c) => {
  try {
    return c.json(
      await createAgentAsync(
        await requirePrivateWorkspaceRoleAsync(c, "admin"),
        await readJsonBody(c),
      ),
      201,
    );
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post("/api/app/agents/generate-from-prompt", async (c) => {
  try {
    const body = (await readJsonBody(c)) as {
      prompt?: string;
      create?: boolean;
      approve?: boolean;
      providerId?: string;
      model?: string;
      status?: "active" | "paused" | "archived";
      runPreview?: boolean;
      sampleInputs?: Record<string, unknown>;
    };
    const context = await requirePrivateWorkspaceRoleAsync(c, "admin");
    const result = await generateAgentFromPromptAsync(context, {
      prompt: body.prompt,
      create: body.create,
      approve: body.approve,
      providerId: body.providerId,
      model: body.model,
      status: body.status,
      runPreview: Boolean(body.runPreview),
      sampleInputs:
        body.sampleInputs && typeof body.sampleInputs === "object" ? body.sampleInputs : undefined,
    });
    return c.json(result, result.created ? 201 : 200);
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post("/api/app/agents/import/validate", async (c) => {
  try {
    const body = await readAgentBundleBody(c, false);
    return c.json(
      await validateAgentBundleImportAsync(
        await requirePrivateWorkspaceRoleAsync(c, "admin"),
        body.bundle,
      ),
    );
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post("/api/app/agents/import", async (c) => {
  try {
    const body = await readAgentBundleBody(c, true);
    return c.json(
      await importAgentBundleAsync(await requirePrivateWorkspaceRoleAsync(c, "admin"), {
        bundle: body.bundle,
        acknowledgeUntrustedPublisher: body.acknowledgeUntrustedPublisher === true,
        idempotencyKey: c.req.header("Idempotency-Key") ?? "",
      }),
      201,
    );
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.get("/api/app/agents/:agentId/export", async (c) => {
  try {
    const exported = await exportAgentBundleAsync(
      await requirePrivateWorkspaceRoleAsync(c, "admin"),
      c.req.param("agentId"),
    );
    c.header("Cache-Control", "no-store");
    c.header("Content-Disposition", `attachment; filename="${exported.fileName}"`);
    return c.json(exported.bundle);
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.get("/api/app/agents/:agentId", async (c) => {
  try {
    return c.json(
      await getAgentAsync(
        await requirePrivateWorkspaceRoleAsync(c, "viewer"),
        c.req.param("agentId"),
      ),
    );
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.patch("/api/app/agents/:agentId", async (c) => {
  try {
    return c.json(
      await updateAgentAsync(
        await requirePrivateWorkspaceRoleAsync(c, "admin"),
        c.req.param("agentId"),
        await readJsonBody(c),
      ),
    );
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.delete("/api/app/agents/:agentId", async (c) => {
  try {
    return c.json(
      await archiveAgentAsync(
        await requirePrivateWorkspaceRoleAsync(c, "admin"),
        c.req.param("agentId"),
      ),
    );
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post("/api/app/agents/:agentId/runs", async (c) => {
  try {
    const body = (await readJsonBody(c)) as Partial<RunAgentInput>;
    const inputs =
      body && typeof body.inputs === "object" && body.inputs !== null ? body.inputs : {};
    const result = await runAgent(
      await requirePrivateWorkspaceRoleAsync(c, "member"),
      c.req.param("agentId"),
      {
        triggerKind: body?.triggerKind,
        inputs,
        toolApproval: body?.toolApproval,
        evaluation: body?.evaluation,
        idempotencyKey: c.req.header("Idempotency-Key"),
      },
    );
    return c.json(result, "approval" in result ? 200 : 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.get("/api/app/agent-templates", async (c) => {
  try {
    await requirePrivateWorkspaceRoleAsync(c, "viewer");
    return c.json(listAgentTemplates());
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post("/api/app/agents/from-template/:templateId", async (c) => {
  try {
    const body = await readJsonBody(c);
    return c.json(
      await createAgentFromTemplateAsync(
        await requirePrivateWorkspaceRoleAsync(c, "admin"),
        c.req.param("templateId"),
        {
          name: typeof body.name === "string" ? body.name : undefined,
          providerId: typeof body.providerId === "string" ? body.providerId : undefined,
          model: typeof body.model === "string" ? body.model : undefined,
        },
      ),
      201,
    );
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.get("/api/app/providers", async (c) => {
  try {
    return c.json(await listProvidersAsync(await requirePrivateWorkspaceRoleAsync(c, "viewer")));
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post("/api/app/providers", async (c) => {
  try {
    return c.json(
      await createProviderAsync(
        await requirePrivateWorkspaceRoleAsync(c, "admin"),
        await readJsonBody(c),
      ),
      201,
    );
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.patch("/api/app/providers/:providerId", async (c) => {
  try {
    return c.json(
      await updateProviderAsync(
        await requirePrivateWorkspaceRoleAsync(c, "admin"),
        c.req.param("providerId"),
        await readJsonBody(c),
      ),
    );
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.get("/api/app/agent-runs", async (c) => {
  try {
    return c.json(await listAgentRunsAsync(await requirePrivateWorkspaceRoleAsync(c, "viewer")));
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.get("/api/app/agent-runs/:runId/detail", async (c) => {
  try {
    return c.json(
      await getAgentRunDetailAsync(
        await requirePrivateWorkspaceRoleAsync(c, "viewer"),
        c.req.param("runId"),
      ),
    );
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post("/api/app/agent-runs/:runId/cancel", async (c) => {
  try {
    return c.json(
      await cancelAgentRunAsync(
        await requirePrivateWorkspaceRoleAsync(c, "member"),
        c.req.param("runId"),
      ),
    );
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post("/api/app/agent-runs/:runId/retry", async (c) => {
  try {
    return c.json(
      await retryAgentRun(
        await requirePrivateWorkspaceRoleAsync(c, "member"),
        c.req.param("runId"),
      ),
      201,
    );
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post("/api/app/agent-runs/:runId/record-as-playbook", async (c) => {
  try {
    return c.json(
      await recordRunAsPlaybookAsync(
        await requirePrivateWorkspaceRoleAsync(c, "admin"),
        c.req.param("runId"),
      ),
    );
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post("/api/app/agent-runs/:runId/diagnose", async (c) => {
  try {
    const ctx = await requirePrivateWorkspaceRoleAsync(c, "member");
    const { loadStoreAsync } = await import("./packetagent-store.js");
    const data = await loadStoreAsync();
    const run = data.agentRuns.find(
      (r) => r.id === c.req.param("runId") && r.workspaceId === ctx.workspace.id,
    );
    if (!run)
      return errorResponse(c, Object.assign(new Error("agent run not found"), { status: 404 }));
    const { diagnoseFailedRun } = await import("./diagnostics.js");
    const diagnostic = await diagnoseFailedRun({ workspaceId: ctx.workspace.id, run });
    return c.json({ diagnostic });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.get("/api/app/tools", async (c) => {
  try {
    await requirePrivateWorkspaceRoleAsync(c, "viewer");
    const registry = getDefaultToolRegistry();
    return c.json({
      tools: registry.list().map((t: { name: string; description: string; side: string }) => ({
        name: t.name,
        description: t.description,
        side: t.side,
      })),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.get("/api/app/integration-readiness", async (c) => {
  try {
    return c.json({
      readiness: await getIntegrationReadinessAsync(
        await requirePrivateWorkspaceRoleAsync(c, "viewer"),
      ),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.get("/api/app/env-vars", async (c) => {
  try {
    return c.json(
      await listWorkspaceEnvVarsForUserAsync(await requirePrivateWorkspaceRoleAsync(c, "viewer")),
    );
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.post("/api/app/env-vars", async (c) => {
  try {
    return c.json(
      await createWorkspaceEnvVarAsync(
        await requirePrivateWorkspaceRoleAsync(c, "admin"),
        await readJsonBody(c),
      ),
      201,
    );
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.patch("/api/app/env-vars/:envVarId", async (c) => {
  try {
    return c.json(
      await updateWorkspaceEnvVarAsync(
        await requirePrivateWorkspaceRoleAsync(c, "admin"),
        c.req.param("envVarId"),
        await readJsonBody(c),
      ),
    );
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.delete("/api/app/env-vars/:envVarId", async (c) => {
  try {
    return c.json(
      await deleteWorkspaceEnvVarByIdAsync(
        await requirePrivateWorkspaceRoleAsync(c, "admin"),
        c.req.param("envVarId"),
      ),
    );
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.get("/api/app/release-history", async (c) => {
  try {
    return c.json(
      await listReleaseHistoryAsync(await requirePrivateWorkspaceRoleAsync(c, "viewer")),
    );
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.route("/api/app/workflow", workflowRoutes);
app.route("/api/app/api-keys", apiKeyRoutes);
app.route("/api/app/usage", usageRoutes);
app.route("/api/app/llm", llmStreamRoutes);
app.route("/api/app/jobs", jobRoutes);
app.route("/api/app/share", shareRoutes);
app.route("/api/public/share", publicShareRoutes);
app.route("/api/app/webhooks", agentWebhookRoutes);
app.route("/api/public/webhooks", publicWebhookRoutes);
app.route("/api/public/webhooks/invitation-email", invitationEmailWebhookRoutes);
app.route("/api/app/operations/status", operationsStatusRoutes);
app.route("/api/app/operations/health", operationsHealthRoutes);
app.route("/api/app/operations/job-metrics", operationsJobMetricsRoutes);
app.route("/api/app/operations/alerts", operationsAlertsRoutes);
app.route("/api/app/sandbox", sandboxRoutes);
app.route("/api/app/workers", workerObservabilityRoutes);
app.route("/api/app/workers", workerRoutes);
app.route("/api/app/workers", workerOperatorRoutes);
app.route("/api", workerPackageRoutes);
app.route("/api", workerPackageEventRoutes);
app.route("/api/packet-products", packetProductCallbackRoutes);

export const scheduler = new JobScheduler({ leaderLock: selectSchedulerLeaderLock() });
const workerExecutionJobHandler = createWorkerExecutionJobHandler({
  onRunUpdated: async (workspaceId, workerRunId) => {
    await refreshLegacyAgentRunFromCanonical(workspaceId, workerRunId);
  },
});
const workerAttentionDeadlineJobHandler = createWorkerAttentionDeadlineJobHandler();
const workerNotificationDeliveryJobHandler = createWorkerNotificationDeliveryJobHandler(
  createWorkerNotificationService({
    transport: createDefaultWorkerNotificationTransport({
      packetchat: createPacketChatNotificationTransport(),
      packetphone: createPacketPhoneNotificationTransport(),
    }),
  }),
);
const workerRetentionJobHandler = createWorkerRetentionJobHandler();
const workerRecoveryCoordinator = createWorkerRecoveryCoordinator();
scheduler.registerReconciler({
  name: "worker-recovery",
  intervalMs: 30_000,
  async run() {
    return workerRecoveryCoordinator.recoverExpired();
  },
});
scheduler.register({
  type: "agent.run",
  async handle(job) {
    const payload = job.payload as {
      agentId?: string;
      triggerKind?: string;
      inputs?: Record<string, unknown>;
    };
    if (!payload.agentId) throw new Error("agent.run job missing agentId");
    const { loadStoreAsync } = await import("./packetagent-store.js");
    const data = await loadStoreAsync();
    const agent = data.agents.find((a) => a.id === payload.agentId);
    if (!agent) throw new Error(`agent ${payload.agentId} not found`);
    if (agent.workspaceId !== job.workspaceId)
      throw new Error(`agent ${payload.agentId} is not in job workspace`);
    const owner = data.users.find((u) => u.id === agent.createdByUserId);
    if (!owner) throw new Error(`agent owner not found`);
    const context = {
      user: {
        id: owner.id,
        email: owner.email,
        displayName: owner.displayName,
        timezone: owner.timezone,
      },
      workspace: {
        id: agent.workspaceId,
        name: "",
        slug: "",
        website: "",
        automationGoal: "",
        createdAt: "",
        updatedAt: "",
      },
    };
    const liveWorkspace = data.workspaces.find((w) => w.id === agent.workspaceId);
    if (liveWorkspace) Object.assign(context.workspace, liveWorkspace);
    const result = await runAgent(context as never, agent.id, {
      triggerKind: payload.triggerKind,
      inputs: payload.inputs,
      toolApproval: undefined,
      idempotencyKey: job.id,
    });
    if ("approval" in result) {
      return {
        agentId: agent.id,
        status: "approval_required",
        approvalRequired: true,
        tools: result.approval.tools.map((tool) => tool.name),
      };
    }
    return { runId: result.run.id, status: result.run.status };
  },
});
scheduler.register({
  type: INVITATION_EMAIL_JOB_TYPE,
  async handle(job) {
    return handleInvitationEmailJob(job);
  },
});
scheduler.register({
  type: METRICS_SNAPSHOT_JOB_TYPE,
  async handle(job) {
    return handleMetricsSnapshotJob(job.payload as MetricsSnapshotJobPayload);
  },
});
scheduler.register({
  type: ALERTS_EVALUATE_JOB_TYPE,
  async handle(job) {
    return handleAlertsEvaluateJob(job.payload as AlertsEvaluateJobPayload);
  },
});
scheduler.register({
  type: ALERTS_DELIVER_JOB_TYPE,
  async handle(job) {
    return handleAlertsDeliverJob(job.payload as unknown as AlertsDeliverJobPayload);
  },
});
scheduler.register({
  type: WORKER_CRON_ACTIVATION_JOB_TYPE,
  async handle(job) {
    const result = await handleWorkerCronActivationJob(job);
    await refreshLegacyAgentRunFromCanonical(job.workspaceId, result.runId);
    return result;
  },
});
scheduler.register({
  type: WORKER_CRON_PROJECTION_JOB_TYPE,
  async handle() {
    return projectWorkerCronTriggers();
  },
});
scheduler.register({
  type: WORKER_EXECUTION_JOB_TYPE,
  async handle(job, context) {
    return workerExecutionJobHandler.handle(job, context);
  },
});
scheduler.register({
  type: WORKER_ATTENTION_DEADLINE_JOB_TYPE,
  async handle(job) {
    return workerAttentionDeadlineJobHandler.handle(job);
  },
});
scheduler.register({
  type: WORKER_NOTIFICATION_DELIVERY_JOB_TYPE,
  async handle(job, context) {
    return workerNotificationDeliveryJobHandler.handle(job, context);
  },
});
scheduler.register({
  type: WORKER_RETENTION_JOB_TYPE,
  async handle(job) {
    return workerRetentionJobHandler.handle(job);
  },
});
app.use("/data/artifacts/*", async (c, next) => {
  if (!artifactServingEnabled()) return c.text("not found", 404);

  try {
    const context = await requirePrivateWorkspaceRoleAsync(c, "viewer");
    const runId = artifactRunIdFromPath(c.req.path);
    if (!runId) return c.text("not found", 404);

    const { loadStoreAsync } = await import("./packetagent-store.js");
    if (!artifactRunBelongsToWorkspace(await loadStoreAsync(), context.workspace.id, runId)) {
      return c.text("not found", 404);
    }
  } catch (error) {
    return errorResponse(c, error);
  }

  await next();
});
// Scope the static root to the artifacts directory itself (NOT "./") so a
// crafted path can't traverse out into the repo/source tree. The URL keeps the
// "/data/artifacts" prefix for callers, but we strip it before resolving on disk
// so files resolve relative to the artifacts dir.
app.use(
  "/data/artifacts/*",
  serveStatic({
    root: "./data/artifacts",
    rewriteRequestPath: (path) => path.replace(/^\/data\/artifacts/, ""),
  }),
);

if (existsSync("./web/dist/index.html")) {
  app.use("/*", serveStatic({ root: "./web/dist" }));
  app.get("*", serveStatic({ path: "./web/dist/index.html" }));
}

export function assertServerStartupRuntimeSupported(env: NodeJS.ProcessEnv = process.env) {
  assertPreviewIsolationConfigured(env);
  return assertManagedDatabaseRuntimeSupported(env);
}

export async function startServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  assertServerStartupRuntimeSupported(env);
  bootstrapServerRuntime();
  const legacyAgentReconciliation = await reconcileLegacyAgentWorkers();
  if (legacyAgentReconciliation.failures.length > 0) {
    console.warn(
      `PacketAgent left ${legacyAgentReconciliation.failures.length} legacy Agent(s) inert because their current Worker projection did not validate.`,
    );
  }
  await projectWorkerCronTriggers();
  await ensureWorkerCronProjectionJob();
  scheduler.start();
  await ensureMetricsSnapshotCronJobAsync();
  await ensureAlertsCronJobAsync();
  await ensureWorkerRetentionJobs({ env });
  const shutdown = async () => {
    await scheduler.stop();
    try {
      const { shutdownAllBrowserSessions } = await import("./tools/browser-runtime.js");
      await shutdownAllBrowserSessions();
    } catch {
      /* ignore */
    }
    try {
      const { shutdownDefaultGeneratedAppRuntimeProcessPool } =
        await import("./generated-app-runtime/server.js");
      await shutdownDefaultGeneratedAppRuntimeProcessPool();
    } catch {
      /* ignore */
    }
    try {
      const { shutdownManagedPostgresStoreClientPool } =
        await import("./store/backends/managed-postgres.js");
      await shutdownManagedPostgresStoreClientPool();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const port = Number(env.PORT ?? 8484);
  serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
    console.log(`packetagent listening on http://localhost:${info.port}`);
  });
}

export function artifactServingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // Require an EXPLICIT opt-in regardless of NODE_ENV. Previously this
  // defaulted ON whenever NODE_ENV !== "production", silently exposing
  // unauthenticated artifact serving in dev. Now it is OFF unless the operator
  // sets PACKETAGENT_ARTIFACT_SERVING_ENABLED to a truthy value (matching the
  // default-off documentation in .env.example).
  return isEnvTruthy(env.PACKETAGENT_ARTIFACT_SERVING_ENABLED);
}

let serverRuntimeBootstrapped = false;

export function bootstrapServerRuntime(): void {
  if (serverRuntimeBootstrapped) return;
  migrateLegacyDefaultDataFiles();
  registerDefaultProviders();
  registerDefaultTools();
  serverRuntimeBootstrapped = true;
}

export function artifactRunBelongsToWorkspace(
  data: {
    agentRuns?: ReadonlyArray<{ id: string; workspaceId: string }>;
    workerRuns?: ReadonlyArray<{ id: string; workspaceId: string }>;
  },
  workspaceId: string,
  runId: string,
): boolean {
  return [data.agentRuns ?? [], data.workerRuns ?? []].some((runs) =>
    runs.some((run) => run.id === runId && run.workspaceId === workspaceId),
  );
}

function artifactRunIdFromPath(path: string): string | null {
  const encoded = path.slice("/data/artifacts/".length).split("/")[0] ?? "";
  let runId: string;
  try {
    runId = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  if (
    !runId ||
    runId === "." ||
    runId === ".." ||
    runId.includes("/") ||
    runId.includes("\\") ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(runId)
  ) {
    return null;
  }
  return runId;
}

function isExecutedDirectly(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint ? resolve(fileURLToPath(import.meta.url)) === resolve(entrypoint) : false;
}

if (isExecutedDirectly()) {
  await startServer();
}

function errorResponse(c: Context, error: unknown) {
  const candidate = (error as Error & { status?: number }).status ?? 500;
  const status =
    Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : 500;
  c.status(status as ContentfulStatusCode);
  return c.json({ error: redactedErrorMessage(error) });
}

async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.includes("application/json")) return {};
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    throw Object.assign(new Error("request body must be valid JSON"), { status: 400 });
  }
}

async function readAgentBundleBody(
  c: Context,
  allowAcknowledgement: boolean,
): Promise<Record<string, unknown>> {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw Object.assign(new Error("request body must use application/json"), { status: 415 });
  }
  const text = await c.req.text();
  if (Buffer.byteLength(text, "utf8") > AGENT_WORKER_BUNDLE_MAX_BYTES + 4_096) {
    throw Object.assign(new Error("Agent bundle request exceeds the bounded import limit"), {
      status: 413,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("request body must be valid JSON"), { status: 400 });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("request body must be a JSON object"), { status: 400 });
  }
  const body = value as Record<string, unknown>;
  const allowed = new Set([
    "bundle",
    ...(allowAcknowledgement ? ["acknowledgeUntrustedPublisher"] : []),
  ]);
  const unexpected = Object.keys(body).find((key) => !allowed.has(key));
  if (unexpected) {
    throw Object.assign(new Error(`request field ${unexpected} is not allowed`), { status: 400 });
  }
  if (!Object.hasOwn(body, "bundle")) {
    throw Object.assign(new Error("request field bundle is required"), { status: 400 });
  }
  if (
    allowAcknowledgement &&
    body.acknowledgeUntrustedPublisher !== undefined &&
    typeof body.acknowledgeUntrustedPublisher !== "boolean"
  ) {
    throw Object.assign(
      new Error("request field acknowledgeUntrustedPublisher must be a boolean"),
      { status: 400 },
    );
  }
  return body;
}

function isEnvTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
