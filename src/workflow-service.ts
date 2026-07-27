import { generateId, now } from "./auth-utils";
import {
  appendWorkspaceBriefVersion,
  findWorkspaceBriefIndexed,
  findWorkspaceBrief,
  findWorkspaceBriefVersionIndexed,
  findWorkspaceByIdIndexed,
  listImplementationPlanItemsForWorkspaceIndexed,
  listReleaseConfirmationsForWorkspaceIndexed,
  listReleaseConfirmationsForWorkspace,
  listRequirementsForWorkspaceIndexed,
  listValidationEvidenceForWorkspaceIndexed,
  listWorkflowConcernsForWorkspaceIndexed,
  listWorkspaceBriefVersionsIndexed,
  listWorkspaceBriefVersions,
  loadStore,
  loadStoreAsync,
  mutateStore,
  mutateStoreAsync,
  nextIncompleteStep,
  ONBOARDING_STEPS,
  recordActivity,
  upsertActivationSignal,
  upsertReleaseConfirmation,
  upsertWorkspaceBrief,
  type ActivityRecord,
  type ActivationSignalRecord,
  type ImplementationPlanItemRecord,
  type ImplementationPlanItemStatus,
  type OnboardingStepKey,
  type ReleaseConfirmationRecord,
  type RequirementPriority,
  type RequirementRecord,
  type RequirementStatus,
  type PacketAgentData,
  type UserRecord,
  type ValidationEvidenceOutcome,
  type ValidationEvidenceRecord,
  type ValidationEvidenceType,
  type WorkflowConcernRecord,
  type WorkflowConcernSeverity,
  type WorkflowConcernStatus,
  type WorkspaceBriefRecord,
  type WorkspaceBriefVersionRecord,
  type WorkspaceRecord,
} from "./packetagent-store";

export type WorkflowContext = {
  user: UserRecord;
  workspace: WorkspaceRecord;
};

export type UpdateWorkspaceBriefInput = {
  summary: string;
  goals?: string[];
  audience?: string;
  constraints?: string;
  problemStatement?: string;
  targetCustomers?: string[];
  desiredOutcome?: string;
  successMetrics?: string[];
};

export type WorkflowRequirementInput = {
  id?: string;
  title: string;
  detail?: string;
  description?: string;
  priority?: RequirementPriority;
  status?: RequirementStatus;
  acceptanceCriteria?: string[];
  source?: RequirementRecord["source"];
};

export type WorkflowPlanItemInput = {
  id?: string;
  requirementIds?: string[];
  title: string;
  description?: string;
  status?: ImplementationPlanItemStatus;
  ownerUserId?: string;
};

export type WorkflowConcernInput = {
  id?: string;
  title?: string;
  prompt?: string;
  answer?: string;
  detail?: string;
  description?: string;
  status?: WorkflowConcernStatus | "answered";
  severity?: WorkflowConcernSeverity;
  dependency?: boolean;
  relatedPlanItemId?: string;
  relatedRequirementId?: string;
  ownerUserId?: string;
  resolutionNote?: string;
};

export type WorkflowValidationEvidenceInput = {
  id?: string;
  planItemId?: string;
  requirementIds?: string[];
  type?: ValidationEvidenceType;
  title: string;
  detail?: string;
  description?: string;
  status?: ValidationEvidenceOutcome;
  outcome?: ValidationEvidenceOutcome;
  evidenceUrl?: string;
  source?: string;
};

export type UpdateReleaseConfirmationInput = {
  confirmed: boolean;
  summary?: string;
  confirmedBy?: string;
  versionLabel?: string;
  validationEvidenceIds?: string[];
};

export interface WorkspaceBriefTemplate {
  id: string;
  name: string;
  description: string;
  brief: UpdateWorkspaceBriefInput;
}

export const WORKSPACE_BRIEF_TEMPLATES: WorkspaceBriefTemplate[] = [
  {
    id: "saas-activation",
    name: "SaaS activation rollout",
    description: "Capture an activation rollout for a SaaS product going through onboarding.",
    brief: {
      summary: "Roll out a guided activation experience that lifts the percentage of new accounts reaching first value within their first session.",
      problemStatement: "New accounts complete sign-up but stall before reaching the activation milestone, leaving the team blind to where users drop off.",
      desiredOutcome: "Operators can see exactly which onboarding steps are working and intervene the moment a workspace stalls.",
      audience: "Activation lead, customer success manager, product manager",
      constraints: "First release must work without changes to the existing sign-up form and reuse the in-product help widget.",
      goals: [
        "Surface stalled accounts within one business day",
        "Provide a single owner per stalled account",
        "Trigger a follow-up nudge when a workspace stays idle for 48 hours",
      ],
      targetCustomers: ["Self-serve trial accounts", "Pilot customers in the first 30 days"],
      successMetrics: [
        "60% of new workspaces reach activation within 7 days",
        "Stalled workspaces have an owner assigned within 24 hours",
        "Activation playbook is documented and adopted",
      ],
    },
  },
  {
    id: "internal-workflow",
    name: "Internal workflow automation",
    description: "Frame an internal automation that consolidates work currently spread across a few teams.",
    brief: {
      summary: "Automate the operational handoffs that slow down our weekly release cycle and recover team focus time.",
      problemStatement: "Cross-team handoffs rely on chat threads and shared docs, which causes work to stall and forces leads to chase status.",
      desiredOutcome: "Each handoff has a clear owner, a status, and an audit trail without leaving the team's existing tools.",
      audience: "Engineering lead, operations partner, release manager",
      constraints: "Automation should fit inside the current release window and avoid replacing existing tooling outright.",
      goals: [
        "Capture every handoff as a tracked task",
        "Notify the next owner automatically",
        "Surface stalled handoffs to the release manager",
      ],
      targetCustomers: ["Release managers", "Engineering leads", "Operations partners"],
      successMetrics: [
        "Average handoff age drops below one business day",
        "Release retros stop logging missed handoffs",
        "Lead status sync time drops to under 15 minutes per week",
      ],
    },
  },
  {
    id: "release-readiness",
    name: "Release readiness checklist",
    description: "Lock in the validation evidence and launch checklist for an upcoming release.",
    brief: {
      summary: "Stand up a release readiness checklist so every shipped change carries the validation evidence the team needs to confirm the release.",
      problemStatement: "Recent releases shipped without recorded validation evidence, making it hard to audit whether each change passed its checks.",
      desiredOutcome: "Releases ship only after the checklist is green, and every confirmation links back to the evidence that supports it.",
      audience: "Release manager, QA partner, product manager",
      constraints: "Checklist must work with the existing CI pipeline and complete inside the release window.",
      goals: [
        "Document the validation evidence required per release type",
        "Block release confirmation until evidence is attached",
        "Capture the release confirmation owner for the audit trail",
      ],
      targetCustomers: ["Release managers", "Engineering leads", "Customer success owners"],
      successMetrics: [
        "100% of releases have linked validation evidence",
        "Release confirmation has a named owner",
        "Audit review turnaround drops below one business day",
      ],
    },
  },
];

export function listWorkspaceBriefTemplates(): WorkspaceBriefTemplate[] {
  return WORKSPACE_BRIEF_TEMPLATES.map((template) => ({
    ...template,
    brief: { ...template.brief },
  }));
}

export function getWorkflowOverview(context: WorkflowContext) {
  return {
    brief: readWorkspaceBrief(context),
    requirements: listRequirements(context),
    planItems: listPlanItems(context),
    blockersAndQuestions: listBlockersAndQuestions(context),
    validationEvidence: listValidationEvidence(context),
    releaseConfirmation: readReleaseConfirmation(context),
  };
}

