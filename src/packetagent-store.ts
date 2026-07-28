import { resolve } from "node:path";
import type { DurableActivationProductRecord } from "./activation/adapters";
import { buildSignalSnapshotFromFacts, buildSignalSnapshotFromProductRecords } from "./activation/adapters";
import { generateId, normalizeEmail, now } from "./auth-utils";
import {
  findAgentRunForWorkspaceViaRepository,
  listAgentRunsForAgentViaRepository,
  listAgentRunsForWorkspaceViaRepository,
} from "./agent-runs-read.js";
import { listActivitiesForWorkspaceViaRepository } from "./activities-read.js";
import { findJobViaRepository, listJobsForWorkspaceViaRepository } from "./jobs-read.js";
import { listInvitationEmailDeliveriesViaRepository } from "./invitation-email-deliveries-read.js";
import { listProviderCallsForWorkspaceViaRepository } from "./provider-calls-read.js";

import type {
  ActivationSignalKind,
  ActivationSignalOrigin,
  ActivationSignalRecord,
  ActivationSignalSource,
  ActivityRecord,
  AgentInputField,
  AgentInputFieldType,
  AgentPlaybookStep,
  AgentRecord,
  AgentRunLogEntry,
  AgentRunLogLevel,
  AgentRunRecord,
  AgentRunStatus,
  AgentRunStep,
  AgentRunStepStatus,
  AgentRunToolCall,
  AgentStatus,
  AgentTriggerKind,
  AlertEventRecord,
  ApiKeyProvider,
  ApiKeyRecord,
  GeneratedAppCheckpointRecord,
  GeneratedAppDockerComposeExportPayload,
  GeneratedAppPublishArtifactManifest,
  GeneratedAppPublishArtifactManifestEntry,
  GeneratedAppPublishLogEntry,
  GeneratedAppPublishLogLevel,
  GeneratedAppPublishRecord,
  GeneratedAppPublishRollbackCommand,
  GeneratedAppPublishRollbackResult,
  GeneratedAppPublishRollbackStatus,
  GeneratedAppPublishStatus,
  GeneratedAppPublishVisibility,
  GeneratedAppRecord,
  GeneratedAppRuntimeArtifactRecord,
  GeneratedAppSourceFileRecord,
  GeneratedAppStatus,
  ImplementationPlanItemRecord,
  ImplementationPlanItemStatus,
  InvitationEmailDeliveryMode,
  InvitationEmailDeliveryRecord,
  InvitationEmailDeliveryStatus,
  JobMetricSnapshotRecord,
  JobRecord,
  JobStatus,
  ListJobsForWorkspaceIndexedOptions,
  ListProviderCallsForWorkspaceIndexedOptions,
  ListWorkspaceRecordsOptions,
  ManagedPostgresStoreClientConfig,
  ManagedPostgresStoreClientFactory,
  ManagedPostgresStoreQueryClient,
  ManagedPostgresStoreQueryResult,
  ManagedPostgresStoreTransactionClient,
  OnboardingStateRecord,
  OnboardingStepKey,
  ProviderCallRecord,
  ProviderKind,
  ProviderRecord,
  ProviderStatus,
  RateLimitRecord,
  ReleaseConfirmationCollection,
  ReleaseConfirmationRecord,
  ReleaseConfirmationStatus,
  RequirementPriority,
  RequirementRecord,
  RequirementStatus,
  ResolvedPacketAgentStoreMode,
  SessionRecord,
  ShareTokenRecord,
  ShareTokenScope,
  PacketAgentData,
  PacketAgentStoreMode,
  UserRecord,
  ValidationEvidenceOutcome,
  ValidationEvidenceRecord,
  ValidationEvidenceType,
  WorkflowConcernKind,
  WorkflowConcernRecord,
  WorkflowConcernSeverity,
  WorkflowConcernStatus,
  WorkspaceBriefCollection,
  WorkspaceBriefRecord,
  WorkspaceBriefVersionRecord,
  WorkspaceEnvVarRecord,
  WorkspaceEnvVarScope,
  WorkspaceInvitationRecord,
  WorkspaceMemberRecord,
  WorkspaceRecord,
  WorkspaceRecordCollectionKey,
  WorkspaceRecordCollectionMap,
  WorkspaceRecordOrder,
  WorkspaceRole,
} from "./store/types.js";
import {
  cleanStoreEnvValue,
  MANAGED_DATABASE_URL_ENV_KEYS,
  ManagedDatabaseStoreBoundaryError,
  ManagedPostgresStoreConfigurationError,
  MANAGED_DATABASE_SYNC_ADAPTER_GAP_MESSAGE,
  resolvePacketAgentStoreMode,
} from "./store/mode.js";
import { clearStoreCacheState, getCacheBackendKey, getCachedStore, getMutateSqliteDepth, setCachedStore } from "./store/cache.js";
import { workspaceBriefEntries, releaseConfirmationEntries } from "./store/collections.js";
import { DATA_FILE, persistJsonStore, runSerializedJsonMutation } from "./store/json-io.js";
import { inferActivationSignalOrigin, normalizeActivationSignalRecord } from "./store/normalize.js";
import { seedStore } from "./store/seed.js";
import { DEFAULT_DB_FILE, openStoreDatabase } from "./store/sqlite-db.js";
import {
  upsertDedicatedActivationSignal,
  findDedicatedActivationSignalForUpsert,
  mergeActivationSignals,
  readDedicatedActivationSignalsForWorkspace,
} from "./store/dedicated-tables.js";
import {
  enqueueActivationSignalDualWrite,
  enqueueActivityDualWrite,
  enqueueAgentRunDualWrite,
  enqueueInvitationEmailDeliveryDualWrite,
} from "./store/dual-write.js";
import { loadStoreFromBackend } from "./store/runtime.js";
import type { AsyncStoreBackend, StoreBackend } from "./store/backends/types.js";
import { jsonStoreBackend, syncStoreAsyncBackend } from "./store/backends/json.js";
import {
  mutateSqliteStore,
  persistSqliteStoreRows,
  sqliteAsyncStoreBackend,
  sqliteIndexedRecord as sqliteIndexedRecordImpl,
  sqliteIndexedRecords as sqliteIndexedRecordsImpl,
  sqliteStoreBackend,
  sqliteWorkspaceRecords as sqliteWorkspaceRecordsImpl,
} from "./store/backends/sqlite.js";
import { managedDatabaseAsyncStoreBackend } from "./store/backends/managed-postgres.js";

export type {
  ActivationSignalKind,
  ActivationSignalOrigin,
  ActivationSignalRecord,
  ActivationSignalSource,
  ActivityRecord,
  AgentInputField,
  AgentInputFieldType,
  AgentPlaybookStep,
  AgentRecord,
  AgentRunLogEntry,
  AgentRunLogLevel,
  AgentRunRecord,
  AgentRunStatus,
  AgentRunStep,
  AgentRunStepStatus,
  AgentRunToolCall,
  AgentStatus,
  AgentTriggerKind,
  AlertEventRecord,
  ApiKeyProvider,
  ApiKeyRecord,
  GeneratedAppCheckpointRecord,
  GeneratedAppDockerComposeExportPayload,
  GeneratedAppPublishArtifactManifest,
  GeneratedAppPublishArtifactManifestEntry,
  GeneratedAppPublishLogEntry,
  GeneratedAppPublishLogLevel,
  GeneratedAppPublishRecord,
  GeneratedAppPublishRollbackCommand,
  GeneratedAppPublishRollbackResult,
  GeneratedAppPublishRollbackStatus,
  GeneratedAppPublishStatus,
  GeneratedAppPublishVisibility,
  GeneratedAppRecord,
  GeneratedAppRuntimeArtifactRecord,
  GeneratedAppSourceFileRecord,
  GeneratedAppStatus,
  ImplementationPlanItemRecord,
  ImplementationPlanItemStatus,
  InvitationEmailDeliveryMode,
  InvitationEmailDeliveryRecord,
  InvitationEmailDeliveryStatus,
  JobMetricSnapshotRecord,
  JobRecord,
  JobStatus,
  ListJobsForWorkspaceIndexedOptions,
  ListProviderCallsForWorkspaceIndexedOptions,
  ListWorkspaceRecordsOptions,
  ManagedPostgresStoreClientConfig,
  ManagedPostgresStoreClientFactory,
  ManagedPostgresStoreQueryClient,
  ManagedPostgresStoreQueryResult,
  ManagedPostgresStoreTransactionClient,
  OnboardingStateRecord,
  OnboardingStepKey,
  ProviderCallRecord,
  ProviderKind,
  ProviderRecord,
  ProviderStatus,
  RateLimitRecord,
  ReleaseConfirmationCollection,
  ReleaseConfirmationRecord,
  ReleaseConfirmationStatus,
  RequirementPriority,
  RequirementRecord,
  RequirementStatus,
  ResolvedPacketAgentStoreMode,
  SessionRecord,
  ShareTokenRecord,
  ShareTokenScope,
  PacketAgentData,
  PacketAgentStoreMode,
  UserRecord,
  ValidationEvidenceOutcome,
  ValidationEvidenceRecord,
  ValidationEvidenceType,
  WorkflowConcernKind,
  WorkflowConcernRecord,
  WorkflowConcernSeverity,
  WorkflowConcernStatus,
  WorkspaceBriefCollection,
  WorkspaceBriefRecord,
  WorkspaceBriefVersionRecord,
  WorkspaceEnvVarRecord,
  WorkspaceEnvVarScope,
  WorkspaceInvitationRecord,
  WorkspaceMemberRecord,
  WorkspaceRecord,
  WorkspaceRecordCollectionKey,
  WorkspaceRecordCollectionMap,
  WorkspaceRecordOrder,
  WorkspaceRole,
} from "./store/types.js";
export type { WorkerCredentialRecord } from "./workers/credential-types.js";
export {
  ManagedDatabaseStoreBoundaryError,
  ManagedPostgresStoreConfigurationError,
  MANAGED_DATABASE_SYNC_ADAPTER_GAP_MESSAGE,
  resolvePacketAgentStoreMode,
} from "./store/mode.js";
export { normalizeStore } from "./store/normalize.js";
export { createSeedStore } from "./store/seed.js";
export { loadSqliteAppData, persistSqliteAppData } from "./store/backends/sqlite.js";
export { setManagedPostgresStoreClientFactoryForTests } from "./store/backends/managed-postgres.js";

function assertSupportedSyncStoreMode(resolution: ResolvedPacketAgentStoreMode): void {
  if (resolution.mode === "managed" || resolution.mode === "postgres" || resolution.managedDatabaseUrlKeys.length > 0) {
    throw new ManagedDatabaseStoreBoundaryError(resolution);
  }
}

