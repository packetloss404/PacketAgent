import { evaluateAlerts, type AlertEvent } from "./alert-engine.js";
import {
  deliverAlertWebhook,
  resolveAlertWebhookConfig,
  type AlertWebhookConfig,
} from "./alert-webhook.js";
import { recordAlertsAsync } from "./alert-store.js";
import { getOperationsHealthAsync, type OperationsHealthReport } from "../operations-health.js";
import { getJobTypeMetrics, type JobTypeMetrics } from "../jobs/scheduler-metrics.js";
import { enqueueJob, enqueueJobAsync, type EnqueueJobInput } from "../jobs/store.js";
import { activateWorkerAlertEvents } from "../workers/adapters.js";
import { nextAfter } from "../jobs/cron.js";
import { loadStore as defaultLoadStore, loadStoreAsync as defaultLoadStoreAsync, type JobRecord, type PacketAgentData } from "../packetagent-store.js";

export const ALERTS_EVALUATE_JOB_TYPE = "alerts.evaluate" as const;

export const ALERT_JOB_FAILURE_RATE_THRESHOLD_ENV = "PACKETAGENT_ALERT_JOB_FAILURE_RATE_THRESHOLD";
export const ALERT_JOB_FAILURE_MIN_SAMPLES_ENV = "PACKETAGENT_ALERT_JOB_FAILURE_MIN_SAMPLES";
export const ALERT_EVALUATE_CRON_ENV = "PACKETAGENT_ALERT_EVALUATE_CRON";
export const ALERT_RETENTION_DAYS_ENV = "PACKETAGENT_ALERT_RETENTION_DAYS";
export const ALERT_WORKSPACE_ID_ENV = "PACKETAGENT_ALERT_WORKSPACE_ID";
export const ALERT_DELIVER_MAX_ATTEMPTS_ENV = "PACKETAGENT_ALERT_DELIVER_MAX_ATTEMPTS";
export const ALERTS_DELIVER_JOB_TYPE = "alerts.deliver" as const;

const DEFAULT_JOB_FAILURE_RATE_THRESHOLD = 0.5;
const DEFAULT_JOB_FAILURE_MIN_SAMPLES = 5;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_WORKSPACE_ID = "__system__";
const DEFAULT_DELIVER_MAX_ATTEMPTS = 3;
const ACTIVE_RECURRING_STATUSES = new Set(["queued", "running", "success"]);

export interface AlertsEvaluateJobPayload {
  retentionDays?: number;
  jobFailureRateThreshold?: number;
  jobFailureMinSamples?: number;
}

export interface AlertsEvaluateJobResult {
  evaluatedAt: string;
  eventCount: number;
  delivered: boolean;
  deliveryError?: string;
  storedCount: number;
  pruned: number;
  enqueuedDeliverJobs: number;
  workerActivations: number;
}

export interface AlertsEvaluateHandlerDeps {
  evaluate?: typeof evaluateAlerts;
  health?: () => OperationsHealthReport | Promise<OperationsHealthReport>;
  metrics?: () => JobTypeMetrics[];
  webhookConfig?: () => AlertWebhookConfig | null;
  deliver?: typeof deliverAlertWebhook;
  record?: (
    events: AlertEvent[],
    deliveryOk: boolean,
    deliveryError: string | undefined,
    options?: { retentionDays?: number },
  ) => { stored: number; pruned: number } | Promise<{ stored: number; pruned: number }>;
  enqueueDeliverJob?: (input: EnqueueJobInput) => JobRecord | Promise<JobRecord>;
  activateWorkers?: (events: readonly AlertEvent[]) => number | Promise<number>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface EnsureAlertsCronJobDeps {
  env?: NodeJS.ProcessEnv;
  loadStore?: () => PacketAgentData;
  enqueue?: (input: EnqueueJobInput) => JobRecord;
}

export interface EnsureAlertsCronJobAsyncDeps {
  env?: NodeJS.ProcessEnv;
  loadStore?: () => PacketAgentData | Promise<PacketAgentData>;
  enqueue?: (input: EnqueueJobInput) => JobRecord | Promise<JobRecord>;
}

export interface EnsureAlertsCronJobResult {
  action: "skipped" | "exists" | "enqueued";
  jobId?: string;
}

function readNumberFromEnv(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

function parseRetentionFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_RETENTION_DAYS;
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return DEFAULT_RETENTION_DAYS;
  const parsed = parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_RETENTION_DAYS;
  return parsed;
}

function parseDeliverMaxAttemptsFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_DELIVER_MAX_ATTEMPTS;
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return DEFAULT_DELIVER_MAX_ATTEMPTS;
  const parsed = parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_DELIVER_MAX_ATTEMPTS;
  return parsed;
}

