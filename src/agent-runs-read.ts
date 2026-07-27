import { createAgentRunsRepository, type AgentRunsRepository } from "./repositories/agent-runs-repo.js";
import { loadStore as defaultLoadStore } from "./packetagent-store.js";
import type { AgentRunRecord, PacketAgentData } from "./packetagent-store.js";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

export interface AgentRunsReadDeps {
  loadStore?: () => PacketAgentData;
  mutateStore?: <T>(mutator: (data: PacketAgentData) => T) => T;
  repository?: AgentRunsRepository;
}

export function listAgentRunsForWorkspaceViaRepository(
  workspaceId: string,
  limit?: number,
  deps: AgentRunsReadDeps = {},
): AgentRunRecord[] {
  const repo = deps.repository ?? createAgentRunsRepository({
    loadStore: deps.loadStore,
    mutateStore: deps.mutateStore,
  });
  const primary = repo.list(workspaceId, limit);
  if (process.env.PACKETAGENT_STORE !== "sqlite") return primary;
  const fallback = legacyAgentRunsFromStore(deps).filter((entry) => entry.workspaceId === workspaceId);
  return mergeAndLimit(primary, fallback, limit);
}

export function listAgentRunsForAgentViaRepository(
  workspaceId: string,
  agentId: string,
  limit?: number,
  deps: AgentRunsReadDeps = {},
): AgentRunRecord[] {
  const repo = deps.repository ?? createAgentRunsRepository({
    loadStore: deps.loadStore,
    mutateStore: deps.mutateStore,
  });
  const primary = repo.listForAgent(workspaceId, agentId, limit);
  if (process.env.PACKETAGENT_STORE !== "sqlite") return primary;
  const fallback = legacyAgentRunsFromStore(deps).filter(
    (entry) => entry.workspaceId === workspaceId && entry.agentId === agentId,
  );
  return mergeAndLimit(primary, fallback, limit);
}

export function findAgentRunForWorkspaceViaRepository(
  workspaceId: string,
  runId: string,
  deps: AgentRunsReadDeps = {},
): AgentRunRecord | null {
  const repo = deps.repository ?? createAgentRunsRepository({
    loadStore: deps.loadStore,
    mutateStore: deps.mutateStore,
  });
  const found = repo.find(workspaceId, runId);
  if (found) return found;
  if (process.env.PACKETAGENT_STORE !== "sqlite") return null;
  return legacyAgentRunsFromStore(deps)
    .find((entry) => entry.workspaceId === workspaceId && entry.id === runId) ?? null;
}

function legacyAgentRunsFromStore(deps: AgentRunsReadDeps): AgentRunRecord[] {
  const load = deps.loadStore ?? defaultLoadStore;
  try {
    const data = load();
    return Array.isArray(data.agentRuns) ? data.agentRuns : [];
  } catch {
    return [];
  }
}

function mergeAndLimit(
  primary: AgentRunRecord[],
  fallback: AgentRunRecord[],
  limit?: number,
): AgentRunRecord[] {
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
