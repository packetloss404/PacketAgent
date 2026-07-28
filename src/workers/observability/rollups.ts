import { createHash } from "node:crypto";
import {
  loadStoreAsync as defaultLoadStore,
  type PacketAgentData,
} from "../../packetagent-store.js";
import type { ActivityRecord, JobRecord, ProviderCallRecord } from "../../store/types.js";
import type { WorkerBudgetReservationRecord } from "../budget-types.js";
import type { WorkerApprovalGrant, WorkerAttentionRequest } from "../control-types.js";
import type { WorkerEffectReceipt } from "../effect-types.js";
import type { WorkerEvent, WorkerEventV2 } from "../persistence-types.js";
import { validateWorkerPersistence } from "../repository.js";
import type { WorkerCheckpoint, WorkerDeployment, WorkerRun, WorkerVersion } from "../types.js";
import { canonicalWorkerJson } from "../validation.js";
import { isWorkerEventV2 } from "./journal.js";
import {
  WORKER_OBSERVABILITY_ROLLUP_SCHEMA_VERSION,
  type WorkerApprovalRollup,
  type WorkerArtifactRollup,
  type WorkerBudgetRollup,
  type WorkerCheckpointRollup,
  type WorkerEffectRollup,
  type WorkerObservabilityRollup,
  type WorkerObservabilityRollupIdentity,
  type WorkerObservabilityRollupSet,
  type WorkerOutcomeRollup,
  type WorkerProviderCallRollup,
  type WorkerQueueRollup,
  type WorkerRetryRollup,
  type WorkerSourceGapRollup,
  type WorkerToolCallRollup,
} from "./rollup-types.js";
import type {
  WorkerArtifactManifest,
  WorkerEvidenceEntry,
  WorkerEvidenceSourceKind,
  WorkerEvidenceSourceReference,
} from "./types.js";

type MaybePromise<T> = T | Promise<T>;

export interface WorkerRollupRepositoryDependencies {
  readonly loadStore?: () => MaybePromise<PacketAgentData>;
}

export interface WorkerRollupRepository {
  rebuild(workspaceId: string): Promise<WorkerObservabilityRollupSet>;
}

interface ScopeRecords {
  readonly identity: WorkerObservabilityRollupIdentity;
  readonly events: readonly WorkerEvent[];
  readonly evidence: readonly WorkerEvidenceEntry[];
  readonly runs: readonly WorkerRun[];
  readonly jobs: readonly JobRecord[];
  readonly providerCalls: readonly ProviderCallRecord[];
  readonly effects: readonly WorkerEffectReceipt[];
  readonly reservations: readonly WorkerBudgetReservationRecord[];
  readonly attention: readonly WorkerAttentionRequest[];
  readonly grants: readonly WorkerApprovalGrant[];
  readonly checkpoints: readonly WorkerCheckpoint[];
  readonly artifacts: readonly WorkerArtifactManifest[];
  readonly activities: readonly ActivityRecord[];
  readonly allData: PacketAgentData;
}

export function createWorkerRollupRepository(
  dependencies: WorkerRollupRepositoryDependencies = {},
): WorkerRollupRepository {
  const loadStore = dependencies.loadStore ?? defaultLoadStore;
  return {
    async rebuild(workspaceId) {
      const data = await loadStore();
      validateWorkerPersistence(data);
      return buildWorkerObservabilityRollups(data, workspaceId);
    },
  };
}