export function loadStore(): PacketAgentData {
  const backend = currentStoreBackend();
  return loadStoreFromBackend(backend);
}

export async function loadStoreAsync(): Promise<PacketAgentData> {
  const backend = currentAsyncStoreBackend();
  const cached = getCachedStore();
  if (cached && getCacheBackendKey() === backend.key) return cached;

  const loaded = await backend.load();
  setCachedStore(loaded, backend.key);
  return loaded;
}

export function mutateStore<T>(mutator: (data: PacketAgentData) => T): T {
  const resolution = resolvePacketAgentStoreMode();
  assertSupportedSyncStoreMode(resolution);

  if (resolution.mode === "sqlite") {
    return mutateSqliteStore(resolve(process.env.PACKETAGENT_DB_PATH ?? DEFAULT_DB_FILE), mutator);
  }

  const data = loadStore();
  const result = mutator(data);
  persistStore(data);
  return result;
}

export async function mutateStoreAsync<T>(mutator: (data: PacketAgentData) => T | Promise<T>): Promise<T> {
  return currentAsyncStoreBackend().mutate(mutator);
}

export interface RecordActivityOptions {
  position?: "start" | "end";
  dedupe?: boolean;
}

export function recordActivity(
  data: PacketAgentData,
  activity: ActivityRecord,
  options: RecordActivityOptions = {},
): ActivityRecord {
  if (options.dedupe) {
    const existing = data.activities.find((entry) => entry.id === activity.id);
    if (existing) return existing;
  }

  if (options.position === "end") {
    data.activities.push(activity);
  } else {
    data.activities.unshift(activity);
  }
  enqueueActivityDualWrite(activity);
  return activity;
}

export function persistStore(data: PacketAgentData): void {
  currentStoreBackend().persist(data);
}

function currentStoreBackend(): StoreBackend {
  const resolution = resolvePacketAgentStoreMode();
  assertSupportedSyncStoreMode(resolution);
  if (resolution.mode === "sqlite") return sqliteStoreBackend(resolve(process.env.PACKETAGENT_DB_PATH ?? DEFAULT_DB_FILE));
  return jsonStoreBackend();
}

function currentAsyncStoreBackend(): AsyncStoreBackend {
  const resolution = resolvePacketAgentStoreMode();
  if (resolution.mode === "managed" || resolution.mode === "postgres" || resolution.managedDatabaseUrlKeys.length > 0) {
    return managedDatabaseAsyncStoreBackend(resolution);
  }

  if (resolution.mode === "sqlite") return sqliteAsyncStoreBackend(resolve(process.env.PACKETAGENT_DB_PATH ?? DEFAULT_DB_FILE));
  return syncStoreAsyncBackend(jsonStoreBackend());
}

function sqliteIndexedRecord<T>(collection: Parameters<typeof sqliteIndexedRecordImpl>[1], whereSql: string, values: Parameters<typeof sqliteIndexedRecordImpl>[3]): T | null {
  if (process.env.PACKETAGENT_STORE !== "sqlite") return null;
  const dbPath = resolve(process.env.PACKETAGENT_DB_PATH ?? DEFAULT_DB_FILE);
  return sqliteIndexedRecordImpl<T>(dbPath, collection, whereSql, values);
}

function sqliteIndexedRecords<T>(collection: Parameters<typeof sqliteIndexedRecordsImpl>[1], whereSql: string, values: Parameters<typeof sqliteIndexedRecordsImpl>[3], orderSql = "app_records.id"): T[] | null {
  if (process.env.PACKETAGENT_STORE !== "sqlite") return null;
  const dbPath = resolve(process.env.PACKETAGENT_DB_PATH ?? DEFAULT_DB_FILE);
  return sqliteIndexedRecordsImpl<T>(dbPath, collection, whereSql, values, orderSql);
}

export function listWorkspaceRecordsIndexed<K extends WorkspaceRecordCollectionKey>(
  collection: K,
  workspaceId: string,
  options: ListWorkspaceRecordsOptions<WorkspaceRecordCollectionMap[K]> = {},
): WorkspaceRecordCollectionMap[K][] {
  const queryLimit = options.filter ? undefined : options.limit;
  const sqliteRecords = sqliteWorkspaceRecords(collection, workspaceId, options.orderBy ?? "id", queryLimit);
  const records = sqliteRecords ?? listWorkspaceRecordsFromStore(collection, workspaceId, options.orderBy ?? "id", queryLimit);
  const filtered = options.filter ? records.filter(options.filter) : records;
  return options.filter && options.limit && options.limit > 0 ? filtered.slice(0, options.limit) : filtered;
}

export async function listWorkspaceRecordsIndexedAsync<K extends WorkspaceRecordCollectionKey>(
  collection: K,
  workspaceId: string,
  options: ListWorkspaceRecordsOptions<WorkspaceRecordCollectionMap[K]> = {},
): Promise<WorkspaceRecordCollectionMap[K][]> {
  const queryLimit = options.filter ? undefined : options.limit;
  const sqliteRecords = shouldUseSqliteIndexedReads()
    ? sqliteWorkspaceRecords(collection, workspaceId, options.orderBy ?? "id", queryLimit)
    : null;
  const records = sqliteRecords ?? listWorkspaceRecordsFromData(
    await loadStoreAsync(),
    collection,
    workspaceId,
    options.orderBy ?? "id",
    queryLimit,
  );
  const filtered = options.filter ? records.filter(options.filter) : records;
  return options.filter && options.limit && options.limit > 0 ? filtered.slice(0, options.limit) : filtered;
}

function shouldUseSqliteIndexedReads(): boolean {
  const resolution = resolvePacketAgentStoreMode();
  return resolution.mode === "sqlite" && resolution.managedDatabaseUrlKeys.length === 0;
}

function sqliteWorkspaceRecords<K extends WorkspaceRecordCollectionKey>(
  collection: K,
  workspaceId: string,
  orderBy: WorkspaceRecordOrder,
  limit: number | undefined,
): WorkspaceRecordCollectionMap[K][] | null {
  if (process.env.PACKETAGENT_STORE !== "sqlite") return null;
  const dbPath = resolve(process.env.PACKETAGENT_DB_PATH ?? DEFAULT_DB_FILE);
  return sqliteWorkspaceRecordsImpl(dbPath, collection, workspaceId, orderBy, limit);
}

function listWorkspaceRecordsFromStore<K extends WorkspaceRecordCollectionKey>(
  collection: K,
  workspaceId: string,
  orderBy: WorkspaceRecordOrder,
  limit: number | undefined,
): WorkspaceRecordCollectionMap[K][] {
  return listWorkspaceRecordsFromData(loadStore(), collection, workspaceId, orderBy, limit);
}

function listWorkspaceRecordsFromData<K extends WorkspaceRecordCollectionKey>(
  data: PacketAgentData,
  collection: K,
  workspaceId: string,
  orderBy: WorkspaceRecordOrder,
  limit: number | undefined,
): WorkspaceRecordCollectionMap[K][] {
  const records = (data[collection] as WorkspaceRecordCollectionMap[K][])
    .filter((entry) => entry.workspaceId === workspaceId);
  const sorted = sortWorkspaceRecords(records, orderBy);
  return limit && limit > 0 ? sorted.slice(0, limit) : sorted;
}

function sortWorkspaceRecords<TRecord>(records: TRecord[], orderBy: WorkspaceRecordOrder): TRecord[] {
  const sorted = records.slice();
  sorted.sort((left, right) => compareWorkspaceRecords(left, right, orderBy));
  return sorted;
}

function compareWorkspaceRecords<TRecord>(left: TRecord, right: TRecord, orderBy: WorkspaceRecordOrder): number {
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  if (orderBy === "createdAtAsc") return compareStrings(field(leftRecord, "createdAt"), field(rightRecord, "createdAt")) || compareStrings(field(leftRecord, "id"), field(rightRecord, "id"));
  if (orderBy === "createdAtDesc") return compareStrings(field(rightRecord, "createdAt"), field(leftRecord, "createdAt")) || compareStrings(field(rightRecord, "id"), field(leftRecord, "id"));
  if (orderBy === "updatedAtDesc") return compareStrings(field(rightRecord, "updatedAt") || field(rightRecord, "createdAt"), field(leftRecord, "updatedAt") || field(leftRecord, "createdAt")) || compareStrings(field(rightRecord, "id"), field(leftRecord, "id"));
  if (orderBy === "occurredAtDesc") return compareStrings(field(rightRecord, "occurredAt"), field(leftRecord, "occurredAt")) || compareStrings(field(rightRecord, "id"), field(leftRecord, "id"));
  if (orderBy === "scheduledAtAsc") return compareStrings(field(leftRecord, "scheduledAt"), field(rightRecord, "scheduledAt")) || compareStrings(field(leftRecord, "id"), field(rightRecord, "id"));
  if (orderBy === "completedAtDesc") return compareStrings(field(rightRecord, "completedAt"), field(leftRecord, "completedAt")) || compareStrings(field(rightRecord, "id"), field(leftRecord, "id"));
  if (orderBy === "orderAsc") return compareNumbers(numberField(leftRecord, "order"), numberField(rightRecord, "order")) || compareStrings(field(leftRecord, "id"), field(rightRecord, "id"));
  if (orderBy === "versionNumberDesc") return compareNumbers(numberField(rightRecord, "versionNumber"), numberField(leftRecord, "versionNumber")) || compareStrings(field(rightRecord, "id"), field(leftRecord, "id"));
  if (orderBy === "nameAsc") return field(leftRecord, "name").localeCompare(field(rightRecord, "name"), undefined, { sensitivity: "base" }) || compareStrings(field(leftRecord, "id"), field(rightRecord, "id"));
  if (orderBy === "keyAsc") return field(leftRecord, "key").localeCompare(field(rightRecord, "key"), undefined, { sensitivity: "base" }) || compareStrings(field(leftRecord, "id"), field(rightRecord, "id"));
  return compareStrings(field(leftRecord, "id"), field(rightRecord, "id"));
}

function field(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" ? value : 0;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNumbers(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function listActivitiesForWorkspaceIndexed(workspaceId: string, limit?: number): ActivityRecord[] {
  return listActivitiesForWorkspaceViaRepository(workspaceId, limit);
}

export function listJobsForWorkspaceIndexed(workspaceId: string, opts: { status?: JobStatus; limit?: number } = {}): JobRecord[] {
  return listJobsForWorkspaceViaRepository(workspaceId, opts);
}

