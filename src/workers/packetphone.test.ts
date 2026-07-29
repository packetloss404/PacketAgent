import assert from "node:assert/strict";
import test from "node:test";
import { createPacketProductCallbackRoutes } from "../packet-product-callback-routes.js";
import { createSeedStore, type PacketAgentData } from "../packetagent-store.js";
import { compileWorkerCapabilityPolicy } from "./capabilities.js";
import {
  WORKER_CREDENTIAL_SCHEMA_VERSION,
  type WorkerCredentialMetadata,
} from "./credential-types.js";
import { createWorkerControlService } from "./control-service.js";
import type { UseWorkerCredentialInput, WorkerCredentialService } from "./credentials.js";
import { createWorkerCredentialService } from "./credentials.js";
import { WorkerNetworkError, type WorkerNetworkPort } from "./network.js";
import {
  appendWorkerEventWithNotifications,
  WorkerNotificationDeliveryError,
} from "./notifications.js";
import {
  PACKETPHONE_MESSAGE_SCHEMA_VERSION,
  PACKETPHONE_ROUTE_SCHEMA_VERSION,
  PacketPhoneCallbackError,
  createPacketPhoneCallbackService,
  createPacketPhoneNotificationTransport,
  parsePacketPhoneRouteConfig,
  type PacketPhoneControlAction,
  type PacketPhoneWorkerControlMessage,
} from "./packetphone.js";
import {
  makeWorkerAttentionRequest,
  makeWorkerDefinition,
  makeWorkerDeployment,
  makeWorkerRun,
  makeWorkerVersion,
  makeWorkerVersionContent,
} from "./__tests__/fixtures.js";

const NOW = new Date("2026-07-28T15:00:00.000Z");
const CALLBACK_NOW = new Date("2026-07-28T15:00:30.000Z");
const ATTENTION_EXPIRES_AT = "2026-07-28T15:10:00.000Z";
const ROUTE_REFERENCE = "vault:packetphone-operations";
const ROUTE_ENDPOINT = "https://phone.example.test/api/worker-controls";
const BEARER_TOKEN = "packetphone-bearer-that-must-not-persist";
const CALLBACK_SECRET = "packetphone-callback-secret-at-least-32-bytes";
const ALL_ACTIONS: readonly PacketPhoneControlAction[] = [
  "approve_once",
  "reject_attention",
  "pause_run",
  "stop_run",
  "revoke_deployment",
];

test("PacketPhone delivery emits role-bounded deterministic controls without persisting secrets", async () => {
  const harness = packetPhoneHarness();
  const request = harness.notification();
  const credentials = testCredentialVault(harness.data);
  await credentials.upsert({
    workspaceId: "workspace-1",
    reference: ROUTE_REFERENCE,
    kind: "opaque",
    label: "PacketPhone operations route",
    value: routeConfig(),
  });
  const messages: PacketPhoneWorkerControlMessage[] = [];
  const transport = createPacketPhoneNotificationTransport({
    loadStore: () => harness.data,
    credentialService: credentials,
    network: captureMessages(messages),
  });

  const delivered = await transport.deliver({
    route: harness.route,
    envelope: request.envelope,
    idempotencyKey: request.idempotencyKey,
    signal: new AbortController().signal,
  });
  await transport.deliver({
    route: harness.route,
    envelope: request.envelope,
    idempotencyKey: request.idempotencyKey,
    signal: new AbortController().signal,
  });

  assert.equal(delivered.deliveryReference, "packetphone-request-42");
  assert.deepEqual(delivered.metadata, { provider: "packetphone", responseCode: 202 });
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], messages[1], "retry payload and callback tokens must be stable");
  const message = messages[0]!;
  assert.equal(message.schemaVersion, PACKETPHONE_MESSAGE_SCHEMA_VERSION);
  assert.deepEqual(message.worker, {
    workspaceId: "workspace-1",
    definitionId: "worker-1",
    deploymentId: "deployment-1",
    runId: "run-1",
    versionId: "worker-version-1",
    versionContentDigest: harness.versionDigest,
  });
  assert.equal(message.state.run, "waiting_for_approval");
  assert.equal(message.state.runRevision, 1);
  assert.equal(message.state.deploymentRevision, 1);
  assert.equal(message.attention?.id, "attention-1");
  assert.equal(message.evidence.id, request.envelope.evidenceId);
  assert.deepEqual(
    message.actions.map((action) => action.action),
    ALL_ACTIONS,
  );
  assert.ok(
    message.actions.every(
      (action) =>
        action.callback.method === "POST" &&
        action.callback.contentType === "application/json" &&
        action.callback.href.endsWith("/api/packet-products/packetphone/worker-control") &&
        action.callback.body.token.split(".").length === 3,
    ),
  );

  const durable = JSON.stringify(harness.data);
  assert.equal(durable.includes(ROUTE_ENDPOINT), false);
  assert.equal(durable.includes(BEARER_TOKEN), false);
  assert.equal(durable.includes(CALLBACK_SECRET), false);
  for (const action of message.actions) {
    assert.equal(durable.includes(action.callback.body.token), false);
  }
});

