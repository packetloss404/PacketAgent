import {
  replacePlanItems,
  replaceRequirements,
  updateWorkspaceBrief,
  type WorkflowContext,
  httpError,
} from "./workflow-service.js";
import type {
  ImplementationPlanItemRecord,
  RequirementRecord,
  WorkspaceBriefRecord,
} from "./packetagent-store.js";

export type WorkflowDraftInput = {
  prompt: string;
  apply?: boolean;
};

export type WorkflowDraft = {
  prompt: string;
  brief: {
    summary: string;
    problemStatement: string;
    desiredOutcome: string;
    targetCustomers: string[];
    successMetrics: string[];
    goals: string[];
    audience: string;
    constraints: string;
  };
  requirements: Array<{
    title: string;
    detail: string;
    priority: "must" | "should" | "could";
    status: "accepted";
  }>;
  planItems: Array<{
    title: string;
    description: string;
    status: "todo";
  }>;
};

export type WorkflowDraftResult = {
  draft: WorkflowDraft;
  applied: boolean;
  brief?: WorkspaceBriefRecord;
  requirements?: RequirementRecord[];
  planItems?: ImplementationPlanItemRecord[];
};

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "so",
  "for",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "with",
  "about",
  "as",
  "from",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "we",
  "our",
  "us",
  "they",
  "them",
  "their",
  "i",
  "you",
  "your",
  "my",
  "me",
  "have",
  "has",
  "had",
  "will",
  "would",
  "should",
  "could",
  "can",
  "do",
  "does",
  "did",
  "than",
  "then",
  "into",
  "out",
  "over",
  "under",
  "any",
  "some",
  "all",
  "each",
  "every",
  "no",
  "not",
]);

const ACTION_VERBS = [
  "build",
  "ship",
  "launch",
  "track",
  "monitor",
  "automate",
  "send",
  "notify",
  "summarize",
  "draft",
  "review",
  "approve",
  "collect",
  "capture",
  "validate",
  "publish",
  "deploy",
  "schedule",
  "sync",
  "integrate",
  "manage",
  "onboard",
  "activate",
  "convert",
  "qualify",
  "tag",
  "route",
  "escalate",
  "respond",
  "process",
  "ingest",
  "score",
  "rank",
  "filter",
  "report",
  "analyze",
];

export function generateWorkflowDraftFromPrompt(prompt: string): WorkflowDraft {
  const trimmed = (prompt ?? "").trim();
  if (trimmed.length < 8) {
    throw httpError(400, "prompt must be at least 8 characters");
  }

  const sentences = splitSentences(trimmed);
  const summary = buildSummary(sentences);
  const customers = extractCustomers(trimmed);
  const metrics = extractMetrics(sentences);
  const actions = extractActions(sentences);
  const requirements = buildRequirements(sentences, actions);
  const planItems = buildPlanItems(sentences, actions);

  return {
    prompt: trimmed,
    brief: {
      summary,
      problemStatement: sentences[0]?.trim() ?? summary,
      desiredOutcome: sentences[sentences.length - 1]?.trim() ?? summary,
      targetCustomers: customers,
      successMetrics: metrics,
      goals: actions.slice(0, 4).map((entry) => capitalize(entry)),
      audience: customers.join(", "),
      constraints: extractConstraints(trimmed),
    },
    requirements,
    planItems,
  };
}

export async function generateAndApplyWorkflowDraft(
  context: WorkflowContext,
  input: WorkflowDraftInput,
): Promise<WorkflowDraftResult> {
  const draft = generateWorkflowDraftFromPrompt(input.prompt ?? "");
  if (!input.apply) {
    return { draft, applied: false };
  }

  return applyWorkflowDraft(context, draft);
}

