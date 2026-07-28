import { Buffer } from "node:buffer";
import {
  loadStoreAsync as defaultLoadStore,
  type PacketAgentData,
} from "../../packetagent-store.js";
import type { WorkerAttentionRequest, WorkerAttentionRequestStatus } from "../control-types.js";
import { WorkerLifecycleError } from "../errors.js";
import type { WorkerEvent } from "../persistence-types.js";
import { validateWorkerPersistence } from "../repository.js";
import { isTerminalWorkerDeploymentStatus, isTerminalWorkerRunStatus } from "../transitions.js";
import type {
  WorkerCheckpoint,
  WorkerDefinition,
  WorkerDeployment,
  WorkerRun,
  WorkerRunStatus,
  WorkerVersion,
} from "../types.js";
import { isWorkerEventV2 } from "./journal.js";
import {
  redactWorkerArtifactManifestForRead,
  redactWorkerEventForRead,
  redactWorkerEvidenceForRead,
} from "./redaction.js";
import type { WorkerObservabilityRollup, WorkerObservabilityRollupSet } from "./rollup-types.js";
import { buildWorkerObservabilityRollups } from "./rollups.js";
import type {
  WorkerArtifactManifest,
  WorkerEvidenceEntry,
  WorkerEvidenceRedactionClassification,
  WorkerEvidenceSourceKind,
} from "./types.js";

type MaybePromise<T> = T | Promise<T>;

export const WORKER_OPERATIONS_READ_MODEL_SCHEMA_VERSION =
  "packetagent.worker-operations-read-model/v1" as const;

const CURSOR_SCHEMA_VERSION = 1;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;
const MAX_CURSOR_LENGTH = 4_096;

export type WorkerOperationsHealthState = "healthy" | "attention" | "degraded";

export interface WorkerOperationsPageInfo {
  readonly hasMore: boolean;
  readonly limit: number;
  readonly nextCursor?: string;
}

