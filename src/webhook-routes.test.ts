import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { SESSION_COOKIE_NAME } from "./auth-utils";
import { findJob } from "./jobs/store";
import { login } from "./packetagent-services";
import { loadStore, mutateStore, resetStoreForTests } from "./packetagent-store";
import { agentWebhookRoutes, publicWebhookRoutes } from "./webhook-routes";

function createTestApp() {
  const app = new Hono();
  app.route("/api/app/webhooks", agentWebhookRoutes);
  app.route("/api/public/webhooks", publicWebhookRoutes);
  return app;
}

function authHeaders(cookieValue: string) {
  return { Cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` };
}

test("webhook token rotation and deletion are workspace-scoped", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });

  const rotateResponse = await app.request("/api/app/webhooks/agents/agent_alpha_support/rotate", {
    method: "POST",
    headers: authHeaders(alpha.cookieValue),
  });
  const rotateBody = await rotateResponse.json() as { webhookToken: string };

  assert.equal(rotateResponse.status, 200);
  assert.match(rotateBody.webhookToken, /^whk_/);
  assert.equal(loadStore().agents.find((agent) => agent.id === "agent_alpha_support")?.webhookToken, rotateBody.webhookToken);

  const crossWorkspaceResponse = await app.request("/api/app/webhooks/agents/agent_beta_dependency_watch/rotate", {
    method: "POST",
    headers: authHeaders(alpha.cookieValue),
  });
  const crossWorkspaceBody = await crossWorkspaceResponse.json();

  assert.equal(crossWorkspaceResponse.status, 404);
  assert.deepEqual(crossWorkspaceBody, { error: "agent not found" });

  const deleteResponse = await app.request("/api/app/webhooks/agents/agent_alpha_support", {
    method: "DELETE",
    headers: authHeaders(alpha.cookieValue),
  });
  const deleteBody = await deleteResponse.json();

  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(deleteBody, { ok: true });
  assert.equal(loadStore().agents.find((agent) => agent.id === "agent_alpha_support")?.webhookToken, undefined);
});

test("webhook token management requires an admin role", async () => {
  resetStoreForTests();
  const app = createTestApp();
  const alpha = login({ email: "alpha@packetagent.local", password: "demo12345" });
  mutateStore((data) => {
    const membership = data.memberships.find((entry) => entry.workspaceId === "alpha" && entry.userId === "user_alpha");
    assert.ok(membership);
    membership.role = "viewer";
  });

  const response = await app.request("/api/app/webhooks/agents/agent_alpha_support/rotate", {
    method: "POST",
    headers: authHeaders(alpha.cookieValue),
  });
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.deepEqual(body, { error: "workspace role admin is required" });
});

test("public webhook enqueues an agent run job with request inputs", async () => {
  resetStoreForTests();
  const app = createTestApp();
  mutateStore((data) => {
    const agent = data.agents.find((entry) => entry.id === "agent_alpha_support");
    assert.ok(agent);
    agent.webhookToken = "whk_route_test_alpha";
  });

  const response = await app.request("/api/public/webhooks/agents/whk_route_test_alpha", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticketId: "T-123", priority: "high" }),
  });
  const body = await response.json() as { accepted: boolean; jobId: string };
  const job = findJob(body.jobId);

  assert.equal(response.status, 200);
  assert.equal(body.accepted, true);
  assert.equal(job?.workspaceId, "alpha");
  assert.equal(job?.type, "agent.run");
  assert.deepEqual(job?.payload, {
    agentId: "agent_alpha_support",
    triggerKind: "webhook",
    inputs: { ticketId: "T-123", priority: "high" },
  });
});

test("public webhook ignores archived agents even when token matches", async () => {
  resetStoreForTests();
  const app = createTestApp();
  mutateStore((data) => {
    const agent = data.agents.find((entry) => entry.id === "agent_alpha_support");
    assert.ok(agent);
    agent.webhookToken = "whk_route_test_archived";
    agent.status = "archived";
  });

  const response = await app.request("/api/public/webhooks/agents/whk_route_test_archived", {
    method: "POST",
  });
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.deepEqual(body, { error: "not found" });
});
