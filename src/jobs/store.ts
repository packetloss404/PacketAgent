import { randomUUID } from "node:crypto";
import { createAsyncJobsRepository, createJobsRepository } from "../repositories/jobs-repo.js";
import { clearStoreCache, findJobIndexed, listJobsForWorkspaceIndexed, loadStoreAsync, mutateStore, mutateStoreAsync, type AgentRecord, type JobRecord, type JobStatus, type PacketAgentData } from "../packetagent-store.js";
import { nextAfter } from "./cron.js";

const STALE_RUNNING_MS = 5 * 60 * 1000;

function nowIso(): string {
  return new Date().toISOString();
}

function isSqliteMode(): boolean {
  return process.env.PACKETAGENT_STORE === "sqlite";
}

function dualWriteJobs(records: JobRecord[]): void {
  if (records.length === 0) return;
  if (!isSqliteMode()) return;
  const repo = createJobsRepository({});
  for (const record of records) {
    repo.upsert(record);
  }
}

export interface EnqueueJobInput {
  workspaceId: string;
  type: string;
  payload?: Record<string, unknown>;
  scheduledAt?: string;
  cron?: string;
  maxAttempts?: number;
}

export interface JobSchedulerStorageSync {
  enqueueJob(input: EnqueueJobInput): JobRecord;
  maintainScheduledAgentJobs(agentId?: string): JobRecord[];
  enqueueRecurringJob(job: JobRecord, scheduledAt: string): JobRecord | null;
  listJobs(workspaceId: string, opts?: { status?: JobStatus; limit?: number }): JobRecord[];
  findJob(id: string): JobRecord | null;
  updateJob(id: string, patch: Partial<JobRecord>): JobRecord | null;
  cancelJob(id: string): JobRecord | null;
  claimNextJob(now: Date): Promise<JobRecord | null>;
  sweepStaleRunningJobs(staleAfterMs?: number, now?: Date): number;
}

export interface JobSchedulerStorage {
  enqueueJob(input: EnqueueJobInput): Promise<JobRecord>;
  maintainScheduledAgentJobs(agentId?: string): Promise<JobRecord[]>;
  enqueueRecurringJob(job: JobRecord, scheduledAt: string): Promise<JobRecord | null>;
  listJobs(workspaceId: string, opts?: { status?: JobStatus; limit?: number }): Promise<JobRecord[]>;
  findJob(id: string): Promise<JobRecord | null>;
  updateJob(id: string, patch: Partial<JobRecord>): Promise<JobRecord | null>;
  cancelJob(id: string): Promise<JobRecord | null>;
  claimNextJob(now: Date): Promise<JobRecord | null>;
  sweepStaleRunningJobs(staleAfterMs?: number, now?: Date): Promise<number>;
}

/**
 * Canonicalize a caller-supplied scheduledAt to UTC ISO-8601 (`...Z`). Callers
 * may pass any Date.parse-able string (e.g. a `-05:00` offset or an RFC-2822
 * date); storing it verbatim breaks the claimNext index scan, which relies on
 * lexical order matching chronological order. Normalizing to canonical UTC here
 * keeps every stored scheduled_at lexically comparable in BOTH the JSON and
 * SQLite backends (preserving read-parity). Returns undefined for absent or
 * unparseable input so the caller falls back to "now".
 */
function normalizeScheduledAt(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
}

export function enqueueJob(input: EnqueueJobInput): JobRecord {
  const ts = nowIso();
  const record: JobRecord = {
    id: randomUUID(),
    workspaceId: input.workspaceId,
    type: input.type,
    payload: input.payload ?? {},
    status: "queued",
    attempts: 0,
    maxAttempts: input.maxAttempts ?? 3,
    scheduledAt: normalizeScheduledAt(input.scheduledAt) ?? ts,
    ...(input.cron ? { cron: input.cron } : {}),
    createdAt: ts,
    updatedAt: ts,
  };
  const inserted = mutateStore((data) => {
    data.jobs.push(record);
    return record;
  });
  dualWriteJobs([inserted]);
  return inserted;
}

function isScheduledAgentRunJob(job: JobRecord, agentId: string): boolean {
  return job.type === "agent.run" && job.payload?.agentId === agentId && job.payload?.triggerKind === "schedule";
}

function activeSchedule(agent: AgentRecord): string | null {
  const schedule = agent.schedule?.trim();
  if (agent.status !== "active" || agent.triggerKind !== "schedule" || !schedule) return null;
  nextAfter(schedule, new Date());
  return schedule;
}

