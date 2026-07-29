import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { assertPermission, type WorkspacePermission } from "./rbac.js";
import { requireAuthenticatedContext } from "./packetagent-services.js";
import { findWorkspaceMembership, loadStoreAsync } from "./packetagent-store.js";
import {
  getWorkflowTemplate,
  listWorkflowTemplates,
  type WorkflowDraft,
} from "./workflow-prompt-service.js";
import { llmDraftWorkflow, llmPlanMode } from "./workflow-llm-service.js";
import {
  replacePlanItemsAsync,
  replaceRequirementsAsync,
  updateWorkspaceBriefAsync,
} from "./workflow-service.js";
import { redactedErrorMessage } from "./security/redaction.js";

type AuthenticatedContext = ReturnType<typeof requireAuthenticatedContext>;
type WorkflowServiceFunction = (context: AuthenticatedContext, input?: unknown) => unknown;
type WorkflowServiceModule = Record<string, unknown>;

const workflowServiceFunctions = {
  getOverview: ["getWorkflowOverviewAsync", "getWorkflowOverview", "getOverview"],
  getBrief: [
    "getWorkflowBriefAsync",
    "readWorkspaceBriefAsync",
    "getWorkflowBrief",
    "readWorkspaceBrief",
    "getBrief",
  ],
  saveBrief: [
    "saveWorkflowBriefAsync",
    "updateWorkspaceBriefAsync",
    "saveWorkflowBrief",
    "updateWorkspaceBrief",
    "updateWorkflowBrief",
    "upsertWorkflowBrief",
  ],
  listBriefVersions: [
    "listWorkspaceBriefHistoryAsync",
    "listWorkspaceBriefHistory",
    "listBriefVersions",
  ],
  restoreBriefVersion: [
    "restoreWorkspaceBriefVersionAsync",
    "restoreWorkspaceBriefVersion",
    "restoreBriefVersion",
  ],
  listBriefTemplates: ["listWorkspaceBriefTemplates", "listBriefTemplates"],
  applyBriefTemplate: [
    "applyWorkspaceBriefTemplateAsync",
    "applyWorkspaceBriefTemplate",
    "applyBriefTemplate",
  ],
  getRequirements: [
    "getWorkflowRequirementsAsync",
    "listRequirementsAsync",
    "getWorkflowRequirements",
    "listRequirements",
    "getRequirements",
  ],
  saveRequirements: [
    "saveWorkflowRequirementsAsync",
    "replaceRequirementsAsync",
    "saveWorkflowRequirements",
    "replaceRequirements",
    "updateWorkflowRequirements",
    "upsertWorkflowRequirements",
  ],
  listPlanItems: [
    "listWorkflowPlanItemsAsync",
    "listPlanItemsAsync",
    "listWorkflowPlanItems",
    "listPlanItems",
    "getWorkflowPlanItems",
  ],
  savePlanItems: [
    "saveWorkflowPlanItemsAsync",
    "replacePlanItemsAsync",
    "saveWorkflowPlanItems",
    "replacePlanItems",
    "updateWorkflowPlanItems",
  ],
  createPlanItem: ["createWorkflowPlanItemAsync", "createWorkflowPlanItem", "addWorkflowPlanItem"],
  updatePlanItem: ["updateWorkflowPlanItemAsync", "updateWorkflowPlanItem", "saveWorkflowPlanItem"],
  getBlockersAndQuestions: [
    "getWorkflowBlockersAndQuestionsAsync",
    "listBlockersAndQuestionsAsync",
    "getWorkflowBlockersAndQuestions",
    "listBlockersAndQuestions",
  ],
  saveBlockersAndQuestions: [
    "saveWorkflowBlockersAndQuestionsAsync",
    "replaceBlockersAndQuestionsAsync",
    "saveWorkflowBlockersAndQuestions",
    "replaceBlockersAndQuestions",
  ],
  listBlockers: ["listWorkflowBlockersAsync", "listWorkflowBlockers", "getWorkflowBlockers"],
  createBlocker: ["createWorkflowBlockerAsync", "createWorkflowBlocker", "addWorkflowBlocker"],
  updateBlocker: ["updateWorkflowBlockerAsync", "updateWorkflowBlocker", "saveWorkflowBlocker"],
  listQuestions: ["listWorkflowQuestionsAsync", "listWorkflowQuestions", "getWorkflowQuestions"],
  createQuestion: ["createWorkflowQuestionAsync", "createWorkflowQuestion", "addWorkflowQuestion"],
  updateQuestion: ["updateWorkflowQuestionAsync", "updateWorkflowQuestion", "saveWorkflowQuestion"],
  listValidationEvidence: [
    "listWorkflowValidationEvidenceAsync",
    "listValidationEvidenceAsync",
    "listWorkflowValidationEvidence",
    "listValidationEvidence",
    "getWorkflowValidationEvidence",
  ],
  saveValidationEvidence: [
    "saveWorkflowValidationEvidenceAsync",
    "replaceValidationEvidenceAsync",
    "saveWorkflowValidationEvidence",
    "replaceValidationEvidence",
    "updateWorkflowValidationEvidence",
  ],
  createValidationEvidence: [
    "createWorkflowValidationEvidenceAsync",
    "createWorkflowValidationEvidence",
    "addWorkflowValidationEvidence",
  ],
  updateValidationEvidence: [
    "updateWorkflowValidationEvidenceAsync",
    "updateWorkflowValidationEvidence",
    "saveWorkflowValidationEvidence",
  ],
  getReleaseConfirmation: [
    "getWorkflowReleaseConfirmationAsync",
    "readReleaseConfirmationAsync",
    "getWorkflowReleaseConfirmation",
    "readReleaseConfirmation",
    "getReleaseConfirmation",
  ],
  confirmRelease: [
    "confirmWorkflowReleaseAsync",
    "updateReleaseConfirmationAsync",
    "confirmWorkflowRelease",
    "updateReleaseConfirmation",
    "saveWorkflowReleaseConfirmation",
    "confirmRelease",
  ],
} as const;