test("PacketPhone approve is consumed once by W7 and replay stays rejected after restart", async () => {
  const harness = packetPhoneHarness();
  const message = await harness.deliver();
  const token = tokenFor(message, "approve_once");
  const callback = harness.callback();

  const approved = await callback.consume(token);

  assert.equal(approved.action, "approve_once");
  assert.equal(approved.disposition, "applied");
  assert.equal(approved.command.kind, "approve_once");
  assert.equal(approved.attention?.status, "approved");
  assert.equal(approved.approval?.scope, "once");
  assert.equal("approvalNonce" in approved, false);
  const command = harness.data.workerControlCommands[0]!;
  assert.equal(command.actor.type, "packet_product");
  assert.equal(command.actor.product, "PacketPhone");
  assert.equal(command.actor.id, "phone-operator-1");
  assert.deepEqual(command.remoteControl, {
    source: "packetphone",
    audience: "PacketPhone",
    actorRole: "admin",
    tokenIdDigest: command.remoteControl?.tokenIdDigest,
    nonceDigest: command.remoteControl?.nonceDigest,
  });
  assert.match(command.remoteControl!.tokenIdDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(command.remoteControl!.nonceDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(harness.data).includes(token), false);
  assert.equal(JSON.stringify(harness.data).includes("approval-secret"), false);

  await assert.rejects(
    () => callback.consume(token),
    (error: unknown) =>
      error instanceof PacketPhoneCallbackError && error.code === "replayed_callback",
  );

  const afterRestart = JSON.parse(JSON.stringify(harness.data)) as PacketAgentData;
  const restarted = createCallbackForStore(afterRestart);
  await assert.rejects(
    () => restarted.consume(token),
    (error: unknown) =>
      error instanceof PacketPhoneCallbackError && error.code === "replayed_callback",
  );
  assert.equal(afterRestart.workerControlCommands.length, 1);
  assert.equal(afterRestart.workerApprovalGrants.length, 1);
});

for (const scenario of [
  {
    action: "reject_attention",
    verify(data: PacketAgentData) {
      assert.equal(data.workerAttentionRequests[0]?.status, "rejected");
      assert.equal(data.workerRuns[0]?.status, "failed");
    },
  },
  {
    action: "pause_run",
    verify(data: PacketAgentData) {
      assert.equal(data.workerRuns[0]?.status, "paused");
    },
  },
  {
    action: "stop_run",
    verify(data: PacketAgentData) {
      assert.equal(data.workerRuns[0]?.status, "cancelled");
      assert.equal(data.workerRuns[0]?.terminalReason, "operator_cancelled");
    },
  },
  {
    action: "revoke_deployment",
    verify(data: PacketAgentData) {
      assert.equal(data.workerDeployments[0]?.status, "revoked");
      assert.equal(data.workerRuns[0]?.terminalReason, "deployment_revoked");
    },
  },
] as const) {
  test(`PacketPhone ${scenario.action} delegates to the matching W7 command`, async () => {
    const harness = packetPhoneHarness();
    const message = await harness.deliver();
    const result = await harness.callback().consume(tokenFor(message, scenario.action));

    assert.equal(result.command.kind, scenario.action);
    assert.equal(harness.data.workerControlCommands.length, 1);
    assert.equal(harness.data.workerControlCommands[0]?.remoteControl?.actorRole, "admin");
    scenario.verify(harness.data);
  });
}

test("PacketPhone roles cannot mint controls outside the W7 permission matrix", async () => {
  const member = packetPhoneHarness({
    actorRole: "member",
    allowedActions: ["pause_run", "stop_run"],
  });
  const message = await member.deliver();
  assert.deepEqual(
    message.actions.map((action) => action.action),
    ["pause_run", "stop_run"],
  );

  assert.throws(
    () =>
      parsePacketPhoneRouteConfig(
        routeConfig({
          actorRole: "member",
          allowedActions: ["pause_run", "approve_once"],
        }),
      ),
    /configuration is invalid/,
  );
  assert.throws(
    () =>
      parsePacketPhoneRouteConfig(
        routeConfig({
          actorRole: "viewer",
          allowedActions: ["pause_run"],
        }),
      ),
    /configuration is invalid/,
  );
});

test("PacketPhone callbacks reject tamper, expiry, stale state, and resolved attention", async () => {
  const tamperHarness = packetPhoneHarness();
  const tamperMessage = await tamperHarness.deliver();
  const valid = tokenFor(tamperMessage, "approve_once");
  const tampered = `${valid.slice(0, -1)}${valid.endsWith("a") ? "b" : "a"}`;
  await assert.rejects(
    () => tamperHarness.callback().consume(tampered),
    (error: unknown) => error instanceof PacketPhoneCallbackError && error.code === "invalid_token",
  );

  await assert.rejects(
    () =>
      tamperHarness
        .callback(new Date("2026-07-28T15:06:00.000Z"))
        .consume(tokenFor(tamperMessage, "stop_run")),
    (error: unknown) => error instanceof PacketPhoneCallbackError && error.code === "expired_token",
  );

  const staleHarness = packetPhoneHarness();
  const staleMessage = await staleHarness.deliver();
  staleHarness.data.workerRuns[0] = {
    ...staleHarness.data.workerRuns[0]!,
    revision: 2,
    updatedAt: CALLBACK_NOW.toISOString(),
  };
  await assert.rejects(
    () => staleHarness.callback().consume(tokenFor(staleMessage, "pause_run")),
    (error: unknown) =>
      error instanceof PacketPhoneCallbackError && error.code === "stale_callback",
  );
  assert.equal(staleHarness.data.workerControlCommands[0]?.status, "rejected");
  assert.equal(staleHarness.data.workerControlCommands[0]?.rejectionCode, "revision_conflict");

  const resolvedHarness = packetPhoneHarness();
  const resolvedMessage = await resolvedHarness.deliver();
  await resolvedHarness.callback().consume(tokenFor(resolvedMessage, "reject_attention"));
  await assert.rejects(
    () => resolvedHarness.callback().consume(tokenFor(resolvedMessage, "approve_once")),
    (error: unknown) =>
      error instanceof PacketPhoneCallbackError && error.code === "action_resolved",
  );
  assert.equal(resolvedHarness.data.workerControlCommands.length, 2);

  const crossed = createPacketPhoneCallbackService({
    loadStore: () => createSeedStore(),
    credentialService: configCredentialService(routeConfig()),
    now: () => CALLBACK_NOW,
  });
  await assert.rejects(
    () => crossed.consume(valid),
    (error: unknown) =>
      error instanceof PacketPhoneCallbackError && error.code === "binding_mismatch",
  );
});

test("PacketPhone callback secret rotation revokes previously issued controls", async () => {
  const harness = packetPhoneHarness();
  const message = await harness.deliver();
  const token = tokenFor(message, "stop_run");
  const rotated = createPacketPhoneCallbackService({
    loadStore: () => harness.data,
    credentialService: configCredentialService(
      routeConfig({
        callbackSecret: "rotated-packetphone-callback-secret-at-least-32-bytes",
      }),
    ),
    control: createControl(harness.data),
    now: () => CALLBACK_NOW,
  });

  await assert.rejects(
    () => rotated.consume(token),
    (error: unknown) => error instanceof PacketPhoneCallbackError && error.code === "invalid_token",
  );
  assert.equal(harness.data.workerControlCommands.length, 0);
});

test("local and PacketPhone controls preserve W7 revision and audit semantics in both race orderings", async () => {
  const localFirst = packetPhoneHarness();
  const localFirstMessage = await localFirst.deliver();
  const localWinner = await localFirst.control.stopRun({
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    actor: { type: "user", id: "local-operator-1" },
    idempotencyKey: "local-stop-wins",
    expectedRevision: 1,
  });
  assert.equal(localWinner.disposition, "applied");
  await assert.rejects(
    () => localFirst.callback().consume(tokenFor(localFirstMessage, "pause_run")),
    (error: unknown) =>
      error instanceof PacketPhoneCallbackError && error.code === "stale_callback",
  );
  assert.deepEqual(
    localFirst.data.workerControlCommands.map((command) => ({
      status: command.status,
      remote: command.remoteControl?.source ?? "local",
    })),
    [
      { status: "applied", remote: "local" },
      { status: "rejected", remote: "packetphone" },
    ],
  );
  assert.equal(localFirst.data.workerRuns[0]?.status, "cancelled");

  const remoteFirst = packetPhoneHarness();
  const remoteFirstMessage = await remoteFirst.deliver();
  const remoteWinner = await remoteFirst
    .callback()
    .consume(tokenFor(remoteFirstMessage, "pause_run"));
  assert.equal(remoteWinner.disposition, "applied");
  const losingLocal = await remoteFirst.control.stopRun({
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    actor: { type: "user", id: "local-operator-2" },
    idempotencyKey: "remote-pause-wins",
    expectedRevision: 1,
  });
  assert.equal(losingLocal.disposition, "rejected");
  assert.equal(losingLocal.command.rejectionCode, "revision_conflict");
  assert.deepEqual(
    remoteFirst.data.workerControlCommands.map((command) => ({
      status: command.status,
      remote: command.remoteControl?.source ?? "local",
    })),
    [
      { status: "applied", remote: "packetphone" },
      { status: "rejected", remote: "local" },
    ],
  );
  assert.equal(remoteFirst.data.workerRuns[0]?.status, "paused");
});

test("PacketPhone callback route is POST-only, no-store, strict, and externally generic", async () => {
  const routes = createPacketProductCallbackRoutes({
    packetPhone: {
      async consume(token) {
        assert.equal(token, "signed-phone-token");
        return {
          action: "stop_run",
          disposition: "applied",
          command: { id: "command-1", kind: "stop_run", status: "applied" },
        };
      },
    },
  });
  const response = await routes.request("/packetphone/worker-control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "signed-phone-token" }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.equal(((await response.json()) as { disposition: string }).disposition, "applied");

  const get = await routes.request("/packetphone/worker-control");
  assert.equal(get.status, 404);

  const unexpected = await routes.request("/packetphone/worker-control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "signed-phone-token", action: "stop_run" }),
  });
  assert.equal(unexpected.status, 401);
  assert.deepEqual(await unexpected.json(), {
    error: "PacketPhone Worker control callback was rejected.",
    code: "invalid_callback",
  });

  const replayRoutes = createPacketProductCallbackRoutes({
    packetPhone: {
      async consume() {
        throw new PacketPhoneCallbackError("replayed_callback");
      },
    },
  });
  const replay = await replayRoutes.request("/packetphone/worker-control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "replayed" }),
  });
  assert.equal(replay.status, 409);
  assert.deepEqual(await replay.json(), {
    error: "PacketPhone Worker control callback was rejected.",
    code: "rejected_callback",
  });
});