export function listAgentsForWorkspaceIndexed(workspaceId: string, includeArchived = false): AgentRecord[] {
  return listWorkspaceRecordsIndexed("agents", workspaceId, {
    orderBy: "updatedAtDesc",
    filter: includeArchived ? undefined : (entry) => entry.status !== "archived",
  });
}

export function listProvidersForWorkspaceIndexed(workspaceId: string): ProviderRecord[] {
  return listWorkspaceRecordsIndexed("providers", workspaceId, { orderBy: "nameAsc" });
}

export function listAgentRunsForWorkspaceIndexed(workspaceId: string, limit?: number): AgentRunRecord[] {
  return listAgentRunsForWorkspaceViaRepository(workspaceId, limit);
}

export function listProviderCallsForWorkspaceIndexed(workspaceId: string, opts: { since?: string; limit?: number } = {}): ProviderCallRecord[] {
  return listProviderCallsForWorkspaceViaRepository(workspaceId, opts);
}

export function listAgentRunsForAgentIndexed(workspaceId: string, agentId: string, limit?: number): AgentRunRecord[] {
  return listAgentRunsForAgentViaRepository(workspaceId, agentId, limit);
}

export function findUserByIdIndexed(userId: string): UserRecord | null {
  return sqliteIndexedRecord<UserRecord>("users", "app_record_search.id = ?", [userId])
    ?? loadStore().users.find((entry) => entry.id === userId) ?? null;
}

export function findUserByEmailIndexed(email: string): UserRecord | null {
  const normalized = normalizeEmail(email);
  return sqliteIndexedRecord<UserRecord>("users", "app_record_search.email = ?", [normalized])
    ?? loadStore().users.find((entry) => normalizeEmail(entry.email) === normalized) ?? null;
}

export function findSessionByIdIndexed(sessionId: string): SessionRecord | null {
  return sqliteIndexedRecord<SessionRecord>("sessions", "app_record_search.id = ?", [sessionId])
    ?? loadStore().sessions.find((entry) => entry.id === sessionId) ?? null;
}

export function findWorkspaceByIdIndexed(workspaceId: string): WorkspaceRecord | null {
  return sqliteIndexedRecord<WorkspaceRecord>("workspaces", "app_record_search.id = ?", [workspaceId])
    ?? loadStore().workspaces.find((entry) => entry.id === workspaceId) ?? null;
}

export function listSessionsForUserIndexed(userId: string): SessionRecord[] {
  return sqliteIndexedRecords<SessionRecord>("sessions", "app_record_search.user_id = ?", [userId])
    ?? loadStore().sessions.filter((entry) => entry.userId === userId);
}

export function findWorkspaceMembershipIndexed(workspaceId: string, userId: string): WorkspaceMemberRecord | null {
  return sqliteIndexedRecord<WorkspaceMemberRecord>("memberships", "app_record_search.workspace_id = ? and app_record_search.user_id = ?", [workspaceId, userId])
    ?? loadStore().memberships.find((entry) => entry.workspaceId === workspaceId && entry.userId === userId) ?? null;
}

export function listWorkspaceMembershipsIndexed(workspaceId: string): WorkspaceMemberRecord[] {
  return sqliteIndexedRecords<WorkspaceMemberRecord>("memberships", "app_record_search.workspace_id = ?", [workspaceId])
    ?? loadStore().memberships.filter((entry) => entry.workspaceId === workspaceId);
}

export function findWorkspaceInvitationByTokenIndexed(token: string): WorkspaceInvitationRecord | null {
  return sqliteIndexedRecord<WorkspaceInvitationRecord>("workspaceInvitations", "app_record_search.token = ?", [token])
    ?? loadStore().workspaceInvitations.find((entry) => entry.token === token) ?? null;
}

