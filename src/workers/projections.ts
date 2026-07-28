import type {
  AgentInputField,
  AgentRecord,
  ImplementationPlanItemRecord,
  RequirementRecord,
  ValidationEvidenceRecord,
  WorkflowConcernRecord,
  WorkspaceBriefRecord,
  WorkspaceRecord,
} from "../packetagent-store.js";
import { parseCron } from "../jobs/cron.js";
import {
  WORKER_CONTRACT_SCHEMA_VERSION,
  type JsonPrimitive,
  type WorkerActorReference,
  type WorkerInputField,
  type WorkerPolicy,
  type WorkerReadModelProjection,
  type WorkerToolCapability,
  type WorkerTrigger,
  type WorkerVersionContent,
} from "./types.js";
import {
  assertValidWorkerDefinition,
  assertValidWorkerVersion,
  computeWorkerVersionContentDigest,
} from "./validation.js";

export const LEGACY_PROJECTION_POLICY: WorkerPolicy = {
  budgets: {
    maxElapsedMs: 15 * 60 * 1000,
    maxIterations: 8,
    maxProviderCostUsd: 1,
    maxConsecutiveFailures: 3,
    maxToolCalls: 32,
    rolling: {
      windowMs: 24 * 60 * 60 * 1_000,
      workspace: {
        maxProviderCostUsd: 100,
        maxBillableActions: 3_200,
      },
      deployment: {
        maxProviderCostUsd: 100,
        maxBillableActions: 3_200,
      },
    },
  },
  retry: {
    maxAttempts: 2,
    initialBackoffMs: 1_000,
    maxBackoffMs: 30_000,
    backoffMultiplier: 2,
  },
  permissions: {
    default: "deny",
    allowedCapabilityIds: [],
  },
  attention: {
    approvalTimeoutMs: 15 * 60 * 1_000,
    escalationAfterMs: 5 * 60 * 1_000,
    onExpiration: "pause",
  },
};

export interface LegacyAgentProjectionOptions {
  readonly timezone?: string;
  readonly policy?: WorkerPolicy;
}

export interface LegacyWorkflowProjectionInput {
  readonly workspace: WorkspaceRecord;
  readonly brief: WorkspaceBriefRecord;
  readonly requirements?: readonly RequirementRecord[];
  readonly planItems?: readonly ImplementationPlanItemRecord[];
  readonly concerns?: readonly WorkflowConcernRecord[];
  readonly validationEvidence?: readonly ValidationEvidenceRecord[];
  readonly createdBy?: WorkerActorReference;
  readonly policy?: WorkerPolicy;
}

function compatibilityId(kind: "agent" | "workflow", sourceId: string, suffix: string): string {
  return `compat:${kind}:${sourceId}:${suffix}`;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function legacyToolCapabilities(agent: AgentRecord): WorkerToolCapability[] {
  const toolNames = uniqueStrings(agent.enabledTools ?? agent.tools);
  return toolNames.map((tool) => ({
    id: `legacy-tool:${tool}`,
    tool,
    verbs: ["execute"],
    resources: ["*"],
    effect: "execute",
    approval: "always",
  }));
}

function policyWithCapabilities(
  policy: WorkerPolicy,
  tools: readonly WorkerToolCapability[],
): WorkerPolicy {
  return {
    ...policy,
    budgets: { ...policy.budgets },
    retry: { ...policy.retry },
    attention: { ...policy.attention },
    permissions: {
      default: "deny",
      allowedCapabilityIds: tools.map((tool) => tool.id),
    },
  };
}

function legacyDefaultValue(field: AgentInputField): JsonPrimitive | undefined {
  const value = field.defaultValue;
  if (value === undefined) return undefined;
  if (field.type === "number") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (field.type === "boolean") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return value;
}

function legacyInputFields(fields: readonly AgentInputField[]): WorkerInputField[] {
  return fields.map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    ...(field.description ? { description: field.description } : {}),
    ...(field.options ? { options: [...field.options] } : {}),
    ...(field.defaultValue !== undefined ? { defaultValue: legacyDefaultValue(field) } : {}),
  }));
}

