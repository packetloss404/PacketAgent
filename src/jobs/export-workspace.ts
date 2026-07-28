import {
  loadStore as loadDefaultStore,
  loadStoreAsync as loadDefaultStoreAsync,
} from "../packetagent-store.js";
import type {
  ActivationSignalRecord,
  ActivityRecord,
  AgentRecord,
  AgentRunRecord,
  ImplementationPlanItemRecord,
  InvitationEmailDeliveryRecord,
  JobRecord,
  ProviderRecord,
  ReleaseConfirmationCollection,
  ReleaseConfirmationRecord,
  RequirementRecord,
  ShareTokenRecord,
  PacketAgentData,
  UserRecord,
  ValidationEvidenceRecord,
  WorkflowConcernRecord,
  WorkspaceBriefCollection,
  WorkspaceBriefRecord,
  WorkspaceEnvVarRecord,
  WorkspaceInvitationRecord,
  WorkspaceMemberRecord,
  WorkerCredentialRecord,
} from "../packetagent-store.js";
import type { ActivationMilestoneRecord, ActivationStatusDto } from "../activation/domain.js";
import type { WorkspaceActivationFacts } from "../activation/adapters.js";
import { maskSecret, redactSensitiveValue } from "../security/redaction.js";
import type {
  WorkerCheckpoint,
  WorkerDefinition,
  WorkerDeployment,
  WorkerRun,
  WorkerVersion,
} from "../workers/types.js";
import type {
  WorkerDeploymentRollout,
  WorkerEvent,
  WorkerLifecycleCommandReceipt,
} from "../workers/persistence-types.js";
import type {
  WorkerArtifactManifest,
  WorkerEvidenceEntry,
} from "../workers/observability/types.js";
import type {
  WorkerActivationInboxRecord,
  WorkerActivationPayloadMetadata,
  WorkerActivationPayloadRecord,
} from "../workers/activation-types.js";
import type { WorkerEffectReceipt } from "../workers/effect-types.js";
import { workerCredentialMetadata } from "../workers/credentials.js";
import type { WorkerCredentialMetadata } from "../workers/credential-types.js";
import {
  packetProductCredentialMetadata,
  type PacketProductCredentialMetadata,
  type WorkerPackageDeploymentRecord,
  type WorkerPackageReceipt,
} from "../workers/package/trust-types.js";

export interface ExportWorkspaceOptions {
  workspaceId: string;
}

export interface ExportWorkspaceDeps {
  loadStore: () => PacketAgentData;
}

export interface ExportWorkspaceAsyncDeps {
  loadStore: () => PacketAgentData | Promise<PacketAgentData>;
}

export interface RedactedInvitation extends Omit<WorkspaceInvitationRecord, "token"> {
  tokenPreview: string;
}

export interface RedactedShareToken extends Omit<ShareTokenRecord, "token"> {
  tokenPreview: string;
}

export interface RedactedAgent extends Omit<AgentRecord, "webhookToken"> {
  webhookTokenPreview: string;
  hasWebhookToken: boolean;
}

export interface RedactedWorkspaceEnvVar extends Omit<WorkspaceEnvVarRecord, "value"> {
  valuePreview: string;
  hasValue: boolean;
}

export interface RedactedProvider extends ProviderRecord {
  hasApiKey: boolean;
}