test("PacketPhone delivery classifies provider and network failures for bounded retries", async () => {
  const harness = packetPhoneHarness();
  const request = harness.notification();
  const deliverWith = (network: WorkerNetworkPort) =>
    createPacketPhoneNotificationTransport({
      loadStore: () => harness.data,
      credentialService: configCredentialService(routeConfig()),
      network,
    }).deliver({
      route: harness.route,
      envelope: request.envelope,
      idempotencyKey: request.idempotencyKey,
      signal: new AbortController().signal,
    });

  await assert.rejects(
    () =>
      deliverWith({
        async request() {
          return { status: 429, headers: {}, body: "", connectedAddress: "8.8.8.8" };
        },
      }),
    (error: unknown) =>
      error instanceof WorkerNotificationDeliveryError &&
      error.code === "packetphone_http_429" &&
      error.retryable,
  );
  await assert.rejects(
    () =>
      deliverWith({
        async request() {
          return { status: 400, headers: {}, body: "", connectedAddress: "8.8.8.8" };
        },
      }),
    (error: unknown) =>
      error instanceof WorkerNotificationDeliveryError &&
      error.code === "packetphone_http_400" &&
      !error.retryable,
  );
  await assert.rejects(
    () =>
      deliverWith({
        async request() {
          throw new WorkerNetworkError("request_failed", "must not escape");
        },
      }),
    (error: unknown) =>
      error instanceof WorkerNotificationDeliveryError &&
      error.code === "packetphone_network_request_failed" &&
      error.retryable,
  );
});

