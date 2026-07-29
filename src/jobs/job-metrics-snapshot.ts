import { randomUUID } from "node:crypto";
import {
  createAsyncJobMetricSnapshotsRepository,
  createJobMetricSnapshotsRepository,
} from "../repositories/job-metric-snapshots-repo.js";
import type { JobMetricSnapshotRecord, PacketAgentData } from "../packetagent-store.js";
import {
  loadStoreAsync as defaultLoadStoreAsync,
  mutateStore as defaultMutateStore,
  mutateStoreAsync as defaultMutateStoreAsync,
} from "../packetagent-store.js";
import { getJobTypeMetrics, type JobTypeMetrics } from "./scheduler-metrics.js";
// Phase 32 read-redirect (Slice B):
import { listJobMetricSnapshotsViaRepository } from "./job-metrics-snapshot-read.js";

const DAY_MS = 86_400_000;
const DEFAULT_RETENTION_DAYS = 30;

export interface SnapshotJobMetricsResult {
  command: "snapshot-job-metrics";
  capturedAt: string;
  snapshots: JobMetricSnapshotRecord[];
  removed: number;
}

export interface SnapshotJobMetricsOptions {
  retentionDays?: number;
}

export interface SnapshotJobMetricsDeps {
  loadStore?: () => PacketAgentData;
  mutateStore?: <T>(mutator: (data: PacketAgentData) => T) => T;
  jobTypeMetrics?: () => JobTypeMetrics[];
  now?: () => Date;
  generateId?: () => string;
}

export interface SnapshotJobMetricsAsyncDeps {
  loadStore?: () => Promise<PacketAgentData>;
  mutateStore?: <T>(mutator: (data: PacketAgentData) => T | Promise<T>) => Promise<T>;
  jobTypeMetrics?: () => JobTypeMetrics[];
  now?: () => Date;
  generateId?: () => string;
}

