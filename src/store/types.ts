import type { ActivationMilestoneRecord, ActivationStatusDto } from "../activation/domain";
import type { WorkspaceActivationFacts } from "../activation/adapters";
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
  WorkerActivationInboxRecord,
  WorkerActivationPayloadRecord,
} from "../workers/activation-types.js";
import type { WorkerEffectReceipt } from "../workers/effect-types.js";

export interface UserRecord {
  id: string;
  email: string;
  displayName: string;
  timezone: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRecord {
  id: string;
  userId: string;
  secretHash: string;
  createdAt: string;
  lastAccessedAt: string;
  expiresAt: string;
}

export interface RateLimitRecord {
  id: string;
  count: number;
  resetAt: string;
  updatedAt: string;
}

export interface WorkspaceRecord {
  id: string;
  slug: string;
  name: string;
  website: string;
  automationGoal: string;
  createdAt: string;
  updatedAt: string;
}

export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";

export interface WorkspaceMemberRecord {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  joinedAt: string;
}

export interface WorkspaceInvitationRecord {
  id: string;
  workspaceId: string;
  email: string;
  role: WorkspaceRole;
  token: string;
  invitedByUserId: string;
  acceptedByUserId?: string;
  acceptedAt?: string;
  revokedAt?: string;
  expiresAt: string;
  createdAt: string;
}

export type InvitationEmailDeliveryStatus = "pending" | "sent" | "skipped" | "failed";
export type InvitationEmailDeliveryMode = "dev" | "skip" | "webhook";

export interface InvitationEmailDeliveryRecord {
  id: string;
  workspaceId: string;
  invitationId: string;
  recipientEmail: string;
  subject: string;
  status: InvitationEmailDeliveryStatus;
  provider: string;
  mode: InvitationEmailDeliveryMode;
  createdAt: string;
  sentAt?: string;
  error?: string;
  providerStatus?: string;
  providerDeliveryId?: string;
  providerStatusAt?: string;
  providerError?: string;
}

export interface JobMetricSnapshotRecord {
  id: string;
  capturedAt: string;
  type: string;
  totalRuns: number;
  succeededRuns: number;
  failedRuns: number;
  canceledRuns: number;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  lastDurationMs: number | null;
  averageDurationMs: number | null;
  p95DurationMs: number | null;
}

export interface AlertEventRecord {
  id: string;
  ruleId: string;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  observedAt: string;
  context: Record<string, unknown>;
  delivered: boolean;
  deliveryError?: string;
  deliveryAttempts?: number;
  lastDeliveryAttemptAt?: string;
  deadLettered?: boolean;
}

export interface WorkspaceBriefRecord {
  workspaceId: string;
  summary: string;
  goals?: string[];
  audience?: string;
  constraints?: string;
  problemStatement?: string;
  targetCustomers?: string[];
  desiredOutcome?: string;
  successMetrics?: string[];
  updatedByUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceBriefVersionRecord {
  id: string;
  workspaceId: string;
  versionNumber: number;
  summary: string;
  goals: string[];
  audience: string;
  constraints: string;
  problemStatement: string;
  targetCustomers: string[];
  desiredOutcome: string;
  successMetrics: string[];
  source: "manual" | "template" | "restore";
  sourceLabel?: string;
  createdByUserId?: string;
  createdByDisplayName?: string;
  createdAt: string;
}

export type RequirementPriority = "must" | "should" | "could";
export type RequirementStatus = "draft" | "approved" | "changed" | "done" | "proposed" | "accepted" | "deferred";

export interface RequirementRecord {
  id: string;
  workspaceId: string;
  title: string;
  detail?: string;
  description?: string;
  priority: RequirementPriority;
  status: RequirementStatus;
  acceptanceCriteria?: string[];
  source?: string;
  createdByUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export type ImplementationPlanItemStatus = "todo" | "in_progress" | "blocked" | "done";

export interface ImplementationPlanItemRecord {
  id: string;
  workspaceId: string;
  requirementIds: string[];
  title: string;
  description: string;
  status: ImplementationPlanItemStatus;
  ownerUserId?: string;
  order: number;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type WorkflowConcernKind = "blocker" | "open_question";
export type WorkflowConcernStatus = "open" | "resolved" | "deferred";
export type WorkflowConcernSeverity = "low" | "medium" | "high" | "critical";

export interface WorkflowConcernRecord {
  id: string;
  workspaceId: string;
  kind: WorkflowConcernKind;
  title: string;
  description: string;
  status: WorkflowConcernStatus;
  severity: WorkflowConcernSeverity;
  relatedPlanItemId?: string;
  relatedRequirementId?: string;
  ownerUserId?: string;
  resolvedAt?: string;
  resolutionNote?: string;
  createdAt: string;
  updatedAt: string;
}

export type ValidationEvidenceType = "automated_test" | "manual_check" | "demo" | "metric" | "customer_review";
export type ValidationEvidenceOutcome = "pending" | "passed" | "failed";

export interface ValidationEvidenceRecord {
  id: string;
  workspaceId: string;
  planItemId?: string;
  requirementIds?: string[];
  type?: string;
  title: string;
  detail?: string;
  description?: string;
  status?: ValidationEvidenceOutcome;
  outcome?: string;
  source?: string;
  evidenceUrl?: string;
  capturedByUserId?: string;
  capturedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type ReleaseConfirmationStatus = "pending" | "confirmed" | "rolled_back";

export interface ReleaseConfirmationRecord {
  workspaceId: string;
  confirmed?: boolean;
  summary?: string;
  confirmedBy?: string;
  id?: string;
  versionLabel?: string;
  status?: ReleaseConfirmationStatus;
  confirmedByUserId?: string;
  confirmedAt?: string;
  releaseNotes?: string;
  validationEvidenceIds?: string[];
  createdAt?: string;
  updatedAt: string;
}

export type WorkspaceBriefCollection = WorkspaceBriefRecord[] | Record<string, WorkspaceBriefRecord>;
export type ReleaseConfirmationCollection = ReleaseConfirmationRecord[] | Record<string, ReleaseConfirmationRecord>;

export interface OnboardingStateRecord {
  workspaceId: string;
  status: "not_started" | "in_progress" | "completed";
  currentStep: OnboardingStepKey;
  completedSteps: OnboardingStepKey[];
  completedAt?: string;
  updatedAt: string;
}

export interface ActivityRecord {
  id: string;
  workspaceId: string;
  scope: "account" | "workspace" | "activation";
  event: string;
  occurredAt: string;
  actor: { type: "user" | "system"; id: string; displayName?: string };
  data: Record<string, string | number | boolean | null | undefined>;
}

export type ActivationSignalKind = "retry" | "scope_change";
export type ActivationSignalSource = "activity" | "agent_run" | "workflow" | "seed" | "user_fact" | "system_fact";
export type ActivationSignalOrigin = "user_entered" | "system_observed";

export interface ActivationSignalRecord {
  id: string;
  workspaceId: string;
  kind: ActivationSignalKind;
  source: ActivationSignalSource;
  origin?: ActivationSignalOrigin;
  sourceId?: string;
  stableKey?: string;
  createdAt: string;
  updatedAt: string;
  data?: Record<string, string | number | boolean | null | undefined>;
}

export type AgentStatus = "active" | "paused" | "archived";
export type AgentTriggerKind = "manual" | "schedule" | "webhook" | "email";

export interface AgentPlaybookStep {
  id: string;
  title: string;
  instruction: string;
}

export type AgentInputFieldType = "string" | "number" | "boolean" | "url" | "enum";

export interface AgentInputField {
  key: string;
  label: string;
  type: AgentInputFieldType;
  required: boolean;
  description?: string;
  options?: string[];
  defaultValue?: string;
}

export interface AgentRecord {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  instructions: string;
  providerId?: string;
  model?: string;
  tools: string[];
  enabledTools?: string[];
  routeKey?: string;
  webhookToken?: string;
  schedule?: string;
  triggerKind?: AgentTriggerKind;
  playbook?: AgentPlaybookStep[];
  status: AgentStatus;
  createdByUserId: string;
  templateId?: string;
  inputSchema: AgentInputField[];
  publishHistory?: Record<string, unknown>[];
  currentPublishId?: string;
  publishStatus?: string;
  publishedUrl?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export type GeneratedAppStatus = "draft" | "saved" | "built";

export type GeneratedAppPublishVisibility = "private" | "public";
export type GeneratedAppPublishStatus = "pending" | "published" | "failed" | "rolled_back";
export type GeneratedAppPublishLogLevel = "info" | "warn" | "error";
export type GeneratedAppPublishRollbackStatus = "pending" | "succeeded" | "failed" | "noop";

export interface GeneratedAppPublishLogEntry {
  at: string;
  level: GeneratedAppPublishLogLevel;
  message: string;
}

export interface GeneratedAppDockerComposeExportPayload {
  fileName: "docker-compose.publish.yml";
  format: "docker-compose";
  version: "3.9";
  services: string[];
  environment: Record<string, string>;
  volumes: string[];
  bundlePath: string;
  manifestPath: string;
  instructions: string[];
  yaml: string;
}

export interface GeneratedAppPublishArtifactManifestEntry {
  path: string;
  kind: "source" | "build_output" | "generated_bundle" | "manifest" | "config";
  required: boolean;
  description: string;
}

export interface GeneratedAppPublishArtifactManifest {
  fileName: "publish-artifacts.json";
  packageId: string;
  entries: GeneratedAppPublishArtifactManifestEntry[];
}

export interface GeneratedAppPublishRollbackCommand {
  kind: "generated-app-publish-rollback";
  commandId: string;
  command: string;
  workspaceId: string;
  appId: string;
  fromPublishId: string;
  toPublishId: string;
  fromLocalPublishPath: string;
  toLocalPublishPath: string;
  requestedByUserId?: string;
  reason?: string;
  requiresConfirmation: true;
  expectedResult: {
    status: "pending";
    restoredPublishId: string;
    supersededPublishId: string;
    localPublishPath: string;
    publicUrl?: string;
    privateUrl?: string;
  };
}

export interface GeneratedAppPublishRollbackResult {
  kind: "generated-app-publish-rollback-result";
  commandId: string;
  status: GeneratedAppPublishRollbackStatus;
  rolledBack: boolean;
  restoredPublishId: string;
  supersededPublishId: string;
  completedAt: string;
  localPublishPath: string;
  publicUrl?: string;
  privateUrl?: string;
  message: string;
  error?: string;
}

export interface GeneratedAppPublishRecord {
  id: string;
  appId: string;
  workspaceId: string;
  checkpointId: string;
  status: GeneratedAppPublishStatus;
  visibility: GeneratedAppPublishVisibility;
  versionLabel: string;
  localPublishPath: string;
  workspacePath: string;
  publicUrl: string;
  privateUrl: string;
  previewUrl?: string;
  buildStatus?: string;
  smokeStatus?: string;
  dockerComposeExport: GeneratedAppDockerComposeExportPayload;
  artifactManifest: GeneratedAppPublishArtifactManifest;
  manifest: GeneratedAppPublishArtifactManifest;
  artifactPaths: string[];
  logs: GeneratedAppPublishLogEntry[];
  previousPublishId?: string;
  rollbackCommand?: GeneratedAppPublishRollbackCommand;
  rollbackResult?: GeneratedAppPublishRollbackResult;
  createdByUserId: string;
  createdAt: string;
  completedAt?: string;
}

export interface GeneratedAppSourceFileRecord {
  path: string;
  content: string;
  contentType: string;
  size: number;
  sha256: string;
  role: "entrypoint" | "source" | "manifest" | "config" | "docs";
}

export interface GeneratedAppRuntimeArtifactRecord {
  entrypoint: string;
  files: GeneratedAppSourceFileRecord[];
  renderedAt: string;
}

export interface GeneratedAppCheckpointRecord {
  id: string;
  appId: string;
  workspaceId: string;
  label: string;
  draft: Record<string, unknown>;
  runtimeArtifact?: GeneratedAppRuntimeArtifactRecord;
  sourceFiles?: GeneratedAppSourceFileRecord[];
  previewUrl?: string;
  buildStatus?: string;
  smokeStatus?: string;
  source: "initial" | "iteration" | "rollback" | "branch";
  codegenSource?: "llm" | "template" | "llm-filetree";
  previousCheckpointId?: string;
  createdByUserId: string;
  createdAt: string;
}

export interface GeneratedAppRecord {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string;
  prompt: string;
  templateId: string;
  status: GeneratedAppStatus;
  draft: Record<string, unknown>;
  checkpointId: string;
  runtimeArtifact?: GeneratedAppRuntimeArtifactRecord;
  sourceFiles?: GeneratedAppSourceFileRecord[];
  previewUrl?: string;
  buildStatus?: string;
  smokeStatus?: string;
  codegenSource?: "llm" | "template" | "llm-filetree";
  checkpoints?: GeneratedAppCheckpointRecord[];
  previewSnapshots?: Record<string, unknown>[];
  publishHistory?: GeneratedAppPublishRecord[];
  currentPublishId?: string;
  publishStatus?: GeneratedAppPublishStatus;
  publishedUrl?: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export type ProviderKind = "openai" | "anthropic" | "minimax" | "azure_openai" | "ollama" | "gemini" | "custom";
export type ProviderStatus = "connected" | "missing_key" | "disabled";

export interface ProviderRecord {
  id: string;
  workspaceId: string;
  name: string;
  kind: ProviderKind;
  defaultModel: string;
  baseUrl?: string;
  apiKeyConfigured: boolean;
  status: ProviderStatus;
  createdAt: string;
  updatedAt: string;
}

export type AgentRunStatus = "queued" | "running" | "success" | "failed" | "canceled";
export type AgentRunStepStatus = "success" | "failed" | "skipped";

export interface AgentRunStep {
  id: string;
  title: string;
  status: AgentRunStepStatus;
  output: string;
  durationMs: number;
  startedAt: string;
}

export type AgentRunLogLevel = "info" | "warn" | "error";

export interface AgentRunLogEntry {
  at: string;
  level: AgentRunLogLevel;
  message: string;
}

export interface AgentRunToolCall {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  output?: unknown;
  error?: string;
  artifacts?: { path: string; bytes: number; kind: string }[];
  durationMs: number;
  startedAt: string;
  completedAt: string;
  status: "ok" | "error" | "timeout";
}

export interface AgentRunRecord {
  id: string;
  workspaceId: string;
  agentId?: string;
  title: string;
  status: AgentRunStatus;
  triggerKind?: AgentTriggerKind;
  transcript?: AgentRunStep[];
  startedAt?: string;
  completedAt?: string;
  inputs?: Record<string, string | number | boolean>;
  output?: string;
  error?: string;
  logs: AgentRunLogEntry[];
  toolCalls?: AgentRunToolCall[];
  modelUsed?: string;
  costUsd?: number;
  createdAt: string;
  updatedAt: string;
}

export type OnboardingStepKey =
  | "create_workspace_profile"
  | "define_requirements"
  | "define_plan"
  | "start_implementation"
  | "validate"
  | "confirm_release";

export type WorkspaceEnvVarScope = "all" | "build" | "runtime";

export interface WorkspaceEnvVarRecord {
  id: string;
  workspaceId: string;
  key: string;
  value: string;
  scope: WorkspaceEnvVarScope;
  secret: boolean;
  description?: string;
  createdByUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export type ApiKeyProvider = "anthropic" | "openai" | "openrouter" | "minimax" | "ollama" | "gemini";

export interface ApiKeyRecord {
  id: string;
  workspaceId: string;
  provider: ApiKeyProvider;
  label: string;
  encryptedValue: string;
  iv: string;
  authTag: string;
  lastUsedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderCallRecord {
  id: string;
  workspaceId: string;
  routeKey: string;
  provider: "anthropic" | "openai" | "openrouter" | "minimax" | "ollama" | "gemini" | "stub";
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  durationMs: number;
  status: "success" | "error" | "canceled";
  errorMessage?: string;
  startedAt: string;
  completedAt: string;
}

export type ShareTokenScope = "brief" | "plan" | "overview";

export interface ShareTokenRecord {
  id: string;
  workspaceId: string;
  token: string;
  scope: ShareTokenScope;
  createdByUserId: string;
  expiresAt?: string;
  revokedAt?: string;
  lastReadAt?: string;
  readCount: number;
  createdAt: string;
}

export type JobStatus = "queued" | "running" | "success" | "failed" | "canceled";

export interface JobRecord {
  id: string;
  workspaceId: string;
  type: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  scheduledAt: string;
  startedAt?: string;
  completedAt?: string;
  cron?: string;
  result?: unknown;
  error?: string;
  cancelRequested?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PacketAgentData {
  users: UserRecord[];
  sessions: SessionRecord[];
  rateLimits?: RateLimitRecord[];
  workspaces: WorkspaceRecord[];
  memberships: WorkspaceMemberRecord[];
  workspaceInvitations: WorkspaceInvitationRecord[];
  invitationEmailDeliveries: InvitationEmailDeliveryRecord[];
  workspaceBriefs: WorkspaceBriefCollection;
  workspaceBriefVersions: WorkspaceBriefVersionRecord[];
  requirements: RequirementRecord[];
  implementationPlanItems: ImplementationPlanItemRecord[];
  workflowConcerns: WorkflowConcernRecord[];
  validationEvidence: ValidationEvidenceRecord[];
  releaseConfirmations: ReleaseConfirmationCollection;
  onboardingStates: OnboardingStateRecord[];
  activities: ActivityRecord[];
  activationSignals: ActivationSignalRecord[];
  agents: AgentRecord[];
  generatedApps?: GeneratedAppRecord[];
  providers: ProviderRecord[];
  agentRuns: AgentRunRecord[];
  workspaceEnvVars: WorkspaceEnvVarRecord[];
  apiKeys: ApiKeyRecord[];
  providerCalls: ProviderCallRecord[];
  jobs: JobRecord[];
  jobMetricSnapshots: JobMetricSnapshotRecord[];
  alertEvents: AlertEventRecord[];
  shareTokens: ShareTokenRecord[];
  workerDefinitions: WorkerDefinition[];
  workerVersions: WorkerVersion[];
  workerDeployments: WorkerDeployment[];
  workerRuns: WorkerRun[];
  workerCheckpoints: WorkerCheckpoint[];
  workerEffectReceipts: WorkerEffectReceipt[];
  workerDeploymentRollouts: WorkerDeploymentRollout[];
  workerCommandReceipts: WorkerLifecycleCommandReceipt[];
  workerEvents: WorkerEvent[];
  workerActivationInboxes: WorkerActivationInboxRecord[];
  workerActivationPayloads: WorkerActivationPayloadRecord[];
  activationFacts: Record<string, WorkspaceActivationFacts>;
  activationMilestones: Record<string, ActivationMilestoneRecord[]>;
  activationReadModels: Record<string, ActivationStatusDto>;
}

export type PacketAgentStoreMode = "json" | "sqlite" | "managed" | "postgres";

export interface ResolvedPacketAgentStoreMode {
  mode: PacketAgentStoreMode;
  requestedStore: string;
  managedDatabaseUrlKeys: string[];
}

export interface ManagedPostgresStoreQueryResult<TRow extends Record<string, unknown> = Record<string, unknown>> {
  rows: TRow[];
  rowCount?: number | null;
}

export interface ManagedPostgresStoreQueryClient {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<ManagedPostgresStoreQueryResult<TRow>>;
  connect?(): Promise<ManagedPostgresStoreTransactionClient>;
  close?(): Promise<void> | void;
}

export interface ManagedPostgresStoreTransactionClient {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<ManagedPostgresStoreQueryResult<TRow>>;
  release?(): Promise<void> | void;
  close?(): Promise<void> | void;
}

export interface ManagedPostgresStoreClientConfig {
  url: string;
  envKey: string;
  resolution: ResolvedPacketAgentStoreMode;
}

export type ManagedPostgresStoreClientFactory =
  (config: ManagedPostgresStoreClientConfig) => ManagedPostgresStoreQueryClient | Promise<ManagedPostgresStoreQueryClient>;

export interface WorkspaceRecordCollectionMap {
  invitationEmailDeliveries: InvitationEmailDeliveryRecord;
  activities: ActivityRecord;
  jobs: JobRecord;
  agents: AgentRecord;
  agentRuns: AgentRunRecord;
  providerCalls: ProviderCallRecord;
  workspaceInvitations: WorkspaceInvitationRecord;
  shareTokens: ShareTokenRecord;
  requirements: RequirementRecord;
  implementationPlanItems: ImplementationPlanItemRecord;
  workflowConcerns: WorkflowConcernRecord;
  validationEvidence: ValidationEvidenceRecord;
  workspaceBriefVersions: WorkspaceBriefVersionRecord;
  providers: ProviderRecord;
  activationSignals: ActivationSignalRecord;
  workspaceEnvVars: WorkspaceEnvVarRecord;
}

export type WorkspaceRecordCollectionKey = keyof WorkspaceRecordCollectionMap;

export type WorkspaceRecordOrder =
  | "id"
  | "createdAtAsc"
  | "createdAtDesc"
  | "updatedAtDesc"
  | "occurredAtDesc"
  | "scheduledAtAsc"
  | "completedAtDesc"
  | "orderAsc"
  | "versionNumberDesc"
  | "nameAsc"
  | "keyAsc";

export interface ListWorkspaceRecordsOptions<TRecord> {
  orderBy?: WorkspaceRecordOrder;
  limit?: number;
  filter?: (record: TRecord) => boolean;
}

export interface ListJobsForWorkspaceIndexedOptions {
  status?: JobStatus;
  limit?: number;
}

export interface ListProviderCallsForWorkspaceIndexedOptions {
  since?: string;
  limit?: number;
}