test("PacketPhone route configuration rejects weak callbacks, non-origin bases, and duplicate actions", () => {
  assert.throws(
    () => parsePacketPhoneRouteConfig(routeConfig({ callbackSecret: "too-short" })),
    /configuration is invalid/,
  );
  assert.throws(
    () =>
      parsePacketPhoneRouteConfig(
        routeConfig({
          callbackBaseUrl: "https://agent.example.test/untrusted/path?token=value",
        }),
      ),
    /configuration is invalid/,
  );
  assert.throws(
    () => parsePacketPhoneRouteConfig(routeConfig({ allowedActions: ["stop_run", "stop_run"] })),
    /configuration is invalid/,
  );
  assert.throws(
    () =>
      parsePacketPhoneRouteConfig(
        JSON.stringify({
          ...JSON.parse(routeConfig()),
          endpoint: "http://phone.example.test/api/worker-controls",
        }),
      ),
    /configuration is invalid/,
  );
});

const LIVE_PACKETPHONE_INTEROP_ENV_KEYS = [
  "PACKETAGENT_PACKETPHONE_INTEROP_ENDPOINT",
  "PACKETAGENT_PACKETPHONE_INTEROP_CALLBACK_BASE_URL",
  "PACKETAGENT_PACKETPHONE_INTEROP_CALLBACK_SECRET",
  "PACKETAGENT_PACKETPHONE_INTEROP_ACTOR_ID",
] as const;
const LIVE_PACKETPHONE_INTEROP_REQUESTED = LIVE_PACKETPHONE_INTEROP_ENV_KEYS.some(
  (key) => process.env[key],
);

