import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Hono } from "hono";
import { strFromU8, unzipSync } from "fflate";
import { SESSION_COOKIE_NAME } from "./auth-utils";
import { appRoutes, setHostInfoSourcesForTests } from "./app-routes";
import { resolvePacketAgentPreviewOrigin } from "./app-preview-isolation.js";
import { mintGeneratedPreviewCapability } from "./app-preview-capability.js";
import { setGeneratedAppFileTreeValidatorForTests } from "./app-routes/builder-core.js";
import { shutdownDefaultGeneratedAppRuntimeProcessPool } from "./generated-app-runtime/server.js";
import { login } from "./packetagent-services";
import { upsertApiKey } from "./security/api-key-store.js";
import {
  clearStoreCacheForTests,
  createSeedStore,
  loadStore,
  mutateStore,
  resetStoreForTests,
  setManagedPostgresStoreClientFactoryForTests,
  type ManagedPostgresStoreClientConfig,
  type ManagedPostgresStoreQueryClient,
  type ManagedPostgresStoreQueryResult,
  type GeneratedAppRecord,
  type PacketAgentData,
} from "./packetagent-store";

const passingGeneratedAppValidator: NonNullable<
  Parameters<typeof setGeneratedAppFileTreeValidatorForTests>[0]
> = async () => ({
  ok: true,
  source: "real",
  errors: [],
  warnings: [],
  durationMs: 7,
  phases: { typecheck: "passed", build: "passed" },
});

setGeneratedAppFileTreeValidatorForTests(passingGeneratedAppValidator);

const STORE_ENV_KEYS = [
  "PACKETAGENT_STORE",
  "DATABASE_URL",
  "PACKETAGENT_DATABASE_URL",
  "PACKETAGENT_MANAGED_DATABASE_URL",
] as const;

type StoreEnvKey = (typeof STORE_ENV_KEYS)[number];

class FakeManagedPostgresClient implements ManagedPostgresStoreQueryClient {
  payloadJson: string | null = JSON.stringify(createSeedStore());

  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<ManagedPostgresStoreQueryResult<TRow>> {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (normalized.startsWith("select payload from packetagent_document_store")) {
      return { rows: this.payloadJson ? [{ payload: this.payloadJson } as unknown as TRow] : [] };
    }
    if (normalized.startsWith("insert into packetagent_document_store")) {
      this.payloadJson = String(params[3]);
    }
    return { rows: [] };
  }

  storedData(): PacketAgentData {
    assert.ok(this.payloadJson);
    return JSON.parse(this.payloadJson) as PacketAgentData;
  }
}

function createTestApp() {
  const app = new Hono();
  app.route("/api", appRoutes);
  return app;
}

