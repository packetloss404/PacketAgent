import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Hono, type Context } from "hono";

type RuntimeModules = Awaited<ReturnType<typeof loadRuntimeModules>>;

const SESSION_COOKIE_NAME = "packetagent_session";

test("SQLite store preserves critical app behavior parity", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-parity-"));
  const dbPath = join(tempDir, "packetagent.sqlite");
  const previousStore = process.env.PACKETAGENT_STORE;
  const previousDbPath = process.env.PACKETAGENT_DB_PATH;

  process.env.PACKETAGENT_STORE = "sqlite";
  process.env.PACKETAGENT_DB_PATH = dbPath;

  t.after(() => {
    restoreEnv("PACKETAGENT_STORE", previousStore);
    restoreEnv("PACKETAGENT_DB_PATH", previousDbPath);
    rmSync(tempDir, { recursive: true, force: true });
  });

  const modules = await loadRuntimeModules();
  modules.store.resetStoreForTests();
  if (!existsSync(dbPath)) {
    t.skip(
      "SQLite store runtime is not wired yet: expected PACKETAGENT_STORE=sqlite to create PACKETAGENT_DB_PATH",
    );
    return;
  }

  await t.test("auth, session, and bootstrap work with SQLite-backed state", async () => {
    resetSqliteStore(modules);
    const app = createTestApp(modules);

    const anonymous = await app.request("/api/auth/session");
    assert.equal(anonymous.status, 200);
    assert.deepEqual(await anonymous.json(), {
      authenticated: false,
      user: null,
      workspace: null,
      onboarding: null,
    });

    const registered = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "sqlite.auth@example.com",
        password: "demo12345",
        displayName: "New User",
      }),
    });
    const cookie = cookieValue(registered);
    const registeredBody = (await registered.json()) as {
      authenticated: boolean;
      workspace: { name: string };
    };
    assert.equal(registered.status, 201);
    assert.equal(registeredBody.authenticated, true);
    assert.equal(registeredBody.workspace.name, "New workspace");

    const session = await app.request("/api/auth/session", { headers: authHeaders(cookie) });
    const bootstrap = await app.request("/api/app/bootstrap", { headers: authHeaders(cookie) });
    const bootstrapBody = (await bootstrap.json()) as {
      activation: { status: { stage: string } };
      activities: unknown[];
    };

    assert.equal(session.status, 200);
    assert.equal(bootstrap.status, 200);
    assert.ok(bootstrapBody.activation.status.stage);
    assert.ok(Array.isArray(bootstrapBody.activities));
  });

  await t.test("RBAC, member listing, and invitation acceptance match JSON behavior", async () => {
    resetSqliteStore(modules);
    const app = createTestApp(modules);
    const alpha = modules.services.login({
      email: "alpha@packetagent.local",
      password: "demo12345",
    });
    const beta = modules.services.login({ email: "beta@packetagent.local", password: "demo12345" });

    setAlphaRole(modules, "admin");
    const created = await app.request("/api/app/invitations", {
      method: "POST",
      headers: { ...authHeaders(alpha.cookieValue), "content-type": "application/json" },
      body: JSON.stringify({ email: "Beta@PacketAgent.Local", role: "member" }),
    });
    const createdBody = (await created.json()) as {
      invitation: { token: string; email: string; role: string; status: string };
    };

    assert.equal(created.status, 201);
    assert.equal(createdBody.invitation.email, "beta@packetagent.local");
    assert.equal(createdBody.invitation.role, "member");
    assert.equal(createdBody.invitation.status, "pending");
    assert.ok(createdBody.invitation.token);

    const adminList = await app.request("/api/app/members", {
      headers: authHeaders(alpha.cookieValue),
    });
    const adminBody = (await adminList.json()) as {
      invitations: Array<{ token?: string; tokenPreview?: string }>;
    };
    assert.equal(adminList.status, 200);
    assert.equal(adminBody.invitations[0]?.token, undefined);
    assert.ok(adminBody.invitations[0]?.tokenPreview);

    setAlphaRole(modules, "viewer");
    const viewerList = await app.request("/api/app/members", {
      headers: authHeaders(alpha.cookieValue),
    });
    const viewerBody = (await viewerList.json()) as {
      invitations: Array<{ token?: string; tokenPreview?: string }>;
    };
    assert.equal(viewerList.status, 200);
    assert.equal(viewerBody.invitations[0]?.token, undefined);
    assert.ok(viewerBody.invitations[0]?.tokenPreview);

    const accepted = await app.request(
      `/api/app/invitations/${createdBody.invitation.token}/accept`,
      {
        method: "POST",
        headers: authHeaders(beta.cookieValue),
      },
    );
    const acceptedBody = (await accepted.json()) as {
      membership: { userId: string; role: string };
      invitation: { status: string };
    };

    assert.equal(accepted.status, 200);
    assert.equal(acceptedBody.membership.userId, "user_beta");
    assert.equal(acceptedBody.membership.role, "member");
    assert.equal(acceptedBody.invitation.status, "accepted");
    assert.equal(
      modules.store
        .loadStore()
        .memberships.some(
          (entry: { workspaceId: string; userId: string }) =>
            entry.workspaceId === "alpha" && entry.userId === "user_beta",
        ),
      true,
    );
  });

  await t.test("workflow writes feed activation bootstrap state", async () => {
    resetSqliteStore(modules);
    const app = createTestApp(modules);
    const registered = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "sqlite.workflow@example.com",
        password: "demo12345",
        displayName: "SQLite Workflow",
      }),
    });
    const cookie = cookieValue(registered);

    const brief = await app.request("/api/app/workflow/brief", {
      method: "PUT",
      headers: { ...authHeaders(cookie), "content-type": "application/json" },
      body: JSON.stringify({
        summary: "Automate SQLite parity checks for the DB runtime",
        targetCustomers: ["Internal operators"],
        successMetrics: ["Parity suite passes"],
      }),
    });
    assert.equal(brief.status, 200);

    const plan = await app.request("/api/app/workflow/plan-mode/apply", {
      method: "POST",
      headers: { ...authHeaders(cookie), "content-type": "application/json" },
      body: JSON.stringify({
        planItems: [{ summary: "Exercise DB runtime writes", status: "doing" }],
      }),
    });
    assert.equal(plan.status, 200);

    const bootstrap = await app.request("/api/app/bootstrap", { headers: authHeaders(cookie) });
    const body = (await bootstrap.json()) as {
      activation: { status: { stage: string; milestones: unknown[] } };
      onboarding: { completedSteps: string[] };
    };
    assert.equal(bootstrap.status, 200);
    assert.ok(["implementation", "validation", "complete"].includes(body.activation.status.stage));
    assert.ok(body.activation.status.milestones.length > 0);
    assert.ok(body.onboarding.completedSteps.includes("create_workspace_profile"));
    assert.ok(body.onboarding.completedSteps.includes("define_plan"));
  });

  await t.test("jobs can be enqueued, listed, and canceled", async () => {
    resetSqliteStore(modules);
    const app = createTestApp(modules);
    const alpha = modules.services.login({
      email: "alpha@packetagent.local",
      password: "demo12345",
    });

    const created = await app.request("/api/app/jobs", {
      method: "POST",
      headers: { ...authHeaders(alpha.cookieValue), "content-type": "application/json" },
      body: JSON.stringify({
        type: "test.sqlite",
        payload: { source: "db-parity" },
        maxAttempts: 2,
      }),
    });
    const createdBody = (await created.json()) as {
      job: { id: string; workspaceId: string; status: string; type: string; payload: unknown };
    };
    assert.equal(created.status, 201);
    assert.equal(createdBody.job.workspaceId, "alpha");
    assert.equal(createdBody.job.status, "queued");

    const list = await app.request("/api/app/jobs?status=queued&limit=10", {
      headers: authHeaders(alpha.cookieValue),
    });
    const listBody = (await list.json()) as { jobs: Array<{ id: string }> };
    assert.equal(list.status, 200);
    assert.ok(listBody.jobs.some((job) => job.id === createdBody.job.id));

    const canceled = await app.request(`/api/app/jobs/${createdBody.job.id}/cancel`, {
      method: "POST",
      headers: authHeaders(alpha.cookieValue),
    });
    const canceledBody = (await canceled.json()) as {
      job: { status: string; cancelRequested: boolean };
    };
    assert.equal(canceled.status, 200);
    assert.equal(canceledBody.job.status, "canceled");
    assert.equal(canceledBody.job.cancelRequested, true);
  });

  await t.test("agent creation and manual run basics persist", async () => {
    resetSqliteStore(modules);
    const app = createTestApp(modules);
    const alpha = modules.services.login({
      email: "alpha@packetagent.local",
      password: "demo12345",
    });

    const created = await app.request("/api/app/agents", {
      method: "POST",
      headers: { ...authHeaders(alpha.cookieValue), "content-type": "application/json" },
      body: JSON.stringify({
        name: "SQLite parity agent",
        description: "Exercises DB-backed agent writes",
        instructions: "Record a local run for parity testing.",
        tools: [],
        inputSchema: [{ key: "ticket", label: "Ticket", type: "string", required: true }],
      }),
    });
    const createdBody = (await created.json()) as { agent: { id: string; name: string } };
    assert.equal(created.status, 201);
    assert.equal(createdBody.agent.name, "SQLite parity agent");

    const run = await app.request(`/api/app/agents/${createdBody.agent.id}/runs`, {
      method: "POST",
      headers: { ...authHeaders(alpha.cookieValue), "content-type": "application/json" },
      body: JSON.stringify({ triggerKind: "manual", inputs: { ticket: "SQL-1" } }),
    });
    const runBody = (await run.json()) as {
      run: {
        agentId: string;
        status: string;
        triggerKind: string;
        inputs: Record<string, unknown>;
      };
    };
    assert.equal(run.status, 201);
    assert.equal(runBody.run.agentId, createdBody.agent.id);
    assert.equal(runBody.run.status, "success");
    assert.equal(runBody.run.triggerKind, "manual");
    assert.deepEqual(runBody.run.inputs, { ticket: "SQL-1" });
  });

  await t.test("share token lifecycle and public share reads persist", async () => {
    resetSqliteStore(modules);
    const app = createTestApp(modules);
    const alpha = modules.services.login({
      email: "alpha@packetagent.local",
      password: "demo12345",
    });

    const created = await app.request("/api/app/share", {
      method: "POST",
      headers: { ...authHeaders(alpha.cookieValue), "content-type": "application/json" },
      body: JSON.stringify({ scope: "overview" }),
    });
    const createdBody = (await created.json()) as {
      token: { id: string; token: string; scope: string; readCount: number };
    };
    assert.equal(created.status, 201);
    assert.equal(createdBody.token.scope, "overview");
    assert.equal(createdBody.token.readCount, 0);

    const publicRead = await app.request(`/api/public/share/${createdBody.token.token}`);
    const publicBody = (await publicRead.json()) as {
      shared: { scope: string; workspace: { id: string }; brief: unknown; planItems: unknown[] };
    };
    assert.equal(publicRead.status, 200);
    assert.equal(publicBody.shared.scope, "overview");
    assert.equal(publicBody.shared.workspace.id, "alpha");
    assert.ok(publicBody.shared.brief);
    assert.ok(Array.isArray(publicBody.shared.planItems));

    const list = await app.request("/api/app/share", { headers: authHeaders(alpha.cookieValue) });
    const listBody = (await list.json()) as {
      tokens: Array<{ id: string; readCount: number; lastReadAt?: string }>;
    };
    const listed = listBody.tokens.find((token) => token.id === createdBody.token.id);
    assert.equal(list.status, 200);
    assert.equal(listed?.readCount, 1);
    assert.ok(listed?.lastReadAt);

    const revoked = await app.request(`/api/app/share/${createdBody.token.id}`, {
      method: "DELETE",
      headers: authHeaders(alpha.cookieValue),
    });
    assert.equal(revoked.status, 200);

    const afterRevoke = await app.request(`/api/public/share/${createdBody.token.token}`);
    assert.equal(afterRevoke.status, 404);
  });
});

