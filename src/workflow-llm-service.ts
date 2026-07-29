import { getDefaultRouter } from "./providers/router.js";
import { recordedCall } from "./providers/ledger.js";
import { generateWorkflowDraftFromPrompt, type WorkflowDraft } from "./workflow-prompt-service.js";
import { type WorkflowContext, getWorkflowOverview } from "./workflow-service.js";
import type { ProviderMessage } from "./providers/types.js";

export interface LlmDraftInput {
  workspaceId: string;
  prompt: string;
}

export interface LlmDraftResult {
  draft: WorkflowDraft;
  modelUsed: string;
  costUsd: number;
}

export interface PlanModePlanItem {
  summary: string;
  status: "todo" | "doing" | "done";
}

export interface PlanModeResult {
  planItems: PlanModePlanItem[];
  rationale: string;
  modelUsed: string;
  costUsd: number;
}

const DRAFT_SYSTEM_PROMPT = `You are a senior product engineer drafting a structured workflow brief from a free-form user goal. Respond ONLY with strict JSON of this exact shape:

{
  "brief": {
    "summary": string,
    "problem": string,
    "outcome": string,
    "customers": string[],
    "metrics": string[]
  },
  "requirements": [{ "summary": string, "priority": "must" | "should" | "could" }],
  "planItems": [{ "summary": string, "status": "todo" }]
}

Do not include any prose or code fences outside the JSON object.`;

const PLAN_MODE_SYSTEM_PROMPT = `You are a senior product engineer in Plan Mode. Given the workspace brief and accepted requirements, decompose the work into ordered, dependency-aware implementation plan items. Respond ONLY with strict JSON:

{
  "planItems": [{ "summary": string, "status": "todo" }],
  "rationale": string
}

Order items so each step's dependencies appear earlier. Do not include any prose or code fences outside the JSON object.`;

const WORKFLOW_DRAFT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    brief: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: { type: "string" },
        problem: { type: "string" },
        outcome: { type: "string" },
        customers: { type: "array", items: { type: "string" } },
        metrics: { type: "array", items: { type: "string" } },
      },
      required: ["summary", "problem", "outcome", "customers", "metrics"],
    },
    requirements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "string" },
          priority: { type: "string", enum: ["must", "should", "could"] },
        },
        required: ["summary", "priority"],
      },
    },
    planItems: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "string" },
          status: { type: "string", enum: ["todo"] },
        },
        required: ["summary", "status"],
      },
    },
  },
  required: ["brief", "requirements", "planItems"],
};

const PLAN_MODE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    planItems: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "string" },
          status: { type: "string", enum: ["todo", "doing", "done"] },
        },
        required: ["summary", "status"],
      },
    },
    rationale: { type: "string" },
  },
  required: ["planItems", "rationale"],
};

export function extractJson(content: string): unknown {
  const trimmed = content.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1] : trimmed;
  const start = candidate.indexOf("{");
  if (start === -1) throw new Error("no JSON object found in model output");
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return JSON.parse(candidate.slice(start, i + 1));
      }
    }
  }
  throw new Error("unbalanced JSON object in model output");
}

function fallbackToRegex(prompt: string): WorkflowDraft {
  return generateWorkflowDraftFromPrompt(prompt);
}

function shapeDraftFromLlm(parsed: unknown, prompt: string): WorkflowDraft {
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const brief = (obj.brief ?? {}) as Record<string, unknown>;
  const requirements = Array.isArray(obj.requirements)
    ? (obj.requirements as Record<string, unknown>[])
    : [];
  const planItems = Array.isArray(obj.planItems)
    ? (obj.planItems as Record<string, unknown>[])
    : [];
  return {
    prompt,
    brief: {
      summary: String(brief.summary ?? ""),
      problemStatement: String(brief.problem ?? brief.problemStatement ?? ""),
      desiredOutcome: String(brief.outcome ?? brief.desiredOutcome ?? ""),
      targetCustomers: Array.isArray(brief.customers) ? brief.customers.map(String) : [],
      successMetrics: Array.isArray(brief.metrics) ? brief.metrics.map(String) : [],
      goals: [],
      audience: Array.isArray(brief.customers)
        ? (brief.customers as unknown[]).map(String).join(", ")
        : "",
      constraints: "",
    },
    requirements: requirements
      .map((r) => {
        const rawPriority = String(r.priority ?? "must");
        const priority: "must" | "should" | "could" =
          rawPriority === "should" ? "should" : rawPriority === "could" ? "could" : "must";
        return {
          title: String(r.summary ?? r.title ?? ""),
          detail: String(r.detail ?? ""),
          priority,
          status: "accepted" as const,
        };
      })
      .filter((r) => r.title.length > 0),
    planItems: planItems
      .map((p) => ({
        title: String(p.summary ?? p.title ?? ""),
        description: String(p.description ?? ""),
        status: "todo" as const,
      }))
      .filter((p) => p.title.length > 0),
  };
}