export function buildWorkerObservabilityRollups(
  data: PacketAgentData,
  workspaceId: string,
): WorkerObservabilityRollupSet {
  const versions = data.workerVersions
    .filter((record) => record.workspaceId === workspaceId)
    .sort(compareVersionIdentity);
  const deployments = data.workerDeployments
    .filter((record) => record.workspaceId === workspaceId)
    .sort(compareDeploymentIdentity);
  const runs = data.workerRuns
    .filter((record) => record.workspaceId === workspaceId)
    .sort(compareRunIdentity);
  const computedThroughSequence = data.workerEvents
    .filter((event) => event.workspaceId === workspaceId)
    .reduce((maximum, event) => Math.max(maximum, event.sequence), 0);

  return {
    schemaVersion: WORKER_OBSERVABILITY_ROLLUP_SCHEMA_VERSION,
    workspaceId,
    computedThroughSequence,
    versions: versions.map((version) =>
      buildRollup(
        data,
        workspaceId,
        {
          kind: "version",
          workerDefinitionId: version.workerDefinitionId,
          workerVersionId: version.id,
        },
        runs.filter((run) => run.workerVersionId === version.id),
      ),
    ),
    deployments: deployments.map((deployment) =>
      buildRollup(
        data,
        workspaceId,
        {
          kind: "deployment",
          workerDefinitionId: deployment.workerDefinitionId,
          workerVersionId: deployment.workerVersionId,
          workerDeploymentId: deployment.id,
        },
        runs.filter((run) => run.workerDeploymentId === deployment.id),
      ),
    ),
    runs: runs.map((run) =>
      buildRollup(
        data,
        workspaceId,
        {
          kind: "run",
          workerDefinitionId: run.workerDefinitionId,
          workerVersionId: run.workerVersionId,
          workerDeploymentId: run.workerDeploymentId,
          workerRunId: run.id,
        },
        [run],
      ),
    ),
  };
}

function buildRollup(
  data: PacketAgentData,
  workspaceId: string,
  identity: WorkerObservabilityRollupIdentity,
  runs: readonly WorkerRun[],
): WorkerObservabilityRollup {
  const runIds = new Set(runs.map((run) => run.id));
  const events = data.workerEvents
    .filter((event) => event.workspaceId === workspaceId && eventMatches(event, identity))
    .sort(compareEvents);
  const evidenceIds = new Set(events.filter(isWorkerEventV2).map((event) => event.evidenceId));
  const evidence = data.workerEvidenceEntries
    .filter(
      (entry) =>
        entry.workspaceId === workspaceId &&
        evidenceIds.has(entry.id) &&
        evidenceMatches(entry, identity),
    )
    .sort((left, right) => left.sequence - right.sequence);
  const jobs = data.jobs
    .filter(
      (job) =>
        job.workspaceId === workspaceId &&
        job.type === "worker.run" &&
        typeof job.payload.workerRunId === "string" &&
        runIds.has(job.payload.workerRunId),
    )
    .sort(compareJobs);
  const correlatedProviderCallIds = new Set(
    events
      .filter(isWorkerEventV2)
      .map((event) => event.correlation?.providerCallId)
      .filter(isString),
  );
  const providerCalls = data.providerCalls
    .filter(
      (record) => record.workspaceId === workspaceId && correlatedProviderCallIds.has(record.id),
    )
    .sort(compareProviderCalls);
  const records: ScopeRecords = {
    identity,
    events,
    evidence,
    runs: [...runs].sort(compareRunIdentity),
    jobs,
    providerCalls,
    effects: data.workerEffectReceipts
      .filter((record) => record.workspaceId === workspaceId && runIds.has(record.workerRunId))
      .sort((left, right) => left.id.localeCompare(right.id)),
    reservations: data.workerBudgetReservations
      .filter((record) => record.workspaceId === workspaceId && runIds.has(record.workerRunId))
      .sort((left, right) => left.id.localeCompare(right.id)),
    attention: data.workerAttentionRequests
      .filter((record) => record.workspaceId === workspaceId && runIds.has(record.workerRunId))
      .sort((left, right) => left.id.localeCompare(right.id)),
    grants: data.workerApprovalGrants
      .filter((record) => record.workspaceId === workspaceId && runIds.has(record.workerRunId))
      .sort((left, right) => left.id.localeCompare(right.id)),
    checkpoints: data.workerCheckpoints
      .filter((record) => record.workspaceId === workspaceId && runIds.has(record.workerRunId))
      .sort(compareCheckpoints),
    artifacts: data.workerArtifactManifests
      .filter((record) => record.workspaceId === workspaceId && runIds.has(record.workerRunId))
      .sort((left, right) => left.id.localeCompare(right.id)),
    activities: data.activities
      .filter(
        (record) =>
          record.workspaceId === workspaceId && activityMatches(data, record, identity, runIds),
      )
      .sort(compareActivities),
    allData: data,
  };
  const timestamps = occurrenceTimestamps(records);

  return {
    schemaVersion: WORKER_OBSERVABILITY_ROLLUP_SCHEMA_VERSION,
    workspaceId,
    identity,
    computedThroughSequence: events.reduce(
      (maximum, event) => Math.max(maximum, event.sequence),
      0,
    ),
    ...(timestamps[0] ? { firstOccurredAt: timestamps[0] } : {}),
    ...(timestamps.at(-1) ? { lastOccurredAt: timestamps.at(-1) } : {}),
    events: events.length,
    evidenceEntries: evidence.length,
    legacyEvents: events.filter((event) => !isWorkerEventV2(event)).length,
    relatedActivities: records.activities.length,
    providers: providerRollup(records, correlatedProviderCallIds),
    tools: toolRollup(records),
    effects: effectRollup(records),
    retries: retryRollup(records),
    queue: queueRollup(records),
    approvals: approvalRollup(records),
    checkpoints: checkpointRollup(records),
    budget: budgetRollup(records),
    artifacts: artifactRollup(records),
    outcomes: outcomeRollup(records),
    sourceGaps: sourceGapRollup(records),
  };
}