export async function getWorkflowOverviewAsync(context: WorkflowContext) {
  return {
    brief: await readWorkspaceBriefAsync(context),
    requirements: await listRequirementsAsync(context),
    planItems: await listPlanItemsAsync(context),
    blockersAndQuestions: await listBlockersAndQuestionsAsync(context),
    validationEvidence: await listValidationEvidenceAsync(context),
    releaseConfirmation: await readReleaseConfirmationAsync(context),
  };
}

export function readWorkspaceBrief(context: WorkflowContext): WorkspaceBriefRecord {
  ensureWorkspaceExists(context.workspace.id);
  return copyRecord(findWorkspaceBriefIndexed(context.workspace.id) ?? defaultWorkspaceBrief(context));
}

export async function readWorkspaceBriefAsync(context: WorkflowContext): Promise<WorkspaceBriefRecord> {
  const data = await loadStoreAsync();
  ensureWorkspace(data, context.workspace.id);
  return copyRecord(findWorkspaceBrief(data, context.workspace.id) ?? defaultWorkspaceBrief(context));
}

export function updateWorkspaceBrief(
  context: WorkflowContext,
  input: UpdateWorkspaceBriefInput,
): WorkspaceBriefRecord {
  return saveWorkspaceBriefInternal(context, input, { source: "manual" });
}

export async function updateWorkspaceBriefAsync(
  context: WorkflowContext,
  input: UpdateWorkspaceBriefInput,
): Promise<WorkspaceBriefRecord> {
  return saveWorkspaceBriefInternalAsync(context, input, { source: "manual" });
}

export function applyWorkspaceBriefTemplate(
  context: WorkflowContext,
  input: { templateId?: string },
): WorkspaceBriefRecord {
  const templateId = input.templateId?.trim();
  if (!templateId) throw httpError(400, "template id is required");
  const template = WORKSPACE_BRIEF_TEMPLATES.find((entry) => entry.id === templateId);
  if (!template) throw httpError(404, "brief template not found");
  return saveWorkspaceBriefInternal(context, template.brief, {
    source: "template",
    sourceLabel: template.name,
  });
}

export async function applyWorkspaceBriefTemplateAsync(
  context: WorkflowContext,
  input: { templateId?: string },
): Promise<WorkspaceBriefRecord> {
  const templateId = input.templateId?.trim();
  if (!templateId) throw httpError(400, "template id is required");
  const template = WORKSPACE_BRIEF_TEMPLATES.find((entry) => entry.id === templateId);
  if (!template) throw httpError(404, "brief template not found");
  return saveWorkspaceBriefInternalAsync(context, template.brief, {
    source: "template",
    sourceLabel: template.name,
  });
}

export function listWorkspaceBriefHistory(context: WorkflowContext): WorkspaceBriefVersionRecord[] {
  ensureWorkspaceExists(context.workspace.id);
  return listWorkspaceBriefVersionsIndexed(context.workspace.id).map(copyRecord);
}

export async function listWorkspaceBriefHistoryAsync(context: WorkflowContext): Promise<WorkspaceBriefVersionRecord[]> {
  const data = await loadStoreAsync();
  ensureWorkspace(data, context.workspace.id);
  return listWorkspaceBriefVersions(data, context.workspace.id).map(copyRecord);
}

export function restoreWorkspaceBriefVersion(
  context: WorkflowContext,
  input: { versionId?: string },
): WorkspaceBriefRecord {
  const versionId = input.versionId?.trim();
  if (!versionId) throw httpError(400, "brief version id is required");
  ensureWorkspaceExists(context.workspace.id);
  const version = findWorkspaceBriefVersionIndexed(context.workspace.id, versionId);
  if (!version) throw httpError(404, "brief version not found");
  return saveWorkspaceBriefInternal(
    context,
    {
      summary: version.summary,
      goals: version.goals,
      audience: version.audience,
      constraints: version.constraints,
      problemStatement: version.problemStatement,
      targetCustomers: version.targetCustomers,
      desiredOutcome: version.desiredOutcome,
      successMetrics: version.successMetrics,
    },
    { source: "restore", sourceLabel: `Restored v${version.versionNumber}` },
  );
}

export async function restoreWorkspaceBriefVersionAsync(
  context: WorkflowContext,
  input: { versionId?: string },
): Promise<WorkspaceBriefRecord> {
  const versionId = input.versionId?.trim();
  if (!versionId) throw httpError(400, "brief version id is required");
  const data = await loadStoreAsync();
  ensureWorkspace(data, context.workspace.id);
  const version = data.workspaceBriefVersions.find((entry) =>
    entry.workspaceId === context.workspace.id && entry.id === versionId
  );
  if (!version) throw httpError(404, "brief version not found");
  return saveWorkspaceBriefInternalAsync(
    context,
    {
      summary: version.summary,
      goals: version.goals,
      audience: version.audience,
      constraints: version.constraints,
      problemStatement: version.problemStatement,
      targetCustomers: version.targetCustomers,
      desiredOutcome: version.desiredOutcome,
      successMetrics: version.successMetrics,
    },
    { source: "restore", sourceLabel: `Restored v${version.versionNumber}` },
  );
}

function saveWorkspaceBriefInternal(
  context: WorkflowContext,
  input: UpdateWorkspaceBriefInput,
  options: { source: WorkspaceBriefVersionRecord["source"]; sourceLabel?: string },
): WorkspaceBriefRecord {
  const timestamp = now();
  const summary = requireText(input.summary, "brief summary", 2);
  const problemStatement = (input.problemStatement ?? "").trim();
  const desiredOutcome = (input.desiredOutcome ?? "").trim();
  const targetCustomers = normalizeTextList(input.targetCustomers ?? []);
  const successMetrics = normalizeTextList(input.successMetrics ?? []);
  const goals = normalizeTextList(input.goals ?? input.successMetrics ?? []);
  const audience = (input.audience ?? targetCustomers.join(", ")).trim();
  const constraints = (input.constraints ?? problemStatement).trim();

  return mutateStore((data) => {
    const workspace = ensureWorkspace(data, context.workspace.id);
    const previousBrief = findWorkspaceBrief(data, workspace.id);
    const scopeChanged = previousBrief
      ? briefScopeChanged(previousBrief, { summary, goals, audience, constraints, problemStatement, targetCustomers, desiredOutcome, successMetrics })
      : false;
    const brief = upsertWorkspaceBrief(
      data,
      {
        workspaceId: workspace.id,
        summary,
        goals,
        audience,
        constraints,
        problemStatement,
        targetCustomers,
        desiredOutcome,
        successMetrics,
        updatedByUserId: context.user.id,
      },
      timestamp,
    );

    const version = appendWorkspaceBriefVersion(
      data,
      {
        workspaceId: workspace.id,
        summary,
        goals,
        audience,
        constraints,
        problemStatement,
        targetCustomers,
        desiredOutcome,
        successMetrics,
        source: options.source,
        sourceLabel: options.sourceLabel,
        createdByUserId: context.user.id,
        createdByDisplayName: context.user.displayName,
      },
      timestamp,
    );

    workspace.automationGoal = summary;
    workspace.updatedAt = timestamp;
    const facts = ensureActivationFacts(data, workspace.id, timestamp);
    facts.briefCapturedAt = timestamp;
    markOnboardingStep(data, workspace.id, "create_workspace_profile", timestamp);
    if (scopeChanged) {
      const signal = upsertActivationSignal(data, {
        workspaceId: workspace.id,
        kind: "scope_change",
        source: "workflow",
        origin: "user_entered",
        sourceId: version.id,
        stableKey: activationSignalStableKey(workspace.id, "scope_change", "workflow", version.id),
        data: {
          source: options.source,
          sourceLabel: options.sourceLabel,
          versionNumber: version.versionNumber,
        },
      }, timestamp);
      pushActivity(data, workspace.id, "workflow.scope_changed", actorFor(context), {
        title: "Workflow scope changed",
        activationSignalKind: "scope_change",
        activationSignalId: signal.id,
        sourceId: version.id,
        versionNumber: version.versionNumber,
        origin: "user_entered",
        observedBy: "workflow_service",
      }, timestamp, activationActivityId(workspace.id, "workflow.scope_changed", signal.id));
    }
    pushActivity(data, workspace.id, "workflow.brief_updated", actorFor(context), {
      title: "Workspace brief updated",
      goalCount: goals.length,
      targetCustomerCount: targetCustomers.length,
      successMetricCount: successMetrics.length,
      source: options.source,
      sourceLabel: options.sourceLabel,
    }, timestamp);
    return copyRecord(brief);
  });
}

