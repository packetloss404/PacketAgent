import { snapshotJobMetricsAsync, type SnapshotJobMetricsResult } from "./job-metrics-snapshot.js";
import { enqueueJob, enqueueJobAsync, type EnqueueJobInput } from "./store.js";
import { nextAfter } from "./cron.js";
import { loadStore as defaultLoadStore, loadStoreAsync as defaultLoadStoreAsync, type JobRecord, type PacketAgentData } from "../packetagent-store.js";

export const METRICS_SNAPSHOT_JOB_TYPE = "metrics.snapshot" as const;

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_WORKSPACE_ID = "__system__";
const ACTIVE_RECURRING_STATUSES = new Set(["queued", "running", "success"]);

export interface MetricsSnapshotJobPayload {
  retentionDays?: number;
}

export interface MetricsSnapshotJobResult {
  snapshotCount: number;
  removed: number;
  capturedAt: string;
}

export interface MetricsSnapshotHandlerDeps {
  snapshot?: (options: { retentionDays?: number }) => SnapshotJobMetricsResult | Promise<SnapshotJobMetricsResult>;
}

export interface EnsureMetricsSnapshotCronJobDeps {
  env?: NodeJS.ProcessEnv;
  loadStore?: () => PacketAgentData;
  enqueue?: (input: EnqueueJobInput) => JobRecord;
}

export interface EnsureMetricsSnapshotCronJobAsyncDeps {
  env?: NodeJS.ProcessEnv;
  loadStore?: () => PacketAgentData | Promise<PacketAgentData>;
  enqueue?: (input: EnqueueJobInput) => JobRecord | Promise<JobRecord>;
}

export interface EnsureMetricsSnapshotCronJobResult {
  action: "skipped" | "enqueued" | "exists";
  jobId?: string;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseRetentionFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_RETENTION_DAYS;
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return DEFAULT_RETENTION_DAYS;
  const parsed = parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_RETENTION_DAYS;
  return parsed;
}

export async function handleMetricsSnapshotJob(
  payload: MetricsSnapshotJobPayload,
  deps: MetricsSnapshotHandlerDeps = {},
): Promise<MetricsSnapshotJobResult> {
  const snapshot = deps.snapshot ?? snapshotJobMetricsAsync;
  const retentionDays = payload?.retentionDays ?? DEFAULT_RETENTION_DAYS;
  if (!isNonNegativeInteger(retentionDays)) {
    throw new Error("retentionDays must be a non-negative integer");
  }
  const result: SnapshotJobMetricsResult = await snapshot({ retentionDays });
  return {
    snapshotCount: result.snapshots.length,
    removed: result.removed,
    capturedAt: result.capturedAt,
  };
}

export function ensureMetricsSnapshotCronJob(
  deps: EnsureMetricsSnapshotCronJobDeps = {},
): EnsureMetricsSnapshotCronJobResult {
  const env = deps.env ?? process.env;
  const loadStore = deps.loadStore ?? defaultLoadStore;
  const enqueue = deps.enqueue ?? enqueueJob;

  const cron = env.PACKETAGENT_JOB_METRICS_SNAPSHOT_CRON?.trim();
  if (!cron) return { action: "skipped" };

  let firstRun: Date;
  try {
    firstRun = nextAfter(cron, new Date());
  } catch (error) {
    console.warn(
      `metrics.snapshot: invalid PACKETAGENT_JOB_METRICS_SNAPSHOT_CRON expression ${JSON.stringify(cron)}; skipping bootstrap (${(error as Error).message})`,
    );
    return { action: "skipped" };
  }

  const data = loadStore();
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  const existing = jobs.find(
    (job) =>
      job.type === METRICS_SNAPSHOT_JOB_TYPE &&
      job.cron === cron &&
      ACTIVE_RECURRING_STATUSES.has(job.status),
  );
  if (existing) return { action: "exists", jobId: existing.id };

  const workspaceId = env.PACKETAGENT_JOB_METRICS_SNAPSHOT_WORKSPACE_ID?.trim() || DEFAULT_WORKSPACE_ID;
  const retentionDays = parseRetentionFromEnv(env.PACKETAGENT_JOB_METRICS_SNAPSHOT_RETENTION_DAYS);

  const created = enqueue({
    workspaceId,
    type: METRICS_SNAPSHOT_JOB_TYPE,
    payload: { retentionDays },
    cron,
    scheduledAt: firstRun.toISOString(),
  });

  return { action: "enqueued", jobId: created.id };
}

export async function ensureMetricsSnapshotCronJobAsync(
  deps: EnsureMetricsSnapshotCronJobAsyncDeps = {},
): Promise<EnsureMetricsSnapshotCronJobResult> {
  const env = deps.env ?? process.env;
  const loadStore = deps.loadStore ?? defaultLoadStoreAsync;
  const enqueue = deps.enqueue ?? enqueueJobAsync;

  const cron = env.PACKETAGENT_JOB_METRICS_SNAPSHOT_CRON?.trim();
  if (!cron) return { action: "skipped" };

  let firstRun: Date;
  try {
    firstRun = nextAfter(cron, new Date());
  } catch (error) {
    console.warn(
      `metrics.snapshot: invalid PACKETAGENT_JOB_METRICS_SNAPSHOT_CRON expression ${JSON.stringify(cron)}; skipping bootstrap (${(error as Error).message})`,
    );
    return { action: "skipped" };
  }

  const data = await loadStore();
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  const existing = jobs.find(
    (job) =>
      job.type === METRICS_SNAPSHOT_JOB_TYPE &&
      job.cron === cron &&
      ACTIVE_RECURRING_STATUSES.has(job.status),
  );
  if (existing) return { action: "exists", jobId: existing.id };

  const workspaceId = env.PACKETAGENT_JOB_METRICS_SNAPSHOT_WORKSPACE_ID?.trim() || DEFAULT_WORKSPACE_ID;
  const retentionDays = parseRetentionFromEnv(env.PACKETAGENT_JOB_METRICS_SNAPSHOT_RETENTION_DAYS);

  const created = await enqueue({
    workspaceId,
    type: METRICS_SNAPSHOT_JOB_TYPE,
    payload: { retentionDays },
    cron,
    scheduledAt: firstRun.toISOString(),
  });

  return { action: "enqueued", jobId: created.id };
}
