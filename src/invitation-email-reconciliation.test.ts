import assert from "node:assert/strict";
import test from "node:test";
import {
  applyInvitationEmailReconciliation,
  normalizeProviderStatus,
  parseInvitationEmailReconciliationBody,
} from "./invitation-email-reconciliation.js";
import type { InvitationEmailDeliveryRecord, PacketAgentData } from "./packetagent-store.js";

function makeDelivery(
  overrides: Partial<InvitationEmailDeliveryRecord> = {},
): InvitationEmailDeliveryRecord {
  return {
    id: "delivery-1",
    workspaceId: "workspace-1",
    invitationId: "invitation-1",
    recipientEmail: "user@example.com",
    subject: "Welcome",
    status: "pending",
    provider: "webhook",
    mode: "webhook",
    createdAt: "2026-04-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeFakeStore(deliveries: InvitationEmailDeliveryRecord[]): {
  data: PacketAgentData;
  loadStore: () => PacketAgentData;
  mutateStore: <T>(mutator: (data: PacketAgentData) => T) => T;
} {
  const data = { invitationEmailDeliveries: deliveries } as unknown as PacketAgentData;
  return {
    data,
    loadStore: () => data,
    mutateStore: (mutator) => mutator(data),
  };
}

test("normalizeProviderStatus accepts canonical values", () => {
  assert.equal(normalizeProviderStatus("delivered"), "delivered");
  assert.equal(normalizeProviderStatus("BOUNCED"), "bounced");
  assert.equal(normalizeProviderStatus("  Failed  "), "failed");
  assert.equal(normalizeProviderStatus("complained"), "complained");
  assert.equal(normalizeProviderStatus("deferred"), "deferred");
  assert.equal(normalizeProviderStatus("dropped"), "dropped");
});

test("normalizeProviderStatus resolves common aliases", () => {
  assert.equal(normalizeProviderStatus("delivery"), "delivered");
  assert.equal(normalizeProviderStatus("hard_bounce"), "bounced");
  assert.equal(normalizeProviderStatus("soft_bounce"), "bounced");
  assert.equal(normalizeProviderStatus("complaint"), "complained");
  assert.equal(normalizeProviderStatus("spam"), "complained");
  assert.equal(normalizeProviderStatus("defer"), "deferred");
  assert.equal(normalizeProviderStatus("drop"), "dropped");
  assert.equal(normalizeProviderStatus("fail"), "failed");
  assert.equal(normalizeProviderStatus("error"), "failed");
});

test("normalizeProviderStatus rejects unknown values and non-strings", () => {
  assert.equal(normalizeProviderStatus("queued"), null);
  assert.equal(normalizeProviderStatus(""), null);
  assert.equal(normalizeProviderStatus(null), null);
  assert.equal(normalizeProviderStatus(undefined), null);
  assert.equal(normalizeProviderStatus(42), null);
  assert.equal(normalizeProviderStatus({}), null);
});

test("parseInvitationEmailReconciliationBody rejects non-objects", () => {
  assert.deepEqual(parseInvitationEmailReconciliationBody(null), {
    ok: false,
    reason: "validation",
    field: "body",
  });
  assert.deepEqual(parseInvitationEmailReconciliationBody("hello"), {
    ok: false,
    reason: "validation",
    field: "body",
  });
  assert.deepEqual(parseInvitationEmailReconciliationBody([]), {
    ok: false,
    reason: "validation",
    field: "body",
  });
});

test("parseInvitationEmailReconciliationBody rejects missing or empty deliveryId", () => {
  assert.deepEqual(parseInvitationEmailReconciliationBody({ providerStatus: "delivered" }), {
    ok: false,
    reason: "validation",
    field: "deliveryId",
  });
  assert.deepEqual(
    parseInvitationEmailReconciliationBody({ deliveryId: "   ", providerStatus: "delivered" }),
    { ok: false, reason: "validation", field: "deliveryId" },
  );
});

test("parseInvitationEmailReconciliationBody returns invalid_status with raw value for unknown statuses", () => {
  const result = parseInvitationEmailReconciliationBody({
    deliveryId: "delivery-1",
    providerStatus: "Quarantined",
  });
  assert.deepEqual(result, { ok: false, reason: "invalid_status", providerStatus: "Quarantined" });
});

test("parseInvitationEmailReconciliationBody returns success with normalized status for aliases", () => {
  const result = parseInvitationEmailReconciliationBody({
    deliveryId: "delivery-1",
    providerStatus: "hard_bounce",
    providerDeliveryId: "provider-message-1",
    occurredAt: "2026-04-26T12:00:00.000Z",
  });
  assert.deepEqual(result, {
    ok: true,
    input: {
      deliveryId: "delivery-1",
      providerStatus: "bounced",
      providerDeliveryId: "provider-message-1",
      providerError: undefined,
      occurredAt: "2026-04-26T12:00:00.000Z",
    },
  });
});

test("parseInvitationEmailReconciliationBody redacts Bearer tokens in providerError", () => {
  const result = parseInvitationEmailReconciliationBody({
    deliveryId: "delivery-1",
    providerStatus: "failed",
    providerError: "upstream rejected with Bearer abc123tokenvalue",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.input.providerError?.includes("abc123tokenvalue"), false);
  assert.equal(result.input.providerError?.includes("Bearer [redacted]"), true);
});

test("parseInvitationEmailReconciliationBody coerces empty optional fields to undefined", () => {
  const result = parseInvitationEmailReconciliationBody({
    deliveryId: "delivery-1",
    providerStatus: "delivered",
    providerDeliveryId: "",
    providerError: "   ",
    occurredAt: "",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.input.providerDeliveryId, undefined);
  assert.equal(result.input.providerError, undefined);
  assert.equal(result.input.occurredAt, undefined);
});

test("applyInvitationEmailReconciliation returns delivery_not_found for unknown id", () => {
  const store = makeFakeStore([makeDelivery({ id: "other-delivery" })]);
  const result = applyInvitationEmailReconciliation(
    { deliveryId: "missing", providerStatus: "delivered" },
    {
      loadStore: store.loadStore,
      mutateStore: store.mutateStore,
      now: () => "2026-04-26T00:00:00.000Z",
    },
  );
  assert.deepEqual(result, { ok: false, reason: "delivery_not_found", deliveryId: "missing" });
});

test("applyInvitationEmailReconciliation mutates the matching row and returns success", () => {
  const delivery = makeDelivery({ id: "delivery-99", workspaceId: "ws-1", invitationId: "inv-1" });
  const store = makeFakeStore([delivery]);
  const result = applyInvitationEmailReconciliation(
    {
      deliveryId: "delivery-99",
      providerStatus: "bounced",
      providerDeliveryId: "provider-msg-99",
      providerError: "mailbox full",
      occurredAt: "2026-04-26T10:00:00.000Z",
    },
    { loadStore: store.loadStore, mutateStore: store.mutateStore, now: () => "ignored" },
  );
  assert.deepEqual(result, {
    ok: true,
    deliveryId: "delivery-99",
    invitationId: "inv-1",
    workspaceId: "ws-1",
    providerStatus: "bounced",
    appliedAt: "2026-04-26T10:00:00.000Z",
  });
  assert.equal(delivery.providerStatus, "bounced");
  assert.equal(delivery.providerDeliveryId, "provider-msg-99");
  assert.equal(delivery.providerError, "mailbox full");
  assert.equal(delivery.providerStatusAt, "2026-04-26T10:00:00.000Z");
});

test("applyInvitationEmailReconciliation defaults appliedAt to now() when occurredAt missing", () => {
  const delivery = makeDelivery({ id: "delivery-now" });
  const store = makeFakeStore([delivery]);
  const result = applyInvitationEmailReconciliation(
    { deliveryId: "delivery-now", providerStatus: "delivered" },
    {
      loadStore: store.loadStore,
      mutateStore: store.mutateStore,
      now: () => "2026-04-26T11:11:11.000Z",
    },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.appliedAt, "2026-04-26T11:11:11.000Z");
  assert.equal(delivery.providerStatusAt, "2026-04-26T11:11:11.000Z");
});