function saveWorkspaceBriefInternalAsync(
  context: WorkflowContext,
  input: UpdateWorkspaceBriefInput,
  options: { source: WorkspaceBriefVersionRecord["source"]; sourceLabel?: string },
): Promise<WorkspaceBriefRecord> {
  const timestamp = now();
  const summary = requireText(input.summary, "brief summary", 2);
  const problemStatement = (input.problemStatement ?? "").trim();
  const desiredOutcome = (input.desiredOutcome ?? "").trim();
  const targetCustomers = normalizeTextList(input.targetCustomers ?? []);
  const successMetrics = normalizeTextList(input.successMetrics ?? []);
  const goals = normalizeTextList(input.goals ?? input.successMetrics ?? []);
  const audience = (input.audience ?? targetCustomers.join(", ")).trim();
  const constraints = (input.constraints ?? problemStatement).trim();

  return mutateStoreAsync((data) => {
    const workspace = ensureWorkspace(data, context.workspace.id);
    const previousBrief = findWorkspaceBrief(data, workspace.id);
    const scopeChanged = previousBrief
      ? briefScopeChanged(previousBrief, { summary, goals, audience, constraints, problemStatement, targetCustomers, desiredOutcome, successMetrics })
      : false;
    const brief = upsertWorkspaceBrief(
      data,
      {
        workspaceId: workspace.id,
        summary,
        goals,
        audience,
        constraints,
        problemStatement,
        targetCustomers,
        desiredOutcome,
        successMetrics,
        updatedByUserId: context.user.id,
      },
      timestamp,
    );

    const version = appendWorkspaceBriefVersion(
      data,
      {
        workspaceId: workspace.id,
        summary,
        goals,
        audience,
        constraints,
        problemStatement,
        targetCustomers,
        desiredOutcome,
        successMetrics,
        source: options.source,
        sourceLabel: options.sourceLabel,
        createdByUserId: context.user.id,
        createdByDisplayName: context.user.displayName,
      },
      timestamp,
    );

    workspace.automationGoal = summary;
    workspace.updatedAt = timestamp;
    const facts = ensureActivationFacts(data, workspace.id, timestamp);
    facts.briefCapturedAt = timestamp;
    markOnboardingStep(data, workspace.id, "create_workspace_profile", timestamp);
    if (scopeChanged) {
      const signal = upsertActivationSignal(data, {
        workspaceId: workspace.id,
        kind: "scope_change",
        source: "workflow",
        origin: "user_entered",
        sourceId: version.id,
        stableKey: activationSignalStableKey(workspace.id, "scope_change", "workflow", version.id),
        data: {
          source: options.source,
          sourceLabel: options.sourceLabel,
          versionNumber: version.versionNumber,
        },
      }, timestamp);
      pushActivity(data, workspace.id, "workflow.scope_changed", actorFor(context), {
        title: "Workflow scope changed",
        activationSignalKind: "scope_change",
        activationSignalId: signal.id,
        sourceId: version.id,
        versionNumber: version.versionNumber,
        origin: "user_entered",
        observedBy: "workflow_service",
      }, timestamp, activationActivityId(workspace.id, "workflow.scope_changed", signal.id));
    }
    pushActivity(data, workspace.id, "workflow.brief_updated", actorFor(context), {
      title: "Workspace brief updated",
      goalCount: goals.length,
      targetCustomerCount: targetCustomers.length,
      successMetricCount: successMetrics.length,
      source: options.source,
      sourceLabel: options.sourceLabel,
    }, timestamp);
    return copyRecord(brief);
  });
}

export function listRequirements(context: WorkflowContext): RequirementRecord[] {
  ensureWorkspaceExists(context.workspace.id);
  return listRequirementsForWorkspaceIndexed(context.workspace.id).map(copyRecord);
}

export async function listRequirementsAsync(context: WorkflowContext): Promise<RequirementRecord[]> {
  const data = await loadStoreAsync();
  ensureWorkspace(data, context.workspace.id);
  return data.requirements
    .filter((entry) => entry.workspaceId === context.workspace.id)
    .map(copyRecord);
}

export function replaceRequirements(
  context: WorkflowContext,
  input: WorkflowRequirementInput[] | { requirements?: WorkflowRequirementInput[] },
): RequirementRecord[] {
  const timestamp = now();
  const entries = Array.isArray(input) ? input : input.requirements ?? [];
  const requirements = entries.map((entry) => normalizeRequirement(context, entry, timestamp));

  return mutateStore((data) => {
    ensureWorkspace(data, context.workspace.id);
    data.requirements = data.requirements.filter((entry) => entry.workspaceId !== context.workspace.id);
    data.requirements.push(...requirements);

    const facts = ensureActivationFacts(data, context.workspace.id, timestamp);
    if (requirements.length > 0) facts.requirementsDefinedAt = timestamp;
    else delete facts.requirementsDefinedAt;
    markOnboardingStep(data, context.workspace.id, "define_requirements", timestamp, requirements.length > 0);
    pushActivity(data, context.workspace.id, "workflow.requirements_updated", actorFor(context), {
      title: "Requirements updated",
      requirementCount: requirements.length,
    }, timestamp);
    return requirements.map(copyRecord);
  });
}

export async function replaceRequirementsAsync(
  context: WorkflowContext,
  input: WorkflowRequirementInput[] | { requirements?: WorkflowRequirementInput[] },
): Promise<RequirementRecord[]> {
  const timestamp = now();
  const entries = Array.isArray(input) ? input : input.requirements ?? [];
  const requirements = entries.map((entry) => normalizeRequirement(context, entry, timestamp));

  return mutateStoreAsync((data) => {
    ensureWorkspace(data, context.workspace.id);
    data.requirements = data.requirements.filter((entry) => entry.workspaceId !== context.workspace.id);
    data.requirements.push(...requirements);

    const facts = ensureActivationFacts(data, context.workspace.id, timestamp);
    if (requirements.length > 0) facts.requirementsDefinedAt = timestamp;
    else delete facts.requirementsDefinedAt;
    markOnboardingStep(data, context.workspace.id, "define_requirements", timestamp, requirements.length > 0);
    pushActivity(data, context.workspace.id, "workflow.requirements_updated", actorFor(context), {
      title: "Requirements updated",
      requirementCount: requirements.length,
    }, timestamp);
    return requirements.map(copyRecord);
  });
}