export function listWorkspaceInvitationsIndexed(workspaceId: string): WorkspaceInvitationRecord[] {
  return sqliteIndexedRecords<WorkspaceInvitationRecord>("workspaceInvitations", "app_record_search.workspace_id = ?", [workspaceId], "json_extract(app_records.payload, '$.createdAt') desc")
    ?? loadStore().workspaceInvitations
      .filter((entry) => entry.workspaceId === workspaceId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function listInvitationEmailDeliveriesIndexed(workspaceId: string, invitationId?: string): InvitationEmailDeliveryRecord[] {
  return listInvitationEmailDeliveriesViaRepository(workspaceId, invitationId);
}

export function findShareTokenByTokenIndexed(token: string): ShareTokenRecord | null {
  return sqliteIndexedRecord<ShareTokenRecord>("shareTokens", "app_record_search.token = ?", [token])
    ?? loadStore().shareTokens.find((entry) => entry.token === token) ?? null;
}

export function listShareTokensForWorkspaceIndexed(workspaceId: string): ShareTokenRecord[] {
  return sqliteIndexedRecords<ShareTokenRecord>("shareTokens", "app_record_search.workspace_id = ?", [workspaceId], "json_extract(app_records.payload, '$.createdAt') desc")
    ?? loadStore().shareTokens
      .filter((entry) => entry.workspaceId === workspaceId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function findWorkspaceBriefIndexed(workspaceId: string): WorkspaceBriefRecord | null {
  return sqliteIndexedRecord<WorkspaceBriefRecord>("workspaceBriefs", "app_record_search.workspace_id = ?", [workspaceId])
    ?? workspaceBriefEntries(loadStore().workspaceBriefs).find((entry) => entry.workspaceId === workspaceId) ?? null;
}

export function listWorkspaceBriefVersionsIndexed(workspaceId: string): WorkspaceBriefVersionRecord[] {
  return sqliteIndexedRecords<WorkspaceBriefVersionRecord>("workspaceBriefVersions", "app_record_search.workspace_id = ?", [workspaceId], "json_extract(app_records.payload, '$.versionNumber') desc")
    ?? loadStore().workspaceBriefVersions
      .filter((entry) => entry.workspaceId === workspaceId)
      .sort((left, right) => right.versionNumber - left.versionNumber);
}

export function findWorkspaceBriefVersionIndexed(workspaceId: string, versionId: string): WorkspaceBriefVersionRecord | null {
  return sqliteIndexedRecord<WorkspaceBriefVersionRecord>("workspaceBriefVersions", "app_record_search.workspace_id = ? and app_record_search.id = ?", [workspaceId, versionId])
    ?? loadStore().workspaceBriefVersions.find((entry) => entry.workspaceId === workspaceId && entry.id === versionId) ?? null;
}

export function listRequirementsForWorkspaceIndexed(workspaceId: string): RequirementRecord[] {
  return sqliteIndexedRecords<RequirementRecord>("requirements", "app_record_search.workspace_id = ?", [workspaceId])
    ?? loadStore().requirements.filter((entry) => entry.workspaceId === workspaceId);
}

export function findRequirementForWorkspaceIndexed(workspaceId: string, requirementId: string): RequirementRecord | null {
  return sqliteIndexedRecord<RequirementRecord>("requirements", "app_record_search.workspace_id = ? and app_record_search.id = ?", [workspaceId, requirementId])
    ?? loadStore().requirements.find((entry) => entry.workspaceId === workspaceId && entry.id === requirementId) ?? null;
}

export function listImplementationPlanItemsForWorkspaceIndexed(workspaceId: string): ImplementationPlanItemRecord[] {
  return sqliteIndexedRecords<ImplementationPlanItemRecord>("implementationPlanItems", "app_record_search.workspace_id = ?", [workspaceId], "json_extract(app_records.payload, '$.order'), app_records.id")
    ?? loadStore().implementationPlanItems
      .filter((entry) => entry.workspaceId === workspaceId)
      .sort((left, right) => left.order - right.order);
}

export function findImplementationPlanItemForWorkspaceIndexed(workspaceId: string, planItemId: string): ImplementationPlanItemRecord | null {
  return sqliteIndexedRecord<ImplementationPlanItemRecord>("implementationPlanItems", "app_record_search.workspace_id = ? and app_record_search.id = ?", [workspaceId, planItemId])
    ?? loadStore().implementationPlanItems.find((entry) => entry.workspaceId === workspaceId && entry.id === planItemId) ?? null;
}

export function listWorkflowConcernsForWorkspaceIndexed(workspaceId: string, kind?: WorkflowConcernKind): WorkflowConcernRecord[] {
  return sqliteIndexedRecords<WorkflowConcernRecord>(
    "workflowConcerns",
    `app_record_search.workspace_id = ?${kind ? " and json_extract(app_records.payload, '$.kind') = ?" : ""}`,
    kind ? [workspaceId, kind] : [workspaceId],
  ) ?? loadStore().workflowConcerns.filter((entry) => entry.workspaceId === workspaceId && (!kind || entry.kind === kind));
}

export function findWorkflowConcernForWorkspaceIndexed(workspaceId: string, concernId: string, kind?: WorkflowConcernKind): WorkflowConcernRecord | null {
  return sqliteIndexedRecord<WorkflowConcernRecord>(
    "workflowConcerns",
    `app_record_search.workspace_id = ? and app_record_search.id = ?${kind ? " and json_extract(app_records.payload, '$.kind') = ?" : ""}`,
    kind ? [workspaceId, concernId, kind] : [workspaceId, concernId],
  ) ?? loadStore().workflowConcerns.find((entry) => entry.workspaceId === workspaceId && entry.id === concernId && (!kind || entry.kind === kind)) ?? null;
}

export function listValidationEvidenceForWorkspaceIndexed(workspaceId: string): ValidationEvidenceRecord[] {
  return sqliteIndexedRecords<ValidationEvidenceRecord>("validationEvidence", "app_record_search.workspace_id = ?", [workspaceId])
    ?? loadStore().validationEvidence.filter((entry) => entry.workspaceId === workspaceId);
}

export function findValidationEvidenceForWorkspaceIndexed(workspaceId: string, evidenceId: string): ValidationEvidenceRecord | null {
  return sqliteIndexedRecord<ValidationEvidenceRecord>("validationEvidence", "app_record_search.workspace_id = ? and app_record_search.id = ?", [workspaceId, evidenceId])
    ?? loadStore().validationEvidence.find((entry) => entry.workspaceId === workspaceId && entry.id === evidenceId) ?? null;
}

export function listReleaseConfirmationsForWorkspaceIndexed(workspaceId: string): ReleaseConfirmationRecord[] {
  return sqliteIndexedRecords<ReleaseConfirmationRecord>("releaseConfirmations", "app_record_search.workspace_id = ?", [workspaceId])
    ?? releaseConfirmationEntries(loadStore().releaseConfirmations).filter((entry) => entry.workspaceId === workspaceId);
}

export function findReleaseConfirmationForWorkspaceIndexed(workspaceId: string, releaseId: string): ReleaseConfirmationRecord | null {
  return sqliteIndexedRecord<ReleaseConfirmationRecord>("releaseConfirmations", "app_record_search.workspace_id = ? and (json_extract(app_records.payload, '$.id') = ? or app_record_search.workspace_id = ?)", [workspaceId, releaseId, releaseId])
    ?? releaseConfirmationEntries(loadStore().releaseConfirmations).find((entry) => entry.workspaceId === workspaceId && (entry.id === releaseId || entry.workspaceId === releaseId)) ?? null;
}

export function findAgentForWorkspaceIndexed(workspaceId: string, agentId: string): AgentRecord | null {
  return sqliteIndexedRecord<AgentRecord>("agents", "app_record_search.workspace_id = ? and app_record_search.id = ?", [workspaceId, agentId])
    ?? loadStore().agents.find((entry) => entry.workspaceId === workspaceId && entry.id === agentId) ?? null;
}

export function findAgentRunForWorkspaceIndexed(workspaceId: string, runId: string): AgentRunRecord | null {
  return findAgentRunForWorkspaceViaRepository(workspaceId, runId);
}

export function findJobIndexed(jobId: string): JobRecord | null {
  return findJobViaRepository(jobId);
}

export async function listActivitiesForWorkspaceIndexedAsync(workspaceId: string, limit?: number): Promise<ActivityRecord[]> {
  return listWorkspaceRecordsIndexedAsync("activities", workspaceId, { orderBy: "occurredAtDesc", limit });
}

export async function listJobsForWorkspaceIndexedAsync(
  workspaceId: string,
  opts: ListJobsForWorkspaceIndexedOptions = {},
): Promise<JobRecord[]> {
  return listWorkspaceRecordsIndexedAsync("jobs", workspaceId, {
    orderBy: "createdAtDesc",
    limit: opts.limit,
    filter: opts.status ? (entry) => entry.status === opts.status : undefined,
  });
}

export async function listAgentsForWorkspaceIndexedAsync(workspaceId: string, includeArchived = false): Promise<AgentRecord[]> {
  return listWorkspaceRecordsIndexedAsync("agents", workspaceId, {
    orderBy: "updatedAtDesc",
    filter: includeArchived ? undefined : (entry) => entry.status !== "archived",
  });
}

export async function listProvidersForWorkspaceIndexedAsync(workspaceId: string): Promise<ProviderRecord[]> {
  return listWorkspaceRecordsIndexedAsync("providers", workspaceId, { orderBy: "nameAsc" });
}

export async function listAgentRunsForWorkspaceIndexedAsync(workspaceId: string, limit?: number): Promise<AgentRunRecord[]> {
  return listWorkspaceRecordsIndexedAsync("agentRuns", workspaceId, { orderBy: "createdAtDesc", limit });
}

export async function listProviderCallsForWorkspaceIndexedAsync(
  workspaceId: string,
  opts: ListProviderCallsForWorkspaceIndexedOptions = {},
): Promise<ProviderCallRecord[]> {
  return listWorkspaceRecordsIndexedAsync("providerCalls", workspaceId, {
    orderBy: "completedAtDesc",
    limit: opts.limit,
    filter: opts.since
      ? (entry) => Date.parse(entry.completedAt) >= Date.parse(opts.since as string)
      : undefined,
  });
}

export async function listAgentRunsForAgentIndexedAsync(
  workspaceId: string,
  agentId: string,
  limit?: number,
): Promise<AgentRunRecord[]> {
  return listWorkspaceRecordsIndexedAsync("agentRuns", workspaceId, {
    orderBy: "createdAtDesc",
    limit,
    filter: (entry) => entry.agentId === agentId,
  });
}

export async function findUserByIdIndexedAsync(userId: string): Promise<UserRecord | null> {
  return shouldUseSqliteIndexedReads()
    ? sqliteIndexedRecord<UserRecord>("users", "app_record_search.id = ?", [userId])
    : (await loadStoreAsync()).users.find((entry) => entry.id === userId) ?? null;
}

export async function findUserByEmailIndexedAsync(email: string): Promise<UserRecord | null> {
  const normalized = normalizeEmail(email);
  return shouldUseSqliteIndexedReads()
    ? sqliteIndexedRecord<UserRecord>("users", "app_record_search.email = ?", [normalized])
    : (await loadStoreAsync()).users.find((entry) => normalizeEmail(entry.email) === normalized) ?? null;
}

export async function findSessionByIdIndexedAsync(sessionId: string): Promise<SessionRecord | null> {
  return shouldUseSqliteIndexedReads()
    ? sqliteIndexedRecord<SessionRecord>("sessions", "app_record_search.id = ?", [sessionId])
    : (await loadStoreAsync()).sessions.find((entry) => entry.id === sessionId) ?? null;
}

export async function findWorkspaceByIdIndexedAsync(workspaceId: string): Promise<WorkspaceRecord | null> {
  return shouldUseSqliteIndexedReads()
    ? sqliteIndexedRecord<WorkspaceRecord>("workspaces", "app_record_search.id = ?", [workspaceId])
    : (await loadStoreAsync()).workspaces.find((entry) => entry.id === workspaceId) ?? null;
}

export async function listSessionsForUserIndexedAsync(userId: string): Promise<SessionRecord[]> {
  return shouldUseSqliteIndexedReads()
    ? sqliteIndexedRecords<SessionRecord>("sessions", "app_record_search.user_id = ?", [userId]) ?? []
    : (await loadStoreAsync()).sessions.filter((entry) => entry.userId === userId);
}

export async function findWorkspaceMembershipIndexedAsync(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceMemberRecord | null> {
  return shouldUseSqliteIndexedReads()
    ? sqliteIndexedRecord<WorkspaceMemberRecord>(
      "memberships",
      "app_record_search.workspace_id = ? and app_record_search.user_id = ?",
      [workspaceId, userId],
    )
    : (await loadStoreAsync()).memberships.find((entry) => entry.workspaceId === workspaceId && entry.userId === userId) ?? null;
}

export async function listWorkspaceMembershipsIndexedAsync(workspaceId: string): Promise<WorkspaceMemberRecord[]> {
  return shouldUseSqliteIndexedReads()
    ? sqliteIndexedRecords<WorkspaceMemberRecord>("memberships", "app_record_search.workspace_id = ?", [workspaceId]) ?? []
    : (await loadStoreAsync()).memberships.filter((entry) => entry.workspaceId === workspaceId);
}

export async function findWorkspaceInvitationByTokenIndexedAsync(token: string): Promise<WorkspaceInvitationRecord | null> {
  return shouldUseSqliteIndexedReads()
    ? sqliteIndexedRecord<WorkspaceInvitationRecord>("workspaceInvitations", "app_record_search.token = ?", [token])
    : (await loadStoreAsync()).workspaceInvitations.find((entry) => entry.token === token) ?? null;
}

export async function listWorkspaceInvitationsIndexedAsync(workspaceId: string): Promise<WorkspaceInvitationRecord[]> {
  return listWorkspaceRecordsIndexedAsync("workspaceInvitations", workspaceId, { orderBy: "createdAtDesc" });
}

export async function listInvitationEmailDeliveriesIndexedAsync(
  workspaceId: string,
  invitationId?: string,
): Promise<InvitationEmailDeliveryRecord[]> {
  return listWorkspaceRecordsIndexedAsync("invitationEmailDeliveries", workspaceId, {
    orderBy: "createdAtDesc",
    filter: invitationId ? (entry) => entry.invitationId === invitationId : undefined,
  });
}

export async function findShareTokenByTokenIndexedAsync(token: string): Promise<ShareTokenRecord | null> {
  return shouldUseSqliteIndexedReads()
    ? sqliteIndexedRecord<ShareTokenRecord>("shareTokens", "app_record_search.token = ?", [token])
    : (await loadStoreAsync()).shareTokens.find((entry) => entry.token === token) ?? null;
}

export async function listShareTokensForWorkspaceIndexedAsync(workspaceId: string): Promise<ShareTokenRecord[]> {
  return listWorkspaceRecordsIndexedAsync("shareTokens", workspaceId, { orderBy: "createdAtDesc" });
}

export async function findWorkspaceBriefIndexedAsync(workspaceId: string): Promise<WorkspaceBriefRecord | null> {
  return shouldUseSqliteIndexedReads()
    ? sqliteIndexedRecord<WorkspaceBriefRecord>("workspaceBriefs", "app_record_search.workspace_id = ?", [workspaceId])
    : findWorkspaceBrief(await loadStoreAsync(), workspaceId);
}

export async function listWorkspaceBriefVersionsIndexedAsync(workspaceId: string): Promise<WorkspaceBriefVersionRecord[]> {
  return listWorkspaceRecordsIndexedAsync("workspaceBriefVersions", workspaceId, { orderBy: "versionNumberDesc" });
}

export async function findWorkspaceBriefVersionIndexedAsync(
  workspaceId: string,
  versionId: string,
): Promise<WorkspaceBriefVersionRecord | null> {
  return shouldUseSqliteIndexedReads()
    ? sqliteIndexedRecord<WorkspaceBriefVersionRecord>(
      "workspaceBriefVersions",
      "app_record_search.workspace_id = ? and app_record_search.id = ?",
      [workspaceId, versionId],
    )
    : findWorkspaceBriefVersion(await loadStoreAsync(), workspaceId, versionId);
}

export async function listRequirementsForWorkspaceIndexedAsync(workspaceId: string): Promise<RequirementRecord[]> {
  return listWorkspaceRecordsIndexedAsync("requirements", workspaceId);
}

export async function findRequirementForWorkspaceIndexedAsync(
  workspaceId: string,
  requirementId: string,
): Promise<RequirementRecord | null> {
  return shouldUseSqliteIndexedReads()
    ? sqliteIndexedRecord<RequirementRecord>(
      "requirements",
      "app_record_search.workspace_id = ? and app_record_search.id = ?",
      [workspaceId, requirementId],
    )
    : (await loadStoreAsync()).requirements.find((entry) => entry.workspaceId === workspaceId && entry.id === requirementId) ?? null;
}

export async function listImplementationPlanItemsForWorkspaceIndexedAsync(
  workspaceId: string,
): Promise<ImplementationPlanItemRecord[]> {
  return listWorkspaceRecordsIndexedAsync("implementationPlanItems", workspaceId, { orderBy: "orderAsc" });
}

export async function findImplementationPlanItemForWorkspaceIndexedAsync(
  workspaceId: string,
  planItemId: string,
): Promise<ImplementationPlanItemRecord | null> {
  return shouldUseSqliteIndexedReads()
    ? sqliteIndexedRecord<ImplementationPlanItemRecord>(
      "implementationPlanItems",
      "app_record_search.workspace_id = ? and app_record_search.id = ?",
      [workspaceId, planItemId],
    )
    : (await loadStoreAsync()).implementationPlanItems.find(
      (entry) => entry.workspaceId === workspaceId && entry.id === planItemId,
    ) ?? null;
}

export async function listWorkflowConcernsForWorkspaceIndexedAsync(
  workspaceId: string,
  kind?: WorkflowConcernKind,
): Promise<WorkflowConcernRecord[]> {
  return listWorkspaceRecordsIndexedAsync("workflowConcerns", workspaceId, {
    filter: kind ? (entry) => entry.kind === kind : undefined,
  });
}

export async function findWorkflowConcernForWorkspaceIndexedAsync(
  workspaceId: string,
  concernId: string,
  kind?: WorkflowConcernKind,
): Promise<WorkflowConcernRecord | null> {
  return shouldUseSqliteIndexedReads()
    ? sqliteIndexedRecord<WorkflowConcernRecord>(
      "workflowConcerns",
      `app_record_search.workspace_id = ? and app_record_search.id = ?${kind ? " and json_extract(app_records.payload, '$.kind') = ?" : ""}`,
      kind ? [workspaceId, concernId, kind] : [workspaceId, concernId],
    )
    : (await loadStoreAsync()).workflowConcerns.find(
      (entry) => entry.workspaceId === workspaceId && entry.id === concernId && (!kind || entry.kind === kind),
    ) ?? null;
}

export async function listValidationEvidenceForWorkspaceIndexedAsync(workspaceId: string): Promise<ValidationEvidenceRecord[]> {
  return listWorkspaceRecordsIndexedAsync("validationEvidence", workspaceId);
}

export async function findValidationEvidenceForWorkspaceIndexedAsync(
  workspaceId: string,
  evidenceId: string,
): Promise<ValidationEvidenceRecord | null> {
  return shouldUseSqliteIndexedReads()
    ? sqliteIndexedRecord<ValidationEvidenceRecord>(
      "validationEvidence",
      "app_record_search.workspace_id = ? and app_record_search.id = ?",
      [workspaceId, evidenceId],
    )
    : (await loadStoreAsync()).validationEvidence.find(
      (entry) => entry.workspaceId === workspaceId && entry.id === evidenceId,
    ) ?? null;
}

export async function listReleaseConfirmationsForWorkspaceIndexedAsync(
  workspaceId: string,
): Promise<ReleaseConfirmationRecord[]> {
  return shouldUseSqliteIndexedReads()
    ? sqliteIndexedRecords<ReleaseConfirmationRecord>("releaseConfirmations", "app_record_search.workspace_id = ?", [workspaceId]) ?? []
    : listReleaseConfirmationsForWorkspace(await loadStoreAsync(), workspaceId);
}

export async function findReleaseConfirmationForWorkspaceIndexedAsync(
  workspaceId: string,
  releaseId: string,
): Promise<ReleaseConfirmationRecord | null> {
  return shouldUseSqliteIndexedReads()
    ? sqliteIndexedRecord<ReleaseConfirmationRecord>(
      "releaseConfirmations",
      "app_record_search.workspace_id = ? and (json_extract(app_records.payload, '$.id') = ? or app_record_search.workspace_id = ?)",
      [workspaceId, releaseId, releaseId],
    )
    : listReleaseConfirmationsForWorkspace(await loadStoreAsync(), workspaceId)
      .find((entry) => entry.id === releaseId || entry.workspaceId === releaseId) ?? null;
}

export async function findAgentForWorkspaceIndexedAsync(workspaceId: string, agentId: string): Promise<AgentRecord | null> {
  return shouldUseSqliteIndexedReads()
    ? sqliteIndexedRecord<AgentRecord>("agents", "app_record_search.workspace_id = ? and app_record_search.id = ?", [workspaceId, agentId])
    : (await loadStoreAsync()).agents.find((entry) => entry.workspaceId === workspaceId && entry.id === agentId) ?? null;
}

export async function findAgentRunForWorkspaceIndexedAsync(
  workspaceId: string,
  runId: string,
): Promise<AgentRunRecord | null> {
  return shouldUseSqliteIndexedReads()
    ? findAgentRunForWorkspaceIndexed(workspaceId, runId)
    : (await loadStoreAsync()).agentRuns.find((entry) => entry.workspaceId === workspaceId && entry.id === runId) ?? null;
}

export async function findJobIndexedAsync(jobId: string): Promise<JobRecord | null> {
  return shouldUseSqliteIndexedReads()
    ? findJobIndexed(jobId)
    : (await loadStoreAsync()).jobs.find((entry) => entry.id === jobId) ?? null;
}

export function resetLocalStore(): PacketAgentData {
  const backend = currentStoreBackend();
  const reset = backend.reset();
  setCachedStore(reset, backend.key);
  return reset;
}

export function resetStoreForTests(): PacketAgentData {
  return resetLocalStore();
}

export function clearStoreCacheForTests(): void {
  clearStoreCache();
}

export interface RateLimitUpsertInput {
  bucketId: string;
  maxAttempts: number;
  windowMs: number;
  timestamp: number;
  maxBuckets: number;
}

export function upsertRateLimit(data: PacketAgentData, input: RateLimitUpsertInput): number | null {
  const updatedAt = new Date(input.timestamp).toISOString();
  const resetAtTimestamp = input.timestamp + input.windowMs;
  data.rateLimits = (data.rateLimits ?? []).filter((entry) => new Date(entry.resetAt).getTime() > input.timestamp);

  const bucket = data.rateLimits.find((entry) => entry.id === input.bucketId);
  if (!bucket) {
    data.rateLimits.push({
      id: input.bucketId,
      count: 1,
      resetAt: new Date(resetAtTimestamp).toISOString(),
      updatedAt,
    });
    pruneRateLimitBuckets(data, input.maxBuckets);
    return null;
  }

  bucket.count += 1;
  bucket.updatedAt = updatedAt;
  pruneRateLimitBuckets(data, input.maxBuckets);
  return bucket.count > input.maxAttempts ? new Date(bucket.resetAt).getTime() : null;
}

export interface RateLimitRepository {
  upsert(input: RateLimitUpsertInput): number | null;
}

export function rateLimitRepository(): RateLimitRepository {
  if (process.env.PACKETAGENT_STORE === "sqlite") return sqliteRateLimitRepository(resolve(process.env.PACKETAGENT_DB_PATH ?? DEFAULT_DB_FILE));
  return jsonRateLimitRepository();
}

function jsonRateLimitRepository(): RateLimitRepository {
  return {
    upsert(input) {
      return mutateStore((data) => upsertRateLimit(data, input));
    },
  };
}

function sqliteRateLimitRepository(dbPath: string): RateLimitRepository {
  return {
    upsert(input) {
      const db = openStoreDatabase(dbPath);
      const updatedAt = new Date(input.timestamp).toISOString();
      const resetAt = new Date(input.timestamp + input.windowMs).toISOString();
      try {
        db.exec("begin immediate");
        try {
          const appRecords = db.prepare("select count(*) as count from app_records").get() as { count: number };
          if (appRecords.count === 0) persistSqliteStoreRows(db, seedStore());
          db.prepare("delete from rate_limit_buckets where reset_at <= ?").run(updatedAt);
          const bucket = db.prepare("select count, reset_at from rate_limit_buckets where id = ?").get(input.bucketId) as { count: number; reset_at: string } | undefined;
          const count = bucket ? bucket.count + 1 : 1;
          db.prepare(`
            insert into rate_limit_buckets (id, count, reset_at, updated_at)
            values (?, ?, ?, ?)
            on conflict(id) do update set
              count = excluded.count,
              reset_at = excluded.reset_at,
              updated_at = excluded.updated_at
          `).run(input.bucketId, count, bucket?.reset_at ?? resetAt, updatedAt);
          db.prepare(`
            delete from rate_limit_buckets
            where id not in (
              select id from rate_limit_buckets order by updated_at desc limit ?
            )
          `).run(Math.max(1, Math.floor(input.maxBuckets)));
          db.exec("commit");
          clearStoreCache();
          return count > input.maxAttempts ? new Date(bucket?.reset_at ?? resetAt).getTime() : null;
        } catch (error) {
          db.exec("rollback");
          throw error;
        }
      } finally {
        db.close();
      }
    },
  };
}

function pruneRateLimitBuckets(data: PacketAgentData, maxBuckets: number) {
  const limit = Math.max(1, Math.floor(maxBuckets));
  if (!data.rateLimits || data.rateLimits.length <= limit) return;
  data.rateLimits = [...data.rateLimits]
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
    .slice(0, limit);
}

export function clearStoreCache(): void {
  clearStoreCacheState();
}

export function defaultWorkspaceIdForUser(data: PacketAgentData, userId: string): string | null {
  return data.memberships.find((entry) => entry.userId === userId)?.workspaceId ?? null;
}

export function findWorkspaceMembership(data: PacketAgentData, workspaceId: string, userId: string): WorkspaceMemberRecord | null {
  return data.memberships.find((entry) => entry.workspaceId === workspaceId && entry.userId === userId) ?? null;
}

export function upsertWorkspaceMembership(data: PacketAgentData, input: WorkspaceMemberRecord): WorkspaceMemberRecord {
  const existing = findWorkspaceMembership(data, input.workspaceId, input.userId);
  if (existing) {
    existing.role = input.role;
    existing.joinedAt = input.joinedAt;
    return existing;
  }

  data.memberships.push(input);
  return input;
}

export function listWorkspaceInvitations(data: PacketAgentData, workspaceId: string): WorkspaceInvitationRecord[] {
  return data.workspaceInvitations
    .filter((entry) => entry.workspaceId === workspaceId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function findWorkspaceInvitationByToken(data: PacketAgentData, token: string): WorkspaceInvitationRecord | null {
  return data.workspaceInvitations.find((entry) => entry.token === token) ?? null;
}

export function upsertWorkspaceInvitation(
  data: PacketAgentData,
  input: WorkspaceInvitationRecord,
): WorkspaceInvitationRecord {
  const existing = data.workspaceInvitations.find((entry) => entry.id === input.id);
  if (existing) {
    Object.assign(existing, input);
    return existing;
  }

  data.workspaceInvitations.push(input);
  return input;
}

export type CreateInvitationEmailDeliveryInput = Omit<InvitationEmailDeliveryRecord, "id" | "createdAt" | "status"> & {
  id?: string;
  createdAt?: string;
  status?: InvitationEmailDeliveryStatus;
};

export function createInvitationEmailDelivery(
  data: PacketAgentData,
  input: CreateInvitationEmailDeliveryInput,
  timestamp = now(),
): InvitationEmailDeliveryRecord {
  const delivery: InvitationEmailDeliveryRecord = {
    id: input.id ?? generateId(),
    workspaceId: input.workspaceId,
    invitationId: input.invitationId,
    recipientEmail: normalizeEmail(input.recipientEmail),
    subject: input.subject,
    status: input.status ?? "pending",
    provider: input.provider,
    mode: input.mode,
    createdAt: input.createdAt ?? timestamp,
    sentAt: input.sentAt,
    error: input.error,
  };

  data.invitationEmailDeliveries.push(delivery);
  enqueueInvitationEmailDeliveryDualWrite(delivery);
  return delivery;
}

export function listInvitationEmailDeliveries(data: PacketAgentData, workspaceId: string, invitationId?: string): InvitationEmailDeliveryRecord[] {
  return data.invitationEmailDeliveries
    .filter((entry) => entry.workspaceId === workspaceId && (!invitationId || entry.invitationId === invitationId))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
}

export function findInvitationEmailDelivery(data: PacketAgentData, deliveryId: string): InvitationEmailDeliveryRecord | null {
  return data.invitationEmailDeliveries.find((entry) => entry.id === deliveryId) ?? null;
}

export function markInvitationEmailDeliverySent(data: PacketAgentData, deliveryId: string, timestamp = now()): InvitationEmailDeliveryRecord | null {
  const delivery = findInvitationEmailDelivery(data, deliveryId);
  if (!delivery) return null;
  delivery.status = "sent";
  delivery.sentAt = timestamp;
  delete delivery.error;
  enqueueInvitationEmailDeliveryDualWrite(delivery);
  return delivery;
}

export function markInvitationEmailDeliverySkipped(data: PacketAgentData, deliveryId: string, reason?: string): InvitationEmailDeliveryRecord | null {
  const delivery = findInvitationEmailDelivery(data, deliveryId);
  if (!delivery) return null;
  delivery.status = "skipped";
  delete delivery.sentAt;
  delivery.error = reason;
  enqueueInvitationEmailDeliveryDualWrite(delivery);
  return delivery;
}

export function markInvitationEmailDeliveryFailed(data: PacketAgentData, deliveryId: string, error: string): InvitationEmailDeliveryRecord | null {
  const delivery = findInvitationEmailDelivery(data, deliveryId);
  if (!delivery) return null;
  delivery.status = "failed";
  delete delivery.sentAt;
  delivery.error = error;
  enqueueInvitationEmailDeliveryDualWrite(delivery);
  return delivery;
}

export interface RecordInvitationEmailProviderStatusInput {
  deliveryId: string;
  providerStatus: string;
  providerDeliveryId?: string;
  providerError?: string;
  occurredAt: string;
}

export function recordInvitationEmailProviderStatus(
  data: PacketAgentData,
  input: RecordInvitationEmailProviderStatusInput,
): InvitationEmailDeliveryRecord | null {
  const delivery = findInvitationEmailDelivery(data, input.deliveryId);
  if (!delivery) return null;
  delivery.providerStatus = input.providerStatus;
  delivery.providerStatusAt = input.occurredAt;
  if (input.providerDeliveryId !== undefined) {
    delivery.providerDeliveryId = input.providerDeliveryId;
  } else {
    delete delivery.providerDeliveryId;
  }
  if (input.providerError !== undefined) {
    delivery.providerError = input.providerError;
  } else {
    delete delivery.providerError;
  }
  enqueueInvitationEmailDeliveryDualWrite(delivery);
  return delivery;
}

export type WorkspaceBriefUpsertInput = Omit<WorkspaceBriefRecord, "createdAt" | "updatedAt"> &
  Partial<Pick<WorkspaceBriefRecord, "createdAt" | "updatedAt">>;

export function findWorkspaceBrief(data: PacketAgentData, workspaceId: string): WorkspaceBriefRecord | null {
  return workspaceBriefEntries(data.workspaceBriefs).find((entry) => entry.workspaceId === workspaceId) ?? null;
}

export function listWorkspaceBriefVersions(data: PacketAgentData, workspaceId: string): WorkspaceBriefVersionRecord[] {
  return data.workspaceBriefVersions
    .filter((entry) => entry.workspaceId === workspaceId)
    .sort((left, right) => right.versionNumber - left.versionNumber);
}

export function findWorkspaceBriefVersion(
  data: PacketAgentData,
  workspaceId: string,
  versionId: string,
): WorkspaceBriefVersionRecord | null {
  return data.workspaceBriefVersions.find((entry) => entry.workspaceId === workspaceId && entry.id === versionId) ?? null;
}

export function appendWorkspaceBriefVersion(
  data: PacketAgentData,
  input: Omit<WorkspaceBriefVersionRecord, "id" | "versionNumber" | "createdAt"> & {
    id?: string;
    createdAt?: string;
  },
  timestamp = now(),
): WorkspaceBriefVersionRecord {
  const versionNumber = listWorkspaceBriefVersions(data, input.workspaceId)[0]?.versionNumber ?? 0;
  const next: WorkspaceBriefVersionRecord = {
    id: input.id ?? generateId(),
    versionNumber: versionNumber + 1,
    workspaceId: input.workspaceId,
    summary: input.summary,
    goals: input.goals,
    audience: input.audience,
    constraints: input.constraints,
    problemStatement: input.problemStatement,
    targetCustomers: input.targetCustomers,
    desiredOutcome: input.desiredOutcome,
    successMetrics: input.successMetrics,
    source: input.source,
    sourceLabel: input.sourceLabel,
    createdByUserId: input.createdByUserId,
    createdByDisplayName: input.createdByDisplayName,
    createdAt: input.createdAt ?? timestamp,
  };
  data.workspaceBriefVersions.push(next);
  return next;
}

export function upsertWorkspaceBrief(
  data: PacketAgentData,
  input: WorkspaceBriefUpsertInput,
  timestamp = now(),
): WorkspaceBriefRecord {
  const existing = findWorkspaceBrief(data, input.workspaceId);
  if (existing) {
    Object.assign(existing, input, { updatedAt: input.updatedAt ?? timestamp });
    return existing;
  }

  const next: WorkspaceBriefRecord = {
    ...input,
    createdAt: input.createdAt ?? timestamp,
    updatedAt: input.updatedAt ?? timestamp,
  };
  if (Array.isArray(data.workspaceBriefs)) {
    data.workspaceBriefs.push(next);
  } else {
    data.workspaceBriefs[next.workspaceId] = next;
  }
  return next;
}

export type RequirementUpsertInput = Omit<RequirementRecord, "id" | "createdAt" | "updatedAt"> &
  Partial<Pick<RequirementRecord, "id" | "createdAt" | "updatedAt">>;

export function listRequirementsForWorkspace(data: PacketAgentData, workspaceId: string): RequirementRecord[] {
  return data.requirements.filter((entry) => entry.workspaceId === workspaceId);
}

export function findRequirement(data: PacketAgentData, requirementId: string): RequirementRecord | null {
  return data.requirements.find((entry) => entry.id === requirementId) ?? null;
}

export function upsertRequirement(data: PacketAgentData, input: RequirementUpsertInput, timestamp = now()): RequirementRecord {
  return upsertRecord(data.requirements, input, timestamp);
}

export type ImplementationPlanItemUpsertInput = Omit<ImplementationPlanItemRecord, "id" | "createdAt" | "updatedAt"> &
  Partial<Pick<ImplementationPlanItemRecord, "id" | "createdAt" | "updatedAt">>;

export function listImplementationPlanItemsForWorkspace(data: PacketAgentData, workspaceId: string): ImplementationPlanItemRecord[] {
  return data.implementationPlanItems
    .filter((entry) => entry.workspaceId === workspaceId)
    .sort((left, right) => left.order - right.order);
}

export function findImplementationPlanItem(data: PacketAgentData, planItemId: string): ImplementationPlanItemRecord | null {
  return data.implementationPlanItems.find((entry) => entry.id === planItemId) ?? null;
}

export function upsertImplementationPlanItem(
  data: PacketAgentData,
  input: ImplementationPlanItemUpsertInput,
  timestamp = now(),
): ImplementationPlanItemRecord {
  return upsertRecord(data.implementationPlanItems, input, timestamp);
}

export type WorkflowConcernUpsertInput = Omit<WorkflowConcernRecord, "id" | "createdAt" | "updatedAt"> &
  Partial<Pick<WorkflowConcernRecord, "id" | "createdAt" | "updatedAt">>;

export function listWorkflowConcernsForWorkspace(
  data: PacketAgentData,
  workspaceId: string,
  kind?: WorkflowConcernKind,
): WorkflowConcernRecord[] {
  return data.workflowConcerns.filter((entry) => entry.workspaceId === workspaceId && (!kind || entry.kind === kind));
}

export function findWorkflowConcern(data: PacketAgentData, concernId: string): WorkflowConcernRecord | null {
  return data.workflowConcerns.find((entry) => entry.id === concernId) ?? null;
}

export function upsertWorkflowConcern(
  data: PacketAgentData,
  input: WorkflowConcernUpsertInput,
  timestamp = now(),
): WorkflowConcernRecord {
  return upsertRecord(data.workflowConcerns, input, timestamp);
}

export type ValidationEvidenceUpsertInput = Omit<ValidationEvidenceRecord, "id" | "createdAt" | "updatedAt"> &
  Partial<Pick<ValidationEvidenceRecord, "id" | "createdAt" | "updatedAt">>;

export function listValidationEvidenceForWorkspace(data: PacketAgentData, workspaceId: string): ValidationEvidenceRecord[] {
  return data.validationEvidence.filter((entry) => entry.workspaceId === workspaceId);
}

export function findValidationEvidence(data: PacketAgentData, evidenceId: string): ValidationEvidenceRecord | null {
  return data.validationEvidence.find((entry) => entry.id === evidenceId) ?? null;
}

export function upsertValidationEvidence(
  data: PacketAgentData,
  input: ValidationEvidenceUpsertInput,
  timestamp = now(),
): ValidationEvidenceRecord {
  return upsertRecord(data.validationEvidence, input, timestamp);
}

export type ReleaseConfirmationUpsertInput = Omit<ReleaseConfirmationRecord, "id" | "createdAt" | "updatedAt"> &
  Partial<Pick<ReleaseConfirmationRecord, "id" | "createdAt" | "updatedAt">>;

export function listReleaseConfirmationsForWorkspace(data: PacketAgentData, workspaceId: string): ReleaseConfirmationRecord[] {
  return releaseConfirmationEntries(data.releaseConfirmations).filter((entry) => entry.workspaceId === workspaceId);
}

export function findReleaseConfirmation(data: PacketAgentData, releaseConfirmationId: string): ReleaseConfirmationRecord | null {
  return releaseConfirmationEntries(data.releaseConfirmations).find((entry) => {
    return entry.id === releaseConfirmationId || entry.workspaceId === releaseConfirmationId;
  }) ?? null;
}

export function upsertReleaseConfirmation(
  data: PacketAgentData,
  input: ReleaseConfirmationUpsertInput,
  timestamp = now(),
): ReleaseConfirmationRecord {
  const existing = releaseConfirmationEntries(data.releaseConfirmations).find((entry) => {
    return (input.id && entry.id === input.id) || entry.workspaceId === input.workspaceId;
  });
  if (existing) {
    Object.assign(existing, input, { updatedAt: input.updatedAt ?? timestamp });
    return existing;
  }

  const next: ReleaseConfirmationRecord = {
    ...input,
    id: input.id ?? generateId(),
    createdAt: input.createdAt ?? timestamp,
    updatedAt: input.updatedAt ?? timestamp,
  };
  if (Array.isArray(data.releaseConfirmations)) {
    data.releaseConfirmations.push(next);
  } else {
    data.releaseConfirmations[next.workspaceId] = next;
  }
  return next;
}

export type AgentUpsertInput = Omit<AgentRecord, "id" | "createdAt" | "updatedAt"> &
  Partial<Pick<AgentRecord, "id" | "createdAt" | "updatedAt">>;

export function listAgentsForWorkspace(data: PacketAgentData, workspaceId: string, includeArchived = false): AgentRecord[] {
  return data.agents
    .filter((entry) => entry.workspaceId === workspaceId && (includeArchived || entry.status !== "archived"))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function findAgent(data: PacketAgentData, agentId: string): AgentRecord | null {
  return data.agents.find((entry) => entry.id === agentId) ?? null;
}

export function upsertAgent(data: PacketAgentData, input: AgentUpsertInput, timestamp = now()): AgentRecord {
  return upsertRecord(data.agents, input, timestamp);
}

export function listProvidersForWorkspace(data: PacketAgentData, workspaceId: string): ProviderRecord[] {
  return data.providers
    .filter((entry) => entry.workspaceId === workspaceId)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function findProvider(data: PacketAgentData, providerId: string): ProviderRecord | null {
  return data.providers.find((entry) => entry.id === providerId) ?? null;
}

export type ProviderUpsertInput = Omit<ProviderRecord, "id" | "createdAt" | "updatedAt"> &
  Partial<Pick<ProviderRecord, "id" | "createdAt" | "updatedAt">>;

export function upsertProvider(data: PacketAgentData, input: ProviderUpsertInput, timestamp = now()): ProviderRecord {
  return upsertRecord(data.providers, input, timestamp);
}

export type AgentRunUpsertInput = Omit<AgentRunRecord, "id" | "createdAt" | "updatedAt"> &
  Partial<Pick<AgentRunRecord, "id" | "createdAt" | "updatedAt">>;

export function listAgentRunsForWorkspace(data: PacketAgentData, workspaceId: string): AgentRunRecord[] {
  return data.agentRuns
    .filter((entry) => entry.workspaceId === workspaceId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function listAgentRunsForAgent(data: PacketAgentData, workspaceId: string, agentId: string): AgentRunRecord[] {
  return listAgentRunsForWorkspace(data, workspaceId).filter((entry) => entry.agentId === agentId);
}

export function upsertAgentRun(data: PacketAgentData, input: AgentRunUpsertInput, timestamp = now()): AgentRunRecord {
  const record = upsertRecord(data.agentRuns, input, timestamp);
  enqueueAgentRunDualWrite(record);
  return record;
}

export type ActivationSignalUpsertInput = Omit<ActivationSignalRecord, "id" | "createdAt" | "updatedAt"> &
  Partial<Pick<ActivationSignalRecord, "id" | "createdAt" | "updatedAt">>;

export interface ActivationSignalRepository {
  listForWorkspace(workspaceId: string): ActivationSignalRecord[];
  upsert(input: ActivationSignalUpsertInput, timestamp?: string): ActivationSignalRecord;
}

export function activationSignalRepository(): ActivationSignalRepository {
  if (process.env.PACKETAGENT_STORE === "sqlite") return sqliteActivationSignalRepository(resolve(process.env.PACKETAGENT_DB_PATH ?? DEFAULT_DB_FILE));
  return jsonActivationSignalRepository();
}

function jsonActivationSignalRepository(): ActivationSignalRepository {
  return {
    listForWorkspace(workspaceId) {
      return listActivationSignalsForWorkspace(loadStore(), workspaceId);
    },
    upsert(input, timestamp = now()) {
      return mutateStore((data) => upsertActivationSignal(data, input, timestamp));
    },
  };
}

function sqliteActivationSignalRepository(dbPath: string): ActivationSignalRepository {
  return {
    listForWorkspace(workspaceId) {
      const db = openStoreDatabase(dbPath);
      try {
        const primary = readDedicatedActivationSignalsForWorkspace(db, workspaceId);
        const fallbackRows = db.prepare(`
          select payload
          from app_records
          where collection = 'activationSignals' and workspace_id = ?
          order by json_extract(payload, '$.createdAt'), id
        `).all(workspaceId) as Array<{ payload: string }>;
        const fallback = fallbackRows.map((row) => normalizeActivationSignalRecord(JSON.parse(row.payload) as ActivationSignalRecord));
        return mergeActivationSignals(primary, fallback);
      } finally {
        db.close();
      }
    },
    upsert(input, timestamp = now()) {
      const db = openStoreDatabase(dbPath);
      try {
        db.exec("begin immediate");
        try {
          const existing = findSqliteActivationSignalForUpsert(db, input);
          const id = existing?.id ?? input.id ?? generateId();
          const record: ActivationSignalRecord = {
            ...existing,
            ...input,
            id,
            origin: input.origin ?? inferActivationSignalOrigin(input.source) ?? existing?.origin,
            createdAt: input.createdAt ?? existing?.createdAt ?? timestamp,
            updatedAt: input.updatedAt ?? timestamp,
          };
          upsertDedicatedActivationSignal(db, record);
          db.exec("commit");
          clearStoreCache();
          return record;
        } catch (error) {
          db.exec("rollback");
          throw error;
        }
      } finally {
        db.close();
      }
    },
  };
}

function findSqliteActivationSignalForUpsert(db: ReturnType<typeof openStoreDatabase>, input: ActivationSignalUpsertInput): ActivationSignalRecord | null {
  const dedicated = findDedicatedActivationSignalForUpsert(db, input);
  if (dedicated) return dedicated;

  const stableKeyRow = input.stableKey
    ? db.prepare(`
      select payload
      from app_records
      where collection = 'activationSignals'
        and workspace_id = ?
        and json_extract(payload, '$.stableKey') = ?
      limit 1
    `).get(input.workspaceId, input.stableKey) as { payload: string } | undefined
    : undefined;
  if (stableKeyRow) return normalizeActivationSignalRecord(JSON.parse(stableKeyRow.payload) as ActivationSignalRecord);

  if (!input.id) return null;
  const idRow = db.prepare(`
    select payload
    from app_records
    where collection = 'activationSignals' and id = ?
    limit 1
  `).get(input.id) as { payload: string } | undefined;
  return idRow ? normalizeActivationSignalRecord(JSON.parse(idRow.payload) as ActivationSignalRecord) : null;
}

export function listActivationSignalsForWorkspace(data: PacketAgentData, workspaceId: string): ActivationSignalRecord[] {
  return data.activationSignals
    .filter((entry) => entry.workspaceId === workspaceId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

export function upsertActivationSignal(data: PacketAgentData, input: ActivationSignalUpsertInput, timestamp = now()): ActivationSignalRecord {
  const existing = input.stableKey
    ? data.activationSignals.find((entry) => entry.workspaceId === input.workspaceId && entry.stableKey === input.stableKey)
    : null;
  const normalizedInput = {
    ...input,
    origin: input.origin ?? inferActivationSignalOrigin(input.source) ?? existing?.origin,
  };
  if (existing) {
    Object.assign(existing, normalizedInput, { id: existing.id, createdAt: input.createdAt ?? existing.createdAt, updatedAt: input.updatedAt ?? timestamp });
    enqueueActivationSignalDualWrite(existing);
    return existing;
  }
  const record = upsertRecord(data.activationSignals, normalizedInput, timestamp);
  enqueueActivationSignalDualWrite(record);
  return record;
}

export const ONBOARDING_STEPS: OnboardingStepKey[] = [
  "create_workspace_profile",
  "define_requirements",
  "define_plan",
  "start_implementation",
  "validate",
  "confirm_release",
];

export function nextIncompleteStep(completedSteps: OnboardingStepKey[]): OnboardingStepKey {
  return ONBOARDING_STEPS.find((step) => !completedSteps.includes(step)) ?? "confirm_release";
}

export function snapshotForWorkspace(data: PacketAgentData, workspaceId: string) {
  const timestamp = now();
  const facts = data.activationFacts[workspaceId];
  const productRecords = activationProductRecordsForWorkspace(data, workspaceId, timestamp);

  if (productRecords.hasDurableRecords) {
    return buildSignalSnapshotFromProductRecords(productRecords.records);
  }

  return buildSignalSnapshotFromFacts({
    ...facts,
    now: timestamp,
  });
}

function activationProductRecordsForWorkspace(data: PacketAgentData, workspaceId: string, timestamp: string) {
  const workspace = data.workspaces.find((entry) => entry.id === workspaceId);
  const facts = data.activationFacts[workspaceId];
  const brief = findWorkspaceBrief(data, workspaceId);
  const requirements = listRequirementsForWorkspace(data, workspaceId);
  const planItems = listImplementationPlanItemsForWorkspace(data, workspaceId);
  const concerns = listWorkflowConcernsForWorkspace(data, workspaceId);
  const validationEvidence = listValidationEvidenceForWorkspace(data, workspaceId);
  const activationSignals = listActivationSignalsForWorkspace(data, workspaceId);
  const retryActivities = activationSignalActivities(data.activities, workspaceId, "retry");
  const scopeChangeActivities = activationSignalActivities(data.activities, workspaceId, "scope_change");
  const releaseConfirmation = listReleaseConfirmationsForWorkspace(data, workspaceId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];

  const records = {
    now: timestamp,
    createdAt: workspace?.createdAt ?? facts?.createdAt,
    startedAt: facts?.startedAt,
    completedAt: facts?.completedAt,
    releasedAt: facts?.releasedAt,
    brief: brief
      ? { id: brief.workspaceId, capturedAt: brief.createdAt, updatedAt: brief.updatedAt }
      : factRecord(facts?.briefCapturedAt),
    requirements: requirements.length > 0
      ? requirements.map((entry) => ({
        id: entry.id,
        status: entry.status,
        definedAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      }))
      : factRecord(facts?.requirementsDefinedAt),
    plan: planItems.length > 0 ? planRecordFromPlanItems(planItems) : factRecord(facts?.planDefinedAt),
    implementation: planItems.length > 0
      ? implementationRecordFromPlanItems(planItems)
      : factRecord(facts?.implementationStartedAt ?? facts?.completedAt),
    blockers: concerns.some((entry) => entry.kind === "blocker")
      ? concerns.filter((entry) => entry.kind === "blocker").map(concernRecord)
      : countRecords("legacy_blocker", facts?.blockerCount, { severity: facts?.criticalIssueCount ? "critical" : undefined }),
    questions: concerns.some((entry) => entry.kind === "open_question")
      ? concerns.filter((entry) => entry.kind === "open_question").map(concernRecord)
      : countRecords("legacy_question", facts?.openQuestionCount),
    validationEvidence: validationEvidence.length > 0
      ? validationEvidence.map(validationEvidenceRecord)
      : [
        ...countRecords("legacy_failed_validation", facts?.failedValidationCount, { status: "failed" }),
        ...factRecords("legacy_validation", facts?.validationPassedAt, { status: "passed", passedAt: facts?.validationPassedAt }),
      ],
    testEvidence: validationEvidence.length > 0
      ? validationEvidence.filter((entry) => entry.type === "automated_test").map(validationEvidenceRecord)
      : factRecords("legacy_test", facts?.testsPassedAt, { status: "passed", evidenceType: "test", passedAt: facts?.testsPassedAt }),
    releaseConfirmation: releaseConfirmation
      ? {
        id: releaseConfirmation.id ?? releaseConfirmation.workspaceId,
        status: releaseConfirmation.status,
        confirmedAt: releaseConfirmation.confirmedAt,
        createdAt: releaseConfirmation.createdAt,
        updatedAt: releaseConfirmation.updatedAt,
      }
      : factRecord(facts?.releaseConfirmedAt),
    retries: durableSignalRecords(activationSignals, "retry", retryActivities, "activity_retry")
      ?? countRecords("legacy_retry", facts?.retryCount),
    scopeChanges: durableSignalRecords(activationSignals, "scope_change", scopeChangeActivities, "activity_scope_change")
      ?? countRecords("legacy_scope_change", facts?.scopeChangeCount),
  };

  return {
    records,
    hasDurableRecords: Boolean(
      brief || requirements.length > 0 || planItems.length > 0 || concerns.length > 0 ||
      validationEvidence.length > 0 || releaseConfirmation || activationSignals.length > 0 || retryActivities.length > 0 || scopeChangeActivities.length > 0,
    ),
  };
}

function activationSignalActivities(activities: ActivityRecord[], workspaceId: string, kind: ActivationSignalRecord["kind"]): ActivityRecord[] {
  return activities.filter((entry) => {
    if (entry.workspaceId !== workspaceId) return false;
    if (entry.data.activationSignalKind === kind) return true;
    return kind === "retry" ? entry.event === "agent.run.retry" : entry.event === "workflow.scope_changed";
  });
}

function durableSignalRecords(
  signals: ActivationSignalRecord[],
  kind: ActivationSignalRecord["kind"],
  activities: ActivityRecord[],
  activityPrefix: string,
): DurableActivationProductRecord[] | null {
  const records = signals
    .filter((entry) => entry.kind === kind)
    .map((entry) => ({ id: entry.id, kind: entry.kind, createdAt: entry.createdAt }));
  const seenSignalIds = new Set(signals.filter((entry) => entry.kind === kind).map((entry) => entry.id));
  const seenSourceIds = new Set(signals.filter((entry) => entry.kind === kind && entry.sourceId).map((entry) => entry.sourceId));

  for (const activity of activities) {
    if (typeof activity.data.activationSignalId === "string" && seenSignalIds.has(activity.data.activationSignalId)) continue;
    if (typeof activity.data.sourceId === "string" && seenSourceIds.has(activity.data.sourceId)) continue;
    if (typeof activity.data.previousRunId === "string" && seenSourceIds.has(activity.data.previousRunId)) continue;
    if (seenSourceIds.has(activity.id)) continue;
    records.push({ id: `${activityPrefix}_${activity.id}`, kind, createdAt: activity.occurredAt });
  }

  return records.length > 0 ? records : null;
}

function factRecord(timestamp: string | undefined): DurableActivationProductRecord | null {
  return timestamp ? { id: `legacy_${timestamp}`, createdAt: timestamp } : null;
}

function factRecords(
  prefix: string,
  timestamp: string | undefined,
  overrides: DurableActivationProductRecord = {},
): DurableActivationProductRecord[] {
  return timestamp ? [{ id: `${prefix}_${timestamp}`, createdAt: timestamp, ...overrides }] : [];
}

function countRecords(
  prefix: string,
  count = 0,
  overrides: DurableActivationProductRecord = {},
): DurableActivationProductRecord[] {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}_${index}`, ...overrides }));
}

function planRecordFromPlanItems(planItems: ImplementationPlanItemRecord[]): DurableActivationProductRecord {
  const first = planItems[0];
  return {
    id: first.id,
    status: planItems.some((entry) => entry.status === "in_progress" || entry.status === "blocked")
      ? "in_progress"
      : planItems.every((entry) => entry.status === "done") ? "completed" : "todo",
    plannedAt: first.createdAt,
    startedAt: firstTimestamp(planItems, "startedAt") ?? firstTimestamp(planItems, "updatedAt", isStartedPlanItem),
    updatedAt: latestTimestamp(planItems.map((entry) => entry.updatedAt)),
    createdAt: first.createdAt,
  };
}

function implementationRecordFromPlanItems(planItems: ImplementationPlanItemRecord[]): DurableActivationProductRecord {
  const started = planItems.filter(isStartedPlanItem);
  const completed = planItems.filter((entry) => entry.status === "done");
  return {
    id: started[0]?.id ?? planItems[0].id,
    status: planItems.length > 0 && completed.length === planItems.length ? "completed" : started.length > 0 ? "in_progress" : "todo",
    startedAt: firstTimestamp(planItems, "startedAt") ?? firstTimestamp(started, "updatedAt"),
    completedAt: completed.length === planItems.length ? latestTimestamp(completed.map((entry) => entry.completedAt ?? entry.updatedAt)) : undefined,
    createdAt: started[0]?.createdAt,
    updatedAt: latestTimestamp(planItems.map((entry) => entry.updatedAt)),
  };
}

function concernRecord(entry: WorkflowConcernRecord): DurableActivationProductRecord {
  return {
    id: entry.id,
    kind: entry.kind,
    status: entry.status,
    severity: entry.severity,
    dependency: Boolean(entry.relatedPlanItemId || entry.relatedRequirementId),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    resolvedAt: entry.resolvedAt,
  };
}

function validationEvidenceRecord(entry: ValidationEvidenceRecord): DurableActivationProductRecord {
  const outcome = entry.outcome ?? entry.status;
  return {
    id: entry.id,
    kind: entry.type,
    evidenceType: entry.type,
    status: outcome,
    capturedAt: entry.capturedAt,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    passedAt: outcome === "passed" ? entry.capturedAt ?? entry.updatedAt : undefined,
    failedAt: outcome === "failed" ? entry.capturedAt ?? entry.updatedAt : undefined,
  };
}

function isStartedPlanItem(entry: ImplementationPlanItemRecord): boolean {
  return entry.status === "in_progress" || entry.status === "blocked" || entry.status === "done";
}

function firstTimestamp(
  records: ImplementationPlanItemRecord[],
  field: "startedAt" | "updatedAt",
  predicate: (entry: ImplementationPlanItemRecord) => boolean = () => true,
): string | undefined {
  return records.filter(predicate).map((entry) => entry[field]).filter(Boolean).sort()[0];
}

function latestTimestamp(timestamps: Array<string | undefined>): string | undefined {
  return timestamps.filter(Boolean).sort().at(-1);
}

function upsertRecord<TRecord extends { id: string; createdAt: string; updatedAt: string }>(
  records: TRecord[],
  input: Omit<TRecord, "id" | "createdAt" | "updatedAt"> & Partial<Pick<TRecord, "id" | "createdAt" | "updatedAt">>,
  timestamp: string,
): TRecord {
  const id = input.id ?? generateId();
  const existing = records.find((entry) => entry.id === id);
  if (existing) {
    Object.assign(existing, input, { id, updatedAt: input.updatedAt ?? timestamp });
    return existing;
  }

  const next = {
    ...input,
    id,
    createdAt: input.createdAt ?? timestamp,
    updatedAt: input.updatedAt ?? timestamp,
  } as TRecord;
  records.push(next);
  return next;
}

export function listWorkspaceEnvVars(data: PacketAgentData, workspaceId: string): WorkspaceEnvVarRecord[] {
  return data.workspaceEnvVars
    .filter((entry) => entry.workspaceId === workspaceId)
    .sort((left, right) => left.key.localeCompare(right.key));
}

export function findWorkspaceEnvVar(data: PacketAgentData, envVarId: string): WorkspaceEnvVarRecord | null {
  return data.workspaceEnvVars.find((entry) => entry.id === envVarId) ?? null;
}

export type WorkspaceEnvVarUpsertInput = Omit<WorkspaceEnvVarRecord, "id" | "createdAt" | "updatedAt"> &
  Partial<Pick<WorkspaceEnvVarRecord, "id" | "createdAt" | "updatedAt">>;

export function upsertWorkspaceEnvVar(
  data: PacketAgentData,
  input: WorkspaceEnvVarUpsertInput,
  timestamp = now(),
): WorkspaceEnvVarRecord {
  return upsertRecord(data.workspaceEnvVars, input, timestamp);
}

export function deleteWorkspaceEnvVar(data: PacketAgentData, envVarId: string): boolean {
  const before = data.workspaceEnvVars.length;
  data.workspaceEnvVars = data.workspaceEnvVars.filter((entry) => entry.id !== envVarId);
  return data.workspaceEnvVars.length < before;
}
