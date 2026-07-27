export type JobMetricStatus = "success" | "failed" | "canceled";

export interface JobTypeMetrics {
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

export interface JobRunRecord {
  type: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: JobMetricStatus;
}

const DEFAULT_WINDOW_SIZE = 50;

function resolveInitialWindowSize(): number {
  const raw = process.env.PACKETAGENT_SCHEDULER_METRICS_WINDOW_SIZE;
  if (raw === undefined || raw === "") return DEFAULT_WINDOW_SIZE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_WINDOW_SIZE;
  return Math.floor(parsed);
}

export let SCHEDULER_METRICS_WINDOW_SIZE: number = resolveInitialWindowSize();

interface JobTypeRecord {
  type: string;
  totalRuns: number;
  succeededRuns: number;
  failedRuns: number;
  canceledRuns: number;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  lastDurationMs: number | null;
  successDurations: number[];
}

const records = new Map<string, JobTypeRecord>();

function getOrCreateRecord(type: string): JobTypeRecord {
  let record = records.get(type);
  if (!record) {
    record = {
      type,
      totalRuns: 0,
      succeededRuns: 0,
      failedRuns: 0,
      canceledRuns: 0,
      lastRunStartedAt: null,
      lastRunFinishedAt: null,
      lastDurationMs: null,
      successDurations: [],
    };
    records.set(type, record);
  }
  return record;
}

export function recordJobRun(record: JobRunRecord): void {
  const target = getOrCreateRecord(record.type);
  target.totalRuns += 1;
  if (record.status === "success") {
    target.succeededRuns += 1;
    target.successDurations.push(record.durationMs);
    if (target.successDurations.length > SCHEDULER_METRICS_WINDOW_SIZE) {
      target.successDurations = target.successDurations.slice(
        target.successDurations.length - SCHEDULER_METRICS_WINDOW_SIZE,
      );
    }
  } else if (record.status === "failed") {
    target.failedRuns += 1;
  } else if (record.status === "canceled") {
    target.canceledRuns += 1;
  }
  target.lastRunStartedAt = record.startedAt;
  target.lastRunFinishedAt = record.finishedAt;
  target.lastDurationMs = record.durationMs;
}

function computeAverage(values: number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

function computeP95(values: number[]): number | null {
  if (values.length < 2) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = 0.95 * (sorted.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  if (lowerIndex === upperIndex) return sorted[lowerIndex];
  const fraction = rank - lowerIndex;
  return sorted[lowerIndex] + (sorted[upperIndex] - sorted[lowerIndex]) * fraction;
}

export function getJobTypeMetrics(): JobTypeMetrics[] {
  const result: JobTypeMetrics[] = [];
  for (const record of records.values()) {
    result.push({
      type: record.type,
      totalRuns: record.totalRuns,
      succeededRuns: record.succeededRuns,
      failedRuns: record.failedRuns,
      canceledRuns: record.canceledRuns,
      lastRunStartedAt: record.lastRunStartedAt,
      lastRunFinishedAt: record.lastRunFinishedAt,
      lastDurationMs: record.lastDurationMs,
      averageDurationMs: computeAverage(record.successDurations),
      p95DurationMs: computeP95(record.successDurations),
    });
  }
  result.sort((a, b) => a.type.localeCompare(b.type));
  return result;
}

export function __resetSchedulerMetricsForTests(): void {
  records.clear();
  SCHEDULER_METRICS_WINDOW_SIZE = resolveInitialWindowSize();
}

// test-only setter so tests can exercise window eviction without re-importing the module.
export function __overrideWindowSizeForTests(size: number): void {
  SCHEDULER_METRICS_WINDOW_SIZE = Math.max(1, Math.floor(size));
}
