import { hashPassword, now, slugify } from "../auth-utils";
import type { WorkspaceActivationFacts } from "../activation/adapters";
import type {
  ActivationSignalRecord,
  ActivityRecord,
  AgentInputField,
  AgentPlaybookStep,
  AgentRecord,
  AgentRunLogEntry,
  AgentRunRecord,
  AgentRunStatus,
  AgentRunStep,
  AgentStatus,
  AgentTriggerKind,
  ImplementationPlanItemRecord,
  JobRecord,
  OnboardingStateRecord,
  OnboardingStepKey,
  ProviderKind,
  ProviderRecord,
  RequirementRecord,
  ReleaseConfirmationCollection,
  PacketAgentData,
  UserRecord,
  ValidationEvidenceRecord,
  WorkflowConcernRecord,
  WorkspaceBriefCollection,
  WorkspaceEnvVarRecord,
  WorkspaceMemberRecord,
  WorkspaceRecord,
} from "./types.js";

// LEAF module: seed data construction. Imports only types and auth-utils
// (id/hash/slug/now helpers) — never a backend or the barrel.

export function seedStore(): PacketAgentData {
  const createdAt = now();
  const users: UserRecord[] = [
    createSeedUser("user_alpha", "alpha@packetagent.local", "Alpha Owner", createdAt),
    createSeedUser("user_beta", "beta@packetagent.local", "Beta Owner", createdAt),
    createSeedUser("user_gamma", "gamma@packetagent.local", "Gamma Owner", createdAt),
  ];

  const workspaces: WorkspaceRecord[] = [
    createWorkspaceRecord(
      "alpha",
      "Alpha Workspace",
      "https://alpha.example.com",
      "Capture the implementation brief and move into validation.",
      createdAt,
    ),
    createWorkspaceRecord(
      "beta",
      "Beta Workspace",
      "https://beta.example.com",
      "Recover from blockers and regain forward progress.",
      createdAt,
    ),
    createWorkspaceRecord(
      "gamma",
      "Gamma Workspace",
      "https://gamma.example.com",
      "Sustain a complete release process for the workspace.",
      createdAt,
    ),
  ];

  const memberships: WorkspaceMemberRecord[] = [
    { workspaceId: "alpha", userId: "user_alpha", role: "owner", joinedAt: createdAt },
    { workspaceId: "beta", userId: "user_beta", role: "owner", joinedAt: createdAt },
    { workspaceId: "gamma", userId: "user_gamma", role: "owner", joinedAt: createdAt },
  ];

  const workspaceBriefs: WorkspaceBriefCollection = {
    alpha: {
      workspaceId: "alpha",
      summary: "Capture a concise onboarding brief and move the workspace into validation.",
      goals: ["Capture validation evidence", "Track remaining launch question"],
      audience: "Implementation lead and customer success manager",
      constraints: "First release should avoid optional reporting scope until it is confirmed.",
      problemStatement:
        "The implementation scope is understood, but release readiness still needs durable validation evidence.",
      targetCustomers: ["Implementation lead", "Customer success manager"],
      desiredOutcome: "A ready-to-review workspace with one remaining question tracked.",
      successMetrics: ["Validation checklist has passing evidence", "Open questions have owners"],
      updatedByUserId: "user_alpha",
      createdAt: isoDaysAgo(9),
      updatedAt: isoDaysAgo(2),
    },
    beta: {
      workspaceId: "beta",
      summary: "Recover a blocked implementation by clarifying dependencies and ownership.",
      goals: ["Resolve dependency ownership", "Clarify retry scope"],
      audience: "Operations owner and technical lead",
      constraints: "Implementation restart is blocked until the dependency owner is confirmed.",
      problemStatement:
        "Dependency gaps and unanswered scope questions are preventing forward progress.",
      targetCustomers: ["Operations owner", "Technical lead"],
      desiredOutcome: "Critical blockers are visible and the implementation plan can restart.",
      successMetrics: [
        "Dependency blocker is resolved",
        "Critical issue has an owner",
        "Retry plan is documented",
      ],
      updatedByUserId: "user_beta",
      createdAt: isoDaysAgo(14),
      updatedAt: isoDaysAgo(4),
    },
    gamma: {
      workspaceId: "gamma",
      summary: "Maintain a complete release workflow from requirements through confirmation.",
      goals: ["Preserve release evidence", "Keep confirmation auditable"],
      audience: "Product manager and release owner",
      constraints: "Release records must stay linked to validation evidence.",
      problemStatement:
        "The workflow is complete and needs a durable audit trail for release confidence.",
      targetCustomers: ["Product manager", "Release owner"],
      desiredOutcome: "Release confirmation remains tied to validation evidence and requirements.",
      successMetrics: [
        "Release confirmation is recorded",
        "Validation evidence is linked to the plan",
      ],
      updatedByUserId: "user_gamma",
      createdAt: isoDaysAgo(30),
      updatedAt: isoDaysAgo(7),
    },
  };

  const requirements: RequirementRecord[] = [
    {
      id: "req_alpha_validation",
      workspaceId: "alpha",
      title: "Capture validation evidence before release",
      detail: "Record proof that the implemented workflow meets the activation checklist.",
      priority: "must",
      status: "approved",
      acceptanceCriteria: [
        "Evidence includes outcome, owner, and linked plan item",
        "Failed checks create follow-up work",
      ],
      source: "brief",
      createdByUserId: "user_alpha",
      createdAt: isoDaysAgo(8),
      updatedAt: isoDaysAgo(2),
    },
    {
      id: "req_alpha_questions",
      workspaceId: "alpha",
      title: "Track remaining launch questions",
      detail: "Keep unanswered launch questions visible until they are resolved or deferred.",
      priority: "should",
      status: "approved",
      acceptanceCriteria: [
        "Each question has status and owner",
        "Resolved questions keep their resolution note",
      ],
      source: "team",
      createdByUserId: "user_alpha",
      createdAt: isoDaysAgo(7),
      updatedAt: isoDaysAgo(3),
    },
    {
      id: "req_beta_dependencies",
      workspaceId: "beta",
      title: "Unblock dependency decisions",
      detail:
        "Identify dependency blockers and critical scope decisions before restarting implementation.",
      priority: "must",
      status: "changed",
      acceptanceCriteria: [
        "Critical blockers are marked high or critical",
        "Dependency owner is assigned",
      ],
      source: "customer",
      createdByUserId: "user_beta",
      createdAt: isoDaysAgo(12),
      updatedAt: isoDaysAgo(5),
    },
    {
      id: "req_gamma_release_audit",
      workspaceId: "gamma",
      title: "Preserve release audit trail",
      detail: "Tie release confirmation to validation evidence and notes for later review.",
      priority: "must",
      status: "done",
      acceptanceCriteria: [
        "Release version is recorded",
        "Confirmation references validation evidence",
      ],
      source: "brief",
      createdByUserId: "user_gamma",
      createdAt: isoDaysAgo(28),
      updatedAt: isoDaysAgo(7),
    },
  ];

  const implementationPlanItems: ImplementationPlanItemRecord[] = [
    {
      id: "plan_alpha_validation",
      workspaceId: "alpha",
      requirementIds: ["req_alpha_validation"],
      title: "Collect validation proof",
      description: "Attach the passing test run and manual review notes to the workspace.",
      status: "in_progress",
      ownerUserId: "user_alpha",
      order: 1,
      startedAt: isoDaysAgo(4),
      createdAt: isoDaysAgo(7),
      updatedAt: isoDaysAgo(1),
    },
    {
      id: "plan_alpha_questions",
      workspaceId: "alpha",
      requirementIds: ["req_alpha_questions"],
      title: "Resolve launch question",
      description: "Confirm whether the first release needs the optional reporting view.",
      status: "todo",
      ownerUserId: "user_alpha",
      order: 2,
      createdAt: isoDaysAgo(6),
      updatedAt: isoDaysAgo(3),
    },
    {
      id: "plan_beta_restart",
      workspaceId: "beta",
      requirementIds: ["req_beta_dependencies"],
      title: "Restart implementation after dependency review",
      description:
        "Document dependency ownership, then move the implementation back to active work.",
      status: "blocked",
      ownerUserId: "user_beta",
      order: 1,
      startedAt: isoDaysAgo(6),
      createdAt: isoDaysAgo(10),
      updatedAt: isoDaysAgo(2),
    },
    {
      id: "plan_gamma_release",
      workspaceId: "gamma",
      requirementIds: ["req_gamma_release_audit"],
      title: "Confirm release package",
      description: "Verify evidence links and record release confirmation.",
      status: "done",
      ownerUserId: "user_gamma",
      order: 1,
      startedAt: isoDaysAgo(24),
      completedAt: isoDaysAgo(7),
      createdAt: isoDaysAgo(28),
      updatedAt: isoDaysAgo(7),
    },
  ];

  const workflowConcerns: WorkflowConcernRecord[] = [
    {
      id: "question_alpha_reporting",
      workspaceId: "alpha",
      kind: "open_question",
      title: "Is reporting required for the first release?",
      description: "Confirm whether reporting should ship now or remain a post-release follow-up.",
      status: "open",
      severity: "medium",
      relatedRequirementId: "req_alpha_questions",
      relatedPlanItemId: "plan_alpha_questions",
      ownerUserId: "user_alpha",
      createdAt: isoDaysAgo(3),
      updatedAt: isoDaysAgo(1),
    },
    {
      id: "blocker_beta_dependency",
      workspaceId: "beta",
      kind: "blocker",
      title: "Customer dependency owner is unconfirmed",
      description: "Implementation cannot restart until the external dependency owner is named.",
      status: "open",
      severity: "critical",
      relatedRequirementId: "req_beta_dependencies",
      relatedPlanItemId: "plan_beta_restart",
      ownerUserId: "user_beta",
      createdAt: isoDaysAgo(6),
      updatedAt: isoDaysAgo(2),
    },
    {
      id: "question_beta_scope",
      workspaceId: "beta",
      kind: "open_question",
      title: "Should the retry include the expanded scope?",
      description: "Decide whether the scope change is included in the next implementation retry.",
      status: "open",
      severity: "high",
      relatedRequirementId: "req_beta_dependencies",
      ownerUserId: "user_beta",
      createdAt: isoDaysAgo(5),
      updatedAt: isoDaysAgo(2),
    },
    {
      id: "blocker_gamma_none",
      workspaceId: "gamma",
      kind: "blocker",
      title: "Release audit review completed",
      description: "Historical blocker closed after release evidence was attached.",
      status: "resolved",
      severity: "low",
      relatedRequirementId: "req_gamma_release_audit",
      relatedPlanItemId: "plan_gamma_release",
      ownerUserId: "user_gamma",
      resolvedAt: isoDaysAgo(10),
      resolutionNote: "Evidence and release notes were linked before confirmation.",
      createdAt: isoDaysAgo(18),
      updatedAt: isoDaysAgo(10),
    },
  ];

  const validationEvidence: ValidationEvidenceRecord[] = [
    {
      id: "evidence_alpha_tests",
      workspaceId: "alpha",
      planItemId: "plan_alpha_validation",
      requirementIds: ["req_alpha_validation"],
      type: "automated_test",
      title: "Activation validation checks passed",
      detail: "Latest validation run passed with no critical issues.",
      status: "passed",
      source: "local validation run",
      capturedByUserId: "user_alpha",
      capturedAt: isoDaysAgo(1),
      createdAt: isoDaysAgo(1),
      updatedAt: isoDaysAgo(1),
    },
    {
      id: "evidence_beta_failed_retry",
      workspaceId: "beta",
      planItemId: "plan_beta_restart",
      requirementIds: ["req_beta_dependencies"],
      type: "manual_check",
      title: "Dependency review failed",
      detail: "Manual review found that the dependency owner is still missing.",
      status: "failed",
      source: "dependency review",
      capturedByUserId: "user_beta",
      capturedAt: isoDaysAgo(3),
      createdAt: isoDaysAgo(3),
      updatedAt: isoDaysAgo(3),
    },
    {
      id: "evidence_gamma_release_demo",
      workspaceId: "gamma",
      planItemId: "plan_gamma_release",
      requirementIds: ["req_gamma_release_audit"],
      type: "demo",
      title: "Release workflow demo accepted",
      detail: "Release owner accepted the final workflow demo.",
      status: "passed",
      source: "release demo",
      capturedByUserId: "user_gamma",
      capturedAt: isoDaysAgo(10),
      createdAt: isoDaysAgo(10),
      updatedAt: isoDaysAgo(10),
    },
  ];

  const providers: ProviderRecord[] = [
    createProvider(
      "provider_alpha_openai",
      "alpha",
      "OpenAI",
      "openai",
      "gpt-4.1-mini",
      true,
      createdAt,
    ),
    createProvider(
      "provider_beta_anthropic",
      "beta",
      "Anthropic",
      "anthropic",
      "claude-3-5-sonnet-latest",
      false,
      createdAt,
    ),
    createProvider(
      "provider_gamma_ollama",
      "gamma",
      "Local Ollama",
      "ollama",
      "llama3.1",
      true,
      createdAt,
      "http://localhost:11434",
    ),
  ];

  const agents: AgentRecord[] = [
    createAgent({
      id: "agent_alpha_support",
      workspaceId: "alpha",
      createdByUserId: "user_alpha",
      name: "Support inbox triage",
      description: "Classifies new support emails, drafts replies, and flags urgent requests.",
      instructions:
        "Watch the support inbox. Classify urgency, draft a concise reply, and alert the owner when severity is high.",
      providerId: "provider_alpha_openai",
      model: "gpt-4.1-mini",
      tools: ["gmail", "email_drafts", "notifications"],
      schedule: "*/15 * * * *",
      triggerKind: "schedule",
      status: "active",
      templateId: "support_triage",
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
      timestamp: createdAt,
      playbook: [
        {
          id: "step_alpha_support_1",
          title: "Read new inbox messages",
          instruction: "Pull unread support emails from the inbox tool.",
        },
        {
          id: "step_alpha_support_2",
          title: "Classify urgency",
          instruction:
            "Score each message as low / medium / high based on subject + body keywords.",
        },
        {
          id: "step_alpha_support_3",
          title: "Draft reply",
          instruction: "Compose a concise reply for each non-urgent message.",
        },
        {
          id: "step_alpha_support_4",
          title: "Escalate critical",
          instruction: "If severity is high, post to #ops and assign the on-call owner.",
        },
      ],
    }),
    createAgent({
      id: "agent_alpha_daily_brief",
      workspaceId: "alpha",
      createdByUserId: "user_alpha",
      name: "Daily workspace brief",
      description:
        "Summarizes open work, recent runs, blockers, and questions every weekday morning.",
      instructions:
        "Generate a compact morning brief from recent activity, open questions, blockers, and validation state.",
      providerId: "provider_alpha_openai",
      model: "gpt-4.1-mini",
      tools: ["activity", "workflow", "email"],
      schedule: "0 8 * * 1-5",
      triggerKind: "schedule",
      status: "active",
      templateId: "daily_brief",
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
      timestamp: createdAt,
      playbook: [
        {
          id: "step_alpha_brief_1",
          title: "Pull yesterday's activity",
          instruction: "Fetch activity events from the last 24 hours.",
        },
        {
          id: "step_alpha_brief_2",
          title: "Summarize open work",
          instruction: "Group blockers, open questions, and in-progress plan items.",
        },
        {
          id: "step_alpha_brief_3",
          title: "Send brief",
          instruction: "Email the morning brief to the workspace owners list.",
        },
      ],
    }),
    createAgent({
      id: "agent_beta_dependency_watch",
      workspaceId: "beta",
      createdByUserId: "user_beta",
      name: "Dependency watcher",
      description: "Monitors unresolved implementation dependencies and prepares escalation notes.",
      instructions:
        "Track critical blockers and summarize what is needed to restart implementation.",
      providerId: "provider_beta_anthropic",
      model: "claude-3-5-sonnet-latest",
      tools: ["workflow", "activity"],
      schedule: "0 9 * * 1-5",
      triggerKind: "schedule",
      status: "paused",
      inputSchema: [],
      timestamp: createdAt,
      playbook: [
        {
          id: "step_beta_dep_1",
          title: "List critical blockers",
          instruction: "Enumerate blockers with severity high or critical.",
        },
        {
          id: "step_beta_dep_2",
          title: "Draft escalation notes",
          instruction: "Write a brief note per blocker with owner and required action.",
        },
      ],
    }),
    createAgent({
      id: "agent_gamma_release_audit",
      workspaceId: "gamma",
      createdByUserId: "user_gamma",
      name: "Release audit",
      description: "Checks release evidence and prepares a confirmation summary.",
      instructions:
        "Review validation evidence, release confirmation, and open questions before release.",
      providerId: "provider_gamma_ollama",
      model: "llama3.1",
      tools: ["validation", "release_notes"],
      schedule: "On demand",
      triggerKind: "manual",
      status: "active",
      templateId: "release_audit",
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
      timestamp: createdAt,
      playbook: [
        {
          id: "step_gamma_audit_1",
          title: "Verify validation evidence",
          instruction: "Confirm every passed evidence has a source and capturer.",
        },
        {
          id: "step_gamma_audit_2",
          title: "Check open questions",
          instruction: "Confirm no open question is tagged release-blocking.",
        },
        {
          id: "step_gamma_audit_3",
          title: "Compose release summary",
          instruction: "Produce a concise audit summary for the release confirmation.",
        },
      ],
    }),
  ];

  const workspaceEnvVars: WorkspaceEnvVarRecord[] = [
    {
      id: "env_alpha_api_base",
      workspaceId: "alpha",
      key: "ALPHA_API_BASE",
      value: "https://api.alpha.example.com",
      scope: "all",
      secret: false,
      description: "Base URL for the Alpha workspace integration.",
      createdByUserId: "user_alpha",
      createdAt: isoDaysAgo(8),
      updatedAt: isoDaysAgo(8),
    },
    {
      id: "env_alpha_signing_secret",
      workspaceId: "alpha",
      key: "ALPHA_SIGNING_SECRET",
      value: "alpha_demo_signing_secret",
      scope: "runtime",
      secret: true,
      description: "Webhook signing secret used by runtime handlers.",
      createdByUserId: "user_alpha",
      createdAt: isoDaysAgo(6),
      updatedAt: isoDaysAgo(6),
    },
    {
      id: "env_beta_feature_flag",
      workspaceId: "beta",
      key: "BETA_FEATURE_RETRY",
      value: "false",
      scope: "build",
      secret: false,
      description: "Toggle to enable retry experiments during builds.",
      createdByUserId: "user_beta",
      createdAt: isoDaysAgo(5),
      updatedAt: isoDaysAgo(2),
    },
  ];

  const agentRuns: AgentRunRecord[] = [
    createAgentRun({
      id: "run_alpha_support_latest",
      workspaceId: "alpha",
      agentId: "agent_alpha_support",
      title: "Support inbox scanned",
      status: "success",
      timestamp: isoDaysAgo(0),
      triggerKind: "schedule",
      inputs: { mailbox: "support@alpha.example.com", urgency_threshold: "medium" },
      output: "Scanned 18 messages. Drafted 4 replies. Flagged 1 high-severity request.",
      transcript: [
        {
          id: "rs_alpha_support_1",
          title: "Read new inbox messages",
          status: "success",
          output: "Pulled 4 unread messages.",
          durationMs: 380,
          startedAt: isoDaysAgo(0),
        },
        {
          id: "rs_alpha_support_2",
          title: "Classify urgency",
          status: "success",
          output: "3 low, 1 high.",
          durationMs: 720,
          startedAt: isoDaysAgo(0),
        },
        {
          id: "rs_alpha_support_3",
          title: "Draft reply",
          status: "success",
          output: "Drafted 3 replies for review.",
          durationMs: 980,
          startedAt: isoDaysAgo(0),
        },
        {
          id: "rs_alpha_support_4",
          title: "Escalate critical",
          status: "success",
          output: "Escalated 1 high-severity message to on-call.",
          durationMs: 410,
          startedAt: isoDaysAgo(0),
        },
      ],
      logs: [
        { at: isoDaysAgo(0), level: "info", message: "Connected to support inbox." },
        { at: isoDaysAgo(0), level: "info", message: "Classified 18 new threads." },
        { at: isoDaysAgo(0), level: "info", message: "Drafted 4 replies." },
      ],
    }),
    createAgentRun({
      id: "run_alpha_brief_latest",
      workspaceId: "alpha",
      agentId: "agent_alpha_daily_brief",
      title: "Daily workspace brief generated",
      status: "success",
      timestamp: isoDaysAgo(1),
      triggerKind: "schedule",
      inputs: { lookback_hours: 24, include_runs: true },
      output: "Brief delivered. 3 open items, 1 question, no failed validations.",
      transcript: [
        {
          id: "rs_alpha_brief_1",
          title: "Pull yesterday's activity",
          status: "success",
          output: "Fetched 12 events.",
          durationMs: 230,
          startedAt: isoDaysAgo(1),
        },
        {
          id: "rs_alpha_brief_2",
          title: "Summarize open work",
          status: "success",
          output: "1 blocker, 2 questions, 4 in-progress items.",
          durationMs: 540,
          startedAt: isoDaysAgo(1),
        },
        {
          id: "rs_alpha_brief_3",
          title: "Send brief",
          status: "success",
          output: "Brief delivered to 3 recipients.",
          durationMs: 310,
          startedAt: isoDaysAgo(1),
        },
      ],
      logs: [
        { at: isoDaysAgo(1), level: "info", message: "Pulled 24h of activity." },
        { at: isoDaysAgo(1), level: "info", message: "Composed morning brief." },
      ],
    }),
    createAgentRun({
      id: "run_beta_dependency_latest",
      workspaceId: "beta",
      agentId: "agent_beta_dependency_watch",
      title: "Dependency escalation skipped while provider key is missing",
      status: "failed",
      timestamp: isoDaysAgo(2),
      triggerKind: "schedule",
      error: "Provider API key is not configured.",
      transcript: [
        {
          id: "rs_beta_dep_1",
          title: "List critical blockers",
          status: "failed",
          output: "Provider API key is not configured.",
          durationMs: 60,
          startedAt: isoDaysAgo(2),
        },
        {
          id: "rs_beta_dep_2",
          title: "Draft escalation notes",
          status: "skipped",
          output: "Skipped because the previous step failed.",
          durationMs: 0,
          startedAt: isoDaysAgo(2),
        },
      ],
      logs: [
        { at: isoDaysAgo(2), level: "warn", message: "Provider connection check failed." },
        { at: isoDaysAgo(2), level: "error", message: "Provider API key is not configured." },
      ],
    }),
    createAgentRun({
      id: "run_gamma_release_latest",
      workspaceId: "gamma",
      agentId: "agent_gamma_release_audit",
      title: "Release audit completed",
      status: "success",
      timestamp: isoDaysAgo(7),
      triggerKind: "manual",
      inputs: { release_label: "gamma-1.0" },
      output: "Audit passed. Validation evidence linked, confirmation recorded.",
      transcript: [
        {
          id: "rs_gamma_audit_1",
          title: "Verify validation evidence",
          status: "success",
          output: "All passed evidence has source + capturer.",
          durationMs: 450,
          startedAt: isoDaysAgo(7),
        },
        {
          id: "rs_gamma_audit_2",
          title: "Check open questions",
          status: "success",
          output: "0 release-blocking questions open.",
          durationMs: 220,
          startedAt: isoDaysAgo(7),
        },
        {
          id: "rs_gamma_audit_3",
          title: "Compose release summary",
          status: "success",
          output: "Summary written to release confirmation.",
          durationMs: 690,
          startedAt: isoDaysAgo(7),
        },
      ],
      logs: [
        { at: isoDaysAgo(7), level: "info", message: "Loaded release confirmation." },
        { at: isoDaysAgo(7), level: "info", message: "Validation evidence verified." },
      ],
    }),
  ];

  const jobs: JobRecord[] = [
    {
      id: "job_alpha_support_schedule",
      workspaceId: "alpha",
      type: "agent.run",
      payload: {
        agentId: "agent_alpha_support",
        triggerKind: "schedule",
        inputs: { mailbox: "support@alpha.example.com", urgency_threshold: "medium" },
      },
      status: "queued",
      attempts: 0,
      maxAttempts: 3,
      scheduledAt: isoDaysAgo(-1),
      cron: "*/15 * * * *",
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: "job_alpha_daily_brief_schedule",
      workspaceId: "alpha",
      type: "agent.run",
      payload: {
        agentId: "agent_alpha_daily_brief",
        triggerKind: "schedule",
        inputs: { lookback_hours: 24, include_runs: true },
      },
      status: "queued",
      attempts: 0,
      maxAttempts: 3,
      scheduledAt: isoDaysAgo(-1),
      cron: "0 8 * * 1-5",
      createdAt,
      updatedAt: createdAt,
    },
  ];

  const releaseConfirmations: ReleaseConfirmationCollection = {
    alpha: {
      id: "release_alpha_pending",
      workspaceId: "alpha",
      confirmed: false,
      summary: "Waiting for the remaining launch question before confirmation.",
      confirmedBy: "",
      versionLabel: "alpha-validation",
      status: "pending",
      releaseNotes: "Waiting for the remaining launch question before confirmation.",
      validationEvidenceIds: ["evidence_alpha_tests"],
      createdAt: isoDaysAgo(1),
      updatedAt: isoDaysAgo(1),
    },
    beta: {
      id: "release_beta_blocked",
      workspaceId: "beta",
      confirmed: false,
      summary: "Release remains pending until dependency ownership is resolved.",
      confirmedBy: "",
      versionLabel: "beta-retry",
      status: "pending",
      releaseNotes: "Release remains pending until dependency ownership is resolved.",
      validationEvidenceIds: ["evidence_beta_failed_retry"],
      createdAt: isoDaysAgo(3),
      updatedAt: isoDaysAgo(2),
    },
    gamma: {
      id: "release_gamma_confirmed",
      workspaceId: "gamma",
      confirmed: true,
      summary: "Initial release confirmed with linked validation evidence.",
      confirmedBy: "Gamma Owner",
      versionLabel: "gamma-1.0",
      status: "confirmed",
      confirmedByUserId: "user_gamma",
      confirmedAt: isoDaysAgo(7),
      releaseNotes: "Initial release confirmed with linked validation evidence.",
      validationEvidenceIds: ["evidence_gamma_release_demo"],
      createdAt: isoDaysAgo(8),
      updatedAt: isoDaysAgo(7),
    },
  };

  const activationSignals: ActivationSignalRecord[] = [
    createActivationSignal(
      "activation_signal_alpha_retry_1",
      "alpha",
      "retry",
      isoDaysAgo(1),
      "run_alpha_support_latest",
    ),
    createActivationSignal(
      "activation_signal_alpha_scope_1",
      "alpha",
      "scope_change",
      isoDaysAgo(3),
      "question_alpha_reporting",
    ),
    createActivationSignal(
      "activation_signal_beta_retry_1",
      "beta",
      "retry",
      isoDaysAgo(2),
      "run_beta_dependency_latest",
    ),
    createActivationSignal("activation_signal_beta_retry_2", "beta", "retry", isoDaysAgo(1)),
    createActivationSignal(
      "activation_signal_beta_scope_1",
      "beta",
      "scope_change",
      isoDaysAgo(3),
      "question_beta_scope",
    ),
    createActivationSignal("activation_signal_beta_scope_2", "beta", "scope_change", isoDaysAgo(2)),
  ];

  const activationFacts: Record<string, WorkspaceActivationFacts> = {
    alpha: {
      now: createdAt,
      createdAt: isoDaysAgo(9),
      briefCapturedAt: isoDaysAgo(9),
      requirementsDefinedAt: isoDaysAgo(7),
      planDefinedAt: isoDaysAgo(7),
      implementationStartedAt: isoDaysAgo(4),
      testsPassedAt: isoDaysAgo(1),
      blockerCount: 0,
      dependencyBlockerCount: 0,
      openQuestionCount: 1,
      criticalIssueCount: 0,
      scopeChangeCount: 1,
      failedValidationCount: 0,
      retryCount: 1,
    },
    beta: {
      now: createdAt,
      createdAt: isoDaysAgo(14),
      briefCapturedAt: isoDaysAgo(14),
      requirementsDefinedAt: isoDaysAgo(11),
      planDefinedAt: isoDaysAgo(10),
      implementationStartedAt: isoDaysAgo(6),
      blockerCount: 2,
      dependencyBlockerCount: 1,
      openQuestionCount: 3,
      criticalIssueCount: 1,
      scopeChangeCount: 2,
      failedValidationCount: 1,
      retryCount: 2,
    },
    gamma: {
      now: createdAt,
      createdAt: isoDaysAgo(30),
      briefCapturedAt: isoDaysAgo(30),
      requirementsDefinedAt: isoDaysAgo(28),
      planDefinedAt: isoDaysAgo(28),
      implementationStartedAt: isoDaysAgo(24),
      completedAt: isoDaysAgo(12),
      testsPassedAt: isoDaysAgo(11),
      validationPassedAt: isoDaysAgo(10),
      releaseConfirmedAt: isoDaysAgo(7),
      blockerCount: 0,
      dependencyBlockerCount: 0,
      openQuestionCount: 0,
      criticalIssueCount: 0,
      scopeChangeCount: 0,
      failedValidationCount: 0,
      retryCount: 0,
    },
  };

  return {
    users,
    sessions: [],
    rateLimits: [],
    workspaces,
    memberships,
    workspaceInvitations: [],
    invitationEmailDeliveries: [],
    workspaceBriefs,
    workspaceBriefVersions: [],
    requirements,
    implementationPlanItems,
    workflowConcerns,
    validationEvidence,
    releaseConfirmations,
    onboardingStates: [
      createOnboardingState(
        "alpha",
        ["create_workspace_profile", "define_requirements", "define_plan", "start_implementation"],
        "validate",
        createdAt,
      ),
      createOnboardingState(
        "beta",
        ["create_workspace_profile", "define_requirements", "define_plan"],
        "start_implementation",
        createdAt,
      ),
      createOnboardingState(
        "gamma",
        [
          "create_workspace_profile",
          "define_requirements",
          "define_plan",
          "start_implementation",
          "validate",
          "confirm_release",
        ],
        "confirm_release",
        createdAt,
        true,
      ),
    ],
    activities: [
      createActivity(
        "alpha",
        "account",
        "account.created",
        { type: "system", id: "seed" },
        { title: "Workspace initialized" },
        createdAt,
      ),
      createActivity(
        "beta",
        "account",
        "account.created",
        { type: "system", id: "seed" },
        { title: "Workspace initialized" },
        createdAt,
      ),
      createActivity(
        "gamma",
        "account",
        "account.created",
        { type: "system", id: "seed" },
        { title: "Workspace initialized" },
        createdAt,
      ),
    ],
    activationSignals,
    agents,
    generatedApps: [],
    providers,
    agentRuns,
    workspaceEnvVars,
    apiKeys: [],
    providerCalls: [],
    jobs,
    jobMetricSnapshots: [],
    alertEvents: [],
    shareTokens: [],
    workerCredentials: [],
    packetProductCredentials: [],
    workerPackageReceipts: [],
    workerDefinitions: [],
    workerVersions: [],
    workerDeployments: [],
    workerRuns: [],
    workerCheckpoints: [],
    workerEffectReceipts: [],
    workerBudgetReservations: [],
    workerAttentionRequests: [],
    workerApprovalGrants: [],
    workerControlCommands: [],
    workerNotificationDeliveries: [],
    workerDeploymentRollouts: [],
    workerCommandReceipts: [],
    workerEvents: [],
    workerEvidenceEntries: [],
    workerArtifactManifests: [],
    workerActivationInboxes: [],
    workerActivationPayloads: [],
    activationFacts,
    activationMilestones: {},
    activationReadModels: {},
  };
}

