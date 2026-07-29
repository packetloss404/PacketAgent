import { randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { requirePrivateWorkspaceRole } from "./rbac.js";
import { findAgent, loadStoreAsync, mutateStoreAsync } from "./packetagent-store.js";
import { enqueueJobAsync } from "./jobs/store.js";
import { redactedErrorMessage } from "./security/redaction.js";
import { workerTraceFromTraceparent } from "./workers/activation.js";
import { activateWorkerWebhookDelivery } from "./workers/adapters.js";
import { WorkerLifecycleError } from "./workers/errors.js";
import type { JsonObject } from "./workers/types.js";

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
    if (!updated)
      return errorResponse(c, Object.assign(new Error("agent not found"), { status: 404 }));
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
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
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

publicWebhookRoutes.post("/workers/:webhookRef", async (c) => {
  try {
    const deliveryId =
      c.req.header("x-packetagent-delivery-id")?.trim() ??
      c.req.header("idempotency-key")?.trim() ??
      "";
    if (!deliveryId) {
      throw new WorkerLifecycleError(
        "invalid_input",
        "X-PacketAgent-Delivery-Id or Idempotency-Key header is required.",
      );
    }
    if (deliveryId.length > 512) {
      throw new WorkerLifecycleError(
        "invalid_input",
        "Worker webhook delivery ID must be at most 512 characters.",
      );
    }
    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new WorkerLifecycleError(
        "invalid_input",
        "Worker webhook body must be application/json.",
      );
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new WorkerLifecycleError("invalid_input", "Worker webhook body must be valid JSON.");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new WorkerLifecycleError("invalid_input", "Worker webhook body must be a JSON object.");
    }
    const result = await activateWorkerWebhookDelivery({
      webhookRef: c.req.param("webhookRef"),
      deliveryId,
      occurredAt: c.req.header("x-packetagent-occurred-at")?.trim() || undefined,
      payload: body as JsonObject,
      trace: workerTraceFromTraceparent(c.req.header("traceparent"), c.req.header("tracestate")),
    });
    return c.json(result, 202);
  } catch (error) {
    return errorResponse(c, error);
  }
});
