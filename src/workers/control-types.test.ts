import assert from "node:assert/strict";
import test from "node:test";
import {
  assertValidWorkerApprovalGrant,
  assertValidWorkerAttentionRequest,
  assertValidWorkerControlCommand,
  assertValidWorkerNotificationDeliveryReference,
} from "./control-types.js";
import {
  makeWorkerApprovalGrant,
  makeWorkerAttentionRequest,
  makeWorkerControlCommand,
  makeWorkerNotificationDelivery,
} from "./__tests__/fixtures.js";

test("W7 control records accept complete immutable Worker bindings", () => {
  assert.doesNotThrow(() => assertValidWorkerAttentionRequest(makeWorkerAttentionRequest()));
  assert.doesNotThrow(() => assertValidWorkerApprovalGrant(makeWorkerApprovalGrant()));
  assert.doesNotThrow(() => assertValidWorkerControlCommand(makeWorkerControlCommand()));
  assert.doesNotThrow(() =>
    assertValidWorkerNotificationDeliveryReference(makeWorkerNotificationDelivery()),
  );
});

test("attention requests require bounded escalation and explicit terminal resolution", () => {
  assert.throws(
    () =>
      assertValidWorkerAttentionRequest(
        makeWorkerAttentionRequest({
          escalatesAt: "2026-07-27T13:30:00.000Z",
        }),
      ),
    /invalid/,
  );
  assert.throws(
    () =>
      assertValidWorkerAttentionRequest(
        makeWorkerAttentionRequest({
          status: "rejected",
        }),
      ),
    /resolution fields/,
  );
  assert.doesNotThrow(() =>
    assertValidWorkerAttentionRequest(
      makeWorkerAttentionRequest({
        status: "rejected",
        resolvedAt: "2026-07-27T12:10:00.000Z",
        resolvedBy: { type: "user", id: "operator-1" },
        resolutionCommandId: "control-command-1",
      }),
    ),
  );
});

test("approval grants are operation-bound, expiring, and one-time consumption is explicit", () => {
  assert.throws(
    () =>
      assertValidWorkerApprovalGrant(
        makeWorkerApprovalGrant({
          operationDigest: "not-a-digest",
        }),
      ),
    /invalid/,
  );
  assert.throws(
    () =>
      assertValidWorkerApprovalGrant(
        makeWorkerApprovalGrant({
          scope: "run",
          status: "consumed",
          consumedAt: "2026-07-27T12:10:00.000Z",
          consumedByActionId: "action-1",
        }),
      ),
    /one-time consumption/,
  );
  assert.doesNotThrow(() =>
    assertValidWorkerApprovalGrant(
      makeWorkerApprovalGrant({
        status: "consumed",
        consumedAt: "2026-07-27T12:10:00.000Z",
        consumedByActionId: "action-1",
      }),
    ),
  );
});

test("control commands enforce kind-specific targets and durable terminal outcomes", () => {
  assert.throws(
    () =>
      assertValidWorkerControlCommand(
        makeWorkerControlCommand({
          workerRunId: undefined,
        }),
      ),
    /target/,
  );
  assert.doesNotThrow(() =>
    assertValidWorkerControlCommand(
      makeWorkerControlCommand({
        kind: "revoke_deployment",
        workerRunId: undefined,
      }),
    ),
  );
  assert.doesNotThrow(() =>
    assertValidWorkerControlCommand(
      makeWorkerControlCommand({
        status: "applied",
        appliedAt: "2026-07-27T12:01:00.000Z",
        appliedRevision: 2,
        updatedAt: "2026-07-27T12:01:00.000Z",
      }),
    ),
  );
  assert.doesNotThrow(() =>
    assertValidWorkerControlCommand(
      makeWorkerControlCommand({
        actor: {
          type: "packet_product",
          id: "phone-operator-1",
          product: "PacketPhone",
        },
        remoteControl: {
          source: "packetphone",
          audience: "PacketPhone",
          actorRole: "admin",
          tokenIdDigest: `sha256:${"a".repeat(64)}`,
          nonceDigest: `sha256:${"b".repeat(64)}`,
        },
      }),
    ),
  );
  assert.throws(
    () =>
      assertValidWorkerControlCommand(
        makeWorkerControlCommand({
          remoteControl: {
            source: "packetphone",
            audience: "PacketPhone",
            actorRole: "admin",
            tokenIdDigest: `sha256:${"a".repeat(64)}`,
            nonceDigest: `sha256:${"b".repeat(64)}`,
          },
        }),
      ),
    /invalid/,
  );
});

test("notification delivery records separate retry state from proven delivery", () => {
  assert.throws(
    () =>
      assertValidWorkerNotificationDeliveryReference(
        makeWorkerNotificationDelivery({
          status: "delivered",
          deliveredAt: "2026-07-27T12:01:00.000Z",
        }),
      ),
    /delivery reference/,
  );
  assert.doesNotThrow(() =>
    assertValidWorkerNotificationDeliveryReference(
      makeWorkerNotificationDelivery({
        status: "dead_letter",
        attemptCount: 3,
        lastFailureCode: "route_unavailable",
        updatedAt: "2026-07-27T12:03:00.000Z",
      }),
    ),
  );
});
