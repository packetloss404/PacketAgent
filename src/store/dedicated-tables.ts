import { type DatabaseSync, type SQLInputValue } from "node:sqlite";
import { normalizeActivationSignalRecord } from "./normalize.js";
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
import type {
  WorkerArtifactManifest,
  WorkerEvidenceEntry,
} from "../workers/observability/types.js";
import type {
  PacketProductCredentialRecord,
  WorkerPackageDeploymentRecord,
  WorkerPackageReceipt,
} from "../workers/package/trust-types.js";
import type { PacketProductEventAcknowledgementRecord } from "../workers/package/event-types.js";
import type {
  ActivationSignalKind,
  ActivationSignalOrigin,
  ActivationSignalRecord,
  ActivationSignalSource,
  ActivityRecord,
  AgentRunLogEntry,
  AgentRunRecord,
  AgentRunStatus,
  AgentRunStep,
  AgentRunToolCall,
  AgentTriggerKind,
  AlertEventRecord,
  InvitationEmailDeliveryMode,
  InvitationEmailDeliveryRecord,
  InvitationEmailDeliveryStatus,
  JobMetricSnapshotRecord,
  JobRecord,
  JobStatus,
  ProviderCallRecord,
  PacketAgentData,
} from "./types.js";

// LEAF module: dedicated relational table load/persist for the sqlite backend.
// Imports only types, normalize (also a leaf), and node:sqlite — never a backend
// or the barrel. These tables are the physical authority for promoted SQLite
// collections and are written inside the canonical store transaction.

export type DedicatedRelationalCollectionKey =
  | "jobMetricSnapshots"
  | "alertEvents"
  | "agentRuns"
  | "jobs"
  | "invitationEmailDeliveries"
  | "activities"
  | "providerCalls"
  | "activationSignals"
  | "packetProductCredentials"
  | "workerPackageReceipts"
  | "workerPackageDeployments"
  | "packetProductEventAcknowledgements"
  | "workerDefinitions"
  | "workerVersions"
  | "workerDeployments"
  | "workerRuns"
  | "workerCheckpoints"
  | "workerEffectReceipts"
  | "workerDeploymentRollouts"
  | "workerCommandReceipts"
  | "workerEvents"
  | "workerEvidenceEntries"
  | "workerArtifactManifests"
  | "workerActivationInboxes"
  | "workerActivationPayloads";

export type DedicatedRelationalCollections = Pick<
  PacketAgentData,
  DedicatedRelationalCollectionKey
>;

// Structural mirror of the barrel's ActivationSignalUpsertInput; kept local so
// this leaf module never imports the barrel. Only the fields read by the
// dedicated lookup helpers below are needed.
type ActivationSignalUpsertInput = Omit<ActivationSignalRecord, "id" | "createdAt" | "updatedAt"> &
  Partial<Pick<ActivationSignalRecord, "id" | "createdAt" | "updatedAt">>;

export function loadDedicatedRelationalCollections(
  db: DatabaseSync,
): DedicatedRelationalCollections {
  return {
    jobMetricSnapshots: loadDedicatedJobMetricSnapshots(db),
    alertEvents: loadDedicatedAlertEvents(db),
    agentRuns: loadDedicatedAgentRuns(db),
    jobs: loadDedicatedJobs(db),
    invitationEmailDeliveries: loadDedicatedInvitationEmailDeliveries(db),
    activities: loadDedicatedActivities(db),
    providerCalls: loadDedicatedProviderCalls(db),
    activationSignals: loadDedicatedActivationSignals(db),
    packetProductCredentials: loadWorkerPayloads<PacketProductCredentialRecord>(
      db,
      "select payload from packet_product_credentials order by workspace_id, created_at, id",
    ),
    workerPackageReceipts: loadWorkerPayloads<WorkerPackageReceipt>(
      db,
      "select payload from worker_package_receipts order by workspace_id, accepted_at, id",
    ),
    workerPackageDeployments: loadWorkerPayloads<WorkerPackageDeploymentRecord>(
      db,
      "select payload from worker_package_deployments order by workspace_id, created_at, id",
    ),
    packetProductEventAcknowledgements: loadWorkerPayloads<PacketProductEventAcknowledgementRecord>(
      db,
      "select payload from packet_product_event_acknowledgements order by workspace_id, acknowledged_at, id",
    ),
    workerDefinitions: loadWorkerPayloads<WorkerDefinition>(
      db,
      "select payload from worker_definitions order by workspace_id, id",
    ),
    workerVersions: loadWorkerPayloads<WorkerVersion>(
      db,
      "select payload from worker_versions order by workspace_id, worker_definition_id, version",
    ),
    workerDeployments: loadWorkerPayloads<WorkerDeployment>(
      db,
      "select payload from worker_deployments order by workspace_id, updated_at, id",
    ),
    workerRuns: loadWorkerPayloads<WorkerRun>(
      db,
      "select payload from worker_runs order by workspace_id, updated_at, id",
    ),
    workerCheckpoints: loadWorkerPayloads<WorkerCheckpoint>(
      db,
      "select payload from worker_checkpoints order by workspace_id, worker_run_id, sequence",
    ),
    workerEffectReceipts: loadWorkerPayloads<WorkerEffectReceipt>(
      db,
      "select payload from worker_effect_receipts order by workspace_id, worker_run_id, prepared_at, id",
    ),
    workerDeploymentRollouts: loadWorkerPayloads<WorkerDeploymentRollout>(
      db,
      "select payload from worker_deployment_rollouts order by workspace_id, created_at, id",
    ),
    workerCommandReceipts: loadWorkerPayloads<WorkerLifecycleCommandReceipt>(
      db,
      "select payload from worker_command_receipts order by workspace_id, created_at, id",
    ),
    workerEvents: loadWorkerPayloads<WorkerEvent>(
      db,
      "select payload from worker_events order by workspace_id, sequence",
    ),
    workerEvidenceEntries: loadWorkerPayloads<WorkerEvidenceEntry>(
      db,
      "select payload from worker_evidence_entries order by workspace_id, sequence",
    ),
    workerArtifactManifests: loadWorkerPayloads<WorkerArtifactManifest>(
      db,
      "select payload from worker_artifact_manifests order by workspace_id, created_at, id",
    ),
    workerActivationInboxes: loadWorkerPayloads<WorkerActivationInboxRecord>(
      db,
      "select payload from worker_activation_inbox order by workspace_id, first_seen_at, id",
    ),
    workerActivationPayloads: loadWorkerPayloads<WorkerActivationPayloadRecord>(
      db,
      "select payload from worker_activation_payloads order by workspace_id, expires_at, id",
    ),
  };
}