function providerRollup(
  records: ScopeRecords,
  correlatedIds: ReadonlySet<string>,
): WorkerProviderCallRollup {
  const byProvider: Record<string, { calls: number; costUsd: number }> = {};
  let succeeded = 0;
  let failed = 0;
  let canceled = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let costUsd = 0;
  let durationMs = 0;
  for (const call of records.providerCalls) {
    if (call.status === "success") succeeded += 1;
    else if (call.status === "error") failed += 1;
    else canceled += 1;
    promptTokens += call.promptTokens;
    completionTokens += call.completionTokens;
    costUsd = addDecimal(costUsd, call.costUsd);
    durationMs += call.durationMs;
    const provider = byProvider[call.provider] ?? { calls: 0, costUsd: 0 };
    provider.calls += 1;
    provider.costUsd = addDecimal(provider.costUsd, call.costUsd);
    byProvider[call.provider] = provider;
  }
  const linkedProviderEvents = records.events.filter(
    (event): event is WorkerEventV2 =>
      isWorkerEventV2(event) &&
      event.source === "provider" &&
      Boolean(event.correlation?.providerCallId),
  );
  const missingSourceRecords = [...correlatedIds].filter(
    (id) => !records.providerCalls.some((call) => call.id === id),
  ).length;
  const missingCompleted = linkedProviderEvents.filter(
    (event) =>
      event.type === "worker.provider.completed" &&
      !records.providerCalls.some((call) => call.id === event.correlation!.providerCallId),
  );
  for (const event of uniqueBy(missingCompleted, (entry) => entry.correlation!.providerCallId!)) {
    promptTokens += numberData(event, "promptTokens");
    completionTokens += numberData(event, "completionTokens");
    costUsd = addDecimal(costUsd, numberData(event, "costUsd"));
    succeeded += 1;
  }
  const missingFailed = linkedProviderEvents.filter(
    (event) =>
      event.type === "worker.provider.failed" &&
      !records.providerCalls.some((call) => call.id === event.correlation!.providerCallId),
  );
  failed += uniqueBy(missingFailed, (entry) => entry.correlation!.providerCallId!).length;

  return {
    calls: correlatedIds.size,
    succeeded,
    failed,
    canceled,
    missingSourceRecords,
    uncorrelatedEvents: records.events.filter(
      (event) =>
        isWorkerEventV2(event) && event.source === "provider" && !event.correlation?.providerCallId,
    ).length,
    promptTokens,
    completionTokens,
    costUsd,
    durationMs,
    byProvider,
  };
}

function toolRollup(records: ScopeRecords): WorkerToolCallRollup {
  const terminalEvents = records.events.filter(
    (event): event is WorkerEventV2 =>
      isWorkerEventV2(event) &&
      ["worker.tool.completed", "worker.tool.failed"].includes(event.type),
  );
  let succeeded = 0;
  let failed = 0;
  let durationMs = 0;
  for (const event of terminalEvents) {
    if (event.type === "worker.tool.completed" && stringData(event, "status") === "ok") {
      succeeded += 1;
    } else failed += 1;
    durationMs += numberData(event, "durationMs");
  }
  const attempted = records.runs.reduce((total, run) => total + run.budgetUsage.toolCalls, 0);
  return {
    attempted,
    completed: terminalEvents.length,
    succeeded,
    failed,
    unresolved: Math.max(attempted - terminalEvents.length, 0),
    denied: records.events.filter((event) => event.type === "worker.policy.denied").length,
    durationMs,
  };
}

