import {
  createActivitiesRepository,
  type ActivitiesRepository,
} from "./repositories/activities-repo.js";
import { loadStore as defaultLoadStore } from "./packetagent-store.js";
import type { ActivityRecord, PacketAgentData } from "./packetagent-store.js";

export interface ActivitiesReadDeps {
  loadStore?: () => PacketAgentData;
  mutateStore?: <T>(mutator: (data: PacketAgentData) => T) => T;
  repository?: ActivitiesRepository;
}

export function listActivitiesForWorkspaceViaRepository(
  workspaceId: string,
  limit?: number,
  deps: ActivitiesReadDeps = {},
): ActivityRecord[] {
  const repo = deps.repository ?? createActivitiesRepository({
    loadStore: deps.loadStore,
    mutateStore: deps.mutateStore,
  });

  if (process.env.PACKETAGENT_STORE !== "sqlite") {
    return repo.list({ workspaceId, limit });
  }

  const primary = repo.list({ workspaceId }).filter((entry) => entry.workspaceId === workspaceId);
  const fallback = legacyActivitiesFromStore(deps).filter((entry) => entry.workspaceId === workspaceId);
  return mergeSortAndLimit(primary, fallback, limit);
}

function legacyActivitiesFromStore(deps: ActivitiesReadDeps): ActivityRecord[] {
  const load = deps.loadStore ?? defaultLoadStore;
  try {
    const data = load();
    return Array.isArray(data.activities) ? data.activities : [];
  } catch {
    return [];
  }
}

function mergeSortAndLimit(
  primary: ActivityRecord[],
  fallback: ActivityRecord[],
  limit?: number,
): ActivityRecord[] {
  const seen = new Set<string>();
  const combined: ActivityRecord[] = [];
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
  combined.sort((left, right) => {
    const cmp = right.occurredAt.localeCompare(left.occurredAt);
    if (cmp !== 0) return cmp;
    return right.id.localeCompare(left.id);
  });
  return limit && limit > 0 ? combined.slice(0, limit) : combined;
}