export function applyWorkflowDraft(
  context: WorkflowContext,
  draft: WorkflowDraft,
): WorkflowDraftResult {
  const brief = updateWorkspaceBrief(context, {
    summary: draft.brief.summary,
    problemStatement: draft.brief.problemStatement,
    desiredOutcome: draft.brief.desiredOutcome,
    targetCustomers: draft.brief.targetCustomers,
    successMetrics: draft.brief.successMetrics,
    goals: draft.brief.goals,
    audience: draft.brief.audience,
    constraints: draft.brief.constraints,
  });
  const requirements = replaceRequirements(context, draft.requirements);
  const planItems = replacePlanItems(context, draft.planItems);

  return { draft, applied: true, brief, requirements, planItems };
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\r?\n+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function buildSummary(sentences: string[]): string {
  if (sentences.length === 0) return "";
  const head = sentences[0]?.trim() ?? "";
  if (head.length <= 180) return head;
  return `${head.slice(0, 177).trim()}...`;
}

function extractCustomers(text: string): string[] {
  const set = new Set<string>();
  const forMatches = text.matchAll(
    /\bfor\s+([A-Za-z][\w\s/&-]{2,40}?)(?:[.,;]|$|\bso\b|\bto\b|\bwhen\b)/gi,
  );
  for (const match of forMatches) addPhrase(set, match[1]);
  const targetMatches = text.matchAll(
    /\b(?:customer|client|user|team|owner|operator|lead|manager|admin|partner|vendor)s?\b/gi,
  );
  for (const match of targetMatches) addPhrase(set, match[0]);
  return Array.from(set).slice(0, 4);
}

function extractMetrics(sentences: string[]): string[] {
  const metrics: string[] = [];
  for (const sentence of sentences) {
    if (
      /\b(?:reduce|increase|cut|grow|track|measure|hit|reach|under|within|less than|more than)\b/i.test(
        sentence,
      )
    ) {
      metrics.push(capitalize(sentence));
    }
    if (
      /\b\d+\s*(?:%|percent|hour|hours|day|days|minute|minutes|sec|seconds|x)\b/i.test(sentence) &&
      !metrics.includes(capitalize(sentence))
    ) {
      metrics.push(capitalize(sentence));
    }
  }
  return metrics.slice(0, 4);
}

function extractConstraints(text: string): string {
  const match = text.match(
    /\b(?:without|except|but not|cannot|must not|avoid|excluding)\s+([^.;\n]{3,180})/i,
  );
  return match ? capitalize(match[0]).trim() : "";
}

function extractActions(sentences: string[]): string[] {
  const actions: string[] = [];
  const seen = new Set<string>();
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    for (const verb of ACTION_VERBS) {
      const pattern = new RegExp(`\\b${verb}\\b\\s+([^.;\\n]{2,80})`, "i");
      const match = lower.match(pattern);
      if (match) {
        const phrase = `${verb} ${match[1]}`.replace(/\s+/g, " ").trim();
        const key = phrase.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          actions.push(phrase);
        }
      }
    }
  }
  if (actions.length === 0) {
    const keywords = topKeywords(sentences.join(" "), 4);
    for (const word of keywords) {
      const phrase = `track ${word}`;
      const key = phrase.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        actions.push(phrase);
      }
    }
  }
  return actions.slice(0, 6);
}

