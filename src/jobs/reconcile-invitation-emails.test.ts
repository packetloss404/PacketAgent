import assert from "node:assert/strict";
import test from "node:test";
import { reconcileInvitationEmails } from "./reconcile-invitation-emails.js";
import type {
  InvitationEmailDeliveryRecord,
  PacketAgentData,
  WorkspaceInvitationRecord,
} from "../packetagent-store.js";
import type {
  InvitationEmailReconciliationInput,
  InvitationEmailReconciliationResult,
} from "../invitation-email-reconciliation.js";

test("lists failed deliveries sorted newest-first with redacted lastError", () => {
  const data = makeStore({
    deliveries: [
      makeDelivery({ id: "del_old", invitationId: "inv_a", workspaceId: "ws_alpha", status: "failed", error: "boom token=secret123", createdAt: "2026-04-20T10:00:00.000Z" }),
      makeDelivery({ id: "del_new", invitationId: "inv_a", workspaceId: "ws_alpha", status: "failed", error: "later boom", createdAt: "2026-04-22T10:00:00.000Z" }),
      makeDelivery({ id: "del_sent", invitationId: "inv_a", workspaceId: "ws_alpha", status: "sent", createdAt: "2026-04-21T10:00:00.000Z" }),
    ],
    invitations: [makeInvitation({ id: "inv_a", workspaceId: "ws_alpha" })],
  });

  const result = reconcileInvitationEmails({}, makeDeps(data));

  assert.equal(result.command, "reconcile-invitation-emails");
  assert.equal(result.scannedDeliveries, 3);
  assert.deepEqual(result.failedDeliveries.map((entry) => entry.deliveryId), ["del_new", "del_old"]);
  assert.equal(result.failedDeliveries[1].lastError, "boom token=[redacted]");
  assert.equal(result.actions.length, 0);
});

test("filters by workspaceId, invitationId, and deliveryId", () => {
  const data = makeStore({
    deliveries: [
      makeDelivery({ id: "del_alpha", invitationId: "inv_a", workspaceId: "ws_alpha", status: "failed", createdAt: "2026-04-20T10:00:00.000Z" }),
      makeDelivery({ id: "del_beta", invitationId: "inv_b", workspaceId: "ws_beta", status: "failed", createdAt: "2026-04-21T10:00:00.000Z" }),
      makeDelivery({ id: "del_gamma", invitationId: "inv_b", workspaceId: "ws_beta", status: "failed", createdAt: "2026-04-22T10:00:00.000Z" }),
    ],
    invitations: [makeInvitation({ id: "inv_a", workspaceId: "ws_alpha" }), makeInvitation({ id: "inv_b", workspaceId: "ws_beta" })],
  });

  const byWorkspace = reconcileInvitationEmails({ workspaceId: "ws_beta" }, makeDeps(data));
  assert.deepEqual(byWorkspace.failedDeliveries.map((entry) => entry.deliveryId), ["del_gamma", "del_beta"]);

  const byInvitation = reconcileInvitationEmails({ invitationId: "inv_a" }, makeDeps(data));
  assert.deepEqual(byInvitation.failedDeliveries.map((entry) => entry.deliveryId), ["del_alpha"]);

  const byDelivery = reconcileInvitationEmails({ deliveryId: "del_beta" }, makeDeps(data));
  assert.deepEqual(byDelivery.failedDeliveries.map((entry) => entry.deliveryId), ["del_beta"]);
});

test("skips rows whose providerStatus is delivered", () => {
  const data = makeStore({
    deliveries: [
      makeDelivery({ id: "del_failed_deferred", status: "failed", providerStatus: "deferred", createdAt: "2026-04-20T10:00:00.000Z" }),
      makeDelivery({ id: "del_failed_delivered", status: "failed", providerStatus: "delivered", createdAt: "2026-04-21T10:00:00.000Z" }),
    ],
    invitations: [],
  });

  const result = reconcileInvitationEmails({}, makeDeps(data));
  assert.deepEqual(result.failedDeliveries.map((entry) => entry.deliveryId), ["del_failed_deferred"]);
});

test("markResolved with known deliveryId calls apply with providerStatus=delivered", () => {
  const data = makeStore({
    deliveries: [makeDelivery({ id: "del_1", status: "failed", createdAt: "2026-04-20T10:00:00.000Z" })],
    invitations: [],
  });
  const calls: InvitationEmailReconciliationInput[] = [];
  const apply = (input: InvitationEmailReconciliationInput): InvitationEmailReconciliationResult => {
    calls.push(input);
    return {
      ok: true,
      deliveryId: input.deliveryId,
      invitationId: "inv_1",
      workspaceId: "ws_alpha",
      providerStatus: input.providerStatus,
      appliedAt: input.occurredAt ?? "2026-04-26T10:00:00.000Z",
    };
  };

  const result = reconcileInvitationEmails(
    { deliveryId: "del_1", markResolved: true, now: () => "2026-04-26T12:34:56.000Z" },
    { ...makeDeps(data), apply },
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    deliveryId: "del_1",
    providerStatus: "delivered",
    occurredAt: "2026-04-26T12:34:56.000Z",
  });
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].ok, true);
  assert.equal(result.actions[0].action, "mark_resolved");
  assert.equal(result.actions[0].deliveryId, "del_1");
  assert.match(result.actions[0].detail ?? "", /providerStatus=delivered/);
});

