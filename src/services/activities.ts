import {
  listReleaseConfirmationsForWorkspace,
  loadStore,
  loadStoreAsync,
  type ActivityRecord,
  type AgentRecord,
  type AgentRunRecord,
  type ImplementationPlanItemRecord,
  type ReleaseConfirmationRecord,
  type RequirementRecord,
  type ValidationEvidenceRecord,
  type WorkflowConcernRecord,
  type PacketAgentData,
} from "../packetagent-store";
import {
  type AuthenticatedContext,
  httpError,
  redactActivity,
} from "./context.js";

export function listWorkspaceActivities(context: AuthenticatedContext) {
  return workspaceActivitiesFromData(loadStore(), context.workspace.id, 50).map(redactActivity);
}

export async function listWorkspaceActivitiesAsync(context: AuthenticatedContext) {
  const data = await loadStoreAsync();
  return workspaceActivitiesFromData(data, context.workspace.id, 50).map(redactActivity);
}

export function getWorkspaceActivityDetail(context: AuthenticatedContext, activityId: string) {
  const data = loadStore();
  return getWorkspaceActivityDetailFromData(data, context, activityId);
}

export async function getWorkspaceActivityDetailAsync(context: AuthenticatedContext, activityId: string) {
  const data = await loadStoreAsync();
  return getWorkspaceActivityDetailFromData(data, context, activityId);
}

function getWorkspaceActivityDetailFromData(data: PacketAgentData, context: AuthenticatedContext, activityId: string) {
  const activities = workspaceActivitiesFromData(data, context.workspace.id, 50).map(redactActivity);
  const index = activities.findIndex((entry) => entry.id === activityId);
  if (index === -1) throw httpError(404, "activity not found");

  const activity = activities[index];
  return {
    activity,
    previous: index > 0 ? activities[index - 1] : null,
    next: index < activities.length - 1 ? activities[index + 1] : null,
    related: buildActivityRelatedContext(data, context.workspace.id, activity),
  };
}

function workspaceActivitiesFromData(data: PacketAgentData, workspaceId: string, limit?: number) {
  const activities = data.activities
    .filter((entry) => entry.workspaceId === workspaceId)
    .sort((left, right) => {
      const cmp = right.occurredAt.localeCompare(left.occurredAt);
      return cmp !== 0 ? cmp : right.id.localeCompare(left.id);
    });
  return limit && limit > 0 ? activities.slice(0, limit) : activities;
}

type ActivityRelatedContext = {
  agent?: ReturnType<typeof summarizeAgent>;
  run?: ReturnType<typeof summarizeAgentRun>;
  blocker?: ReturnType<typeof summarizeWorkflowConcern>;
  question?: ReturnType<typeof summarizeWorkflowConcern>;
  planItem?: ReturnType<typeof summarizePlanItem>;
  requirement?: ReturnType<typeof summarizeRequirement>;
  evidence?: ReturnType<typeof summarizeValidationEvidence>;
  release?: ReturnType<typeof summarizeReleaseConfirmation>;
  workflow?: {
    requirements?: ReturnType<typeof summarizeRequirement>[];
    planItems?: ReturnType<typeof summarizePlanItem>[];
    blockers?: ReturnType<typeof summarizeWorkflowConcern>[];
    questions?: ReturnType<typeof summarizeWorkflowConcern>[];
    validationEvidence?: ReturnType<typeof summarizeValidationEvidence>[];
    releaseConfirmation?: ReturnType<typeof summarizeReleaseConfirmation>;
  };
};