function buildRequirements(sentences: string[], actions: string[]): WorkflowDraft["requirements"] {
  const requirements: WorkflowDraft["requirements"] = [];
  const seen = new Set<string>();
  for (const action of actions) {
    const title = capitalize(action);
    if (seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    const detail =
      sentences.find((sentence) => sentence.toLowerCase().includes(action.split(" ")[0])) ?? "";
    const priority = pickPriority(action, detail);
    requirements.push({ title, detail, priority, status: "accepted" });
  }
  if (requirements.length === 0) {
    requirements.push({
      title: capitalize(sentences[0]?.slice(0, 80) ?? "Capture initial requirement"),
      detail: sentences[0] ?? "",
      priority: "must",
      status: "accepted",
    });
  }
  return requirements.slice(0, 6);
}

function buildPlanItems(sentences: string[], actions: string[]): WorkflowDraft["planItems"] {
  const items: WorkflowDraft["planItems"] = [];
  const seen = new Set<string>();
  const seedTitles = [
    "Capture workspace brief from prompt",
    ...actions.map((action) => `Plan: ${capitalize(action)}`),
    "Validate and confirm release",
  ];
  for (const title of seedTitles) {
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const description =
      sentences.find((sentence) =>
        sentence.toLowerCase().includes(title.toLowerCase().split(" ").slice(-1)[0] ?? ""),
      ) ?? "";
    items.push({ title, description, status: "todo" });
  }
  return items.slice(0, 6);
}

function pickPriority(action: string, detail: string): "must" | "should" | "could" {
  const text = `${action} ${detail}`.toLowerCase();
  if (/\b(must|need|require|critical|urgent|always|never|safety|compliance|legal)\b/.test(text))
    return "must";
  if (/\b(maybe|nice|optional|later|consider|future|could)\b/.test(text)) return "could";
  return "should";
}

function topKeywords(text: string, limit: number): string[] {
  const counts = new Map<string, number>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    const word = raw.trim();
    if (word.length < 4 || STOP_WORDS.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([word]) => word);
}

function addPhrase(set: Set<string>, phrase: string | undefined): void {
  if (!phrase) return;
  const cleaned = phrase.replace(/\s+/g, " ").trim();
  if (cleaned.length < 3 || cleaned.length > 60) return;
  set.add(capitalize(cleaned));
}

function capitalize(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

// ---------- Workflow templates ----------

export type WorkflowTemplate = {
  id: string;
  name: string;
  category: string;
  description: string;
  brief: {
    summary: string;
    problemStatement: string;
    desiredOutcome: string;
    audience: string;
    constraints: string;
    targetCustomers: string[];
    successMetrics: string[];
    goals: string[];
  };
  requirements: Array<{ title: string; detail: string; priority: "must" | "should" | "could" }>;
  planItems: Array<{ title: string; description: string }>;
};

export type ApplyWorkflowTemplateResult = {
  template: WorkflowTemplate;
  brief: WorkspaceBriefRecord;
  requirements: RequirementRecord[];
  planItems: ImplementationPlanItemRecord[];
};

const TEMPLATES: WorkflowTemplate[] = [
  {
    id: "customer_onboarding_portal",
    name: "Customer onboarding portal",
    category: "Customer success",
    description:
      "Stand up a self-serve onboarding flow for new customers with checklist tracking and a kickoff handoff.",
    brief: {
      summary:
        "Launch a self-serve customer onboarding portal that tracks checklist completion through to kickoff.",
      problemStatement:
        "New customers stall during onboarding because steps live in scattered email threads and spreadsheets.",
      desiredOutcome:
        "Every new customer reaches kickoff within seven days with a verifiable activation checklist.",
      audience: "Customer success managers and new customer admins",
      constraints: "Reuse existing identity provider; no new logins for customers.",
      targetCustomers: ["Customer success manager", "New customer admin"],
      successMetrics: [
        "Time to kickoff under seven days",
        "At least 80 percent of checklist items completed before kickoff",
      ],
      goals: [
        "Visualize onboarding checklist",
        "Capture kickoff handoff",
        "Surface stalled customers",
      ],
    },
    requirements: [
      {
        title: "Render onboarding checklist per customer",
        detail: "Each customer sees their tailored steps with completion state.",
        priority: "must",
      },
      {
        title: "Capture kickoff handoff confirmation",
        detail: "Owner confirms kickoff with notes and date.",
        priority: "must",
      },
      {
        title: "Flag stalled onboardings after 72 hours of inactivity",
        detail: "Surface stalled customers to the customer success manager.",
        priority: "should",
      },
      {
        title: "Allow customer admins to invite teammates",
        detail: "Invitation flow with role assignment.",
        priority: "could",
      },
    ],
    planItems: [
      {
        title: "Define onboarding checklist schema",
        description: "Steps, owners, due dates, completion proof.",
      },
      {
        title: "Build checklist UI for customer admin",
        description: "Self-serve view with inline completion.",
      },
      {
        title: "Add stalled-onboarding alert job",
        description: "Daily check that surfaces inactive accounts.",
      },
      {
        title: "Capture kickoff confirmation",
        description: "Form that records handoff notes and confirmation owner.",
      },
    ],
  },
  {
    id: "internal_support_triage",
    name: "Internal support triage",
    category: "Operations",
    description:
      "Classify incoming support requests, route to owners, and track resolution evidence.",
    brief: {
      summary:
        "Triage internal support requests with classification, ownership, and resolution evidence.",
      problemStatement:
        "Support requests arrive across email, chat, and tickets without a single owner or audit trail.",
      desiredOutcome:
        "Every request has an owner within one hour and a resolution note within the SLA.",
      audience: "Support team lead and on-call operators",
      constraints: "Cannot store customer PII outside existing ticket system.",
      targetCustomers: ["Support lead", "On-call operator"],
      successMetrics: [
        "Time to first owner under one hour",
        "100 percent of resolved requests have a resolution note",
      ],
      goals: ["Classify requests", "Assign owners automatically", "Track resolution evidence"],
    },
    requirements: [
      {
        title: "Classify each incoming request by topic and urgency",
        detail: "Use rule-based classifier with manual override.",
        priority: "must",
      },
      {
        title: "Assign an owner within one hour",
        detail: "Round-robin within on-call rotation.",
        priority: "must",
      },
      {
        title: "Capture resolution note before closing",
        detail: "Closure requires a non-empty note.",
        priority: "must",
      },
      {
        title: "Notify on-call when SLA risk is high",
        detail: "Send alerts at 50 percent and 80 percent of SLA window.",
        priority: "should",
      },
    ],
    planItems: [
      {
        title: "Define request schema with topic and urgency",
        description: "Source, channel, urgency, requester, owner.",
      },
      {
        title: "Implement classifier and routing rules",
        description: "Rule-based classifier with weighted defaults.",
      },
      { title: "Add SLA alerting job", description: "Surface at-risk requests to on-call." },
      {
        title: "Capture resolution note on close",
        description: "Block closure without a resolution note.",
      },
    ],
  },
  {
    id: "vendor_activation_tracker",
    name: "Vendor activation tracker",
    category: "Procurement",
    description:
      "Activate new vendors with structured intake, contract validation, and release confirmation.",
    brief: {
      summary:
        "Activate new vendors with structured intake, contract validation, and release confirmation.",
      problemStatement:
        "Vendor onboarding is informal, leaving missing documents and unclear go-live status.",
      desiredOutcome:
        "Every vendor reaches go-live with confirmed contract, security review, and release record.",
      audience: "Procurement lead and security reviewer",
      constraints: "Security review must precede release confirmation.",
      targetCustomers: ["Procurement lead", "Security reviewer", "Vendor primary contact"],
      successMetrics: [
        "Days from intake to go-live under 14",
        "Zero vendor go-lives without a recorded security review",
      ],
      goals: ["Capture intake", "Validate contract", "Record security review", "Confirm release"],
    },
    requirements: [
      {
        title: "Capture vendor intake details",
        detail: "Company, primary contact, scope, target go-live.",
        priority: "must",
      },
      {
        title: "Validate contract document",
        detail: "Reviewer attaches signed contract and confirmation note.",
        priority: "must",
      },
      {
        title: "Record security review outcome",
        detail: "Pass, fail, or conditional with follow-up actions.",
        priority: "must",
      },
      {
        title: "Confirm release before go-live",
        detail: "Release requires contract and passing security review.",
        priority: "must",
      },
    ],
    planItems: [
      {
        title: "Build vendor intake form",
        description: "Capture vendor metadata and target go-live.",
      },
      {
        title: "Add contract validation step",
        description: "Document upload with reviewer confirmation.",
      },
      {
        title: "Add security review checklist",
        description: "Reviewer captures outcome and follow-ups.",
      },
      {
        title: "Wire release confirmation",
        description: "Block release if prerequisites are missing.",
      },
    ],
  },
];

export function listWorkflowTemplates(): WorkflowTemplate[] {
  return TEMPLATES.map((entry) => ({ ...entry }));
}

export function getWorkflowTemplate(id: string): WorkflowTemplate | null {
  const found = TEMPLATES.find((entry) => entry.id === id);
  return found ? { ...found } : null;
}

export function applyWorkflowTemplate(
  context: WorkflowContext,
  templateId: string,
): ApplyWorkflowTemplateResult {
  const template = getWorkflowTemplate(templateId);
  if (!template) throw httpError(404, "workflow template not found");

  const brief = updateWorkspaceBrief(context, {
    summary: template.brief.summary,
    problemStatement: template.brief.problemStatement,
    desiredOutcome: template.brief.desiredOutcome,
    audience: template.brief.audience,
    constraints: template.brief.constraints,
    targetCustomers: template.brief.targetCustomers,
    successMetrics: template.brief.successMetrics,
    goals: template.brief.goals,
  });
  const requirements = replaceRequirements(
    context,
    template.requirements.map((entry) => ({
      title: entry.title,
      detail: entry.detail,
      priority: entry.priority,
      status: "accepted",
    })),
  );
  const planItems = replacePlanItems(
    context,
    template.planItems.map((entry) => ({
      title: entry.title,
      description: entry.description,
      status: "todo",
    })),
  );

  return { template, brief, requirements, planItems };
}
