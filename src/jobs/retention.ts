import {
  mutateStoreAsync,
  type JobRecord,
  type JobStatus,
  type PacketAgentData,
} from "../packetagent-store.js";

/**
 * Terminal jobs are history, not work. Without a bound they accumulate forever,
 * and because the SQLite backend rewrites the whole `jobs` table on every
 * store mutation, an unbounded table makes every scheduler poll progressively
 * more expensive until the process stops answering. Retention keeps the table
 * bounded: terminal jobs older than the window are dropped, newest-first, up to
 * a per-pass cap so a single cleanup never becomes its own long transaction.
 */
export const DEFAULT_JOB_RETENTION_DAYS = 7;
export const DEFAULT_JOB_RETENTION_MAX_PER_PASS = 5_000;

const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  "success",
  "failed",
  "canceled",
]);

export interface JobsRetentionOptions {
  retentionDays?: number;
  maxPerPass?: number;
  now?: Date;
}

export function parseJobRetentionDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_JOB_RETENTION_DAYS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_JOB_RETENTION_DAYS;
  return parsed;
}

/**
 * Removes up to `maxPerPass` terminal jobs whose last update is older than the
 * retention window. Queued and running jobs are never touched, regardless of
 * age. Returns the number removed.
 */
export function pruneTerminalJobs(
  data: PacketAgentData,
  options: JobsRetentionOptions = {},
): number {
  const retentionDays = options.retentionDays ?? DEFAULT_JOB_RETENTION_DAYS;
  const maxPerPass = Math.max(0, options.maxPerPass ?? DEFAULT_JOB_RETENTION_MAX_PER_PASS);
  const cutoff = (options.now ?? new Date()).getTime() - retentionDays * 86_400_000;
  if (maxPerPass === 0) return 0;

  const candidates = (Array.isArray(data.jobs) ? data.jobs : [])
    .filter((job: JobRecord) => {
      if (!TERMINAL_STATUSES.has(job.status)) return false;
      const updated = Date.parse(job.updatedAt);
      return Number.isFinite(updated) && updated < cutoff;
    })
    .sort((left: JobRecord, right: JobRecord) => {
      const cmp = Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
      return cmp !== 0 ? cmp : left.id.localeCompare(right.id);
    })
    .slice(0, maxPerPass);

  if (candidates.length === 0) return 0;
  const drop = new Set(candidates.map((job: JobRecord) => job.id));
  data.jobs = data.jobs.filter((job: JobRecord) => !drop.has(job.id));
  return candidates.length;
}

export async function runJobsRetention(options: JobsRetentionOptions = {}): Promise<number> {
  return await mutateStoreAsync((data) => pruneTerminalJobs(data, options));
}
