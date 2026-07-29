import { type Context, type Hono } from "hono";
import { networkInterfaces as defaultNetworkInterfaces } from "node:os";
import {
  applyCsrfCookie,
  clearCsrfCookie,
  rejectCrossOriginPrivateMutation,
} from "../route-security.js";
import { buildIntegrationMarketplace } from "../integration-marketplace.js";
import {
  inspectIntegrationSandbox,
  type IntegrationSandboxConnectorId,
} from "../integration-sandbox.js";
import { buildModelRoutingPresets } from "../model-routing-presets.js";
import {
  applySessionCookie,
  acceptWorkspaceInvitation,
  completeOnboardingStep,
  createWorkspaceInvitation,
  getActivationDetail,
  getIntegrationReadinessAsync,
  getOnboarding,
  getPrivateBootstrap,
  getSessionPayloadAsync,
  getWorkspaceActivityDetailAsync,
  listWorkspaceMembers,
  listWorkspaceActivitiesAsync,
  loginAsync,
  logoutAsync,
  registerAsync,
  removeWorkspaceMember,
  requireAuthenticatedContextAsync,
  resendWorkspaceInvitation,
  revokeWorkspaceInvitation,
  restoreSessionAsync,
  updateWorkspaceMemberRole,
  updateProfile,
  updateWorkspace,
} from "../packetagent-services.js";
import { loadStoreAsync } from "../packetagent-store.js";
import { errorResponse, requireWorkspacePermission } from "./shared.js";
import { AUTH_RATE_LIMIT, INVITATION_RATE_LIMIT, enforceRateLimit } from "./rate-limit.js";

export function resetAppRouteSecurityForTests() {
  // Security state is store-backed; tests reset it through resetStoreForTests().
}

type HostInfoSources = {
  networkInterfaces: typeof defaultNetworkInterfaces;
  resolvePort: () => number;
};

const DEFAULT_HOST_INFO_SOURCES: HostInfoSources = {
  networkInterfaces: defaultNetworkInterfaces,
  resolvePort: () => {
    const raw = process.env.PORT;
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 8484;
  },
};

let hostInfoSources: HostInfoSources = DEFAULT_HOST_INFO_SOURCES;

export function setHostInfoSourcesForTests(overrides: Partial<HostInfoSources> | null): () => void {
  const previous = hostInfoSources;
  hostInfoSources = overrides
    ? { ...DEFAULT_HOST_INFO_SOURCES, ...overrides }
    : DEFAULT_HOST_INFO_SOURCES;
  return () => {
    hostInfoSources = previous;
  };
}

export function buildHostInfoPayload(sources: HostInfoSources = hostInfoSources): {
  lanIps: string[];
  port: number;
} {
  const lanIps: string[] = [];
  let interfaces: ReturnType<typeof defaultNetworkInterfaces> = {};
  try {
    interfaces = sources.networkInterfaces() ?? {};
  } catch {
    interfaces = {};
  }
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family !== "IPv4") continue;
      if (entry.internal) continue;
      if (!entry.address) continue;
      lanIps.push(entry.address);
    }
  }
  return { lanIps, port: sources.resolvePort() };
}

async function integrationMarketplace(c: Context) {
  try {
    const context = await requireAuthenticatedContextAsync(c);
    await requireWorkspacePermission(context, "viewWorkspace");
    const readiness = await getIntegrationReadinessAsync(context);
    return c.json({ marketplace: buildIntegrationMarketplace({ readiness, env: process.env }) });
  } catch (error) {
    return errorResponse(c, error);
  }
}

async function builderProviderStatus(c: Context) {
  try {
    const context = await requireAuthenticatedContextAsync(c);
    await requireWorkspacePermission(context, "viewWorkspace");
    // Lazy-import to avoid a circular dep between app-routes and provider
    // bootstrap (which itself imports route-adjacent modules in some setups).
    const { registerDefaultProviders } = await import("../providers/bootstrap.js");
    const {
      snapshotPresetResolutions,
      availableProviders,
      providerReadinessSnapshot,
      vaultProviderNamesForWorkspace,
    } = await import("../providers/preset-resolver.js");
    registerDefaultProviders();
    const vaultProviders = await vaultProviderNamesForWorkspace(context.workspace.id);
    const providerOptions = { vaultProviders };
    const snapshot = snapshotPresetResolutions(providerOptions);
    const available = availableProviders(providerOptions);
    return c.json({
      presets: snapshot,
      availableProviders: available,
      providers: providerReadinessSnapshot(providerOptions),
      priority: process.env.PACKETAGENT_PROVIDER_PRIORITY ?? null,
    });
  } catch (error) {
    return errorResponse(c, error);
  }
}