export interface ExportedWorkspaceData {
  users: UserRecord[];
  memberships: WorkspaceMemberRecord[];
  invitations: RedactedInvitation[];
  invitationEmailDeliveries: InvitationEmailDeliveryRecord[];
  workspaceBriefs: WorkspaceBriefRecord[];
  requirements: RequirementRecord[];
  implementationPlanItems: ImplementationPlanItemRecord[];
  workflowConcerns: WorkflowConcernRecord[];
  validationEvidence: ValidationEvidenceRecord[];
  releaseConfirmations: ReleaseConfirmationRecord[];
  agents: RedactedAgent[];
  agentRuns: AgentRunRecord[];
  jobs: JobRecord[];
  providers: RedactedProvider[];
  providerCalls: unknown[];
  workspaceEnvVars: RedactedWorkspaceEnvVar[];
  shareTokens: RedactedShareToken[];
  activities: ActivityRecord[];
  workerCredentials: WorkerCredentialMetadata[];
  packetProductCredentials: PacketProductCredentialMetadata[];
  workerPackageReceipts: WorkerPackageReceipt[];
  workerPackageDeployments: WorkerPackageDeploymentRecord[];
  workerDefinitions: WorkerDefinition[];
  workerVersions: WorkerVersion[];
  workerDeployments: WorkerDeployment[];
  workerRuns: WorkerRun[];
  workerCheckpoints: WorkerCheckpoint[];
  workerEffectReceipts: WorkerEffectReceipt[];
  workerBudgetReservations: import("../workers/budget-types.js").WorkerBudgetReservationRecord[];
  workerAttentionRequests: import("../workers/control-types.js").WorkerAttentionRequest[];
  workerApprovalGrants: import("../workers/control-types.js").WorkerApprovalGrant[];
  workerControlCommands: import("../workers/control-types.js").WorkerControlCommand[];
  workerNotificationDeliveries: import("../workers/control-types.js").WorkerNotificationDeliveryReference[];
  workerDeploymentRollouts: WorkerDeploymentRollout[];
  workerCommandReceipts: WorkerLifecycleCommandReceipt[];
  workerEvents: WorkerEvent[];
  workerEvidenceEntries: WorkerEvidenceEntry[];
  workerArtifactManifests: WorkerArtifactManifest[];
  workerActivationInboxes: WorkerActivationInboxRecord[];
  workerActivationPayloads: WorkerActivationPayloadMetadata[];
  activationFacts: WorkspaceActivationFacts | null;
  activationSignals: ActivationSignalRecord[];
  activationMilestones: ActivationMilestoneRecord[];
  activationReadModel: ActivationStatusDto | null;
}

export interface ExportWorkspaceResult {
  command: "export-workspace";
  workspaceId: string;
  exportedAt: string;
  data: ExportedWorkspaceData;
}

const defaultDeps: ExportWorkspaceDeps = {
  loadStore: loadDefaultStore,
};

const defaultAsyncDeps: ExportWorkspaceAsyncDeps = {
  loadStore: loadDefaultStoreAsync,
};

export function exportWorkspaceData(
  options: ExportWorkspaceOptions,
  deps: ExportWorkspaceDeps = defaultDeps,
): ExportWorkspaceResult {
  return buildWorkspaceExport(options, deps.loadStore());
}

export async function exportWorkspaceDataAsync(
  options: ExportWorkspaceOptions,
  deps: ExportWorkspaceAsyncDeps = defaultAsyncDeps,
): Promise<ExportWorkspaceResult> {
  return buildWorkspaceExport(options, await deps.loadStore());
}

