import { randomUUID } from "node:crypto";
import {
  mutateStoreAsync,
  recordActivity,
  upsertImplementationPlanItem,
  upsertWorkflowConcern,
  type ActivityRecord,
} from "../packetagent-store.js";
import { workspaceAuthorization } from "./authorization.js";
import type { ToolDefinition } from "./types.js";

function mutationEffect(
  classification: "idempotent_mutation" | "reconcilable_mutation" | "non_replayable_mutation",
  operation: string,
) {
  return {
    describe: () => ({
      classification,
      operation,
    }),
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

async function recordToolActivity(
  workspaceId: string,
  userId: string,
  event: string,
  data: Record<string, string | number | boolean | null | undefined>,
): Promise<void> {
  await mutateStoreAsync((store) => {
    const entry: ActivityRecord = {
      id: randomUUID(),
      workspaceId,
      scope: "workspace",
      event,
      data,
      actor: { type: "user", id: userId },
      occurredAt: nowIso(),
    };
    recordActivity(store, entry, { position: "end" });
  });
}

export const createPlanItemTool: ToolDefinition = {
  name: "create_plan_item",
  description: "Create a new implementation plan item in the workflow.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1 },
      description: { type: "string" },
      status: { type: "string", enum: ["todo", "in_progress", "blocked", "done"], default: "todo" },
      requirementIds: { type: "array", items: { type: "string" } },
    },
    required: ["title"],
    additionalProperties: false,
  },
  side: "write",
  effect: mutationEffect("non_replayable_mutation", "plan_item.create"),
  authorization: workspaceAuthorization("CREATE", "write"),
  async handle(input, ctx) {
    const {
      title,
      description = "",
      status = "todo",
      requirementIds = [],
    } = input as {
      title: string;
      description?: string;
      status?: "todo" | "in_progress" | "blocked" | "done";
      requirementIds?: string[];
    };
    const created = await mutateStoreAsync((data) => {
      const existingMax = data.implementationPlanItems
        .filter((p) => p.workspaceId === ctx.workspaceId)
        .reduce((acc, p) => Math.max(acc, p.order ?? 0), 0);
      return upsertImplementationPlanItem(data, {
        workspaceId: ctx.workspaceId,
        title: title.trim(),
        description,
        status,
        requirementIds,
        order: existingMax + 1,
      });
    });
    await recordToolActivity(ctx.workspaceId, ctx.userId, "tool.plan_item.created", {
      id: created.id,
      title: created.title,
    });
    return { ok: true, output: { planItem: created } };
  },
};

export const updatePlanItemStatusTool: ToolDefinition = {
  name: "update_plan_item_status",
  description: "Update the status of an existing plan item.",
  inputSchema: {
    type: "object",
    properties: {
      planItemId: { type: "string" },
      status: { type: "string", enum: ["todo", "in_progress", "blocked", "done"] },
    },
    required: ["planItemId", "status"],
    additionalProperties: false,
  },
  side: "write",
  effect: mutationEffect("idempotent_mutation", "plan_item.status.set"),
  authorization: workspaceAuthorization("UPDATE", "write"),
  async handle(input, ctx) {
    const { planItemId, status } = input as {
      planItemId: string;
      status: "todo" | "in_progress" | "blocked" | "done";
    };
    const updated = await mutateStoreAsync((data) => {
      const entry = data.implementationPlanItems.find(
        (p) => p.id === planItemId && p.workspaceId === ctx.workspaceId,
      );
      if (!entry) return null;
      entry.status = status;
      entry.updatedAt = nowIso();
      return entry;
    });
    if (!updated) return { ok: false, error: `plan item ${planItemId} not found in workspace` };
    await recordToolActivity(ctx.workspaceId, ctx.userId, "tool.plan_item.status_updated", {
      id: planItemId,
      status,
    });
    return { ok: true, output: { planItem: updated } };
  },
};

export const createBlockerTool: ToolDefinition = {
  name: "create_blocker",
  description:
    "Open a new workflow blocker or question to capture a concern that needs resolution.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1 },
      detail: { type: "string" },
      kind: { type: "string", enum: ["blocker", "open_question"], default: "blocker" },
      severity: { type: "string", enum: ["low", "medium", "high", "critical"], default: "medium" },
    },
    required: ["title"],
    additionalProperties: false,
  },
  side: "write",
  effect: mutationEffect("non_replayable_mutation", "workflow_concern.create"),
  authorization: workspaceAuthorization("CREATE", "write"),
  async handle(input, ctx) {
    const {
      title,
      detail = "",
      kind = "blocker",
      severity = "medium",
    } = input as {
      title: string;
      detail?: string;
      kind?: "blocker" | "open_question";
      severity?: "low" | "medium" | "high" | "critical";
    };
    const created = await mutateStoreAsync((data) =>
      upsertWorkflowConcern(data, {
        workspaceId: ctx.workspaceId,
        kind,
        title: title.trim(),
        description: detail,
        severity,
        status: "open",
      }),
    );
    await recordToolActivity(ctx.workspaceId, ctx.userId, `tool.${kind}.opened`, {
      id: created.id,
      title: created.title,
    });
    return { ok: true, output: { concern: created } };
  },
};

export const logNoteTool: ToolDefinition = {
  name: "log_note",
  description: "Append a free-form note to the workspace activity log. Use sparingly.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1 },
      body: { type: "string" },
    },
    required: ["title"],
    additionalProperties: false,
  },
  side: "write",
  effect: mutationEffect("non_replayable_mutation", "activity_note.append"),
  authorization: workspaceAuthorization("APPEND", "write"),
  async handle(input, ctx) {
    const { title, body = "" } = input as { title: string; body?: string };
    await recordToolActivity(ctx.workspaceId, ctx.userId, "tool.note", {
      title: title.trim(),
      body,
    });
    return { ok: true, output: { note: { title: title.trim(), body } } };
  },
};

export const WRITE_TOOLS: ToolDefinition[] = [
  createPlanItemTool,
  updatePlanItemStatusTool,
  createBlockerTool,
  logNoteTool,
];