export function listPlanItems(context: WorkflowContext): ImplementationPlanItemRecord[] {
  ensureWorkspaceExists(context.workspace.id);
  return listImplementationPlanItemsForWorkspaceIndexed(context.workspace.id).map(copyRecord);
}

export async function listPlanItemsAsync(context: WorkflowContext): Promise<ImplementationPlanItemRecord[]> {
  const data = await loadStoreAsync();
  ensureWorkspace(data, context.workspace.id);
  return data.implementationPlanItems
    .filter((entry) => entry.workspaceId === context.workspace.id)
    .sort((left, right) => left.order - right.order)
    .map(copyRecord);
}

export function replacePlanItems(
  context: WorkflowContext,
  input: WorkflowPlanItemInput[] | { planItems?: WorkflowPlanItemInput[] },
): ImplementationPlanItemRecord[] {
  const timestamp = now();
  const entries = Array.isArray(input) ? input : input.planItems ?? [];
  const planItems = entries.map((entry, index) => normalizePlanItem(context.workspace.id, entry, index, timestamp));

  return mutateStore((data) => {
    ensureWorkspace(data, context.workspace.id);
    data.implementationPlanItems = data.implementationPlanItems.filter((entry) => entry.workspaceId !== context.workspace.id);
    data.implementationPlanItems.push(...planItems);

    const facts = ensureActivationFacts(data, context.workspace.id, timestamp);
    if (planItems.length > 0) facts.planDefinedAt = timestamp;
    else delete facts.planDefinedAt;
    if (planItems.some((entry) => entry.status === "in_progress" || entry.status === "blocked" || entry.status === "done")) {
      facts.implementationStartedAt = timestamp;
      facts.startedAt = facts.startedAt ?? timestamp;
    }
    if (planItems.length > 0 && planItems.every((entry) => entry.status === "done")) {
      facts.completedAt = timestamp;
    }
    markOnboardingStep(data, context.workspace.id, "define_plan", timestamp, planItems.length > 0);
    markOnboardingStep(
      data,
      context.workspace.id,
      "start_implementation",
      timestamp,
      planItems.some((entry) => entry.status === "in_progress" || entry.status === "blocked" || entry.status === "done"),
    );
    pushActivity(data, context.workspace.id, "workflow.plan_updated", actorFor(context), {
      title: "Plan items updated",
      planItemCount: planItems.length,
      completedCount: planItems.filter((entry) => entry.status === "done").length,
    }, timestamp);
    return planItems.map(copyRecord);
  });
}

export async function replacePlanItemsAsync(
  context: WorkflowContext,
  input: WorkflowPlanItemInput[] | { planItems?: WorkflowPlanItemInput[] },
): Promise<ImplementationPlanItemRecord[]> {
  const timestamp = now();
  const entries = Array.isArray(input) ? input : input.planItems ?? [];
  const planItems = entries.map((entry, index) => normalizePlanItem(context.workspace.id, entry, index, timestamp));

  return mutateStoreAsync((data) => {
    ensureWorkspace(data, context.workspace.id);
    data.implementationPlanItems = data.implementationPlanItems.filter((entry) => entry.workspaceId !== context.workspace.id);
    data.implementationPlanItems.push(...planItems);

    const facts = ensureActivationFacts(data, context.workspace.id, timestamp);
    if (planItems.length > 0) facts.planDefinedAt = timestamp;
    else delete facts.planDefinedAt;
    if (planItems.some((entry) => entry.status === "in_progress" || entry.status === "blocked" || entry.status === "done")) {
      facts.implementationStartedAt = timestamp;
      facts.startedAt = facts.startedAt ?? timestamp;
    }
    if (planItems.length > 0 && planItems.every((entry) => entry.status === "done")) {
      facts.completedAt = timestamp;
    }
    markOnboardingStep(data, context.workspace.id, "define_plan", timestamp, planItems.length > 0);
    markOnboardingStep(
      data,
      context.workspace.id,
      "start_implementation",
      timestamp,
      planItems.some((entry) => entry.status === "in_progress" || entry.status === "blocked" || entry.status === "done"),
    );
    pushActivity(data, context.workspace.id, "workflow.plan_updated", actorFor(context), {
      title: "Plan items updated",
      planItemCount: planItems.length,
      completedCount: planItems.filter((entry) => entry.status === "done").length,
    }, timestamp);
    return planItems.map(copyRecord);
  });
}

export function createWorkflowPlanItem(context: WorkflowContext, input: WorkflowPlanItemInput): ImplementationPlanItemRecord {
  const current = listPlanItems(context).map(planItemToInput);
  const saved = replacePlanItems(context, [...current, input]);
  return saved[saved.length - 1];
}

export async function createWorkflowPlanItemAsync(
  context: WorkflowContext,
  input: WorkflowPlanItemInput,
): Promise<ImplementationPlanItemRecord> {
  const current = (await listPlanItemsAsync(context)).map(planItemToInput);
  const saved = await replacePlanItemsAsync(context, [...current, input]);
  return saved[saved.length - 1];
}

export function updateWorkflowPlanItem(
  context: WorkflowContext,
  input: WorkflowPlanItemInput & { itemId?: string },
): ImplementationPlanItemRecord {
  const itemId = input.itemId ?? input.id;
  if (!itemId) throw httpError(400, "plan item id is required");
  const current = listPlanItems(context);
  const existing = current.find((entry) => entry.id === itemId);
  if (!existing) throw httpError(404, "plan item not found");
  const saved = replacePlanItems(
    context,
    current.map((entry) => entry.id === itemId ? { ...planItemToInput(entry), ...input, id: itemId } : planItemToInput(entry)),
  );
  return saved.find((entry) => entry.id === itemId) ?? saved[0];
}

export async function updateWorkflowPlanItemAsync(
  context: WorkflowContext,
  input: WorkflowPlanItemInput & { itemId?: string },
): Promise<ImplementationPlanItemRecord> {
  const itemId = input.itemId ?? input.id;
  if (!itemId) throw httpError(400, "plan item id is required");
  const current = await listPlanItemsAsync(context);
  const existing = current.find((entry) => entry.id === itemId);
  if (!existing) throw httpError(404, "plan item not found");
  const saved = await replacePlanItemsAsync(
    context,
    current.map((entry) => entry.id === itemId ? { ...planItemToInput(entry), ...input, id: itemId } : planItemToInput(entry)),
  );
  return saved.find((entry) => entry.id === itemId) ?? saved[0];
}

export function listBlockersAndQuestions(context: WorkflowContext) {
  ensureWorkspaceExists(context.workspace.id);
  return {
    blockers: listWorkflowConcernsForWorkspaceIndexed(context.workspace.id, "blocker").map(copyRecord),
    questions: listWorkflowConcernsForWorkspaceIndexed(context.workspace.id, "open_question").map(copyRecord),
  };
}

export async function listBlockersAndQuestionsAsync(context: WorkflowContext) {
  const data = await loadStoreAsync();
  ensureWorkspace(data, context.workspace.id);
  return {
    blockers: data.workflowConcerns
      .filter((entry) => entry.workspaceId === context.workspace.id && entry.kind === "blocker")
      .map(copyRecord),
    questions: data.workflowConcerns
      .filter((entry) => entry.workspaceId === context.workspace.id && entry.kind === "open_question")
      .map(copyRecord),
  };
}