function loadWorkerPayloads<T>(db: DatabaseSync, sql: string): T[] {
  const rows = db.prepare(sql).all() as Array<{ payload: string }>;
  return rows.map((row) => JSON.parse(row.payload) as T);
}

export function mergeDedicatedRelationalCollections(
  partial: Partial<PacketAgentData>,
  dedicatedCollections: DedicatedRelationalCollections,
): void {
  for (const collection of Object.keys(
    dedicatedCollections,
  ) as DedicatedRelationalCollectionKey[]) {
    const records = dedicatedCollections[collection];
    if (records.length > 0 || partial[collection] === undefined) {
      partial[collection] = records as never;
    }
  }
}

function loadDedicatedJobMetricSnapshots(db: DatabaseSync): JobMetricSnapshotRecord[] {
  const rows = db
    .prepare(
      `
    select id, captured_at, type, total_runs, succeeded_runs, failed_runs, canceled_runs,
      last_run_started_at, last_run_finished_at, last_duration_ms, average_duration_ms, p95_duration_ms
    from job_metric_snapshots
    order by captured_at asc, id asc
  `,
    )
    .all() as Array<{
    id: string;
    captured_at: string;
    type: string;
    total_runs: number;
    succeeded_runs: number;
    failed_runs: number;
    canceled_runs: number;
    last_run_started_at: string | null;
    last_run_finished_at: string | null;
    last_duration_ms: number | null;
    average_duration_ms: number | null;
    p95_duration_ms: number | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    capturedAt: row.captured_at,
    type: row.type,
    totalRuns: row.total_runs,
    succeededRuns: row.succeeded_runs,
    failedRuns: row.failed_runs,
    canceledRuns: row.canceled_runs,
    lastRunStartedAt: row.last_run_started_at,
    lastRunFinishedAt: row.last_run_finished_at,
    lastDurationMs: row.last_duration_ms,
    averageDurationMs: row.average_duration_ms,
    p95DurationMs: row.p95_duration_ms,
  }));
}

function loadDedicatedAlertEvents(db: DatabaseSync): AlertEventRecord[] {
  const rows = db
    .prepare(
      `
    select id, rule_id, severity, title, detail, observed_at, context,
      delivered, delivery_error, delivery_attempts, last_delivery_attempt_at, dead_lettered
    from alert_events
    order by observed_at desc, id asc
  `,
    )
    .all() as Array<{
    id: string;
    rule_id: string;
    severity: AlertEventRecord["severity"];
    title: string;
    detail: string;
    observed_at: string;
    context: string;
    delivered: number;
    delivery_error: string | null;
    delivery_attempts: number | null;
    last_delivery_attempt_at: string | null;
    dead_lettered: number | null;
  }>;
  return rows.map((row) => {
    const record: AlertEventRecord = {
      id: row.id,
      ruleId: row.rule_id,
      severity: row.severity,
      title: row.title,
      detail: row.detail,
      observedAt: row.observed_at,
      context: parseJsonRecord(row.context),
      delivered: row.delivered === 1,
    };
    if (row.delivery_error !== null) record.deliveryError = row.delivery_error;
    if (row.delivery_attempts !== null) record.deliveryAttempts = row.delivery_attempts;
    if (row.last_delivery_attempt_at !== null)
      record.lastDeliveryAttemptAt = row.last_delivery_attempt_at;
    if (row.dead_lettered !== null) record.deadLettered = row.dead_lettered === 1;
    return record;
  });
}

function loadDedicatedAgentRuns(db: DatabaseSync): AgentRunRecord[] {
  const rows = db
    .prepare(
      `
    select id, workspace_id, agent_id,
      worker_definition_id, worker_version_id, worker_deployment_id, worker_run_id,
      title, status, trigger_kind,
      started_at, completed_at, inputs, output, error,
      logs, tool_calls, transcript, model_used, cost_usd, evaluation,
      created_at, updated_at
    from agent_runs
    order by created_at desc, id asc
  `,
    )
    .all() as Array<{
    id: string;
    workspace_id: string;
    agent_id: string | null;
    worker_definition_id: string | null;
    worker_version_id: string | null;
    worker_deployment_id: string | null;
    worker_run_id: string | null;
    title: string;
    status: AgentRunStatus;
    trigger_kind: AgentTriggerKind | null;
    started_at: string | null;
    completed_at: string | null;
    inputs: string | null;
    output: string | null;
    error: string | null;
    logs: string;
    tool_calls: string | null;
    transcript: string | null;
    model_used: string | null;
    cost_usd: number | null;
    evaluation: string | null;
    created_at: string;
    updated_at: string;
  }>;
  return rows.map((row) => {
    const record: AgentRunRecord = {
      id: row.id,
      workspaceId: row.workspace_id,
      title: row.title,
      status: row.status,
      logs: parseJsonArrayValue<AgentRunLogEntry>(row.logs),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.agent_id !== null) record.agentId = row.agent_id;
    if (row.worker_definition_id !== null) {
      record.workerDefinitionId = row.worker_definition_id;
    }
    if (row.worker_version_id !== null) record.workerVersionId = row.worker_version_id;
    if (row.worker_deployment_id !== null) {
      record.workerDeploymentId = row.worker_deployment_id;
    }
    if (row.worker_run_id !== null) record.workerRunId = row.worker_run_id;
    if (row.trigger_kind !== null) record.triggerKind = row.trigger_kind;
    if (row.transcript !== null)
      record.transcript = parseJsonArrayValue<AgentRunStep>(row.transcript);
    if (row.started_at !== null) record.startedAt = row.started_at;
    if (row.completed_at !== null) record.completedAt = row.completed_at;
    if (row.inputs !== null)
      record.inputs = parseJsonRecord(row.inputs) as Record<string, string | number | boolean>;
    if (row.output !== null) record.output = row.output;
    if (row.error !== null) record.error = row.error;
    if (row.tool_calls !== null)
      record.toolCalls = parseJsonArrayValue<AgentRunToolCall>(row.tool_calls);
    if (row.model_used !== null) record.modelUsed = row.model_used;
    if (row.cost_usd !== null) record.costUsd = row.cost_usd;
    if (row.evaluation !== null) {
      const evaluation = parseJsonRecord(row.evaluation) as unknown as NonNullable<
        AgentRunRecord["evaluation"]
      >;
      record.evaluation = evaluation;
    }
    return record;
  });
}