function cancelQueued(job: JobRecord, timestamp: string): void {
  job.status = "canceled";
  job.cancelRequested = true;
  job.completedAt = timestamp;
  job.updatedAt = timestamp;
}

function scheduledAgentPayload(agentId: string, payload?: Record<string, unknown>): Record<string, unknown> {
  return { ...(payload ?? {}), agentId, triggerKind: "schedule" };
}

interface ScheduledAgentResult {
  maintained: JobRecord | null;
  touched: JobRecord[];
}

function ensureScheduledAgentJob(
  data: PacketAgentData,
  agent: AgentRecord,
  timestamp: string,
  scheduledAt?: string,
  payload?: Record<string, unknown>,
): ScheduledAgentResult {
  let schedule: string | null = null;
  try { schedule = activeSchedule(agent); }
  catch { schedule = null; }

  const queued = data.jobs
    .filter((job) => job.status === "queued" && isScheduledAgentRunJob(job, agent.id))
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));

  const touched: JobRecord[] = [];

  if (!schedule) {
    for (const job of queued) {
      cancelQueued(job, timestamp);
      touched.push(job);
    }
    return { maintained: null, touched };
  }

  const current = queued.filter((job) => job.cron === schedule);
  const stale = queued.filter((job) => job.cron !== schedule);
  for (const job of stale) {
    cancelQueued(job, timestamp);
    touched.push(job);
  }
  for (const job of current.slice(1)) {
    cancelQueued(job, timestamp);
    touched.push(job);
  }
  if (current[0]) return { maintained: current[0], touched };

  const record: JobRecord = {
    id: randomUUID(),
    workspaceId: agent.workspaceId,
    type: "agent.run",
    payload: scheduledAgentPayload(agent.id, payload),
    status: "queued",
    attempts: 0,
    maxAttempts: 3,
    cron: schedule,
    scheduledAt: scheduledAt ?? nextAfter(schedule, new Date()).toISOString(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  data.jobs.push(record);
  touched.push(record);
  return { maintained: record, touched };
}

export function maintainScheduledAgentJobs(agentId?: string): JobRecord[] {
  const timestamp = nowIso();
  const { maintained, touched } = mutateStore((data) => {
    const agents = agentId ? data.agents.filter((agent) => agent.id === agentId) : data.agents;
    const maintained: JobRecord[] = [];
    const touched: JobRecord[] = [];
    for (const agent of agents) {
      const result = ensureScheduledAgentJob(data, agent, timestamp);
      if (result.maintained) maintained.push(result.maintained);
      for (const job of result.touched) touched.push(job);
    }
    return { maintained, touched };
  });
  // Dual-write every record that ensureScheduledAgentJob touched (created, cancelled, or already-current that
  // we still treat as the maintained record). The "maintained" list may include current[0] entries that were
  // not mutated; including them in the dual-write is a harmless idempotent upsert.
  const dedup = new Map<string, JobRecord>();
  for (const job of touched) dedup.set(job.id, job);
  for (const job of maintained) dedup.set(job.id, job);
  dualWriteJobs([...dedup.values()]);
  return maintained;
}

export function enqueueRecurringJob(job: JobRecord, scheduledAt: string): JobRecord | null {
  if (job.type === "agent.run" && job.payload?.triggerKind === "schedule" && typeof job.payload.agentId === "string") {
    const { maintained, touched } = mutateStore((data) => {
      const agent = data.agents.find((entry) => entry.id === job.payload.agentId);
      if (!agent) return { maintained: null as JobRecord | null, touched: [] as JobRecord[] };
      const result = ensureScheduledAgentJob(data, agent, nowIso(), scheduledAt, job.payload);
      return { maintained: result.maintained, touched: result.touched };
    });
    const dedup = new Map<string, JobRecord>();
    for (const entry of touched) dedup.set(entry.id, entry);
    if (maintained) dedup.set(maintained.id, maintained);
    dualWriteJobs([...dedup.values()]);
    return maintained;
  }

  return enqueueJob({
    workspaceId: job.workspaceId,
    type: job.type,
    payload: job.payload,
    cron: job.cron,
    scheduledAt,
    maxAttempts: job.maxAttempts,
  });
}

export function listJobs(
  workspaceId: string,
  opts: { status?: JobStatus; limit?: number } = {},
): JobRecord[] {
  return listJobsForWorkspaceIndexed(workspaceId, opts);
}

export function findJob(id: string): JobRecord | null {
  return findJobIndexed(id);
}

export function updateJob(id: string, patch: Partial<JobRecord>): JobRecord | null {
  const updated = mutateStore((data) => {
    const job = data.jobs.find((j) => j.id === id);
    if (!job) return null;
    Object.assign(job, patch, { updatedAt: nowIso() });
    return job;
  });
  if (updated) dualWriteJobs([updated]);
  return updated;
}

export function cancelJob(id: string): JobRecord | null {
  const updated = mutateStore((data) => {
    const job = data.jobs.find((j) => j.id === id);
    if (!job) return null;
    job.cancelRequested = true;
    job.updatedAt = nowIso();
    if (job.status === "queued") {
      job.status = "canceled";
      job.completedAt = job.updatedAt;
    }
    return job;
  });
  if (updated) dualWriteJobs([updated]);
  return updated;
}

let claimMutex: Promise<unknown> = Promise.resolve();

export async function claimNextJob(now: Date): Promise<JobRecord | null> {
  if (isSqliteMode()) {
    const claimed = createJobsRepository({}).claimNext(now);
    if (claimed) clearStoreCache();
    return claimed;
  }

  const previous = claimMutex;
  let release!: () => void;
  claimMutex = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const claimed = mutateStore((data) => {
      const candidate = data.jobs
        .filter((j) => j.status === "queued" && Date.parse(j.scheduledAt) <= now.getTime())
        .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt))[0];
      if (!candidate) return null;
      candidate.status = "running";
      candidate.attempts += 1;
      candidate.startedAt = now.toISOString();
      candidate.updatedAt = candidate.startedAt;
      return candidate;
    });
    if (claimed) dualWriteJobs([claimed]);
    return claimed;
  } finally {
    release();
  }
}