function authHeaders(cookieValue: string) {
  return { Cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` };
}

async function openGeneratedPreviewSession(
  app: Hono,
  input: {
    appId: string;
    sessionCookie: string;
    checkpointId?: string;
    scope?: "read" | "interact";
  },
) {
  const tokenResponse = await app.request(
    `/api/app/generated-apps/${encodeURIComponent(input.appId)}/preview-token`,
    {
      method: "POST",
      headers: {
        ...authHeaders(input.sessionCookie),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        scope: input.scope ?? "read",
        ...(input.checkpointId ? { checkpointId: input.checkpointId } : {}),
      }),
    },
  );
  assert.equal(tokenResponse.status, 200);
  const tokenBody = (await tokenResponse.json()) as {
    token: string;
    previewUrl: string;
    checkpointId: string;
  };
  const previewUrl = new URL(tokenBody.previewUrl);
  assert.equal(previewUrl.origin, resolvePacketAgentPreviewOrigin());
  assert.equal(previewUrl.search, "");
  assert.match(previewUrl.hash, /^#token=pt1\./);
  const canonicalAppId = decodeURIComponent(
    previewUrl.pathname.split("/generated-apps/")[1]?.split("/")[0] ?? "",
  );
  assert.ok(canonicalAppId);

  const sessionResponse = await app.request(
    new URL(
      `/api/app/generated-apps/${encodeURIComponent(canonicalAppId)}/preview-session`,
      resolvePacketAgentPreviewOrigin(),
    ),
    {
      method: "POST",
      headers: {
        Origin: resolvePacketAgentPreviewOrigin(),
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token: tokenBody.token }),
    },
  );
  assert.equal(sessionResponse.status, 200);
  const setCookie = sessionResponse.headers.get("set-cookie");
  assert.ok(setCookie);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=None/i);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /Partitioned/i);
  assert.match(
    setCookie,
    new RegExp(
      `Path=/api/app/generated-apps/${canonicalAppId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`,
    ),
  );
  assert.doesNotMatch(setCookie, new RegExp(`${SESSION_COOKIE_NAME}=`, "i"));
  return {
    cookie: setCookie.split(";")[0]!,
    previewUrl,
    token: tokenBody.token,
    checkpointId: tokenBody.checkpointId,
  };
}

function generatedPreviewRequestUrl(path: string): URL {
  return new URL(path, resolvePacketAgentPreviewOrigin());
}

async function withGeneratedAppWorkspaceRoot(run: (rootPath: string) => Promise<void> | void) {
  const previous = process.env.PACKETAGENT_GENERATED_APP_WORKSPACES_DIR;
  const rootPath = mkdtempSync(join(tmpdir(), "packetagent-generated-apps-"));
  process.env.PACKETAGENT_GENERATED_APP_WORKSPACES_DIR = rootPath;
  try {
    await run(rootPath);
  } finally {
    if (previous === undefined) delete process.env.PACKETAGENT_GENERATED_APP_WORKSPACES_DIR;
    else process.env.PACKETAGENT_GENERATED_APP_WORKSPACES_DIR = previous;
    rmSync(rootPath, { recursive: true, force: true });
  }
}

function assertPathInside(parentPath: string, childPath: string) {
  if (resolve(parentPath) === resolve(childPath)) return;
  const scoped = relative(parentPath, childPath);
  if (scoped === "") return;
  assert.ok(
    !scoped.startsWith("..") && !isAbsolute(scoped),
    `${childPath} should be inside ${parentPath}`,
  );
}

function cookieValue(response: Response) {
  const cookie = response.headers.get("set-cookie") ?? "";
  const match = cookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  assert.ok(match?.[1], "expected response to set a session cookie");
  return match[1];
}

async function withManagedStoreEnv(
  env: Partial<Record<StoreEnvKey, string>>,
  client: FakeManagedPostgresClient,
  run: (configs: ManagedPostgresStoreClientConfig[]) => Promise<void> | void,
) {
  const previous = new Map<StoreEnvKey, string | undefined>();
  for (const key of STORE_ENV_KEYS) previous.set(key, process.env[key]);

  const configs: ManagedPostgresStoreClientConfig[] = [];
  const restoreFactory = setManagedPostgresStoreClientFactoryForTests((config) => {
    configs.push(config);
    return client;
  });

  try {
    for (const key of STORE_ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(env) as Array<[StoreEnvKey, string | undefined]>) {
      if (value !== undefined) process.env[key] = value;
    }
    clearStoreCacheForTests();
    await run(configs);
  } finally {
    clearStoreCacheForTests();
    restoreFactory();
    for (const key of STORE_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("app activation route requires authentication", async () => {
  resetStoreForTests();
  const app = createTestApp();

  const response = await app.request("/api/app/activation");
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.deepEqual(body, { error: "authentication required" });
});

test("auth session routes run through the async managed store backend", async () => {
  const client = new FakeManagedPostgresClient();

  await withManagedStoreEnv(
    {
      PACKETAGENT_STORE: "postgres",
      PACKETAGENT_DATABASE_URL: "postgres://packetagent:secret@db.example.com/packetagent",
    },
    client,
    async (configs) => {
      const app = createTestApp();

      const loginResponse = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "alpha@packetagent.local", password: "demo12345" }),
      });
      const loginBody = (await loginResponse.json()) as {
        authenticated: boolean;
        user: { id: string };
      };

      assert.equal(configs[0].envKey, "PACKETAGENT_DATABASE_URL");
      assert.equal(loginResponse.status, 200);
      assert.equal(loginBody.authenticated, true);
      assert.equal(loginBody.user.id, "user_alpha");

      const sessionResponse = await app.request("/api/auth/session", {
        headers: authHeaders(cookieValue(loginResponse)),
      });
      const sessionBody = (await sessionResponse.json()) as {
        authenticated: boolean;
        user: { id: string };
      };

      assert.equal(sessionResponse.status, 200);
      assert.equal(sessionBody.authenticated, true);
      assert.equal(sessionBody.user.id, "user_alpha");
      assert.equal(
        client.storedData().sessions.some((entry) => entry.userId === "user_alpha"),
        true,
      );
    },
  );
});

test("app activation detail is scoped to the authenticated workspace", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });

  const response = await app.request("/api/app/activation", {
    headers: authHeaders(alpha.cookieValue),
  });
  const body = (await response.json()) as {
    workspace: { id: string };
    activities: { workspaceId: string }[];
  };

  assert.equal(response.status, 200);
  assert.equal(body.workspace.id, "alpha");
  assert.ok(body.activities.length > 0);
  assert.ok(body.activities.every((activity) => activity.workspaceId === "alpha"));
});

test("integration marketplace route requires authentication", async () => {
  resetStoreForTests();
  const app = createTestApp();

  const response = await app.request("/api/app/integration-marketplace");
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.deepEqual(body, { error: "authentication required" });
});

test("model routing presets route requires authentication", async () => {
  resetStoreForTests();
  const app = createTestApp();

  const response = await app.request("/api/app/model-routing-presets");
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.deepEqual(body, { error: "authentication required" });
});

test("model routing presets route exposes safe workspace-scoped presets", async (t) => {
  resetStoreForTests();
  const previousOpenAi = process.env.OPENAI_API_KEY;
  const previousFast = process.env.PACKETAGENT_MODEL_PRESET_FAST;
  t.after(() => {
    if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAi;
    if (previousFast === undefined) delete process.env.PACKETAGENT_MODEL_PRESET_FAST;
    else process.env.PACKETAGENT_MODEL_PRESET_FAST = previousFast;
  });
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  process.env.OPENAI_API_KEY = "sk-route-secret";
  process.env.PACKETAGENT_MODEL_PRESET_FAST = "openai:gpt-4.1-mini";

  const response = await app.request("/api/app/model-routing-presets", {
    headers: authHeaders(alpha.cookieValue),
  });
  const body = (await response.json()) as {
    routingPresets?: {
      version?: string;
      presets?: {
        fast?: { primary?: { provider?: string; model?: string; envHints?: string[] } };
        smart?: { fallbacks?: Array<{ provider?: string }> };
        local?: { primary?: { provider?: string } };
      };
    };
  };

  assert.equal(response.status, 200);
  assert.equal(body.routingPresets?.version, "phase-72-lane-4");
  assert.equal(body.routingPresets?.presets?.fast?.primary?.provider, "openai");
  assert.equal(body.routingPresets?.presets?.fast?.primary?.model, "gpt-4.1-mini");
  assert.ok(
    body.routingPresets?.presets?.fast?.primary?.envHints?.includes(
      "PACKETAGENT_MODEL_PRESET_FAST",
    ),
  );
  assert.equal(JSON.stringify(body).includes("sk-route-secret"), false);

  const aliasResponse = await app.request("/api/app/llm/routing-presets", {
    headers: authHeaders(alpha.cookieValue),
  });
  assert.equal(aliasResponse.status, 200);
});

test("builder provider status reports vault-only capability readiness without secrets", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  upsertApiKey({
    workspaceId: "alpha",
    provider: "openrouter",
    label: "OpenRouter",
    value: "openrouter-status-secret",
  });

  const response = await app.request("/api/app/builder/providers/status", {
    headers: authHeaders(alpha.cookieValue),
  });
  const body = (await response.json()) as {
    availableProviders?: string[];
    providers?: Array<{
      provider: string;
      ready: boolean;
      credentialSource: string;
      capabilities: { vaultKey: boolean; structuredOutput: string };
    }>;
  };

  assert.equal(response.status, 200);
  assert.ok(body.availableProviders?.includes("openrouter"));
  const openrouter = body.providers?.find((entry) => entry.provider === "openrouter");
  assert.equal(openrouter?.ready, true);
  assert.equal(openrouter?.credentialSource, "workspace_vault");
  assert.equal(openrouter?.capabilities.vaultKey, true);
  assert.equal(openrouter?.capabilities.structuredOutput, "conditional");
  assert.equal(JSON.stringify(body).includes("openrouter-status-secret"), false);
});

test("integration marketplace route exposes cards, readiness, config, and test payloads without secrets", async (t) => {
  resetStoreForTests();
  const previousOpenAi = process.env.OPENAI_API_KEY;
  t.after(() => {
    if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAi;
  });
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  process.env.OPENAI_API_KEY = "sk-route-secret";

  const response = await app.request("/api/app/integration-marketplace", {
    headers: authHeaders(alpha.cookieValue),
  });
  const body = (await response.json()) as {
    marketplace?: {
      version?: string;
      cards?: Array<{
        id: string;
        config: { requiredEnv: string[]; secretsRedacted: boolean };
        test: { method: string; path: string; body: Record<string, unknown> };
        readiness: { status: string; blockers: string[] };
      }>;
    };
  };
  const cards = body.marketplace?.cards ?? [];

  assert.equal(response.status, 200);
  assert.equal(body.marketplace?.version, "phase-71-lane-4");
  assert.equal(cards.length, 10);
  assert.ok(
    cards.some(
      (card) => card.id === "openai" && card.config.requiredEnv.includes("OPENAI_API_KEY"),
    ),
  );
  assert.ok(
    cards.some(
      (card) => card.id === "database" && card.config.requiredEnv.includes("DATABASE_URL"),
    ),
  );
  assert.ok(
    cards.some(
      (card) => card.id === "stripe-payments" && card.test.path.includes("stripe-payments"),
    ),
  );
  assert.ok(cards.every((card) => card.config.secretsRedacted));
  assert.equal(JSON.stringify(body).includes("sk-route-secret"), false);

  const aliasResponse = await app.request("/api/app/integrations/marketplace", {
    headers: authHeaders(alpha.cookieValue),
  });
  assert.equal(aliasResponse.status, 200);
});

test("integration marketplace advertised test routes use deterministic sandbox checks", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const headers = { ...authHeaders(alpha.cookieValue), "Content-Type": "application/json" };

  mutateStore((data) => {
    data.workspaceEnvVars.push({
      id: "env_alpha_route_email_test",
      workspaceId: "alpha",
      key: "RESEND_API_KEY",
      value: "re_route_test_secret",
      scope: "runtime",
      secret: true,
      description: "route test email key",
      createdByUserId: "user_alpha",
      createdAt: "2026-05-03T21:00:00.000Z",
      updatedAt: "2026-05-03T21:00:00.000Z",
    });
  });

  const llmResponse = await app.request("/api/app/llm/test", {
    method: "POST",
    headers,
    body: JSON.stringify({ provider: "openai", prompt: "Reply with ok." }),
  });
  const llmBody = (await llmResponse.json()) as {
    test?: { connectorId?: string; deterministic?: boolean; liveNetworkCalls?: boolean };
    sandbox?: { version?: string };
  };

  assert.equal(llmResponse.status, 200);
  assert.equal(llmBody.test?.connectorId, "model_provider");
  assert.equal(llmBody.test?.deterministic, true);
  assert.equal(llmBody.test?.liveNetworkCalls, false);
  assert.equal(llmBody.sandbox?.version, "phase-71-lane-3");

  const stripeResponse = await app.request("/api/app/integrations/stripe-payments/test", {
    method: "POST",
    headers,
    body: JSON.stringify({ dryRun: true, sample: { id: "cs_test_123" } }),
  });
  const stripeBody = (await stripeResponse.json()) as { test?: { connectorId?: string } };

  assert.equal(stripeResponse.status, 200);
  assert.equal(stripeBody.test?.connectorId, "payment");

  const emailResponse = await app.request("/api/app/integrations/email/test", {
    method: "POST",
    headers,
    body: JSON.stringify({ dryRun: true, sample: { to: "ops@example.test" } }),
  });
  const emailBody = (await emailResponse.json()) as {
    test?: { connectorId?: string; status?: string };
    sandbox?: unknown;
  };

  assert.equal(emailResponse.status, 200);
  assert.equal(emailBody.test?.connectorId, "email");
  assert.equal(emailBody.test?.status, "pass");
  assert.equal(JSON.stringify(emailBody).includes("re_route_test_secret"), false);
});

test("activity list and detail do not expose another workspace", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });

  mutateStore((data) => {
    data.activities.unshift(
      {
        id: "activity_beta_private_route_test",
        workspaceId: "beta",
        scope: "activation",
        event: "route.private_beta",
        actor: { type: "system", id: "test" },
        data: { title: "Beta private activity" },
        occurredAt: "2026-01-03T00:00:00.000Z",
      },
      {
        id: "activity_alpha_newer_route_test",
        workspaceId: "alpha",
        scope: "activation",
        event: "route.alpha_newer",
        actor: { type: "system", id: "test" },
        data: { title: "Alpha newer activity" },
        occurredAt: "2026-01-02T00:00:00.000Z",
      },
      {
        id: "activity_alpha_older_route_test",
        workspaceId: "alpha",
        scope: "activation",
        event: "route.alpha_older",
        actor: { type: "system", id: "test" },
        data: { title: "Alpha older activity" },
        occurredAt: "2026-01-01T00:00:00.000Z",
      },
    );
  });

  const listResponse = await app.request("/api/app/activity", {
    headers: authHeaders(alpha.cookieValue),
  });
  const listBody = (await listResponse.json()) as {
    activities: { id: string; workspaceId: string }[];
  };

  assert.equal(listResponse.status, 200);
  assert.ok(
    listBody.activities.some((activity) => activity.id === "activity_alpha_newer_route_test"),
  );
  assert.ok(
    !listBody.activities.some((activity) => activity.id === "activity_beta_private_route_test"),
  );
  assert.ok(listBody.activities.every((activity) => activity.workspaceId === "alpha"));

  const detailResponse = await app.request("/api/app/activity/activity_beta_private_route_test", {
    headers: authHeaders(alpha.cookieValue),
  });
  const detailBody = await detailResponse.json();

  assert.equal(detailResponse.status, 404);
  assert.deepEqual(detailBody, { error: "activity not found" });
});

test("generated apps list is workspace-scoped and returns lightweight summaries", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });

  mutateStore((data) => {
    data.generatedApps ??= [];
    data.generatedApps.unshift(
      {
        id: "gapp_alpha_summary_route_test",
        workspaceId: "alpha",
        slug: "alpha-bookings",
        name: "Alpha Bookings",
        description: "Booking app for Alpha",
        prompt: "Build a booking app for Alpha.",
        templateId: "booking",
        status: "built",
        draft: { app: { name: "Alpha Bookings" } },
        checkpointId: "gapp_ckpt_alpha_summary_route_test",
        previewUrl: "/builder/preview/alpha/alpha-bookings",
        buildStatus: "passed",
        smokeStatus: "pass",
        publishStatus: "published",
        publishedUrl: "https://apps.example.test/alpha/alpha-bookings",
        createdByUserId: "user_alpha",
        createdAt: "2026-05-01T10:00:00.000Z",
        updatedAt: "2026-05-02T10:00:00.000Z",
      },
      {
        id: "gapp_beta_summary_route_test",
        workspaceId: "beta",
        slug: "beta-private",
        name: "Beta Private",
        description: "Private beta app",
        prompt: "Build a private app for Beta.",
        templateId: "crm",
        status: "saved",
        draft: { app: { name: "Beta Private" } },
        checkpointId: "gapp_ckpt_beta_summary_route_test",
        createdByUserId: "user_beta",
        createdAt: "2026-05-01T11:00:00.000Z",
        updatedAt: "2026-05-02T11:00:00.000Z",
      },
    );
  });

  const response = await app.request("/api/app/generated-apps", {
    headers: authHeaders(alpha.cookieValue),
  });
  const body = (await response.json()) as {
    generatedApps?: Array<Record<string, unknown>>;
  };

  assert.equal(response.status, 200);
  assert.equal(body.generatedApps?.length, 1);
  assert.deepEqual(body.generatedApps?.[0], {
    id: "gapp_alpha_summary_route_test",
    slug: "alpha-bookings",
    name: "Alpha Bookings",
    status: "built",
    previewUrl: "/builder/preview/alpha/alpha-bookings",
    publishStatus: "published",
    publishedUrl: "https://apps.example.test/alpha/alpha-bookings",
    checkpointId: "gapp_ckpt_alpha_summary_route_test",
    updatedAt: "2026-05-02T10:00:00.000Z",
    createdAt: "2026-05-01T10:00:00.000Z",
  });
  assert.equal(JSON.stringify(body).includes("gapp_beta_summary_route_test"), false);
  assert.equal(Object.hasOwn(body.generatedApps?.[0] ?? {}, "workspaceId"), false);
  assert.equal(Object.hasOwn(body.generatedApps?.[0] ?? {}, "draft"), false);
  assert.equal(Object.hasOwn(body.generatedApps?.[0] ?? {}, "prompt"), false);
});

test("builder agent draft can be approved into an agent", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const headers = { ...authHeaders(alpha.cookieValue), "Content-Type": "application/json" };

  const draftResponse = await app.request("/api/app/builder/agent-draft", {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt:
        "Create a release audit agent that reviews evidence URLs, checks the release label, and reports blockers before launch.",
    }),
  });
  const draftBody = (await draftResponse.json()) as { draft?: { agent?: { name?: string } } };

  assert.equal(draftResponse.status, 200);
  assert.equal(draftBody.draft?.agent?.name, "Release audit agent");

  const approveResponse = await app.request("/api/app/builder/agent-draft/approve", {
    method: "POST",
    headers,
    body: JSON.stringify({ draft: draftBody.draft, runPreview: true }),
  });
  const approveBody = (await approveResponse.json()) as {
    agent?: { id?: string };
    firstRun?: { status?: string };
  };

  assert.equal(approveResponse.status, 201);
  assert.ok(approveBody.agent?.id);
  assert.equal(approveBody.firstRun?.status, "success");
  assert.ok(loadStore().agents.some((agent) => agent.id === approveBody.agent?.id));

  const agentPublishStateResponse = await app.request(
    `/api/app/builder/publish/state?agentId=${approveBody.agent?.id}`,
    {
      headers,
    },
  );
  const agentPublishState = (await agentPublishStateResponse.json()) as {
    agentId?: string;
    canPublish?: boolean;
  };

  assert.equal(agentPublishStateResponse.status, 200);
  assert.equal(agentPublishState.agentId, approveBody.agent?.id);
  assert.equal(agentPublishState.canPublish, true);

  const agentPublishResponse = await app.request("/api/app/builder/publishes", {
    method: "POST",
    headers,
    body: JSON.stringify({
      agentId: approveBody.agent?.id,
      target: "agent",
      visibility: "private",
    }),
  });
  const agentPublish = (await agentPublishResponse.json()) as {
    published?: boolean;
    publishId?: string;
    state?: { agentId?: string; publishedUrl?: string; status?: string };
  };

  assert.equal(agentPublishResponse.status, 201);
  assert.equal(agentPublish.published, true);
  assert.ok(agentPublish.publishId);
  assert.equal(agentPublish.state?.agentId, approveBody.agent?.id);
  assert.equal(agentPublish.state?.status, "published");
  assert.match(agentPublish.state?.publishedUrl ?? "", /localhost:8484/);

  const persistedAgentStateResponse = await app.request(
    `/api/app/builder/publish/state?agentId=${approveBody.agent?.id}`,
    {
      headers,
    },
  );
  const persistedAgentState = (await persistedAgentStateResponse.json()) as {
    agentId?: string;
    currentPublishId?: string;
    publishedUrl?: string;
    status?: string;
    history?: unknown[];
  };

  assert.equal(persistedAgentStateResponse.status, 200);
  assert.equal(persistedAgentState.agentId, approveBody.agent?.id);
  assert.equal(persistedAgentState.currentPublishId, agentPublish.publishId);
  assert.equal(persistedAgentState.status, "published");
  assert.equal(persistedAgentState.publishedUrl, agentPublish.state?.publishedUrl);
  assert.ok((persistedAgentState.history?.length ?? 0) >= 1);
});

test("builder app draft can be generated and applied with smoke metadata", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const headers = { ...authHeaders(alpha.cookieValue), "Content-Type": "application/json" };

  const draftResponse = await app.request("/api/app/builder/app-draft", {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt:
        "Build a public booking app with services, appointment slots, staff calendars, and admin controls.",
    }),
  });
  const draftBody = (await draftResponse.json()) as {
    draft?: {
      intent?: string;
      app?: {
        name?: string;
        slug?: string;
        pages?: Array<{ route: string; access: string; components: string[] }>;
        dataSchema?: Array<{ name: string }>;
        apiRoutes?: Array<{
          path: string;
          access: string;
          authRequired: boolean;
          requiredRole?: string;
        }>;
      };
      smokeBuildStatus?: { status?: string; checks?: unknown[]; blockers?: string[] };
    };
  };

  assert.equal(draftResponse.status, 200);
  assert.equal(draftBody.draft?.intent, "booking");
  assert.ok(draftBody.draft?.app?.slug);
  assert.ok(
    draftBody.draft?.app?.pages?.some(
      (page) => page.route === "/book" && page.access === "public" && page.components.length > 0,
    ),
  );
  assert.ok(draftBody.draft?.app?.dataSchema?.some((entity) => entity.name === "appointment"));
  assert.ok(
    draftBody.draft?.app?.apiRoutes?.some(
      (route) =>
        route.path.includes("/api/app/generated/") &&
        route.path.includes("/appointments") &&
        route.authRequired,
    ),
  );
  assert.ok(
    draftBody.draft?.app?.apiRoutes?.some(
      (route) =>
        route.path.includes("/services") &&
        route.access === "admin" &&
        route.authRequired &&
        route.requiredRole === "admin",
    ),
  );
  assert.equal(draftBody.draft?.smokeBuildStatus?.status, "pending");
  assert.ok((draftBody.draft?.smokeBuildStatus?.checks?.length ?? 0) > 0);
  assert.deepEqual(draftBody.draft?.smokeBuildStatus?.blockers, []);

  const applyResponse = await app.request("/api/app/builder/app-draft/apply", {
    method: "POST",
    headers,
    body: JSON.stringify({ draft: draftBody.draft, runSmoke: true }),
  });
  const applyBody = (await applyResponse.json()) as {
    created?: boolean;
    applied?: boolean;
    app?: { id?: string; status?: string; previewUrl?: string };
    checkpoint?: { id?: string; appId?: string };
    previewUrl?: string;
    smokeBuild?: { status?: string; checks?: unknown[] };
  };

  assert.equal(applyResponse.status, 201);
  assert.equal(applyBody.created, true);
  assert.equal(applyBody.applied, true);
  assert.equal(applyBody.app?.status, "built");
  assert.match(applyBody.app?.previewUrl ?? "", /\/builder\/preview\/alpha\//);
  assert.equal(applyBody.previewUrl, applyBody.app?.previewUrl);
  assert.ok(applyBody.checkpoint?.id);
  assert.equal(applyBody.smokeBuild?.status, "pass");
  assert.ok((applyBody.smokeBuild?.checks?.length ?? 0) > 0);
  assert.ok(
    loadStore().generatedApps?.some(
      (entry) => entry.id === applyBody.app?.id && entry.checkpointId === applyBody.checkpoint?.id,
    ),
  );
});

test("builder app-draft/apply stores generated source files for the current checkpoint", async () => {
  await withGeneratedAppWorkspaceRoot(async (rootPath) => {
    resetStoreForTests();
    const app = createTestApp();
    const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
    const headers = { ...authHeaders(alpha.cookieValue), "Content-Type": "application/json" };

    const draftResponse = await app.request("/api/app/builder/app-draft", {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt:
          "Build a public booking app with service selection, appointment slots, and staff scheduling.",
      }),
    });
    const { draft } = (await draftResponse.json()) as { draft: Record<string, unknown> };
    const applyResponse = await app.request("/api/app/builder/app-draft/apply", {
      method: "POST",
      headers,
      body: JSON.stringify({ draft, runSmoke: true }),
    });
    const applied = (await applyResponse.json()) as {
      app?: { id?: string; slug?: string; previewUrl?: string };
      checkpoint?: { id?: string };
      sourceFiles?: Array<{ path: string; role: string; sha256: string }>;
      artifact?: { entrypoint?: string; files?: unknown[] };
      workspace?: {
        id?: string;
        slug?: string;
        path?: string;
        checkpointPath?: string;
        manifest?: {
          path?: string;
          fileCount?: number;
          entrypoint?: string;
          checkpointId?: string;
        };
      };
    };

    assert.equal(applyResponse.status, 201);
    assert.ok(applied.app?.id);
    assert.ok(applied.checkpoint?.id);
    assert.match(
      applied.app?.previewUrl ?? "",
      new RegExp(`/builder/preview/alpha/${applied.app.id}$`),
    );
    assert.equal(applied.artifact?.entrypoint, "index.html");
    assert.ok(
      applied.sourceFiles?.some(
        (file) => file.path === "index.html" && file.role === "entrypoint" && file.sha256,
      ),
    );
    assert.ok(
      applied.sourceFiles?.some((file) => file.path === "src/App.tsx" && file.role === "source"),
    );

    assert.equal(applied.workspace?.id, "alpha");
    assert.equal(applied.workspace?.slug, "alpha-workspace");
    assert.ok(applied.workspace?.path);
    assert.ok(applied.workspace?.checkpointPath);
    assert.ok(applied.workspace?.manifest?.path);
    assert.equal(applied.workspace.manifest.entrypoint, "index.html");
    assert.equal(applied.workspace.manifest.checkpointId, applied.checkpoint.id);
    assertPathInside(rootPath, applied.workspace.path);
    assertPathInside(applied.workspace.path, applied.workspace.checkpointPath);
    assertPathInside(applied.workspace.checkpointPath, applied.workspace.manifest.path);
    assert.ok(existsSync(join(applied.workspace.checkpointPath, "index.html")));
    assert.ok(existsSync(join(applied.workspace.checkpointPath, "src", "App.tsx")));
    const manifest = JSON.parse(readFileSync(applied.workspace.manifest.path, "utf8")) as {
      workspace?: { id?: string; slug?: string };
      app?: { id?: string };
      checkpoint?: { id?: string };
      files?: unknown[];
    };
    assert.equal(manifest.workspace?.id, "alpha");
    assert.equal(manifest.workspace?.slug, "alpha-workspace");
    assert.equal(manifest.app?.id, applied.app.id);
    assert.equal(manifest.checkpoint?.id, applied.checkpoint.id);
    assert.equal(manifest.files?.length, applied.workspace.manifest.fileCount);

    const stored = loadStore().generatedApps?.find((entry) => entry.id === applied.app?.id) as
      | {
          sourceFiles?: Array<{ path: string }>;
          checkpoints?: Array<{ id: string; sourceFiles?: Array<{ path: string }> }>;
        }
      | undefined;
    assert.ok(stored);
    const currentCheckpoint = stored.checkpoints?.find(
      (checkpoint) => checkpoint.id === applied.checkpoint?.id,
    );
    assert.ok(currentCheckpoint?.sourceFiles?.some((file) => file.path === "src/App.tsx"));
    assert.ok(stored.sourceFiles?.some((file) => file.path === "index.html"));
  });
});

test("generated app source routes are workspace-scoped", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const headers = { ...authHeaders(alpha.cookieValue), "Content-Type": "application/json" };

  const draftResponse = await app.request("/api/app/builder/app-draft", {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt: "Build a CRM app for accounts, contacts, deals, and renewal notes.",
    }),
  });
  const { draft } = (await draftResponse.json()) as { draft: Record<string, unknown> };
  const applyResponse = await app.request("/api/app/builder/app-draft/apply", {
    method: "POST",
    headers,
    body: JSON.stringify({ draft, runSmoke: true }),
  });
  const applied = (await applyResponse.json()) as {
    app: { id: string };
    checkpoint: { id: string };
  };
  assert.equal(applyResponse.status, 201);

  mutateStore((data) => {
    data.generatedApps ??= [];
    const betaApp = {
      id: "gapp_beta_source_route_test",
      workspaceId: "beta",
      slug: "beta-secret-source",
      name: "Beta Secret Source",
      description: "Private beta app",
      prompt: "Build private beta source app.",
      templateId: "crm",
      status: "built",
      draft: {
        prompt: "secret",
        intent: "crm",
        summary: "secret",
        app: { slug: "beta-secret-source", name: "Beta Secret Source" },
      },
      checkpointId: "gapp_ckpt_beta_source_route_test",
      sourceFiles: [
        {
          path: "index.html",
          content: "beta secret artifact",
          contentType: "text/html; charset=utf-8",
          size: 20,
          sha256: "beta-secret",
          role: "entrypoint",
        },
      ],
      createdByUserId: "user_beta",
      createdAt: "2026-05-02T11:00:00.000Z",
      updatedAt: "2026-05-02T11:00:00.000Z",
    } satisfies GeneratedAppRecord & {
      sourceFiles: Array<{
        path: string;
        content: string;
        contentType: string;
        size: number;
        sha256: string;
        role: "entrypoint";
      }>;
    };
    data.generatedApps.push(betaApp);
  });

  const sourceResponse = await app.request(
    `/api/app/generated-apps/${applied.app.id}/source?checkpointId=${applied.checkpoint.id}`,
    {
      headers: authHeaders(alpha.cookieValue),
    },
  );
  const sourceBody = (await sourceResponse.json()) as {
    app?: { id?: string };
    checkpoint?: { id?: string };
    workspace?: {
      id?: string;
      slug?: string;
      path?: string;
      manifest?: { path?: string; checkpointId?: string };
    };
    files?: Array<{ path?: string; content?: string }>;
  };

  assert.equal(sourceResponse.status, 200);
  assert.equal(sourceBody.app?.id, applied.app.id);
  assert.equal(sourceBody.checkpoint?.id, applied.checkpoint.id);
  assert.equal(sourceBody.workspace?.id, "alpha");
  assert.equal(sourceBody.workspace?.slug, "alpha-workspace");
  assert.ok(sourceBody.workspace?.path?.includes("alpha-workspace"));
  assert.equal(sourceBody.workspace?.manifest?.checkpointId, applied.checkpoint.id);
  assert.ok(
    sourceBody.files?.some(
      (file) => file.path === "index.html" && file.content?.includes("generated-app-data"),
    ),
  );
  assert.equal(JSON.stringify(sourceBody).includes("beta secret artifact"), false);

  const planResponse = await app.request(
    `/api/app/generated-apps/${applied.app.id}/package-plan?checkpointId=${applied.checkpoint.id}`,
    { headers: authHeaders(alpha.cookieValue) },
  );
  const planBody = (await planResponse.json()) as {
    checkpoint?: { id?: string };
    plan?: { status?: string; executionPolicy?: { executed?: boolean } };
  };
  assert.equal(planResponse.status, 200);
  assert.equal(planBody.checkpoint?.id, applied.checkpoint.id);
  assert.equal(planBody.plan?.status, "ready");
  assert.equal(planBody.plan?.executionPolicy?.executed, false);

  const exportResponse = await app.request(
    `/api/app/generated-apps/${applied.app.id}/export?checkpointId=${applied.checkpoint.id}`,
    { headers: authHeaders(alpha.cookieValue) },
  );
  assert.equal(exportResponse.status, 200);
  assert.equal(exportResponse.headers.get("content-type"), "application/zip");
  assert.match(exportResponse.headers.get("content-disposition") ?? "", /\.zip"/);
  assert.equal(exportResponse.headers.get("x-packetagent-package-plan"), "ready");
  const archive = unzipSync(new Uint8Array(await exportResponse.arrayBuffer()));
  const archivePaths = Object.keys(archive);
  assert.ok(archivePaths.some((path) => path.endsWith("/src/App.tsx")));
  assert.ok(archivePaths.some((path) => path.endsWith("/.packetagent/package-install-plan.json")));
  const exportReadmePath = archivePaths.find((path) => path.endsWith("/PACKETAGENT_EXPORT.md"));
  assert.ok(exportReadmePath);
  assert.match(strFromU8(archive[exportReadmePath]!), /did not run a package installation/i);

  const betaResponse = await app.request(
    "/api/app/generated-apps/gapp_beta_source_route_test/source",
    {
      headers: authHeaders(alpha.cookieValue),
    },
  );
  const betaBody = (await betaResponse.json()) as { error?: string };
  assert.equal(betaResponse.status, 404);
  assert.equal(betaBody.error, "generated app not found");

  const betaExportResponse = await app.request(
    "/api/app/generated-apps/gapp_beta_source_route_test/export",
    { headers: authHeaders(alpha.cookieValue) },
  );
  assert.equal(betaExportResponse.status, 404);
});

test("generated app runtime API persists records through per-app SQLite", async () => {
  resetStoreForTests();
  const previousRuntimeRoot = process.env.PACKETAGENT_GENERATED_APP_RUNTIME_DIR;
  const previousLegacyTemplates = process.env.PACKETAGENT_LEGACY_TEMPLATES;
  const runtimeRoot = mkdtempSync(join(tmpdir(), "packetagent-generated-runtime-"));
  process.env.PACKETAGENT_GENERATED_APP_RUNTIME_DIR = runtimeRoot;
  process.env.PACKETAGENT_LEGACY_TEMPLATES = "1";
  try {
    const app = createTestApp();
    const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
    const headers = { ...authHeaders(alpha.cookieValue), "Content-Type": "application/json" };

    const draftResponse = await app.request("/api/app/builder/app-draft", {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "Build a CRM app for accounts and deals." }),
    });
    const draftBody = (await draftResponse.json()) as { draft?: unknown };
    const applyResponse = await app.request("/api/app/builder/app-draft/apply", {
      method: "POST",
      headers,
      body: JSON.stringify({ draft: draftBody.draft }),
    });
    const applied = (await applyResponse.json()) as { app: { id: string } };
    const previewSession = await openGeneratedPreviewSession(app, {
      appId: applied.app.id,
      sessionCookie: alpha.cookieValue,
      scope: "interact",
    });
    const runtimeHeaders = {
      Cookie: previewSession.cookie,
      "Content-Type": "application/json",
    };

    const idleHealthResponse = await app.request(
      `/api/app/generated-apps/${applied.app.id}/runtime/health`,
      { headers },
    );
    const idleHealth = (await idleHealthResponse.json()) as {
      health?: { status?: string; processCount?: number; metrics?: { requests?: number } };
    };
    assert.equal(idleHealthResponse.status, 200);
    assert.equal(idleHealthResponse.headers.get("cache-control"), "private, no-store");
    assert.equal(idleHealth.health?.status, "idle");
    assert.equal(idleHealth.health?.processCount, 0);
    assert.equal(idleHealth.health?.metrics?.requests, 0);

    const firstListResponse = await app.request(
      generatedPreviewRequestUrl(`/api/app/generated-apps/${applied.app.id}/api/account`),
      { headers: runtimeHeaders },
    );
    const firstList = (await firstListResponse.json()) as Array<{ id?: string; name?: string }>;
    assert.equal(firstListResponse.status, 200);
    assert.equal(
      firstListResponse.headers.get("x-packetagent-generated-app-runtime"),
      "server-sqlite-process",
    );
    assert.ok(firstListResponse.headers.get("x-packetagent-generated-app-runtime-pid"));
    assert.ok(firstList.some((record) => record.name === "Account 1"));

    const createResponse = await app.request(
      generatedPreviewRequestUrl(`/api/app/generated-apps/${applied.app.id}/api/account`),
      {
        method: "POST",
        headers: runtimeHeaders,
        body: JSON.stringify({
          name: "Shared Farm Co",
          ownerId: "user_test",
          status: "active",
          createdAt: "2026-05-18T12:00:00.000Z",
        }),
      },
    );
    const created = (await createResponse.json()) as { id?: string; name?: string };
    assert.equal(createResponse.status, 201);
    assert.equal(created.name, "Shared Farm Co");

    const secondListResponse = await app.request(
      generatedPreviewRequestUrl(`/api/app/generated-apps/${applied.app.id}/api/account`),
      { headers: runtimeHeaders },
    );
    const secondList = (await secondListResponse.json()) as Array<{ id?: string; name?: string }>;
    assert.equal(secondListResponse.status, 200);
    assert.ok(
      secondList.some((record) => record.id === created.id && record.name === "Shared Farm Co"),
    );

    const healthResponse = await app.request(
      `/api/app/generated-apps/${applied.app.id}/runtime/health`,
      { headers },
    );
    const health = (await healthResponse.json()) as {
      scope?: { workspaceId?: string; appId?: string };
      health?: {
        status?: string;
        schemaChangePolicy?: string;
        processCount?: number;
        maxProcesses?: number;
        metrics?: { requests?: number; successfulRequests?: number; workerStarts?: number };
        processes?: Array<{ appId?: string; state?: string; pid?: number }>;
        recentCrashes?: unknown[];
      };
    };
    assert.equal(healthResponse.status, 200);
    assert.equal(health.scope?.workspaceId, "alpha");
    assert.equal(health.scope?.appId, applied.app.id);
    assert.equal(health.health?.status, "healthy");
    assert.equal(health.health?.schemaChangePolicy, "reset-and-reseed");
    assert.equal(health.health?.processCount, 1);
    assert.ok((health.health?.maxProcesses ?? 0) >= 1);
    assert.equal(health.health?.metrics?.requests, 3);
    assert.equal(health.health?.metrics?.successfulRequests, 3);
    assert.equal(health.health?.metrics?.workerStarts, 1);
    assert.equal(health.health?.processes?.[0]?.state, "ready");
    assert.ok(health.health?.processes?.[0]?.pid);
    assert.deepEqual(health.health?.recentCrashes, []);

    const workspaceHealthResponse = await app.request("/api/app/generated-app-runtime/health", {
      headers,
    });
    const workspaceHealth = (await workspaceHealthResponse.json()) as {
      health?: { metrics?: { requests?: number }; processes?: Array<{ appId?: string }> };
    };
    assert.equal(workspaceHealthResponse.status, 200);
    assert.equal(workspaceHealth.health?.metrics?.requests, 3);
    assert.deepEqual(
      workspaceHealth.health?.processes?.map((process) => process.appId),
      [applied.app.id],
    );
  } finally {
    await shutdownDefaultGeneratedAppRuntimeProcessPool();
    if (previousRuntimeRoot === undefined) delete process.env.PACKETAGENT_GENERATED_APP_RUNTIME_DIR;
    else process.env.PACKETAGENT_GENERATED_APP_RUNTIME_DIR = previousRuntimeRoot;
    if (previousLegacyTemplates === undefined) delete process.env.PACKETAGENT_LEGACY_TEMPLATES;
    else process.env.PACKETAGENT_LEGACY_TEMPLATES = previousLegacyTemplates;
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("builder preview refresh rewrites generated app workspace files", async () => {
  await withGeneratedAppWorkspaceRoot(async (rootPath) => {
    resetStoreForTests();
    const app = createTestApp();
    const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
    const headers = { ...authHeaders(alpha.cookieValue), "Content-Type": "application/json" };

    const draftResponse = await app.request("/api/app/builder/app-draft", {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "Build a project dashboard app for tasks, risks, milestones, and approvals.",
      }),
    });
    const { draft } = (await draftResponse.json()) as { draft: Record<string, unknown> };
    const applyResponse = await app.request("/api/app/builder/app-draft/apply", {
      method: "POST",
      headers,
      body: JSON.stringify({ draft, runSmoke: false }),
    });
    const applied = (await applyResponse.json()) as {
      app?: { id?: string };
      workspace?: { checkpointPath?: string };
    };
    assert.equal(applyResponse.status, 201);
    assert.ok(applied.app?.id);
    assert.ok(applied.workspace?.checkpointPath);
    rmSync(applied.workspace.checkpointPath, { recursive: true, force: true });
    assert.equal(existsSync(applied.workspace.checkpointPath), false);

    const refreshResponse = await app.request("/api/app/builder/preview/refresh", {
      method: "POST",
      headers,
      body: JSON.stringify({ appId: applied.app.id, runSmoke: false }),
    });
    const refreshed = (await refreshResponse.json()) as {
      workspace?: {
        id?: string;
        slug?: string;
        path?: string;
        checkpointPath?: string;
        manifest?: { path?: string; fileCount?: number; entrypoint?: string };
      };
      sourceFiles?: Array<{ path: string }>;
    };

    assert.equal(refreshResponse.status, 200);
    assert.equal(refreshed.workspace?.id, "alpha");
    assert.equal(refreshed.workspace?.slug, "alpha-workspace");
    assert.ok(refreshed.workspace?.path);
    assert.ok(refreshed.workspace?.checkpointPath);
    assert.ok(refreshed.workspace?.manifest?.path);
    assertPathInside(rootPath, refreshed.workspace.path);
    assertPathInside(refreshed.workspace.path, refreshed.workspace.checkpointPath);
    assert.equal(refreshed.workspace.manifest.entrypoint, "index.html");
    assert.ok((refreshed.workspace.manifest.fileCount ?? 0) >= 1);
    assert.ok(existsSync(join(refreshed.workspace.checkpointPath, "index.html")));
    assert.ok(existsSync(refreshed.workspace.manifest.path));
    assert.ok(refreshed.sourceFiles?.some((file) => file.path === "src/App.tsx"));
  });
});

test("generated app preview route resolves by actual app id or slug", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const headers = { ...authHeaders(alpha.cookieValue), "Content-Type": "application/json" };

  const draftResponse = await app.request("/api/app/builder/app-draft", {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt:
        "Build a task tracker app for launch projects, assignees, comments, and review queues.",
    }),
  });
  const { draft } = (await draftResponse.json()) as { draft: Record<string, unknown> };
  const applyResponse = await app.request("/api/app/builder/app-draft/apply", {
    method: "POST",
    headers,
    body: JSON.stringify({ draft, runSmoke: true }),
  });
  const applied = (await applyResponse.json()) as {
    app: { id: string; slug: string; previewUrl?: string };
  };

  assert.equal(applyResponse.status, 201);
  assert.match(
    applied.app.previewUrl ?? "",
    new RegExp(`/builder/preview/alpha/${applied.app.id}(?:/|$)`),
  );

  mutateStore((data) => {
    const generated = data.generatedApps?.find((entry) => entry.id === applied.app.id);
    assert.ok(generated);
    const asset = {
      path: "assets/preview.css",
      content: "body { color: rgb(12, 34, 56); }",
      contentType: "text/css; charset=utf-8",
      size: 35,
      sha256: "preview-css-test",
      role: "source" as const,
    };
    generated.runtimeArtifact?.files.push(asset);
    generated.sourceFiles?.push(asset);
    const checkpoint = generated.checkpoints?.find((entry) => entry.id === generated.checkpointId);
    checkpoint?.runtimeArtifact?.files.push(asset);
    checkpoint?.sourceFiles?.push(asset);
  });
  const previewSession = await openGeneratedPreviewSession(app, {
    appId: applied.app.id,
    sessionCookie: alpha.cookieValue,
    scope: "interact",
  });
  const previewHeaders = { Cookie: previewSession.cookie };

  const byIdResponse = await app.request(
    generatedPreviewRequestUrl(`/api/app/generated-apps/${applied.app.id}/preview`),
    { headers: previewHeaders },
  );
  const byIdHtml = await byIdResponse.text();
  assert.equal(byIdResponse.status, 200);
  assert.match(byIdResponse.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(byIdResponse.headers.get("x-packetagent-generated-app-id"), applied.app.id);
  assert.equal(byIdResponse.headers.get("x-packetagent-generated-app-runtime"), "static");
  assert.equal(byIdResponse.headers.get("x-packetagent-generated-app-live"), "false");
  assert.match(
    byIdResponse.headers.get("content-security-policy") ?? "",
    /frame-ancestors http:\/\/localhost/,
  );
  assert.match(byIdHtml, new RegExp(`data-app-id="${applied.app.id}"`));
  assert.match(byIdHtml, /packetagent\.preview\.v1/);

  const sourceFileResponse = await app.request(
    generatedPreviewRequestUrl(`/api/app/generated-apps/${applied.app.id}/preview/src/App.tsx`),
    {
      headers: previewHeaders,
    },
  );
  const sourceFileBody = await sourceFileResponse.text();
  assert.equal(sourceFileResponse.status, 200);
  // TSX is transformed to JS at serve time so browsers accept it as a module script.
  assert.match(sourceFileResponse.headers.get("content-type") ?? "", /application\/javascript/);
  assert.match(sourceFileBody, /function GeneratedApp/);

  const assetResponse = await app.request(
    generatedPreviewRequestUrl(
      `/api/app/generated-apps/${applied.app.id}/preview/assets/preview.css`,
    ),
    {
      headers: previewHeaders,
    },
  );
  const assetBody = await assetResponse.text();
  assert.equal(assetResponse.status, 200);
  assert.match(assetResponse.headers.get("content-type") ?? "", /text\/css/);
  assert.equal(assetBody, "body { color: rgb(12, 34, 56); }");

  const readinessResponse = await app.request(
    generatedPreviewRequestUrl(`/api/app/generated-apps/${applied.app.id}/preview?format=json`),
    {
      headers: previewHeaders,
    },
  );
  const readinessBody = (await readinessResponse.json()) as {
    preview?: {
      path?: string;
      runtime?: {
        mode?: string;
        live?: boolean;
        servedBy?: string;
        process?: { status?: string; command?: string };
      };
    };
    artifact?: { files?: Array<{ path?: string }> };
  };
  assert.equal(readinessResponse.status, 200);
  assert.equal(readinessBody.preview?.path, "index.html");
  assert.equal(readinessBody.preview?.runtime?.mode, "static");
  assert.equal(readinessBody.preview?.runtime?.live, false);
  assert.equal(readinessBody.preview?.runtime?.servedBy, "packetagent-static-workspace");
  assert.equal(readinessBody.preview?.runtime?.process?.status, "not_started");
  assert.match(readinessBody.preview?.runtime?.process?.command ?? "", /npm run dev/);
  assert.ok(readinessBody.artifact?.files?.some((file) => file.path === "src/App.tsx"));

  const slugPreviewSession = await openGeneratedPreviewSession(app, {
    appId: applied.app.slug,
    sessionCookie: alpha.cookieValue,
    scope: "read",
  });
  const bySlugResponse = await app.request(
    generatedPreviewRequestUrl(`/api/app/generated-apps/${applied.app.id}/preview`),
    { headers: { Cookie: slugPreviewSession.cookie } },
  );
  const bySlugHtml = await bySlugResponse.text();
  assert.equal(bySlugResponse.status, 200);
  assert.equal(bySlugResponse.headers.get("x-packetagent-generated-app-id"), applied.app.id);
  assert.match(bySlugHtml, new RegExp(`data-app-slug="${applied.app.slug}"`));

  const publishStateResponse = await app.request(
    `/api/app/builder/publish/state?appId=${applied.app.slug}`,
    {
      headers: authHeaders(alpha.cookieValue),
    },
  );
  const publishState = (await publishStateResponse.json()) as { appId?: string };
  assert.equal(publishStateResponse.status, 200);
  assert.equal(publishState.appId, applied.app.id);
});

test("builder app-draft/apply fails closed when required sandbox validation is blocked", async () => {
  setGeneratedAppFileTreeValidatorForTests(async () => ({
    ok: false,
    source: "blocked",
    errors: [
      {
        file: "<sandbox>",
        message: "Docker unavailable",
        severity: "error",
        phase: "typecheck",
      },
    ],
    warnings: [],
    durationMs: 3,
    phases: { typecheck: "skipped", build: "skipped" },
  }));
  try {
    resetStoreForTests();
    const app = createTestApp();
    const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
    const headers = { ...authHeaders(alpha.cookieValue), "Content-Type": "application/json" };

    const draftResponse = await app.request("/api/app/builder/app-draft", {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "Build a public booking app." }),
    });
    const draftBody = (await draftResponse.json()) as { draft?: unknown };

    const applyResponse = await app.request("/api/app/builder/app-draft/apply", {
      method: "POST",
      headers,
      body: JSON.stringify({ draft: draftBody.draft, runSmoke: true }),
    });
    const applyBody = (await applyResponse.json()) as {
      smokeBuild?: {
        status?: string;
        message?: string;
        blockers?: string[];
      };
    };

    assert.equal(applyResponse.status, 201);
    assert.equal(applyBody.smokeBuild?.status, "fail");
    assert.match(applyBody.smokeBuild?.message ?? "", /blocked/);
    assert.ok(
      applyBody.smokeBuild?.blockers?.some((blocker) => blocker.includes("Docker unavailable")),
    );
  } finally {
    setGeneratedAppFileTreeValidatorForTests(passingGeneratedAppValidator);
  }
});

test("builder app iteration can generate a diff, apply it, and rollback checkpoints", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const headers = { ...authHeaders(alpha.cookieValue), "Content-Type": "application/json" };

  const draftResponse = await app.request("/api/app/builder/app-draft", {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt:
        "Build a booking app with public booking, services, appointment slots, and admin controls.",
    }),
  });
  const { draft } = (await draftResponse.json()) as { draft: Record<string, unknown> };
  const applyResponse = await app.request("/api/app/builder/app-draft/apply", {
    method: "POST",
    headers,
    body: JSON.stringify({ draft, runSmoke: true }),
  });
  const applied = (await applyResponse.json()) as {
    app: { id: string; previewUrl?: string };
    checkpoint: { id: string };
    draft: Record<string, unknown>;
  };
  const initialRecord = loadStore().generatedApps?.find((entry) => entry.id === applied.app.id);
  const initialSourceSha = initialRecord?.checkpoints
    ?.find((checkpoint) => checkpoint.id === applied.checkpoint.id)
    ?.sourceFiles?.find((file) => file.path === "src/App.tsx")?.sha256;
  assert.ok(initialSourceSha);

  const iterationResponse = await app.request("/api/app/builder/app-iteration", {
    method: "POST",
    headers,
    body: JSON.stringify({
      appId: applied.app.id,
      checkpointId: applied.checkpoint.id,
      draft: applied.draft,
      target: { id: "page:/book", kind: "page", label: "Booking", path: "/book" },
      prompt:
        "Add clearer confirmation copy to the booking page after a customer picks an appointment slot.",
    }),
  });
  const iteration = (await iterationResponse.json()) as {
    id?: string;
    status?: string;
    files?: Array<{
      diff: string;
      path: string;
      source?: string;
      beforeSha256?: string;
      afterSha256?: string;
    }>;
    sourceDiffFiles?: Array<{
      diff: string;
      path: string;
      source?: string;
      beforeSha256?: string;
      afterSha256?: string;
    }>;
    sourceFiles?: Array<{ path: string; sha256: string }>;
    fileTree?: Array<{ path: string; content: string }>;
    draftSource?: string;
    logs?: Array<{ message?: string }>;
    draft?: { app?: { pages?: Array<{ route: string; purpose: string; actions: string[] }> } };
    preview?: { status?: string };
    rollback?: { checkpointId?: string };
  };

  assert.equal(iterationResponse.status, 200);
  assert.equal(iteration.status, "generated");
  assert.ok(iteration.id);
  assert.ok(
    iteration.files?.some(
      (file) => file.path.includes("page") && file.diff.includes("confirmation copy"),
    ),
  );
  assert.ok(
    iteration.files?.some(
      (file) =>
        file.path === "src/App.tsx" &&
        file.source === "runtime" &&
        file.beforeSha256 !== file.afterSha256,
    ),
  );
  assert.ok(
    iteration.sourceDiffFiles?.some(
      (file) => file.path === "src/App.tsx" && file.diff.includes("sha256:"),
    ),
  );
  assert.ok(
    iteration.sourceFiles?.some(
      (file) => file.path === "src/App.tsx" && file.sha256 !== initialSourceSha,
    ),
  );
  assert.equal(iteration.draftSource, "llm-filetree");
  assert.ok(
    iteration.fileTree?.some((file) => file.path === "src/App.tsx" && file.content.length > 0),
  );
  assert.ok(iteration.logs?.some((entry) => entry.message?.includes("canonical file-tree path")));
  assert.ok(
    iteration.draft?.app?.pages?.some(
      (page) => page.route === "/book" && page.purpose.includes("Iteration request"),
    ),
  );
  assert.equal(iteration.preview?.status, "pending");
  assert.ok(iteration.rollback?.checkpointId);

  const applyIterationResponse = await app.request("/api/app/builder/app-iteration/apply", {
    method: "POST",
    headers,
    body: JSON.stringify({
      appId: applied.app.id,
      checkpointId: applied.checkpoint.id,
      diffId: iteration.id,
      target: { id: "page:/book", kind: "page", label: "Booking", path: "/book" },
      files: iteration.files,
      diff: iteration,
      runSmoke: true,
    }),
  });
  const appliedIteration = (await applyIterationResponse.json()) as {
    applied?: boolean;
    checkpoint?: { id?: string };
    previewUrl?: string;
    diff?: {
      status?: string;
      draft?: unknown;
      sourceDiffFiles?: Array<{ path: string; beforeSha256?: string; afterSha256?: string }>;
    };
    sourceDiffFiles?: Array<{ path: string; beforeSha256?: string; afterSha256?: string }>;
    sourceFiles?: Array<{ path: string; sha256: string }>;
    draftSource?: string;
    smoke?: { status?: string };
    workspace?: {
      path?: string;
      checkpointPath?: string;
      manifest?: { path?: string; checkpointId?: string };
    };
  };

  assert.equal(applyIterationResponse.status, 201);
  assert.equal(appliedIteration.applied, true);
  assert.equal(appliedIteration.diff?.status, "applied");
  assert.equal(appliedIteration.smoke?.status, "pass");
  assert.equal(appliedIteration.draftSource, "llm-filetree");
  assert.match(appliedIteration.previewUrl ?? "", /\/builder\/preview\/alpha\//);
  assert.notEqual(appliedIteration.checkpoint?.id, applied.checkpoint.id);
  assert.ok(
    appliedIteration.sourceDiffFiles?.some(
      (file) =>
        file.path === "src/App.tsx" &&
        file.beforeSha256 === initialSourceSha &&
        file.afterSha256 !== initialSourceSha,
    ),
  );
  assert.ok(appliedIteration.diff?.sourceDiffFiles?.some((file) => file.path === "src/App.tsx"));
  assert.ok(appliedIteration.workspace?.path?.includes("alpha-workspace"));
  assert.equal(appliedIteration.workspace?.manifest?.checkpointId, appliedIteration.checkpoint?.id);
  assert.ok(appliedIteration.workspace?.checkpointPath);
  assert.ok(existsSync(join(appliedIteration.workspace.checkpointPath, "src", "App.tsx")));
  const convertedRecord = loadStore().generatedApps?.find((entry) => entry.id === applied.app.id);
  const convertedCheckpoint = convertedRecord?.checkpoints?.find(
    (checkpoint) => checkpoint.id === appliedIteration.checkpoint?.id,
  );
  assert.equal(convertedCheckpoint?.codegenSource, "llm-filetree");
  assert.ok(appliedIteration.workspace?.manifest?.path);
  assert.ok(existsSync(appliedIteration.workspace.manifest.path));

  const iteratedRecord = loadStore().generatedApps?.find((entry) => entry.id === applied.app.id);
  const iteratedSourceSha = iteratedRecord?.checkpoints
    ?.find((checkpoint) => checkpoint.id === appliedIteration.checkpoint?.id)
    ?.sourceFiles?.find((file) => file.path === "src/App.tsx")?.sha256;
  assert.ok(iteratedSourceSha);
  assert.notEqual(iteratedSourceSha, initialSourceSha);

  const checkpointResponse = await app.request(
    `/api/app/builder/checkpoints?appId=${applied.app.id}`,
    {
      headers,
    },
  );
  const checkpointBody = (await checkpointResponse.json()) as {
    checkpoints?: Array<{ id: string; source: string }>;
  };

  assert.equal(checkpointResponse.status, 200);
  assert.ok(
    checkpointBody.checkpoints?.some((checkpoint) => checkpoint.id === applied.checkpoint.id),
  );
  assert.ok(
    checkpointBody.checkpoints?.some(
      (checkpoint) =>
        checkpoint.id === appliedIteration.checkpoint?.id && checkpoint.source === "iteration",
    ),
  );

  const rollbackResponse = await app.request(
    `/api/app/builder/checkpoints/${applied.checkpoint.id}/rollback`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ appId: applied.app.id, reason: "test rollback" }),
    },
  );
  const rollbackBody = (await rollbackResponse.json()) as {
    rolledBack?: boolean;
    checkpoint?: { id?: string };
    preview?: { message?: string };
    sourceFiles?: Array<{ path: string; sha256: string }>;
  };

  assert.equal(rollbackResponse.status, 200);
  assert.equal(rollbackBody.rolledBack, true);
  assert.ok(rollbackBody.checkpoint?.id);
  assert.ok(rollbackBody.preview?.message?.includes(applied.checkpoint.id));
  assert.ok(
    rollbackBody.sourceFiles?.some(
      (file) => file.path === "src/App.tsx" && file.sha256 === initialSourceSha,
    ),
  );

  const rolledBackRecord = loadStore().generatedApps?.find((entry) => entry.id === applied.app.id);
  const rollbackSourceSha = rolledBackRecord?.checkpoints
    ?.find((checkpoint) => checkpoint.id === rollbackBody.checkpoint?.id)
    ?.sourceFiles?.find((file) => file.path === "src/App.tsx")?.sha256;
  assert.equal(rollbackSourceSha, initialSourceSha);
  assert.notEqual(rollbackSourceSha, iteratedSourceSha);
});

test("builder canonical changes routes validate target app and expose preview, fix, and agent checkpoint contracts", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const headers = { ...authHeaders(alpha.cookieValue), "Content-Type": "application/json" };

  const draftResponse = await app.request("/api/app/builder/app-draft", {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt: "Build a CRM app for companies, contacts, opportunities, and follow-up notes.",
    }),
  });
  const { draft } = (await draftResponse.json()) as { draft: Record<string, unknown> };
  const applyResponse = await app.request("/api/app/builder/app-draft/apply", {
    method: "POST",
    headers,
    body: JSON.stringify({ draft, runSmoke: true }),
  });
  const applied = (await applyResponse.json()) as {
    app: { id: string };
    checkpoint: { id: string };
    draft: Record<string, unknown>;
  };

  const changeDraftResponse = await app.request("/api/app/builder/changes/draft", {
    method: "POST",
    headers,
    body: JSON.stringify({
      appId: applied.app.id,
      checkpointId: applied.checkpoint.id,
      draft: applied.draft,
      target: {
        id: "api:GET:/api/app/generated/crm/contacts",
        kind: "api_route",
        label: "GET contacts",
        path: "/api/app/generated/crm/contacts",
      },
      prompt:
        "Add a draft-safe GitHub issue export action without running live repository operations.",
    }),
  });
  const changeDraft = (await changeDraftResponse.json()) as {
    changeSet?: {
      id?: string;
      status?: string;
      tools?: { requestedCategories?: string[]; canProceed?: boolean };
      draft?: Record<string, unknown>;
    };
  };

  assert.equal(changeDraftResponse.status, 200);
  assert.ok(changeDraft.changeSet?.id);
  assert.equal(changeDraft.changeSet?.status, "generated");
  assert.equal(changeDraft.changeSet?.tools?.canProceed, true);
  assert.ok(changeDraft.changeSet?.tools?.requestedCategories?.includes("github"));

  const blockedDraftResponse = await app.request("/api/app/builder/changes/draft", {
    method: "POST",
    headers,
    body: JSON.stringify({
      appId: applied.app.id,
      checkpointId: applied.checkpoint.id,
      draft: applied.draft,
      target: { id: "config", kind: "config", label: "Generated app config" },
      prompt: "Create live Stripe checkout and charge customers for subscriptions.",
    }),
  });
  const blockedDraft = (await blockedDraftResponse.json()) as { changeSet?: { status?: string } };

  assert.equal(blockedDraftResponse.status, 200);
  assert.equal(blockedDraft.changeSet?.status, "blocked");

  const blockedApplyResponse = await app.request("/api/app/builder/changes/apply", {
    method: "POST",
    headers,
    body: JSON.stringify({
      appId: applied.app.id,
      checkpointId: applied.checkpoint.id,
      changeSet: blockedDraft.changeSet,
      runSmoke: true,
    }),
  });
  const blockedApplyBody = (await blockedApplyResponse.json()) as { error?: string };

  assert.equal(blockedApplyResponse.status, 409);
  assert.match(blockedApplyBody.error ?? "", /blocked change set/);

  const directDraftApplyResponse = await app.request("/api/app/builder/changes/apply", {
    method: "POST",
    headers,
    body: JSON.stringify({
      appId: applied.app.id,
      checkpointId: applied.checkpoint.id,
      draft: changeDraft.changeSet?.draft,
      runSmoke: true,
    }),
  });
  const directDraftApplyBody = (await directDraftApplyResponse.json()) as { error?: string };

  assert.equal(directDraftApplyResponse.status, 400);
  assert.match(directDraftApplyBody.error ?? "", /reviewed diff or changeSet/);

  const mismatchResponse = await app.request("/api/app/builder/changes/apply", {
    method: "POST",
    headers,
    body: JSON.stringify({
      appId: applied.app.id,
      checkpointId: applied.checkpoint.id,
      changeSet: {
        ...changeDraft.changeSet,
        draft: {
          ...(changeDraft.changeSet?.draft ?? {}),
          app: {
            ...((changeDraft.changeSet?.draft as { app?: Record<string, unknown> })?.app ?? {}),
            slug: "different-app",
          },
        },
      },
      runSmoke: true,
    }),
  });
  const mismatchBody = (await mismatchResponse.json()) as { error?: string };

  assert.equal(mismatchResponse.status, 409);
  assert.match(mismatchBody.error ?? "", /does not match/);

  const changeApplyResponse = await app.request("/api/app/builder/changes/apply", {
    method: "POST",
    headers,
    body: JSON.stringify({
      appId: applied.app.id,
      checkpointId: applied.checkpoint.id,
      changeSet: changeDraft.changeSet,
      runSmoke: true,
      refreshPreview: true,
    }),
  });
  const changeApply = (await changeApplyResponse.json()) as {
    applied?: boolean;
    changeSet?: { status?: string };
    checkpoint?: { id?: string };
  };

  assert.equal(changeApplyResponse.status, 201);
  assert.equal(changeApply.applied, true);
  assert.equal(changeApply.changeSet?.status, "applied");
  assert.ok(changeApply.checkpoint?.id);

  const refreshResponse = await app.request("/api/app/builder/preview/refresh", {
    method: "POST",
    headers,
    body: JSON.stringify({
      appId: applied.app.id,
      checkpointId: changeApply.checkpoint?.id,
      runSmoke: true,
    }),
  });
  const refreshBody = (await refreshResponse.json()) as {
    preview?: { status?: string };
    smoke?: { status?: string };
  };

  assert.equal(refreshResponse.status, 200);
  assert.equal(refreshBody.preview?.status, "ready");
  assert.equal(refreshBody.smoke?.status, "pass");

  const fixResponse = await app.request("/api/app/builder/fix-prompt", {
    method: "POST",
    headers,
    body: JSON.stringify({
      appId: applied.app.id,
      checkpointId: changeApply.checkpoint?.id,
      target: { id: "page:/", kind: "page", label: "Home", path: "/" },
      errorContext: { source: "runtime", message: "ReferenceError: contact is not defined" },
    }),
  });
  const fixBody = (await fixResponse.json()) as { prompt?: string };

  assert.equal(fixResponse.status, 200);
  assert.match(fixBody.prompt ?? "", /ReferenceError/);
  assert.match(fixBody.prompt ?? "", /Checkpoint/);

  const agentCheckpointResponse = await app.request(
    "/api/app/builder/checkpoints?agentId=agent_alpha_support",
    {
      headers,
    },
  );
  const agentCheckpointBody = (await agentCheckpointResponse.json()) as {
    checkpoints?: Array<{ agentId?: string }>;
  };

  assert.equal(agentCheckpointResponse.status, 200);
  assert.equal(agentCheckpointBody.checkpoints?.[0]?.agentId, "agent_alpha_support");
});

test("builder publish creates self-hosted history, compose export, logs, and rollback result", async (t) => {
  resetStoreForTests();
  const previousSmtpUrl = process.env.SMTP_URL;
  const previousManifestSigningKey = process.env.PACKETAGENT_PUBLISH_MANIFEST_SIGNING_KEY;
  const previousManifestSigningKeyId = process.env.PACKETAGENT_PUBLISH_MANIFEST_SIGNING_KEY_ID;
  process.env.SMTP_URL = "smtp://localhost";
  process.env.PACKETAGENT_PUBLISH_MANIFEST_SIGNING_KEY =
    "packetagent-route-test-publish-signing-key-32-bytes";
  process.env.PACKETAGENT_PUBLISH_MANIFEST_SIGNING_KEY_ID = "route-test-key";
  t.after(() => {
    if (previousSmtpUrl === undefined) delete process.env.SMTP_URL;
    else process.env.SMTP_URL = previousSmtpUrl;
    if (previousManifestSigningKey === undefined)
      delete process.env.PACKETAGENT_PUBLISH_MANIFEST_SIGNING_KEY;
    else process.env.PACKETAGENT_PUBLISH_MANIFEST_SIGNING_KEY = previousManifestSigningKey;
    if (previousManifestSigningKeyId === undefined)
      delete process.env.PACKETAGENT_PUBLISH_MANIFEST_SIGNING_KEY_ID;
    else process.env.PACKETAGENT_PUBLISH_MANIFEST_SIGNING_KEY_ID = previousManifestSigningKeyId;
  });
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const headers = { ...authHeaders(alpha.cookieValue), "Content-Type": "application/json" };

  const draftResponse = await app.request("/api/app/builder/app-draft", {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt:
        "Build a booking app with public booking, appointment slots, services, and admin controls.",
    }),
  });
  const { draft } = (await draftResponse.json()) as { draft: Record<string, unknown> };
  const applyResponse = await app.request("/api/app/builder/app-draft/apply", {
    method: "POST",
    headers,
    body: JSON.stringify({ draft, runSmoke: true }),
  });
  const applied = (await applyResponse.json()) as {
    app: { id: string };
    checkpoint: { id: string };
  };

  const firstPublishResponse = await app.request("/api/app/builder/publish", {
    method: "POST",
    headers,
    body: JSON.stringify({
      appId: applied.app.id,
      checkpointId: applied.checkpoint.id,
      visibility: "public",
      localPublishRoot: "exports\\packetagent",
      publicBaseUrl: "https://apps.example.test/",
      privateBaseUrl: "http://localhost:8484/",
    }),
  });
  const firstPublish = (await firstPublishResponse.json()) as {
    published?: boolean;
    publish?: {
      id: string;
      status: string;
      localPublishPath: string;
      workspacePath?: string;
      privateUrl?: string;
      logs: unknown[];
      manifest?: {
        fileName?: string;
        schemaVersion?: string;
        staticAssets?: { status?: string; references?: unknown[] };
        integrity?: { digest?: string; signature?: { keyId?: string } };
        entries?: Array<{ path?: string; size?: number; sha256?: string }>;
      };
    };
    validation?: {
      artifactPresence?: {
        integrity?: {
          status?: string;
          checksumVerified?: boolean;
          checkedFiles?: number;
        };
      };
    };
    dockerComposeExport?: { yaml?: string; services?: string[] };
    history?: Array<{ id?: string; workspacePath?: string; manifest?: { fileName?: string } }>;
  };

  assert.equal(firstPublishResponse.status, 201);
  assert.equal(firstPublish.published, true);
  assert.equal(firstPublish.publish?.status, "published");
  assert.match(
    firstPublish.publish?.localPublishPath ?? "",
    /^exports\/packetagent\/alpha-workspace\//,
  );
  assert.equal(firstPublish.publish?.workspacePath, firstPublish.publish?.localPublishPath);
  assert.equal(firstPublish.publish?.manifest?.fileName, "publish-artifacts.json");
  assert.equal(
    firstPublish.publish?.manifest?.schemaVersion,
    "packetagent.generated-app-artifact-manifest/v2",
  );
  assert.match(firstPublish.publish?.manifest?.integrity?.digest ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.equal(firstPublish.publish?.manifest?.integrity?.signature?.keyId, "route-test-key");
  assert.equal(firstPublish.publish?.manifest?.staticAssets?.status, "pass");
  assert.ok((firstPublish.publish?.manifest?.staticAssets?.references?.length ?? 0) >= 1);
  assert.ok(
    firstPublish.publish?.manifest?.entries?.every(
      (entry) =>
        typeof entry.size === "number" &&
        entry.size >= 0 &&
        /^[a-f0-9]{64}$/.test(entry.sha256 ?? ""),
    ),
  );
  assert.equal(firstPublish.validation?.artifactPresence?.integrity?.status, "verified");
  assert.equal(firstPublish.validation?.artifactPresence?.integrity?.checksumVerified, true);
  assert.ok(
    firstPublish.history?.some(
      (entry) =>
        entry.id === firstPublish.publish?.id &&
        entry.workspacePath === firstPublish.publish?.localPublishPath &&
        entry.manifest?.fileName === "publish-artifacts.json",
    ),
  );
  assert.match(firstPublish.publish?.privateUrl ?? "", /localhost:8484/);
  assert.match(firstPublish.dockerComposeExport?.yaml ?? "", /generated-app:/);
  assert.ok(firstPublish.dockerComposeExport?.services?.includes("generated-app"));
  assert.equal(firstPublish.dockerComposeExport?.services?.includes("packetagent-db"), false);
  assert.ok((firstPublish.publish?.logs.length ?? 0) >= 3);

  const integrityResponse = await app.request(
    `/api/app/generated-apps/${applied.app.id}/publish/integrity`,
    { headers },
  );
  const integrity = (await integrityResponse.json()) as {
    publishId?: string;
    verification?: {
      status?: string;
      checksumVerified?: boolean;
      signatureStatus?: string;
      issues?: unknown[];
    };
  };
  assert.equal(integrityResponse.status, 200);
  assert.equal(integrity.publishId, firstPublish.publish?.id);
  assert.equal(integrity.verification?.status, "verified");
  assert.equal(integrity.verification?.checksumVerified, true);
  assert.equal(integrity.verification?.signatureStatus, "verified");
  assert.deepEqual(integrity.verification?.issues, []);
  const beta = login({ email: "beta@packetagent.local", password: "demo12345" });
  const crossWorkspaceIntegrityResponse = await app.request(
    `/api/app/generated-apps/${applied.app.id}/publish/integrity`,
    { headers: authHeaders(beta.cookieValue) },
  );
  assert.equal(crossWorkspaceIntegrityResponse.status, 404);

  const publishedEntrypoint = resolve(
    process.cwd(),
    firstPublish.publish?.localPublishPath ?? "",
    "bundle",
    "index.html",
  );
  const originalEntrypoint = readFileSync(publishedEntrypoint, "utf8");
  writeFileSync(publishedEntrypoint, `${originalEntrypoint}\n<!-- tampered -->\n`, "utf8");
  const tamperedIntegrityResponse = await app.request(
    `/api/app/generated-apps/${applied.app.id}/publish/integrity`,
    { headers },
  );
  const tamperedIntegrity = (await tamperedIntegrityResponse.json()) as {
    verification?: {
      status?: string;
      issues?: Array<{ code?: string; path?: string }>;
    };
  };
  assert.equal(tamperedIntegrityResponse.status, 200);
  assert.equal(tamperedIntegrity.verification?.status, "invalid");
  assert.ok(
    tamperedIntegrity.verification?.issues?.some(
      (issue) =>
        issue.code === "manifest.entry.digest_mismatch" && issue.path === "bundle/index.html",
    ),
  );
  writeFileSync(publishedEntrypoint, originalEntrypoint, "utf8");

  const privatePreviewSession = await openGeneratedPreviewSession(app, {
    appId: applied.app.id,
    sessionCookie: alpha.cookieValue,
    checkpointId: applied.checkpoint.id,
    scope: "read",
  });
  const privatePreviewResponse = await app.request(
    generatedPreviewRequestUrl(`/api/app/generated-apps/${applied.app.id}/preview`),
    { headers: { Cookie: privatePreviewSession.cookie } },
  );
  assert.equal(privatePreviewResponse.status, 200);
  assert.match(
    privatePreviewResponse.headers.get("x-packetagent-generated-app-id") ?? "",
    new RegExp(`^${applied.app.id}$`),
  );

  const failedCheckpointId = "gapp_ckpt_publish_failed_test";
  mutateStore((data) => {
    const generated = data.generatedApps?.find((entry) => entry.id === applied.app.id);
    assert.ok(generated);
    const baseCheckpoint = generated.checkpoints?.find(
      (checkpoint) => checkpoint.id === applied.checkpoint.id,
    );
    assert.ok(baseCheckpoint);
    generated.checkpoints = [
      ...(generated.checkpoints ?? []),
      {
        ...baseCheckpoint,
        id: failedCheckpointId,
        label: "Failed publish checkpoint",
        buildStatus: "failed",
        smokeStatus: "failed",
        previousCheckpointId: generated.checkpointId,
        createdAt: "2026-05-03T20:00:00.000Z",
      },
    ];
  });

  const failedPublishResponse = await app.request("/api/app/builder/publish", {
    method: "POST",
    headers,
    body: JSON.stringify({
      appId: applied.app.id,
      checkpointId: failedCheckpointId,
      visibility: "public",
      publicBaseUrl: "https://apps.example.test/",
    }),
  });
  const failedPublish = (await failedPublishResponse.json()) as {
    error?: string;
    validation?: { canPublish?: boolean };
  };

  assert.equal(failedPublishResponse.status, 409);
  assert.equal(failedPublish.error, "publish validation failed");
  assert.equal(failedPublish.validation?.canPublish, false);
  assert.equal(
    loadStore().generatedApps?.find((entry) => entry.id === applied.app.id)?.currentPublishId,
    firstPublish.publish?.id,
  );

  const stateResponse = await app.request(
    `/api/app/builder/publish/state?appId=${applied.app.id}`,
    {
      headers,
    },
  );
  const state = (await stateResponse.json()) as {
    publishedUrl?: string;
    history?: unknown[];
    readiness?: { workspaceSlug?: string; localPublishPath?: string };
  };

  assert.equal(stateResponse.status, 200);
  assert.match(state.publishedUrl ?? "", /apps\.example\.test/);
  assert.equal(state.readiness?.workspaceSlug, "alpha-workspace");
  assert.match(state.readiness?.localPublishPath ?? "", /alpha-workspace/);
  assert.ok((state.history?.length ?? 0) >= 1);

  const composeResponse = await app.request(
    `/api/app/builder/publish/docker-compose?appId=${applied.app.id}`,
    {
      headers,
    },
  );
  const compose = (await composeResponse.json()) as { fileName?: string; contents?: string };

  assert.equal(composeResponse.status, 200);
  assert.equal(compose.fileName, "docker-compose.publish.yml");
  assert.match(compose.contents ?? "", /generated-app:/);
  assert.match(compose.contents ?? "", /read_only: true/);

  const secondPublishResponse = await app.request("/api/app/builder/publish", {
    method: "POST",
    headers,
    body: JSON.stringify({
      appId: applied.app.id,
      checkpointId: applied.checkpoint.id,
      visibility: "private",
    }),
  });
  const secondPublish = (await secondPublishResponse.json()) as {
    published?: boolean;
    publish?: {
      id: string;
      privateUrl?: string;
      previousPublishId?: string;
      rollbackCommand?: { command?: string; toPublishId?: string };
    };
    rollbackToPrevious?: { command?: string };
    state?: { publishedUrl?: string };
  };

  assert.equal(secondPublishResponse.status, 201);
  assert.equal(secondPublish.published, true);
  assert.equal(secondPublish.publish?.previousPublishId, firstPublish.publish?.id);
  assert.equal(secondPublish.publish?.rollbackCommand?.toPublishId, firstPublish.publish?.id);
  assert.match(secondPublish.rollbackToPrevious?.command ?? "", /packetagent publish rollback/);
  assert.equal(secondPublish.state?.publishedUrl, secondPublish.publish?.privateUrl);
  assert.match(secondPublish.state?.publishedUrl ?? "", /localhost:8787/);

  const rollbackResponse = await app.request(
    `/api/app/builder/publish/${secondPublish.publish?.id}/rollback`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ appId: applied.app.id, reason: "test publish rollback" }),
    },
  );
  const rollback = (await rollbackResponse.json()) as {
    rolledBack?: boolean;
    rollback?: {
      result?: { status?: string; restoredPublishId?: string; supersededPublishId?: string };
    };
    app?: { currentPublishId?: string };
    history?: Array<{ id: string; status: string; rollbackResult?: { status?: string } }>;
  };

  assert.equal(rollbackResponse.status, 200);
  assert.equal(rollback.rolledBack, true);
  assert.equal(rollback.rollback?.result?.status, "succeeded");
  assert.equal(rollback.rollback?.result?.restoredPublishId, firstPublish.publish?.id);
  assert.equal(rollback.rollback?.result?.supersededPublishId, secondPublish.publish?.id);
  assert.equal(rollback.app?.currentPublishId, firstPublish.publish?.id);
  assert.ok(
    rollback.history?.some(
      (entry) =>
        entry.id === secondPublish.publish?.id &&
        entry.status === "rolled_back" &&
        entry.rollbackResult?.status === "succeeded",
    ),
  );

  const stored = loadStore().generatedApps?.find((entry) => entry.id === applied.app.id);
  assert.equal(stored?.currentPublishId, firstPublish.publish?.id);
  assert.ok(
    stored?.publishHistory?.some(
      (entry) =>
        entry.id === secondPublish.publish?.id && entry.rollbackResult?.status === "succeeded",
    ),
  );
});

test("builder publish prepare and compose export require workspace management", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const headers = { ...authHeaders(alpha.cookieValue), "Content-Type": "application/json" };

  const draftResponse = await app.request("/api/app/builder/app-draft", {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt: "Build a public booking app with services and appointment slots.",
    }),
  });
  const { draft } = (await draftResponse.json()) as { draft: Record<string, unknown> };
  const applyResponse = await app.request("/api/app/builder/app-draft/apply", {
    method: "POST",
    headers,
    body: JSON.stringify({ draft, runSmoke: true }),
  });
  const applied = (await applyResponse.json()) as {
    app: { id: string };
    checkpoint: { id: string };
  };
  assert.equal(applyResponse.status, 201);

  mutateStore((data) => {
    const membership = data.memberships.find(
      (entry) => entry.workspaceId === "alpha" && entry.userId === "user_alpha",
    );
    assert.ok(membership);
    membership.role = "viewer";
  });

  const stateResponse = await app.request(
    `/api/app/builder/publish/state?appId=${applied.app.id}`,
    {
      headers,
    },
  );
  assert.equal(stateResponse.status, 200);

  const prepareResponse = await app.request("/api/app/builder/publish/prepare", {
    method: "POST",
    headers,
    body: JSON.stringify({ appId: applied.app.id, checkpointId: applied.checkpoint.id }),
  });
  const prepareBody = (await prepareResponse.json()) as { error?: string };
  assert.equal(prepareResponse.status, 403);
  assert.match(prepareBody.error ?? "", /admin/);

  const composeResponse = await app.request(
    `/api/app/builder/publish/docker-compose?appId=${applied.app.id}`,
    {
      headers,
    },
  );
  const composeBody = (await composeResponse.json()) as { error?: string };
  assert.equal(composeResponse.status, 403);
  assert.match(composeBody.error ?? "", /admin/);
});

test("builder publish blocks when the generated workspace artifact is missing", async (t) => {
  resetStoreForTests();
  const publishRoot = mkdtempSync(join(tmpdir(), "packetagent-publish-missing-"));
  t.after(() => rmSync(publishRoot, { recursive: true, force: true }));
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const headers = { ...authHeaders(alpha.cookieValue), "Content-Type": "application/json" };

  const draftResponse = await app.request("/api/app/builder/app-draft", {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt: "Build a public booking app for artifact validation." }),
  });
  const { draft } = (await draftResponse.json()) as { draft: Record<string, unknown> };
  const applyResponse = await app.request("/api/app/builder/app-draft/apply", {
    method: "POST",
    headers,
    body: JSON.stringify({ draft, runSmoke: true }),
  });
  const applied = (await applyResponse.json()) as {
    app: { id: string };
    checkpoint: { id: string };
  };
  assert.equal(applyResponse.status, 201);

  mutateStore((data) => {
    const generated = data.generatedApps?.find((entry) => entry.id === applied.app.id);
    assert.ok(generated);
    delete generated.runtimeArtifact;
    delete generated.sourceFiles;
    const checkpoint = generated.checkpoints?.find((entry) => entry.id === applied.checkpoint.id);
    assert.ok(checkpoint);
    delete checkpoint.runtimeArtifact;
    delete checkpoint.sourceFiles;
  });

  const publishResponse = await app.request("/api/app/builder/publish", {
    method: "POST",
    headers,
    body: JSON.stringify({
      appId: applied.app.id,
      checkpointId: applied.checkpoint.id,
      localPublishRoot: publishRoot,
      privateBaseUrl: "http://localhost:8484",
    }),
  });
  const publish = (await publishResponse.json()) as {
    error?: string;
    validation?: {
      canPublish?: boolean;
      artifactPresence?: { status?: string; missingArtifacts?: string[] };
      actionableFailures?: Array<{ stage?: string; message?: string }>;
    };
  };

  assert.equal(publishResponse.status, 409);
  assert.equal(publish.error, "publish validation failed");
  assert.equal(publish.validation?.canPublish, false);
  assert.equal(publish.validation?.artifactPresence?.status, "fail");
  assert.ok(
    publish.validation?.artifactPresence?.missingArtifacts?.some((path) =>
      path.endsWith("/bundle"),
    ),
  );
  assert.ok(
    publish.validation?.actionableFailures?.some(
      (failure) =>
        failure.stage === "artifact" && /No generated app bundle/.test(failure.message ?? ""),
    ),
  );
  assert.equal(
    loadStore().generatedApps?.find((entry) => entry.id === applied.app.id)?.currentPublishId,
    undefined,
  );
});

test("builder publish blocks requested integrations that are not ready", async (t) => {
  resetStoreForTests();
  const integrationEnvKeys = [
    "RESEND_API_KEY",
    "SENDGRID_API_KEY",
    "POSTMARK_TOKEN",
    "SMTP_URL",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_ID",
    "GITHUB_TOKEN",
    "GH_TOKEN",
  ] as const;
  const previous = new Map<string, string | undefined>();
  for (const key of integrationEnvKeys) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  t.after(() => {
    for (const key of integrationEnvKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const headers = { ...authHeaders(alpha.cookieValue), "Content-Type": "application/json" };

  const draftResponse = await app.request("/api/app/builder/app-draft", {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt:
        "Build an ops app that sends Stripe payment receipts over email and syncs GitHub issues.",
    }),
  });
  const { draft } = (await draftResponse.json()) as { draft: Record<string, unknown> };
  const applyResponse = await app.request("/api/app/builder/app-draft/apply", {
    method: "POST",
    headers,
    body: JSON.stringify({ draft, runSmoke: true }),
  });
  const applied = (await applyResponse.json()) as {
    app: { id: string };
    checkpoint: { id: string };
  };
  assert.equal(applyResponse.status, 201);

  const prepareResponse = await app.request("/api/app/builder/publish/prepare", {
    method: "POST",
    headers,
    body: JSON.stringify({ appId: applied.app.id, checkpointId: applied.checkpoint.id }),
  });
  const prepare = (await prepareResponse.json()) as {
    ready?: boolean;
    integrations?: {
      canPublish?: boolean;
      canUseAllRequestedIntegrations?: boolean;
      featureBlockers?: string[];
    };
    state?: { canPublish?: boolean; nextActions?: string[] };
  };
  assert.equal(prepareResponse.status, 200);
  assert.equal(prepare.integrations?.canPublish, true);
  assert.equal(prepare.integrations?.canUseAllRequestedIntegrations, false);
  assert.equal(prepare.ready, false);
  assert.equal(prepare.state?.canPublish, false);
  assert.ok(
    prepare.integrations?.featureBlockers?.some((blocker) => blocker.includes("Email delivery")),
  );
  assert.ok(
    prepare.integrations?.featureBlockers?.some((blocker) => blocker.includes("Stripe payments")),
  );
  assert.ok(
    prepare.state?.nextActions?.some(
      (action) => action.includes("Email delivery") || action.includes("Stripe payments"),
    ),
  );

  const publishResponse = await app.request("/api/app/builder/publish", {
    method: "POST",
    headers,
    body: JSON.stringify({ appId: applied.app.id, checkpointId: applied.checkpoint.id }),
  });
  const publish = (await publishResponse.json()) as {
    error?: string;
    integrations?: { canUseAllRequestedIntegrations?: boolean };
  };
  assert.equal(publishResponse.status, 409);
  assert.equal(publish.error, "publish validation failed");
  assert.equal(publish.integrations?.canUseAllRequestedIntegrations, false);
});

async function readSseEvents(
  stream: ReadableStream<Uint8Array>,
): Promise<Array<{ type: string; [k: string]: unknown }>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ type: string; [k: string]: unknown }> = [];
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
        for (const line of raw.split("\n")) {
          if (line.startsWith("data:")) {
            const data = line.slice(5).trimStart();
            if (data) events.push(JSON.parse(data));
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return events;
}

test("builder app-draft/stream requires authentication", async () => {
  const app = createTestApp();
  const response = await app.request("/api/app/builder/app-draft/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "Build a small CRM for renewals." }),
  });
  assert.equal(response.status, 401);
});

test("builder app-draft/stream emits step events, a draft event, and done", async () => {
  resetStoreForTests();
  const previous = process.env.PACKETAGENT_BUILDER_CHAT_STEP_MS;
  process.env.PACKETAGENT_BUILDER_CHAT_STEP_MS = "0";
  try {
    const app = createTestApp();
    const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
    const headers = { ...authHeaders(alpha.cookieValue), "Content-Type": "application/json" };

    const response = await app.request("/api/app/builder/app-draft/stream", {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "Build a small CRM for renewals and contacts." }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.ok(response.body, "response should expose a streaming body");

    const events = await readSseEvents(response.body!);
    const types = events.map((e) => e.type);
    assert.ok(types.includes("step"), "expected at least one step event");
    assert.ok(types.includes("file-progress"), "expected typed file progress events");
    assert.ok(types.includes("draft"), "expected a draft event");
    assert.equal(types[types.length - 1], "done");
    const draftEvent = events.find((e) => e.type === "draft") as {
      type: "draft";
      draft: { app: { name: string; slug: string } };
    };
    assert.ok(draftEvent.draft.app.name);
    assert.ok(draftEvent.draft.app.slug);
  } finally {
    if (previous === undefined) delete process.env.PACKETAGENT_BUILDER_CHAT_STEP_MS;
    else process.env.PACKETAGENT_BUILDER_CHAT_STEP_MS = previous;
  }
});

test("builder app-draft/stream echoes the chosen routing preset in step events", async () => {
  resetStoreForTests();
  const previous = process.env.PACKETAGENT_BUILDER_CHAT_STEP_MS;
  process.env.PACKETAGENT_BUILDER_CHAT_STEP_MS = "0";
  try {
    const app = createTestApp();
    const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
    const headers = { ...authHeaders(alpha.cookieValue), "Content-Type": "application/json" };

    const response = await app.request("/api/app/builder/app-draft/stream", {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "Build a small CRM for renewals.", preset: "fast" }),
    });
    assert.equal(response.status, 200);
    const events = await readSseEvents(response.body!);
    const stepTexts = events
      .filter((e) => e.type === "step")
      .map((e) => (e as unknown as { text: string }).text);
    assert.ok(
      stepTexts.some((text) => text.toLowerCase().includes("fast preset")),
      `expected a step mentioning the fast preset, got: ${stepTexts.join(" | ")}`,
    );
  } finally {
    if (previous === undefined) delete process.env.PACKETAGENT_BUILDER_CHAT_STEP_MS;
    else process.env.PACKETAGENT_BUILDER_CHAT_STEP_MS = previous;
  }
});

test("builder app-draft/stream narrates the template fallback path with prose events", async () => {
  resetStoreForTests();
  const previousStepMs = process.env.PACKETAGENT_BUILDER_CHAT_STEP_MS;
  const previousApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.PACKETAGENT_BUILDER_CHAT_STEP_MS = "0";
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const app = createTestApp();
    const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
    const headers = { ...authHeaders(alpha.cookieValue), "Content-Type": "application/json" };

    const response = await app.request("/api/app/builder/app-draft/stream", {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "Build a small CRM for renewals and contacts." }),
    });
    assert.equal(response.status, 200);
    const events = await readSseEvents(response.body!);
    const proseEvents = events.filter((e) => e.type === "prose") as Array<{
      type: "prose";
      text: string;
    }>;
    assert.ok(
      proseEvents.length >= 3,
      `expected at least 3 prose events, got ${proseEvents.length}`,
    );
    const draftEvent = events.find((e) => e.type === "draft") as
      | { type: "draft"; source: string; draft: { app: { name: string } } }
      | undefined;
    assert.ok(draftEvent, "expected a draft event");
    assert.equal(draftEvent.source, "template");
    const allProseConcat = proseEvents.map((e) => e.text).join("");
    assert.match(allProseConcat, /task_tracker|crm|booking|dashboard|portal/i);
  } finally {
    if (previousStepMs === undefined) delete process.env.PACKETAGENT_BUILDER_CHAT_STEP_MS;
    else process.env.PACKETAGENT_BUILDER_CHAT_STEP_MS = previousStepMs;
    if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousApiKey;
  }
});

test("checkpoint branch creates a new app with previousCheckpointId chain", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const headers = { ...authHeaders(alpha.cookieValue), "Content-Type": "application/json" };

  const draftResponse = await app.request("/api/app/builder/app-draft", {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt: "Build a public booking app with services and appointments." }),
  });
  const draftBody = (await draftResponse.json()) as { draft: unknown };
  const authoredFiles = [
    { path: "index.html", content: '<div id="root"></div>' },
    {
      path: "src/App.tsx",
      content: "export default function App(){ return <main>Branched booking app</main>; }\n",
    },
    {
      path: "package.json",
      content:
        '{"scripts":{"build":"vite build"},"dependencies":{"@vitejs/plugin-react":"latest","vite":"latest","typescript":"latest","react":"latest","react-dom":"latest"},"devDependencies":{}}\n',
    },
  ];

  const applyResponse = await app.request("/api/app/builder/app-draft/apply", {
    method: "POST",
    headers,
    body: JSON.stringify({
      draft: draftBody.draft,
      source: "llm-filetree",
      files: authoredFiles,
      runSmoke: true,
    }),
  });
  const applied = (await applyResponse.json()) as {
    app: { id: string; name: string };
    checkpoint: { id: string };
  };
  assert.equal(applyResponse.status, 201);

  const branchResponse = await app.request(
    `/api/app/builder/checkpoints/${applied.checkpoint.id}/branch`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ appId: applied.app.id }),
    },
  );
  const branched = (await branchResponse.json()) as {
    branched: boolean;
    app: { id: string; name: string; slug: string };
    checkpoint: { id: string; appId: string };
    sourceAppId: string;
    sourceCheckpointId: string;
  };
  assert.equal(branchResponse.status, 201);
  assert.equal(branched.branched, true);
  assert.notEqual(branched.app.id, applied.app.id);
  assert.equal(branched.sourceAppId, applied.app.id);
  assert.equal(branched.sourceCheckpointId, applied.checkpoint.id);
  assert.match(branched.app.name, / \(branch\)$/);
  assert.match(branched.app.slug, /-branch-/);

  const stored = loadStore().generatedApps ?? [];
  const sourceApp = stored.find((entry) => entry.id === applied.app.id);
  const branchApp = stored.find((entry) => entry.id === branched.app.id);
  assert.ok(sourceApp, "source app survives");
  assert.ok(branchApp, "branch app exists");
  const branchInitial = (branchApp.checkpoints ?? []).find(
    (checkpoint) => checkpoint.id === branched.checkpoint.id,
  );
  assert.ok(branchInitial, "branch app has its own initial checkpoint");
  assert.equal(branchInitial.source, "branch");
  assert.equal(branchInitial.previousCheckpointId, applied.checkpoint.id);
  assert.equal(branchInitial.codegenSource, "llm-filetree");
  assert.equal(
    branchInitial.sourceFiles?.find((file) => file.path === "src/App.tsx")?.content,
    authoredFiles[1]?.content,
  );
  assert.equal(branchApp.codegenSource, "llm-filetree");
  assert.equal(
    branchApp.sourceFiles?.find((file) => file.path === "src/App.tsx")?.content,
    authoredFiles[1]?.content,
  );
});

test("checkpoint branch requires authentication", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const response = await app.request("/api/app/builder/checkpoints/some-id/branch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId: "some-app" }),
  });
  assert.equal(response.status, 401);
});

test("builder app-iteration/stream emits step events, a diff event, and done", async () => {
  resetStoreForTests();
  const previous = process.env.PACKETAGENT_BUILDER_CHAT_STEP_MS;
  process.env.PACKETAGENT_BUILDER_CHAT_STEP_MS = "0";
  try {
    const app = createTestApp();
    const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
    const headers = { ...authHeaders(alpha.cookieValue), "Content-Type": "application/json" };

    const draftResponse = await app.request("/api/app/builder/app-draft", {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "Build a small CRM for renewals and contacts." }),
    });
    const draftBody = (await draftResponse.json()) as { draft: unknown };

    const response = await app.request("/api/app/builder/app-iteration/stream", {
      method: "POST",
      headers,
      body: JSON.stringify({
        draft: draftBody.draft,
        prompt: "Add inline notes to the contact detail page.",
        target: { id: "target_app_test", kind: "app", label: "Whole app" },
      }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.ok(response.body, "response should expose a streaming body");

    const events = await readSseEvents(response.body!);
    const types = events.map((e) => e.type);
    assert.ok(types.includes("step"), "expected at least one step event");
    assert.ok(types.includes("file-progress"), "expected typed file progress events");
    assert.ok(types.includes("diff"), "expected a diff event");
    assert.equal(types[types.length - 1], "done");
    const diffEvent = events.find((e) => e.type === "diff") as {
      type: "diff";
      iteration: { id: string; files: unknown[] };
    };
    assert.ok(diffEvent.iteration.id);
    assert.ok(Array.isArray(diffEvent.iteration.files));
  } finally {
    if (previous === undefined) delete process.env.PACKETAGENT_BUILDER_CHAT_STEP_MS;
    else process.env.PACKETAGENT_BUILDER_CHAT_STEP_MS = previous;
  }
});

test("host-info route requires authentication and reports LAN ips for share affordance", async (t) => {
  resetStoreForTests();
  const app = createTestApp();

  const unauth = await app.request("/api/app/host-info");
  assert.equal(unauth.status, 401);
  assert.deepEqual(await unauth.json(), { error: "authentication required" });

  const restore = setHostInfoSourcesForTests({
    networkInterfaces: () => ({
      lo: [
        {
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "127.0.0.1/8",
        },
      ],
      en0: [
        {
          address: "192.168.4.21",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "aa:bb:cc:dd:ee:ff",
          internal: false,
          cidr: "192.168.4.21/24",
        },
        {
          address: "fe80::1",
          netmask: "ffff:ffff:ffff:ffff::",
          family: "IPv6",
          mac: "aa:bb:cc:dd:ee:ff",
          internal: false,
          cidr: "fe80::1/64",
          scopeid: 4,
        },
      ],
      eth1: [
        {
          address: "10.0.0.7",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "11:22:33:44:55:66",
          internal: false,
          cidr: "10.0.0.7/24",
        },
      ],
    }),
    resolvePort: () => 9090,
  });
  t.after(() => restore());

  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const response = await app.request("/api/app/host-info", {
    headers: authHeaders(alpha.cookieValue),
  });
  const body = (await response.json()) as { lanIps: string[]; port: number };

  assert.equal(response.status, 200);
  assert.equal(body.port, 9090);
  assert.deepEqual(body.lanIps, ["192.168.4.21", "10.0.0.7"]);
});

test("host-info route returns empty lanIps when no external IPv4 interfaces are present", async (t) => {
  resetStoreForTests();
  const app = createTestApp();
  const restore = setHostInfoSourcesForTests({
    networkInterfaces: () => ({
      lo: [
        {
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "127.0.0.1/8",
        },
      ],
    }),
    resolvePort: () => 8484,
  });
  t.after(() => restore());

  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const response = await app.request("/api/app/host-info", {
    headers: authHeaders(alpha.cookieValue),
  });
  const body = (await response.json()) as { lanIps: string[]; port: number };

  assert.equal(response.status, 200);
  assert.equal(body.port, 8484);
  assert.deepEqual(body.lanIps, []);
});

async function setupGeneratedAppForPreviewTokenTests() {
  resetStoreForTests();
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const headers = { ...authHeaders(alpha.cookieValue), "Content-Type": "application/json" };
  const draftResponse = await app.request("/api/app/builder/app-draft", {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt: "Build a small invoice tracker for freelancers and clients." }),
  });
  const { draft } = (await draftResponse.json()) as { draft: Record<string, unknown> };
  const applyResponse = await app.request("/api/app/builder/app-draft/apply", {
    method: "POST",
    headers,
    body: JSON.stringify({ draft, runSmoke: true }),
  });
  const applied = (await applyResponse.json()) as { app: { id: string; slug: string } };
  assert.equal(applyResponse.status, 201);
  return { app, alpha, headers, applied };
}

test("preview-token endpoint requires authentication", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const response = await app.request("/api/app/generated-apps/some-app/preview-token", {
    method: "POST",
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "authentication required" });
});

test("preview-token endpoint mints a token with a future expiry and a previewUrl", async () => {
  const { app, alpha, applied } = await setupGeneratedAppForPreviewTokenTests();
  const before = Date.now();
  const response = await app.request(`/api/app/generated-apps/${applied.app.id}/preview-token`, {
    method: "POST",
    headers: authHeaders(alpha.cookieValue),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    token: string;
    scope: string;
    checkpointId: string;
    expiresAt: string;
    previewUrl: string;
  };
  assert.match(body.token, /^pt1\./);
  assert.equal(body.token.includes(applied.app.id), false);
  assert.equal(body.scope, "read");
  assert.match(body.checkpointId, /^gapp_ckpt_/);
  const expiresAtMs = Date.parse(body.expiresAt);
  assert.ok(Number.isFinite(expiresAtMs));
  assert.ok(expiresAtMs > before, "token expiry should be in the future");
  // Default TTL is 1 hour; allow a small drift.
  assert.ok(expiresAtMs - before <= 60 * 60 * 1000 + 5000);
  assert.ok(expiresAtMs - before >= 60 * 60 * 1000 - 5000);
  const previewUrl = new URL(body.previewUrl);
  assert.equal(previewUrl.origin, resolvePacketAgentPreviewOrigin());
  assert.equal(
    previewUrl.pathname,
    `/api/app/generated-apps/${encodeURIComponent(applied.app.id)}/preview/`,
  );
  assert.equal(previewUrl.search, "");
  assert.equal(previewUrl.hash, `#token=${body.token}`);
});

test("preview-token endpoint rejects appIds outside the caller's workspace", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  mutateStore((data) => {
    data.generatedApps ??= [];
    data.generatedApps.push({
      id: "gapp_beta_preview_token_test",
      workspaceId: "beta",
      slug: "beta-private-token",
      name: "Beta Private Token",
      description: "Other workspace",
      prompt: "Build a private app for Beta.",
      templateId: "crm",
      status: "saved",
      draft: { app: { name: "Beta Private Token" } },
      checkpointId: "gapp_ckpt_beta_preview_token_test",
      createdByUserId: "user_beta",
      createdAt: "2026-05-01T12:00:00.000Z",
      updatedAt: "2026-05-02T12:00:00.000Z",
    });
  });
  const response = await app.request(
    "/api/app/generated-apps/gapp_beta_preview_token_test/preview-token",
    {
      method: "POST",
      headers: authHeaders(alpha.cookieValue),
    },
  );
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "generated app not found" });
});

