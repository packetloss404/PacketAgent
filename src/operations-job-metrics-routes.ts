import { Hono, type Context } from "hono";
import { requirePrivateWorkspaceRole } from "./rbac.js";
import { listJobMetricSnapshotsAsync } from "./jobs/job-metrics-snapshot.js";
import { redactedErrorMessage } from "./security/redaction.js";

export const operationsJobMetricsRoutes = new Hono();

operationsJobMetricsRoutes.get("/history", async (c: Context) => {
  try {
    requirePrivateWorkspaceRole(c, "admin");
    const type = c.req.query("type") || undefined;
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
    const snapshots = await listJobMetricSnapshotsAsync({ type, since, until, limit });
    return c.json({ snapshots });
  } catch (error) {
    const status = ((error as { status?: number }).status ?? 500) as 401 | 403 | 404 | 500;
    return c.json({ error: redactedErrorMessage(error) }, status);
  }
});