test(
  "live PacketPhone endpoint accepts role-bounded Worker controls",
  {
    skip: LIVE_PACKETPHONE_INTEROP_REQUESTED
      ? false
      : `set ${LIVE_PACKETPHONE_INTEROP_ENV_KEYS.join(", ")} to run live interoperability`,
  },
  async () => {
    const harness = packetPhoneHarness();
    const request = harness.notification();
    const bearerToken = process.env.PACKETAGENT_PACKETPHONE_INTEROP_BEARER_TOKEN?.trim();
    const transport = createPacketPhoneNotificationTransport({
      loadStore: () => harness.data,
      credentialService: configCredentialService(
        JSON.stringify({
          schemaVersion: PACKETPHONE_ROUTE_SCHEMA_VERSION,
          endpoint: requiredInteropEnv("PACKETAGENT_PACKETPHONE_INTEROP_ENDPOINT"),
          ...(bearerToken ? { bearerToken } : {}),
          callbackBaseUrl: requiredInteropEnv("PACKETAGENT_PACKETPHONE_INTEROP_CALLBACK_BASE_URL"),
          callbackSecret: requiredInteropEnv("PACKETAGENT_PACKETPHONE_INTEROP_CALLBACK_SECRET"),
          actorId: requiredInteropEnv("PACKETAGENT_PACKETPHONE_INTEROP_ACTOR_ID"),
          actorRole: "admin",
          allowedActions: ALL_ACTIONS,
          timeoutMs: 15_000,
          callbackTtlSeconds: 5 * 60,
        }),
      ),
    });

    const result = await transport.deliver({
      route: harness.route,
      envelope: request.envelope,
      idempotencyKey: request.idempotencyKey,
      signal: AbortSignal.timeout(20_000),
    });

    assert.equal(result.metadata?.provider, "packetphone");
    assert.ok(result.deliveryReference);
  },
);

interface PacketPhoneHarnessOptions {
  readonly actorRole?: "viewer" | "member" | "admin" | "owner";
  readonly allowedActions?: readonly PacketPhoneControlAction[];
}

