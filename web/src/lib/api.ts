import type {
  ActivityDetailPayload,
  ActivityRecord,
  AgentBuilderApproveResult,
  AgentBuilderDraft,
  AgentBuilderDraftResult,
  AgentPromptDraftResult,
  AgentRecord,
  AgentRunDetailPayload,
  AgentRunRecord,
  AgentTemplate,
  GeneratedAppSummary,
  BuilderModelPreset,
  BuilderModelPresetId,
  BuilderProviderStatusPayload,
  AppBuilderApproveResult,
  AppBuilderApplyStatus,
  AppBuilderChangeSetResult,
  AppBuilderCheckpointListResult,
  AppBuilderDraft,
  AppBuilderDraftSource,
  AppBuilderDraftResult,
  AppBuilderFixPromptResult,
  AppBuilderFileProgress,
  AppBuilderGeneratedFile,
  AppBuilderIterationApplyRequest,
  AppBuilderIterationApplyResult,
  AppBuilderIterationRequest,
  AppBuilderIterationResult,
  AppBuilderPackageInstallPlan,
  AppBuilderPublishRequest,
  AppBuilderPublishResult,
  AppBuilderPublishRollbackResult,
  AppBuilderPublishState,
  AppBuilderRollbackResult,
  AppBuilderSmokeBuildStatus,
  ActivationDetailPayload,
  BootstrapPayload,
  ConfirmWorkflowReleaseInput,
  ProviderRecord,
  PublicDashboardPayload,
  RunAgentInput,
  RunAgentResponse,
  SaveAgentInput,
  SaveProviderInput,
  SaveWorkflowBlockerInput,
  SaveWorkspaceEnvVarInput,
  WorkspaceEnvVarRecord,
  SaveWorkflowBriefInput,
  SaveWorkflowPlanItemInput,
  SaveWorkflowQuestionInput,
  SaveWorkflowRequirementInput,
  SaveWorkflowValidationEvidenceInput,
  Session,
  WorkflowBlocker,
  WorkflowBrief,
  WorkflowBriefTemplate,
  WorkflowBriefVersion,
  WorkflowDraftResult,
  WorkflowPlanItem,
  WorkflowQuestion,
  WorkflowReleaseConfirmation,
  WorkflowRequirement,
  WorkflowTemplate,
  WorkflowTemplateApplyResult,
  WorkflowValidationEvidence,
  ApiKeyProviderName,
  MaskedApiKey,
  UsageSummary,
  ProviderCallRecord,
  JobRecord,
  IntegrationReadinessSummary,
  IntegrationMarketplaceTestResult,
  PlanModeResult,
  PlanModePlanItem,
  AvailableTool,
  RunDiagnostic,
  CreateShareTokenInput,
  CreateWorkspaceInvitationInput,
  PublicSharePayload,
  ShareTokenRecord,
  WorkspaceMemberRecord,
  WorkspaceMembersPayload,
  WorkspaceRole,
  SandboxStatus,
  SandboxRuntimeInfo,
  SandboxExecRecord,
  SandboxExecRequest,
  SandboxExecStatus,
  GeneratedAppRuntimeHealth,
  GeneratedAppPublishIntegrityPayload,
  WorkerAttentionView,
  WorkerOperationsHealth,
  WorkerOperationsPageInfo,
  WorkerRunDetail,
  WorkerRunStatus,
  WorkerRunSummary,
} from "@/lib/types";
import { pushExternalToast } from "@/context/toast-state";

let lastAuthToastAt = 0;
const CSRF_COOKIE_NAME = "packetagent_csrf";
const CSRF_HEADER_NAME = "X-CSRF-Token";

type BuilderModelRoutingPresetPayload = {
  id: BuilderModelPresetId;
  label: string;
  goal: string;
  primary: BuilderModelPreset["primary"];
  fallbacks: BuilderModelPreset["fallbacks"];
};

type BuilderModelRoutingPresetSurfacePayload = {
  version: string;
  presets: Record<BuilderModelPresetId, BuilderModelRoutingPresetPayload>;
  totals: {
    presets: number;
    ready: number;
    needsSetup: number;
  };
};

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const csrfToken = csrfTokenForRequest(init);
  const response = await fetch(url, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      typeof payload?.error === "string"
        ? payload.error
        : `${response.status} ${response.statusText}`,
    ) as Error & { status?: number };
    error.status = response.status;
    if (response.status === 401 && !url.includes("/api/auth/")) {
      const now = Date.now();
      if (now - lastAuthToastAt > 4000) {
        lastAuthToastAt = now;
        pushExternalToast({
          tone: "warn",
          title: "Your session expired",
          description: "Please sign in again to continue.",
        });
      }
    } else if (response.status >= 500) {
      pushExternalToast({
        tone: "error",
        title: "Server error",
        description: error.message,
      });
    }
    throw error;
  }
  return payload as T;
}