export function listWorkflowBlockers(context: WorkflowContext) {
  return listBlockersAndQuestions(context).blockers.map(toBlockerDto);
}

export async function listWorkflowBlockersAsync(context: WorkflowContext) {
  return (await listBlockersAndQuestionsAsync(context)).blockers.map(toBlockerDto);
}

export function createWorkflowBlocker(context: WorkflowContext, input: WorkflowConcernInput) {
  const current = listBlockersAndQuestions(context);
  const saved = replaceBlockersAndQuestions(context, {
    blockers: [...current.blockers.map(concernToInput), input],
    questions: current.questions.map(concernToInput),
  });
  return toBlockerDto(saved.blockers[saved.blockers.length - 1]);
}

export async function createWorkflowBlockerAsync(context: WorkflowContext, input: WorkflowConcernInput) {
  const current = await listBlockersAndQuestionsAsync(context);
  const saved = await replaceBlockersAndQuestionsAsync(context, {
    blockers: [...current.blockers.map(concernToInput), input],
    questions: current.questions.map(concernToInput),
  });
  return toBlockerDto(saved.blockers[saved.blockers.length - 1]);
}

export function updateWorkflowBlocker(context: WorkflowContext, input: WorkflowConcernInput & { blockerId?: string }) {
  const blockerId = input.blockerId ?? input.id;
  if (!blockerId) throw httpError(400, "blocker id is required");
  const current = listBlockersAndQuestions(context);
  const existing = current.blockers.find((entry) => entry.id === blockerId);
  if (!existing) throw httpError(404, "blocker not found");
  const saved = replaceBlockersAndQuestions(context, {
    blockers: current.blockers.map((entry) => entry.id === blockerId ? { ...concernToInput(entry), ...input, id: blockerId } : concernToInput(entry)),
    questions: current.questions.map(concernToInput),
  });
  return toBlockerDto(saved.blockers.find((entry) => entry.id === blockerId) ?? saved.blockers[0]);
}

export async function updateWorkflowBlockerAsync(context: WorkflowContext, input: WorkflowConcernInput & { blockerId?: string }) {
  const blockerId = input.blockerId ?? input.id;
  if (!blockerId) throw httpError(400, "blocker id is required");
  const current = await listBlockersAndQuestionsAsync(context);
  const existing = current.blockers.find((entry) => entry.id === blockerId);
  if (!existing) throw httpError(404, "blocker not found");
  const saved = await replaceBlockersAndQuestionsAsync(context, {
    blockers: current.blockers.map((entry) => entry.id === blockerId ? { ...concernToInput(entry), ...input, id: blockerId } : concernToInput(entry)),
    questions: current.questions.map(concernToInput),
  });
  return toBlockerDto(saved.blockers.find((entry) => entry.id === blockerId) ?? saved.blockers[0]);
}

export function listWorkflowQuestions(context: WorkflowContext) {
  return listBlockersAndQuestions(context).questions.map(toQuestionDto);
}

export async function listWorkflowQuestionsAsync(context: WorkflowContext) {
  return (await listBlockersAndQuestionsAsync(context)).questions.map(toQuestionDto);
}

export function createWorkflowQuestion(context: WorkflowContext, input: WorkflowConcernInput) {
  const current = listBlockersAndQuestions(context);
  const saved = replaceBlockersAndQuestions(context, {
    blockers: current.blockers.map(concernToInput),
    questions: [...current.questions.map(concernToInput), input],
  });
  return toQuestionDto(saved.questions[saved.questions.length - 1]);
}

export async function createWorkflowQuestionAsync(context: WorkflowContext, input: WorkflowConcernInput) {
  const current = await listBlockersAndQuestionsAsync(context);
  const saved = await replaceBlockersAndQuestionsAsync(context, {
    blockers: current.blockers.map(concernToInput),
    questions: [...current.questions.map(concernToInput), input],
  });
  return toQuestionDto(saved.questions[saved.questions.length - 1]);
}

export function updateWorkflowQuestion(context: WorkflowContext, input: WorkflowConcernInput & { questionId?: string }) {
  const questionId = input.questionId ?? input.id;
  if (!questionId) throw httpError(400, "question id is required");
  const current = listBlockersAndQuestions(context);
  const existing = current.questions.find((entry) => entry.id === questionId);
  if (!existing) throw httpError(404, "question not found");
  const saved = replaceBlockersAndQuestions(context, {
    blockers: current.blockers.map(concernToInput),
    questions: current.questions.map((entry) => entry.id === questionId ? { ...concernToInput(entry), ...input, id: questionId } : concernToInput(entry)),
  });
  return toQuestionDto(saved.questions.find((entry) => entry.id === questionId) ?? saved.questions[0]);
}

export async function updateWorkflowQuestionAsync(context: WorkflowContext, input: WorkflowConcernInput & { questionId?: string }) {
  const questionId = input.questionId ?? input.id;
  if (!questionId) throw httpError(400, "question id is required");
  const current = await listBlockersAndQuestionsAsync(context);
  const existing = current.questions.find((entry) => entry.id === questionId);
  if (!existing) throw httpError(404, "question not found");
  const saved = await replaceBlockersAndQuestionsAsync(context, {
    blockers: current.blockers.map(concernToInput),
    questions: current.questions.map((entry) => entry.id === questionId ? { ...concernToInput(entry), ...input, id: questionId } : concernToInput(entry)),
  });
  return toQuestionDto(saved.questions.find((entry) => entry.id === questionId) ?? saved.questions[0]);
}

export function replaceBlockersAndQuestions(
  context: WorkflowContext,
  input: { blockers?: WorkflowConcernInput[]; questions?: WorkflowConcernInput[] },
) {
  const timestamp = now();
  const blockers = (input.blockers ?? []).map((entry) => normalizeConcern(context.workspace.id, "blocker", entry, timestamp));
  const questions = (input.questions ?? []).map((entry) => normalizeConcern(context.workspace.id, "open_question", entry, timestamp));

  return mutateStore((data) => {
    ensureWorkspace(data, context.workspace.id);
    data.workflowConcerns = data.workflowConcerns.filter((entry) => entry.workspaceId !== context.workspace.id);
    data.workflowConcerns.push(...blockers, ...questions);

    const facts = ensureActivationFacts(data, context.workspace.id, timestamp);
    const openBlockers = blockers.filter((entry) => entry.status === "open");
    facts.blockerCount = openBlockers.length;
    facts.dependencyBlockerCount = openBlockers.filter((entry) => Boolean(entry.relatedPlanItemId || entry.relatedRequirementId)).length;
    facts.criticalIssueCount = openBlockers.filter((entry) => entry.severity === "critical").length;
    facts.openQuestionCount = questions.filter((entry) => entry.status === "open").length;
    pushActivity(data, context.workspace.id, "workflow.blockers_questions_updated", actorFor(context), {
      title: "Blockers and questions updated",
      blockerCount: facts.blockerCount,
      openQuestionCount: facts.openQuestionCount,
    }, timestamp);
    return {
      blockers: blockers.map(copyRecord),
      questions: questions.map(copyRecord),
    };
  });
}