type WorkflowOperation = keyof typeof workflowServiceFunctions;

export const workflowRoutes = new Hono();

workflowRoutes.get("/", (c) => runWorkflowOperation(c, "getOverview"));

workflowRoutes.get("/brief", (c) => runWorkflowOperation(c, "getBrief"));
workflowRoutes.put("/brief", (c) =>
  runWorkflowOperation(c, "saveBrief", readJsonBody, [], "editWorkflow"),
);

workflowRoutes.get("/brief/templates", (c) => runWorkflowOperation(c, "listBriefTemplates"));
workflowRoutes.post("/brief/templates/:templateId/apply", (c) =>
  runWorkflowOperation(c, "applyBriefTemplate", readJsonBody, ["templateId"], "editWorkflow"),
);

workflowRoutes.get("/brief/versions", (c) => runWorkflowOperation(c, "listBriefVersions"));
workflowRoutes.post("/brief/versions/:versionId/restore", (c) =>
  runWorkflowOperation(c, "restoreBriefVersion", readJsonBody, ["versionId"], "editWorkflow"),
);

workflowRoutes.get("/requirements", (c) => runWorkflowOperation(c, "getRequirements"));
workflowRoutes.put("/requirements", (c) =>
  runWorkflowOperation(c, "saveRequirements", readJsonBody, [], "editWorkflow"),
);

workflowRoutes.get("/plan-items", (c) => runWorkflowOperation(c, "listPlanItems"));
workflowRoutes.put("/plan-items", (c) =>
  runWorkflowOperation(c, "savePlanItems", readJsonBody, [], "editWorkflow"),
);
workflowRoutes.post("/plan-items", (c) =>
  runWorkflowOperation(c, "createPlanItem", readJsonBody, [], "editWorkflow"),
);
workflowRoutes.patch("/plan-items/:itemId", (c) =>
  runWorkflowOperation(c, "updatePlanItem", readJsonBody, ["itemId"], "editWorkflow"),
);

workflowRoutes.get("/blockers-questions", (c) =>
  runWorkflowOperation(c, "getBlockersAndQuestions"),
);
workflowRoutes.put("/blockers-questions", (c) =>
  runWorkflowOperation(c, "saveBlockersAndQuestions", readJsonBody, [], "editWorkflow"),
);

workflowRoutes.get("/blockers", (c) => runWorkflowOperation(c, "listBlockers"));
workflowRoutes.post("/blockers", (c) =>
  runWorkflowOperation(c, "createBlocker", readJsonBody, [], "editWorkflow"),
);
workflowRoutes.patch("/blockers/:blockerId", (c) =>
  runWorkflowOperation(c, "updateBlocker", readJsonBody, ["blockerId"], "editWorkflow"),
);