function effectRollup(records: ScopeRecords): WorkerEffectRollup {
  let prepared = 0;
  let completed = 0;
  let succeeded = 0;
  let failed = 0;
  let timedOut = 0;
  let durationMs = 0;
  for (const effect of records.effects) {
    if (effect.status === "prepared") prepared += 1;
    else completed += 1;
    if (effect.result) {
      durationMs += effect.result.durationMs;
      if (effect.result.status === "ok") succeeded += 1;
      else if (effect.result.status === "timeout") timedOut += 1;
      else failed += 1;
    }
  }
  return {
    total: records.effects.length,
    prepared,
    completed,
    succeeded,
    failed,
    timedOut,
    durationMs,
  };
}

function retryRollup(records: ScopeRecords): WorkerRetryRollup {
  const phaseFailures = records.events.filter(
    (event): event is WorkerEventV2 =>
      isWorkerEventV2(event) && event.type === "worker.phase.failed",
  );
  return {
    executionAttempts: records.jobs.reduce((total, job) => total + Math.max(job.attempts, 0), 0),
    jobRetries: records.jobs.reduce((total, job) => total + Math.max(job.attempts - 1, 0), 0),
    recoveryRequeues: records.events.filter((event) => event.type === "worker.run.recovery_queued")
      .length,
    providerFailures: uniqueBy(
      records.events.filter(
        (event): event is WorkerEventV2 =>
          isWorkerEventV2(event) && event.type === "worker.provider.failed",
      ),
      (event) => event.correlation?.providerCallId ?? event.id,
    ).length,
    phaseFailures: phaseFailures.length,
    scheduledBackoffMs: phaseFailures.reduce(
      (total, event) => total + numberData(event, "backoffMs"),
      0,
    ),
  };
}

function queueRollup(records: ScopeRecords): WorkerQueueRollup {
  const statusCounts: Partial<Record<JobRecord["status"], number>> = {};
  const durations: number[] = [];
  for (const job of records.jobs) {
    increment(statusCounts, job.status);
    if (!job.startedAt) continue;
    const duration = Date.parse(job.startedAt) - Date.parse(job.scheduledAt);
    if (Number.isFinite(duration) && duration >= 0) durations.push(duration);
  }
  const totalDurationMs = durations.reduce((total, duration) => total + duration, 0);
  return {
    jobs: records.jobs.length,
    statusCounts,
    startedSamples: durations.length,
    pendingSamples: records.jobs.length - durations.length,
    totalDurationMs,
    averageDurationMs: durations.length > 0 ? Math.round(totalDurationMs / durations.length) : null,
    maximumDurationMs: durations.length > 0 ? Math.max(...durations) : null,
  };
}

function approvalRollup(records: ScopeRecords): WorkerApprovalRollup {
  const requestStatusCounts: Partial<Record<WorkerAttentionRequest["status"], number>> = {};
  const grantStatusCounts: Partial<Record<WorkerApprovalGrant["status"], number>> = {};
  const grantScopeCounts: Partial<Record<WorkerApprovalGrant["scope"], number>> = {};
  for (const request of records.attention) increment(requestStatusCounts, request.status);
  for (const grant of records.grants) {
    increment(grantStatusCounts, grant.status);
    increment(grantScopeCounts, grant.scope);
  }
  return {
    requests: records.attention.length,
    requestStatusCounts,
    grants: records.grants.length,
    grantStatusCounts,
    grantScopeCounts,
  };
}

function checkpointRollup(records: ScopeRecords): WorkerCheckpointRollup {
  const latest = records.checkpoints.at(-1);
  return {
    count: records.checkpoints.length,
    ...(latest
      ? {
          latestId: latest.id,
          latestSequence: latest.sequence,
          latestCreatedAt: latest.createdAt,
        }
      : {}),
  };
}