export async function replaceBlockersAndQuestionsAsync(
  context: WorkflowContext,
  input: { blockers?: WorkflowConcernInput[]; questions?: WorkflowConcernInput[] },
) {
  const timestamp = now();
  const blockers = (input.blockers ?? []).map((entry) => normalizeConcern(context.workspace.id, "blocker", entry, timestamp));
  const questions = (input.questions ?? []).map((entry) => normalizeConcern(context.workspace.id, "open_question", entry, timestamp));

  return mutateStoreAsync((data) => {
    ensureWorkspace(data, context.workspace.id);
    data.workflowConcerns = data.workflowConcerns.filter((entry) => entry.workspaceId !== context.workspace.id);
    data.workflowConcerns.push(...blockers, ...questions);

    const facts = ensureActivationFacts(data, context.workspace.id, timestamp);
    const openBlockers = blockers.filter((entry) => entry.status === "open");
    facts.blockerCount = openBlockers.length;
    facts.dependencyBlockerCount = openBlockers.filter((entry) => Boolean(entry.relatedPlanItemId || entry.relatedRequirementId)).length;
    facts.criticalIssueCount = openBlockers.filter((entry) => entry.severity === "critical").length;
    facts.openQuestionCount = questions.filter((entry) => entry.status === "open").length;
    pushActivity(data, context.workspace.id, "workflow.blockers_questions_updated", actorFor(context), {
      title: "Blockers and questions updated",
      blockerCount: facts.blockerCount,
      openQuestionCount: facts.openQuestionCount,
    }, timestamp);
    return {
      blockers: blockers.map(copyRecord),
      questions: questions.map(copyRecord),
    };
  });
}

export function listValidationEvidence(context: WorkflowContext): ValidationEvidenceRecord[] {
  ensureWorkspaceExists(context.workspace.id);
  return listValidationEvidenceForWorkspaceIndexed(context.workspace.id).map(copyRecord);
}

export async function listValidationEvidenceAsync(context: WorkflowContext): Promise<ValidationEvidenceRecord[]> {
  const data = await loadStoreAsync();
  ensureWorkspace(data, context.workspace.id);
  return data.validationEvidence
    .filter((entry) => entry.workspaceId === context.workspace.id)
    .map(copyRecord);
}

export function replaceValidationEvidence(
  context: WorkflowContext,
  input: WorkflowValidationEvidenceInput[] | { validationEvidence?: WorkflowValidationEvidenceInput[] },
): ValidationEvidenceRecord[] {
  const timestamp = now();
  const entries = Array.isArray(input) ? input : input.validationEvidence ?? [];
  const evidence = entries.map((entry) => normalizeValidationEvidence(context, entry, timestamp));

  return mutateStore((data) => {
    ensureWorkspace(data, context.workspace.id);
    data.validationEvidence = data.validationEvidence.filter((entry) => entry.workspaceId !== context.workspace.id);
    data.validationEvidence.push(...evidence);

    const facts = ensureActivationFacts(data, context.workspace.id, timestamp);
    const passedCount = evidence.filter((entry) => entry.status === "passed").length;
    const failedCount = evidence.filter((entry) => entry.status === "failed").length;
    facts.failedValidationCount = failedCount;
    if (passedCount > 0) facts.testsPassedAt = timestamp;
    if (passedCount > 0 && failedCount === 0) {
      facts.validationPassedAt = timestamp;
      facts.completedAt = facts.completedAt ?? timestamp;
    } else {
      delete facts.validationPassedAt;
    }
    markOnboardingStep(data, context.workspace.id, "validate", timestamp, passedCount > 0 && failedCount === 0);
    pushActivity(data, context.workspace.id, "workflow.validation_evidence_updated", actorFor(context), {
      title: "Validation evidence updated",
      evidenceCount: evidence.length,
      passedCount,
      failedCount,
    }, timestamp);
    return evidence.map(copyRecord);
  });
}

export async function replaceValidationEvidenceAsync(
  context: WorkflowContext,
  input: WorkflowValidationEvidenceInput[] | { validationEvidence?: WorkflowValidationEvidenceInput[] },
): Promise<ValidationEvidenceRecord[]> {
  const timestamp = now();
  const entries = Array.isArray(input) ? input : input.validationEvidence ?? [];
  const evidence = entries.map((entry) => normalizeValidationEvidence(context, entry, timestamp));

  return mutateStoreAsync((data) => {
    ensureWorkspace(data, context.workspace.id);
    data.validationEvidence = data.validationEvidence.filter((entry) => entry.workspaceId !== context.workspace.id);
    data.validationEvidence.push(...evidence);

    const facts = ensureActivationFacts(data, context.workspace.id, timestamp);
    const passedCount = evidence.filter((entry) => entry.status === "passed").length;
    const failedCount = evidence.filter((entry) => entry.status === "failed").length;
    facts.failedValidationCount = failedCount;
    if (passedCount > 0) facts.testsPassedAt = timestamp;
    if (passedCount > 0 && failedCount === 0) {
      facts.validationPassedAt = timestamp;
      facts.completedAt = facts.completedAt ?? timestamp;
    } else {
      delete facts.validationPassedAt;
    }
    markOnboardingStep(data, context.workspace.id, "validate", timestamp, passedCount > 0 && failedCount === 0);
    pushActivity(data, context.workspace.id, "workflow.validation_evidence_updated", actorFor(context), {
      title: "Validation evidence updated",
      evidenceCount: evidence.length,
      passedCount,
      failedCount,
    }, timestamp);
    return evidence.map(copyRecord);
  });
}

export const listWorkflowValidationEvidence = listValidationEvidence;
export const listWorkflowValidationEvidenceAsync = listValidationEvidenceAsync;

export function createWorkflowValidationEvidence(
  context: WorkflowContext,
  input: WorkflowValidationEvidenceInput,
): ValidationEvidenceRecord {
  const current = listValidationEvidence(context).map(validationEvidenceToInput);
  const saved = replaceValidationEvidence(context, [...current, input]);
  return saved[saved.length - 1];
}

export async function createWorkflowValidationEvidenceAsync(
  context: WorkflowContext,
  input: WorkflowValidationEvidenceInput,
): Promise<ValidationEvidenceRecord> {
  const current = (await listValidationEvidenceAsync(context)).map(validationEvidenceToInput);
  const saved = await replaceValidationEvidenceAsync(context, [...current, input]);
  return saved[saved.length - 1];
}

export function updateWorkflowValidationEvidence(
  context: WorkflowContext,
  input: WorkflowValidationEvidenceInput & { evidenceId?: string },
): ValidationEvidenceRecord {
  const evidenceId = input.evidenceId ?? input.id;
  if (!evidenceId) throw httpError(400, "validation evidence id is required");
  const current = listValidationEvidence(context);
  const existing = current.find((entry) => entry.id === evidenceId);
  if (!existing) throw httpError(404, "validation evidence not found");
  const saved = replaceValidationEvidence(
    context,
    current.map((entry) => entry.id === evidenceId ? { ...validationEvidenceToInput(entry), ...input, id: evidenceId } : validationEvidenceToInput(entry)),
  );
  return saved.find((entry) => entry.id === evidenceId) ?? saved[0];
}

export async function updateWorkflowValidationEvidenceAsync(
  context: WorkflowContext,
  input: WorkflowValidationEvidenceInput & { evidenceId?: string },
): Promise<ValidationEvidenceRecord> {
  const evidenceId = input.evidenceId ?? input.id;
  if (!evidenceId) throw httpError(400, "validation evidence id is required");
  const current = await listValidationEvidenceAsync(context);
  const existing = current.find((entry) => entry.id === evidenceId);
  if (!existing) throw httpError(404, "validation evidence not found");
  const saved = await replaceValidationEvidenceAsync(
    context,
    current.map((entry) => entry.id === evidenceId ? { ...validationEvidenceToInput(entry), ...input, id: evidenceId } : validationEvidenceToInput(entry)),
  );
  return saved.find((entry) => entry.id === evidenceId) ?? saved[0];
}