export function sweepStaleRunningJobs(staleAfterMs: number = STALE_RUNNING_MS, now: Date = new Date()): number {
  if (isSqliteMode()) {
    const swept = createJobsRepository({}).sweepStaleRunning(staleAfterMs, now);
    if (swept > 0) clearStoreCache();
    return swept;
  }

  const swept: JobRecord[] = [];
  const count = mutateStore((data) => {
    const cutoff = now.getTime() - staleAfterMs;
    const timestamp = now.toISOString();
    let count = 0;
    for (const job of data.jobs) {
      if (job.status === "running" && job.startedAt && Date.parse(job.startedAt) < cutoff) {
        job.status = "queued";
        job.updatedAt = timestamp;
        delete job.startedAt;
        swept.push(job);
        count++;
      }
    }
    return count;
  });
  dualWriteJobs(swept);
  return count;
}

function createDefaultAsyncJobsRepository() {
  return createAsyncJobsRepository({
    loadStore: loadStoreAsync,
    mutateStore: mutateStoreAsync,
  });
}

async function enqueueJobViaAsyncStore(input: EnqueueJobInput): Promise<JobRecord> {
  const ts = nowIso();
  const record: JobRecord = {
    id: randomUUID(),
    workspaceId: input.workspaceId,
    type: input.type,
    payload: input.payload ?? {},
    status: "queued",
    attempts: 0,
    maxAttempts: input.maxAttempts ?? 3,
    scheduledAt: normalizeScheduledAt(input.scheduledAt) ?? ts,
    ...(input.cron ? { cron: input.cron } : {}),
    createdAt: ts,
    updatedAt: ts,
  };
  const inserted = await mutateStoreAsync((data) => {
    data.jobs.push(record);
    return record;
  });
  dualWriteJobs([inserted]);
  return inserted;
}

async function maintainScheduledAgentJobsViaAsyncStore(agentId?: string): Promise<JobRecord[]> {
  const timestamp = nowIso();
  const { maintained, touched } = await mutateStoreAsync((data) => {
    const agents = agentId ? data.agents.filter((agent) => agent.id === agentId) : data.agents;
    const maintained: JobRecord[] = [];
    const touched: JobRecord[] = [];
    for (const agent of agents) {
      const result = ensureScheduledAgentJob(data, agent, timestamp);
      if (result.maintained) maintained.push(result.maintained);
      for (const job of result.touched) touched.push(job);
    }
    return { maintained, touched };
  });
  const dedup = new Map<string, JobRecord>();
  for (const job of touched) dedup.set(job.id, job);
  for (const job of maintained) dedup.set(job.id, job);
  dualWriteJobs([...dedup.values()]);
  return maintained;
}

