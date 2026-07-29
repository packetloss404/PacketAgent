import { createJobsRepository, type JobsRepository } from "./repositories/jobs-repo.js";
import { loadStore as defaultLoadStore } from "./packetagent-store.js";
import type { JobRecord, JobStatus, PacketAgentData } from "./packetagent-store.js";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

export interface JobsReadDeps {
  loadStore?: () => PacketAgentData;
  mutateStore?: <T>(mutator: (data: PacketAgentData) => T) => T;
  repository?: JobsRepository;
}

export function listJobsForWorkspaceViaRepository(
  workspaceId: string,
  opts: { status?: JobStatus; limit?: number } = {},
  deps: JobsReadDeps = {},
): JobRecord[] {
  const repo = deps.repository ?? createJobsRepository({
    loadStore: deps.loadStore,
    mutateStore: deps.mutateStore,
  });
  const primary = repo.list({ workspaceId, status: opts.status, limit: opts.limit });
  if (process.env.PACKETAGENT_STORE !== "sqlite") return primary;
  const fallback = legacyJobsFromStore(deps).filter((entry) => {
    if (entry.workspaceId !== workspaceId) return false;
    if (opts.status && entry.status !== opts.status) return false;
    return true;
  });
  return mergeAndLimit(primary, fallback, opts.limit);
}

export function findJobViaRepository(
  workspaceId: string,
  jobId: string,
  deps: JobsReadDeps = {},
): JobRecord | null {
  const repo = deps.repository ?? createJobsRepository({
    loadStore: deps.loadStore,
    mutateStore: deps.mutateStore,
  });
  const found = repo.find(workspaceId, jobId);
  if (found) return found;
  if (process.env.PACKETAGENT_STORE !== "sqlite") return null;
  return legacyJobsFromStore(deps).find(
    (entry) => entry.workspaceId === workspaceId && entry.id === jobId,
  ) ?? null;
}

function legacyJobsFromStore(deps: JobsReadDeps): JobRecord[] {
  const load = deps.loadStore ?? defaultLoadStore;
  try {
    const data = load();
    return Array.isArray(data.jobs) ? data.jobs : [];
  } catch {
    return [];
  }
}

function mergeAndLimit(
  primary: JobRecord[],
  fallback: JobRecord[],
  limit?: number,
): JobRecord[] {
  if (fallback.length === 0) return primary;
  const seen = new Set(primary.map((entry) => entry.id));
  const combined = primary.slice();
  for (const entry of fallback) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    combined.push(entry);
  }
  combined.sort((left, right) => {
    const cmp = right.createdAt.localeCompare(left.createdAt);
    if (cmp !== 0) return cmp;
    return left.id.localeCompare(right.id);
  });
  return combined.slice(0, clampLimit(limit));
}

function clampLimit(limit?: number): number {
  const requested = limit ?? DEFAULT_LIST_LIMIT;
  return Math.min(Math.max(requested, 0), MAX_LIST_LIMIT);
}