export async function handleAlertsEvaluateJob(
  payload: AlertsEvaluateJobPayload,
  deps: AlertsEvaluateHandlerDeps = {},
): Promise<AlertsEvaluateJobResult> {
  const evaluate = deps.evaluate ?? evaluateAlerts;
  const healthFn = deps.health ?? getOperationsHealthAsync;
  const metricsFn = deps.metrics ?? getJobTypeMetrics;
  const webhookConfigFn = deps.webhookConfig ?? (() => resolveAlertWebhookConfig());
  const deliverFn = deps.deliver ?? deliverAlertWebhook;
  const recordFn = deps.record ?? recordAlertsAsync;
  const enqueueDeliverFn = deps.enqueueDeliverJob ?? enqueueJobAsync;
  const activateWorkers = deps.activateWorkers ?? activateWorkerAlertEvents;
  const env = deps.env ?? process.env;
  const nowFn = deps.now ?? (() => new Date());

  const evaluatedAt = nowFn().toISOString();

  const jobFailureRateThreshold =
    payload.jobFailureRateThreshold ??
    readNumberFromEnv(env, ALERT_JOB_FAILURE_RATE_THRESHOLD_ENV) ??
    DEFAULT_JOB_FAILURE_RATE_THRESHOLD;
  const jobFailureMinSamples =
    payload.jobFailureMinSamples ??
    readNumberFromEnv(env, ALERT_JOB_FAILURE_MIN_SAMPLES_ENV) ??
    DEFAULT_JOB_FAILURE_MIN_SAMPLES;
  const retentionDays = payload.retentionDays ?? parseRetentionFromEnv(env[ALERT_RETENTION_DAYS_ENV]);

  const events: AlertEvent[] = evaluate({
    health: await healthFn(),
    metrics: metricsFn(),
    jobFailureRateThreshold,
    jobFailureMinSamples,
  });

  let delivered = true;
  let deliveryError: string | undefined;

  if (events.length > 0) {
    const config = webhookConfigFn();
    if (config === null) {
      delivered = true;
      deliveryError = "webhook not configured";
    } else {
      const result = await deliverFn(config, events);
      delivered = result.ok;
      deliveryError = result.error;
    }
  }

  const recordResult = await recordFn(events, delivered, deliveryError, { retentionDays });
  const workerActivations = await activateWorkers(events);

  let enqueuedDeliverJobs = 0;
  if (delivered === false && events.length > 0) {
    const configuredMax = parseDeliverMaxAttemptsFromEnv(env[ALERT_DELIVER_MAX_ATTEMPTS_ENV]);
    const retryMaxAttempts = Math.max(1, configuredMax - 1);
    const workspaceId = env[ALERT_WORKSPACE_ID_ENV]?.trim() || DEFAULT_WORKSPACE_ID;
    const scheduledAt = nowFn().toISOString();
    for (const event of events) {
      await enqueueDeliverFn({
        workspaceId,
        type: ALERTS_DELIVER_JOB_TYPE,
        payload: { alertId: event.id },
        maxAttempts: retryMaxAttempts,
        scheduledAt,
      });
      enqueuedDeliverJobs += 1;
    }
  }

  const result: AlertsEvaluateJobResult = {
    evaluatedAt,
    eventCount: events.length,
    delivered,
    storedCount: recordResult.stored,
    pruned: recordResult.pruned,
    enqueuedDeliverJobs,
    workerActivations,
  };
  if (deliveryError !== undefined) {
    result.deliveryError = deliveryError;
  }
  return result;
}

export function ensureAlertsCronJob(
  deps: EnsureAlertsCronJobDeps = {},
): EnsureAlertsCronJobResult {
  const env = deps.env ?? process.env;
  const loadStore = deps.loadStore ?? defaultLoadStore;
  const enqueue = deps.enqueue ?? enqueueJob;

  const cron = env[ALERT_EVALUATE_CRON_ENV]?.trim();
  if (!cron) return { action: "skipped" };

  let firstRun: Date;
  try {
    firstRun = nextAfter(cron, new Date());
  } catch (error) {
    console.warn(
      `alerts.evaluate: invalid ${ALERT_EVALUATE_CRON_ENV} expression ${JSON.stringify(cron)}; skipping bootstrap (${(error as Error).message})`,
    );
    return { action: "skipped" };
  }

  const data = loadStore();
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  const existing = jobs.find(
    (job) =>
      job.type === ALERTS_EVALUATE_JOB_TYPE &&
      job.cron === cron &&
      ACTIVE_RECURRING_STATUSES.has(job.status),
  );
  if (existing) return { action: "exists", jobId: existing.id };

  const workspaceId = env[ALERT_WORKSPACE_ID_ENV]?.trim() || DEFAULT_WORKSPACE_ID;
  const retentionDays = parseRetentionFromEnv(env[ALERT_RETENTION_DAYS_ENV]);

  const created = enqueue({
    workspaceId,
    type: ALERTS_EVALUATE_JOB_TYPE,
    payload: { retentionDays },
    cron,
    scheduledAt: firstRun.toISOString(),
  });

  return { action: "enqueued", jobId: created.id };
}

export async function ensureAlertsCronJobAsync(
  deps: EnsureAlertsCronJobAsyncDeps = {},
): Promise<EnsureAlertsCronJobResult> {
  const env = deps.env ?? process.env;
  const loadStore = deps.loadStore ?? defaultLoadStoreAsync;
  const enqueue = deps.enqueue ?? enqueueJobAsync;

  const cron = env[ALERT_EVALUATE_CRON_ENV]?.trim();
  if (!cron) return { action: "skipped" };

  let firstRun: Date;
  try {
    firstRun = nextAfter(cron, new Date());
  } catch (error) {
    console.warn(
      `alerts.evaluate: invalid ${ALERT_EVALUATE_CRON_ENV} expression ${JSON.stringify(cron)}; skipping bootstrap (${(error as Error).message})`,
    );
    return { action: "skipped" };
  }

  const data = await loadStore();
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  const existing = jobs.find(
    (job) =>
      job.type === ALERTS_EVALUATE_JOB_TYPE &&
      job.cron === cron &&
      ACTIVE_RECURRING_STATUSES.has(job.status),
  );
  if (existing) return { action: "exists", jobId: existing.id };

  const workspaceId = env[ALERT_WORKSPACE_ID_ENV]?.trim() || DEFAULT_WORKSPACE_ID;
  const retentionDays = parseRetentionFromEnv(env[ALERT_RETENTION_DAYS_ENV]);

  const created = await enqueue({
    workspaceId,
    type: ALERTS_EVALUATE_JOB_TYPE,
    payload: { retentionDays },
    cron,
    scheduledAt: firstRun.toISOString(),
  });

  return { action: "enqueued", jobId: created.id };
}
