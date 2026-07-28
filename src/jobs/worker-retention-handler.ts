import {
  loadStoreAsync as defaultLoadStore,
  type JobRecord,
  type PacketAgentData,
} from "../packetagent-store.js";
import { enqueueJobAsync as defaultEnqueue, type EnqueueJobInput } from "./store.js";
import { nextAfter } from "./cron.js";
import {
  createWorkerRetentionService,
  type WorkerRetentionService,
} from "../workers/observability/retention.js";
import {
  DEFAULT_WORKER_RETENTION_POLICY,
  WORKER_RETENTION_POLICY_SCHEMA_VERSION,
  assertWorkerRetentionPolicy,
  type WorkerRetentionCleanupResult,
  type WorkerRetentionPolicy,
} from "../workers/observability/retention-types.js";

export const WORKER_RETENTION_JOB_TYPE = "worker.observability.retention" as const;
export const WORKER_RETENTION_CRON_ENV = "PACKETAGENT_WORKER_RETENTION_CRON" as const;

const ACTIVE_RECURRING_STATUSES = new Set(["queued", "running", "success"]);

export interface WorkerRetentionJobPayload {
  readonly workspaceId: string;
  readonly policy: WorkerRetentionPolicy;
  readonly dryRun?: boolean;
  readonly maxItems?: number;
  readonly maxDurationMs?: number;
}

export interface WorkerRetentionJobHandler {
  readonly type: typeof WORKER_RETENTION_JOB_TYPE;
  handle(job: JobRecord): Promise<WorkerRetentionCleanupResult>;
}

export interface EnsureWorkerRetentionJobsDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly loadStore?: () => PacketAgentData | Promise<PacketAgentData>;
  readonly enqueue?: (input: EnqueueJobInput) => JobRecord | Promise<JobRecord>;
}

export interface EnsureWorkerRetentionJobsResult {
  readonly action: "skipped" | "ensured";
  readonly existing: number;
  readonly enqueued: number;
}

export function createWorkerRetentionJobHandler(
  service: WorkerRetentionService = createWorkerRetentionService(),
): WorkerRetentionJobHandler {
  return {
    type: WORKER_RETENTION_JOB_TYPE,
    async handle(job) {
      const payload = assertWorkerRetentionJobPayload(job.payload);
      if (payload.workspaceId !== job.workspaceId) {
        throw new Error("Worker retention job workspaceId must match the scheduler tenant.");
      }
      return service.cleanup(payload);
    },
  };
}

export async function ensureWorkerRetentionJobs(
  dependencies: EnsureWorkerRetentionJobsDependencies = {},
): Promise<EnsureWorkerRetentionJobsResult> {
  const env = dependencies.env ?? process.env;
  const cron = env[WORKER_RETENTION_CRON_ENV]?.trim();
  if (!cron) return { action: "skipped", existing: 0, enqueued: 0 };

  let scheduledAt: string;
  try {
    scheduledAt = nextAfter(cron, new Date()).toISOString();
  } catch (error) {
    console.warn(
      `${WORKER_RETENTION_JOB_TYPE}: invalid ${WORKER_RETENTION_CRON_ENV} expression ${JSON.stringify(cron)}; skipping bootstrap (${(error as Error).message})`,
    );
    return { action: "skipped", existing: 0, enqueued: 0 };
  }

  const loadStore = dependencies.loadStore ?? defaultLoadStore;
  const enqueue = dependencies.enqueue ?? defaultEnqueue;
  const data = await loadStore();
  const policy = policyFromEnvironment(env);
  const maxItems = integerFromEnvironment(env.PACKETAGENT_WORKER_RETENTION_MAX_ITEMS, 100, 500);
  const maxDurationMs = integerFromEnvironment(
    env.PACKETAGENT_WORKER_RETENTION_MAX_DURATION_MS,
    5_000,
    60_000,
  );
  const dryRun = truthy(env.PACKETAGENT_WORKER_RETENTION_DRY_RUN);
  let existing = 0;
  let enqueued = 0;

  for (const workspace of [...data.workspaces].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const present = data.jobs.some(
      (job) =>
        job.workspaceId === workspace.id &&
        job.type === WORKER_RETENTION_JOB_TYPE &&
        job.cron === cron &&
        ACTIVE_RECURRING_STATUSES.has(job.status),
    );
    if (present) {
      existing += 1;
      continue;
    }
    await enqueue({
      workspaceId: workspace.id,
      type: WORKER_RETENTION_JOB_TYPE,
      cron,
      scheduledAt,
      maxAttempts: 3,
      payload: {
        workspaceId: workspace.id,
        policy,
        dryRun,
        maxItems,
        maxDurationMs,
      },
    });
    enqueued += 1;
  }
  return { action: "ensured", existing, enqueued };
}

function assertWorkerRetentionJobPayload(
  value: Record<string, unknown>,
): WorkerRetentionJobPayload {
  const allowed = new Set(["workspaceId", "policy", "dryRun", "maxItems", "maxDurationMs"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("Worker retention job payload contains unsupported fields.");
  }
  if (typeof value.workspaceId !== "string" || !value.workspaceId.trim()) {
    throw new Error("Worker retention job requires an explicit workspaceId.");
  }
  assertWorkerRetentionPolicy(value.policy);
  if (value.dryRun !== undefined && typeof value.dryRun !== "boolean") {
    throw new Error("Worker retention job dryRun must be a boolean.");
  }
  assertOptionalBound(value.maxItems, "maxItems", 500);
  assertOptionalBound(value.maxDurationMs, "maxDurationMs", 60_000);
  return value as unknown as WorkerRetentionJobPayload;
}

function policyFromEnvironment(env: NodeJS.ProcessEnv): WorkerRetentionPolicy {
  return {
    schemaVersion: WORKER_RETENTION_POLICY_SCHEMA_VERSION,
    metadataDays: integerFromEnvironment(
      env.PACKETAGENT_WORKER_RETENTION_METADATA_DAYS,
      DEFAULT_WORKER_RETENTION_POLICY.metadataDays,
      3_650,
    ),
    summaryDays: integerFromEnvironment(
      env.PACKETAGENT_WORKER_RETENTION_SUMMARY_DAYS,
      DEFAULT_WORKER_RETENTION_POLICY.summaryDays,
      3_650,
    ),
    promptDays: integerFromEnvironment(
      env.PACKETAGENT_WORKER_RETENTION_PROMPT_DAYS,
      DEFAULT_WORKER_RETENTION_POLICY.promptDays,
      3_650,
    ),
    toolPayloadDays: integerFromEnvironment(
      env.PACKETAGENT_WORKER_RETENTION_TOOL_PAYLOAD_DAYS,
      DEFAULT_WORKER_RETENTION_POLICY.toolPayloadDays,
      3_650,
    ),
    artifactDays: integerFromEnvironment(
      env.PACKETAGENT_WORKER_RETENTION_ARTIFACT_DAYS,
      DEFAULT_WORKER_RETENTION_POLICY.artifactDays,
      3_650,
    ),
  };
}

function integerFromEnvironment(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  if (!value || !/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : fallback;
}

function assertOptionalBound(value: unknown, label: string, maximum: number): void {
  if (
    value !== undefined &&
    (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum)
  ) {
    throw new Error(`Worker retention job ${label} must be an integer from 1 to ${maximum}.`);
  }
}

function truthy(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