function loadDedicatedJobs(db: DatabaseSync): JobRecord[] {
  const rows = db
    .prepare(
      `
    select id, workspace_id, type, payload, status, attempts, max_attempts,
      scheduled_at, started_at, completed_at, cron, result, error,
      cancel_requested, created_at, updated_at
    from jobs
    order by created_at desc, id asc
  `,
    )
    .all() as Array<{
    id: string;
    workspace_id: string;
    type: string;
    payload: string;
    status: JobStatus;
    attempts: number;
    max_attempts: number;
    scheduled_at: string;
    started_at: string | null;
    completed_at: string | null;
    cron: string | null;
    result: string | null;
    error: string | null;
    cancel_requested: number | null;
    created_at: string;
    updated_at: string;
  }>;
  return rows.map((row) => {
    const record: JobRecord = {
      id: row.id,
      workspaceId: row.workspace_id,
      type: row.type,
      payload: parseJsonRecord(row.payload),
      status: row.status,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      scheduledAt: row.scheduled_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.started_at !== null) record.startedAt = row.started_at;
    if (row.completed_at !== null) record.completedAt = row.completed_at;
    if (row.cron !== null) record.cron = row.cron;
    if (row.result !== null) record.result = parseJsonUnknown(row.result);
    if (row.error !== null) record.error = row.error;
    if (row.cancel_requested !== null) record.cancelRequested = row.cancel_requested === 1;
    return record;
  });
}

function loadDedicatedInvitationEmailDeliveries(db: DatabaseSync): InvitationEmailDeliveryRecord[] {
  const rows = db
    .prepare(
      `
    select id, workspace_id, invitation_id, recipient_email, subject,
      status, provider, mode, created_at, sent_at, error,
      provider_status, provider_delivery_id, provider_status_at, provider_error
    from invitation_email_deliveries
    order by created_at desc, id asc
  `,
    )
    .all() as Array<{
    id: string;
    workspace_id: string;
    invitation_id: string;
    recipient_email: string;
    subject: string;
    status: InvitationEmailDeliveryStatus;
    provider: string;
    mode: InvitationEmailDeliveryMode;
    created_at: string;
    sent_at: string | null;
    error: string | null;
    provider_status: string | null;
    provider_delivery_id: string | null;
    provider_status_at: string | null;
    provider_error: string | null;
  }>;
  return rows.map((row) => {
    const record: InvitationEmailDeliveryRecord = {
      id: row.id,
      workspaceId: row.workspace_id,
      invitationId: row.invitation_id,
      recipientEmail: row.recipient_email,
      subject: row.subject,
      status: row.status,
      provider: row.provider,
      mode: row.mode,
      createdAt: row.created_at,
    };
    if (row.sent_at !== null) record.sentAt = row.sent_at;
    if (row.error !== null) record.error = row.error;
    if (row.provider_status !== null) record.providerStatus = row.provider_status;
    if (row.provider_delivery_id !== null) record.providerDeliveryId = row.provider_delivery_id;
    if (row.provider_status_at !== null) record.providerStatusAt = row.provider_status_at;
    if (row.provider_error !== null) record.providerError = row.provider_error;
    return record;
  });
}

function loadDedicatedActivities(db: DatabaseSync): ActivityRecord[] {
  const rows = db
    .prepare(
      `
    select payload
    from activities
    order by occurred_at desc, id desc
  `,
    )
    .all() as Array<{ payload: string }>;
  return rows.map((row) => JSON.parse(row.payload) as ActivityRecord);
}

