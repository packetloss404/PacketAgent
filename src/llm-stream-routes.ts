import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { requirePrivateWorkspaceRole } from "./rbac.js";
import { getDefaultRouter } from "./providers/router.js";
import { recordedStream } from "./providers/ledger.js";
import type { ProviderMessage, ProviderToolDef } from "./providers/types.js";
import { redactedErrorMessage, redactSensitiveString } from "./security/redaction.js";

interface StreamRequestBody {
  routeKey?: string;
  messages?: ProviderMessage[];
  tools?: ProviderToolDef[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

const HEARTBEAT_MS = 15_000;

const inflight = new Map<string, AbortController>();

function errorResponse(c: Context, error: unknown) {
  c.status(((error as Error & { status?: number }).status ?? 500) as 500);
  return c.json({ error: redactedErrorMessage(error) });
}

export const llmStreamRoutes = new Hono();

llmStreamRoutes.post("/stream", async (c) => {
  let workspaceId: string;
  try {
    workspaceId = requirePrivateWorkspaceRole(c, "member").workspace.id;
  } catch (error) {
    return errorResponse(c, error);
  }

  let body: StreamRequestBody;
  try {
    body = (await c.req.json()) as StreamRequestBody;
  } catch {
    return errorResponse(c, Object.assign(new Error("invalid JSON"), { status: 400 }));
  }

  if (!body.routeKey || !Array.isArray(body.messages) || body.messages.length === 0) {
    return errorResponse(
      c,
      Object.assign(new Error("routeKey and non-empty messages are required"), { status: 400 }),
    );
  }

  const streamId = c.req.header("x-stream-id") ?? crypto.randomUUID();
  const abortCtrl = new AbortController();
  inflight.set(streamId, abortCtrl);
  const upstreamSignal = c.req.raw.signal;
  const onUpstreamAbort = () => abortCtrl.abort();
  upstreamSignal.addEventListener("abort", onUpstreamAbort);

  const router = getDefaultRouter();
  const route = router.resolve(body.routeKey);
  const callOpts = {
    model: body.model && body.model.length > 0 ? body.model : route.model,
    messages: body.messages,
    workspaceId,
    routeKey: body.routeKey,
    signal: abortCtrl.signal,
    ...(body.tools ? { tools: body.tools } : {}),
    ...(body.maxTokens !== undefined ? { maxTokens: body.maxTokens } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
  };

  c.header("x-stream-id", streamId);

  return streamSSE(c, async (sse) => {
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    try {
      heartbeat = setInterval(() => {
        sse.write(": ping\n\n").catch(() => {});
      }, HEARTBEAT_MS);
      const upstream = router.stream(callOpts);
      const recorded = recordedStream(
        { workspaceId, routeKey: body.routeKey!, provider: route.provider, model: callOpts.model },
        upstream,
      );
      for await (const chunk of recorded) {
        if (chunk.error) {
          await sse.writeSSE({
            event: "error",
            data: JSON.stringify({ error: redactSensitiveString(chunk.error) }),
          });
          continue;
        }
        await sse.writeSSE({ event: "chunk", data: JSON.stringify(chunk) });
      }
      await sse.writeSSE({ event: "done", data: "{}" });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      inflight.delete(streamId);
      upstreamSignal.removeEventListener("abort", onUpstreamAbort);
    }
  });
});

llmStreamRoutes.post("/cancel/:streamId", (c) => {
  try {
    requirePrivateWorkspaceRole(c, "member");
    const streamId = c.req.param("streamId");
    const ctrl = inflight.get(streamId);
    if (ctrl) {
      ctrl.abort();
      inflight.delete(streamId);
      return c.json({ canceled: true });
    }
    return c.json({ canceled: false });
  } catch (error) {
    return errorResponse(c, error);
  }
});

export function registerInflightForTests(streamId: string, ctrl: AbortController): void {
  inflight.set(streamId, ctrl);
}

export function clearInflightForTests(): void {
  inflight.clear();
}
