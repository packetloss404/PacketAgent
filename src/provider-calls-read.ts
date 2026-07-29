import {
  createProviderCallsRepository,
  type ProviderCallsRepository,
} from "./repositories/provider-calls-repo.js";
import { loadStore as defaultLoadStore } from "./packetagent-store.js";
import type { ProviderCallRecord, PacketAgentData } from "./packetagent-store.js";

export interface ProviderCallsReadDeps {
  loadStore?: () => PacketAgentData;
  mutateStore?: <T>(mutator: (data: PacketAgentData) => T) => T;
  repository?: ProviderCallsRepository;
}

export interface ListProviderCallsOptions {
  since?: string;
  limit?: number;
}

export function listProviderCallsForWorkspaceViaRepository(
  workspaceId: string,
  opts: ListProviderCallsOptions = {},
  deps: ProviderCallsReadDeps = {},
): ProviderCallRecord[] {
  const repo =
    deps.repository ??
    createProviderCallsRepository({
      loadStore: deps.loadStore,
      mutateStore: deps.mutateStore,
    });

  if (process.env.PACKETAGENT_STORE !== "sqlite") {
    return repo.list({ workspaceId, since: opts.since, limit: opts.limit });
  }

  const primary = repo.list({ workspaceId }).filter((entry) => entry.workspaceId === workspaceId);
  const fallback = legacyProviderCallsFromStore(deps).filter(
    (entry) => entry.workspaceId === workspaceId,
  );
  return mergeFilterSortAndLimit(primary, fallback, opts);
}

function legacyProviderCallsFromStore(deps: ProviderCallsReadDeps): ProviderCallRecord[] {
  const load = deps.loadStore ?? defaultLoadStore;
  try {
    const data = load();
    return Array.isArray(data.providerCalls) ? data.providerCalls : [];
  } catch {
    return [];
  }
}

function mergeFilterSortAndLimit(
  primary: ProviderCallRecord[],
  fallback: ProviderCallRecord[],
  opts: ListProviderCallsOptions,
): ProviderCallRecord[] {
  const seen = new Set<string>();
  const combined: ProviderCallRecord[] = [];
  for (const entry of primary) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    combined.push(entry);
  }
  for (const entry of fallback) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    combined.push(entry);
  }

  const filtered = opts.since
    ? combined.filter((entry) => Date.parse(entry.completedAt) >= Date.parse(opts.since as string))
    : combined;
  filtered.sort(compareProviderCalls);
  return isPositiveLimit(opts.limit) ? filtered.slice(0, opts.limit) : filtered;
}

function compareProviderCalls(left: ProviderCallRecord, right: ProviderCallRecord): number {
  const cmp = right.completedAt.localeCompare(left.completedAt);
  if (cmp !== 0) return cmp;
  return right.id.localeCompare(left.id);
}

function isPositiveLimit(limit: number | undefined): limit is number {
  return typeof limit === "number" && limit > 0;
}