test("preview fragment bootstrap exchanges a capability for an app-scoped HttpOnly cookie", async () => {
  const { app, alpha, applied } = await setupGeneratedAppForPreviewTokenTests();
  const primaryPreview = await app.request(`/api/app/generated-apps/${applied.app.id}/preview`, {
    headers: authHeaders(alpha.cookieValue),
  });
  assert.equal(primaryPreview.status, 404);

  const previewSession = await openGeneratedPreviewSession(app, {
    appId: applied.app.id,
    sessionCookie: alpha.cookieValue,
    scope: "read",
  });
  const bootstrapUrl = new URL(previewSession.previewUrl);
  bootstrapUrl.hash = "";
  const bootstrap = await app.request(bootstrapUrl);
  const bootstrapHtml = await bootstrap.text();
  assert.equal(bootstrap.status, 200);
  assert.match(bootstrapHtml, /location\.hash/);
  assert.match(bootstrap.headers.get("content-security-policy") ?? "", /script-src 'nonce-/);

  const previewResponse = await app.request(
    generatedPreviewRequestUrl(`/api/app/generated-apps/${applied.app.id}/preview/`),
    { headers: { Cookie: previewSession.cookie } },
  );
  assert.equal(previewResponse.status, 200);
  assert.match(previewResponse.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(previewResponse.headers.get("x-packetagent-generated-app-id"), applied.app.id);
  const html = await previewResponse.text();
  assert.match(html, new RegExp(`data-app-id="${applied.app.id}"`));
  assert.doesNotMatch(
    html,
    new RegExp(previewSession.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

test("read preview sessions cannot mutate runtime data and session exchange is same-origin only", async () => {
  const { app, alpha, applied } = await setupGeneratedAppForPreviewTokenTests();
  const previewSession = await openGeneratedPreviewSession(app, {
    appId: applied.app.id,
    sessionCookie: alpha.cookieValue,
    scope: "read",
  });
  const writeResponse = await app.request(
    generatedPreviewRequestUrl(`/api/app/generated-apps/${applied.app.id}/api/account`),
    {
      method: "POST",
      headers: {
        Cookie: previewSession.cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "must not persist" }),
    },
  );
  assert.equal(writeResponse.status, 403);
  assert.deepEqual(await writeResponse.json(), {
    error: "shared preview sessions can only read runtime data",
  });

  const crossOriginSession = await app.request(
    generatedPreviewRequestUrl(`/api/app/generated-apps/${applied.app.id}/preview-session`),
    {
      method: "POST",
      headers: {
        Origin: "https://attacker.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token: previewSession.token }),
    },
  );
  assert.equal(crossOriginSession.status, 403);
});

test("preview origin rejects legacy query-string capability delivery", async () => {
  const { app, alpha, applied } = await setupGeneratedAppForPreviewTokenTests();
  const tokenResponse = await app.request(
    `/api/app/generated-apps/${applied.app.id}/preview-token`,
    {
      method: "POST",
      headers: authHeaders(alpha.cookieValue),
    },
  );
  const { token } = (await tokenResponse.json()) as { token: string };
  const response = await app.request(
    generatedPreviewRequestUrl(
      `/api/app/generated-apps/${applied.app.id}/preview/?token=${encodeURIComponent(token)}`,
    ),
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "preview capabilities must be delivered in the URL fragment, not the query string",
  });
});

test("preview route rejects an expired token with a friendly 401", async () => {
  const { app, applied } = await setupGeneratedAppForPreviewTokenTests();
  const record = loadStore().generatedApps?.find((entry) => entry.id === applied.app.id);
  assert.ok(record?.checkpointId);
  const { token } = mintGeneratedPreviewCapability({
    appId: applied.app.id,
    workspaceId: record.workspaceId,
    checkpointId: record.checkpointId,
    scope: "read",
    ttlSeconds: 60,
    now: new Date(Date.now() - 2 * 60 * 60 * 1000),
  });

  const previewResponse = await app.request(
    generatedPreviewRequestUrl(`/api/app/generated-apps/${applied.app.id}/preview-session`),
    {
      method: "POST",
      headers: {
        Origin: resolvePacketAgentPreviewOrigin(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token }),
    },
  );
  assert.equal(previewResponse.status, 401);
  assert.deepEqual(await previewResponse.json(), { error: "preview link expired or invalid" });
});

test("preview route rejects a tampered or wrong-app token with a friendly 401", async () => {
  const { app, alpha, applied } = await setupGeneratedAppForPreviewTokenTests();
  const tokenResponse = await app.request(
    `/api/app/generated-apps/${applied.app.id}/preview-token`,
    {
      method: "POST",
      headers: authHeaders(alpha.cookieValue),
    },
  );
  const tokenBody = (await tokenResponse.json()) as { token: string };

  // Tampered: flip the last character of the hmac portion.
  const flipped = tokenBody.token.slice(0, -1) + (tokenBody.token.endsWith("A") ? "B" : "A");
  const tamperedResponse = await app.request(
    generatedPreviewRequestUrl(`/api/app/generated-apps/${applied.app.id}/preview-session`),
    {
      method: "POST",
      headers: {
        Origin: resolvePacketAgentPreviewOrigin(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token: flipped }),
    },
  );
  assert.equal(tamperedResponse.status, 401);
  assert.deepEqual(await tamperedResponse.json(), { error: "preview link expired or invalid" });

  // Wrong app: use a valid token but mount it under a different appId in the path.
  // The token's appId no longer matches the route param, so verification must fail.
  mutateStore((data) => {
    data.generatedApps ??= [];
    data.generatedApps.push({
      id: "gapp_alpha_preview_token_other",
      workspaceId: "alpha",
      slug: "alpha-other-token",
      name: "Alpha Other Token",
      description: "Another alpha app",
      prompt: "Build a different alpha app.",
      templateId: "crm",
      status: "saved",
      draft: { app: { name: "Alpha Other Token" } },
      checkpointId: "gapp_ckpt_alpha_preview_token_other",
      createdByUserId: "user_alpha",
      createdAt: "2026-05-01T13:00:00.000Z",
      updatedAt: "2026-05-02T13:00:00.000Z",
    });
  });
  const wrongAppResponse = await app.request(
    generatedPreviewRequestUrl(
      "/api/app/generated-apps/gapp_alpha_preview_token_other/preview-session",
    ),
    {
      method: "POST",
      headers: {
        Origin: resolvePacketAgentPreviewOrigin(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token: tokenBody.token }),
    },
  );
  assert.equal(wrongAppResponse.status, 401);
  assert.deepEqual(await wrongAppResponse.json(), { error: "preview link expired or invalid" });
});

// --- Issue 1: rate-limit identity scoping --------------------------------

test("auth:login limiter scopes the bucket by submitted email so one attacker can't lock everyone out", async (t) => {
  resetStoreForTests();
  const previousMax = process.env.PACKETAGENT_AUTH_RATE_LIMIT_MAX_ATTEMPTS;
  process.env.PACKETAGENT_AUTH_RATE_LIMIT_MAX_ATTEMPTS = "1";
  t.after(() => {
    if (previousMax === undefined) delete process.env.PACKETAGENT_AUTH_RATE_LIMIT_MAX_ATTEMPTS;
    else process.env.PACKETAGENT_AUTH_RATE_LIMIT_MAX_ATTEMPTS = previousMax;
  });
  const app = createTestApp();

  const attempt = (email: string) =>
    app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "wrong-password" }),
    });

  // All requests share the same (test) network identity, so without email
  // scoping they'd all land in one bucket. With max=1 the attacker's first
  // attempt is allowed through to auth (401), the second is rate limited (429).
  const attacker1 = await attempt("attacker@packetagent.local");
  assert.equal(attacker1.status, 401, "first attacker attempt should reach auth, not the limiter");
  const attacker2 = await attempt("attacker@packetagent.local");
  assert.equal(attacker2.status, 429, "second attacker attempt should be rate limited");

  // A different victim email must NOT be collateral-damaged by the attacker's
  // exhausted bucket — it gets its own bucket and reaches auth (401, not 429).
  const victim = await attempt("victim@packetagent.local");
  assert.equal(victim.status, 401, "victim should not inherit the attacker's exhausted bucket");
});

// --- Issue 3: preview-token production secret refusal ---------------------

test("preview-token minting refuses the baked-in fallback secret in production", async (t) => {
  const previousEnv = process.env.NODE_ENV;
  const previousPreview = process.env.PACKETAGENT_PREVIEW_TOKEN_SECRET;
  const previousMaster = process.env.PACKETAGENT_MASTER_KEY;
  const previousAppOrigin = process.env.PACKETAGENT_APP_ORIGIN;
  const previousPreviewOrigin = process.env.PACKETAGENT_PREVIEW_ORIGIN;
  t.after(() => {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
    if (previousPreview === undefined) delete process.env.PACKETAGENT_PREVIEW_TOKEN_SECRET;
    else process.env.PACKETAGENT_PREVIEW_TOKEN_SECRET = previousPreview;
    if (previousMaster === undefined) delete process.env.PACKETAGENT_MASTER_KEY;
    else process.env.PACKETAGENT_MASTER_KEY = previousMaster;
    if (previousAppOrigin === undefined) delete process.env.PACKETAGENT_APP_ORIGIN;
    else process.env.PACKETAGENT_APP_ORIGIN = previousAppOrigin;
    if (previousPreviewOrigin === undefined) delete process.env.PACKETAGENT_PREVIEW_ORIGIN;
    else process.env.PACKETAGENT_PREVIEW_ORIGIN = previousPreviewOrigin;
  });

  const { app, alpha, applied } = await setupGeneratedAppForPreviewTokenTests();

  // No real secret configured + production => minting must refuse, not forge.
  process.env.NODE_ENV = "production";
  delete process.env.PACKETAGENT_PREVIEW_TOKEN_SECRET;
  delete process.env.PACKETAGENT_MASTER_KEY;
  process.env.PACKETAGENT_APP_ORIGIN = "https://packetagent.example.test";
  process.env.PACKETAGENT_PREVIEW_ORIGIN = "https://preview.packetagent.example.test";

  const refused = await app.request(`/api/app/generated-apps/${applied.app.id}/preview-token`, {
    method: "POST",
    headers: authHeaders(alpha.cookieValue),
  });
  assert.equal(refused.status, 500);
  const refusedBody = (await refused.json()) as { error: string };
  assert.match(refusedBody.error, /preview capabilities are unavailable/);

  // Once a real secret is configured, production minting works again.
  process.env.PACKETAGENT_PREVIEW_TOKEN_SECRET = "a-real-production-preview-secret";
  const ok = await app.request(`/api/app/generated-apps/${applied.app.id}/preview-token`, {
    method: "POST",
    headers: authHeaders(alpha.cookieValue),
  });
  assert.equal(ok.status, 200);
  const okBody = (await ok.json()) as { token: string };
  assert.match(okBody.token, /^pt1\./);
});

test("preview verification refuses fallback-forged tokens in production", async (t) => {
  const previousEnv = process.env.NODE_ENV;
  const previousPreview = process.env.PACKETAGENT_PREVIEW_TOKEN_SECRET;
  const previousMaster = process.env.PACKETAGENT_MASTER_KEY;
  const previousAppOrigin = process.env.PACKETAGENT_APP_ORIGIN;
  const previousPreviewOrigin = process.env.PACKETAGENT_PREVIEW_ORIGIN;
  t.after(() => {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
    if (previousPreview === undefined) delete process.env.PACKETAGENT_PREVIEW_TOKEN_SECRET;
    else process.env.PACKETAGENT_PREVIEW_TOKEN_SECRET = previousPreview;
    if (previousMaster === undefined) delete process.env.PACKETAGENT_MASTER_KEY;
    else process.env.PACKETAGENT_MASTER_KEY = previousMaster;
    if (previousAppOrigin === undefined) delete process.env.PACKETAGENT_APP_ORIGIN;
    else process.env.PACKETAGENT_APP_ORIGIN = previousAppOrigin;
    if (previousPreviewOrigin === undefined) delete process.env.PACKETAGENT_PREVIEW_ORIGIN;
    else process.env.PACKETAGENT_PREVIEW_ORIGIN = previousPreviewOrigin;
  });

  const { app, applied } = await setupGeneratedAppForPreviewTokenTests();

  const record = loadStore().generatedApps?.find((entry) => entry.id === applied.app.id);
  assert.ok(record?.checkpointId);
  const { token: forged } = mintGeneratedPreviewCapability({
    appId: applied.app.id,
    workspaceId: record.workspaceId,
    checkpointId: record.checkpointId,
    scope: "read",
    env: { NODE_ENV: "development" },
  });

  // In production with no real secret, verification must refuse (401), not
  // accept the fallback-forged token.
  process.env.NODE_ENV = "production";
  delete process.env.PACKETAGENT_PREVIEW_TOKEN_SECRET;
  delete process.env.PACKETAGENT_MASTER_KEY;
  process.env.PACKETAGENT_APP_ORIGIN = "https://packetagent.example.test";
  process.env.PACKETAGENT_PREVIEW_ORIGIN = "https://preview.packetagent.example.test";

  const previewResponse = await app.request(
    new URL(
      `/api/app/generated-apps/${applied.app.id}/preview-session`,
      process.env.PACKETAGENT_PREVIEW_ORIGIN,
    ),
    {
      method: "POST",
      headers: {
        Origin: process.env.PACKETAGENT_PREVIEW_ORIGIN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token: forged }),
    },
  );
  assert.equal(previewResponse.status, 401);
  assert.deepEqual(await previewResponse.json(), { error: "preview link expired or invalid" });
});