function buildWorkspaceExport(
  options: ExportWorkspaceOptions,
  store: PacketAgentData,
): ExportWorkspaceResult {
  const { workspaceId } = options;
  const workspace = store.workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) {
    throw Object.assign(new Error("workspace not found"), { status: 404 });
  }

  const memberships = (store.memberships ?? []).filter(
    (entry) => entry.workspaceId === workspaceId,
  );
  const memberUserIds = new Set(memberships.map((entry) => entry.userId));
  const users = (store.users ?? []).filter((entry) => memberUserIds.has(entry.id));

  const invitations = (store.workspaceInvitations ?? [])
    .filter((entry) => entry.workspaceId === workspaceId)
    .map((entry) => redactInvitation(entry));

  const invitationIds = new Set(invitations.map((entry) => entry.id));
  const invitationEmailDeliveries = (store.invitationEmailDeliveries ?? [])
    .filter((entry) => entry.workspaceId === workspaceId && invitationIds.has(entry.invitationId))
    .map((entry) => redactSensitiveValue(entry) as InvitationEmailDeliveryRecord);

  const workspaceBriefs = briefEntries(store.workspaceBriefs)
    .filter((entry) => entry.workspaceId === workspaceId)
    .map((entry) => redactSensitiveValue(entry) as WorkspaceBriefRecord);

  const requirements = (store.requirements ?? [])
    .filter((entry) => entry.workspaceId === workspaceId)
    .map((entry) => redactSensitiveValue(entry) as RequirementRecord);

  const implementationPlanItems = (store.implementationPlanItems ?? [])
    .filter((entry) => entry.workspaceId === workspaceId)
    .map((entry) => redactSensitiveValue(entry) as ImplementationPlanItemRecord);

  const workflowConcerns = (store.workflowConcerns ?? [])
    .filter((entry) => entry.workspaceId === workspaceId)
    .map((entry) => redactSensitiveValue(entry) as WorkflowConcernRecord);

  const validationEvidence = (store.validationEvidence ?? [])
    .filter((entry) => entry.workspaceId === workspaceId)
    .map((entry) => redactSensitiveValue(entry) as ValidationEvidenceRecord);

  const releaseConfirmations = releaseEntries(store.releaseConfirmations)
    .filter((entry) => entry.workspaceId === workspaceId)
    .map((entry) => redactSensitiveValue(entry) as ReleaseConfirmationRecord);

  const agents = (store.agents ?? [])
    .filter((entry) => entry.workspaceId === workspaceId)
    .map((entry) => redactAgent(entry));

  const agentRuns = (store.agentRuns ?? [])
    .filter((entry) => entry.workspaceId === workspaceId)
    .map((entry) => redactSensitiveValue(entry) as AgentRunRecord);

  const jobs = (store.jobs ?? [])
    .filter((entry) => entry.workspaceId === workspaceId)
    .map((entry) => redactSensitiveValue(entry) as JobRecord);

  const providers = (store.providers ?? [])
    .filter((entry) => entry.workspaceId === workspaceId)
    .map((entry) => redactProvider(entry));

  const providerCalls = (store.providerCalls ?? [])
    .filter((entry) => entry.workspaceId === workspaceId)
    .map((entry) => redactSensitiveValue(entry));

  const workspaceEnvVars = (store.workspaceEnvVars ?? [])
    .filter((entry) => entry.workspaceId === workspaceId)
    .map((entry) => redactEnvVar(entry));

  const shareTokens = (store.shareTokens ?? [])
    .filter((entry) => entry.workspaceId === workspaceId)
    .map((entry) => redactShareToken(entry));

  const activities = (store.activities ?? [])
    .filter((entry) => entry.workspaceId === workspaceId)
    .map((entry) => redactSensitiveValue(entry) as ActivityRecord);

  const workerCredentials = workspaceWorkerRecords(store.workerCredentials, workspaceId).map(
    (record: WorkerCredentialRecord) => workerCredentialMetadata(record),
  );
  const packetProductCredentials = workspaceWorkerRecords(
    store.packetProductCredentials,
    workspaceId,
  ).map(packetProductCredentialMetadata);
  const workerPackageReceipts = workspaceWorkerRecords(store.workerPackageReceipts, workspaceId);
  const workerPackageDeployments = workspaceWorkerRecords(
    store.workerPackageDeployments,
    workspaceId,
  );
  const workerDefinitions = workspaceWorkerRecords(store.workerDefinitions, workspaceId);
  const workerVersions = workspaceWorkerRecords(store.workerVersions, workspaceId);
  const workerDeployments = workspaceWorkerRecords(store.workerDeployments, workspaceId);
  const workerRuns = workspaceWorkerRecords(store.workerRuns, workspaceId);
  const workerCheckpoints = workspaceWorkerRecords(store.workerCheckpoints, workspaceId);
  const workerEffectReceipts = workspaceWorkerRecords(store.workerEffectReceipts, workspaceId);
  const workerBudgetReservations = workspaceWorkerRecords(
    store.workerBudgetReservations,
    workspaceId,
  );
  const workerAttentionRequests = workspaceWorkerRecords(
    store.workerAttentionRequests,
    workspaceId,
  );
  const workerApprovalGrants = workspaceWorkerRecords(store.workerApprovalGrants, workspaceId);
  const workerControlCommands = workspaceWorkerRecords(store.workerControlCommands, workspaceId);
  const workerNotificationDeliveries = workspaceWorkerRecords(
    store.workerNotificationDeliveries,
    workspaceId,
  );
  const workerDeploymentRollouts = workspaceWorkerRecords(
    store.workerDeploymentRollouts,
    workspaceId,
  );
  const workerCommandReceipts = workspaceWorkerRecords(store.workerCommandReceipts, workspaceId);
  const workerEvents = workspaceWorkerRecords(store.workerEvents, workspaceId);
  const workerEvidenceEntries = workspaceWorkerRecords(store.workerEvidenceEntries, workspaceId);
  const workerArtifactManifests = workspaceWorkerRecords(
    store.workerArtifactManifests,
    workspaceId,
  );
  const workerActivationInboxes = workspaceWorkerRecords(
    store.workerActivationInboxes,
    workspaceId,
  );
  const workerActivationPayloads = workspaceWorkerRecords(
    store.workerActivationPayloads,
    workspaceId,
  ).map(workerActivationPayloadMetadata);

  const activationFacts = store.activationFacts?.[workspaceId] ?? null;
  const activationSignals = (store.activationSignals ?? [])
    .filter((entry) => entry.workspaceId === workspaceId)
    .map((entry) => redactSensitiveValue(entry) as ActivationSignalRecord);
  const activationMilestones = (store.activationMilestones?.[workspaceId] ?? []).map(
    (entry) => redactSensitiveValue(entry) as ActivationMilestoneRecord,
  );
  const activationReadModel = store.activationReadModels?.[workspaceId]
    ? (redactSensitiveValue(store.activationReadModels[workspaceId]) as ActivationStatusDto)
    : null;

  return {
    command: "export-workspace",
    workspaceId,
    exportedAt: new Date().toISOString(),
    data: {
      users,
      memberships,
      invitations,
      invitationEmailDeliveries,
      workspaceBriefs,
      requirements,
      implementationPlanItems,
      workflowConcerns,
      validationEvidence,
      releaseConfirmations,
      agents,
      agentRuns,
      jobs,
      providers,
      providerCalls,
      workspaceEnvVars,
      shareTokens,
      activities,
      workerCredentials,
      packetProductCredentials,
      workerPackageReceipts,
      workerPackageDeployments,
      workerDefinitions,
      workerVersions,
      workerDeployments,
      workerRuns,
      workerCheckpoints,
      workerEffectReceipts,
      workerBudgetReservations,
      workerAttentionRequests,
      workerApprovalGrants,
      workerControlCommands,
      workerNotificationDeliveries,
      workerDeploymentRollouts,
      workerCommandReceipts,
      workerEvents,
      workerEvidenceEntries,
      workerArtifactManifests,
      workerActivationInboxes,
      workerActivationPayloads,
      activationFacts,
      activationSignals,
      activationMilestones,
      activationReadModel,
    },
  };
}

