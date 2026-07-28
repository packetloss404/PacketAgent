import assert from "node:assert/strict";
import test from "node:test";
import { Hono, type Context } from "hono";
import { SESSION_COOKIE_NAME } from "./auth-utils.js";
import {
  WORKSPACE_ROLE_DEFINITIONS,
  WORKSPACE_ROLES,
  WorkspaceAccessError,
  assertPermission,
  canEditWorkflow,
  canManageWorkspace,
  canViewWorkspace,
  getWorkspaceRole,
  hasWorkspacePermission,
  hasWorkspaceRole,
  requirePrivateWorkspace,
  requirePrivateWorkspaceAsync,
  requirePrivateWorkspacePermission,
  requirePrivateWorkspacePermissionAsync,
  requirePrivateWorkspaceRole,
  requirePrivateWorkspaceRoleAsync,
  requireWorkspaceRole,
} from "./rbac";
import { login } from "./packetagent-services.js";
import { mutateStore, resetStoreForTests } from "./packetagent-store.js";

test("workspace roles are ordered from least to most privileged", () => {
  assert.deepEqual(WORKSPACE_ROLES, ["viewer", "member", "admin", "owner"]);

  assert.equal(WORKSPACE_ROLE_DEFINITIONS.viewer.rank < WORKSPACE_ROLE_DEFINITIONS.member.rank, true);
  assert.equal(WORKSPACE_ROLE_DEFINITIONS.member.rank < WORKSPACE_ROLE_DEFINITIONS.admin.rank, true);
  assert.equal(WORKSPACE_ROLE_DEFINITIONS.admin.rank < WORKSPACE_ROLE_DEFINITIONS.owner.rank, true);
});

test("workspace permission helpers follow the role hierarchy", () => {
  const viewer = { role: "viewer" };
  const member = { role: "member" };
  const admin = { role: "admin" };
  const owner = { role: "owner" };

  assert.equal(canViewWorkspace(viewer), true);
  assert.equal(canEditWorkflow(viewer), false);
  assert.equal(canManageWorkspace(viewer), false);

  assert.equal(canViewWorkspace(member), true);
  assert.equal(canEditWorkflow(member), true);
  assert.equal(canManageWorkspace(member), false);

  assert.equal(canViewWorkspace(admin), true);
  assert.equal(canEditWorkflow(admin), true);
  assert.equal(canManageWorkspace(admin), true);

  assert.equal(canViewWorkspace(owner), true);
  assert.equal(canEditWorkflow(owner), true);
  assert.equal(canManageWorkspace(owner), true);
});

test("Worker operator permissions separate inspection, run control, deployment control, and approval", () => {
  const viewer = { role: "viewer" };
  const member = { role: "member" };
  const admin = { role: "admin" };

  assert.equal(hasWorkspacePermission(viewer, "inspectWorkers"), true);
  assert.equal(hasWorkspacePermission(viewer, "controlWorkerRuns"), false);

  assert.equal(hasWorkspacePermission(member, "inspectWorkers"), true);
  assert.equal(hasWorkspacePermission(member, "controlWorkerRuns"), true);
  assert.equal(hasWorkspacePermission(member, "controlWorkerDeployments"), false);
  assert.equal(hasWorkspacePermission(member, "approveWorkerActions"), false);

  assert.equal(hasWorkspacePermission(admin, "controlWorkerRuns"), true);
  assert.equal(hasWorkspacePermission(admin, "controlWorkerDeployments"), true);
  assert.equal(hasWorkspacePermission(admin, "approveWorkerActions"), true);
});

test("role checks accept higher roles for lower requirements", () => {
  assert.equal(hasWorkspaceRole({ role: "owner" }, "viewer"), true);
  assert.equal(hasWorkspaceRole({ role: "admin" }, "member"), true);
  assert.equal(hasWorkspaceRole({ role: "member" }, "admin"), false);
  assert.equal(requireWorkspaceRole({ role: "owner" }, "admin"), "owner");
});

test("invalid or missing membership has no permissions", () => {
  assert.equal(getWorkspaceRole(null), null);
  assert.equal(getWorkspaceRole(undefined), null);
  assert.equal(getWorkspaceRole({ role: null }), null);
  assert.equal(getWorkspaceRole({ role: "billing" }), null);

  for (const membership of [null, undefined, { role: null }, { role: "billing" }]) {
    assert.equal(canViewWorkspace(membership), false);
    assert.equal(canEditWorkflow(membership), false);
    assert.equal(canManageWorkspace(membership), false);
  }
});