function budgetRollup(records: ScopeRecords): WorkerBudgetRollup {
  const reportedUsage = {
    elapsedMs: 0,
    iterations: 0,
    providerCostUsd: 0,
    consecutiveFailures: 0,
    toolCalls: 0,
  };
  let reservedProviderCostUsd = 0;
  let settledProviderCostUsd = 0;
  let releasedProviderCostUsd = 0;
  let reservedBillableActions = 0;
  let settledBillableActions = 0;
  let releasedBillableActions = 0;
  for (const run of records.runs) {
    reportedUsage.elapsedMs += run.budgetUsage.elapsedMs;
    reportedUsage.iterations += run.budgetUsage.iterations;
    reportedUsage.providerCostUsd = addDecimal(
      reportedUsage.providerCostUsd,
      run.budgetUsage.providerCostUsd,
    );
    reportedUsage.consecutiveFailures = Math.max(
      reportedUsage.consecutiveFailures,
      run.budgetUsage.consecutiveFailures,
    );
    reportedUsage.toolCalls += run.budgetUsage.toolCalls;
  }
  for (const reservation of records.reservations) {
    const amount =
      reservation.status === "settled"
        ? (reservation.settledAmount ?? 0)
        : reservation.reservedAmount;
    if (reservation.kind === "provider_cost_usd") {
      if (reservation.status === "reserved") {
        reservedProviderCostUsd = addDecimal(reservedProviderCostUsd, amount);
      } else if (reservation.status === "settled") {
        settledProviderCostUsd = addDecimal(settledProviderCostUsd, amount);
      } else {
        releasedProviderCostUsd = addDecimal(releasedProviderCostUsd, amount);
      }
    } else if (reservation.status === "reserved") {
      reservedBillableActions += amount;
    } else if (reservation.status === "settled") {
      settledBillableActions += amount;
    } else {
      releasedBillableActions += amount;
    }
  }
  return {
    reportedUsage,
    reservations: records.reservations.length,
    reservedProviderCostUsd,
    settledProviderCostUsd,
    releasedProviderCostUsd,
    reservedBillableActions,
    settledBillableActions,
    releasedBillableActions,
  };
}

function artifactRollup(records: ScopeRecords): WorkerArtifactRollup {
  let publicMetadata = 0;
  let internal = 0;
  let sensitiveReferences = 0;
  let totalBytes = 0;
  for (const manifest of records.artifacts) {
    totalBytes += manifest.artifact.byteLength;
    if (manifest.classification === "public_metadata") publicMetadata += 1;
    else if (manifest.classification === "sensitive_reference") {
      sensitiveReferences += 1;
    } else internal += 1;
  }
  return {
    count: records.artifacts.length,
    totalBytes,
    publicMetadata,
    internal,
    sensitiveReferences,
  };
}

function outcomeRollup(records: ScopeRecords): WorkerOutcomeRollup {
  const statusCounts: Partial<Record<WorkerRun["status"], number>> = {};
  const terminalReasonCounts: Partial<Record<NonNullable<WorkerRun["terminalReason"]>, number>> =
    {};
  for (const run of records.runs) {
    increment(statusCounts, run.status);
    if (run.terminalReason) increment(terminalReasonCounts, run.terminalReason);
  }
  const exitEvaluations = records.events.filter(
    (event): event is WorkerEventV2 =>
      isWorkerEventV2(event) && event.type === "worker.phase.evaluated",
  );
  const matchedExitPredicates = exitEvaluations.filter(
    (event) => event.data?.matched === true,
  ).length;
  return {
    runs: records.runs.length,
    statusCounts,
    terminalReasonCounts,
    exitEvaluations: exitEvaluations.length,
    matchedExitPredicates,
    unmatchedExitPredicates: exitEvaluations.length - matchedExitPredicates,
  };
}

