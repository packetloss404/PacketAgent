import { Hono, type Context } from "hono";
import { parseInvitationEmailReconciliationBody } from "./invitation-email-reconciliation.js";
import { resolveInvitationEmailReconciliationConfig } from "./invitation-email.js";
import { redactedErrorMessage } from "./security/redaction.js";
import { mutateStoreAsync, recordInvitationEmailProviderStatus } from "./packetagent-store.js";

function errorResponse(c: Context, error: unknown) {
  c.status(((error as Error & { status?: number }).status ?? 500) as 500);
  return c.json({ error: redactedErrorMessage(error) });
}

async function readJsonBody(c: Context): Promise<unknown> {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw Object.assign(new Error("request body must be valid JSON"), { status: 400 });
  }
  try {
    return await c.req.json();
  } catch {
    throw Object.assign(new Error("request body must be valid JSON"), { status: 400 });
  }
}

export const invitationEmailWebhookRoutes = new Hono();

invitationEmailWebhookRoutes.post("/", async (c) => {
  try {
    const config = resolveInvitationEmailReconciliationConfig();
    if (!config.secret) {
      return c.json(
        {
          error:
            "reconciliation webhook is disabled; set PACKETAGENT_INVITATION_EMAIL_RECONCILIATION_SECRET",
        },
        503,
      );
    }

    const provided = c.req.header(config.secretHeader);
    if (!provided || provided !== config.secret) {
      return c.json({ error: "unauthorized" }, 401);
    }

    let body: unknown;
    try {
      body = await readJsonBody(c);
    } catch {
      return c.json({ error: "request body must be valid JSON" }, 400);
    }

    const parsed = parseInvitationEmailReconciliationBody(body);
    if (!parsed.ok) {
      if (parsed.reason === "validation") {
        return c.json({ error: "invalid request", field: parsed.field }, 400);
      }
      if (parsed.reason === "invalid_status") {
        return c.json(
          { error: "invalid provider status", providerStatus: parsed.providerStatus },
          400,
        );
      }
      return c.json({ error: "invalid request" }, 400);
    }

    const appliedAt = parsed.input.occurredAt ?? new Date().toISOString();
    const updated = await mutateStoreAsync((data) =>
      recordInvitationEmailProviderStatus(data, {
        deliveryId: parsed.input.deliveryId,
        providerStatus: parsed.input.providerStatus,
        providerDeliveryId: parsed.input.providerDeliveryId,
        providerError: parsed.input.providerError,
        occurredAt: appliedAt,
      }),
    );
    if (!updated) {
      return c.json({ error: "delivery not found", deliveryId: parsed.input.deliveryId }, 404);
    }

    return c.json({
      ok: true,
      deliveryId: updated.id,
      invitationId: updated.invitationId,
      workspaceId: updated.workspaceId,
      providerStatus: parsed.input.providerStatus,
      appliedAt,
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});
