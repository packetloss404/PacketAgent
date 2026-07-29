import { Hono, type Context } from "hono";
import { requirePrivateWorkspaceRole } from "./rbac.js";
import { cancelJobAsync, enqueueJobAsync, findJobAsync, listJobsAsync } from "./jobs/store.js";
import { parseCron } from "./jobs/cron.js";
import { loadStoreAsync } from "./packetagent-store.js";
import type { JobRecord, JobStatus } from "./packetagent-store.js";
import { redactSensitiveString, redactSensitiveValue } from "./security/redaction.js";

function errorResponse(c: Context, error: unknown) {
  c.status(((error as Error & { status?: number }).status ?? 500) as 500);
  return c.json({ error: redactSensitiveString((error as Error).message) });
}

function serializeJob(job: JobRecord): JobRecord {
  return {
    ...job,
    payload: redactSensitiveValue(job.payload) as Record<string, unknown>,
    result: redactSensitiveValue(job.result),
    error: job.error ? redactSensitiveString(job.error) : undefined,
  };
}

function badRequest(message: string) {
  return Object.assign(new Error(message), { status: 400 });
}

async function validateJobInput(
  body: Partial<{
    type: string;
    payload: Record<string, unknown>;
    scheduledAt: string;
    cron: string;
    maxAttempts: number;
  }>,
  workspaceId: string,
) {
  if (body.scheduledAt !== undefined && Number.isNaN(Date.parse(body.scheduledAt))) {
    throw badRequest("scheduledAt must be a valid date");
  }
  if (body.cron !== undefined) {
    try {
      parseCron(body.cron);
    } catch {
      throw badRequest("cron must be a valid 5-field expression");
    }
  }
  if (
    body.maxAttempts !== undefined &&
    (!Number.isInteger(body.maxAttempts) || body.maxAttempts < 1)
  ) {
    throw badRequest("maxAttempts must be a positive integer");
  }
  if (body.type === "agent.run") {
    const agentId = body.payload?.agentId;
    if (typeof agentId !== "string") throw badRequest("agent.run payload.agentId is required");
    const data = await loadStoreAsync();
    const agent = (data.agents ?? []).find(
      (entry) => entry.workspaceId === workspaceId && entry.id === agentId,
    );
    if (!agent) {
      throw badRequest("agent.run payload.agentId must reference an agent in this workspace");
    }
  }
}

export const jobRoutes = new Hono();

jobRoutes.get("/", async (c) => {
  try {
    const { workspace } = requirePrivateWorkspaceRole(c, "viewer");
    const status = c.req.query("status") as JobStatus | undefined;
    const limit = Number(c.req.query("limit") ?? 50);
    const jobs = await listJobsAsync(workspace.id, { status, limit });
    return c.json({ jobs: jobs.map(serializeJob) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

jobRoutes.post("/", async (c) => {
  try {
    const { workspace } = requirePrivateWorkspaceRole(c, "admin");
    const body = (await c.req.json().catch(() => ({}))) as Partial<{
      type: string;
      payload: Record<string, unknown>;
      scheduledAt: string;
      cron: string;
      maxAttempts: number;
    }>;
    if (!body.type) return errorResponse(c, badRequest("type is required"));
    await validateJobInput(body, workspace.id);
    const job = await enqueueJobAsync({
      workspaceId: workspace.id,
      type: body.type,
      payload: body.payload ?? {},
      ...(body.scheduledAt ? { scheduledAt: body.scheduledAt } : {}),
      ...(body.cron ? { cron: body.cron } : {}),
      ...(body.maxAttempts !== undefined ? { maxAttempts: body.maxAttempts } : {}),
    });
    return c.json({ job: serializeJob(job) }, 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});

jobRoutes.get("/:id", async (c) => {
  try {
    const { workspace } = requirePrivateWorkspaceRole(c, "viewer");
    const job = await findJobAsync(workspace.id, c.req.param("id"));
    if (!job) return errorResponse(c, Object.assign(new Error("not found"), { status: 404 }));
    return c.json({ job: serializeJob(job) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

jobRoutes.post("/:id/cancel", async (c) => {
  try {
    const { workspace } = requirePrivateWorkspaceRole(c, "admin");
    const existing = await findJobAsync(workspace.id, c.req.param("id"));
    if (!existing) return errorResponse(c, Object.assign(new Error("not found"), { status: 404 }));
    const job = await cancelJobAsync(workspace.id, existing.id);
    if (!job) return errorResponse(c, Object.assign(new Error("not found"), { status: 404 }));
    return c.json({ ok: true, job: serializeJob(job) });
  } catch (error) {
    return errorResponse(c, error);
  }
});