workflowRoutes.get("/questions", (c) => runWorkflowOperation(c, "listQuestions"));
workflowRoutes.post("/questions", (c) =>
  runWorkflowOperation(c, "createQuestion", readJsonBody, [], "editWorkflow"),
);
workflowRoutes.patch("/questions/:questionId", (c) =>
  runWorkflowOperation(c, "updateQuestion", readJsonBody, ["questionId"], "editWorkflow"),
);

workflowRoutes.get("/validation-evidence", (c) =>
  runWorkflowOperation(c, "listValidationEvidence"),
);
workflowRoutes.put("/validation-evidence", (c) =>
  runWorkflowOperation(c, "saveValidationEvidence", readJsonBody, [], "editWorkflow"),
);
workflowRoutes.post("/validation-evidence", (c) =>
  runWorkflowOperation(c, "createValidationEvidence", readJsonBody, [], "editWorkflow"),
);
workflowRoutes.patch("/validation-evidence/:evidenceId", (c) =>
  runWorkflowOperation(c, "updateValidationEvidence", readJsonBody, ["evidenceId"], "editWorkflow"),
);

workflowRoutes.get("/release-confirmation", (c) =>
  runWorkflowOperation(c, "getReleaseConfirmation"),
);
workflowRoutes.put("/release-confirmation", (c) =>
  runWorkflowOperation(c, "confirmRelease", readJsonBody, [], "editWorkflow"),
);
workflowRoutes.post("/release-confirmation", (c) =>
  runWorkflowOperation(c, "confirmRelease", readJsonBody, [], "editWorkflow"),
);

workflowRoutes.get("/templates", async (c) => {
  try {
    const context = requireAuthenticatedContext(c);
    await requireWorkflowPermission(context, "viewWorkspace");
    return c.json({ templates: listWorkflowTemplates() });
  } catch (error) {
    return errorResponse(c, error);
  }
});

workflowRoutes.post("/templates/:templateId/apply", async (c) => {
  try {
    const context = requireAuthenticatedContext(c);
    await requireWorkflowPermission(context, "editWorkflow");
    const result = await applyWorkflowTemplateAsync(context, c.req.param("templateId"));
    return c.json(result);
  } catch (error) {
    return errorResponse(c, error);
  }
});