function packetPhoneHarness(options: PacketPhoneHarnessOptions = {}) {
  const data = createSeedStore();
  const base = makeWorkerVersionContent();
  const content = makeWorkerVersionContent({
    tools: base.tools.map((capability) => ({ ...capability, approval: "always" as const })),
    credentialRefs: ["vault:release-api", ROUTE_REFERENCE],
    notificationRoutes: [
      {
        id: "operations-phone",
        kind: "packetphone",
        reference: ROUTE_REFERENCE,
        events: ["attention", "progress", "terminal"],
      },
    ],
  });
  const version = makeWorkerVersion({ status: "validated", content });
  const compilation = compileWorkerCapabilityPolicy({
    workerVersionContentDigest: version.contentDigest,
    requestedCapabilities: version.content.tools,
    allowedCapabilityIds: version.content.policy.permissions.allowedCapabilityIds,
    credentialRefs: version.content.credentialRefs,
  });
  data.workerDefinitions.push(
    makeWorkerDefinition({
      status: "active",
      currentVersionId: version.id,
      updatedAt: NOW.toISOString(),
    }),
  );
  data.workerVersions.push(version);
  data.workerDeployments.push(
    makeWorkerDeployment({
      status: "active",
      capabilityGrants: compilation.grants,
      compiledPolicy: compilation.policy,
      updatedAt: NOW.toISOString(),
      activatedAt: NOW.toISOString(),
    }),
  );
  data.workerRuns.push(
    makeWorkerRun({
      status: "waiting_for_approval",
      startedAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    }),
  );
  data.workerAttentionRequests.push(
    makeWorkerAttentionRequest({
      workerVersionContentDigest: version.contentDigest,
      policyDigest: compilation.policy.policyDigest,
      requestedAt: NOW.toISOString(),
      escalatesAt: "2026-07-28T15:05:00.000Z",
      expiresAt: ATTENTION_EXPIRES_AT,
      notificationRouteIds: ["operations-phone"],
    }),
  );
  const route = content.notificationRoutes[0]!;
  let request: ReturnType<typeof appendPhoneNotification> | undefined;
  let captured: PacketPhoneWorkerControlMessage | undefined;
  const control = createControl(data);
  const configured = routeConfig({
    actorRole: options.actorRole ?? "admin",
    allowedActions: options.allowedActions ?? ALL_ACTIONS,
  });
  return {
    data,
    control,
    route,
    versionDigest: version.contentDigest,
    notification() {
      request ??= appendPhoneNotification(data);
      return request;
    },
    async deliver() {
      const notification = this.notification();
      const transport = createPacketPhoneNotificationTransport({
        loadStore: () => data,
        credentialService: configCredentialService(configured),
        network: captureMessage((message) => {
          captured = message;
        }),
      });
      await transport.deliver({
        route,
        envelope: notification.envelope,
        idempotencyKey: notification.idempotencyKey,
        signal: new AbortController().signal,
      });
      assert.ok(captured);
      return captured;
    },
    callback(currentTime = CALLBACK_NOW) {
      return createPacketPhoneCallbackService({
        loadStore: () => data,
        credentialService: configCredentialService(configured),
        control,
        now: () => currentTime,
      });
    },
  };
}

function appendPhoneNotification(data: PacketAgentData) {
  const appended = appendWorkerEventWithNotifications(data, {
    journal: {
      id: "event-attention-phone",
      workspaceId: "workspace-1",
      type: "worker.attention.requested",
      source: "approval",
      workerDefinitionId: "worker-1",
      workerVersionId: "worker-version-1",
      workerDeploymentId: "deployment-1",
      workerRunId: "run-1",
      actor: { type: "system", id: "packetagent.worker-attention" },
      summary: "A release operation requires bounded approval.",
      data: {
        workerRunId: "run-1",
        attentionRequestId: "attention-1",
      },
      occurredAt: NOW.toISOString(),
    },
    notification: {
      event: "attention",
      title: "Worker approval required",
      attentionRequestId: "attention-1",
      routeIds: ["operations-phone"],
      expiresAt: ATTENTION_EXPIRES_AT,
      data: {
        requiredAction: "approve_or_reject",
        attentionRequestId: "attention-1",
        expiresAt: ATTENTION_EXPIRES_AT,
      },
    },
    id: (kind) => `${kind}-packetphone`,
  });
  const outbox = appended.outboxItems[0]!;
  return {
    envelope: outbox.envelope,
    idempotencyKey: outbox.idempotencyKey,
  };
}