export function createSeedStore(): PacketAgentData {
  return seedStore();
}

function createSeedUser(
  id: string,
  email: string,
  displayName: string,
  timestamp: string,
): UserRecord {
  return {
    id,
    email,
    displayName,
    timezone: "UTC",
    passwordHash: hashPassword("demo12345"),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function createWorkspaceRecord(
  id: string,
  name: string,
  website: string,
  automationGoal: string,
  timestamp: string,
): WorkspaceRecord {
  return {
    id,
    slug: slugify(name) || id,
    name,
    website,
    automationGoal,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function createOnboardingState(
  workspaceId: string,
  completedSteps: OnboardingStepKey[],
  currentStep: OnboardingStepKey,
  timestamp: string,
  completed = false,
): OnboardingStateRecord {
  return {
    workspaceId,
    status: completed ? "completed" : completedSteps.length > 0 ? "in_progress" : "not_started",
    currentStep,
    completedSteps,
    completedAt: completed ? timestamp : undefined,
    updatedAt: timestamp,
  };
}

function createActivity(
  workspaceId: string,
  scope: ActivityRecord["scope"],
  event: string,
  actor: ActivityRecord["actor"],
  data: ActivityRecord["data"],
  timestamp: string,
): ActivityRecord {
  return {
    id: `${workspaceId}_${event}_${timestamp}`,
    workspaceId,
    scope,
    event,
    actor,
    data,
    occurredAt: timestamp,
  };
}

function createProvider(
  id: string,
  workspaceId: string,
  name: string,
  kind: ProviderKind,
  defaultModel: string,
  apiKeyConfigured: boolean,
  timestamp: string,
  baseUrl?: string,
): ProviderRecord {
  return {
    id,
    workspaceId,
    name,
    kind,
    defaultModel,
    baseUrl,
    apiKeyConfigured,
    status: apiKeyConfigured ? "connected" : "missing_key",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function createAgent(input: {
  id: string;
  workspaceId: string;
  createdByUserId: string;
  name: string;
  description: string;
  instructions: string;
  providerId?: string;
  model?: string;
  tools: string[];
  schedule?: string;
  triggerKind?: AgentTriggerKind;
  playbook?: AgentPlaybookStep[];
  status: AgentStatus;
  templateId?: string;
  inputSchema?: AgentInputField[];
  timestamp: string;
}): AgentRecord {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    createdByUserId: input.createdByUserId,
    name: input.name,
    description: input.description,
    instructions: input.instructions,
    providerId: input.providerId,
    model: input.model,
    tools: input.tools,
    schedule: input.schedule,
    triggerKind: input.triggerKind,
    playbook: input.playbook,
    status: input.status,
    templateId: input.templateId,
    inputSchema: input.inputSchema ?? [],
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  };
}

function createAgentRun(input: {
  id: string;
  workspaceId: string;
  agentId: string;
  title: string;
  status: AgentRunStatus;
  timestamp: string;
  triggerKind?: AgentTriggerKind;
  transcript?: AgentRunStep[];
  inputs?: Record<string, string | number | boolean>;
  output?: string;
  error?: string;
  logs?: AgentRunLogEntry[];
}): AgentRunRecord {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    title: input.title,
    status: input.status,
    triggerKind: input.triggerKind,
    transcript: input.transcript,
    startedAt: input.timestamp,
    completedAt:
      input.status === "queued" || input.status === "running" ? undefined : input.timestamp,
    inputs: input.inputs,
    output: input.output,
    error: input.error,
    logs: input.logs ?? [],
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  };
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function createActivationSignal(
  id: string,
  workspaceId: string,
  kind: ActivationSignalRecord["kind"],
  timestamp: string,
  sourceId?: string,
): ActivationSignalRecord {
  return {
    id,
    workspaceId,
    kind,
    source: "seed",
    origin: "system_observed",
    sourceId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