async function modelRoutingPresets(c: Context) {
  try {
    const context = await requireAuthenticatedContextAsync(c);
    await requireWorkspacePermission(context, "viewWorkspace");
    const data = await loadStoreAsync();
    const readiness = await getIntegrationReadinessAsync(context);
    return c.json({
      routingPresets: buildModelRoutingPresets({
        workspaceId: context.workspace.id,
        providers: data.providers,
        readiness,
        env: process.env,
        vaultProviders: data.apiKeys
          .filter((entry) => entry.workspaceId === context.workspace.id)
          .map((entry) => entry.provider),
      }),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
}

async function integrationSandboxTest(c: Context, connectorId: IntegrationSandboxConnectorId) {
  try {
    const context = await requireAuthenticatedContextAsync(c);
    await requireWorkspacePermission(context, "viewWorkspace");
    const readiness = await getIntegrationReadinessAsync(context);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const workspaceEnv = await workspaceIntegrationSandboxEnv(context);
    const report = inspectIntegrationSandbox({
      draft: {
        summary: integrationSandboxSummary(connectorId, body),
        integrations: [connectorId],
      },
      env: { ...process.env, ...workspaceEnv },
      availableTools: readiness.tools.names,
      connectedConnectors: readiness.tools.names,
      runtime: {
        connectors: {
          [connectorId]: { required: true },
        },
      },
    });
    const result = report.results.find((entry) => entry.id === connectorId) ?? report.results[0];
    return c.json({
      test: {
        status: result?.status ?? report.status,
        connectorId,
        message: result?.message ?? "Sandbox check completed.",
        setupGuide: result?.setupGuide ?? report.setupGuide,
        deterministic: true,
        liveNetworkCalls: false,
      },
      sandbox: report,
    });
  } catch (error) {
    return errorResponse(c, error);
  }
}

async function workspaceIntegrationSandboxEnv(
  context: Awaited<ReturnType<typeof requireAuthenticatedContextAsync>>,
) {
  const data = await loadStoreAsync();
  const env: Record<string, string | undefined> = {};
  for (const entry of data.workspaceEnvVars.filter(
    (item) => item.workspaceId === context.workspace.id && item.scope !== "build",
  )) {
    env[entry.key] = entry.value || "configured";
  }

  const apiKeyProviders = new Set(
    data.apiKeys
      .filter((entry) => entry.workspaceId === context.workspace.id)
      .map((entry) => entry.provider),
  );
  if (apiKeyProviders.has("openai"))
    env.OPENAI_API_KEY = env.OPENAI_API_KEY ?? "workspace-vault-key";
  if (apiKeyProviders.has("anthropic"))
    env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY ?? "workspace-vault-key";
  if (apiKeyProviders.has("minimax"))
    env.MINIMAX_API_KEY = env.MINIMAX_API_KEY ?? "workspace-vault-key";
  if (apiKeyProviders.has("gemini"))
    env.GEMINI_API_KEY = env.GEMINI_API_KEY ?? "workspace-vault-key";
  if (apiKeyProviders.has("openrouter"))
    env.OPENROUTER_API_KEY = env.OPENROUTER_API_KEY ?? "workspace-vault-key";
  if (apiKeyProviders.has("ollama"))
    env.OLLAMA_BASE_URL = env.OLLAMA_BASE_URL ?? "workspace-vault-key";

  for (const provider of data.providers.filter(
    (entry) => entry.workspaceId === context.workspace.id && entry.status !== "disabled",
  )) {
    if (provider.kind === "openai" && provider.apiKeyConfigured)
      env.OPENAI_API_KEY = env.OPENAI_API_KEY ?? "workspace-provider-key";
    if (provider.kind === "anthropic" && provider.apiKeyConfigured)
      env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY ?? "workspace-provider-key";
    if (provider.kind === "minimax" && provider.apiKeyConfigured)
      env.MINIMAX_API_KEY = env.MINIMAX_API_KEY ?? "workspace-provider-key";
    if (provider.kind === "gemini" && provider.apiKeyConfigured)
      env.GEMINI_API_KEY = env.GEMINI_API_KEY ?? "workspace-provider-key";
    if (provider.kind === "openrouter" && provider.apiKeyConfigured)
      env.OPENROUTER_API_KEY = env.OPENROUTER_API_KEY ?? "workspace-provider-key";
    if (provider.kind === "ollama")
      env.OLLAMA_BASE_URL = provider.baseUrl ?? env.OLLAMA_BASE_URL ?? "http://localhost:11434";
    if (provider.kind === "custom") {
      env.CUSTOM_PROVIDER_BASE_URL =
        provider.baseUrl ?? env.CUSTOM_PROVIDER_BASE_URL ?? "workspace-custom-provider";
      if (provider.apiKeyConfigured)
        env.CUSTOM_PROVIDER_API_KEY = env.CUSTOM_PROVIDER_API_KEY ?? "workspace-provider-key";
    }
  }

  return env;
}

function connectorForIntegrationTestKind(kind: string): IntegrationSandboxConnectorId {
  switch (kind) {
    case "email":
      return "email";
    case "slack-webhook":
    case "webhook":
      return "webhook";
    case "github-webhook":
    case "github":
      return "github";
    case "stripe-payments":
    case "stripe":
    case "payment":
      return "payment";
    case "browser-scraping":
    case "browser":
      return "browser";
    case "database":
      return "database";
    case "custom-api":
    case "custom-api-provider":
    case "custom":
      return "model_provider";
    default:
      return "webhook";
  }
}

function integrationSandboxSummary(
  connectorId: IntegrationSandboxConnectorId,
  body: Record<string, unknown>,
): string {
  const bodyText =
    typeof body.provider === "string"
      ? body.provider
      : typeof body.mode === "string"
        ? body.mode
        : JSON.stringify(body.body ?? body.sample ?? body).slice(0, 240);
  const labels: Record<IntegrationSandboxConnectorId, string> = {
    model_provider: "model provider OpenAI Anthropic Ollama custom API",
    database: "database Postgres persistence",
    email: "email SMTP Resend SendGrid Postmark",
    webhook: "webhook Slack inbound signed events",
    payment: "Stripe payments checkout subscription webhook",
    github: "GitHub webhook repository issue pull request",
    browser: "browser scraping Playwright screenshot crawl",
    preview_renderer: "preview renderer",
    preview_runtime: "preview runtime API routes",
    preview_browser: "preview browser smoke screenshot",
  };
  return `${labels[connectorId]} ${bodyText}`;
}

export function registerAuthBootstrapRoutes(app: Hono): void {
  app.get("/auth/session", async (c) => {
    try {
      const context = await restoreSessionAsync(c);
      if (!context) {
        return c.json({ authenticated: false, user: null, workspace: null, onboarding: null });
      }

      await requireWorkspacePermission(context, "viewWorkspace");
      return c.json(await getSessionPayloadAsync(context));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/auth/register", async (c) => {
    try {
      const body = (await c.req.json()) as {
        email?: string;
        password?: string;
        displayName?: string;
      };
      // Combine IP + submitted email so one attacker can't exhaust the shared
      // login/register bucket and lock every account out (see clientKey()).
      await enforceRateLimit(c, "auth:register", AUTH_RATE_LIMIT, body.email);
      const result = await registerAsync({
        email: body.email ?? "",
        password: body.password ?? "",
        displayName: body.displayName ?? "",
      });
      applySessionCookie(c, result.cookieValue);
      applyCsrfCookie(c, result.cookieValue);
      c.status(201);
      return c.json(await getSessionPayloadAsync(result.context));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/auth/login", async (c) => {
    try {
      const body = (await c.req.json()) as { email?: string; password?: string };
      // Combine IP + submitted email so one attacker can't exhaust the shared
      // login/register bucket and lock every account out (see clientKey()).
      await enforceRateLimit(c, "auth:login", AUTH_RATE_LIMIT, body.email);
      const result = await loginAsync({
        email: body.email ?? "",
        password: body.password ?? "",
      });
      applySessionCookie(c, result.cookieValue);
      applyCsrfCookie(c, result.cookieValue);
      return c.json(await getSessionPayloadAsync(result.context));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/auth/logout", async (c) => {
    const blocked = rejectCrossOriginPrivateMutation(c);
    if (blocked) return blocked;
    await logoutAsync(c);
    clearCsrfCookie(c);
    return c.json({ ok: true });
  });

  app.get("/app/bootstrap", async (c) => {
    try {
      const context = await requireAuthenticatedContextAsync(c);
      await requireWorkspacePermission(context, "viewWorkspace");
      return c.json(await getPrivateBootstrap(context));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get("/app/activation", async (c) => {
    try {
      const context = await requireAuthenticatedContextAsync(c);
      await requireWorkspacePermission(context, "viewWorkspace");
      return c.json(await getActivationDetail(context));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get("/app/activity", async (c) => {
    try {
      const context = await requireAuthenticatedContextAsync(c);
      await requireWorkspacePermission(context, "viewWorkspace");
      return c.json({ activities: await listWorkspaceActivitiesAsync(context) });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get("/app/activity/:id", async (c) => {
    try {
      const context = await requireAuthenticatedContextAsync(c);
      await requireWorkspacePermission(context, "viewWorkspace");
      return c.json(await getWorkspaceActivityDetailAsync(context, c.req.param("id")));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get("/app/host-info", async (c) => {
    try {
      const context = await requireAuthenticatedContextAsync(c);
      await requireWorkspacePermission(context, "viewWorkspace");
      void context;
      return c.json(buildHostInfoPayload());
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get("/app/integration-marketplace", async (c) => integrationMarketplace(c));
  app.get("/app/integrations/marketplace", async (c) => integrationMarketplace(c));
  app.get("/app/model-routing-presets", async (c) => modelRoutingPresets(c));
  app.get("/app/llm/routing-presets", async (c) => modelRoutingPresets(c));
  app.get("/app/builder/providers/status", async (c) => builderProviderStatus(c));
  app.post("/app/llm/test", async (c) => integrationSandboxTest(c, "model_provider"));
  app.post("/app/tools/browser/test", async (c) => integrationSandboxTest(c, "browser"));
  app.post("/app/integrations/:kind/test", async (c) =>
    integrationSandboxTest(c, connectorForIntegrationTestKind(c.req.param("kind"))),
  );
}

export function registerWorkspaceMemberRoutes(app: Hono): void {
  app.get("/app/onboarding", async (c) => {
    try {
      const context = await requireAuthenticatedContextAsync(c);
      await requireWorkspacePermission(context, "viewWorkspace");
      return c.json({ onboarding: await getOnboarding(context) });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/app/onboarding/steps/:stepKey/complete", async (c) => {
    try {
      const context = await requireAuthenticatedContextAsync(c);
      await requireWorkspacePermission(context, "editWorkflow");
      return c.json({ onboarding: await completeOnboardingStep(context, c.req.param("stepKey")) });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.patch("/app/profile", async (c) => {
    try {
      const context = await requireAuthenticatedContextAsync(c);
      const body = (await c.req.json()) as { displayName?: string; timezone?: string };
      const user = await updateProfile(context, {
        displayName: body.displayName ?? "",
        timezone: body.timezone ?? "",
      });
      return c.json({
        profile: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          timezone: user.timezone,
        },
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.patch("/app/workspace", async (c) => {
    try {
      const context = await requireAuthenticatedContextAsync(c);
      await requireWorkspacePermission(context, "manageWorkspace");
      const body = (await c.req.json()) as {
        name?: string;
        website?: string;
        automationGoal?: string;
      };
      const workspace = await updateWorkspace(context, {
        name: body.name ?? "",
        website: body.website ?? "",
        automationGoal: body.automationGoal ?? "",
      });
      return c.json({ workspace });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get("/app/members", async (c) => {
    try {
      const context = await requireAuthenticatedContextAsync(c);
      await requireWorkspacePermission(context, "viewWorkspace");
      return c.json(await listWorkspaceMembers(context));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/app/invitations", async (c) => {
    try {
      await enforceRateLimit(c, "invitation:create", INVITATION_RATE_LIMIT);
      const context = await requireAuthenticatedContextAsync(c);
      await requireWorkspacePermission(context, "manageWorkspace");
      const body = (await c.req.json()) as { email?: string; role?: string };
      c.status(201);
      return c.json(
        await createWorkspaceInvitation(context, {
          email: body.email ?? "",
          role: body.role ?? "member",
        }),
      );
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/app/invitations/:token/accept", async (c) => {
    try {
      await enforceRateLimit(c, "invitation:accept", INVITATION_RATE_LIMIT);
      const context = await requireAuthenticatedContextAsync(c);
      return c.json(await acceptWorkspaceInvitation(context, c.req.param("token")));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/app/invitations/:invitationId/resend", async (c) => {
    try {
      await enforceRateLimit(c, "invitation:resend", INVITATION_RATE_LIMIT);
      const context = await requireAuthenticatedContextAsync(c);
      await requireWorkspacePermission(context, "manageWorkspace");
      return c.json(await resendWorkspaceInvitation(context, c.req.param("invitationId")));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/app/invitations/:invitationId/revoke", async (c) => {
    try {
      const context = await requireAuthenticatedContextAsync(c);
      await requireWorkspacePermission(context, "manageWorkspace");
      return c.json(await revokeWorkspaceInvitation(context, c.req.param("invitationId")));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.patch("/app/members/:userId", async (c) => {
    try {
      const context = await requireAuthenticatedContextAsync(c);
      await requireWorkspacePermission(context, "manageWorkspace");
      const body = (await c.req.json()) as { role?: string };
      return c.json(
        await updateWorkspaceMemberRole(context, c.req.param("userId"), { role: body.role ?? "" }),
      );
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.delete("/app/members/:userId", async (c) => {
    try {
      const context = await requireAuthenticatedContextAsync(c);
      await requireWorkspacePermission(context, "manageWorkspace");
      return c.json(await removeWorkspaceMember(context, c.req.param("userId")));
    } catch (error) {
      return errorResponse(c, error);
    }
  });
}
