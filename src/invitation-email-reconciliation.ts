import type { PacketAgentData } from "./packetagent-store.js";
import {
  loadStore as defaultLoadStore,
  mutateStore as defaultMutateStore,
  recordInvitationEmailProviderStatus,
} from "./packetagent-store.js";
import { redactedErrorMessage } from "./security/redaction.js";

export type ProviderDeliveryStatus =
  | "delivered"
  | "bounced"
  | "complained"
  | "deferred"
  | "dropped"
  | "failed";

export interface InvitationEmailReconciliationInput {
  deliveryId: string;
  providerStatus: ProviderDeliveryStatus;
  providerDeliveryId?: string;
  providerError?: string;
  occurredAt?: string;
}

export interface InvitationEmailReconciliationSuccess {
  ok: true;
  deliveryId: string;
  invitationId: string;
  workspaceId: string;
  providerStatus: ProviderDeliveryStatus;
  appliedAt: string;
}

export type InvitationEmailReconciliationFailure =
  | { ok: false; reason: "delivery_not_found"; deliveryId: string }
  | { ok: false; reason: "invalid_status"; providerStatus: string }
  | { ok: false; reason: "validation"; field: string };

export type InvitationEmailReconciliationResult =
  | InvitationEmailReconciliationSuccess
  | InvitationEmailReconciliationFailure;

const CANONICAL_STATUSES: ReadonlySet<ProviderDeliveryStatus> = new Set([
  "delivered",
  "bounced",
  "complained",
  "deferred",
  "dropped",
  "failed",
]);

// Maps common provider-side aliases to the canonical ProviderDeliveryStatus union.
const STATUS_ALIASES: Readonly<Record<string, ProviderDeliveryStatus>> = {
  delivery: "delivered",
  hard_bounce: "bounced",
  soft_bounce: "bounced",
  complaint: "complained",
  spam: "complained",
  defer: "deferred",
  drop: "dropped",
  fail: "failed",
  error: "failed",
};

export function normalizeProviderStatus(value: unknown): ProviderDeliveryStatus | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (CANONICAL_STATUSES.has(normalized as ProviderDeliveryStatus)) {
    return normalized as ProviderDeliveryStatus;
  }
  return STATUS_ALIASES[normalized] ?? null;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function parseInvitationEmailReconciliationBody(
  body: unknown,
): { ok: true; input: InvitationEmailReconciliationInput } | InvitationEmailReconciliationFailure {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "validation", field: "body" };
  }

  const record = body as Record<string, unknown>;

  const deliveryId = optionalString(record.deliveryId);
  if (!deliveryId) {
    return { ok: false, reason: "validation", field: "deliveryId" };
  }

  const rawProviderStatus = record.providerStatus;
  if (typeof rawProviderStatus !== "string" || !rawProviderStatus.trim()) {
    return { ok: false, reason: "validation", field: "providerStatus" };
  }
  const providerStatus = normalizeProviderStatus(rawProviderStatus);
  if (!providerStatus) {
    return { ok: false, reason: "invalid_status", providerStatus: rawProviderStatus };
  }

  const providerDeliveryId = optionalString(record.providerDeliveryId);
  const occurredAt = optionalString(record.occurredAt);
  const rawProviderError = optionalString(record.providerError);
  const providerError = rawProviderError ? redactedErrorMessage(rawProviderError, []) : undefined;

  return {
    ok: true,
    input: {
      deliveryId,
      providerStatus,
      providerDeliveryId,
      providerError,
      occurredAt,
    },
  };
}

export interface InvitationEmailReconciliationDeps {
  loadStore?: () => PacketAgentData;
  mutateStore?: <T>(mutator: (data: PacketAgentData) => T) => T;
  now?: () => string;
}

export function applyInvitationEmailReconciliation(
  input: InvitationEmailReconciliationInput,
  deps: InvitationEmailReconciliationDeps = {},
): InvitationEmailReconciliationResult {
  const mutate = deps.mutateStore ?? defaultMutateStore;
  const now = deps.now ?? (() => new Date().toISOString());
  // loadStore is part of the dep contract for downstream callers but apply only needs mutateStore.
  void (deps.loadStore ?? defaultLoadStore);

  const occurredAt = input.occurredAt ?? now();

  const updated = mutate((data) =>
    recordInvitationEmailProviderStatus(data, {
      deliveryId: input.deliveryId,
      providerStatus: input.providerStatus,
      providerDeliveryId: input.providerDeliveryId,
      providerError: input.providerError,
      occurredAt,
    }),
  );

  if (!updated) {
    return { ok: false, reason: "delivery_not_found", deliveryId: input.deliveryId };
  }

  return {
    ok: true,
    deliveryId: updated.id,
    invitationId: updated.invitationId,
    workspaceId: updated.workspaceId,
    providerStatus: input.providerStatus,
    appliedAt: occurredAt,
  };
}