function agentTrigger(
  agent: AgentRecord,
  timezone: string,
): { trigger: WorkerTrigger; warnings: WorkerReadModelProjection["warnings"] } {
  if (agent.triggerKind === "schedule") {
    const expression = agent.schedule?.trim();
    if (expression) {
      try {
        parseCron(expression);
        return {
          trigger: {
            id: "legacy-trigger",
            kind: "cron",
            enabled: agent.status === "active",
            expression,
            timezone,
            description: "Projected from the legacy Agent schedule.",
          },
          warnings:
            timezone === "UTC"
              ? [
                  {
                    code: "projection.schedule_timezone_defaulted",
                    message:
                      "The legacy Agent has no schedule timezone; the draft projection uses UTC.",
                    path: "version.content.triggers[0].timezone",
                  },
                ]
              : [],
        };
      } catch {
        return {
          trigger: {
            id: "legacy-trigger",
            kind: "manual",
            enabled: agent.status === "active",
            description: "Manual fallback for an invalid legacy Agent schedule.",
          },
          warnings: [
            {
              code: "projection.invalid_schedule",
              message:
                "The legacy Agent schedule is invalid and was projected as a manual trigger.",
              path: "version.content.triggers[0]",
            },
          ],
        };
      }
    }
    return {
      trigger: {
        id: "legacy-trigger",
        kind: "manual",
        enabled: agent.status === "active",
        description: "Manual fallback for a legacy Agent with no schedule expression.",
      },
      warnings: [
        {
          code: "projection.missing_schedule",
          message:
            "The legacy Agent has schedule trigger kind but no schedule and was projected as manual.",
          path: "version.content.triggers[0]",
        },
      ],
    };
  }
  if (agent.triggerKind === "webhook" || agent.triggerKind === "email") {
    return {
      trigger: {
        id: "legacy-trigger",
        kind: "webhook",
        enabled: agent.status === "active",
        adapter: agent.triggerKind === "email" ? "email" : "http",
        eventType:
          agent.triggerKind === "email"
            ? "packetagent.legacy.email.received"
            : "packetagent.legacy.agent.requested",
        webhookRef: `legacy-agent:${agent.id}:webhook`,
        description: `Projected from the legacy Agent ${agent.triggerKind} trigger.`,
      },
      warnings: [],
    };
  }
  return {
    trigger: {
      id: "legacy-trigger",
      kind: "manual",
      enabled: agent.status === "active",
      description: "Projected from the legacy Agent manual trigger.",
    },
    warnings: [],
  };
}

function agentInstructions(agent: AgentRecord): string {
  const instructions = agent.instructions.trim();
  const playbook =
    agent.playbook?.filter((step) => step.title.trim() || step.instruction.trim()) ?? [];
  if (playbook.length === 0) return instructions;
  return [
    instructions,
    "",
    "Legacy playbook:",
    ...playbook.map((step, index) => `${index + 1}. ${step.title}: ${step.instruction}`),
  ].join("\n");
}