export interface WorkerRunListFilters {
  readonly status?: WorkerRunStatus;
  readonly workerDefinitionId?: string;
  readonly workerVersionId?: string;
  readonly workerDeploymentId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface WorkerAttentionListFilters {
  readonly status?: WorkerAttentionRequestStatus;
  readonly workerRunId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface WorkerEventListFilters {
  readonly workerDeploymentId?: string;
  readonly workerRunId?: string;
  readonly source?: string;
  readonly type?: string;
  readonly afterSequence?: number;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface WorkerEvidenceListFilters {
  readonly workerDeploymentId?: string;
  readonly workerRunId?: string;
  readonly classification?: WorkerEvidenceRedactionClassification;
  readonly sourceKind?: WorkerEvidenceSourceKind;
  readonly afterSequence?: number;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface WorkerArtifactListFilters {
  readonly workerDeploymentId?: string;
  readonly workerRunId?: string;
  readonly classification?: WorkerEvidenceRedactionClassification;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface WorkerCheckpointReadModel {
  readonly id: string;
  readonly sequence: number;
  readonly cursor: WorkerCheckpoint["cursor"];
  readonly remainingBudget: WorkerCheckpoint["remainingBudget"];
  readonly stateDigest: string;
  readonly createdAt: string;
}

export interface WorkerAttentionReadModel {
  readonly id: string;
  readonly workerDefinitionId: string;
  readonly workerDeploymentId: string;
  readonly workerRunId: string;
  readonly workerVersionId: string;
  readonly status: WorkerAttentionRequestStatus;
  readonly runRevision: number;
  readonly capabilityId: string;
  readonly operationDigest: string;
  readonly operation?: {
    readonly tool: string;
    readonly verb: string;
    readonly effect: string;
    readonly resourceCount: number;
    readonly resourceSchemes: readonly string[];
  };
  readonly expirationDisposition: WorkerAttentionRequest["expirationDisposition"];
  readonly requestedAt: string;
  readonly escalatesAt?: string;
  readonly expiresAt: string;
  readonly resolvedAt?: string;
}

export interface WorkerRunSummaryReadModel {
  readonly schemaVersion: typeof WORKER_OPERATIONS_READ_MODEL_SCHEMA_VERSION;
  readonly id: string;
  readonly definition: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly status: WorkerDefinition["status"];
  };
  readonly version: {
    readonly id: string;
    readonly version: number;
    readonly status: WorkerVersion["status"];
    readonly objective: string;
    readonly contentDigest: string;
  };
  readonly deployment: {
    readonly id: string;
    readonly status: WorkerDeployment["status"];
    readonly revision: number;
    readonly statusReason?: string;
  };
  readonly status: WorkerRunStatus;
  readonly revision: number;
  readonly attempt: number;
  readonly trigger: {
    readonly id: string;
    readonly kind: WorkerRun["triggerKind"];
  };
  readonly terminalReason?: WorkerRun["terminalReason"];
  readonly budget: {
    readonly policy: WorkerVersion["content"]["policy"]["budgets"];
    readonly usage: WorkerRun["budgetUsage"];
  };
  readonly latestCheckpoint?: WorkerCheckpointReadModel;
  readonly attention: {
    readonly open: number;
    readonly total: number;
  };
  readonly rollup: WorkerObservabilityRollup;
  readonly controls: {
    readonly canPause: boolean;
    readonly canResume: boolean;
    readonly canStop: boolean;
    readonly canRevokeDeployment: boolean;
    readonly canResolveAttention: boolean;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface WorkerOperationsHealthReadModel {
  readonly schemaVersion: typeof WORKER_OPERATIONS_READ_MODEL_SCHEMA_VERSION;
  readonly workspaceId: string;
  readonly state: WorkerOperationsHealthState;
  readonly computedThroughSequence: number;
  readonly totals: {
    readonly definitions: number;
    readonly versions: number;
    readonly deployments: number;
    readonly runs: number;
    readonly activeRuns: number;
    readonly terminalRuns: number;
    readonly openAttention: number;
  };
  readonly runStatusCounts: Readonly<Partial<Record<WorkerRunStatus, number>>>;
  readonly providerCostUsd: number;
  readonly billableToolCalls: number;
  readonly unexplainedSourceGaps: number;
}

export interface WorkerRunDetailReadModel {
  readonly schemaVersion: typeof WORKER_OPERATIONS_READ_MODEL_SCHEMA_VERSION;
  readonly run: WorkerRunSummaryReadModel;
  readonly attention: readonly WorkerAttentionReadModel[];
  readonly events: {
    readonly items: readonly WorkerEvent[];
    readonly page: WorkerOperationsPageInfo;
  };
  readonly evidence: {
    readonly items: readonly WorkerEvidenceEntry[];
    readonly page: WorkerOperationsPageInfo;
  };
  readonly artifacts: {
    readonly items: readonly WorkerArtifactManifest[];
    readonly page: WorkerOperationsPageInfo;
  };
}

export interface WorkerOperationsReadModelDependencies {
  readonly loadStore?: () => MaybePromise<PacketAgentData>;
  readonly knownSecretValues?: (
    workspaceId: string,
  ) => MaybePromise<readonly (string | null | undefined)[]>;
}

export interface WorkerOperationsReadModel {
  health(workspaceId: string): Promise<WorkerOperationsHealthReadModel>;
  listRuns(
    workspaceId: string,
    filters?: WorkerRunListFilters,
  ): Promise<{
    readonly runs: readonly WorkerRunSummaryReadModel[];
    readonly page: WorkerOperationsPageInfo;
  }>;
  getRun(
    workspaceId: string,
    workerRunId: string,
    limit?: number,
  ): Promise<WorkerRunDetailReadModel>;
  listAttention(
    workspaceId: string,
    filters?: WorkerAttentionListFilters,
  ): Promise<{
    readonly attention: readonly WorkerAttentionReadModel[];
    readonly page: WorkerOperationsPageInfo;
  }>;
  listEvents(
    workspaceId: string,
    filters?: WorkerEventListFilters,
  ): Promise<{
    readonly events: readonly WorkerEvent[];
    readonly page: WorkerOperationsPageInfo;
  }>;
  listEvidence(
    workspaceId: string,
    filters?: WorkerEvidenceListFilters,
  ): Promise<{
    readonly evidence: readonly WorkerEvidenceEntry[];
    readonly page: WorkerOperationsPageInfo;
  }>;
  listArtifacts(
    workspaceId: string,
    filters?: WorkerArtifactListFilters,
  ): Promise<{
    readonly artifacts: readonly WorkerArtifactManifest[];
    readonly page: WorkerOperationsPageInfo;
  }>;
}

interface CursorEnvelope {
  readonly v: typeof CURSOR_SCHEMA_VERSION;
  readonly kind: "runs" | "attention" | "events" | "evidence" | "artifacts";
  readonly workspaceId: string;
  readonly filters: string;
  readonly position: Readonly<Record<string, string | number>>;
}

export function createWorkerOperationsReadModel(
  dependencies: WorkerOperationsReadModelDependencies = {},
): WorkerOperationsReadModel {
  const loadStore = dependencies.loadStore ?? defaultLoadStore;
  const knownSecretValues = dependencies.knownSecretValues ?? (() => []);

  return {
    async health(workspaceId) {
      const data = await readStore(loadStore);
      const rollups = buildWorkerObservabilityRollups(data, workspaceId);
      return buildHealth(data, workspaceId, rollups);
    },

    async listRuns(workspaceId, filters = {}) {
      const data = await readStore(loadStore);
      const rollups = buildWorkerObservabilityRollups(data, workspaceId);
      return listRunsFromStore(data, workspaceId, rollups, filters);
    },

    async getRun(workspaceId, workerRunId, requestedLimit) {
      const data = await readStore(loadStore);
      const secrets = await knownSecretValues(workspaceId);
      const rollups = buildWorkerObservabilityRollups(data, workspaceId);
      const run = requireRun(data, workspaceId, workerRunId);
      const limit = pageLimit(requestedLimit);
      const summary = projectRunSummary(data, run, requireRunRollup(rollups, run.id));
      const attention = data.workerAttentionRequests
        .filter((record) => record.workspaceId === workspaceId && record.workerRunId === run.id)
        .sort(compareAttention)
        .map((record) => projectAttention(data, record));
      const events = listEventsFromStore(data, workspaceId, { workerRunId, limit }, secrets);
      const evidence = listEvidenceFromStore(data, workspaceId, { workerRunId, limit }, secrets);
      const artifacts = listArtifactsFromStore(data, workspaceId, { workerRunId, limit }, secrets);
      return {
        schemaVersion: WORKER_OPERATIONS_READ_MODEL_SCHEMA_VERSION,
        run: summary,
        attention,
        events: { items: events.events, page: events.page },
        evidence: { items: evidence.evidence, page: evidence.page },
        artifacts: { items: artifacts.artifacts, page: artifacts.page },
      };
    },

    async listAttention(workspaceId, filters = {}) {
      const data = await readStore(loadStore);
      return listAttentionFromStore(data, workspaceId, filters);
    },

    async listEvents(workspaceId, filters = {}) {
      const data = await readStore(loadStore);
      const secrets = await knownSecretValues(workspaceId);
      return listEventsFromStore(data, workspaceId, filters, secrets);
    },

    async listEvidence(workspaceId, filters = {}) {
      const data = await readStore(loadStore);
      const secrets = await knownSecretValues(workspaceId);
      return listEvidenceFromStore(data, workspaceId, filters, secrets);
    },

    async listArtifacts(workspaceId, filters = {}) {
      const data = await readStore(loadStore);
      const secrets = await knownSecretValues(workspaceId);
      return listArtifactsFromStore(data, workspaceId, filters, secrets);
    },
  };
}

function buildHealth(
  data: PacketAgentData,
  workspaceId: string,
  rollups: WorkerObservabilityRollupSet,
): WorkerOperationsHealthReadModel {
  const runs = data.workerRuns.filter((record) => record.workspaceId === workspaceId);
  const runStatusCounts: Partial<Record<WorkerRunStatus, number>> = {};
  for (const run of runs) {
    runStatusCounts[run.status] = (runStatusCounts[run.status] ?? 0) + 1;
  }
  const openAttention = data.workerAttentionRequests.filter(
    (record) => record.workspaceId === workspaceId && record.status === "open",
  ).length;
  const unexplainedSourceGaps = rollups.runs.reduce(
    (total, rollup) => total + rollup.sourceGaps.unexplained,
    0,
  );
  const state: WorkerOperationsHealthState =
    unexplainedSourceGaps > 0 || (runStatusCounts.quarantined ?? 0) > 0
      ? "degraded"
      : openAttention > 0 || (runStatusCounts.waiting_for_approval ?? 0) > 0
        ? "attention"
        : "healthy";
  return {
    schemaVersion: WORKER_OPERATIONS_READ_MODEL_SCHEMA_VERSION,
    workspaceId,
    state,
    computedThroughSequence: rollups.computedThroughSequence,
    totals: {
      definitions: data.workerDefinitions.filter((record) => record.workspaceId === workspaceId)
        .length,
      versions: data.workerVersions.filter((record) => record.workspaceId === workspaceId).length,
      deployments: data.workerDeployments.filter((record) => record.workspaceId === workspaceId)
        .length,
      runs: runs.length,
      activeRuns: runs.filter((run) => !isTerminalWorkerRunStatus(run.status)).length,
      terminalRuns: runs.filter((run) => isTerminalWorkerRunStatus(run.status)).length,
      openAttention,
    },
    runStatusCounts,
    providerCostUsd: addDecimals(rollups.runs.map((rollup) => rollup.providers.costUsd)),
    billableToolCalls: runs.reduce((total, run) => total + run.budgetUsage.toolCalls, 0),
    unexplainedSourceGaps,
  };
}

function listRunsFromStore(
  data: PacketAgentData,
  workspaceId: string,
  rollups: WorkerObservabilityRollupSet,
  filters: WorkerRunListFilters,
) {
  const limit = pageLimit(filters.limit);
  const filterKey = stableFilterKey({
    status: filters.status,
    workerDefinitionId: filters.workerDefinitionId,
    workerVersionId: filters.workerVersionId,
    workerDeploymentId: filters.workerDeploymentId,
  });
  const cursor = filters.cursor
    ? decodeCursor(filters.cursor, "runs", workspaceId, filterKey)
    : undefined;
  const createdAt = cursor ? cursorString(cursor, "createdAt") : undefined;
  const id = cursor ? cursorString(cursor, "id") : undefined;
  const candidates = data.workerRuns
    .filter(
      (run) =>
        run.workspaceId === workspaceId &&
        (filters.status === undefined || run.status === filters.status) &&
        (filters.workerDefinitionId === undefined ||
          run.workerDefinitionId === filters.workerDefinitionId) &&
        (filters.workerVersionId === undefined ||
          run.workerVersionId === filters.workerVersionId) &&
        (filters.workerDeploymentId === undefined ||
          run.workerDeploymentId === filters.workerDeploymentId),
    )
    .sort(compareRunsDescending)
    .filter(
      (run) =>
        createdAt === undefined ||
        run.createdAt < createdAt ||
        (run.createdAt === createdAt && run.id < id!),
    );
  const page = takePage(candidates, limit);
  const last = page.items.at(-1);
  return {
    runs: page.items.map((run) => projectRunSummary(data, run, requireRunRollup(rollups, run.id))),
    page: pageInfo(
      limit,
      page.hasMore,
      last
        ? encodeCursor({
            v: CURSOR_SCHEMA_VERSION,
            kind: "runs",
            workspaceId,
            filters: filterKey,
            position: { createdAt: last.createdAt, id: last.id },
          })
        : undefined,
    ),
  };
}

function listAttentionFromStore(
  data: PacketAgentData,
  workspaceId: string,
  filters: WorkerAttentionListFilters,
) {
  const limit = pageLimit(filters.limit);
  const filterKey = stableFilterKey({
    status: filters.status,
    workerRunId: filters.workerRunId,
  });
  const cursor = filters.cursor
    ? decodeCursor(filters.cursor, "attention", workspaceId, filterKey)
    : undefined;
  const requestedAt = cursor ? cursorString(cursor, "requestedAt") : undefined;
  const id = cursor ? cursorString(cursor, "id") : undefined;
  const candidates = data.workerAttentionRequests
    .filter(
      (record) =>
        record.workspaceId === workspaceId &&
        (filters.status === undefined || record.status === filters.status) &&
        (filters.workerRunId === undefined || record.workerRunId === filters.workerRunId),
    )
    .sort(compareAttention)
    .filter(
      (record) =>
        requestedAt === undefined ||
        record.requestedAt < requestedAt ||
        (record.requestedAt === requestedAt && record.id < id!),
    );
  const page = takePage(candidates, limit);
  const last = page.items.at(-1);
  return {
    attention: page.items.map((record) => projectAttention(data, record)),
    page: pageInfo(
      limit,
      page.hasMore,
      last
        ? encodeCursor({
            v: CURSOR_SCHEMA_VERSION,
            kind: "attention",
            workspaceId,
            filters: filterKey,
            position: { requestedAt: last.requestedAt, id: last.id },
          })
        : undefined,
    ),
  };
}

function listEventsFromStore(
  data: PacketAgentData,
  workspaceId: string,
  filters: WorkerEventListFilters,
  secrets: readonly (string | null | undefined)[],
) {
  const limit = pageLimit(filters.limit);
  const filterKey = stableFilterKey({
    workerDeploymentId: filters.workerDeploymentId,
    workerRunId: filters.workerRunId,
    source: filters.source,
    type: filters.type,
  });
  const cursor = filters.cursor
    ? decodeCursor(filters.cursor, "events", workspaceId, filterKey)
    : undefined;
  const afterSequence = cursor
    ? cursorNumber(cursor, "sequence")
    : validAfterSequence(filters.afterSequence);
  const candidates = data.workerEvents
    .filter(
      (event) =>
        event.workspaceId === workspaceId &&
        event.sequence > afterSequence &&
        (filters.workerDeploymentId === undefined ||
          event.workerDeploymentId === filters.workerDeploymentId) &&
        (filters.workerRunId === undefined || workerEventRunId(event) === filters.workerRunId) &&
        (filters.source === undefined ||
          (isWorkerEventV2(event) && event.source === filters.source)) &&
        (filters.type === undefined || event.type === filters.type),
    )
    .sort(compareSequence);
  const page = takePage(candidates, limit);
  const last = page.items.at(-1);
  return {
    events: page.items.map((event) => redactWorkerEventForRead(structuredClone(event), secrets)),
    page: pageInfo(
      limit,
      page.hasMore,
      last
        ? encodeCursor({
            v: CURSOR_SCHEMA_VERSION,
            kind: "events",
            workspaceId,
            filters: filterKey,
            position: { sequence: last.sequence },
          })
        : undefined,
    ),
  };
}

function listEvidenceFromStore(
  data: PacketAgentData,
  workspaceId: string,
  filters: WorkerEvidenceListFilters,
  secrets: readonly (string | null | undefined)[],
) {
  const limit = pageLimit(filters.limit);
  const filterKey = stableFilterKey({
    workerDeploymentId: filters.workerDeploymentId,
    workerRunId: filters.workerRunId,
    classification: filters.classification,
    sourceKind: filters.sourceKind,
  });
  const cursor = filters.cursor
    ? decodeCursor(filters.cursor, "evidence", workspaceId, filterKey)
    : undefined;
  const afterSequence = cursor
    ? cursorNumber(cursor, "sequence")
    : validAfterSequence(filters.afterSequence);
  const candidates = data.workerEvidenceEntries
    .filter(
      (entry) =>
        entry.workspaceId === workspaceId &&
        entry.sequence > afterSequence &&
        (filters.workerDeploymentId === undefined ||
          entry.workerDeploymentId === filters.workerDeploymentId) &&
        (filters.workerRunId === undefined || entry.workerRunId === filters.workerRunId) &&
        (filters.classification === undefined || entry.classification === filters.classification) &&
        (filters.sourceKind === undefined ||
          entry.sourceReferences.some((source) => source.kind === filters.sourceKind)),
    )
    .sort(compareSequence);
  const page = takePage(candidates, limit);
  const last = page.items.at(-1);
  return {
    evidence: page.items.map((entry) =>
      redactWorkerEvidenceForRead(structuredClone(entry), secrets),
    ),
    page: pageInfo(
      limit,
      page.hasMore,
      last
        ? encodeCursor({
            v: CURSOR_SCHEMA_VERSION,
            kind: "evidence",
            workspaceId,
            filters: filterKey,
            position: { sequence: last.sequence },
          })
        : undefined,
    ),
  };
}

function listArtifactsFromStore(
  data: PacketAgentData,
  workspaceId: string,
  filters: WorkerArtifactListFilters,
  secrets: readonly (string | null | undefined)[],
) {
  const limit = pageLimit(filters.limit);
  const filterKey = stableFilterKey({
    workerDeploymentId: filters.workerDeploymentId,
    workerRunId: filters.workerRunId,
    classification: filters.classification,
  });
  const cursor = filters.cursor
    ? decodeCursor(filters.cursor, "artifacts", workspaceId, filterKey)
    : undefined;
  const createdAt = cursor ? cursorString(cursor, "createdAt") : undefined;
  const id = cursor ? cursorString(cursor, "id") : undefined;
  const candidates = data.workerArtifactManifests
    .filter(
      (manifest) =>
        manifest.workspaceId === workspaceId &&
        (filters.workerDeploymentId === undefined ||
          manifest.workerDeploymentId === filters.workerDeploymentId) &&
        (filters.workerRunId === undefined || manifest.workerRunId === filters.workerRunId) &&
        (filters.classification === undefined ||
          manifest.classification === filters.classification),
    )
    .sort(compareArtifactsDescending)
    .filter(
      (manifest) =>
        createdAt === undefined ||
        manifest.createdAt < createdAt ||
        (manifest.createdAt === createdAt && manifest.id < id!),
    );
  const page = takePage(candidates, limit);
  const last = page.items.at(-1);
  return {
    artifacts: page.items.map((manifest) =>
      redactWorkerArtifactManifestForRead(structuredClone(manifest), secrets),
    ),
    page: pageInfo(
      limit,
      page.hasMore,
      last
        ? encodeCursor({
            v: CURSOR_SCHEMA_VERSION,
            kind: "artifacts",
            workspaceId,
            filters: filterKey,
            position: { createdAt: last.createdAt, id: last.id },
          })
        : undefined,
    ),
  };
}

function projectRunSummary(
  data: PacketAgentData,
  run: WorkerRun,
  rollup: WorkerObservabilityRollup,
): WorkerRunSummaryReadModel {
  const definition = requireDefinition(data, run);
  const version = requireVersion(data, run);
  const deployment = requireDeployment(data, run);
  const checkpoints = data.workerCheckpoints
    .filter((record) => record.workspaceId === run.workspaceId && record.workerRunId === run.id)
    .sort((left, right) => right.sequence - left.sequence || right.id.localeCompare(left.id));
  const latestCheckpoint = checkpoints.find((record) => record.id === run.latestCheckpointId);
  const attention = data.workerAttentionRequests.filter(
    (record) => record.workspaceId === run.workspaceId && record.workerRunId === run.id,
  );
  const openAttention = attention.filter((record) => record.status === "open").length;
  return {
    schemaVersion: WORKER_OPERATIONS_READ_MODEL_SCHEMA_VERSION,
    id: run.id,
    definition: {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      status: definition.status,
    },
    version: {
      id: version.id,
      version: version.version,
      status: version.status,
      objective: version.content.objective,
      contentDigest: version.contentDigest,
    },
    deployment: {
      id: deployment.id,
      status: deployment.status,
      revision: deployment.revision,
      ...(deployment.statusReason ? { statusReason: deployment.statusReason } : {}),
    },
    status: run.status,
    revision: run.revision,
    attempt: run.attempt,
    trigger: {
      id: run.triggerId,
      kind: run.triggerKind,
    },
    ...(run.terminalReason ? { terminalReason: run.terminalReason } : {}),
    budget: {
      policy: structuredClone(version.content.policy.budgets),
      usage: structuredClone(run.budgetUsage),
    },
    ...(latestCheckpoint ? { latestCheckpoint: projectCheckpoint(latestCheckpoint) } : {}),
    attention: {
      open: openAttention,
      total: attention.length,
    },
    rollup,
    controls: {
      canPause: run.status === "running",
      canResume: run.status === "paused" && !isTerminalWorkerDeploymentStatus(deployment.status),
      canStop: ["queued", "running", "waiting_for_approval", "paused"].includes(run.status),
      canRevokeDeployment: !isTerminalWorkerDeploymentStatus(deployment.status),
      canResolveAttention: openAttention > 0,
    },
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
  };
}

function projectCheckpoint(checkpoint: WorkerCheckpoint): WorkerCheckpointReadModel {
  return {
    id: checkpoint.id,
    sequence: checkpoint.sequence,
    cursor: structuredClone(checkpoint.cursor),
    remainingBudget: structuredClone(checkpoint.remainingBudget),
    stateDigest: checkpoint.stateDigest,
    createdAt: checkpoint.createdAt,
  };
}

function projectAttention(
  data: PacketAgentData,
  attention: WorkerAttentionRequest,
): WorkerAttentionReadModel {
  const run = requireRun(data, attention.workspaceId, attention.workerRunId);
  const operation = operationSummary(data.workerEvents, attention);
  return {
    id: attention.id,
    workerDefinitionId: attention.workerDefinitionId,
    workerDeploymentId: attention.workerDeploymentId,
    workerRunId: attention.workerRunId,
    workerVersionId: attention.workerVersionId,
    status: attention.status,
    runRevision: run.revision,
    capabilityId: attention.capabilityId,
    operationDigest: attention.operationDigest,
    ...(operation ? { operation } : {}),
    expirationDisposition: attention.expirationDisposition,
    requestedAt: attention.requestedAt,
    ...(attention.escalatesAt ? { escalatesAt: attention.escalatesAt } : {}),
    expiresAt: attention.expiresAt,
    ...(attention.resolvedAt ? { resolvedAt: attention.resolvedAt } : {}),
  };
}

function operationSummary(
  events: readonly WorkerEvent[],
  attention: WorkerAttentionRequest,
): WorkerAttentionReadModel["operation"] | undefined {
  const event = [...events]
    .reverse()
    .find(
      (candidate) =>
        candidate.workspaceId === attention.workspaceId &&
        candidate.workerDeploymentId === attention.workerDeploymentId &&
        workerEventRunId(candidate) === attention.workerRunId &&
        (candidate.type === "worker.policy.denied" || candidate.type === "worker.policy.allowed") &&
        candidate.data?.operationDigest === attention.operationDigest &&
        candidate.data.capabilityId === attention.capabilityId,
    );
  const value = event?.data;
  if (
    typeof value?.tool !== "string" ||
    typeof value.verb !== "string" ||
    typeof value.effect !== "string" ||
    typeof value.resourceCount !== "number" ||
    !Number.isSafeInteger(value.resourceCount) ||
    value.resourceCount < 0 ||
    !Array.isArray(value.resourceSchemes) ||
    !value.resourceSchemes.every((item) => typeof item === "string")
  ) {
    return undefined;
  }
  return {
    tool: value.tool,
    verb: value.verb,
    effect: value.effect,
    resourceCount: value.resourceCount,
    resourceSchemes: value.resourceSchemes,
  };
}

function requireDefinition(data: PacketAgentData, run: WorkerRun): WorkerDefinition {
  const definition = data.workerDefinitions.find(
    (record) => record.workspaceId === run.workspaceId && record.id === run.workerDefinitionId,
  );
  if (!definition) {
    throw new WorkerLifecycleError(
      "not_found",
      `WorkerDefinition ${run.workerDefinitionId} was not found.`,
    );
  }
  return definition;
}

function requireVersion(data: PacketAgentData, run: WorkerRun): WorkerVersion {
  const version = data.workerVersions.find(
    (record) => record.workspaceId === run.workspaceId && record.id === run.workerVersionId,
  );
  if (!version) {
    throw new WorkerLifecycleError(
      "not_found",
      `WorkerVersion ${run.workerVersionId} was not found.`,
    );
  }
  return version;
}

function requireDeployment(data: PacketAgentData, run: WorkerRun): WorkerDeployment {
  const deployment = data.workerDeployments.find(
    (record) => record.workspaceId === run.workspaceId && record.id === run.workerDeploymentId,
  );
  if (!deployment) {
    throw new WorkerLifecycleError(
      "not_found",
      `WorkerDeployment ${run.workerDeploymentId} was not found.`,
    );
  }
  return deployment;
}

function requireRun(data: PacketAgentData, workspaceId: string, workerRunId: string): WorkerRun {
  const run = data.workerRuns.find(
    (record) => record.workspaceId === workspaceId && record.id === workerRunId,
  );
  if (!run) {
    throw new WorkerLifecycleError("not_found", `WorkerRun ${workerRunId} was not found.`);
  }
  return run;
}

function requireRunRollup(
  rollups: WorkerObservabilityRollupSet,
  workerRunId: string,
): WorkerObservabilityRollup {
  const rollup = rollups.runs.find((record) => record.identity.workerRunId === workerRunId);
  if (!rollup) {
    throw new WorkerLifecycleError(
      "not_found",
      `Worker observability rollup for ${workerRunId} was not found.`,
    );
  }
  return rollup;
}

async function readStore(loadStore: () => MaybePromise<PacketAgentData>): Promise<PacketAgentData> {
  const data = await loadStore();
  validateWorkerPersistence(data);
  return data;
}

function workerEventRunId(event: WorkerEvent): string | undefined {
  if (isWorkerEventV2(event)) return event.workerRunId;
  return typeof event.data?.workerRunId === "string" ? event.data.workerRunId : undefined;
}

function compareRunsDescending(left: WorkerRun, right: WorkerRun): number {
  const created = right.createdAt.localeCompare(left.createdAt);
  return created !== 0 ? created : right.id.localeCompare(left.id);
}

function compareAttention(left: WorkerAttentionRequest, right: WorkerAttentionRequest): number {
  const requested = right.requestedAt.localeCompare(left.requestedAt);
  return requested !== 0 ? requested : right.id.localeCompare(left.id);
}

function compareSequence(
  left: { readonly sequence: number; readonly id: string },
  right: { readonly sequence: number; readonly id: string },
): number {
  return left.sequence - right.sequence || left.id.localeCompare(right.id);
}

function compareArtifactsDescending(
  left: WorkerArtifactManifest,
  right: WorkerArtifactManifest,
): number {
  const created = right.createdAt.localeCompare(left.createdAt);
  return created !== 0 ? created : right.id.localeCompare(left.id);
}

function takePage<T>(
  values: readonly T[],
  limit: number,
): { readonly items: readonly T[]; readonly hasMore: boolean } {
  return {
    items: values.slice(0, limit),
    hasMore: values.length > limit,
  };
}

function pageInfo(
  limit: number,
  hasMore: boolean,
  nextCursor: string | undefined,
): WorkerOperationsPageInfo {
  return {
    hasMore,
    limit,
    ...(hasMore && nextCursor ? { nextCursor } : {}),
  };
}

function pageLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_LIMIT) {
    throw invalidCursorOrFilter(`limit must be an integer between 1 and ${MAX_PAGE_LIMIT}.`);
  }
  return value;
}

function validAfterSequence(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidCursorOrFilter("afterSequence must be a non-negative integer.");
  }
  return value;
}

function stableFilterKey(filters: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(filters)
        .filter(([, value]) => value !== undefined)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

function encodeCursor(cursor: CursorEnvelope): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(
  encoded: string,
  expectedKind: CursorEnvelope["kind"],
  workspaceId: string,
  filters: string,
): CursorEnvelope["position"] {
  if (!encoded || encoded.length > MAX_CURSOR_LENGTH) {
    throw invalidCursorOrFilter("cursor is invalid.");
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<CursorEnvelope>;
    if (
      parsed.v !== CURSOR_SCHEMA_VERSION ||
      parsed.kind !== expectedKind ||
      parsed.workspaceId !== workspaceId ||
      parsed.filters !== filters ||
      !parsed.position ||
      typeof parsed.position !== "object" ||
      Array.isArray(parsed.position)
    ) {
      throw new Error("cursor binding mismatch");
    }
    return parsed.position as CursorEnvelope["position"];
  } catch {
    throw invalidCursorOrFilter("cursor is invalid for this workspace and filter set.");
  }
}

function cursorString(position: CursorEnvelope["position"], name: string): string {
  const value = position[name];
  if (typeof value !== "string" || !value) {
    throw invalidCursorOrFilter("cursor position is invalid.");
  }
  return value;
}

function cursorNumber(position: CursorEnvelope["position"], name: string): number {
  const value = position[name];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidCursorOrFilter("cursor position is invalid.");
  }
  return value as number;
}

function invalidCursorOrFilter(message: string): WorkerLifecycleError {
  return new WorkerLifecycleError("invalid_input", message);
}

function addDecimals(values: readonly number[]): number {
  return values.reduce((total, value) => Number((total + value).toFixed(12)), 0);
}
