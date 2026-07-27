import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import {
  DEFAULT_INVITATION_EMAIL_RECONCILIATION_SECRET_HEADER,
  PACKETAGENT_INVITATION_EMAIL_RECONCILIATION_SECRET_ENV,
  PACKETAGENT_INVITATION_EMAIL_RECONCILIATION_SECRET_HEADER_ENV,
} from "./invitation-email";
import { invitationEmailWebhookRoutes } from "./invitation-email-webhook-routes";
import {
  createInvitationEmailDelivery,
  findInvitationEmailDelivery,
  loadStore,
  mutateStore,
  resetStoreForTests,
} from "./packetagent-store";

const RECON_ENV_KEYS = [
  PACKETAGENT_INVITATION_EMAIL_RECONCILIATION_SECRET_ENV,
  PACKETAGENT_INVITATION_EMAIL_RECONCILIATION_SECRET_HEADER_ENV,
];

function createTestApp() {
  const app = new Hono();
  app.route("/api/public/webhooks/invitation-email", invitationEmailWebhookRoutes);
  return app;
}

function captureEnv(): Map<string, string | undefined> {
  return new Map(RECON_ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Map<string, string | undefined>): void {
  for (const key of RECON_ENV_KEYS) {
    const value = snapshot.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearReconciliationEnv(): void {
  for (const key of RECON_ENV_KEYS) delete process.env[key];
}

function seedDelivery(): string {
  const id = `delivery_${randomUUID()}`;
  mutateStore((data) =>
    createInvitationEmailDelivery(data, {
      id,
      workspaceId: "alpha",
      invitationId: `invite_${randomUUID()}`,
      recipientEmail: "invitee@example.com",
      subject: "You're invited",
      provider: "webhook",
      mode: "webhook",
      status: "sent",
      sentAt: "2026-04-26T10:00:00.000Z",
    }),
  );
  return id;
}

test("returns 503 when no reconciliation secret is configured", async () => {
  const snapshot = captureEnv();
  try {
    clearReconciliationEnv();
    resetStoreForTests();
    const app = createTestApp();

    const response = await app.request("/api/public/webhooks/invitation-email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deliveryId: "x", providerStatus: "delivered" }),
    });
    const body = await response.json() as { error: string };

    assert.equal(response.status, 503);
    assert.match(body.error, /reconciliation webhook is disabled/);
    assert.match(body.error, /PACKETAGENT_INVITATION_EMAIL_RECONCILIATION_SECRET/);
  } finally {
    restoreEnv(snapshot);
  }
});

test("returns 401 when the secret header is missing", async () => {
  const snapshot = captureEnv();
  try {
    clearReconciliationEnv();
    process.env[PACKETAGENT_INVITATION_EMAIL_RECONCILIATION_SECRET_ENV] = "shh-secret";
    resetStoreForTests();
    const app = createTestApp();

    const response = await app.request("/api/public/webhooks/invitation-email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deliveryId: "x", providerStatus: "delivered" }),
    });
    const body = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(body, { error: "unauthorized" });
  } finally {
    restoreEnv(snapshot);
  }
});

test("returns 401 when the secret header value is wrong", async () => {
  const snapshot = captureEnv();
  try {
    clearReconciliationEnv();
    process.env[PACKETAGENT_INVITATION_EMAIL_RECONCILIATION_SECRET_ENV] = "shh-secret";
    resetStoreForTests();
    const app = createTestApp();

    const response = await app.request("/api/public/webhooks/invitation-email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [DEFAULT_INVITATION_EMAIL_RECONCILIATION_SECRET_HEADER]: "wrong-secret",
      },
      body: JSON.stringify({ deliveryId: "x", providerStatus: "delivered" }),
    });
    const body = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(body, { error: "unauthorized" });
  } finally {
    restoreEnv(snapshot);
  }
});

test("returns 400 when the request body is not JSON", async () => {
  const snapshot = captureEnv();
  try {
    clearReconciliationEnv();
    process.env[PACKETAGENT_INVITATION_EMAIL_RECONCILIATION_SECRET_ENV] = "shh-secret";
    resetStoreForTests();
    const app = createTestApp();

    const response = await app.request("/api/public/webhooks/invitation-email", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        [DEFAULT_INVITATION_EMAIL_RECONCILIATION_SECRET_HEADER]: "shh-secret",
      },
      body: "not json",
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: "request body must be valid JSON" });
  } finally {
    restoreEnv(snapshot);
  }
});

test("returns 400 with the offending field when validation fails", async () => {
  const snapshot = captureEnv();
  try {
    clearReconciliationEnv();
    process.env[PACKETAGENT_INVITATION_EMAIL_RECONCILIATION_SECRET_ENV] = "shh-secret";
    resetStoreForTests();
    const app = createTestApp();

    const response = await app.request("/api/public/webhooks/invitation-email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [DEFAULT_INVITATION_EMAIL_RECONCILIATION_SECRET_HEADER]: "shh-secret",
      },
      body: JSON.stringify({ providerStatus: "delivered" }),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: "invalid request", field: "deliveryId" });
  } finally {
    restoreEnv(snapshot);
  }
});