workflowRoutes.post("/generate-from-prompt", async (c) => {
  try {
    const context = requireAuthenticatedContext(c);
    await requireWorkflowPermission(context, "editWorkflow");
    const body = (await readJsonBody(c)) as { prompt?: string; apply?: boolean } | undefined;
    const prompt = body?.prompt ?? "";
    const apply = Boolean(body?.apply);
    const llm = await llmDraftWorkflow({ workspaceId: context.workspace.id, prompt });
    if (!apply) {
      return c.json({
        draft: llm.draft,
        applied: false,
        modelUsed: llm.modelUsed,
        costUsd: llm.costUsd,
      });
    }
    return c.json({
      ...(await applyWorkflowDraftAsync(context, llm.draft)),
      modelUsed: llm.modelUsed,
      costUsd: llm.costUsd,
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

workflowRoutes.post("/plan-mode", async (c) => {
  try {
    const context = requireAuthenticatedContext(c);
    await requireWorkflowPermission(context, "editWorkflow");
    const result = await llmPlanMode(context);
    return c.json(result);
  } catch (error) {
    return errorResponse(c, error);
  }
});

workflowRoutes.post("/plan-mode/apply", async (c) => {
  try {
    const context = requireAuthenticatedContext(c);
    await requireWorkflowPermission(context, "editWorkflow");
    const body = (await readJsonBody(c)) as
      | { planItems?: { summary: string; status?: string }[] }
      | undefined;
    const items = (body?.planItems ?? [])
      .map((p) => {
        const raw = String(p.status ?? "todo");
        const status: "todo" | "in_progress" | "done" =
          raw === "in_progress" || raw === "doing"
            ? "in_progress"
            : raw === "done"
              ? "done"
              : "todo";
        return { title: p.summary, description: "", status };
      })
      .filter((p) => p.title.length > 0);
    const planItems = await replacePlanItemsAsync(context, items);
    return c.json({ planItems });
  } catch (error) {
    return errorResponse(c, error);
  }
});

export default workflowRoutes;

async function applyWorkflowDraftAsync(context: AuthenticatedContext, draft: WorkflowDraft) {
  const brief = await updateWorkspaceBriefAsync(context, {
    summary: draft.brief.summary,
    problemStatement: draft.brief.problemStatement,
    desiredOutcome: draft.brief.desiredOutcome,
    targetCustomers: draft.brief.targetCustomers,
    successMetrics: draft.brief.successMetrics,
    goals: draft.brief.goals,
    audience: draft.brief.audience,
    constraints: draft.brief.constraints,
  });
  const requirements = await replaceRequirementsAsync(context, draft.requirements);
  const planItems = await replacePlanItemsAsync(context, draft.planItems);

  return { draft, applied: true, brief, requirements, planItems };
}

async function applyWorkflowTemplateAsync(context: AuthenticatedContext, templateId: string) {
  const template = getWorkflowTemplate(templateId);
  if (!template) throw httpError(404, "workflow template not found");

  const brief = await updateWorkspaceBriefAsync(context, {
    summary: template.brief.summary,
    problemStatement: template.brief.problemStatement,
    desiredOutcome: template.brief.desiredOutcome,
    audience: template.brief.audience,
    constraints: template.brief.constraints,
    targetCustomers: template.brief.targetCustomers,
    successMetrics: template.brief.successMetrics,
    goals: template.brief.goals,
  });
  const requirements = await replaceRequirementsAsync(
    context,
    template.requirements.map((entry) => ({
      title: entry.title,
      detail: entry.detail,
      priority: entry.priority,
      status: "accepted",
    })),
  );
  const planItems = await replacePlanItemsAsync(
    context,
    template.planItems.map((entry) => ({
      title: entry.title,
      description: entry.description,
      status: "todo",
    })),
  );

  return { template, brief, requirements, planItems };
}

async function runWorkflowOperation(
  c: Context,
  operation: WorkflowOperation,
  readBody?: (c: Context) => Promise<unknown>,
  paramNames: string[] = [],
  permission: WorkspacePermission = "viewWorkspace",
) {
  try {
    const context = requireAuthenticatedContext(c);
    await requireWorkflowPermission(context, permission);
    const service = await loadWorkflowService();
    if (!service) {
      throw httpError(501, "workflow service module is not available");
    }

    const handler = findServiceFunction(service, workflowServiceFunctions[operation]);
    if (!handler) {
      throw httpError(501, `workflow service handler is not available for ${operation}`);
    }

    const body = readBody ? await readBody(c) : {};
    const params = Object.fromEntries(paramNames.map((name) => [name, c.req.param(name)]));
    const input =
      paramNames.length > 0 ? { ...(isRecord(body) ? body : { value: body }), ...params } : body;

    const result = await handler(context, input);
    return c.body(JSON.stringify(result === undefined ? { ok: true } : result), 200, {
      "Content-Type": "application/json; charset=UTF-8",
    });
  } catch (error) {
    return errorResponse(c, error);
  }
}

async function requireWorkflowPermission(
  context: AuthenticatedContext,
  permission: WorkspacePermission,
) {
  const membership = findWorkspaceMembership(
    await loadStoreAsync(),
    context.workspace.id,
    context.user.id,
  );
  assertPermission(membership, permission);
}

let workflowServicePromise: Promise<WorkflowServiceModule | null> | null = null;

async function loadWorkflowService(): Promise<WorkflowServiceModule | null> {
  workflowServicePromise ??= import("./workflow-service.js")
    .then((module) => module as WorkflowServiceModule)
    .catch((error: unknown) => {
      if (isMissingWorkflowService(error)) {
        return null;
      }
      throw error;
    });

  return workflowServicePromise;
}

function findServiceFunction(
  service: WorkflowServiceModule,
  names: readonly string[],
): WorkflowServiceFunction | null {
  for (const name of names) {
    const candidate = service[name];
    if (typeof candidate === "function") {
      return candidate as WorkflowServiceFunction;
    }
  }
  return null;
}

async function readJsonBody(c: Context): Promise<unknown> {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return {};
  }

  try {
    const body = await c.req.json();
    return body as unknown;
  } catch {
    throw httpError(400, "request body must be valid JSON");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isMissingWorkflowService(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  const message = (error as Error).message ?? "";
  return code === "ERR_MODULE_NOT_FOUND" && message.includes("workflow-service");
}

function errorResponse(c: Context, error: unknown) {
  const status = (error as Error & { status?: number }).status ?? 500;
  c.status(status as ContentfulStatusCode);
  return c.json({ error: redactedErrorMessage(error) });
}

function httpError(status: number, message: string) {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}
