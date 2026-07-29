import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { requirePrivateWorkspaceRoleAsync } from "./rbac.js";
import { getDefaultSandboxService, type SandboxService } from "./sandbox/sandbox-service.js";
import type {
  SandboxExecRecord,
  SandboxExecRequestBody,
  SandboxExecStatus,
} from "./sandbox/types.js";
import { redactedErrorMessage } from "./security/redaction.js";

const VALID_STATUSES: ReadonlySet<SandboxExecStatus> = new Set([
  "queued",
  "running",
  "success",
  "failed",
  "timeout",
  "canceled",
]);

function errorResponse(c: Context, error: unknown) {
  const status = ((error as Error & { status?: number }).status ?? 500) as
    | 400
    | 401
    | 403
    | 404
    | 500;
  return c.json({ error: redactedErrorMessage(error) }, status);
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

function notFound(message = "not found"): Error {
  return Object.assign(new Error(message), { status: 404 });
}

interface SandboxRouteDeps {
  service?: SandboxService;
}

export function createSandboxRoutes(deps: SandboxRouteDeps = {}): Hono {
  const router = new Hono();
  const resolveService = () => deps.service ?? getDefaultSandboxService();

  router.get("/status", async (c) => {
    try {
      await requirePrivateWorkspaceRoleAsync(c, "viewer");
      const status = await resolveService().getStatus();
      return c.json(status);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  router.get("/runtimes", async (c) => {
    try {
      await requirePrivateWorkspaceRoleAsync(c, "viewer");
      const runtimes = await resolveService().listRuntimes();
      return c.json({ runtimes });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  router.post("/exec", async (c) => {
    try {
      const ctx = await requirePrivateWorkspaceRoleAsync(c, "member");
      const body = (await readJsonBody(c)) as Partial<SandboxExecRequestBody>;
      if (!body.command || typeof body.command !== "string" || body.command.trim().length === 0) {
        throw badRequest("command is required");
      }
      const exec = await resolveService().startExec({
        workspaceId: ctx.workspace.id,
        command: body.command,
        ...(typeof body.appId === "string" ? { appId: body.appId } : {}),
        ...(typeof body.checkpointId === "string" ? { checkpointId: body.checkpointId } : {}),
        ...(typeof body.runtime === "string" ? { runtime: body.runtime } : {}),
        ...(typeof body.workingDir === "string" ? { workingDir: body.workingDir } : {}),
        ...(body.env && typeof body.env === "object"
          ? { env: body.env as Record<string, string> }
          : {}),
        ...(typeof body.timeoutMs === "number" ? { timeoutMs: body.timeoutMs } : {}),
        ...(typeof body.stdin === "string" ? { stdin: body.stdin } : {}),
      });
      return c.json({ exec }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  router.get("/exec", async (c) => {
    try {
      const ctx = await requirePrivateWorkspaceRoleAsync(c, "viewer");
      const limit = parseLimit(c.req.query("limit"));
      const appIdParam = c.req.query("appId") ?? undefined;
      const statusParam = parseStatus(c.req.query("status"));
      const execs = await resolveService().listExecs(ctx.workspace.id, {
        ...(limit !== undefined ? { limit } : {}),
        ...(appIdParam !== undefined ? { appId: appIdParam } : {}),
        ...(statusParam !== undefined ? { status: statusParam } : {}),
      });
      return c.json({ execs });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  router.get("/exec/:id", async (c) => {
    try {
      const ctx = await requirePrivateWorkspaceRoleAsync(c, "viewer");
      const exec = await resolveService().getExec(ctx.workspace.id, c.req.param("id"));
      if (!exec) throw notFound();
      return c.json({ exec });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  router.post("/exec/:id/cancel", async (c) => {
    try {
      const ctx = await requirePrivateWorkspaceRoleAsync(c, "member");
      const exec = await resolveService().cancelExec(ctx.workspace.id, c.req.param("id"));
      if (!exec) throw notFound();
      return c.json({ exec });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  router.get("/exec/:id/stream", async (c) => {
    let workspaceId: string;
    try {
      const ctx = await requirePrivateWorkspaceRoleAsync(c, "viewer");
      workspaceId = ctx.workspace.id;
    } catch (error) {
      return errorResponse(c, error);
    }

    const id = c.req.param("id");
    const service = resolveService();
    const initial = await service.getExec(workspaceId, id);
    if (!initial) return errorResponse(c, notFound());

    return streamSSE(c, async (sse) => {
      const onChunk = async (record: SandboxExecRecord, evt: { stream: string; data: string }) => {
        if (record.id !== id) return;
        await sse.writeSSE({
          event: "chunk",
          data: JSON.stringify({ stream: evt.stream, data: evt.data }),
        });
      };
      const onUpdate = async (record: SandboxExecRecord) => {
        if (record.id !== id) return;
        await sse.writeSSE({ event: "status", data: JSON.stringify(record) });
      };
      const onDone = async (record: SandboxExecRecord) => {
        if (record.id !== id) return;
        await sse.writeSSE({ event: "done", data: JSON.stringify(record) });
      };

      service.events.on("exec.chunk", onChunk);
      service.events.on("exec.update", onUpdate);
      service.events.on("exec.done", onDone);

      try {
        await sse.writeSSE({ event: "status", data: JSON.stringify(initial) });
        if (isTerminalStatus(initial.status)) {
          await sse.writeSSE({ event: "done", data: JSON.stringify(initial) });
          return;
        }
        await new Promise<void>((resolve) => {
          const finalize = (record: SandboxExecRecord) => {
            if (record.id === id) resolve();
          };
          service.events.once("exec.done", finalize);
          c.req.raw.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        service.events.off("exec.chunk", onChunk);
        service.events.off("exec.update", onUpdate);
        service.events.off("exec.done", onDone);
      }
    });
  });

  return router;
}

export const sandboxRoutes = createSandboxRoutes();

function isTerminalStatus(status: SandboxExecStatus): boolean {
  return (
    status === "success" || status === "failed" || status === "timeout" || status === "canceled"
  );
}

function parseLimit(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function parseStatus(raw: string | undefined): SandboxExecStatus | undefined {
  if (!raw) return undefined;
  return VALID_STATUSES.has(raw as SandboxExecStatus) ? (raw as SandboxExecStatus) : undefined;
}

async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.includes("application/json")) return {};
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    throw Object.assign(new Error("request body must be valid JSON"), { status: 400 });
  }
}