test("assert helpers throw for missing, invalid, or insufficient role", () => {
  assert.throws(() => requireWorkspaceRole(null, "viewer"), WorkspaceAccessError);
  assert.throws(() => requireWorkspaceRole({ role: "billing" }, "viewer"), WorkspaceAccessError);
  assert.throws(() => requireWorkspaceRole({ role: "viewer" }, "member"), WorkspaceAccessError);
  assert.throws(() => assertPermission({ role: "member" }, "manageWorkspace"), WorkspaceAccessError);

  assert.equal(assertPermission({ role: "admin" }, "manageWorkspace"), "admin");
});

test("route policy helpers require an authenticated session", async () => {
  resetStoreForTests();
  const app = createPolicyApp();

  const response = await app.request("/private");

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "authentication required" });
});

test("route policy helpers reject malformed workspace memberships", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  mutateStore((data) => {
    const membership = data.memberships.find((entry) => entry.workspaceId === "alpha" && entry.userId === "user_alpha");
    assert.ok(membership);
    membership.role = "billing" as typeof membership.role;
  });
  const app = createPolicyApp("membership");

  const response = await app.request("/private", { headers: authHeaders(auth.cookieValue) });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "workspace membership is required" });
});

test("route policy helpers reject insufficient workspace permissions", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  mutateStore((data) => {
    const membership = data.memberships.find((entry) => entry.workspaceId === "alpha" && entry.userId === "user_alpha");
    assert.ok(membership);
    membership.role = "viewer";
  });
  const app = createPolicyApp();

  const response = await app.request("/private", { headers: authHeaders(auth.cookieValue) });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "workspace role member is required" });
});

test("route policy helpers return the authenticated context when permission is allowed", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  mutateStore((data) => {
    const membership = data.memberships.find((entry) => entry.workspaceId === "alpha" && entry.userId === "user_alpha");
    assert.ok(membership);
    membership.role = "member";
  });
  const app = createPolicyApp();

  const response = await app.request("/private", { headers: authHeaders(auth.cookieValue) });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { workspaceId: "alpha", userId: "user_alpha" });
});

test("route role policy helper accepts roles above the minimum", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  const app = createPolicyApp("role");

  const response = await app.request("/private", { headers: authHeaders(auth.cookieValue) });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { workspaceId: "alpha", userId: "user_alpha" });
});

test("async route policy helpers return the authenticated context when permission is allowed", async () => {
  resetStoreForTests();
  const auth = login({ email: "alpha@packetagent.local", password: "demo12345" });
  mutateStore((data) => {
    const membership = data.memberships.find((entry) => entry.workspaceId === "alpha" && entry.userId === "user_alpha");
    assert.ok(membership);
    membership.role = "member";
  });
  const app = createAsyncPolicyApp();

  const response = await app.request("/private", { headers: authHeaders(auth.cookieValue) });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { workspaceId: "alpha", userId: "user_alpha" });
});

function createPolicyApp(mode: "permission" | "membership" | "role" = "permission") {
  const app = new Hono();
  app.get("/private", (c) => {
    try {
      const context = routePolicyContext(c, mode);
      return c.json({ workspaceId: context.workspace.id, userId: context.user.id });
    } catch (error) {
      return errorResponse(c, error);
    }
  });
  return app;
}

function createAsyncPolicyApp(mode: "permission" | "membership" | "role" = "permission") {
  const app = new Hono();
  app.get("/private", async (c) => {
    try {
      const context = await asyncRoutePolicyContext(c, mode);
      return c.json({ workspaceId: context.workspace.id, userId: context.user.id });
    } catch (error) {
      return errorResponse(c, error);
    }
  });
  return app;
}

function routePolicyContext(c: Context, mode: "permission" | "membership" | "role") {
  if (mode === "membership") return requirePrivateWorkspace(c);
  if (mode === "role") return requirePrivateWorkspaceRole(c, "admin");
  return requirePrivateWorkspacePermission(c, "editWorkflow");
}

function asyncRoutePolicyContext(c: Context, mode: "permission" | "membership" | "role") {
  if (mode === "membership") return requirePrivateWorkspaceAsync(c);
  if (mode === "role") return requirePrivateWorkspaceRoleAsync(c, "admin");
  return requirePrivateWorkspacePermissionAsync(c, "editWorkflow");
}

function authHeaders(cookieValue: string) {
  return { Cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` };
}

function errorResponse(c: Context, error: unknown) {
  c.status(((error as Error & { status?: number }).status ?? 500) as any);
  return c.json({ error: (error as Error).message });
}