async function enqueueRecurringJobViaAsyncStore(job: JobRecord, scheduledAt: string): Promise<JobRecord | null> {
  if (job.type === "agent.run" && job.payload?.triggerKind === "schedule" && typeof job.payload.agentId === "string") {
    const { maintained, touched } = await mutateStoreAsync((data) => {
      const agent = data.agents.find((entry) => entry.id === job.payload.agentId);
      if (!agent) return { maintained: null as JobRecord | null, touched: [] as JobRecord[] };
      const result = ensureScheduledAgentJob(data, agent, nowIso(), scheduledAt, job.payload);
      return { maintained: result.maintained, touched: result.touched };
    });
    const dedup = new Map<string, JobRecord>();
    for (const entry of touched) dedup.set(entry.id, entry);
    if (maintained) dedup.set(maintained.id, maintained);
    dualWriteJobs([...dedup.values()]);
    return maintained;
  }

  if (
    job.type === "worker.activate.cron" &&
    typeof job.payload.workerDeploymentId === "string" &&
    typeof job.payload.triggerId === "string"
  ) {
    const timestamp = nowIso();
    const outcome = await mutateStoreAsync((data) => {
      const deployment = data.workerDeployments.find(
        (entry) =>
          entry.workspaceId === job.workspaceId &&
          entry.id === job.payload.workerDeploymentId &&
          entry.status === "active",
      );
      const version = deployment
        ? data.workerVersions.find(
            (entry) =>
              entry.workspaceId === job.workspaceId &&
              entry.id === deployment.workerVersionId &&
              entry.status === "validated",
          )
        : undefined;
      const trigger = version?.content.triggers.find(
        (entry) =>
          entry.id === job.payload.triggerId &&
          entry.kind === "cron" &&
          entry.enabled,
      );
      if (
        !deployment ||
        !version ||
        !trigger ||
        trigger.kind !== "cron" ||
        trigger.expression !== job.cron ||
        trigger.timezone !== job.payload.timezone
      ) {
        return { record: null, created: false };
      }
      const existing = data.jobs.find(
        (entry) =>
          entry.workspaceId === job.workspaceId &&
          entry.type === job.type &&
          (entry.status === "queued" || entry.status === "running") &&
          entry.payload.workerDeploymentId === job.payload.workerDeploymentId &&
          entry.payload.triggerId === job.payload.triggerId,
      );
      if (existing) return { record: existing, created: false };
      const record: JobRecord = {
        id: randomUUID(),
        workspaceId: job.workspaceId,
        type: job.type,
        payload: job.payload,
        status: "queued",
        attempts: 0,
        maxAttempts: job.maxAttempts,
        scheduledAt: normalizeScheduledAt(scheduledAt) ?? timestamp,
        ...(job.cron ? { cron: job.cron } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      data.jobs.push(record);
      return { record, created: true };
    });
    if (outcome.created && outcome.record) dualWriteJobs([outcome.record]);
    return outcome.record;
  }

  return enqueueJobViaAsyncStore({
    workspaceId: job.workspaceId,
    type: job.type,
    payload: job.payload,
    cron: job.cron,
    scheduledAt,
    maxAttempts: job.maxAttempts,
  });
}

let claimAsyncMutex: Promise<unknown> = Promise.resolve();

export function createAsyncJobSchedulerStorage(): JobSchedulerStorage {
  return {
    enqueueJob(input) {
      return enqueueJobViaAsyncStore(input);
    },
    maintainScheduledAgentJobs(agentId) {
      return maintainScheduledAgentJobsViaAsyncStore(agentId);
    },
    enqueueRecurringJob(job, scheduledAt) {
      return enqueueRecurringJobViaAsyncStore(job, scheduledAt);
    },
    listJobs(workspaceId, opts = {}) {
      return createDefaultAsyncJobsRepository().list({ workspaceId, ...opts });
    },
    findJob(id) {
      return createDefaultAsyncJobsRepository().find(id);
    },
    async updateJob(id, patch) {
      const updated = await createDefaultAsyncJobsRepository().update(id, patch);
      if (updated) dualWriteJobs([updated]);
      return updated;
    },
    async cancelJob(id) {
      const updated = await mutateStoreAsync((data) => {
        const job = data.jobs.find((j) => j.id === id);
        if (!job) return null;
        job.cancelRequested = true;
        job.updatedAt = nowIso();
        if (job.status === "queued") {
          job.status = "canceled";
          job.completedAt = job.updatedAt;
        }
        return job;
      });
      if (updated) dualWriteJobs([updated]);
      return updated;
    },
    async claimNextJob(now) {
      if (isSqliteMode()) {
        const claimed = await createDefaultAsyncJobsRepository().claimNext(now);
        if (claimed) clearStoreCache();
        return claimed;
      }

      const previous = claimAsyncMutex;
      let release!: () => void;
      claimAsyncMutex = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        const claimed = await mutateStoreAsync((data) => {
          const candidate = data.jobs
            .filter((j) => j.status === "queued" && Date.parse(j.scheduledAt) <= now.getTime())
            .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt))[0];
          if (!candidate) return null;
          candidate.status = "running";
          candidate.attempts += 1;
          candidate.startedAt = now.toISOString();
          candidate.updatedAt = candidate.startedAt;
          return candidate;
        });
        if (claimed) dualWriteJobs([claimed]);
        return claimed;
      } finally {
        release();
      }
    },
    async sweepStaleRunningJobs(staleAfterMs = STALE_RUNNING_MS, now = new Date()) {
      if (isSqliteMode()) {
        const swept = await createDefaultAsyncJobsRepository().sweepStaleRunning(staleAfterMs, now);
        if (swept > 0) clearStoreCache();
        return swept;
      }

      const swept: JobRecord[] = [];
      const count = await mutateStoreAsync((data) => {
        const cutoff = now.getTime() - staleAfterMs;
        const timestamp = now.toISOString();
        let count = 0;
        for (const job of data.jobs) {
          if (job.status === "running" && job.startedAt && Date.parse(job.startedAt) < cutoff) {
            job.status = "queued";
            job.updatedAt = timestamp;
            delete job.startedAt;
            swept.push(job);
            count++;
          }
        }
        return count;
      });
      dualWriteJobs(swept);
      return count;
    },
  };
}