export interface ListJobMetricSnapshotsOptions {
  type?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export interface ListJobMetricSnapshotsDeps {
  loadStore?: () => PacketAgentData;
}

export interface ListJobMetricSnapshotsAsyncDeps {
  loadStore?: () => Promise<PacketAgentData>;
}

export interface PruneJobMetricSnapshotsOptions {
  retentionDays: number;
}

export interface PruneJobMetricSnapshotsResult {
  removed: number;
}

export interface PruneJobMetricSnapshotsDeps {
  mutateStore?: <T>(mutator: (data: PacketAgentData) => T) => T;
  now?: () => Date;
}

export interface PruneJobMetricSnapshotsAsyncDeps {
  mutateStore?: <T>(mutator: (data: PacketAgentData) => T | Promise<T>) => Promise<T>;
  now?: () => Date;
}

function ensureSnapshotCollection(data: PacketAgentData): JobMetricSnapshotRecord[] {
  if (!Array.isArray(data.jobMetricSnapshots)) {
    data.jobMetricSnapshots = [];
  }
  return data.jobMetricSnapshots;
}

function buildSnapshot(
  metric: JobTypeMetrics,
  capturedAt: string,
  id: string,
): JobMetricSnapshotRecord {
  return {
    id,
    capturedAt,
    type: metric.type,
    totalRuns: metric.totalRuns,
    succeededRuns: metric.succeededRuns,
    failedRuns: metric.failedRuns,
    canceledRuns: metric.canceledRuns,
    lastRunStartedAt: metric.lastRunStartedAt,
    lastRunFinishedAt: metric.lastRunFinishedAt,
    lastDurationMs: metric.lastDurationMs,
    averageDurationMs: metric.averageDurationMs,
    p95DurationMs: metric.p95DurationMs,
  };
}

export function snapshotJobMetrics(
  options: SnapshotJobMetricsOptions = {},
  deps: SnapshotJobMetricsDeps = {},
): SnapshotJobMetricsResult {
  const mutate = deps.mutateStore ?? defaultMutateStore;
  const metricsSource = deps.jobTypeMetrics ?? getJobTypeMetrics;
  const nowFn = deps.now ?? (() => new Date());
  const generateId = deps.generateId ?? (() => randomUUID());
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;

  const now = nowFn();
  const capturedAt = now.toISOString();
  const metrics = metricsSource();

  const result = mutate((data) => {
    const collection = ensureSnapshotCollection(data);
    const snapshots: JobMetricSnapshotRecord[] = metrics.map((metric) =>
      buildSnapshot(metric, capturedAt, generateId()),
    );
    for (const snapshot of snapshots) {
      collection.push(snapshot);
    }

    let removed = 0;
    let retainAfterIso: string | null = null;
    if (retentionDays > 0) {
      const cutoff = now.getTime() - retentionDays * DAY_MS;
      retainAfterIso = new Date(cutoff).toISOString();
      const retained = collection.filter((entry) => Date.parse(entry.capturedAt) >= cutoff);
      removed = collection.length - retained.length;
      if (removed > 0) {
        data.jobMetricSnapshots = retained;
      }
    }

    return {
      command: "snapshot-job-metrics" as const,
      capturedAt,
      snapshots,
      removed,
      retainAfterIso,
    };
  });

  if (process.env.PACKETAGENT_STORE === "sqlite") {
    const repo = createJobMetricSnapshotsRepository({});
    if (result.snapshots.length > 0) {
      repo.insertMany(result.snapshots);
    }
    if (result.retainAfterIso !== null) {
      repo.prune(result.retainAfterIso);
    }
  }

  return {
    command: result.command,
    capturedAt: result.capturedAt,
    snapshots: result.snapshots,
    removed: result.removed,
  };
}

export async function snapshotJobMetricsAsync(
  options: SnapshotJobMetricsOptions = {},
  deps: SnapshotJobMetricsAsyncDeps = {},
): Promise<SnapshotJobMetricsResult> {
  const mutate = deps.mutateStore ?? defaultMutateStoreAsync;
  const metricsSource = deps.jobTypeMetrics ?? getJobTypeMetrics;
  const nowFn = deps.now ?? (() => new Date());
  const generateId = deps.generateId ?? (() => randomUUID());
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;

  const now = nowFn();
  const capturedAt = now.toISOString();
  const metrics = metricsSource();

  const result = await mutate((data) => {
    const collection = ensureSnapshotCollection(data);
    const snapshots: JobMetricSnapshotRecord[] = metrics.map((metric) =>
      buildSnapshot(metric, capturedAt, generateId()),
    );
    for (const snapshot of snapshots) {
      collection.push(snapshot);
    }

    let removed = 0;
    let retainAfterIso: string | null = null;
    if (retentionDays > 0) {
      const cutoff = now.getTime() - retentionDays * DAY_MS;
      retainAfterIso = new Date(cutoff).toISOString();
      const retained = collection.filter((entry) => Date.parse(entry.capturedAt) >= cutoff);
      removed = collection.length - retained.length;
      if (removed > 0) {
        data.jobMetricSnapshots = retained;
      }
    }

    return {
      command: "snapshot-job-metrics" as const,
      capturedAt,
      snapshots,
      removed,
      retainAfterIso,
    };
  });

  if (process.env.PACKETAGENT_STORE === "sqlite") {
    const repo = createJobMetricSnapshotsRepository({});
    if (result.snapshots.length > 0) {
      repo.insertMany(result.snapshots);
    }
    if (result.retainAfterIso !== null) {
      repo.prune(result.retainAfterIso);
    }
  }

  return {
    command: result.command,
    capturedAt: result.capturedAt,
    snapshots: result.snapshots,
    removed: result.removed,
  };
}

export function listJobMetricSnapshots(
  options: ListJobMetricSnapshotsOptions = {},
  deps: ListJobMetricSnapshotsDeps = {},
): JobMetricSnapshotRecord[] {
  return listJobMetricSnapshotsViaRepository(options, { loadStore: deps.loadStore });
}

export async function listJobMetricSnapshotsAsync(
  options: ListJobMetricSnapshotsOptions = {},
  deps: ListJobMetricSnapshotsAsyncDeps = {},
): Promise<JobMetricSnapshotRecord[]> {
  const repository = createAsyncJobMetricSnapshotsRepository({
    loadStore: deps.loadStore ?? defaultLoadStoreAsync,
    mutateStore: defaultMutateStoreAsync,
  });
  return repository.list(options);
}

export function pruneJobMetricSnapshots(
  options: PruneJobMetricSnapshotsOptions,
  deps: PruneJobMetricSnapshotsDeps = {},
): PruneJobMetricSnapshotsResult {
  if (options.retentionDays === 0) {
    return { removed: 0 };
  }

  const mutate = deps.mutateStore ?? defaultMutateStore;
  const nowFn = deps.now ?? (() => new Date());
  const cutoff = nowFn().getTime() - options.retentionDays * DAY_MS;
  const retainAfterIso = new Date(cutoff).toISOString();

  const result = mutate((data) => {
    const collection = ensureSnapshotCollection(data);
    const retained = collection.filter((entry) => Date.parse(entry.capturedAt) >= cutoff);
    const removed = collection.length - retained.length;
    if (removed > 0) {
      data.jobMetricSnapshots = retained;
    }
    return { removed };
  });

  if (process.env.PACKETAGENT_STORE === "sqlite") {
    const repo = createJobMetricSnapshotsRepository({});
    repo.prune(retainAfterIso);
  }

  return result;
}

export async function pruneJobMetricSnapshotsAsync(
  options: PruneJobMetricSnapshotsOptions,
  deps: PruneJobMetricSnapshotsAsyncDeps = {},
): Promise<PruneJobMetricSnapshotsResult> {
  if (options.retentionDays === 0) {
    return { removed: 0 };
  }

  const mutate = deps.mutateStore ?? defaultMutateStoreAsync;
  const nowFn = deps.now ?? (() => new Date());
  const cutoff = nowFn().getTime() - options.retentionDays * DAY_MS;
  const retainAfterIso = new Date(cutoff).toISOString();

  const result = await mutate((data) => {
    const collection = ensureSnapshotCollection(data);
    const retained = collection.filter((entry) => Date.parse(entry.capturedAt) >= cutoff);
    const removed = collection.length - retained.length;
    if (removed > 0) {
      data.jobMetricSnapshots = retained;
    }
    return { removed };
  });

  if (process.env.PACKETAGENT_STORE === "sqlite") {
    const repo = createJobMetricSnapshotsRepository({});
    repo.prune(retainAfterIso);
  }

  return result;
}
