import type {
  ActivationSignalOrigin,
  ActivationSignalRecord,
  ActivationSignalSource,
  ReleaseConfirmationCollection,
  PacketAgentData,
  WorkspaceBriefCollection,
} from "./types.js";

// LEAF module: pure normalization of partial/loaded store payloads into a
// complete PacketAgentData shape. Imports only types — never a backend or barrel.

export function normalizeStore(data: Partial<PacketAgentData>): PacketAgentData {
  return {
    users: data.users ?? [],
    sessions: data.sessions ?? [],
    rateLimits: data.rateLimits ?? [],
    workspaces: data.workspaces ?? [],
    memberships: data.memberships ?? [],
    workspaceInvitations: data.workspaceInvitations ?? [],
    invitationEmailDeliveries: data.invitationEmailDeliveries ?? [],
    workspaceBriefs: normalizeWorkspaceBriefCollection(data.workspaceBriefs),
    workspaceBriefVersions: data.workspaceBriefVersions ?? [],
    requirements: data.requirements ?? [],
    implementationPlanItems: data.implementationPlanItems ?? [],
    workflowConcerns: data.workflowConcerns ?? [],
    validationEvidence: data.validationEvidence ?? [],
    releaseConfirmations: normalizeReleaseConfirmationCollection(data.releaseConfirmations),
    onboardingStates: data.onboardingStates ?? [],
    activities: data.activities ?? [],
    activationSignals: (data.activationSignals ?? []).map(normalizeActivationSignalRecord),
    agents: (data.agents ?? []).map((entry) => ({
      ...entry,
      inputSchema: Array.isArray(entry.inputSchema) ? entry.inputSchema : [],
    })),
    generatedApps: data.generatedApps ?? [],
    providers: data.providers ?? [],
    agentRuns: (data.agentRuns ?? []).map((entry) => ({
      ...entry,
      logs: Array.isArray(entry.logs) ? entry.logs : [],
    })),
    workspaceEnvVars: data.workspaceEnvVars ?? [],
    apiKeys: data.apiKeys ?? [],
    providerCalls: data.providerCalls ?? [],
    jobs: data.jobs ?? [],
    jobMetricSnapshots: data.jobMetricSnapshots ?? [],
    alertEvents: data.alertEvents ?? [],
    shareTokens: data.shareTokens ?? [],
    workerCredentials: data.workerCredentials ?? [],
    workerDefinitions: data.workerDefinitions ?? [],
    workerVersions: data.workerVersions ?? [],
    workerDeployments: data.workerDeployments ?? [],
    workerRuns: (data.workerRuns ?? []).map((entry) => ({
      ...entry,
      revision: entry.revision ?? 1,
      runtimeFence: entry.runtimeFence ?? 0,
    })),
    workerCheckpoints: data.workerCheckpoints ?? [],
    workerEffectReceipts: data.workerEffectReceipts ?? [],
    workerBudgetReservations: data.workerBudgetReservations ?? [],
    workerAttentionRequests: data.workerAttentionRequests ?? [],
    workerApprovalGrants: data.workerApprovalGrants ?? [],
    workerControlCommands: data.workerControlCommands ?? [],
    workerNotificationDeliveries: data.workerNotificationDeliveries ?? [],
    workerDeploymentRollouts: data.workerDeploymentRollouts ?? [],
    workerCommandReceipts: data.workerCommandReceipts ?? [],
    workerEvents: data.workerEvents ?? [],
    workerActivationInboxes: data.workerActivationInboxes ?? [],
    workerActivationPayloads: data.workerActivationPayloads ?? [],
    activationFacts: data.activationFacts ?? {},
    activationMilestones: data.activationMilestones ?? {},
    activationReadModels: data.activationReadModels ?? {},
  };
}

function normalizeWorkspaceBriefCollection(collection: Partial<PacketAgentData>["workspaceBriefs"]): WorkspaceBriefCollection {
  if (!collection) return {};
  if (!Array.isArray(collection)) return collection;
  return Object.fromEntries(collection.map((entry) => [entry.workspaceId, entry]));
}

function normalizeReleaseConfirmationCollection(
  collection: Partial<PacketAgentData>["releaseConfirmations"],
): ReleaseConfirmationCollection {
  if (!collection) return {};
  if (!Array.isArray(collection)) return collection;
  return Object.fromEntries(collection.map((entry) => [entry.workspaceId, entry]));
}

export function inferActivationSignalOrigin(source: ActivationSignalSource): ActivationSignalOrigin | undefined {
  if (source === "seed" || source === "system_fact" || source === "activity") return "system_observed";
  if (source === "user_fact" || source === "workflow" || source === "agent_run") return "user_entered";
  return undefined;
}

export function normalizeActivationSignalRecord(record: ActivationSignalRecord): ActivationSignalRecord {
  return {
    ...record,
    origin: record.origin ?? inferActivationSignalOrigin(record.source),
  };
}
