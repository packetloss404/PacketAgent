import { Hono, type Context } from "hono";
import { requirePrivateWorkspaceRole } from "./rbac.js";
import { listAlertsAsync } from "./alerts/alert-store.js";
import type { AlertSeverity } from "./alerts/alert-engine.js";
import { redactedErrorMessage } from "./security/redaction.js";

const ALLOWED_SEVERITIES: ReadonlySet<AlertSeverity> = new Set<AlertSeverity>([
  "info",
  "warning",
  "critical",
]);

export const operationsAlertsRoutes = new Hono();

operationsAlertsRoutes.get("/", async (c: Context) => {
  try {
    requirePrivateWorkspaceRole(c, "admin");
    const severityRaw = c.req.query("severity") || undefined;
    if (severityRaw !== undefined && !ALLOWED_SEVERITIES.has(severityRaw as AlertSeverity)) {
      return c.json({ error: "invalid severity" }, 400);
    }
    const since = c.req.query("since") || undefined;
    const until = c.req.query("until") || undefined;
    if (since !== undefined && Number.isNaN(Date.parse(since))) {
      return c.json({ error: "invalid since" }, 400);
    }
    if (until !== undefined && Number.isNaN(Date.parse(until))) {
      return c.json({ error: "invalid until" }, 400);
    }
    const limitRaw = c.req.query("limit");
    const limit = limitRaw
      ? Math.max(1, Math.min(500, Number.parseInt(limitRaw, 10) || 100))
      : undefined;
    const alerts = await listAlertsAsync({
      severity: severityRaw as AlertSeverity | undefined,
      since,
      until,
      limit,
    });
    return c.json({ alerts });
  } catch (error) {
    const status = ((error as { status?: number }).status ?? 500) as 401 | 403 | 404 | 500;
    return c.json({ error: redactedErrorMessage(error) }, status);
  }
});
