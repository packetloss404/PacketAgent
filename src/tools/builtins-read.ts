import {
  loadStoreAsync,
  findWorkspaceBrief,
  listRequirementsForWorkspace,
  listImplementationPlanItemsForWorkspace,
  listWorkflowConcernsForWorkspace,
} from "../packetagent-store.js";
import { inputAuthorization, workspaceAuthorization } from "./authorization.js";
import type { ToolDefinition } from "./types.js";

function readOnlyEffect(operation: string, billableAction = false) {
  return {
    describe: () => ({
      classification: "read_only" as const,
      operation,
      ...(billableAction ? { billableAction: true } : {}),
    }),
  };
}

export const readWorkflowBriefTool: ToolDefinition = {
  name: "read_workflow_brief",
  description:
    "Read the current workspace brief: summary, problem statement, desired outcome, customers, metrics, goals, constraints.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  side: "read",
  effect: readOnlyEffect("workflow_brief.read"),
  authorization: workspaceAuthorization("READ", "read"),
  async handle(_input, ctx) {
    const data = await loadStoreAsync();
    const brief = findWorkspaceBrief(data, ctx.workspaceId);
    return { ok: true, output: { brief } };
  },
};

export const listRequirementsTool: ToolDefinition = {
  name: "list_requirements",
  description: "List the workspace's requirements with priority and status.",
  inputSchema: {
    type: "object",
    properties: {
      priority: { type: "string", enum: ["must", "should", "could"] },
      status: { type: "string", enum: ["accepted", "proposed", "rejected"] },
    },
    additionalProperties: false,
  },
  side: "read",
  effect: readOnlyEffect("requirements.list"),
  authorization: workspaceAuthorization("LIST", "read"),
  async handle(input, ctx) {
    const { priority, status } = input as { priority?: string; status?: string };
    const data = await loadStoreAsync();
    let entries = listRequirementsForWorkspace(data, ctx.workspaceId);
    if (priority) entries = entries.filter((r) => r.priority === priority);
    if (status) entries = entries.filter((r) => r.status === status);
    return { ok: true, output: { count: entries.length, requirements: entries } };
  },
};

export const listPlanItemsTool: ToolDefinition = {
  name: "list_plan_items",
  description: "List implementation plan items, optionally filtered by status.",
  inputSchema: {
    type: "object",
    properties: { status: { type: "string", enum: ["todo", "in_progress", "blocked", "done"] } },
    additionalProperties: false,
  },
  side: "read",
  effect: readOnlyEffect("plan_items.list"),
  authorization: workspaceAuthorization("LIST", "read"),
  async handle(input, ctx) {
    const { status } = input as { status?: string };
    const data = await loadStoreAsync();
    let entries = listImplementationPlanItemsForWorkspace(data, ctx.workspaceId);
    if (status) entries = entries.filter((p) => p.status === status);
    return { ok: true, output: { count: entries.length, planItems: entries } };
  },
};

export const listBlockersTool: ToolDefinition = {
  name: "list_blockers",
  description: "List workflow blockers and questions, optionally filtered by status.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["blocker", "question"] },
      status: { type: "string" },
    },
    additionalProperties: false,
  },
  side: "read",
  effect: readOnlyEffect("workflow_concerns.list"),
  authorization: workspaceAuthorization("LIST", "read"),
  async handle(input, ctx) {
    const { kind, status } = input as { kind?: string; status?: string };
    const data = await loadStoreAsync();
    let entries = listWorkflowConcernsForWorkspace(data, ctx.workspaceId);
    if (kind) entries = entries.filter((c) => c.kind === kind);
    if (status) entries = entries.filter((c) => c.status === status);
    return { ok: true, output: { count: entries.length, concerns: entries } };
  },
};

export const listAgentsTool: ToolDefinition = {
  name: "list_agents",
  description: "List workspace agents (without instructions or playbook detail).",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  side: "read",
  effect: readOnlyEffect("agents.list"),
  authorization: workspaceAuthorization("LIST", "read"),
  async handle(_input, ctx) {
    const data = await loadStoreAsync();
    const agents = data.agents
      .filter((a) => a.workspaceId === ctx.workspaceId)
      .map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        triggerKind: a.triggerKind,
        schedule: a.schedule,
        status: a.status,
        provider: a.providerId,
        model: a.model,
      }));
    return { ok: true, output: { count: agents.length, agents } };
  },
};