function sourceGapRollup(records: ScopeRecords): WorkerSourceGapRollup {
  const missing = new Map<
    string,
    { readonly kind: WorkerEvidenceSourceKind; readonly id: string }
  >();
  for (const entry of records.evidence) {
    for (const reference of entry.sourceReferences) {
      if (!sourceReferenceExists(records.allData, records.events, entry.workspaceId, reference)) {
        missing.set(`${reference.kind}:${reference.id}`, {
          kind: reference.kind,
          id: reference.id,
        });
      }
    }
  }
  const byKind: Partial<Record<WorkerEvidenceSourceKind, number>> = {};
  let retentionDeleted = 0;
  for (const reference of [...missing.values()].sort((left, right) =>
    `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`),
  )) {
    increment(byKind, reference.kind);
    if (retentionTombstoneExists(records.events, reference.id)) {
      retentionDeleted += 1;
    }
  }
  return {
    total: missing.size,
    retentionDeleted,
    unexplained: missing.size - retentionDeleted,
    byKind,
  };
}

function retentionTombstoneExists(events: readonly WorkerEvent[], resourceId: string): boolean {
  const resourceDigest = `sha256:${createHash("sha256")
    .update(canonicalWorkerJson({ resourceId }))
    .digest("hex")}`;
  return events.some(
    (event) =>
      isWorkerEventV2(event) &&
      event.source === "retention" &&
      Array.isArray(event.data?.resourceIdDigests) &&
      event.data.resourceIdDigests.includes(resourceDigest),
  );
}

function sourceReferenceExists(
  data: PacketAgentData,
  scopeEvents: readonly WorkerEvent[],
  workspaceId: string,
  reference: WorkerEvidenceSourceReference,
): boolean {
  switch (reference.kind) {
    case "worker_event":
      return data.workerEvents.some(
        (record) => record.workspaceId === workspaceId && record.id === reference.id,
      );
    case "activation_inbox":
      return data.workerActivationInboxes.some(
        (record) => record.workspaceId === workspaceId && record.id === reference.id,
      );
    case "execution_job":
      return data.jobs.some(
        (record) => record.workspaceId === workspaceId && record.id === reference.id,
      );
    case "provider_call":
      return data.providerCalls.some(
        (record) => record.workspaceId === workspaceId && record.id === reference.id,
      );
    case "tool_call":
      return scopeEvents.some(
        (event) => isWorkerEventV2(event) && event.correlation?.toolCallId === reference.id,
      );
    case "effect_receipt":
      return data.workerEffectReceipts.some(
        (record) => record.workspaceId === workspaceId && record.id === reference.id,
      );
    case "checkpoint":
      return data.workerCheckpoints.some(
        (record) => record.workspaceId === workspaceId && record.id === reference.id,
      );
    case "attention_request":
      return data.workerAttentionRequests.some(
        (record) => record.workspaceId === workspaceId && record.id === reference.id,
      );
    case "approval_grant":
      return data.workerApprovalGrants.some(
        (record) => record.workspaceId === workspaceId && record.id === reference.id,
      );
    case "control_command":
      return data.workerControlCommands.some(
        (record) => record.workspaceId === workspaceId && record.id === reference.id,
      );
  }
}

function eventMatches(event: WorkerEvent, identity: WorkerObservabilityRollupIdentity): boolean {
  if (
    event.workerDefinitionId !== identity.workerDefinitionId ||
    event.workerVersionId !== identity.workerVersionId
  ) {
    return false;
  }
  if (
    identity.workerDeploymentId !== undefined &&
    event.workerDeploymentId !== identity.workerDeploymentId
  ) {
    return false;
  }
  if (identity.workerRunId !== undefined) {
    const runId = isWorkerEventV2(event)
      ? event.workerRunId
      : typeof event.data?.workerRunId === "string"
        ? event.data.workerRunId
        : undefined;
    return runId === identity.workerRunId;
  }
  return true;
}

function evidenceMatches(
  evidence: WorkerEvidenceEntry,
  identity: WorkerObservabilityRollupIdentity,
): boolean {
  return (
    evidence.workerDefinitionId === identity.workerDefinitionId &&
    evidence.workerVersionId === identity.workerVersionId &&
    (identity.workerDeploymentId === undefined ||
      evidence.workerDeploymentId === identity.workerDeploymentId) &&
    (identity.workerRunId === undefined || evidence.workerRunId === identity.workerRunId)
  );
}