function workerActivationPayloadMetadata(
  record: WorkerActivationPayloadRecord,
): WorkerActivationPayloadMetadata {
  const { ciphertext: _ciphertext, iv: _iv, authTag: _authTag, ...metadata } = record;
  return { ...metadata, encrypted: true };
}

function workspaceWorkerRecords<TRecord extends { workspaceId: string }>(
  records: readonly TRecord[] | undefined,
  workspaceId: string,
): TRecord[] {
  return (records ?? [])
    .filter((entry) => entry.workspaceId === workspaceId)
    .map((entry) => redactSensitiveValue(entry) as TRecord);
}

function redactInvitation(invitation: WorkspaceInvitationRecord): RedactedInvitation {
  const { token, ...rest } = invitation;
  return { ...rest, tokenPreview: maskSecret(token) };
}

function redactShareToken(shareToken: ShareTokenRecord): RedactedShareToken {
  const { token, ...rest } = shareToken;
  return { ...rest, tokenPreview: maskSecret(token) };
}

function redactAgent(agent: AgentRecord): RedactedAgent {
  const { webhookToken, ...rest } = agent;
  return {
    ...rest,
    webhookTokenPreview: webhookToken ? maskSecret(webhookToken) : "",
    hasWebhookToken: Boolean(webhookToken),
  };
}

function redactEnvVar(envVar: WorkspaceEnvVarRecord): RedactedWorkspaceEnvVar {
  const { value, ...rest } = envVar;
  return {
    ...rest,
    valuePreview: value ? maskSecret(value) : "",
    hasValue: Boolean(value),
  };
}

function redactProvider(provider: ProviderRecord): RedactedProvider {
  const sanitized = redactSensitiveValue(provider) as ProviderRecord;
  return { ...sanitized, hasApiKey: Boolean(provider.apiKeyConfigured) };
}

function briefEntries(collection: WorkspaceBriefCollection | undefined): WorkspaceBriefRecord[] {
  if (!collection) return [];
  return Array.isArray(collection) ? collection : Object.values(collection);
}

function releaseEntries(
  collection: ReleaseConfirmationCollection | undefined,
): ReleaseConfirmationRecord[] {
  if (!collection) return [];
  return Array.isArray(collection) ? collection : Object.values(collection);
}
