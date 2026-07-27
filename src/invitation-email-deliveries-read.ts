import {
  createInvitationEmailDeliveriesRepository,
  type InvitationEmailDeliveriesRepository,
} from "./repositories/invitation-email-deliveries-repo.js";
import { loadStore as defaultLoadStore } from "./packetagent-store.js";
import type { InvitationEmailDeliveryRecord, PacketAgentData } from "./packetagent-store.js";

export interface InvitationEmailDeliveriesReadDeps {
  loadStore?: () => PacketAgentData;
  mutateStore?: <T>(mutator: (data: PacketAgentData) => T) => T;
  repository?: InvitationEmailDeliveriesRepository;
}

export function listInvitationEmailDeliveriesViaRepository(
  workspaceId: string,
  invitationId?: string,
  deps: InvitationEmailDeliveriesReadDeps = {},
): InvitationEmailDeliveryRecord[] {
  const repo = deps.repository ?? createInvitationEmailDeliveriesRepository({
    loadStore: deps.loadStore,
    mutateStore: deps.mutateStore,
  });
  const primary = repo.list({ workspaceId, invitationId });
  if (process.env.PACKETAGENT_STORE !== "sqlite") return primary;
  const fallback = legacyDeliveriesFromStore(deps).filter((entry) => {
    if (entry.workspaceId !== workspaceId) return false;
    if (invitationId !== undefined && entry.invitationId !== invitationId) return false;
    return true;
  });
  return mergeAndSort(primary, fallback);
}

function legacyDeliveriesFromStore(deps: InvitationEmailDeliveriesReadDeps): InvitationEmailDeliveryRecord[] {
  const load = deps.loadStore ?? defaultLoadStore;
  try {
    const data = load();
    return Array.isArray(data.invitationEmailDeliveries) ? data.invitationEmailDeliveries : [];
  } catch {
    return [];
  }
}

function mergeAndSort(
  primary: InvitationEmailDeliveryRecord[],
  fallback: InvitationEmailDeliveryRecord[],
): InvitationEmailDeliveryRecord[] {
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
  return combined;
}