export function readReleaseConfirmation(context: WorkflowContext): ReleaseConfirmationRecord | null {
  ensureWorkspaceExists(context.workspace.id);
  const confirmations = listReleaseConfirmationsForWorkspaceIndexed(context.workspace.id);
  const latest = confirmations.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  return latest ? copyRecord(latest) : null;
}

export async function readReleaseConfirmationAsync(context: WorkflowContext): Promise<ReleaseConfirmationRecord | null> {
  const data = await loadStoreAsync();
  ensureWorkspace(data, context.workspace.id);
  const confirmations = listReleaseConfirmationsForWorkspace(data, context.workspace.id);
  const latest = confirmations.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  return latest ? copyRecord(latest) : null;
}

export const getWorkflowReleaseConfirmation = readReleaseConfirmation;
export const confirmWorkflowRelease = updateReleaseConfirmation;
export const getWorkflowReleaseConfirmationAsync = readReleaseConfirmationAsync;
export const confirmWorkflowReleaseAsync = updateReleaseConfirmationAsync;

export function updateReleaseConfirmation(
  context: WorkflowContext,
  input: UpdateReleaseConfirmationInput,
): ReleaseConfirmationRecord {
  const timestamp = now();
  const releaseNotes = (input.summary ?? "").trim();
  if (input.confirmed && releaseNotes.length < 2) throw httpError(400, "release summary must be at least 2 characters");

  return mutateStore((data) => {
    ensureWorkspace(data, context.workspace.id);
    const existing = listReleaseConfirmationsForWorkspace(data, context.workspace.id)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    const confirmation = upsertReleaseConfirmation(
      data,
      {
        id: existing?.id,
        workspaceId: context.workspace.id,
        versionLabel: (input.versionLabel ?? existing?.versionLabel ?? "release").trim() || "release",
        confirmed: input.confirmed,
        summary: releaseNotes,
        confirmedBy: input.confirmed ? context.user.displayName : "",
        status: input.confirmed ? "confirmed" : "pending",
        confirmedByUserId: input.confirmed ? context.user.id : undefined,
        confirmedAt: input.confirmed ? timestamp : undefined,
        releaseNotes,
        validationEvidenceIds: input.validationEvidenceIds ?? existing?.validationEvidenceIds ?? [],
      },
      timestamp,
    );

    const facts = ensureActivationFacts(data, context.workspace.id, timestamp);
    if (confirmation.status === "confirmed") {
      facts.releaseConfirmedAt = timestamp;
      facts.releasedAt = timestamp;
      markOnboardingStep(data, context.workspace.id, "confirm_release", timestamp);
    } else {
      delete facts.releaseConfirmedAt;
      delete facts.releasedAt;
    }
    pushActivity(data, context.workspace.id, "workflow.release_confirmation_updated", actorFor(context), {
      title: confirmation.status === "confirmed" ? "Release confirmed" : "Release confirmation cleared",
      confirmed: confirmation.status === "confirmed",
    }, timestamp);
    return copyRecord(confirmation);
  });
}

export async function updateReleaseConfirmationAsync(
  context: WorkflowContext,
  input: UpdateReleaseConfirmationInput,
): Promise<ReleaseConfirmationRecord> {
  const timestamp = now();
  const releaseNotes = (input.summary ?? "").trim();
  if (input.confirmed && releaseNotes.length < 2) throw httpError(400, "release summary must be at least 2 characters");

  return mutateStoreAsync((data) => {
    ensureWorkspace(data, context.workspace.id);
    const existing = listReleaseConfirmationsForWorkspace(data, context.workspace.id)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    const confirmation = upsertReleaseConfirmation(
      data,
      {
        id: existing?.id,
        workspaceId: context.workspace.id,
        versionLabel: (input.versionLabel ?? existing?.versionLabel ?? "release").trim() || "release",
        confirmed: input.confirmed,
        summary: releaseNotes,
        confirmedBy: input.confirmed ? context.user.displayName : "",
        status: input.confirmed ? "confirmed" : "pending",
        confirmedByUserId: input.confirmed ? context.user.id : undefined,
        confirmedAt: input.confirmed ? timestamp : undefined,
        releaseNotes,
        validationEvidenceIds: input.validationEvidenceIds ?? existing?.validationEvidenceIds ?? [],
      },
      timestamp,
    );

    const facts = ensureActivationFacts(data, context.workspace.id, timestamp);
    if (confirmation.status === "confirmed") {
      facts.releaseConfirmedAt = timestamp;
      facts.releasedAt = timestamp;
      markOnboardingStep(data, context.workspace.id, "confirm_release", timestamp);
    } else {
      delete facts.releaseConfirmedAt;
      delete facts.releasedAt;
    }
    pushActivity(data, context.workspace.id, "workflow.release_confirmation_updated", actorFor(context), {
      title: confirmation.status === "confirmed" ? "Release confirmed" : "Release confirmation cleared",
      confirmed: confirmation.status === "confirmed",
    }, timestamp);
    return copyRecord(confirmation);
  });
}