test("JSON default and SQLite opt-in keep indexed route behavior aligned", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-indexed-routes-"));
  const previousStore = process.env.PACKETAGENT_STORE;
  const previousDbPath = process.env.PACKETAGENT_DB_PATH;
  const previousInvitationEmailMode = process.env.PACKETAGENT_INVITATION_EMAIL_MODE;

  t.after(() => {
    restoreEnv("PACKETAGENT_STORE", previousStore);
    restoreEnv("PACKETAGENT_DB_PATH", previousDbPath);
    restoreEnv("PACKETAGENT_INVITATION_EMAIL_MODE", previousInvitationEmailMode);
    rmSync(tempDir, { recursive: true, force: true });
  });

  const modules = await loadRuntimeModules();
  const jsonResult = await runIndexedRouteScenario(modules, "json");

  process.env.PACKETAGENT_STORE = "sqlite";
  process.env.PACKETAGENT_DB_PATH = join(tempDir, "packetagent.sqlite");
  const sqliteResult = await runIndexedRouteScenario(modules, "sqlite");

  assert.deepEqual(sqliteResult, jsonResult);
});

test("JSON default and SQLite opt-in keep invitation delivery skip mode aligned", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-db-invitation-delivery-"));
  const previousStore = process.env.PACKETAGENT_STORE;
  const previousDbPath = process.env.PACKETAGENT_DB_PATH;
  const previousInvitationEmailMode = process.env.PACKETAGENT_INVITATION_EMAIL_MODE;

  t.after(() => {
    restoreEnv("PACKETAGENT_STORE", previousStore);
    restoreEnv("PACKETAGENT_DB_PATH", previousDbPath);
    restoreEnv("PACKETAGENT_INVITATION_EMAIL_MODE", previousInvitationEmailMode);
    rmSync(tempDir, { recursive: true, force: true });
  });

  process.env.PACKETAGENT_INVITATION_EMAIL_MODE = "skip";
  const modules = await loadRuntimeModules();
  const jsonResult = await runInvitationDeliveryModeScenario(modules, "json");

  process.env.PACKETAGENT_STORE = "sqlite";
  process.env.PACKETAGENT_DB_PATH = join(tempDir, "packetagent.sqlite");
  const sqliteResult = await runInvitationDeliveryModeScenario(modules, "sqlite");

  assert.deepEqual(sqliteResult, jsonResult);
});