function createControl(data: PacketAgentData) {
  let nextId = 0;
  return createWorkerControlService({
    mutateStore: async (mutator) => mutator(data),
    now: () => CALLBACK_NOW,
    id: (kind) => `${kind}-packetphone-${++nextId}`,
    nonce: () => "approval-secret-that-must-not-persist",
  });
}

function createCallbackForStore(data: PacketAgentData) {
  return createPacketPhoneCallbackService({
    loadStore: () => data,
    credentialService: configCredentialService(routeConfig()),
    control: createControl(data),
    now: () => CALLBACK_NOW,
  });
}

function routeConfig(
  overrides: {
    readonly callbackSecret?: string;
    readonly callbackBaseUrl?: string;
    readonly actorRole?: "viewer" | "member" | "admin" | "owner";
    readonly allowedActions?: readonly PacketPhoneControlAction[];
  } = {},
): string {
  return JSON.stringify({
    schemaVersion: PACKETPHONE_ROUTE_SCHEMA_VERSION,
    endpoint: ROUTE_ENDPOINT,
    bearerToken: BEARER_TOKEN,
    callbackBaseUrl: overrides.callbackBaseUrl ?? "https://agent.example.test",
    callbackSecret: overrides.callbackSecret ?? CALLBACK_SECRET,
    actorId: "phone-operator-1",
    actorRole: overrides.actorRole ?? "admin",
    allowedActions: overrides.allowedActions ?? ALL_ACTIONS,
    timeoutMs: 5_000,
    callbackTtlSeconds: 5 * 60,
  });
}

function testCredentialVault(data: PacketAgentData): WorkerCredentialService {
  let nextId = 0;
  return createWorkerCredentialService({
    mutateStore: async (mutator) => mutator(data),
    masterKey: () => Buffer.alloc(32, 9),
    generateId: () => `credential-${++nextId}`,
    now: () => NOW.toISOString(),
  });
}

function configCredentialService(rawConfig: string): WorkerCredentialService {
  const metadata: WorkerCredentialMetadata = {
    schemaVersion: WORKER_CREDENTIAL_SCHEMA_VERSION,
    id: "credential-packetphone",
    workspaceId: "workspace-1",
    reference: ROUTE_REFERENCE,
    kind: "opaque",
    label: "PacketPhone operations route",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    encrypted: true,
  };
  return {
    async list() {
      return [metadata];
    },
    async upsert() {
      throw new Error("not implemented by test credential service");
    },
    async remove() {
      return false;
    },
    async use<TResult>(
      input: UseWorkerCredentialInput,
      consumer: (value: string, metadata: WorkerCredentialMetadata) => Promise<TResult> | TResult,
    ): Promise<TResult> {
      assert.equal(input.reference, ROUTE_REFERENCE);
      assert.ok(input.declaredCredentialRefs.includes(ROUTE_REFERENCE));
      assert.deepEqual(input.expectedKinds, ["opaque"]);
      return consumer(rawConfig, { ...metadata, workspaceId: input.workspaceId });
    },
  };
}

function captureMessage(
  set: (message: PacketPhoneWorkerControlMessage) => void,
): WorkerNetworkPort {
  return {
    async request(input) {
      assert.equal(input.headers?.authorization, `Bearer ${BEARER_TOKEN}`);
      assert.ok(input.headers?.["idempotency-key"]);
      set(JSON.parse(input.body ?? "{}") as PacketPhoneWorkerControlMessage);
      return {
        status: 202,
        headers: { "x-request-id": "packetphone-request-42" },
        body: "{}",
        connectedAddress: "8.8.8.8",
      };
    },
  };
}

function captureMessages(messages: PacketPhoneWorkerControlMessage[]): WorkerNetworkPort {
  return captureMessage((message) => {
    messages.push(message);
  });
}

function tokenFor(
  message: PacketPhoneWorkerControlMessage,
  action: PacketPhoneControlAction,
): string {
  const control = message.actions.find((candidate) => candidate.action === action);
  assert.ok(control, `missing ${action} callback`);
  return control.callback.body.token;
}

function requiredInteropEnv(key: (typeof LIVE_PACKETPHONE_INTEROP_ENV_KEYS)[number]): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required live PacketPhone interoperability setting ${key}.`);
  }
  return value;
}