function loadDedicatedProviderCalls(db: DatabaseSync): ProviderCallRecord[] {
  const rows = db
    .prepare(
      `
    select id, workspace_id, route_key, provider, model, prompt_tokens,
      completion_tokens, cost_usd, duration_ms, status, error_message,
      started_at, completed_at
    from provider_calls
    order by completed_at asc, id asc
  `,
    )
    .all() as Array<{
    id: string;
    workspace_id: string;
    route_key: string;
    provider: ProviderCallRecord["provider"];
    model: string;
    prompt_tokens: number;
    completion_tokens: number;
    cost_usd: number;
    duration_ms: number;
    status: ProviderCallRecord["status"];
    error_message: string | null;
    started_at: string;
    completed_at: string;
  }>;
  return rows.map((row) => {
    const record: ProviderCallRecord = {
      id: row.id,
      workspaceId: row.workspace_id,
      routeKey: row.route_key,
      provider: row.provider,
      model: row.model,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      costUsd: row.cost_usd,
      durationMs: row.duration_ms,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
    if (row.error_message !== null) record.errorMessage = row.error_message;
    return record;
  });
}

function loadDedicatedActivationSignals(db: DatabaseSync): ActivationSignalRecord[] {
  const rows = db
    .prepare(
      `
    select id, workspace_id, kind, source, origin, source_id, stable_key, data, created_at, updated_at
    from activation_signals
    order by workspace_id asc, created_at asc, id asc
  `,
    )
    .all() as unknown as ActivationSignalRow[];
  return rows.map(activationSignalRowToRecord);
}

// ---------------------------------------------------------------------------
// Incremental dedicated-table persistence
//
// The store is a whole-document read-modify-write: a mutation loads the entire
// dataset, mutates it in memory, then persists it. Persisting by deleting and
// re-inserting every row of every dedicated table made one mutation cost scale
// with the total table size (the production incident: ~127k terminal jobs
// rewrote the whole `jobs` table on every write).
//
// `persistDedicatedRelationalRows` now diffs the mutated dataset against the
// snapshot captured when it was loaded and writes only rows that changed or
// disappeared. A row's signature is its serialized record, so the comparison is
// exact and independent of how the individual columns are stored.
// ---------------------------------------------------------------------------

/** Serialized signature of every dedicated row, keyed by table then row key. */
export type DedicatedRowSnapshot = Map<string, Map<string, string>>;

const ROW_KEY_SEPARATOR = "\u0000";

interface DedicatedTableSpec<T> {
  table: string;
  columns: string[];
  keyColumns: string[];
  keyValues: (record: T) => string[];
  values: (record: T) => SQLInputValue[];
}

interface DedicatedTablePlan {
  table: string;
  columns: string[];
  keyColumns: string[];
  rows: Array<{
    key: string;
    signature: string;
    values: SQLInputValue[];
  }>;
}

function buildTablePlan<T>(spec: DedicatedTableSpec<T>, records: readonly T[]): DedicatedTablePlan {
  return {
    table: spec.table,
    columns: spec.columns,
    keyColumns: spec.keyColumns,
    rows: records.map((record) => {
      const keyValues = spec.keyValues(record);
      return {
        key: keyValues.join(ROW_KEY_SEPARATOR),
        signature: JSON.stringify(record),
        values: spec.values(record),
      };
    }),
  };
}

// Rows are deleted children-first so a removed parent never trips
// `on delete restrict`. Upserts run in the reverse (dependency) order — the
// order of `dedicatedTablePlans` — so a new child always follows its parent.
const DEDICATED_TABLE_DELETE_ORDER = [
  "packet_product_event_acknowledgements",
  "worker_package_deployments",
  "worker_package_receipts",
  "packet_product_credentials",
  "worker_artifact_manifests",
  "worker_evidence_entries",
  "worker_activation_inbox",
  "worker_activation_payloads",
  "worker_events",
  "worker_command_receipts",
  "worker_deployment_rollouts",
  "worker_effect_receipts",
  "worker_checkpoints",
  "worker_runs",
  "worker_deployments",
  "worker_versions",
  "worker_definitions",
  "job_metric_snapshots",
  "alert_events",
  "agent_runs",
  "jobs",
  "invitation_email_deliveries",
  "activities",
  "provider_calls",
  "activation_signals",
] as const;

function dedicatedTablePlans(data: PacketAgentData): DedicatedTablePlan[] {
  return [
    buildTablePlan<JobMetricSnapshotRecord>(
      {
        table: "job_metric_snapshots",
        keyColumns: ["id"],
        columns: [
          "id",
          "captured_at",
          "type",
          "total_runs",
          "succeeded_runs",
          "failed_runs",
          "canceled_runs",
          "last_run_started_at",
          "last_run_finished_at",
          "last_duration_ms",
          "average_duration_ms",
          "p95_duration_ms",
        ],
        keyValues: (record) => [record.id],
        values: (record) => [
          record.id,
          record.capturedAt,
          record.type,
          record.totalRuns,
          record.succeededRuns,
          record.failedRuns,
          record.canceledRuns,
          record.lastRunStartedAt ?? null,
          record.lastRunFinishedAt ?? null,
          record.lastDurationMs ?? null,
          record.averageDurationMs ?? null,
          record.p95DurationMs ?? null,
        ],
      },
      data.jobMetricSnapshots ?? [],
    ),
    buildTablePlan<AlertEventRecord>(
      {
        table: "alert_events",
        keyColumns: ["id"],
        columns: [
          "id",
          "rule_id",
          "severity",
          "title",
          "detail",
          "observed_at",
          "context",
          "delivered",
          "delivery_error",
          "delivery_attempts",
          "last_delivery_attempt_at",
          "dead_lettered",
        ],
        keyValues: (record) => [record.id],
        values: (record) => [
          record.id,
          record.ruleId,
          record.severity,
          record.title,
          record.detail,
          record.observedAt,
          JSON.stringify(record.context ?? {}),
          record.delivered ? 1 : 0,
          record.deliveryError ?? null,
          record.deliveryAttempts ?? null,
          record.lastDeliveryAttemptAt ?? null,
          record.deadLettered === undefined ? null : record.deadLettered ? 1 : 0,
        ],
      },
      data.alertEvents ?? [],
    ),
    buildTablePlan<AgentRunRecord>(
      {
        table: "agent_runs",
        keyColumns: ["id"],
        columns: [
          "id",
          "workspace_id",
          "agent_id",
          "worker_definition_id",
          "worker_version_id",
          "worker_deployment_id",
          "worker_run_id",
          "title",
          "status",
          "trigger_kind",
          "started_at",
          "completed_at",
          "inputs",
          "output",
          "error",
          "logs",
          "tool_calls",
          "transcript",
          "model_used",
          "cost_usd",
          "evaluation",
          "created_at",
          "updated_at",
        ],
        keyValues: (record) => [record.id],
        values: (record) => [
          record.id,
          record.workspaceId,
          record.agentId ?? null,
          record.workerDefinitionId ?? null,
          record.workerVersionId ?? null,
          record.workerDeploymentId ?? null,
          record.workerRunId ?? null,
          record.title,
          record.status,
          record.triggerKind ?? null,
          record.startedAt ?? null,
          record.completedAt ?? null,
          record.inputs === undefined ? null : JSON.stringify(record.inputs),
          record.output ?? null,
          record.error ?? null,
          JSON.stringify(record.logs ?? []),
          record.toolCalls === undefined ? null : JSON.stringify(record.toolCalls),
          record.transcript === undefined ? null : JSON.stringify(record.transcript),
          record.modelUsed ?? null,
          record.costUsd ?? null,
          record.evaluation === undefined ? null : JSON.stringify(record.evaluation),
          record.createdAt,
          record.updatedAt,
        ],
      },
      data.agentRuns ?? [],
    ),
    buildTablePlan<JobRecord>(
      {
        table: "jobs",
        keyColumns: ["id"],
        columns: [
          "id",
          "workspace_id",
          "type",
          "payload",
          "status",
          "attempts",
          "max_attempts",
          "scheduled_at",
          "started_at",
          "completed_at",
          "cron",
          "result",
          "error",
          "cancel_requested",
          "created_at",
          "updated_at",
        ],
        keyValues: (record) => [record.id],
        values: (record) => [
          record.id,
          record.workspaceId,
          record.type,
          JSON.stringify(record.payload ?? {}),
          record.status,
          record.attempts,
          record.maxAttempts,
          record.scheduledAt,
          record.startedAt ?? null,
          record.completedAt ?? null,
          record.cron ?? null,
          record.result === undefined ? null : JSON.stringify(record.result),
          record.error ?? null,
          record.cancelRequested === undefined ? null : record.cancelRequested ? 1 : 0,
          record.createdAt,
          record.updatedAt,
        ],
      },
      data.jobs ?? [],
    ),
    buildTablePlan<InvitationEmailDeliveryRecord>(
      {
        table: "invitation_email_deliveries",
        keyColumns: ["id"],
        columns: [
          "id",
          "workspace_id",
          "invitation_id",
          "recipient_email",
          "subject",
          "status",
          "provider",
          "mode",
          "created_at",
          "sent_at",
          "error",
          "provider_status",
          "provider_delivery_id",
          "provider_status_at",
          "provider_error",
        ],
        keyValues: (record) => [record.id],
        values: (record) => [
          record.id,
          record.workspaceId,
          record.invitationId,
          record.recipientEmail,
          record.subject,
          record.status,
          record.provider,
          record.mode,
          record.createdAt,
          record.sentAt ?? null,
          record.error ?? null,
          record.providerStatus ?? null,
          record.providerDeliveryId ?? null,
          record.providerStatusAt ?? null,
          record.providerError ?? null,
        ],
      },
      data.invitationEmailDeliveries ?? [],
    ),
    buildTablePlan<ActivityRecord>(
      {
        table: "activities",
        keyColumns: ["id"],
        columns: [
          "id",
          "workspace_id",
          "occurred_at",
          "type",
          "payload",
          "user_id",
          "related_subject",
        ],
        keyValues: (record) => [record.id],
        values: (record) => [
          record.id,
          record.workspaceId,
          record.occurredAt,
          record.event,
          JSON.stringify(record),
          record.actor.type === "user" ? record.actor.id : null,
          null,
        ],
      },
      data.activities ?? [],
    ),
    buildTablePlan<ProviderCallRecord>(
      {
        table: "provider_calls",
        keyColumns: ["id"],
        columns: [
          "id",
          "workspace_id",
          "route_key",
          "provider",
          "model",
          "prompt_tokens",
          "completion_tokens",
          "cost_usd",
          "duration_ms",
          "status",
          "error_message",
          "started_at",
          "completed_at",
        ],
        keyValues: (record) => [record.id],
        values: (record) => [
          record.id,
          record.workspaceId,
          record.routeKey,
          record.provider,
          record.model,
          record.promptTokens,
          record.completionTokens,
          record.costUsd,
          record.durationMs,
          record.status,
          record.errorMessage ?? null,
          record.startedAt,
          record.completedAt,
        ],
      },
      data.providerCalls ?? [],
    ),
    buildTablePlan<ActivationSignalRecord>(
      {
        table: "activation_signals",
        keyColumns: ["id"],
        columns: [
          "id",
          "workspace_id",
          "kind",
          "source",
          "origin",
          "source_id",
          "stable_key",
          "data",
          "created_at",
          "updated_at",
        ],
        keyValues: (record) => [record.id],
        values: (record) => [
          record.id,
          record.workspaceId,
          record.kind,
          record.source,
          record.origin ?? null,
          record.sourceId ?? null,
          record.stableKey ?? null,
          record.data === undefined ? null : JSON.stringify(record.data),
          record.createdAt,
          record.updatedAt,
        ],
      },
      (data.activationSignals ?? []).map(normalizeActivationSignalRecord),
    ),
    buildTablePlan<PacketProductCredentialRecord>(
      {
        table: "packet_product_credentials",
        keyColumns: ["workspace_id", "id"],
        columns: [
          "workspace_id",
          "id",
          "product",
          "subject_id",
          "status",
          "token_digest",
          "require_package_signature",
          "expires_at",
          "created_at",
          "updated_at",
          "payload",
        ],
        keyValues: (record) => [record.workspaceId, record.id],
        values: (record) => [
          record.workspaceId,
          record.id,
          record.product,
          record.subjectId,
          record.status,
          record.tokenDigest,
          record.requirePackageSignature ? 1 : 0,
          record.expiresAt ?? null,
          record.createdAt,
          record.updatedAt,
          JSON.stringify(record),
        ],
      },
      data.packetProductCredentials ?? [],
    ),
    buildTablePlan<WorkerPackageReceipt>(
      {
        table: "worker_package_receipts",
        keyColumns: ["workspace_id", "id"],
        columns: [
          "workspace_id",
          "id",
          "package_id",
          "package_version",
          "idempotency_key",
          "package_digest",
          "request_digest",
          "credential_id",
          "accepted_at",
          "payload",
        ],
        keyValues: (record) => [record.workspaceId, record.id],
        values: (record) => [
          record.workspaceId,
          record.id,
          record.packageId,
          record.packageVersion,
          record.idempotencyKey,
          record.packageDigest,
          record.requestDigest,
          record.credentialId,
          record.acceptedAt,
          JSON.stringify(record),
        ],
      },
      data.workerPackageReceipts ?? [],
    ),
    buildTablePlan<WorkerDefinition>(
      {
        table: "worker_definitions",
        keyColumns: ["workspace_id", "id"],
        columns: [
          "workspace_id",
          "id",
          "status",
          "name",
          "current_version_id",
          "updated_at",
          "payload",
        ],
        keyValues: (record) => [record.workspaceId, record.id],
        values: (record) => [
          record.workspaceId,
          record.id,
          record.status,
          record.name,
          record.currentVersionId ?? null,
          record.updatedAt,
          JSON.stringify(record),
        ],
      },
      data.workerDefinitions ?? [],
    ),
    buildTablePlan<WorkerVersion>(
      {
        table: "worker_versions",
        keyColumns: ["workspace_id", "id"],
        columns: [
          "workspace_id",
          "id",
          "worker_definition_id",
          "version",
          "status",
          "content_digest",
          "created_at",
          "payload",
        ],
        keyValues: (record) => [record.workspaceId, record.id],
        values: (record) => [
          record.workspaceId,
          record.id,
          record.workerDefinitionId,
          record.version,
          record.status,
          record.contentDigest,
          record.createdAt,
          JSON.stringify(record),
        ],
      },
      data.workerVersions ?? [],
    ),
    buildTablePlan<WorkerDeployment>(
      {
        table: "worker_deployments",
        keyColumns: ["workspace_id", "id"],
        columns: [
          "workspace_id",
          "id",
          "worker_definition_id",
          "worker_version_id",
          "status",
          "revision",
          "updated_at",
          "payload",
        ],
        keyValues: (record) => [record.workspaceId, record.id],
        values: (record) => [
          record.workspaceId,
          record.id,
          record.workerDefinitionId,
          record.workerVersionId,
          record.status,
          record.revision,
          record.updatedAt,
          JSON.stringify(record),
        ],
      },
      data.workerDeployments ?? [],
    ),
    buildTablePlan<WorkerPackageDeploymentRecord>(
      {
        table: "worker_package_deployments",
        keyColumns: ["workspace_id", "id"],
        columns: [
          "workspace_id",
          "id",
          "receipt_id",
          "package_id",
          "package_version",
          "package_digest",
          "worker_definition_id",
          "worker_version_id",
          "worker_deployment_id",
          "operation",
          "created_at",
          "payload",
        ],
        keyValues: (record) => [record.workspaceId, record.id],
        values: (record) => [
          record.workspaceId,
          record.id,
          record.receiptId,
          record.packageId,
          record.packageVersion,
          record.packageDigest,
          record.workerDefinitionId,
          record.workerVersionId,
          record.workerDeploymentId,
          record.operation,
          record.createdAt,
          JSON.stringify(record),
        ],
      },
      data.workerPackageDeployments ?? [],
    ),
    buildTablePlan<WorkerRun>(
      {
        table: "worker_runs",
        keyColumns: ["workspace_id", "id"],
        columns: [
          "workspace_id",
          "id",
          "worker_definition_id",
          "worker_version_id",
          "worker_deployment_id",
          "status",
          "attempt",
          "updated_at",
          "payload",
        ],
        keyValues: (record) => [record.workspaceId, record.id],
        values: (record) => [
          record.workspaceId,
          record.id,
          record.workerDefinitionId,
          record.workerVersionId,
          record.workerDeploymentId,
          record.status,
          record.attempt,
          record.updatedAt,
          JSON.stringify(record),
        ],
      },
      data.workerRuns ?? [],
    ),
    buildTablePlan<PacketProductEventAcknowledgementRecord>(
      {
        table: "packet_product_event_acknowledgements",
        keyColumns: ["workspace_id", "id"],
        columns: [
          "workspace_id",
          "id",
          "credential_id",
          "package_deployment_id",
          "worker_deployment_id",
          "stream_kind",
          "worker_run_id",
          "idempotency_key",
          "request_digest",
          "event_id",
          "workspace_sequence",
          "effective_event_id",
          "effective_workspace_sequence",
          "expected_revision",
          "disposition",
          "applied_revision",
          "acknowledged_at",
          "payload",
        ],
        keyValues: (record) => [record.workspaceId, record.id],
        values: (record) => [
          record.workspaceId,
          record.id,
          record.credentialId,
          record.packageDeploymentId,
          record.workerDeploymentId,
          record.streamKind,
          record.workerRunId ?? null,
          record.idempotencyKey,
          record.requestDigest,
          record.eventId,
          record.workspaceSequence,
          record.effectiveEventId,
          record.effectiveWorkspaceSequence,
          record.expectedRevision,
          record.disposition,
          record.appliedRevision,
          record.acknowledgedAt,
          JSON.stringify(record),
        ],
      },
      data.packetProductEventAcknowledgements ?? [],
    ),
    buildTablePlan<WorkerActivationPayloadRecord>(
      {
        table: "worker_activation_payloads",
        keyColumns: ["workspace_id", "id"],
        columns: [
          "workspace_id",
          "id",
          "reference",
          "digest",
          "classification",
          "byte_length",
          "expires_at",
          "payload",
        ],
        keyValues: (record) => [record.workspaceId, record.id],
        values: (record) => [
          record.workspaceId,
          record.id,
          record.reference,
          record.digest,
          record.classification,
          record.byteLength,
          record.expiresAt,
          JSON.stringify(record),
        ],
      },
      data.workerActivationPayloads ?? [],
    ),
    buildTablePlan<WorkerActivationInboxRecord>(
      {
        table: "worker_activation_inbox",
        keyColumns: ["workspace_id", "id"],
        columns: [
          "workspace_id",
          "id",
          "worker_deployment_id",
          "worker_version_id",
          "trigger_id",
          "source",
          "delivery_id",
          "request_digest",
          "disposition",
          "worker_run_id",
          "execution_job_id",
          "first_seen_at",
          "last_seen_at",
          "duplicate_count",
          "payload",
        ],
        keyValues: (record) => [record.workspaceId, record.id],
        values: (record) => [
          record.workspaceId,
          record.id,
          record.workerDeploymentId,
          record.workerVersionId,
          record.triggerId,
          record.source,
          record.deliveryId,
          record.requestDigest,
          record.disposition,
          record.workerRunId ?? null,
          record.executionJobId ?? null,
          record.firstSeenAt,
          record.lastSeenAt,
          record.duplicateCount,
          JSON.stringify(record),
        ],
      },
      data.workerActivationInboxes ?? [],
    ),
    buildTablePlan<WorkerCheckpoint>(
      {
        table: "worker_checkpoints",
        keyColumns: ["workspace_id", "id"],
        columns: [
          "workspace_id",
          "id",
          "worker_run_id",
          "worker_version_id",
          "sequence",
          "created_at",
          "payload",
        ],
        keyValues: (record) => [record.workspaceId, record.id],
        values: (record) => [
          record.workspaceId,
          record.id,
          record.workerRunId,
          record.workerVersionId,
          record.sequence,
          record.createdAt,
          JSON.stringify(record),
        ],
      },
      data.workerCheckpoints ?? [],
    ),
    buildTablePlan<WorkerEffectReceipt>(
      {
        table: "worker_effect_receipts",
        keyColumns: ["workspace_id", "id"],
        columns: [
          "workspace_id",
          "id",
          "worker_run_id",
          "worker_version_id",
          "worker_deployment_id",
          "effect_key",
          "iteration",
          "action_id",
          "capability_id",
          "tool_name",
          "operation",
          "input_digest",
          "classification",
          "status",
          "prepared_at",
          "completed_at",
          "payload",
        ],
        keyValues: (record) => [record.workspaceId, record.id],
        values: (record) => [
          record.workspaceId,
          record.id,
          record.workerRunId,
          record.workerVersionId,
          record.workerDeploymentId,
          record.effectKey,
          record.iteration,
          record.actionId,
          record.capabilityId,
          record.toolName,
          record.operation,
          record.inputDigest,
          record.classification,
          record.status,
          record.preparedAt,
          record.completedAt ?? null,
          JSON.stringify(record),
        ],
      },
      data.workerEffectReceipts ?? [],
    ),
    buildTablePlan<WorkerDeploymentRollout>(
      {
        table: "worker_deployment_rollouts",
        keyColumns: ["workspace_id", "id"],
        columns: [
          "workspace_id",
          "id",
          "worker_definition_id",
          "from_deployment_id",
          "to_deployment_id",
          "kind",
          "created_at",
          "payload",
        ],
        keyValues: (record) => [record.workspaceId, record.id],
        values: (record) => [
          record.workspaceId,
          record.id,
          record.workerDefinitionId,
          record.fromDeploymentId,
          record.toDeploymentId,
          record.kind,
          record.createdAt,
          JSON.stringify(record),
        ],
      },
      data.workerDeploymentRollouts ?? [],
    ),
    buildTablePlan<WorkerLifecycleCommandReceipt>(
      {
        table: "worker_command_receipts",
        keyColumns: ["workspace_id", "id"],
        columns: [
          "workspace_id",
          "id",
          "idempotency_key",
          "operation",
          "target_id",
          "request_digest",
          "created_at",
          "payload",
        ],
        keyValues: (record) => [record.workspaceId, record.id],
        values: (record) => [
          record.workspaceId,
          record.id,
          record.idempotencyKey,
          record.operation,
          record.targetId ?? null,
          record.requestDigest,
          record.createdAt,
          JSON.stringify(record),
        ],
      },
      data.workerCommandReceipts ?? [],
    ),
    buildTablePlan<WorkerEvent>(
      {
        table: "worker_events",
        keyColumns: ["workspace_id", "id"],
        columns: [
          "workspace_id",
          "id",
          "sequence",
          "type",
          "worker_definition_id",
          "worker_version_id",
          "worker_deployment_id",
          "worker_run_id",
          "source",
          "deployment_sequence",
          "run_sequence",
          "evidence_id",
          "event_digest",
          "occurred_at",
          "payload",
        ],
        keyValues: (record) => [record.workspaceId, record.id],
        values: (record) => {
          const v2 = record.schemaVersion === "packetagent.worker-event/v2" ? record : undefined;
          return [
            record.workspaceId,
            record.id,
            record.sequence,
            record.type,
            record.workerDefinitionId,
            record.workerVersionId ?? null,
            record.workerDeploymentId ?? null,
            v2?.workerRunId ?? null,
            v2?.source ?? null,
            v2?.deploymentSequence ?? null,
            v2?.runSequence ?? null,
            v2?.evidenceId ?? null,
            v2?.eventDigest ?? null,
            record.occurredAt,
            JSON.stringify(record),
          ];
        },
      },
      data.workerEvents ?? [],
    ),
    buildTablePlan<WorkerEvidenceEntry>(
      {
        table: "worker_evidence_entries",
        keyColumns: ["workspace_id", "id"],
        columns: [
          "workspace_id",
          "id",
          "sequence",
          "worker_definition_id",
          "worker_version_id",
          "worker_deployment_id",
          "worker_run_id",
          "source_event_id",
          "created_at",
          "payload",
        ],
        keyValues: (record) => [record.workspaceId, record.id],
        values: (record) => [
          record.workspaceId,
          record.id,
          record.sequence,
          record.workerDefinitionId,
          record.workerVersionId ?? null,
          record.workerDeploymentId ?? null,
          record.workerRunId ?? null,
          record.sourceEventId,
          record.createdAt,
          JSON.stringify(record),
        ],
      },
      data.workerEvidenceEntries ?? [],
    ),
    buildTablePlan<WorkerArtifactManifest>(
      {
        table: "worker_artifact_manifests",
        keyColumns: ["workspace_id", "id"],
        columns: [
          "workspace_id",
          "id",
          "worker_definition_id",
          "worker_version_id",
          "worker_deployment_id",
          "worker_run_id",
          "created_at",
          "expires_at",
          "manifest_digest",
          "payload",
        ],
        keyValues: (record) => [record.workspaceId, record.id],
        values: (record) => [
          record.workspaceId,
          record.id,
          record.workerDefinitionId,
          record.workerVersionId,
          record.workerDeploymentId,
          record.workerRunId,
          record.createdAt,
          record.expiresAt ?? null,
          record.manifestDigest,
          JSON.stringify(record),
        ],
      },
      data.workerArtifactManifests ?? [],
    ),
  ];
}

/** Capture the serialized signature of every dedicated row currently in `data`. */
export function snapshotDedicatedRelationalRows(data: PacketAgentData): DedicatedRowSnapshot {
  const snapshot: DedicatedRowSnapshot = new Map();
  for (const plan of dedicatedTablePlans(data)) {
    snapshot.set(plan.table, new Map(plan.rows.map((row) => [row.key, row.signature])));
  }
  return snapshot;
}

function upsertStatementSql(plan: DedicatedTablePlan): string {
  const placeholders = plan.columns.map(() => "?").join(", ");
  const updates = plan.columns
    .filter((column) => !plan.keyColumns.includes(column))
    .map((column) => `${column} = excluded.${column}`)
    .join(", ");
  return `insert into ${plan.table} (${plan.columns.join(", ")}) values (${placeholders}) on conflict(${plan.keyColumns.join(", ")}) do update set ${updates}`;
}

/**
 * Persist the dedicated tables. With a `snapshot` (the signature captured when
 * the dataset was loaded) only changed/removed rows are written; without one the
 * tables are cleared and fully re-inserted, which is what seed/reset need.
 */
export function persistDedicatedRelationalRows(
  db: DatabaseSync,
  data: PacketAgentData,
  snapshot?: DedicatedRowSnapshot,
): void {
  const plans = dedicatedTablePlans(data);
  const plansByTable = new Map(plans.map((plan) => [plan.table, plan]));

  if (!snapshot) {
    for (const table of DEDICATED_TABLE_DELETE_ORDER) {
      db.exec(`delete from ${table}`);
    }
  } else {
    for (const table of DEDICATED_TABLE_DELETE_ORDER) {
      const plan = plansByTable.get(table);
      const previous = snapshot.get(table);
      if (!plan || !previous || previous.size === 0) continue;
      const present = new Set(plan.rows.map((row) => row.key));
      const removed = [...previous.keys()].filter((key) => !present.has(key));
      if (removed.length === 0) continue;
      const statement = db.prepare(
        `delete from ${table} where ${plan.keyColumns.map((column) => `${column} = ?`).join(" and ")}`,
      );
      for (const key of removed) {
        statement.run(...key.split(ROW_KEY_SEPARATOR));
      }
    }
  }

  for (const plan of plans) {
    const previous = snapshot?.get(plan.table);
    if (previous && plan.rows.every((row) => previous.get(row.key) === row.signature)) {
      continue;
    }
    const statement = db.prepare(upsertStatementSql(plan));
    for (const row of plan.rows) {
      if (previous?.get(row.key) === row.signature) continue;
      statement.run(...row.values);
    }
  }
}

export function parseJsonRecord(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

export function parseJsonArrayValue<T>(raw: string | null | undefined): T[] {
  if (raw === null || raw === undefined) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function parseJsonUnknown(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export interface ActivationSignalRow {
  id: string;
  workspace_id: string;
  kind: ActivationSignalKind;
  source: ActivationSignalSource;
  origin: ActivationSignalOrigin | null;
  source_id: string | null;
  stable_key: string | null;
  data: string | null;
  created_at: string;
  updated_at: string;
}

export function readDedicatedActivationSignalsForWorkspace(
  db: DatabaseSync,
  workspaceId: string,
): ActivationSignalRecord[] {
  const rows = db
    .prepare(
      `
    select id, workspace_id, kind, source, origin, source_id, stable_key, data, created_at, updated_at
    from activation_signals
    where workspace_id = ?
    order by created_at asc, id asc
  `,
    )
    .all(workspaceId) as unknown as ActivationSignalRow[];
  return rows.map(activationSignalRowToRecord);
}

export function findDedicatedActivationSignalForUpsert(
  db: DatabaseSync,
  input: ActivationSignalUpsertInput,
): ActivationSignalRecord | null {
  const row = input.stableKey
    ? (db
        .prepare(
          `
      select id, workspace_id, kind, source, origin, source_id, stable_key, data, created_at, updated_at
      from activation_signals
      where workspace_id = ? and stable_key = ?
      limit 1
    `,
        )
        .get(input.workspaceId, input.stableKey) as ActivationSignalRow | undefined)
    : input.id
      ? (db
          .prepare(
            `
        select id, workspace_id, kind, source, origin, source_id, stable_key, data, created_at, updated_at
        from activation_signals
        where id = ?
        limit 1
      `,
          )
          .get(input.id) as ActivationSignalRow | undefined)
      : undefined;
  return row ? activationSignalRowToRecord(row) : null;
}

export function activationSignalRowToRecord(row: ActivationSignalRow): ActivationSignalRecord {
  const record: ActivationSignalRecord = {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.origin !== null) record.origin = row.origin;
  if (row.source_id !== null) record.sourceId = row.source_id;
  if (row.stable_key !== null) record.stableKey = row.stable_key;
  if (row.data !== null) record.data = parseJsonRecord(row.data) as ActivationSignalRecord["data"];
  return normalizeActivationSignalRecord(record);
}

export function upsertDedicatedActivationSignal(
  db: DatabaseSync,
  record: ActivationSignalRecord,
): void {
  db.prepare(
    `
    insert into activation_signals (
      id, workspace_id, kind, source, origin, source_id, stable_key, data, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(id) do update set
      workspace_id = excluded.workspace_id,
      kind = excluded.kind,
      source = excluded.source,
      origin = excluded.origin,
      source_id = excluded.source_id,
      stable_key = excluded.stable_key,
      data = excluded.data,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at
  `,
  ).run(
    record.id,
    record.workspaceId,
    record.kind,
    record.source,
    record.origin ?? null,
    record.sourceId ?? null,
    record.stableKey ?? null,
    record.data === undefined ? null : JSON.stringify(record.data),
    record.createdAt,
    record.updatedAt,
  );
}

export function mergeActivationSignals(
  primary: ActivationSignalRecord[],
  fallback: ActivationSignalRecord[],
): ActivationSignalRecord[] {
  const seen = new Set(primary.map((entry) => entry.id));
  const seenStableKeys = new Set(
    primary
      .filter((entry) => entry.stableKey)
      .map((entry) => `${entry.workspaceId}:${entry.stableKey}`),
  );
  const combined = primary.slice();
  for (const entry of fallback) {
    if (seen.has(entry.id)) continue;
    if (entry.stableKey && seenStableKeys.has(`${entry.workspaceId}:${entry.stableKey}`)) continue;
    seen.add(entry.id);
    if (entry.stableKey) seenStableKeys.add(`${entry.workspaceId}:${entry.stableKey}`);
    combined.push(entry);
  }
  return combined.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
}
