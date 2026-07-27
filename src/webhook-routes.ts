import { randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { requirePrivateWorkspaceRole } from "./rbac.js";
import { findAgent, loadStoreAsync, mutateStoreAsync } from "./packetagent-store.js";
import { enqueueJobAsync } from "./jobs/store.js";
import { redactedErrorMessage } from "./security/redaction.js";

function errorResponse(c: Context, error: unknown) {
  c.status(((error as Error & { status?: number }).status ?? 500) as 500);
  return c.json({ error: redactedErrorMessage(error) });
}

function nowIso(): string {
  return new Date().toISOString();
}

function generateWebhookToken(): string {
  return "whk_" + randomBytes(18).toString("base64url");
}

export const agentWebhookRoutes = new Hono();

agentWebhookRoutes.post("/agents/:agentId/rotate", async (c) => {
  try {
    const ctx = requirePrivateWorkspaceRole(c, "admin");
    const id = c.req.param("agentId");
    const updated = await mutateStoreAsync((data) => {
      const agent = findAgent(data, id);
      if (!agent || agent.workspaceId !== ctx.workspace.id) return null;
      agent.webhookToken = generateWebhookToken();
      agent.updatedAt = nowIso();
      return agent;
    });
    if (!updated) return errorResponse(c, Object.assign(new Error("agent not found"), { status: 404 }));
    return c.json({ webhookToken: updated.webhookToken });
  } catch (error) {
    return errorResponse(c, error);
  }
});

agentWebhookRoutes.delete("/agents/:agentId", async (c) => {
  try {
    const ctx = requirePrivateWorkspaceRole(c, "admin");
    const id = c.req.param("agentId");
    const ok = await mutateStoreAsync((data) => {
      const agent = findAgent(data, id);
      if (!agent || agent.workspaceId !== ctx.workspace.id) return false;
      delete agent.webhookToken;
      agent.updatedAt = nowIso();
      return true;
    });
    if (!ok) return errorResponse(c, Object.assign(new Error("agent not found"), { status: 404 }));
    return c.json({ ok: true });
  } catch (error) {
    return errorResponse(c, error);
  }
});

export const publicWebhookRoutes = new Hono();

publicWebhookRoutes.post("/agents/:token", async (c) => {
  try {
    const tokenParam = c.req.param("token");
    const data = await loadStoreAsync();
    const agent = data.agents.find((a) => a.webhookToken === tokenParam && a.status !== "archived");
    if (!agent) return errorResponse(c, Object.assign(new Error("not found"), { status: 404 }));
    let body: Record<string, unknown> = {};
    try { body = (await c.req.json()) as Record<string, unknown>; }
    catch { body = {}; }
    const job = await enqueueJobAsync({
      workspaceId: agent.workspaceId,
      type: "agent.run",
      payload: { agentId: agent.id, triggerKind: "webhook", inputs: body },
    });
    return c.json({ accepted: true, jobId: job.id });
  } catch (error) {
    return errorResponse(c, error);
  }
});