export async function llmDraftWorkflow(input: LlmDraftInput): Promise<LlmDraftResult> {
  const router = getDefaultRouter();
  const route = router.resolve("workflow.draft");
  const messages: ProviderMessage[] = [
    { role: "system", content: DRAFT_SYSTEM_PROMPT },
    { role: "user", content: input.prompt },
  ];
  try {
    const result = await recordedCall(
      {
        workspaceId: input.workspaceId,
        routeKey: "workflow.draft",
        provider: route.provider,
        model: route.model,
      },
      () =>
        router.call({
          workspaceId: input.workspaceId,
          routeKey: "workflow.draft",
          messages,
          structuredOutput: {
            name: "workflow_draft",
            schema: WORKFLOW_DRAFT_SCHEMA,
            strict: true,
          },
          temperature: 0.2,
          maxTokens: 2048,
        }),
    );
    let parsed: unknown;
    try {
      parsed = extractJson(result.content);
    } catch {
      return {
        draft: fallbackToRegex(input.prompt),
        modelUsed: result.model,
        costUsd: result.usage.costUsd,
      };
    }
    const draft = shapeDraftFromLlm(parsed, input.prompt);
    if (draft.requirements.length === 0 && draft.planItems.length === 0) {
      return {
        draft: fallbackToRegex(input.prompt),
        modelUsed: result.model,
        costUsd: result.usage.costUsd,
      };
    }
    return { draft, modelUsed: result.model, costUsd: result.usage.costUsd };
  } catch {
    return { draft: fallbackToRegex(input.prompt), modelUsed: route.model, costUsd: 0 };
  }
}

function shapePlanFromLlm(parsed: unknown): { planItems: PlanModePlanItem[]; rationale: string } {
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const planItems = Array.isArray(obj.planItems)
    ? (obj.planItems as Record<string, unknown>[])
    : [];
  const rationale = typeof obj.rationale === "string" ? obj.rationale : "";
  return {
    planItems: planItems
      .map((p) => {
        const rawStatus = String(p.status ?? "todo");
        const status: "todo" | "doing" | "done" =
          rawStatus === "doing" ? "doing" : rawStatus === "done" ? "done" : "todo";
        return { summary: String(p.summary ?? p.title ?? ""), status };
      })
      .filter((p) => p.summary.length > 0),
    rationale,
  };
}

export async function llmPlanMode(context: WorkflowContext): Promise<PlanModeResult> {
  const overview = getWorkflowOverview(context);
  const briefSummary = overview.brief?.summary ?? "(no brief yet)";
  const briefProblem = overview.brief?.problemStatement ?? "";
  const requirements = overview.requirements.map((r) => `- (${r.priority}) ${r.title}`).join("\n");
  const router = getDefaultRouter();
  const route = router.resolve("workflow.plan_mode");
  const messages: ProviderMessage[] = [
    { role: "system", content: PLAN_MODE_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Brief: ${briefSummary}\nProblem: ${briefProblem}\n\nRequirements:\n${requirements || "(none)"}\n\nReturn ordered plan items now.`,
    },
  ];
  try {
    const result = await recordedCall(
      {
        workspaceId: context.workspace.id,
        routeKey: "workflow.plan_mode",
        provider: route.provider,
        model: route.model,
      },
      () =>
        router.call({
          workspaceId: context.workspace.id,
          routeKey: "workflow.plan_mode",
          messages,
          structuredOutput: {
            name: "workflow_plan",
            schema: PLAN_MODE_SCHEMA,
            strict: true,
          },
          temperature: 0.2,
          maxTokens: 2048,
        }),
    );
    let parsed: unknown;
    try {
      parsed = extractJson(result.content);
    } catch {
      return {
        planItems: [],
        rationale: "Plan Mode could not parse the model output. Try again or refine the brief.",
        modelUsed: result.model,
        costUsd: result.usage.costUsd,
      };
    }
    const shaped = shapePlanFromLlm(parsed);
    return { ...shaped, modelUsed: result.model, costUsd: result.usage.costUsd };
  } catch (error) {
    return {
      planItems: [],
      rationale: `Plan Mode failed: ${(error as Error).message}`,
      modelUsed: route.model,
      costUsd: 0,
    };
  }
}

export type { WorkflowDraft };