async function loadRuntimeModules() {
  const [
    store,
    services,
    appRoutesModule,
    workflowRoutesModule,
    jobRoutesModule,
    shareRoutesModule,
    rbacModule,
  ] = await Promise.all([
    import("./packetagent-store.js"),
    import("./packetagent-services.js"),
    import("./app-routes.js"),
    import("./workflow-routes.js"),
    import("./job-routes.js"),
    import("./share-routes.js"),
    import("./rbac.js"),
  ]);
  return {
    store,
    services,
    appRoutesModule,
    workflowRoutesModule,
    jobRoutesModule,
    shareRoutesModule,
    rbacModule,
  };
}

function createTestApp(modules: RuntimeModules) {
  const app = new Hono();
  app.route("/api", modules.appRoutesModule.appRoutes);
  app.route("/api/app/workflow", modules.workflowRoutesModule.workflowRoutes);
  app.route("/api/app/jobs", modules.jobRoutesModule.jobRoutes);
  app.route("/api/app/share", modules.shareRoutesModule.shareRoutes);
  app.route("/api/public/share", modules.shareRoutesModule.publicShareRoutes);

  app.get("/api/app/agents", (c) => {
    try {
      return c.json(
        modules.services.listAgents(modules.rbacModule.requirePrivateWorkspaceRole(c, "viewer")),
      );
    } catch (error) {
      return errorResponse(c, error);
    }
  });
  app.post("/api/app/agents", async (c) => {
    try {
      return c.json(
        modules.services.createAgent(
          modules.rbacModule.requirePrivateWorkspaceRole(c, "admin"),
          await readJsonBody(c),
        ),
        201,
      );
    } catch (error) {
      return errorResponse(c, error);
    }
  });
  app.post("/api/app/agents/:agentId/runs", async (c) => {
    try {
      const body = (await readJsonBody(c)) as {
        triggerKind?: string;
        inputs?: Record<string, unknown>;
        toolApproval?: unknown;
      };
      const result = await modules.services.runAgent(
        modules.rbacModule.requirePrivateWorkspaceRole(c, "member"),
        c.req.param("agentId"),
        {
          triggerKind: body.triggerKind,
          inputs: body.inputs ?? {},
          toolApproval: body.toolApproval as never,
        },
      );
      return c.json(result, "approval" in result ? 200 : 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  return app;
}

function resetSqliteStore(modules: RuntimeModules) {
  modules.store.resetStoreForTests();
}

async function runIndexedRouteScenario(modules: RuntimeModules, label: string) {
  if (label === "json") {
    delete process.env.PACKETAGENT_STORE;
    delete process.env.PACKETAGENT_DB_PATH;
  }

  modules.appRoutesModule.resetAppRouteSecurityForTests();
  modules.store.resetStoreForTests();
  const app = createTestApp(modules);
  const alpha = modules.services.login({ email: "alpha@packetagent.local", password: "demo12345" });

  const session = await app.request("/api/auth/session", {
    headers: authHeaders(alpha.cookieValue),
  });
  const sessionBody = (await session.json()) as {
    authenticated: boolean;
    user: { email: string };
    workspace: { id: string };
  };

  const invitation = await app.request("/api/app/invitations", {
    method: "POST",
    headers: { ...authHeaders(alpha.cookieValue), "content-type": "application/json" },
    body: JSON.stringify({ email: "indexed.parity@example.com", role: "member" }),
  });
  const invitationBody = (await invitation.json()) as {
    invitation: { id: string; email: string; role: string; status: string; token?: string };
  };

  const members = await app.request("/api/app/members", {
    headers: authHeaders(alpha.cookieValue),
  });
  const membersBody = (await members.json()) as {
    invitations: Array<{
      email: string;
      role: string;
      status: string;
      token?: string;
      tokenPreview?: string;
    }>;
  };

  const resent = await app.request(`/api/app/invitations/${invitationBody.invitation.id}/resend`, {
    method: "POST",
    headers: authHeaders(alpha.cookieValue),
  });
  const resentBody = (await resent.json()) as { invitation: { token?: string; status: string } };

  const revoked = await app.request(`/api/app/invitations/${invitationBody.invitation.id}/revoke`, {
    method: "POST",
    headers: authHeaders(alpha.cookieValue),
  });
  const revokedBody = (await revoked.json()) as {
    invitation: { status: string; revokedAt: string | null };
  };

  const revokedAccept = await app.request(
    `/api/app/invitations/${resentBody.invitation.token ?? "missing"}/accept`,
    {
      method: "POST",
      headers: authHeaders(alpha.cookieValue),
    },
  );
  const invitationDeliveryCount = modules.store
    .loadStore()
    .invitationEmailDeliveries.filter(
      (entry: { invitationId: string }) => entry.invitationId === invitationBody.invitation.id,
    ).length;

  const share = await app.request("/api/app/share", {
    method: "POST",
    headers: { ...authHeaders(alpha.cookieValue), "content-type": "application/json" },
    body: JSON.stringify({ scope: "overview" }),
  });
  const shareBody = (await share.json()) as {
    token: { id: string; token: string; scope: string; readCount: number };
  };

  const publicShare = await app.request(`/api/public/share/${shareBody.token.token}`);
  const publicShareBody = (await publicShare.json()) as {
    shared: { scope: string; workspace: { id: string } };
  };

  const shareList = await app.request("/api/app/share", {
    headers: authHeaders(alpha.cookieValue),
  });
  const shareListBody = (await shareList.json()) as {
    tokens: Array<{ id: string; scope: string; readCount: number; lastReadAt?: string }>;
  };
  const listedToken = shareListBody.tokens.find((token) => token.id === shareBody.token.id);

  const crossOriginMutation = await app.request("/api/app/workspace", {
    method: "PATCH",
    headers: {
      ...authHeaders(alpha.cookieValue),
      "content-type": "application/json",
      host: "localhost",
      origin: "https://evil.example",
    },
    body: JSON.stringify({ name: "Blocked", website: "", automationGoal: "" }),
  });
  const crossOriginBody = (await crossOriginMutation.json()) as { error: string };

  const sameOriginMissingCsrf = await app.request("/api/app/workspace", {
    method: "PATCH",
    headers: {
      ...authHeaders(alpha.cookieValue),
      "content-type": "application/json",
      host: "localhost",
      origin: "http://localhost",
    },
    body: JSON.stringify({ name: "Blocked", website: "", automationGoal: "" }),
  });
  const sameOriginMissingCsrfBody = (await sameOriginMissingCsrf.json()) as { error: string };

  const rateLimitIp = "203.0.113.77";
  let rateLimitAttemptStatus = 0;
  for (let index = 0; index < 21; index += 1) {
    const response = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": rateLimitIp },
      body: JSON.stringify({ email: "alpha@packetagent.local", password: "wrong-password" }),
    });
    rateLimitAttemptStatus = response.status;
  }
  const rateLimitBucket = (modules.store.loadStore().rateLimits ?? []).find(
    (entry: { id: string }) => entry.id.startsWith("auth:login:sha256:"),
  );

  return {
    session: {
      status: session.status,
      authenticated: sessionBody.authenticated,
      email: sessionBody.user.email,
      workspaceId: sessionBody.workspace.id,
    },
    invitation: {
      createStatus: invitation.status,
      listStatus: members.status,
      created: {
        email: invitationBody.invitation.email,
        role: invitationBody.invitation.role,
        status: invitationBody.invitation.status,
        hasToken: Boolean(invitationBody.invitation.token),
      },
      listed: membersBody.invitations.some(
        (entry) =>
          entry.email === "indexed.parity@example.com" &&
          entry.role === "member" &&
          entry.status === "pending" &&
          !entry.token &&
          Boolean(entry.tokenPreview),
      ),
      resendStatus: resent.status,
      resendRotatedToken:
        Boolean(resentBody.invitation.token) &&
        resentBody.invitation.token !== invitationBody.invitation.token,
      revokeStatus: revoked.status,
      revokedStatus: revokedBody.invitation.status,
      revokedAt: Boolean(revokedBody.invitation.revokedAt),
      revokedAcceptStatus: revokedAccept.status,
      deliveryCount: invitationDeliveryCount,
    },
    share: {
      createStatus: share.status,
      publicStatus: publicShare.status,
      listStatus: shareList.status,
      scope: shareBody.token.scope,
      initialReadCount: shareBody.token.readCount,
      publicScope: publicShareBody.shared.scope,
      publicWorkspaceId: publicShareBody.shared.workspace.id,
      listedReadCount: listedToken?.readCount,
      listedLastReadAt: Boolean(listedToken?.lastReadAt),
    },
    security: {
      crossOriginStatus: crossOriginMutation.status,
      crossOriginError: crossOriginBody.error,
      sameOriginMissingCsrfStatus: sameOriginMissingCsrf.status,
      sameOriginMissingCsrfError: sameOriginMissingCsrfBody.error,
      rateLimitStatus: rateLimitAttemptStatus,
      rateLimitCount: rateLimitBucket?.count,
      rateLimitRawIpStored: rateLimitBucket?.id.includes(rateLimitIp) ?? false,
    },
  };
}

async function runInvitationDeliveryModeScenario(modules: RuntimeModules, label: string) {
  if (label === "json") {
    delete process.env.PACKETAGENT_STORE;
    delete process.env.PACKETAGENT_DB_PATH;
  }

  modules.appRoutesModule.resetAppRouteSecurityForTests();
  modules.store.resetStoreForTests();
  const app = createTestApp(modules);
  const alpha = modules.services.login({ email: "alpha@packetagent.local", password: "demo12345" });

  const created = await app.request("/api/app/invitations", {
    method: "POST",
    headers: { ...authHeaders(alpha.cookieValue), "content-type": "application/json" },
    body: JSON.stringify({ email: "skip.delivery@example.com", role: "member" }),
  });
  const createdBody = (await created.json()) as {
    invitation: { id: string };
    emailDelivery: { status: string; error: string | null };
  };
  const deliveries = modules.store
    .loadStore()
    .invitationEmailDeliveries.filter(
      (entry: { invitationId: string }) => entry.invitationId === createdBody.invitation.id,
    );
  const delivery = deliveries[0] as
    | { status: string; provider: string; mode: string; sentAt?: string; error?: string }
    | undefined;

  return {
    createStatus: created.status,
    responseDeliveryStatus: createdBody.emailDelivery.status,
    responseDeliveryError: createdBody.emailDelivery.error,
    deliveryCount: deliveries.length,
    deliveryStatus: delivery?.status,
    deliveryProvider: delivery?.provider,
    deliveryMode: delivery?.mode,
    deliverySentAt: Boolean(delivery?.sentAt),
    deliveryError: delivery?.error,
  };
}

function setAlphaRole(modules: RuntimeModules, role: "owner" | "admin" | "member" | "viewer") {
  modules.store.mutateStore(
    (data: { memberships: Array<{ workspaceId: string; userId: string; role: string }> }) => {
      const membership = data.memberships.find(
        (entry) => entry.workspaceId === "alpha" && entry.userId === "user_alpha",
      );
      assert.ok(membership, "expected alpha membership");
      membership.role = role;
    },
  );
}

function authHeaders(cookieValue: string) {
  return { Cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` };
}

function cookieValue(response: Response) {
  const cookie = response.headers.get("set-cookie") ?? "";
  const match = cookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  assert.ok(match?.[1], "expected response to set a session cookie");
  return match[1];
}

async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.includes("application/json")) return {};
  const body = await c.req.json();
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function errorResponse(c: Context, error: unknown) {
  c.status(((error as Error & { status?: number }).status ?? 500) as 500);
  return c.json({ error: (error as Error).message });
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
