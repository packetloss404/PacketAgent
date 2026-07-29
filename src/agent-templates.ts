import type { AgentInputField } from "./packetagent-store";

export interface AgentTemplate {
  id: string;
  name: string;
  category: "support" | "operations" | "release" | "research" | "comms";
  summary: string;
  description: string;
  instructions: string;
  tools: string[];
  setupRequiredTools?: string[];
  schedule?: string;
  inputSchema: AgentInputField[];
}

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: "support_triage",
    name: "Support inbox triage",
    category: "support",
    summary: "Classify, draft, and escalate inbound support email.",
    description:
      "Watches a shared mailbox, classifies severity, drafts replies, and escalates urgent threads to the right owner.",
    instructions:
      "Confirm the Gmail, draft email, and notification connectors are configured before claiming mailbox work. When setup is available, read incoming support email, classify severity (low / medium / high), draft a concise customer reply, and escalate high-severity threads. If setup is missing, report the blocker and summarize any available workspace context.",
    tools: ["read_workflow_brief", "list_recent_runs", "list_blockers", "log_note"],
    setupRequiredTools: ["gmail", "email_drafts", "notifications"],
    schedule: "*/15 * * * *",
    inputSchema: [
      {
        key: "mailbox",
        label: "Mailbox label",
        type: "string",
        required: true,
        description: "Inbox or label to scan.",
      },
      {
        key: "urgency_threshold",
        label: "Urgency threshold",
        type: "enum",
        required: true,
        options: ["low", "medium", "high"],
        defaultValue: "medium",
      },
    ],
  },
  {
    id: "daily_brief",
    name: "Daily workspace brief",
    category: "operations",
    summary: "Compose a morning brief from workspace activity.",
    description:
      "Summarizes recent activity, open blockers, open questions, and validation state into a short morning brief.",
    instructions:
      "Pull workspace activity for the lookback window. Summarize open blockers, open questions, and any failed validations. Produce a 5 line morning brief in plain text. Do not claim email delivery unless an email connector is configured.",
    tools: ["read_workflow_brief", "list_recent_runs", "list_blockers"],
    setupRequiredTools: ["email"],
    schedule: "0 8 * * 1-5",
    inputSchema: [
      {
        key: "lookback_hours",
        label: "Lookback (hours)",
        type: "number",
        required: true,
        defaultValue: "24",
      },
      {
        key: "include_runs",
        label: "Include agent runs",
        type: "boolean",
        required: false,
        defaultValue: "true",
      },
    ],
  },
  {
    id: "release_audit",
    name: "Release audit",
    category: "release",
    summary: "Verify release evidence before confirmation.",
    description:
      "Reviews validation evidence, release confirmation status, and any unresolved questions before a release ships.",
    instructions:
      "For the release label, review available workspace requirements and plan items, then note any missing validation evidence or release-note tooling as setup required. Block confirmation if required evidence is unavailable or any open question is critical.",
    tools: ["read_workflow_brief", "list_requirements", "list_plan_items"],
    setupRequiredTools: ["validation_evidence", "release_notes"],
    inputSchema: [
      {
        key: "release_label",
        label: "Release label",
        type: "string",
        required: true,
        description: "Version label being audited.",
      },
      { key: "evidence_url", label: "Evidence URL", type: "url", required: false },
    ],
  },
  {
    id: "blocker_watcher",
    name: "Blocker watcher",
    category: "operations",
    summary: "Track unresolved blockers and prepare escalation.",
    description:
      "Monitors open blockers in the workspace and prepares escalation notes for the owner of any critical blocker.",
    instructions:
      "List open blockers ordered by severity. For any blocker marked critical or high, draft an escalation note that names the owner and suggested next step.",
    tools: ["read_workflow_brief", "list_blockers", "log_note"],
    schedule: "0 9 * * 1-5",
    inputSchema: [
      {
        key: "min_severity",
        label: "Minimum severity",
        type: "enum",
        required: true,
        options: ["medium", "high", "critical"],
        defaultValue: "high",
      },
    ],
  },
  {
    id: "weekly_release_notes",
    name: "Weekly release notes",
    category: "comms",
    summary: "Draft weekly release notes from completed plan items.",
    description:
      "Pulls completed plan items and validation evidence from the past week and drafts customer-facing release notes.",
    instructions:
      "Find plan items completed in the past week. For each, write a one line customer-facing summary. Group by theme. Output markdown. Do not claim release-note publication unless a publication adapter is configured.",
    tools: ["read_workflow_brief", "list_plan_items", "list_recent_runs", "log_note"],
    setupRequiredTools: ["release_notes"],
    schedule: "0 16 * * 5",
    inputSchema: [
      {
        key: "audience",
        label: "Audience",
        type: "enum",
        required: true,
        options: ["customers", "internal"],
        defaultValue: "customers",
      },
    ],
  },
  {
    id: "research_summarizer",
    name: "Research summarizer",
    category: "research",
    summary: "Summarize a long URL into a structured note.",
    description:
      "Reads a URL or document, returns a structured summary with key findings, risks, and follow-up questions.",
    instructions:
      "Read the source. Produce sections: Summary (3 bullets), Key findings, Risks, Follow-up questions.",
    tools: ["http_fetch"],
    inputSchema: [
      { key: "source_url", label: "Source URL", type: "url", required: true },
      {
        key: "depth",
        label: "Depth",
        type: "enum",
        required: false,
        options: ["quick", "deep"],
        defaultValue: "quick",
      },
    ],
  },
];

export function findAgentTemplate(id: string): AgentTemplate | null {
  return AGENT_TEMPLATES.find((entry) => entry.id === id) ?? null;
}