export function projectLegacyAgentToWorker(
  agent: AgentRecord,
  options: LegacyAgentProjectionOptions = {},
): WorkerReadModelProjection {
  const definitionId = compatibilityId("agent", agent.id, "definition");
  const versionId = compatibilityId("agent", agent.id, "version:1");
  const timezone = options.timezone?.trim() || "UTC";
  const tools = legacyToolCapabilities(agent);
  const triggerResult = agentTrigger(agent, timezone);
  const warnings = [...triggerResult.warnings];
  if (tools.length > 0) {
    warnings.push({
      code: "projection.coarse_tool_capabilities",
      message:
        "Legacy whole-tool grants were projected as approval-required execute access to all resources.",
      path: "version.content.tools",
    });
  }
  warnings.push({
    code: "projection.requires_validation",
    message:
      "Legacy Agent projections remain draft until validated and deployed through the Worker lifecycle.",
    path: "version.status",
  });

  const content: WorkerVersionContent = {
    objective: agent.description.trim() || agent.name.trim(),
    instructions: agentInstructions(agent),
    inputSchema: {
      fields: legacyInputFields(agent.inputSchema),
      additionalProperties: false,
    },
    execution: {
      routeKey: agent.routeKey?.trim() || "smart",
      ...(agent.providerId ? { providerId: agent.providerId } : {}),
      ...(agent.model ? { model: agent.model } : {}),
      target: { kind: "packetagent" },
    },
    tools,
    credentialRefs: [],
    triggers: [triggerResult.trigger],
    policy: policyWithCapabilities(options.policy ?? LEGACY_PROJECTION_POLICY, tools),
    exitPredicates: [
      {
        id: "legacy-objective-satisfied",
        kind: "objective_satisfied",
        description:
          "The projected Agent has produced the requested result and no further tool action is needed.",
      },
    ],
    acceptanceCommands: [],
    notificationRoutes: [],
  };
  const createdBy: WorkerActorReference = {
    type: "user",
    id: agent.createdByUserId,
  };
  const definition = {
    schemaVersion: WORKER_CONTRACT_SCHEMA_VERSION,
    id: definitionId,
    workspaceId: agent.workspaceId,
    name: agent.name,
    description: agent.description.trim() || agent.name,
    status: agent.status === "archived" ? ("retired" as const) : ("draft" as const),
    currentVersionId: versionId,
    createdBy,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
  const version = {
    schemaVersion: WORKER_CONTRACT_SCHEMA_VERSION,
    id: versionId,
    workspaceId: agent.workspaceId,
    workerDefinitionId: definitionId,
    version: 1,
    status: "draft" as const,
    content,
    contentDigest: computeWorkerVersionContentDigest(content),
    source: {
      product: "PacketAgent" as const,
      kind: "legacy_agent" as const,
      sourceId: agent.id,
    },
    createdBy,
    createdAt: agent.updatedAt,
  };
  assertValidWorkerDefinition(definition);
  assertValidWorkerVersion(version);
  return { definition, version, warnings };
}

function workflowActor(input: LegacyWorkflowProjectionInput): WorkerActorReference {
  if (input.createdBy) return input.createdBy;
  if (input.brief.updatedByUserId) return { type: "user", id: input.brief.updatedByUserId };
  return { type: "system", id: "packetagent-legacy-workflow-projection" };
}

function workflowInstructions(input: LegacyWorkflowProjectionInput): string {
  const sections: string[] = [input.brief.summary.trim()];
  if (input.brief.goals?.length) {
    sections.push("", "Goals:", ...input.brief.goals.map((goal) => `- ${goal}`));
  }
  if (input.requirements?.length) {
    sections.push(
      "",
      "Requirements:",
      ...input.requirements.map((requirement) => {
        const detail = requirement.detail ?? requirement.description;
        return `- [${requirement.priority}/${requirement.status}] ${requirement.title}${detail ? `: ${detail}` : ""}`;
      }),
    );
  }
  if (input.planItems?.length) {
    sections.push(
      "",
      "Implementation plan:",
      ...[...input.planItems]
        .sort((left, right) => left.order - right.order)
        .map((item) => `- [${item.status}] ${item.title}: ${item.description}`),
    );
  }
  if (input.concerns?.length) {
    sections.push(
      "",
      "Concerns:",
      ...input.concerns.map(
        (concern) =>
          `- [${concern.severity}/${concern.status}] ${concern.title}: ${concern.description}`,
      ),
    );
  }
  if (input.validationEvidence?.length) {
    sections.push(
      "",
      "Validation evidence:",
      ...input.validationEvidence.map((evidence) => {
        const outcome = evidence.outcome ?? evidence.status ?? "pending";
        return `- [${outcome}] ${evidence.title}${evidence.detail ? `: ${evidence.detail}` : ""}`;
      }),
    );
  }
  return sections.join("\n");
}

export function projectLegacyWorkflowToWorker(
  input: LegacyWorkflowProjectionInput,
): WorkerReadModelProjection {
  const definitionId = compatibilityId("workflow", input.workspace.id, "definition");
  const versionId = compatibilityId("workflow", input.workspace.id, "version:1");
  const createdBy = workflowActor(input);
  const content: WorkerVersionContent = {
    objective: input.brief.desiredOutcome?.trim() || input.brief.summary.trim(),
    instructions: workflowInstructions(input),
    inputSchema: {
      fields: [],
      additionalProperties: false,
    },
    execution: {
      routeKey: "smart",
      target: { kind: "packetagent" },
    },
    tools: [],
    credentialRefs: [],
    triggers: [
      {
        id: "legacy-workflow-manual",
        kind: "manual",
        enabled: true,
        description: "Legacy workspace workflows project as manual-only Worker drafts.",
      },
    ],
    policy: policyWithCapabilities(input.policy ?? LEGACY_PROJECTION_POLICY, []),
    exitPredicates: [
      {
        id: "legacy-workflow-objective",
        kind: "objective_satisfied",
        description: input.brief.successMetrics?.length
          ? `The objective is satisfied when these success metrics are met: ${input.brief.successMetrics.join("; ")}`
          : "The workflow objective is satisfied and its required validation evidence has been recorded.",
      },
    ],
    acceptanceCommands: [],
    notificationRoutes: [],
  };
  const definition = {
    schemaVersion: WORKER_CONTRACT_SCHEMA_VERSION,
    id: definitionId,
    workspaceId: input.workspace.id,
    name: `${input.workspace.name} workflow`,
    description: input.brief.summary,
    status: "draft" as const,
    currentVersionId: versionId,
    createdBy,
    createdAt: input.brief.createdAt,
    updatedAt: input.brief.updatedAt,
  };
  const version = {
    schemaVersion: WORKER_CONTRACT_SCHEMA_VERSION,
    id: versionId,
    workspaceId: input.workspace.id,
    workerDefinitionId: definitionId,
    version: 1,
    status: "draft" as const,
    content,
    contentDigest: computeWorkerVersionContentDigest(content),
    source: {
      product: "PacketAgent" as const,
      kind: "legacy_workflow" as const,
      sourceId: input.workspace.id,
    },
    createdBy,
    createdAt: input.brief.updatedAt,
  };
  assertValidWorkerDefinition(definition);
  assertValidWorkerVersion(version);
  return {
    definition,
    version,
    warnings: [
      {
        code: "projection.workflow_authoring_context",
        message:
          "Workspace workflow records are authoring context; the projection is manual, tool-less, and draft.",
        path: "version.status",
      },
      {
        code: "projection.requires_validation",
        message:
          "The projected workflow must be reviewed, validated, and deployed before activation.",
        path: "version.status",
      },
    ],
  };
}
