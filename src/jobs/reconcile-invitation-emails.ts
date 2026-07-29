import {
  loadStore as defaultLoadStore,
  mutateStore as defaultMutateStore,
  type InvitationEmailDeliveryRecord,
  type JobRecord,
  type PacketAgentData,
  type WorkspaceInvitationRecord,
} from "../packetagent-store.js";
import { applyInvitationEmailReconciliation } from "../invitation-email-reconciliation.js";
import { enqueueJob } from "./store.js";
import { resolveInvitationEmailRetryMaxAttempts } from "../invitation-email.js";
import { redactedErrorMessage } from "../security/redaction.js";

const INVITATION_EMAIL_JOB_TYPE = "invitation.email";

export interface ReconcileInvitationEmailsOptions {
  workspaceId?: string;
  invitationId?: string;
  deliveryId?: string;
  markResolved?: boolean;
  requeue?: boolean;
  now?: () => string;
}

export interface ReconcileFailedDelivery {
  deliveryId: string;
  invitationId: string;
  workspaceId: string;
  recipientEmail: string;
  status: string;
  providerStatus?: string;
  providerDeliveryId?: string;
  lastError?: string;
  attemptedAt: string;
}

export interface ReconcileAction {
  deliveryId: string;
  action: "mark_resolved" | "requeue";
  ok: boolean;
  detail?: string;
}

export interface ReconcileInvitationEmailsResult {
  command: "reconcile-invitation-emails";
  scannedDeliveries: number;
  failedDeliveries: ReconcileFailedDelivery[];
  actions: ReconcileAction[];
}

export interface ReconcileInvitationEmailsDeps {
  loadStore?: () => PacketAgentData;
  mutateStore?: <T>(mutator: (data: PacketAgentData) => T) => T;
  apply?: typeof applyInvitationEmailReconciliation;
  enqueueRetry?: (delivery: InvitationEmailDeliveryRecord) => string;
  now?: () => string;
}

export function reconcileInvitationEmails(
  options: ReconcileInvitationEmailsOptions = {},
  deps: ReconcileInvitationEmailsDeps = {},
): ReconcileInvitationEmailsResult {
  const loadStore = deps.loadStore ?? defaultLoadStore;
  const mutateStore = deps.mutateStore ?? defaultMutateStore;
  const apply = deps.apply ?? applyInvitationEmailReconciliation;
  const now = options.now ?? deps.now ?? (() => new Date().toISOString());
  const enqueueRetry =
    deps.enqueueRetry ??
    ((delivery: InvitationEmailDeliveryRecord) => defaultEnqueueRetry(loadStore(), delivery));

  const data = loadStore();
  const allDeliveries = data.invitationEmailDeliveries ?? [];
  const filtered = allDeliveries.filter((entry) => {
    if (options.workspaceId && entry.workspaceId !== options.workspaceId) return false;
    if (options.invitationId && entry.invitationId !== options.invitationId) return false;
    if (options.deliveryId && entry.id !== options.deliveryId) return false;
    return true;
  });

  const needsReconciliation = filtered
    .filter((entry) => entry.status === "failed" && entry.providerStatus !== "delivered")
    .slice()
    .sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    );

  const failedDeliveries: ReconcileFailedDelivery[] = needsReconciliation.map((entry) => ({
    deliveryId: entry.id,
    invitationId: entry.invitationId,
    workspaceId: entry.workspaceId,
    recipientEmail: entry.recipientEmail,
    status: entry.status,
    providerStatus: entry.providerStatus,
    providerDeliveryId: entry.providerDeliveryId,
    lastError: entry.error ? redactedErrorMessage(entry.error) : undefined,
    attemptedAt: entry.sentAt ?? entry.createdAt,
  }));

  const actions: ReconcileAction[] = [];

  if (options.markResolved && options.requeue && options.deliveryId) {
    actions.push({
      deliveryId: options.deliveryId,
      action: "mark_resolved",
      ok: false,
      detail: "markResolved and requeue are mutually exclusive",
    });
    return {
      command: "reconcile-invitation-emails",
      scannedDeliveries: filtered.length,
      failedDeliveries,
      actions,
    };
  }

  if (options.markResolved && options.deliveryId) {
    const delivery = allDeliveries.find((entry) => entry.id === options.deliveryId);
    if (!delivery) {
      actions.push({
        deliveryId: options.deliveryId,
        action: "mark_resolved",
        ok: false,
        detail: "delivery not found",
      });
    } else {
      const result = apply({
        deliveryId: options.deliveryId,
        providerStatus: "delivered",
        occurredAt: now(),
      });
      if (result.ok) {
        actions.push({
          deliveryId: options.deliveryId,
          action: "mark_resolved",
          ok: true,
          detail: `applied providerStatus=delivered at ${result.appliedAt}`,
        });
      } else {
        actions.push({
          deliveryId: options.deliveryId,
          action: "mark_resolved",
          ok: false,
          detail: reconciliationFailureDetail(result),
        });
      }
    }
  }

  if (options.requeue && options.deliveryId) {
    const delivery = allDeliveries.find((entry) => entry.id === options.deliveryId);
    if (!delivery) {
      actions.push({
        deliveryId: options.deliveryId,
        action: "requeue",
        ok: false,
        detail: "delivery not found",
      });
    } else {
      try {
        const jobId = enqueueRetry(delivery);
        actions.push({
          deliveryId: options.deliveryId,
          action: "requeue",
          ok: true,
          detail: `enqueued invitation.email job ${jobId}`,
        });
      } catch (error) {
        actions.push({
          deliveryId: options.deliveryId,
          action: "requeue",
          ok: false,
          detail: redactedErrorMessage(error),
        });
      }
    }
  }

  void mutateStore;

  return {
    command: "reconcile-invitation-emails",
    scannedDeliveries: filtered.length,
    failedDeliveries,
    actions,
  };
}

function reconciliationFailureDetail(
  result: Extract<ReturnType<typeof applyInvitationEmailReconciliation>, { ok: false }>,
): string {
  switch (result.reason) {
    case "delivery_not_found":
      return "delivery not found";
    case "invalid_status":
      return `invalid provider status: ${result.providerStatus}`;
    case "validation":
      return `validation failed for field: ${result.field}`;
    default:
      return "reconciliation failed";
  }
}

function defaultEnqueueRetry(
  data: PacketAgentData,
  delivery: InvitationEmailDeliveryRecord,
): string {
  const invitation = findInvitation(data, delivery.invitationId, delivery.workspaceId);
  const payload: Record<string, unknown> = {
    invitationId: delivery.invitationId,
    action: "resend" as const,
  };
  if (invitation?.invitedByUserId) {
    payload.requestedByUserId = invitation.invitedByUserId;
  }
  const job: JobRecord = enqueueJob({
    workspaceId: delivery.workspaceId,
    type: INVITATION_EMAIL_JOB_TYPE,
    payload,
    maxAttempts: resolveInvitationEmailRetryMaxAttempts(),
  });
  return job.id;
}

function findInvitation(
  data: PacketAgentData,
  invitationId: string,
  workspaceId: string,
): WorkspaceInvitationRecord | undefined {
  return (data.workspaceInvitations ?? []).find(
    (entry) => entry.id === invitationId && entry.workspaceId === workspaceId,
  );
}
