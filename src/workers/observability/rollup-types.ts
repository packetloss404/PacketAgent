import type { JobStatus, ProviderCallRecord } from "../../store/types.js";
import type { WorkerEvidenceSourceKind } from "./types.js";
import type { WorkerBudgetUsage, WorkerRunStatus, WorkerRunTerminalReason } from "../types.js";
import type {
  WorkerApprovalGrantStatus,
  WorkerApprovalScope,
  WorkerAttentionRequestStatus,
} from "../control-types.js";

export const WORKER_OBSERVABILITY_ROLLUP_SCHEMA_VERSION =
  "packetagent.worker-observability-rollup/v1" as const;

export type WorkerObservabilityRollupScopeKind = "version" | "deployment" | "run";

export interface WorkerObservabilityRollupIdentity {
  readonly kind: WorkerObservabilityRollupScopeKind;
  readonly workerDefinitionId: string;
  readonly workerVersionId: string;
  readonly workerDeploymentId?: string;
  readonly workerRunId?: string;
}

export interface WorkerProviderCallRollup {
  readonly calls: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly canceled: number;
  readonly missingSourceRecords: number;
  readonly uncorrelatedEvents: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly costUsd: number;
  readonly durationMs: number;
  readonly byProvider: Readonly<
    Partial<
      Record<
        ProviderCallRecord["provider"],
        {
          readonly calls: number;
          readonly costUsd: number;
        }
      >
    >
  >;
}

export interface WorkerToolCallRollup {
  readonly attempted: number;
  readonly completed: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly unresolved: number;
  readonly denied: number;
  readonly durationMs: number;
}

export interface WorkerEffectRollup {
  readonly total: number;
  readonly prepared: number;
  readonly completed: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly timedOut: number;
  readonly durationMs: number;
}

export interface WorkerRetryRollup {
  readonly executionAttempts: number;
  readonly jobRetries: number;
  readonly recoveryRequeues: number;
  readonly providerFailures: number;
  readonly phaseFailures: number;
  readonly scheduledBackoffMs: number;
}

export interface WorkerQueueRollup {
  readonly jobs: number;
  readonly statusCounts: Readonly<Partial<Record<JobStatus, number>>>;
  readonly startedSamples: number;
  readonly pendingSamples: number;
  readonly totalDurationMs: number;
  readonly averageDurationMs: number | null;
  readonly maximumDurationMs: number | null;
}

export interface WorkerApprovalRollup {
  readonly requests: number;
  readonly requestStatusCounts: Readonly<Partial<Record<WorkerAttentionRequestStatus, number>>>;
  readonly grants: number;
  readonly grantStatusCounts: Readonly<Partial<Record<WorkerApprovalGrantStatus, number>>>;
  readonly grantScopeCounts: Readonly<Partial<Record<WorkerApprovalScope, number>>>;
}

export interface WorkerCheckpointRollup {
  readonly count: number;
  readonly latestId?: string;
  readonly latestSequence?: number;
  readonly latestCreatedAt?: string;
}

export interface WorkerBudgetRollup {
  readonly reportedUsage: WorkerBudgetUsage;
  readonly reservations: number;
  readonly reservedProviderCostUsd: number;
  readonly settledProviderCostUsd: number;
  readonly releasedProviderCostUsd: number;
  readonly reservedBillableActions: number;
  readonly settledBillableActions: number;
  readonly releasedBillableActions: number;
}

export interface WorkerArtifactRollup {
  readonly count: number;
  readonly totalBytes: number;
  readonly publicMetadata: number;
  readonly internal: number;
  readonly sensitiveReferences: number;
}

export interface WorkerOutcomeRollup {
  readonly runs: number;
  readonly statusCounts: Readonly<Partial<Record<WorkerRunStatus, number>>>;
  readonly terminalReasonCounts: Readonly<Partial<Record<WorkerRunTerminalReason, number>>>;
  readonly exitEvaluations: number;
  readonly matchedExitPredicates: number;
  readonly unmatchedExitPredicates: number;
}

export interface WorkerSourceGapRollup {
  readonly total: number;
  readonly byKind: Readonly<Partial<Record<WorkerEvidenceSourceKind, number>>>;
}

export interface WorkerObservabilityRollup {
  readonly schemaVersion: typeof WORKER_OBSERVABILITY_ROLLUP_SCHEMA_VERSION;
  readonly workspaceId: string;
  readonly identity: WorkerObservabilityRollupIdentity;
  readonly computedThroughSequence: number;
  readonly firstOccurredAt?: string;
  readonly lastOccurredAt?: string;
  readonly events: number;
  readonly evidenceEntries: number;
  readonly legacyEvents: number;
  readonly relatedActivities: number;
  readonly providers: WorkerProviderCallRollup;
  readonly tools: WorkerToolCallRollup;
  readonly effects: WorkerEffectRollup;
  readonly retries: WorkerRetryRollup;
  readonly queue: WorkerQueueRollup;
  readonly approvals: WorkerApprovalRollup;
  readonly checkpoints: WorkerCheckpointRollup;
  readonly budget: WorkerBudgetRollup;
  readonly artifacts: WorkerArtifactRollup;
  readonly outcomes: WorkerOutcomeRollup;
  readonly sourceGaps: WorkerSourceGapRollup;
}

export interface WorkerObservabilityRollupSet {
  readonly schemaVersion: typeof WORKER_OBSERVABILITY_ROLLUP_SCHEMA_VERSION;
  readonly workspaceId: string;
  readonly computedThroughSequence: number;
  readonly versions: readonly WorkerObservabilityRollup[];
  readonly deployments: readonly WorkerObservabilityRollup[];
  readonly runs: readonly WorkerObservabilityRollup[];
}