test("returns 400 echoing the raw provider status when it is unknown", async () => {
  const snapshot = captureEnv();
  try {
    clearReconciliationEnv();
    process.env[PACKETAGENT_INVITATION_EMAIL_RECONCILIATION_SECRET_ENV] = "shh-secret";
    resetStoreForTests();
    const app = createTestApp();

    const response = await app.request("/api/public/webhooks/invitation-email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [DEFAULT_INVITATION_EMAIL_RECONCILIATION_SECRET_HEADER]: "shh-secret",
      },
      body: JSON.stringify({ deliveryId: "anything", providerStatus: "moonshot" }),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: "invalid provider status", providerStatus: "moonshot" });
  } finally {
    restoreEnv(snapshot);
  }
});

test("returns 404 when the delivery is unknown", async () => {
  const snapshot = captureEnv();
  try {
    clearReconciliationEnv();
    process.env[PACKETAGENT_INVITATION_EMAIL_RECONCILIATION_SECRET_ENV] = "shh-secret";
    resetStoreForTests();
    const app = createTestApp();

    const unknownId = `delivery_${randomUUID()}`;
    const response = await app.request("/api/public/webhooks/invitation-email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [DEFAULT_INVITATION_EMAIL_RECONCILIATION_SECRET_HEADER]: "shh-secret",
      },
      body: JSON.stringify({ deliveryId: unknownId, providerStatus: "delivered" }),
    });
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(body, { error: "delivery not found", deliveryId: unknownId });
  } finally {
    restoreEnv(snapshot);
  }
});

test("records provider status on the delivery row on success", async () => {
  const snapshot = captureEnv();
  try {
    clearReconciliationEnv();
    process.env[PACKETAGENT_INVITATION_EMAIL_RECONCILIATION_SECRET_ENV] = "shh-secret";
    resetStoreForTests();
    const app = createTestApp();
    const deliveryId = seedDelivery();

    const response = await app.request("/api/public/webhooks/invitation-email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [DEFAULT_INVITATION_EMAIL_RECONCILIATION_SECRET_HEADER]: "shh-secret",
      },
      body: JSON.stringify({
        deliveryId,
        providerStatus: "delivered",
        providerDeliveryId: "prov-123",
        occurredAt: "2026-04-26T11:00:00.000Z",
      }),
    });
    const body = await response.json() as {
      ok: boolean;
      deliveryId: string;
      invitationId: string;
      workspaceId: string;
      providerStatus: string;
      appliedAt: string;
    };

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.deliveryId, deliveryId);
    assert.equal(body.workspaceId, "alpha");
    assert.equal(body.providerStatus, "delivered");
    assert.equal(body.appliedAt, "2026-04-26T11:00:00.000Z");

    const stored = findInvitationEmailDelivery(loadStore(), deliveryId);
    assert.equal(stored?.providerStatus, "delivered");
    assert.equal(stored?.providerDeliveryId, "prov-123");
    assert.equal(stored?.providerStatusAt, "2026-04-26T11:00:00.000Z");
  } finally {
    restoreEnv(snapshot);
  }
});

test("normalizes alias provider statuses on success", async () => {
  const snapshot = captureEnv();
  try {
    clearReconciliationEnv();
    process.env[PACKETAGENT_INVITATION_EMAIL_RECONCILIATION_SECRET_ENV] = "shh-secret";
    resetStoreForTests();
    const app = createTestApp();
    const deliveryId = seedDelivery();

    const response = await app.request("/api/public/webhooks/invitation-email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [DEFAULT_INVITATION_EMAIL_RECONCILIATION_SECRET_HEADER]: "shh-secret",
      },
      body: JSON.stringify({
        deliveryId,
        providerStatus: "hard_bounce",
        occurredAt: "2026-04-26T12:00:00.000Z",
      }),
    });
    const body = await response.json() as { ok: boolean; providerStatus: string };

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.providerStatus, "bounced");

    const stored = findInvitationEmailDelivery(loadStore(), deliveryId);
    assert.equal(stored?.providerStatus, "bounced");
    assert.equal(stored?.providerStatusAt, "2026-04-26T12:00:00.000Z");
  } finally {
    restoreEnv(snapshot);
  }
});

test("honors a custom secret header from env", async () => {
  const snapshot = captureEnv();
  try {
    clearReconciliationEnv();
    process.env[PACKETAGENT_INVITATION_EMAIL_RECONCILIATION_SECRET_ENV] = "another-secret";
    process.env[PACKETAGENT_INVITATION_EMAIL_RECONCILIATION_SECRET_HEADER_ENV] = "x-custom-recon";
    resetStoreForTests();
    const app = createTestApp();
    const deliveryId = seedDelivery();

    const response = await app.request("/api/public/webhooks/invitation-email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-custom-recon": "another-secret",
      },
      body: JSON.stringify({
        deliveryId,
        providerStatus: "complained",
        occurredAt: "2026-04-26T13:00:00.000Z",
      }),
    });

    assert.equal(response.status, 200);
    const stored = findInvitationEmailDelivery(loadStore(), deliveryId);
    assert.equal(stored?.providerStatus, "complained");
  } finally {
    restoreEnv(snapshot);
  }
});