async function downloadBinary(url: string): Promise<{ blob: Blob; fileName: string }> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(
      typeof payload?.error === "string"
        ? payload.error
        : `${response.status} ${response.statusText}`,
    );
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const fileName = disposition.match(/filename="([^"]+)"/i)?.[1] ?? "generated-app.zip";
  return { blob: await response.blob(), fileName };
}

function csrfTokenForRequest(init?: RequestInit) {
  const method = (init?.method ?? "GET").toUpperCase();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return "";
  if (typeof document === "undefined") return "";
  return (
    document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${CSRF_COOKIE_NAME}=`))
      ?.slice(CSRF_COOKIE_NAME.length + 1) ?? ""
  );
}

export type BuilderStreamEvent =
  | { type: "step"; text: string }
  | { type: "prose"; text: string }
  | { type: "file-progress"; progress: AppBuilderFileProgress }
  | {
      type: "draft";
      draft: AppBuilderDraft;
      source?: AppBuilderDraftSource;
      files?: AppBuilderGeneratedFile[];
      sourceFiles?: AppBuilderApproveResult["sourceFiles"];
      validationErrors?: string[];
    }
  | { type: "diff"; iteration: AppBuilderIterationResult }
  | { type: "validation"; errors: string[] }
  | { type: "done" }
  | { type: "error"; error: string };

async function streamSse(
  url: string,
  body: unknown,
  onEvent: (event: BuilderStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const csrfToken = csrfTokenForRequest({ method: "POST" });
  const response = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({}));
    const message =
      typeof payload?.error === "string"
        ? payload.error
        : `${response.status} ${response.statusText}`;
    const error = new Error(message) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator: number;
      while ((separator = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const parsed = parseSseChunk(raw);
        if (parsed) {
          onEvent(parsed);
          if (parsed.type === "done" || parsed.type === "error") return;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseChunk(raw: string): BuilderStreamEvent | null {
  const lines = raw.split("\n");
  let dataLine = "";
  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLine += line.slice(5).trimStart();
    }
  }
  if (!dataLine) return null;
  try {
    return JSON.parse(dataLine) as BuilderStreamEvent;
  } catch {
    return null;
  }
}

function integrationMarketplaceTestPath(cardId: string) {
  switch (cardId) {
    case "openai":
    case "anthropic":
    case "ollama-local":
    case "custom-api":
      return "/api/app/llm/test";
    case "browser":
      return "/api/app/tools/browser/test";
    case "custom-api-provider":
      return "/api/app/integrations/custom-api-provider/test";
    case "browser-scraping":
      return "/api/app/tools/browser/test";
    case "slack-webhook":
    case "email":
    case "github-webhook":
    case "stripe-payments":
    case "database":
      return `/api/app/integrations/${cardId}/test`;
    default:
      return `/api/app/integrations/${cardId}/test`;
  }
}

export const api = {
  getSession: async (): Promise<Session | null> => {
    const payload = await j<
      Session | { authenticated: false; user: null; workspace: null; onboarding: null }
    >("/api/auth/session");
    return payload.authenticated ? (payload as Session) : null;
  },
  signIn: (body: { email: string; password: string }) =>
    j<Session>("/api/auth/login", { method: "POST", body: JSON.stringify(body) }),
  signUp: (body: { displayName: string; email: string; password: string }) =>
    j<Session>("/api/auth/register", { method: "POST", body: JSON.stringify(body) }),
  signOut: () => j<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  getPublicDashboard: () => j<PublicDashboardPayload>("/api/activation"),
  getBootstrap: () => j<BootstrapPayload>("/api/app/bootstrap"),
  getActivationDetail: () => j<ActivationDetailPayload>("/api/app/activation"),
  getHostInfo: () => j<{ lanIps: string[]; port: number }>("/api/app/host-info"),
  getOnboarding: () =>
    j<{ onboarding: BootstrapPayload["onboarding"] }>("/api/app/onboarding").then(
      (payload) => payload.onboarding,
    ),
  completeOnboardingStep: (stepKey: string) =>
    j<{ onboarding: BootstrapPayload["onboarding"] }>(
      `/api/app/onboarding/steps/${stepKey}/complete`,
      { method: "POST" },
    ),
  updateProfile: (body: { displayName: string; timezone: string }) =>
    j<{ profile: Session["user"] }>("/api/app/profile", {
      method: "PATCH",
      body: JSON.stringify(body),
    }).then((payload) => payload.profile),
  updateWorkspace: (body: { name: string; website: string; automationGoal: string }) =>
    j<{ workspace: Session["workspace"] }>("/api/app/workspace", {
      method: "PATCH",
      body: JSON.stringify(body),
    }).then((payload) => payload.workspace),
  listWorkspaceMembers: () => j<WorkspaceMembersPayload>("/api/app/members"),
  createWorkspaceInvitation: (body: CreateWorkspaceInvitationInput) =>
    j<{ invitation: WorkspaceMembersPayload["invitations"][number] }>("/api/app/invitations", {
      method: "POST",
      body: JSON.stringify(body),
    }).then((payload) => payload.invitation),
  resendWorkspaceInvitation: (invitationId: string) =>
    j<{ invitation: WorkspaceMembersPayload["invitations"][number] }>(
      `/api/app/invitations/${invitationId}/resend`,
      { method: "POST" },
    ).then((payload) => payload.invitation),
  revokeWorkspaceInvitation: (invitationId: string) =>
    j<{ invitation: WorkspaceMembersPayload["invitations"][number] }>(
      `/api/app/invitations/${invitationId}/revoke`,
      { method: "POST" },
    ).then((payload) => payload.invitation),
  updateWorkspaceMemberRole: (userId: string, role: WorkspaceRole) =>
    j<{ member: WorkspaceMemberRecord }>(`/api/app/members/${userId}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }).then((payload) => payload.member),
  removeWorkspaceMember: (userId: string) =>
    j<{ ok: boolean }>(`/api/app/members/${userId}`, { method: "DELETE" }),
  listActivity: () =>
    j<{ activities: ActivityRecord[] }>("/api/app/activity").then((payload) => payload.activities),
  getActivityDetail: (id: string) => j<ActivityDetailPayload>(`/api/app/activity/${id}`),
  listAgents: () =>
    j<{ agents: AgentRecord[] }>("/api/app/agents").then((payload) => payload.agents),
  listGeneratedApps: () =>
    j<{ generatedApps: GeneratedAppSummary[] }>("/api/app/generated-apps").then(
      (payload) => payload.generatedApps,
    ),
  getGeneratedAppPackagePlan: (input: { appId: string; checkpointId?: string }) => {
    const params = new URLSearchParams();
    if (input.checkpointId) params.set("checkpointId", input.checkpointId);
    const query = params.toString();
    return j<{
      checkpoint: { id: string; createdAt: string };
      plan: AppBuilderPackageInstallPlan;
    }>(
      `/api/app/generated-apps/${encodeURIComponent(input.appId)}/package-plan${query ? `?${query}` : ""}`,
    );
  },
  downloadGeneratedAppExport: (input: { appId: string; checkpointId?: string }) => {
    const params = new URLSearchParams();
    if (input.checkpointId) params.set("checkpointId", input.checkpointId);
    const query = params.toString();
    return downloadBinary(
      `/api/app/generated-apps/${encodeURIComponent(input.appId)}/export${query ? `?${query}` : ""}`,
    );
  },
  getGeneratedAppPublishIntegrity: (input: { appId: string; publishId?: string }) => {
    const params = new URLSearchParams();
    if (input.publishId) params.set("publishId", input.publishId);
    const query = params.toString();
    return j<GeneratedAppPublishIntegrityPayload>(
      `/api/app/generated-apps/${encodeURIComponent(input.appId)}/publish/integrity${query ? `?${query}` : ""}`,
    );
  },
  createPreviewToken: (appId: string, options: { ttlSeconds?: number } = {}) => {
    const params = new URLSearchParams();
    if (options.ttlSeconds && Number.isFinite(options.ttlSeconds) && options.ttlSeconds > 0) {
      params.set("ttl", String(Math.floor(options.ttlSeconds)));
    }
    const qs = params.toString();
    return j<{ token: string; expiresAt: string; previewUrl: string }>(
      `/api/app/generated-apps/${encodeURIComponent(appId)}/preview-token${qs ? `?${qs}` : ""}`,
      { method: "POST" },
    );
  },
  getAgent: (id: string) =>
    j<{ agent: AgentRecord; runs: AgentRunRecord[] }>(`/api/app/agents/${id}`),
  createAgent: (body: SaveAgentInput) =>
    j<{ agent: AgentRecord }>("/api/app/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }).then((payload) => payload.agent),
  generateAgentFromPrompt: (body: {
    prompt: string;
    create?: boolean;
    approve?: boolean;
    providerId?: string;
    model?: string;
    status?: AgentRecord["status"];
    runPreview?: boolean;
    sampleInputs?: Record<string, unknown>;
  }) =>
    j<AgentPromptDraftResult>("/api/app/agents/generate-from-prompt", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  generateAgentBuilderDraft: (body: { prompt: string; preset?: BuilderModelPresetId }) =>
    j<AgentBuilderDraftResult>("/api/app/builder/agent-draft", {
      method: "POST",
      body: JSON.stringify(body),
    }).then((payload) => payload.draft),
  approveAgentBuilderDraft: (body: {
    prompt?: string;
    draft?: AgentBuilderDraft;
    status?: AgentRecord["status"];
    runPreview?: boolean;
    sampleInputs?: Record<string, unknown>;
  }) =>
    j<AgentBuilderApproveResult>("/api/app/builder/agent-draft/approve", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  generateAppBuilderDraft: (body: { prompt: string; preset?: BuilderModelPresetId }) =>
    j<AppBuilderDraftResult>("/api/app/builder/app-draft", {
      method: "POST",
      body: JSON.stringify(body),
    }).then((payload) => payload.draft),
  streamAppBuilderDraft: (
    body: { prompt: string; preset?: BuilderModelPresetId },
    onEvent: (event: BuilderStreamEvent) => void,
    signal?: AbortSignal,
  ) => streamSse("/api/app/builder/app-draft/stream", body, onEvent, signal),
  approveAppBuilderDraft: (body: {
    prompt?: string;
    draft?: AppBuilderDraft;
    source?: AppBuilderDraftSource;
    files?: AppBuilderGeneratedFile[];
    runBuild?: boolean;
    runSmoke?: boolean;
    targetStatus?: AppBuilderApplyStatus;
  }) =>
    j<AppBuilderApproveResult>("/api/app/builder/app-draft/apply", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  generateAppBuilderIteration: (
    body: AppBuilderIterationRequest & { preset?: BuilderModelPresetId },
  ) =>
    j<AppBuilderIterationResult>("/api/app/builder/app-iteration", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  streamAppBuilderIteration: (
    body: AppBuilderIterationRequest & { preset?: BuilderModelPresetId },
    onEvent: (event: BuilderStreamEvent) => void,
    signal?: AbortSignal,
  ) => streamSse("/api/app/builder/app-iteration/stream", body, onEvent, signal),
  applyAppBuilderIterationDiff: (body: AppBuilderIterationApplyRequest) =>
    j<AppBuilderIterationApplyResult>("/api/app/builder/app-iteration/apply", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  draftBuilderChangeSet: (body: AppBuilderIterationRequest) =>
    j<AppBuilderChangeSetResult>("/api/app/builder/changes/draft", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  applyBuilderChangeSet: (body: AppBuilderIterationApplyRequest) =>
    j<AppBuilderIterationApplyResult>("/api/app/builder/changes/apply", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  refreshBuilderPreview: (body: {
    appId?: string;
    checkpointId?: string;
    runBuild?: boolean;
    runSmoke?: boolean;
  }) =>
    j<{
      preview: AppBuilderIterationApplyResult["preview"];
      build?: { status: string };
      smoke?: AppBuilderIterationApplyResult["smoke"];
      checkpoint?: AppBuilderIterationApplyResult["checkpoint"];
    }>("/api/app/builder/preview/refresh", { method: "POST", body: JSON.stringify(body) }),
  buildBuilderFixPrompt: (
    body: Partial<AppBuilderIterationRequest> & {
      errorContext?: { source?: "build" | "runtime" | "smoke"; message?: string; prompt?: string };
    },
  ) =>
    j<AppBuilderFixPromptResult>("/api/app/builder/fix-prompt", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listBuilderCheckpoints: (query: { appId?: string; agentId?: string }) => {
    const params = new URLSearchParams();
    if (query.appId) params.set("appId", query.appId);
    if (query.agentId) params.set("agentId", query.agentId);
    return j<AppBuilderCheckpointListResult>(`/api/app/builder/checkpoints?${params.toString()}`);
  },
  rollbackBuilderCheckpoint: (
    checkpointId: string,
    body: { appId?: string; agentId?: string; reason?: string } = {},
  ) =>
    j<AppBuilderRollbackResult>(`/api/app/builder/checkpoints/${checkpointId}/rollback`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  branchBuilderCheckpoint: (checkpointId: string, body: { appId: string }) =>
    j<{
      branched: boolean;
      app: { id: string; slug: string; name: string; status: string; previewUrl?: string };
      checkpoint: { id: string; appId: string; savedAt: string };
      sourceAppId: string;
      sourceCheckpointId: string;
      draft: AppBuilderDraft;
      smoke?: AppBuilderSmokeBuildStatus;
    }>(`/api/app/builder/checkpoints/${checkpointId}/branch`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getBuilderPublishState: (query: { appId?: string; checkpointId?: string }) => {
    const params = new URLSearchParams();
    if (query.appId) params.set("appId", query.appId);
    if (query.checkpointId) params.set("checkpointId", query.checkpointId);
    return j<AppBuilderPublishState>(`/api/app/builder/publish/state?${params.toString()}`);
  },
  publishBuilderApp: (body: AppBuilderPublishRequest) =>
    j<AppBuilderPublishResult>("/api/app/builder/publish", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  rollbackBuilderPublish: (
    publishId: string,
    body: { appId?: string; checkpointId?: string; reason?: string } = {},
  ) =>
    j<AppBuilderPublishRollbackResult>(`/api/app/builder/publish/${publishId}/rollback`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  exportBuilderDockerCompose: (query: { appId?: string; checkpointId?: string }) => {
    const params = new URLSearchParams();
    if (query.appId) params.set("appId", query.appId);
    if (query.checkpointId) params.set("checkpointId", query.checkpointId);
    return j<{ fileName: string; contents: string }>(
      `/api/app/builder/publish/docker-compose?${params.toString()}`,
    );
  },
  updateAgent: (id: string, body: Partial<SaveAgentInput>) =>
    j<{ agent: AgentRecord }>(`/api/app/agents/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }).then((payload) => payload.agent),
  archiveAgent: (id: string) =>
    j<{ agent: AgentRecord }>(`/api/app/agents/${id}`, { method: "DELETE" }).then(
      (payload) => payload.agent,
    ),
  runAgent: (id: string, body?: RunAgentInput) =>
    j<RunAgentResponse>(`/api/app/agents/${id}/runs`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),
  listAgentTemplates: () =>
    j<{ templates: AgentTemplate[] }>("/api/app/agent-templates").then(
      (payload) => payload.templates,
    ),
  createAgentFromTemplate: (
    templateId: string,
    body: { name?: string; providerId?: string; model?: string } = {},
  ) =>
    j<{ agent: AgentRecord }>(`/api/app/agents/from-template/${templateId}`, {
      method: "POST",
      body: JSON.stringify(body),
    }).then((payload) => payload.agent),
  listBuilderModelPresets: () =>
    j<{ routingPresets: BuilderModelRoutingPresetSurfacePayload }>(
      "/api/app/model-routing-presets",
    ).then((payload) =>
      Object.values(payload.routingPresets.presets).map((preset) => ({
        ...preset,
        model: preset.primary?.model ?? "stub-small",
        summary: preset.goal,
        bestFor: preset.primary?.ready
          ? preset.primary.reason
          : (preset.primary?.blockers[0] ??
            "Needs provider setup before this preset can use a live model."),
      })),
    ),
  getBuilderProviderStatus: () =>
    j<BuilderProviderStatusPayload>("/api/app/builder/providers/status"),
  listProviders: () =>
    j<{ providers: ProviderRecord[] }>("/api/app/providers").then((payload) => payload.providers),
  createProvider: (body: SaveProviderInput) =>
    j<{ provider: ProviderRecord }>("/api/app/providers", {
      method: "POST",
      body: JSON.stringify(body),
    }).then((payload) => payload.provider),
  updateProvider: (id: string, body: Partial<SaveProviderInput>) =>
    j<{ provider: ProviderRecord }>(`/api/app/providers/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }).then((payload) => payload.provider),
  listAgentRuns: () =>
    j<{ runs: AgentRunRecord[] }>("/api/app/agent-runs").then((payload) => payload.runs),
  getAgentRunDetail: (runId: string) =>
    j<AgentRunDetailPayload>(`/api/app/agent-runs/${encodeURIComponent(runId)}/detail`),
  cancelAgentRun: (runId: string) =>
    j<{ run: AgentRunRecord }>(`/api/app/agent-runs/${runId}/cancel`, { method: "POST" }).then(
      (payload) => payload.run,
    ),
  retryAgentRun: (runId: string) =>
    j<{ run: AgentRunRecord }>(`/api/app/agent-runs/${runId}/retry`, { method: "POST" }).then(
      (payload) => payload.run,
    ),
  getWorkerOperationsHealth: () =>
    j<{ health: WorkerOperationsHealth }>("/api/app/workers/health").then(
      (payload) => payload.health,
    ),
  listWorkerRuns: (
    query: {
      status?: WorkerRunStatus;
      workerDefinitionId?: string;
      workerVersionId?: string;
      workerDeploymentId?: string;
      cursor?: string;
      limit?: number;
    } = {},
  ) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return j<{ runs: WorkerRunSummary[]; page: WorkerOperationsPageInfo }>(
      `/api/app/workers/runs${suffix}`,
    );
  },
  getWorkerRunDetail: (runId: string) =>
    j<{ detail: WorkerRunDetail }>(
      `/api/app/workers/runs/${encodeURIComponent(runId)}/detail`,
    ).then((payload) => payload.detail),
  controlWorkerRun: (
    runId: string,
    action: "pause" | "resume" | "stop",
    expectedRevision: number,
  ) =>
    j<unknown>(`/api/app/workers/runs/${encodeURIComponent(runId)}/${action}`, {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ expectedRevision }),
    }),
  revokeWorkerDeployment: (deploymentId: string, expectedRevision: number) =>
    j<unknown>(`/api/app/workers/deployments/${encodeURIComponent(deploymentId)}/revoke`, {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ expectedRevision }),
    }),
  resolveWorkerAttention: (
    attentionId: string,
    action: "approve-once" | "approve-for-run" | "reject",
    expectedRevision: number,
  ) =>
    j<{ attention: WorkerAttentionView }>(
      `/api/app/workers/attention/${encodeURIComponent(attentionId)}/${action}`,
      {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ expectedRevision }),
      },
    ),
  listEnvVars: () =>
    j<{ envVars: WorkspaceEnvVarRecord[] }>("/api/app/env-vars").then((payload) => payload.envVars),
  createEnvVar: (body: SaveWorkspaceEnvVarInput) =>
    j<{ envVar: WorkspaceEnvVarRecord }>("/api/app/env-vars", {
      method: "POST",
      body: JSON.stringify(body),
    }).then((payload) => payload.envVar),
  updateEnvVar: (id: string, body: Partial<SaveWorkspaceEnvVarInput>) =>
    j<{ envVar: WorkspaceEnvVarRecord }>(`/api/app/env-vars/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }).then((payload) => payload.envVar),
  deleteEnvVar: (id: string) => j<{ ok: boolean }>(`/api/app/env-vars/${id}`, { method: "DELETE" }),
  getWorkflowBrief: () => j<WorkflowBrief>("/api/app/workflow/brief"),
  saveWorkflowBrief: (body: SaveWorkflowBriefInput) =>
    j<WorkflowBrief>("/api/app/workflow/brief", { method: "PUT", body: JSON.stringify(body) }),
  listWorkflowBriefTemplates: () => j<WorkflowBriefTemplate[]>("/api/app/workflow/brief/templates"),
  applyWorkflowBriefTemplate: (templateId: string) =>
    j<WorkflowBrief>(`/api/app/workflow/brief/templates/${templateId}/apply`, {
      method: "POST",
      body: "{}",
    }),
  listWorkflowBriefVersions: () => j<WorkflowBriefVersion[]>("/api/app/workflow/brief/versions"),
  restoreWorkflowBriefVersion: (versionId: string) =>
    j<WorkflowBrief>(`/api/app/workflow/brief/versions/${versionId}/restore`, {
      method: "POST",
      body: "{}",
    }),
  listWorkflowRequirements: () => j<WorkflowRequirement[]>("/api/app/workflow/requirements"),
  saveWorkflowRequirements: (requirements: SaveWorkflowRequirementInput[]) =>
    j<WorkflowRequirement[]>("/api/app/workflow/requirements", {
      method: "PUT",
      body: JSON.stringify(requirements),
    }),
  listWorkflowPlanItems: () => j<WorkflowPlanItem[]>("/api/app/workflow/plan-items"),
  createWorkflowPlanItem: (body: SaveWorkflowPlanItemInput) =>
    j<WorkflowPlanItem>("/api/app/workflow/plan-items", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateWorkflowPlanItem: (itemId: string, body: Partial<SaveWorkflowPlanItemInput>) =>
    j<WorkflowPlanItem>(`/api/app/workflow/plan-items/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  listWorkflowBlockers: () => j<WorkflowBlocker[]>("/api/app/workflow/blockers"),
  createWorkflowBlocker: (body: SaveWorkflowBlockerInput) =>
    j<WorkflowBlocker>("/api/app/workflow/blockers", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateWorkflowBlocker: (blockerId: string, body: Partial<SaveWorkflowBlockerInput>) =>
    j<WorkflowBlocker>(`/api/app/workflow/blockers/${blockerId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  listWorkflowQuestions: () => j<WorkflowQuestion[]>("/api/app/workflow/questions"),
  createWorkflowQuestion: (body: SaveWorkflowQuestionInput) =>
    j<WorkflowQuestion>("/api/app/workflow/questions", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateWorkflowQuestion: (questionId: string, body: Partial<SaveWorkflowQuestionInput>) =>
    j<WorkflowQuestion>(`/api/app/workflow/questions/${questionId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  listWorkflowValidationEvidence: () =>
    j<WorkflowValidationEvidence[]>("/api/app/workflow/validation-evidence"),
  createWorkflowValidationEvidence: (body: SaveWorkflowValidationEvidenceInput) =>
    j<WorkflowValidationEvidence>("/api/app/workflow/validation-evidence", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateWorkflowValidationEvidence: (
    evidenceId: string,
    body: Partial<SaveWorkflowValidationEvidenceInput>,
  ) =>
    j<WorkflowValidationEvidence>(`/api/app/workflow/validation-evidence/${evidenceId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  getWorkflowReleaseConfirmation: () =>
    j<WorkflowReleaseConfirmation>("/api/app/workflow/release-confirmation"),
  confirmWorkflowRelease: (body: ConfirmWorkflowReleaseInput) =>
    j<WorkflowReleaseConfirmation>("/api/app/workflow/release-confirmation", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listWorkflowTemplates: () =>
    j<{ templates: WorkflowTemplate[] }>("/api/app/workflow/templates").then(
      (payload) => payload.templates,
    ),
  applyWorkflowTemplate: (templateId: string) =>
    j<WorkflowTemplateApplyResult>(`/api/app/workflow/templates/${templateId}/apply`, {
      method: "POST",
    }),
  generateWorkflowFromPrompt: (body: { prompt: string; apply?: boolean }) =>
    j<WorkflowDraftResult>("/api/app/workflow/generate-from-prompt", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listApiKeys: () =>
    j<{ apiKeys: MaskedApiKey[] }>("/api/app/api-keys").then((payload) => payload.apiKeys),
  createApiKey: (body: { provider: ApiKeyProviderName; label: string; value: string }) =>
    j<{ apiKey: MaskedApiKey }>("/api/app/api-keys", {
      method: "POST",
      body: JSON.stringify(body),
    }).then((p) => p.apiKey),
  deleteApiKey: (id: string) => j<{ ok: boolean }>(`/api/app/api-keys/${id}`, { method: "DELETE" }),
  getUsageSummary: () =>
    j<{ summary: UsageSummary }>("/api/app/usage/summary").then((payload) => payload.summary),
  listProviderCalls: (limit = 100) =>
    j<{ calls: ProviderCallRecord[] }>(`/api/app/usage/calls?limit=${limit}`).then(
      (payload) => payload.calls,
    ),
  listJobs: (limit = 50) =>
    j<{ jobs: JobRecord[] }>(`/api/app/jobs?limit=${limit}`).then((payload) => payload.jobs),
  enqueueJob: (body: {
    type: string;
    payload: Record<string, unknown>;
    cron?: string;
    scheduledAt?: string;
    maxAttempts?: number;
  }) =>
    j<{ job: JobRecord }>("/api/app/jobs", { method: "POST", body: JSON.stringify(body) }).then(
      (p) => p.job,
    ),
  cancelJob: (id: string) =>
    j<{ ok: boolean; job: JobRecord }>(`/api/app/jobs/${id}/cancel`, { method: "POST" }).then(
      (p) => p.job,
    ),
  requestPlanMode: () =>
    j<PlanModeResult>("/api/app/workflow/plan-mode", { method: "POST", body: "{}" }),
  applyPlanMode: (planItems: PlanModePlanItem[]) =>
    j<{ planItems: WorkflowPlanItem[] }>("/api/app/workflow/plan-mode/apply", {
      method: "POST",
      body: JSON.stringify({ planItems }),
    }).then((p) => p.planItems),
  listTools: () => j<{ tools: AvailableTool[] }>("/api/app/tools").then((p) => p.tools),
  getIntegrationReadiness: () =>
    j<{ readiness: IntegrationReadinessSummary }>("/api/app/integration-readiness").then(
      (p) => p.readiness,
    ),
  testIntegrationMarketplaceCard: (cardId: string) => {
    const path = integrationMarketplaceTestPath(cardId);
    return j<IntegrationMarketplaceTestResult>(path, {
      method: "POST",
      body: JSON.stringify({ dryRun: true, cardId }),
    });
  },
  diagnoseAgentRun: (runId: string) =>
    j<{ diagnostic: RunDiagnostic | null }>(`/api/app/agent-runs/${runId}/diagnose`, {
      method: "POST",
    }).then((p) => p.diagnostic),
  recordRunAsPlaybook: (runId: string) =>
    j<{ agent: AgentRecord }>(`/api/app/agent-runs/${runId}/record-as-playbook`, {
      method: "POST",
    }).then((p) => p.agent),
  rotateAgentWebhook: (agentId: string) =>
    j<{ webhookToken: string }>(`/api/app/webhooks/agents/${agentId}/rotate`, {
      method: "POST",
    }).then((p) => p.webhookToken),
  removeAgentWebhook: (agentId: string) =>
    j<{ ok: boolean }>(`/api/app/webhooks/agents/${agentId}`, { method: "DELETE" }),
  listShareTokens: () => j<{ tokens: ShareTokenRecord[] }>("/api/app/share").then((p) => p.tokens),
  createShareToken: (body: CreateShareTokenInput) =>
    j<{ token: ShareTokenRecord }>("/api/app/share", {
      method: "POST",
      body: JSON.stringify(body),
    }).then((p) => p.token),
  deleteShareToken: (id: string) =>
    j<{ ok: boolean }>(`/api/app/share/${id}`, { method: "DELETE" }),
  getPublicShare: (token: string) =>
    j<{ shared: PublicSharePayload }>(`/api/public/share/${encodeURIComponent(token)}`).then(
      (p) => p.shared,
    ),
  getOperationsHealth: () => j<unknown>("/api/app/operations/health"),
  listOperationsAlerts: (
    query: { severity?: string; since?: string; until?: string; limit?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (query.severity) params.set("severity", query.severity);
    if (query.since) params.set("since", query.since);
    if (query.until) params.set("until", query.until);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const qs = params.toString();
    return j<unknown>(`/api/app/operations/alerts${qs ? `?${qs}` : ""}`);
  },
  getOperationsJobMetrics: (
    query: { type?: string; since?: string; until?: string; limit?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (query.type) params.set("type", query.type);
    if (query.since) params.set("since", query.since);
    if (query.until) params.set("until", query.until);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const qs = params.toString();
    return j<unknown>(`/api/app/operations/job-metrics/history${qs ? `?${qs}` : ""}`);
  },
  getSandboxStatus: () => j<SandboxStatus>("/api/app/sandbox/status"),
  getGeneratedAppRuntimeHealth: (appId: string) =>
    j<{ health: GeneratedAppRuntimeHealth }>(
      `/api/app/generated-apps/${encodeURIComponent(appId)}/runtime/health`,
    ).then((payload) => payload.health),
  listSandboxRuntimes: () =>
    j<{ runtimes: SandboxRuntimeInfo[] }>("/api/app/sandbox/runtimes").then((p) => p.runtimes),
  startSandboxExec: (body: SandboxExecRequest) =>
    j<{ exec: SandboxExecRecord }>("/api/app/sandbox/exec", {
      method: "POST",
      body: JSON.stringify(body),
    }).then((p) => p.exec),
  listSandboxExecs: (
    query: { limit?: number; appId?: string; status?: SandboxExecStatus } = {},
  ) => {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.appId) params.set("appId", query.appId);
    if (query.status) params.set("status", query.status);
    const qs = params.toString();
    return j<{ execs: SandboxExecRecord[] }>(`/api/app/sandbox/exec${qs ? `?${qs}` : ""}`).then(
      (p) => p.execs,
    );
  },
  getSandboxExec: (id: string) =>
    j<{ exec: SandboxExecRecord }>(`/api/app/sandbox/exec/${id}`).then((p) => p.exec),
  cancelSandboxExec: (id: string) =>
    j<{ exec: SandboxExecRecord }>(`/api/app/sandbox/exec/${id}/cancel`, { method: "POST" }).then(
      (p) => p.exec,
    ),
};

export function streamSandboxExec(
  id: string,
  handlers: {
    onChunk?: (msg: { stream: "stdout" | "stderr"; data: string }) => void;
    onStatus?: (exec: SandboxExecRecord) => void;
    onDone?: (exec: SandboxExecRecord) => void;
    onError?: (e: Error) => void;
  },
): () => void {
  const es = new EventSource(`/api/app/sandbox/exec/${id}/stream`, { withCredentials: true });
  es.addEventListener("chunk", (e) => {
    try {
      handlers.onChunk?.(JSON.parse((e as MessageEvent).data));
    } catch {
      /* ignore parse */
    }
  });
  es.addEventListener("status", (e) => {
    try {
      handlers.onStatus?.(JSON.parse((e as MessageEvent).data));
    } catch {
      /* ignore parse */
    }
  });
  es.addEventListener("done", (e) => {
    try {
      handlers.onDone?.(JSON.parse((e as MessageEvent).data));
    } catch {
      /* ignore parse */
    }
    es.close();
  });
  es.onerror = () => {
    handlers.onError?.(new Error("stream error"));
    es.close();
  };
  return () => es.close();
}