export const listRecentRunsTool: ToolDefinition = {
  name: "list_recent_runs",
  description: "List the most recent agent runs in this workspace, newest first.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", minimum: 1, maximum: 50, default: 10 },
      status: { type: "string", enum: ["success", "failed", "running", "queued", "canceled"] },
    },
    additionalProperties: false,
  },
  side: "read",
  effect: readOnlyEffect("agent_runs.list"),
  authorization: workspaceAuthorization("LIST", "read"),
  async handle(input, ctx) {
    const { limit = 10, status } = input as { limit?: number; status?: string };
    const data = await loadStoreAsync();
    const workspaceAgents = new Set(
      data.agents.filter((a) => a.workspaceId === ctx.workspaceId).map((a) => a.id),
    );
    let runs = data.agentRuns.filter(
      (r) => r.agentId !== undefined && workspaceAgents.has(r.agentId),
    );
    if (status) runs = runs.filter((r) => r.status === status);
    runs = runs.slice().reverse().slice(0, limit);
    return {
      ok: true,
      output: {
        count: runs.length,
        runs: runs.map((r) => ({
          id: r.id,
          title: r.title,
          status: r.status,
          createdAt: r.createdAt,
          durationMs:
            r.startedAt && r.completedAt
              ? new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime()
              : null,
        })),
      },
    };
  },
};

export const httpGetTool: ToolDefinition = {
  name: "http_get",
  description:
    "Fetch a URL with GET. Returns status, headers, and (truncated) body. Only http(s) is allowed.",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", format: "uri" } },
    required: ["url"],
    additionalProperties: false,
  },
  side: "read",
  effect: readOnlyEffect("http.get", true),
  authorization: inputAuthorization((input: { url?: unknown }) => ({
    verb: "GET",
    effect: "read",
    resources: [typeof input.url === "string" ? input.url : ""],
  })),
  timeoutMs: 15_000,
  async handle(input, ctx) {
    const { url } = input as { url: string };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, error: `invalid url: ${url}` };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, error: `protocol ${parsed.protocol} not allowed; must be http or https` };
    }
    const blockedHosts = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
    if (blockedHosts.has(parsed.hostname.toLowerCase())) {
      return { ok: false, error: `host ${parsed.hostname} is blocked from tool fetch` };
    }
    if (ctx.worker) {
      if (!ctx.worker.services) {
        return { ok: false, error: "Worker runtime security services are unavailable." };
      }
      try {
        const response = await ctx.worker.services.network.request({
          url: parsed.toString(),
          method: "GET",
          signal: ctx.signal,
          maxResponseBytes: 16_384,
        });
        const raw = response.body;
        const body = raw.length > 16_384 ? raw.slice(0, 16_384) + "\n…[truncated]" : raw;
        const contentType = response.headers["content-type"] ?? "";
        const ok = response.status >= 200 && response.status < 300;
        return {
          ok,
          output: { status: response.status, contentType, body },
          ...(ok ? {} : { error: `HTTP ${response.status}` }),
        };
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        return { ok: false, error: `fetch failed: ${(error as Error).message}` };
      }
    }
    let res: Response;
    try {
      res = await fetch(parsed.toString(), { signal: ctx.signal, redirect: "follow" });
    } catch (error) {
      return { ok: false, error: `fetch failed: ${(error as Error).message}` };
    }
    const contentType = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    const body = raw.length > 16_384 ? raw.slice(0, 16_384) + "\n…[truncated]" : raw;
    return {
      ok: res.ok,
      output: { status: res.status, contentType, body },
      ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
    };
  },
};

export const READ_TOOLS: ToolDefinition[] = [
  readWorkflowBriefTool,
  listRequirementsTool,
  listPlanItemsTool,
  listBlockersTool,
  listAgentsTool,
  listRecentRunsTool,
  httpGetTool,
];