function activityMatches(
  data: PacketAgentData,
  activity: ActivityRecord,
  identity: WorkerObservabilityRollupIdentity,
  runIds: ReadonlySet<string>,
): boolean {
  const workerRunId = activity.data.workerRunId;
  if (typeof workerRunId === "string") return runIds.has(workerRunId);
  if (identity.kind === "run") return false;
  const workerDeploymentId = activity.data.workerDeploymentId;
  if (typeof workerDeploymentId === "string") {
    if (identity.kind === "deployment") {
      return workerDeploymentId === identity.workerDeploymentId;
    }
    return data.workerDeployments.some(
      (deployment) =>
        deployment.workspaceId === activity.workspaceId &&
        deployment.id === workerDeploymentId &&
        deployment.workerVersionId === identity.workerVersionId,
    );
  }
  return activity.data.workerVersionId === identity.workerVersionId;
}

function compareEvents(left: WorkerEvent, right: WorkerEvent): number {
  return left.sequence - right.sequence || left.id.localeCompare(right.id);
}

function compareJobs(left: JobRecord, right: JobRecord): number {
  return left.scheduledAt.localeCompare(right.scheduledAt) || left.id.localeCompare(right.id);
}

function compareProviderCalls(left: ProviderCallRecord, right: ProviderCallRecord): number {
  return left.completedAt.localeCompare(right.completedAt) || left.id.localeCompare(right.id);
}

function compareCheckpoints(left: WorkerCheckpoint, right: WorkerCheckpoint): number {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    left.sequence - right.sequence ||
    left.id.localeCompare(right.id)
  );
}

function compareActivities(left: ActivityRecord, right: ActivityRecord): number {
  return left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id);
}

function compareVersionIdentity(left: WorkerVersion, right: WorkerVersion): number {
  return (
    left.workerDefinitionId.localeCompare(right.workerDefinitionId) ||
    left.version - right.version ||
    left.id.localeCompare(right.id)
  );
}

function compareDeploymentIdentity(left: WorkerDeployment, right: WorkerDeployment): number {
  return (
    left.workerDefinitionId.localeCompare(right.workerDefinitionId) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function compareRunIdentity(left: WorkerRun, right: WorkerRun): number {
  return (
    left.workerDefinitionId.localeCompare(right.workerDefinitionId) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function occurrenceTimestamps(records: ScopeRecords): string[] {
  return [
    ...records.events.map((event) => event.occurredAt),
    ...records.runs.flatMap((run) =>
      compactTimestamps([run.createdAt, run.startedAt, run.updatedAt, run.completedAt]),
    ),
    ...records.jobs.flatMap((job) =>
      compactTimestamps([job.createdAt, job.startedAt, job.updatedAt, job.completedAt]),
    ),
    ...records.providerCalls.flatMap((call) => [call.startedAt, call.completedAt]),
    ...records.effects.flatMap((effect) =>
      compactTimestamps([effect.preparedAt, effect.completedAt]),
    ),
    ...records.reservations.flatMap((reservation) =>
      compactTimestamps([
        reservation.reservedAt,
        reservation.settledAt,
        reservation.releasedAt,
        reservation.updatedAt,
      ]),
    ),
    ...records.attention.flatMap((attention) =>
      compactTimestamps([attention.requestedAt, attention.resolvedAt]),
    ),
    ...records.grants.flatMap((grant) =>
      compactTimestamps([grant.grantedAt, grant.consumedAt, grant.revokedAt, grant.expiredAt]),
    ),
    ...records.checkpoints.map((checkpoint) => checkpoint.createdAt),
    ...records.artifacts.map((artifact) => artifact.createdAt),
    ...records.activities.map((activity) => activity.occurredAt),
  ].sort();
}

function compactTimestamps(values: readonly (string | undefined)[]): string[] {
  return values.filter(isString);
}

function stringData(event: WorkerEventV2, key: string): string | undefined {
  const value = event.data?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberData(event: WorkerEventV2, key: string): number {
  const value = event.data?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function increment<TKey extends string>(counts: Partial<Record<TKey, number>>, key: TKey): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function addDecimal(left: number, right: number): number {
  return Number((left + right).toFixed(12));
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const value of values) {
    const identity = key(value);
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push(value);
  }
  return unique;
}

function isString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