test("markResolved with unknown deliveryId records a failed action", () => {
  const data = makeStore({ deliveries: [], invitations: [] });
  const apply = (): InvitationEmailReconciliationResult => {
    throw new Error("apply should not be called for unknown delivery");
  };

  const result = reconcileInvitationEmails(
    { deliveryId: "missing", markResolved: true },
    { ...makeDeps(data), apply },
  );

  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].ok, false);
  assert.equal(result.actions[0].detail, "delivery not found");
});

test("requeue with known deliveryId calls enqueueRetry and records job id", () => {
  const delivery = makeDelivery({ id: "del_re", invitationId: "inv_re", workspaceId: "ws_alpha", status: "failed", createdAt: "2026-04-20T10:00:00.000Z" });
  const data = makeStore({
    deliveries: [delivery],
    invitations: [makeInvitation({ id: "inv_re", workspaceId: "ws_alpha", invitedByUserId: "user_1" })],
  });
  const enqueueCalls: InvitationEmailDeliveryRecord[] = [];
  const enqueueRetry = (entry: InvitationEmailDeliveryRecord): string => {
    enqueueCalls.push(entry);
    return "job_new_42";
  };

  const result = reconcileInvitationEmails(
    { deliveryId: "del_re", requeue: true },
    { ...makeDeps(data), enqueueRetry },
  );

  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].id, "del_re");
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].ok, true);
  assert.equal(result.actions[0].action, "requeue");
  assert.match(result.actions[0].detail ?? "", /job_new_42/);
});

test("markResolved + requeue together returns a validation failure and skips both", () => {
  const data = makeStore({
    deliveries: [makeDelivery({ id: "del_x", status: "failed", createdAt: "2026-04-20T10:00:00.000Z" })],
    invitations: [],
  });
  let applyCalled = false;
  let enqueueCalled = false;
  const apply = (): InvitationEmailReconciliationResult => {
    applyCalled = true;
    throw new Error("apply must not be called");
  };
  const enqueueRetry = (): string => {
    enqueueCalled = true;
    throw new Error("enqueueRetry must not be called");
  };

  const result = reconcileInvitationEmails(
    { deliveryId: "del_x", markResolved: true, requeue: true },
    { ...makeDeps(data), apply, enqueueRetry },
  );

  assert.equal(applyCalled, false);
  assert.equal(enqueueCalled, false);
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].ok, false);
  assert.equal(result.actions[0].detail, "markResolved and requeue are mutually exclusive");
});

test("default now produces an ISO timestamp", () => {
  const data = makeStore({
    deliveries: [makeDelivery({ id: "del_iso", status: "failed", createdAt: "2026-04-20T10:00:00.000Z" })],
    invitations: [],
  });
  const observed: string[] = [];
  const apply = (input: InvitationEmailReconciliationInput): InvitationEmailReconciliationResult => {
    observed.push(input.occurredAt ?? "");
    return {
      ok: true,
      deliveryId: input.deliveryId,
      invitationId: "inv_1",
      workspaceId: "ws_alpha",
      providerStatus: input.providerStatus,
      appliedAt: input.occurredAt ?? "",
    };
  };

  reconcileInvitationEmails(
    { deliveryId: "del_iso", markResolved: true },
    { ...makeDeps(data), apply },
  );

  assert.equal(observed.length, 1);
  assert.match(observed[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

interface StoreSeed {
  deliveries: InvitationEmailDeliveryRecord[];
  invitations: WorkspaceInvitationRecord[];
}

function makeStore(seed: StoreSeed): PacketAgentData {
  return {
    invitationEmailDeliveries: seed.deliveries,
    workspaceInvitations: seed.invitations,
  } as unknown as PacketAgentData;
}

function makeDeps(data: PacketAgentData) {
  return {
    loadStore: () => data,
    mutateStore: <T>(mutator: (data: PacketAgentData) => T): T => mutator(data),
  };
}

function makeDelivery(input: Partial<InvitationEmailDeliveryRecord> & { id: string }): InvitationEmailDeliveryRecord {
  return {
    id: input.id,
    workspaceId: input.workspaceId ?? "ws_alpha",
    invitationId: input.invitationId ?? "inv_1",
    recipientEmail: input.recipientEmail ?? "person@example.com",
    subject: input.subject ?? "Welcome",
    status: input.status ?? "failed",
    provider: input.provider ?? "test",
    mode: input.mode ?? "webhook",
    createdAt: input.createdAt ?? "2026-04-20T10:00:00.000Z",
    sentAt: input.sentAt,
    error: input.error,
    providerStatus: input.providerStatus,
    providerDeliveryId: input.providerDeliveryId,
    providerStatusAt: input.providerStatusAt,
    providerError: input.providerError,
  };
}

function makeInvitation(input: Partial<WorkspaceInvitationRecord> & { id: string; workspaceId: string }): WorkspaceInvitationRecord {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    email: input.email ?? "person@example.com",
    role: input.role ?? "member",
    token: input.token ?? "tok_abc",
    invitedByUserId: input.invitedByUserId ?? "user_1",
    acceptedByUserId: input.acceptedByUserId,
    acceptedAt: input.acceptedAt,
    revokedAt: input.revokedAt,
    expiresAt: input.expiresAt ?? "2026-12-31T00:00:00.000Z",
    createdAt: input.createdAt ?? "2026-04-20T10:00:00.000Z",
  };
}
