import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { appRoutes, resetAppRouteSecurityForTests } from "./app-routes.js";
import { SESSION_COOKIE_NAME } from "./auth-utils.js";
import { enforcePrivateAppMutationSecurity } from "./route-security.js";
import { loadStore, resetStoreForTests } from "./packetagent-store.js";

// This suite asserts the shipped default, so it must not set
// PACKETAGENT_REGISTRATION_MODE.

function createTestApp() {
  const app = new Hono();
  app.use("/api/app/*", enforcePrivateAppMutationSecurity);
  app.route("/api", appRoutes);
  return app;
}

function sessionCookie(response: Response): string {
  const cookie = response.headers.get("set-cookie") ?? "";
  const match = cookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  assert.ok(match?.[1], "expected a session cookie");
  return match[1];
}

function csrfCookie(response: Response): string {
  const cookie = response.headers.get("set-cookie") ?? "";
  const match = cookie.match(/packetagent_csrf=([^;]+)/);
  assert.ok(match?.[1], "expected a csrf cookie");
  return match[1];
}

async function registerViaApi(
  app: Hono,
  body: Record<string, unknown>,
): Promise<{ status: number; payload: Record<string, unknown>; response: Response }> {
  const response = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    payload: (await response.clone().json()) as Record<string, unknown>,
    response,
  };
}

function resetAll() {
  delete process.env.PACKETAGENT_REGISTRATION_MODE;
  resetStoreForTests();
  resetAppRouteSecurityForTests();
}

test("an uninvited stranger cannot register on a seeded instance", async () => {
  resetAll();
  const app = createTestApp();
  const before = loadStore().users.length;
  assert.ok(before > 0, "the seeded store must already have a user");

  const { status, payload } = await registerViaApi(app, {
    email: "stranger@example.com",
    password: "demo12345",
    displayName: "Stranger",
  });

  assert.equal(status, 403);
  assert.match(String(payload.error), /invite-only/i);
  assert.equal(loadStore().users.length, before, "no user record may be created");
});

test("a bad invitation token is refused without revealing why", async () => {
  resetAll();
  const app = createTestApp();

  const { status, payload } = await registerViaApi(app, {
    email: "stranger@example.com",
    password: "demo12345",
    displayName: "Stranger",
    invitationToken: "not-a-real-token",
  });

  assert.equal(status, 403);
  assert.equal(String(payload.error), "invitation is not valid for this email address");
});

test("an invited address registers and lands in the inviting workspace", async () => {
  resetAll();
  const app = createTestApp();

  // Sign in as the seeded owner and issue an invitation.
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "alpha@packetagent.local", password: "demo12345" }),
  });
  assert.equal(login.status, 200);
  const cookie = sessionCookie(login);
  const csrf = csrfCookie(login);
  const owner = (await login.json()) as { workspace: { id: string } };

  const invite = await app.request("/api/app/invitations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Cookie: `${SESSION_COOKIE_NAME}=${cookie}; packetagent_csrf=${csrf}`,
      Origin: "http://localhost",
      Host: "localhost",
      "X-CSRF-Token": csrf,
    },
    body: JSON.stringify({ email: "invited@example.com", role: "member" }),
  });
  assert.equal(invite.status, 201);

  const invitation = loadStore().workspaceInvitations.find(
    (record) => record.email === "invited@example.com",
  );
  assert.ok(invitation, "the invitation must be persisted");

  const { status, payload } = await registerViaApi(app, {
    email: "invited@example.com",
    password: "demo12345",
    displayName: "Invited Person",
    invitationToken: invitation.token,
  });

  assert.equal(status, 201);
  assert.equal((payload.user as { email: string }).email, "invited@example.com");

  const store = loadStore();
  const created = store.users.find((user) => user.email === "invited@example.com");
  assert.ok(created, "the account must exist");
  assert.ok(
    store.memberships.some(
      (m) => m.userId === created.id && m.workspaceId === owner.workspace.id && m.role === "member",
    ),
    "the new account must join the inviting workspace with the invited role",
  );

  const consumed = store.workspaceInvitations.find((record) => record.id === invitation.id);
  assert.equal(consumed?.acceptedByUserId, created.id, "the invitation must be consumed");

  // The same token must not admit a second account.
  const replay = await registerViaApi(app, {
    email: "invited@example.com",
    password: "demo12345",
    displayName: "Impostor",
    invitationToken: invitation.token,
  });
  assert.equal(replay.status, 409, "the address is taken; the token is also spent");
});