export function createSyncJobSchedulerStorage(): JobSchedulerStorageSync {
  return {
    enqueueJob,
    maintainScheduledAgentJobs,
    enqueueRecurringJob,
    listJobs,
    findJob,
    updateJob,
    cancelJob,
    claimNextJob,
    sweepStaleRunningJobs,
  };
}

export function asyncJobSchedulerStorage(syncStorage?: JobSchedulerStorageSync): JobSchedulerStorage {
  if (!syncStorage) return createAsyncJobSchedulerStorage();
  return {
    async enqueueJob(input) {
      return syncStorage.enqueueJob(input);
    },
    async maintainScheduledAgentJobs(agentId) {
      return syncStorage.maintainScheduledAgentJobs(agentId);
    },
    async enqueueRecurringJob(job, scheduledAt) {
      return syncStorage.enqueueRecurringJob(job, scheduledAt);
    },
    async listJobs(workspaceId, opts) {
      return syncStorage.listJobs(workspaceId, opts);
    },
    async findJob(id) {
      return syncStorage.findJob(id);
    },
    async updateJob(id, patch) {
      return syncStorage.updateJob(id, patch);
    },
    async cancelJob(id) {
      return syncStorage.cancelJob(id);
    },
    async claimNextJob(now) {
      return syncStorage.claimNextJob(now);
    },
    async sweepStaleRunningJobs(staleAfterMs, now) {
      return syncStorage.sweepStaleRunningJobs(staleAfterMs, now);
    },
  };
}

export const defaultJobSchedulerStorage: JobSchedulerStorage = asyncJobSchedulerStorage();

export function enqueueJobAsync(input: EnqueueJobInput): Promise<JobRecord> {
  return defaultJobSchedulerStorage.enqueueJob(input);
}

export function maintainScheduledAgentJobsAsync(agentId?: string): Promise<JobRecord[]> {
  return defaultJobSchedulerStorage.maintainScheduledAgentJobs(agentId);
}

export function enqueueRecurringJobAsync(job: JobRecord, scheduledAt: string): Promise<JobRecord | null> {
  return defaultJobSchedulerStorage.enqueueRecurringJob(job, scheduledAt);
}

export function listJobsAsync(
  workspaceId: string,
  opts: { status?: JobStatus; limit?: number } = {},
): Promise<JobRecord[]> {
  return defaultJobSchedulerStorage.listJobs(workspaceId, opts);
}

export function findJobAsync(id: string): Promise<JobRecord | null> {
  return defaultJobSchedulerStorage.findJob(id);
}

export function updateJobAsync(id: string, patch: Partial<JobRecord>): Promise<JobRecord | null> {
  return defaultJobSchedulerStorage.updateJob(id, patch);
}

export function cancelJobAsync(id: string): Promise<JobRecord | null> {
  return defaultJobSchedulerStorage.cancelJob(id);
}

export function claimNextJobAsync(now: Date): Promise<JobRecord | null> {
  return defaultJobSchedulerStorage.claimNextJob(now);
}

export function sweepStaleRunningJobsAsync(staleAfterMs: number = STALE_RUNNING_MS, now: Date = new Date()): Promise<number> {
  return defaultJobSchedulerStorage.sweepStaleRunningJobs(staleAfterMs, now);
}