function buildActivityRelatedContext(
  data: PacketAgentData,
  workspaceId: string,
  activity: ActivityRecord,
): ActivityRelatedContext {
  const related: ActivityRelatedContext = {};
  const agentId = stringDataValue(activity.data, "agentId");
  const runId = stringDataValue(activity.data, "runId");
  const blockerId = stringDataValue(activity.data, "blockerId");
  const questionId = stringDataValue(activity.data, "questionId");
  const planItemId = stringDataValue(activity.data, "planItemId");
  const requirementId = stringDataValue(activity.data, "requirementId");
  const evidenceId = stringDataValue(activity.data, "evidenceId");
  const releaseId = stringDataValue(activity.data, "releaseId");

  const agent = agentId ? data.agents.find((entry) => entry.workspaceId === workspaceId && entry.id === agentId) : undefined;
  if (agent) related.agent = summarizeAgent(agent);

  const run = runId ? data.agentRuns.find((entry) => entry.workspaceId === workspaceId && entry.id === runId) : undefined;
  if (run) related.run = summarizeAgentRun(run);

  const blocker = blockerId ? data.workflowConcerns.find((entry) => entry.workspaceId === workspaceId && entry.id === blockerId && entry.kind === "blocker") : undefined;
  if (blocker) related.blocker = summarizeWorkflowConcern(blocker);

  const question = questionId ? data.workflowConcerns.find((entry) => entry.workspaceId === workspaceId && entry.id === questionId && entry.kind === "open_question") : undefined;
  if (question) related.question = summarizeWorkflowConcern(question);

  const planItem = planItemId ? data.implementationPlanItems.find((entry) => entry.workspaceId === workspaceId && entry.id === planItemId) : undefined;
  if (planItem) related.planItem = summarizePlanItem(planItem);

  const requirement = requirementId ? data.requirements.find((entry) => entry.workspaceId === workspaceId && entry.id === requirementId) : undefined;
  if (requirement) related.requirement = summarizeRequirement(requirement);

  const evidence = evidenceId ? data.validationEvidence.find((entry) => entry.workspaceId === workspaceId && entry.id === evidenceId) : undefined;
  if (evidence) related.evidence = summarizeValidationEvidence(evidence);

  const release = releaseId ? listReleaseConfirmationsForWorkspace(data, workspaceId).find((entry) => entry.id === releaseId || entry.workspaceId === releaseId) : undefined;
  if (release) related.release = summarizeReleaseConfirmation(release);

  const workflow = {
    ...(related.requirement ? { requirements: [related.requirement] } : {}),
    ...(related.planItem ? { planItems: [related.planItem] } : {}),
    ...(related.blocker ? { blockers: [related.blocker] } : {}),
    ...(related.question ? { questions: [related.question] } : {}),
    ...(related.evidence ? { validationEvidence: [related.evidence] } : {}),
    ...(related.release ? { releaseConfirmation: related.release } : {}),
  };
  if (Object.keys(workflow).length > 0) related.workflow = workflow;

  return related;
}

function stringDataValue(data: ActivityRecord["data"], key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function summarizeAgent(agent: AgentRecord) {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    status: agent.status,
    triggerKind: agent.triggerKind,
    model: agent.model,
    updatedAt: agent.updatedAt,
  };
}

function summarizeAgentRun(run: AgentRunRecord) {
  return {
    id: run.id,
    agentId: run.agentId,
    title: run.title,
    status: run.status,
    triggerKind: run.triggerKind,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function summarizeWorkflowConcern(concern: WorkflowConcernRecord) {
  return {
    id: concern.id,
    kind: concern.kind,
    title: concern.title,
    status: concern.status,
    severity: concern.severity,
    relatedPlanItemId: concern.relatedPlanItemId,
    relatedRequirementId: concern.relatedRequirementId,
    updatedAt: concern.updatedAt,
  };
}

function summarizePlanItem(planItem: ImplementationPlanItemRecord) {
  return {
    id: planItem.id,
    title: planItem.title,
    status: planItem.status,
    order: planItem.order,
    requirementIds: planItem.requirementIds,
    ownerUserId: planItem.ownerUserId,
    updatedAt: planItem.updatedAt,
  };
}

function summarizeRequirement(requirement: RequirementRecord) {
  return {
    id: requirement.id,
    title: requirement.title,
    priority: requirement.priority,
    status: requirement.status,
    updatedAt: requirement.updatedAt,
  };
}

function summarizeValidationEvidence(evidence: ValidationEvidenceRecord) {
  return {
    id: evidence.id,
    title: evidence.title,
    type: evidence.type,
    status: evidence.status,
    planItemId: evidence.planItemId,
    requirementIds: evidence.requirementIds,
    capturedAt: evidence.capturedAt,
    updatedAt: evidence.updatedAt,
  };
}

function summarizeReleaseConfirmation(release: ReleaseConfirmationRecord) {
  return {
    id: release.id,
    versionLabel: release.versionLabel,
    status: release.status,
    confirmed: release.confirmed,
    confirmedAt: release.confirmedAt,
    summary: release.summary,
    updatedAt: release.updatedAt,
  };
}
