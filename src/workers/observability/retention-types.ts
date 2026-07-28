export const WORKER_RETENTION_POLICY_SCHEMA_VERSION =
  "packetagent.worker-retention-policy/v1" as const;

export const DEFAULT_WORKER_RETENTION_POLICY: WorkerRetentionPolicy = {
  schemaVersion: WORKER_RETENTION_POLICY_SCHEMA_VERSION,
  metadataDays: 365,
  summaryDays: 90,
  promptDays: 30,
  toolPayloadDays: 30,
  artifactDays: 90,
};

export interface WorkerRetentionPolicy {
  readonly schemaVersion: typeof WORKER_RETENTION_POLICY_SCHEMA_VERSION;
  readonly metadataDays: number;
  readonly summaryDays: number;
  readonly promptDays: number;
  readonly toolPayloadDays: number;
  readonly artifactDays: number;
}

export type WorkerRetentionCategory =
  | "metadata"
  | "summary"
  | "prompt"
  | "tool_payload"
  | "artifact";

export type WorkerRetentionResourceKind =
  | "worker_event"
  | "activation_payload"
  | "worker_run_input"
  | "worker_run_summary"
  | "checkpoint_chain"
  | "effect_result"
  | "artifact_bytes";

export interface WorkerRetentionCleanupInput {
  readonly workspaceId: string;
  readonly policy: WorkerRetentionPolicy;
  readonly dryRun?: boolean;
  readonly maxItems?: number;
  readonly maxDurationMs?: number;
}

export interface WorkerRetentionCategoryMetrics {
  readonly scanned: number;
  readonly eligible: number;
  readonly deleted: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface WorkerRetentionCleanupResult {
  readonly workspaceId: string;
  readonly policy: WorkerRetentionPolicy;
  readonly dryRun: boolean;
  readonly maxItems: number;
  readonly maxDurationMs: number;
  readonly processed: number;
  readonly deleted: number;
  readonly hasMore: boolean;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly elapsedMs: number;
  readonly categories: Readonly<Record<WorkerRetentionCategory, WorkerRetentionCategoryMetrics>>;
}

const MAX_RETENTION_DAYS = 3_650;

export function assertWorkerRetentionPolicy(
  value: unknown,
): asserts value is WorkerRetentionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Worker retention policy must be an object.");
  }
  const policy = value as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion",
    "metadataDays",
    "summaryDays",
    "promptDays",
    "toolPayloadDays",
    "artifactDays",
  ]);
  if (Object.keys(policy).some((key) => !allowed.has(key))) {
    throw new Error("Worker retention policy contains unsupported fields.");
  }
  if (policy.schemaVersion !== WORKER_RETENTION_POLICY_SCHEMA_VERSION) {
    throw new Error("Worker retention policy schema version is unsupported.");
  }
  for (const field of [
    "metadataDays",
    "summaryDays",
    "promptDays",
    "toolPayloadDays",
    "artifactDays",
  ] as const) {
    const days = policy[field];
    if (
      typeof days !== "number" ||
      !Number.isSafeInteger(days) ||
      days < 1 ||
      days > MAX_RETENTION_DAYS
    ) {
      throw new Error(`Worker retention ${field} must be an integer from 1 to 3650.`);
    }
  }
}