function normalizeRequirement(
  context: WorkflowContext,
  input: WorkflowRequirementInput,
  timestamp: string,
): RequirementRecord {
  return {
    id: input.id?.trim() || generateId(),
    workspaceId: context.workspace.id,
    title: requireText(input.title, "requirement title", 2),
    detail: (input.description ?? input.detail ?? "").trim(),
    description: (input.description ?? input.detail ?? "").trim(),
    priority: requireAllowed(input.priority ?? "should", ["must", "should", "could"], "requirement priority"),
    status: requireAllowed(input.status ?? "accepted", ["proposed", "accepted", "deferred"], "requirement status"),
    acceptanceCriteria: normalizeTextList(input.acceptanceCriteria ?? []),
    source: requireAllowed(input.source ?? "team", ["brief", "customer", "team", "system"], "requirement source"),
    createdByUserId: context.user.id,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function normalizePlanItem(
  workspaceId: string,
  input: WorkflowPlanItemInput,
  order: number,
  timestamp: string,
): ImplementationPlanItemRecord {
  const status = requireAllowed(input.status ?? "todo", ["todo", "in_progress", "blocked", "done"], "plan item status");
  return {
    id: input.id?.trim() || generateId(),
    workspaceId,
    requirementIds: normalizeTextList(input.requirementIds ?? []),
    title: requireText(input.title, "plan item title", 2),
    description: (input.description ?? "").trim(),
    status,
    ownerUserId: input.ownerUserId?.trim() || undefined,
    order,
    startedAt: status === "in_progress" || status === "blocked" || status === "done" ? timestamp : undefined,
    completedAt: status === "done" ? timestamp : undefined,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function normalizeConcern(
  workspaceId: string,
  kind: WorkflowConcernRecord["kind"],
  input: WorkflowConcernInput,
  timestamp: string,
): WorkflowConcernRecord {
  const statusInput = input.status === "answered" ? "resolved" : input.status ?? "open";
  const status = requireAllowed(statusInput, ["open", "resolved", "deferred"], "concern status");
  const title = input.title ?? input.prompt ?? "";
  const description = input.description ?? input.detail ?? input.answer ?? "";
  return {
    id: input.id?.trim() || generateId(),
    workspaceId,
    kind,
    title: requireText(title, "concern title", 2),
    description: description.trim(),
    status,
    severity: requireAllowed(input.severity ?? "medium", ["low", "medium", "high", "critical"], "concern severity"),
    relatedPlanItemId: input.relatedPlanItemId?.trim() || (input.dependency ? "external-dependency" : undefined),
    relatedRequirementId: input.relatedRequirementId?.trim() || undefined,
    ownerUserId: input.ownerUserId?.trim() || undefined,
    resolvedAt: status === "resolved" ? timestamp : undefined,
    resolutionNote: input.resolutionNote?.trim() || undefined,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function normalizeValidationEvidence(
  context: WorkflowContext,
  input: WorkflowValidationEvidenceInput,
  timestamp: string,
): ValidationEvidenceRecord {
  const outcome = requireAllowed(input.outcome ?? input.status ?? "pending", ["pending", "passed", "failed"], "validation outcome");
  const description = input.description ?? input.detail ?? "";
  const source = input.source ?? input.evidenceUrl ?? "";
  return {
    id: input.id?.trim() || generateId(),
    workspaceId: context.workspace.id,
    planItemId: input.planItemId?.trim() || undefined,
    requirementIds: normalizeTextList(input.requirementIds ?? []),
    type: requireAllowed(input.type ?? "manual_check", ["automated_test", "manual_check", "demo", "metric", "customer_review"], "validation evidence type"),
    title: requireText(input.title, "validation evidence title", 2),
    detail: description.trim(),
    description: description.trim(),
    status: outcome,
    outcome,
    source: source.trim(),
    evidenceUrl: input.evidenceUrl?.trim() || input.source?.trim() || undefined,
    capturedByUserId: context.user.id,
    capturedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function ensureWorkspaceExists(workspaceId: string): void {
  if (!findWorkspaceByIdIndexed(workspaceId)) throw httpError(404, "workspace not found");
}

function ensureWorkspace(data: PacketAgentData, workspaceId: string): WorkspaceRecord {
  const workspace = data.workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) throw httpError(404, "workspace not found");
  return workspace;
}

function ensureActivationFacts(data: PacketAgentData, workspaceId: string, timestamp: string) {
  const facts = data.activationFacts[workspaceId] ?? { now: timestamp };
  facts.now = timestamp;
  data.activationFacts[workspaceId] = facts;
  return facts;
}

function markOnboardingStep(
  data: PacketAgentData,
  workspaceId: string,
  stepKey: OnboardingStepKey,
  timestamp: string,
  enabled = true,
) {
  if (!enabled) return;
  const record = data.onboardingStates.find((entry) => entry.workspaceId === workspaceId);
  if (!record) return;
  if (!record.completedSteps.includes(stepKey)) record.completedSteps.push(stepKey);
  record.currentStep = nextIncompleteStep(record.completedSteps);
  record.status = record.completedSteps.length === ONBOARDING_STEPS.length ? "completed" : "in_progress";
  record.completedAt = record.status === "completed" ? timestamp : record.completedAt;
  record.updatedAt = timestamp;
}

function defaultWorkspaceBrief(context: WorkflowContext): WorkspaceBriefRecord {
  return {
    workspaceId: context.workspace.id,
    summary: context.workspace.automationGoal,
    goals: [],
    audience: "",
    constraints: "",
    problemStatement: "",
    targetCustomers: [],
    desiredOutcome: "",
    successMetrics: [],
    updatedByUserId: context.user.id,
    createdAt: context.workspace.createdAt,
    updatedAt: context.workspace.updatedAt,
  };
}

function actorFor(context: WorkflowContext): ActivityRecord["actor"] {
  return {
    type: "user",
    id: context.user.id,
    displayName: context.user.displayName,
  };
}

function pushActivity(
  data: PacketAgentData,
  workspaceId: string,
  event: string,
  actor: ActivityRecord["actor"],
  activityData: ActivityRecord["data"],
  timestamp: string,
  id = generateId(),
) {
  if (data.activities.some((entry) => entry.id === id)) return;
  recordActivity(data, {
    id,
    workspaceId,
    scope: "activation",
    event,
    actor,
    data: activityData,
    occurredAt: timestamp,
  }, { dedupe: true });
}

function briefScopeChanged(
  previous: WorkspaceBriefRecord,
  next: Pick<WorkspaceBriefRecord, "summary" | "goals" | "audience" | "constraints" | "problemStatement" | "targetCustomers" | "desiredOutcome" | "successMetrics">,
): boolean {
  return previous.summary !== next.summary ||
    previous.audience !== next.audience ||
    previous.constraints !== next.constraints ||
    previous.problemStatement !== next.problemStatement ||
    previous.desiredOutcome !== next.desiredOutcome ||
    !sameStringList(previous.goals ?? [], next.goals ?? []) ||
    !sameStringList(previous.targetCustomers ?? [], next.targetCustomers ?? []) ||
    !sameStringList(previous.successMetrics ?? [], next.successMetrics ?? []);
}

function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function activationSignalStableKey(
  workspaceId: string,
  kind: ActivationSignalRecord["kind"],
  source: ActivationSignalRecord["source"],
  sourceId: string,
): string {
  return `${workspaceId}:${kind}:${source}:${sourceId}`;
}

function activationActivityId(workspaceId: string, event: string, signalId: string): string {
  return `activity_${stableIdPart(workspaceId)}_${stableIdPart(event)}_${stableIdPart(signalId)}`;
}

function stableIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_");
}

function copyRecord<T>(record: T): T {
  return record && typeof record === "object" ? { ...record } : record;
}

function planItemToInput(entry: ImplementationPlanItemRecord): WorkflowPlanItemInput {
  return {
    id: entry.id,
    requirementIds: entry.requirementIds,
    title: entry.title,
    description: entry.description,
    status: entry.status,
    ownerUserId: entry.ownerUserId,
  };
}

function concernToInput(entry: WorkflowConcernRecord): WorkflowConcernInput {
  return {
    id: entry.id,
    title: entry.title,
    description: entry.description,
    status: entry.status,
    severity: entry.severity,
    relatedPlanItemId: entry.relatedPlanItemId,
    relatedRequirementId: entry.relatedRequirementId,
    ownerUserId: entry.ownerUserId,
    resolutionNote: entry.resolutionNote,
  };
}

function validationEvidenceToInput(entry: ValidationEvidenceRecord): WorkflowValidationEvidenceInput {
  return {
    id: entry.id,
    planItemId: entry.planItemId,
    requirementIds: entry.requirementIds,
    type: entry.type as ValidationEvidenceType,
    title: entry.title,
    description: entry.description ?? entry.detail,
    outcome: entry.status ?? entry.outcome as ValidationEvidenceOutcome,
    evidenceUrl: entry.evidenceUrl ?? entry.source,
  };
}

function toBlockerDto(entry: WorkflowConcernRecord) {
  return {
    ...copyRecord(entry),
    detail: entry.description,
    dependency: Boolean(entry.relatedPlanItemId || entry.relatedRequirementId),
  };
}

function toQuestionDto(entry: WorkflowConcernRecord) {
  return {
    ...copyRecord(entry),
    prompt: entry.title,
    answer: entry.description,
    status: entry.status === "open" ? "open" : "answered",
    answeredAt: entry.resolvedAt,
  };
}

function normalizeTextList(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

function requireText(value: string, label: string, minimumLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length < minimumLength) {
    throw httpError(400, `${label} must be at least ${minimumLength} characters`);
  }
  return trimmed;
}

function requireAllowed<T extends string>(value: T, allowed: readonly T[], label: string): T {
  if (!allowed.includes(value)) {
    throw httpError(400, `unknown ${label}`);
  }
  return value;
}

export function httpError(status: number, message: string) {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}
