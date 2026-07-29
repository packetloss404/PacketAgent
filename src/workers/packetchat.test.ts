import assert from "node:assert/strict";
import test from "node:test";
import { createPacketProductCallbackRoutes } from "../packet-product-callback-routes.js";
import { createSeedStore, type PacketAgentData } from "../packetagent-store.js";
import {
  makeWorkerCheckpoint,
  makeWorkerDefinition,
  makeWorkerDeployment,
  makeWorkerRun,
  makeWorkerVersion,
  makeWorkerVersionContent,
} from "./__tests__/fixtures.js";
import {
  WORKER_CREDENTIAL_SCHEMA_VERSION,
  type WorkerCredentialMetadata,
} from "./credential-types.js";
import type { UseWorkerCredentialInput, WorkerCredentialService } from "./credentials.js";
import { createWorkerCredentialService } from "./credentials.js";
import { WorkerNetworkError, type WorkerNetworkPort } from "./network.js";
import {
  appendWorkerEventWithNotifications,
  WorkerNotificationDeliveryError,
} from "./notifications.js";
import {
  PACKETCHAT_MESSAGE_SCHEMA_VERSION,
  PACKETCHAT_ROUTE_SCHEMA_VERSION,
  PacketChatCallbackError,
  createPacketChatCallbackService,
  createPacketChatNotificationTransport,
  parsePacketChatRouteConfig,
  type PacketChatWorkerMessage,
} from "./packetchat.js";

const NOW = new Date("2026-07-28T14:00:00.000Z");
const ROUTE_REFERENCE = "vault:packetchat-operations";
const ROUTE_ENDPOINT = "https://chat.example.test/api/worker-messages";
const BEARER_TOKEN = "packetchat-bearer-that-must-not-persist";
const CALLBACK_SECRET = "packetchat-callback-secret-at-least-32-bytes";

test("PacketChat delivery sends one bounded replaceable progress card without persisting secrets", async () => {
  const harness = packetChatHarness();
  const request = harness.notification();
  const credentialService = testCredentialVault(harness.data);
  await credentialService.upsert({
    workspaceId: "workspace-1",
    reference: ROUTE_REFERENCE,
    kind: "opaque",
    label: "PacketChat operations route",
    value: routeConfig(),
  });
  let captured:
    | {
        readonly headers: Readonly<Record<string, string>>;
        readonly body: PacketChatWorkerMessage;
      }
    | undefined;
  const network: WorkerNetworkPort = {
    async request(input) {
      captured = {
        headers: input.headers ?? {},
        body: JSON.parse(input.body ?? "{}") as PacketChatWorkerMessage,
      };
      return {
        status: 202,
        headers: { "x-request-id": "packetchat-request-42" },
        body: "{}",
        connectedAddress: "8.8.8.8",
      };
    },
  };
  const transport = createPacketChatNotificationTransport({
    loadStore: () => harness.data,
    credentialService,
    network,
    now: () => NOW,
  });

  const delivered = await transport.deliver({
    route: harness.route,
    envelope: request.envelope,
    idempotencyKey: request.idempotencyKey,
    signal: new AbortController().signal,
  });

  assert.equal(delivered.deliveryReference, "packetchat-request-42");
  assert.deepEqual(delivered.metadata, {
    provider: "packetchat",
    responseCode: 202,
  });
  assert.ok(captured);
  assert.equal(captured.headers.authorization, `Bearer ${BEARER_TOKEN}`);
  assert.equal(captured.headers["idempotency-key"], request.idempotencyKey);
  assert.equal(captured.body.schemaVersion, PACKETCHAT_MESSAGE_SCHEMA_VERSION);
  assert.deepEqual(captured.body.thread, {
    key: "worker-run:run-1",
    messageKey: "worker-run:run-1:progress",
    behavior: "replace",
  });
  assert.deepEqual(captured.body.worker, {
    workspaceId: "workspace-1",
    definitionId: "worker-1",
    deploymentId: "deployment-1",
    runId: "run-1",
    versionId: "worker-version-1",
    versionContentDigest: harness.versionDigest,
  });
  assert.equal(captured.body.state.deployment, "active");
  assert.equal(captured.body.state.run, "running");
  assert.equal(captured.body.state.version, "validated");
  assert.equal(captured.body.state.versionNumber, 1);
  assert.equal(captured.body.checkpoint?.id, "checkpoint-1");
  assert.equal(captured.body.evidence.id, request.envelope.evidenceId);
  assert.equal(captured.body.requiredAction, "none");
  assert.ok(captured.body.title.length <= 160);
  assert.ok(captured.body.summary.length <= 1_000);
  assert.match(captured.body.callbacks.open, /worker-callback\?token=/);
  assert.match(captured.body.callbacks.inspect, /worker-callback\?token=/);

  const durable = JSON.stringify(harness.data);
  assert.equal(durable.includes(ROUTE_ENDPOINT), false);
  assert.equal(durable.includes(BEARER_TOKEN), false);
  assert.equal(durable.includes(CALLBACK_SECRET), false);
  assert.equal(durable.includes(extractToken(captured.body.callbacks.open)), false);
  assert.deepEqual(request.jobPayload, { outboxItemId: request.outboxId });
  assert.equal(JSON.stringify(request.jobPayload).includes(ROUTE_REFERENCE), false);
});

test("PacketChat callbacks authenticate the exact Worker binding and return open or redacted inspect views", async () => {
  const harness = packetChatHarness();
  const request = harness.notification();
  let message: PacketChatWorkerMessage | undefined;
  const transport = createPacketChatNotificationTransport({
    loadStore: () => harness.data,
    credentialService: configCredentialService(routeConfig()),
    network: captureMessage((value) => {
      message = value;
    }),
    now: () => NOW,
  });
  await transport.deliver({
    route: harness.route,
    envelope: request.envelope,
    idempotencyKey: request.idempotencyKey,
    signal: new AbortController().signal,
  });
  assert.ok(message);

  const callback = createPacketChatCallbackService({
    loadStore: () => harness.data,
    credentialService: configCredentialService(routeConfig()),
    now: () => new Date(NOW.getTime() + 30_000),
  });
  const opened = await callback.authenticate(extractToken(message.callbacks.open));
  assert.deepEqual(opened, {
    action: "open",
    openUrl: "https://agent.example.test/runs/worker/run-1",
  });
  assert.deepEqual(
    await callback.authenticate(extractToken(message.callbacks.open)),
    opened,
    "read-only callbacks may replay without creating durable effects",
  );
  const inspected = await callback.authenticate(extractToken(message.callbacks.inspect));
  assert.equal(inspected.action, "inspect");
  assert.equal(inspected.detail?.run.id, "run-1");
  assert.equal(inspected.detail?.run.version.contentDigest, harness.versionDigest);

  const validInspectToken = extractToken(message.callbacks.inspect);
  const tampered = `${validInspectToken.slice(0, -1)}${
    validInspectToken.endsWith("a") ? "b" : "a"
  }`;
  await assert.rejects(
    () => callback.authenticate(tampered),
    (error: unknown) => error instanceof PacketChatCallbackError && error.code === "invalid_token",
  );

  const expired = createPacketChatCallbackService({
    loadStore: () => harness.data,
    credentialService: configCredentialService(routeConfig()),
    now: () => new Date(NOW.getTime() + 61_000),
  });
  await assert.rejects(
    () => expired.authenticate(extractToken(message!.callbacks.open)),
    (error: unknown) => error instanceof PacketChatCallbackError && error.code === "expired_token",
  );

  const otherWorkspace = packetChatHarness("workspace-2");
  const crossed = createPacketChatCallbackService({
    loadStore: () => otherWorkspace.data,
    credentialService: configCredentialService(routeConfig()),
    now: () => new Date(NOW.getTime() + 30_000),
  });
  await assert.rejects(
    () => crossed.authenticate(extractToken(message!.callbacks.open)),
    (error: unknown) =>
      error instanceof PacketChatCallbackError && error.code === "binding_mismatch",
  );

  const rotated = createPacketChatCallbackService({
    loadStore: () => harness.data,
    credentialService: configCredentialService(
      routeConfig({
        callbackSecret: "rotated-packetchat-callback-secret-at-least-32-bytes",
      }),
    ),
    now: () => new Date(NOW.getTime() + 30_000),
  });
  await assert.rejects(
    () => rotated.authenticate(extractToken(message!.callbacks.open)),
    (error: unknown) => error instanceof PacketChatCallbackError && error.code === "invalid_token",
  );
});

test("PacketChat delivery classifies provider and network failures for bounded retries", async () => {
  const harness = packetChatHarness();
  const request = harness.notification();
  const deliverWith = (network: WorkerNetworkPort) =>
    createPacketChatNotificationTransport({
      loadStore: () => harness.data,
      credentialService: configCredentialService(routeConfig()),
      network,
      now: () => NOW,
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
          return {
            status: 429,
            headers: {},
            body: "",
            connectedAddress: "8.8.8.8",
          };
        },
      }),
    (error: unknown) =>
      error instanceof WorkerNotificationDeliveryError &&
      error.code === "packetchat_http_429" &&
      error.retryable,
  );
  await assert.rejects(
    () =>
      deliverWith({
        async request() {
          return {
            status: 400,
            headers: {},
            body: "",
            connectedAddress: "8.8.8.8",
          };
        },
      }),
    (error: unknown) =>
      error instanceof WorkerNotificationDeliveryError &&
      error.code === "packetchat_http_400" &&
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
      error.code === "packetchat_network_request_failed" &&
      error.retryable,
  );
});

test("PacketChat callback route is no-store and fails closed on missing tokens", async () => {
  const routes = createPacketProductCallbackRoutes({
    packetChat: {
      async authenticate(token) {
        assert.equal(token, "signed-token");
        return { action: "open", openUrl: "https://agent.example.test/runs/worker/run-1" };
      },
    },
  });
  const response = await routes.request("/packetchat/worker-callback?token=signed-token");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    action: "open",
    openUrl: "https://agent.example.test/runs/worker/run-1",
  });

  const missing = await routes.request("/packetchat/worker-callback");
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get("cache-control"), "no-store");
  assert.deepEqual(await missing.json(), {
    error: "PacketChat Worker callback authentication failed.",
    code: "invalid_callback",
  });
});

test("PacketChat route configuration rejects weak callback and non-origin base values", () => {
  assert.throws(
    () =>
      parsePacketChatRouteConfig(
        JSON.stringify({
          ...JSON.parse(routeConfig()),
          callbackSecret: "too-short",
        }),
      ),
    /configuration is invalid/,
  );
  assert.throws(
    () =>
      parsePacketChatRouteConfig(
        JSON.stringify({
          ...JSON.parse(routeConfig()),
          callbackBaseUrl: "https://agent.example.test/untrusted/path?token=value",
        }),
      ),
    /configuration is invalid/,
  );
});

const LIVE_PACKETCHAT_INTEROP_ENV_KEYS = [
  "PACKETAGENT_PACKETCHAT_INTEROP_ENDPOINT",
  "PACKETAGENT_PACKETCHAT_INTEROP_CALLBACK_BASE_URL",
  "PACKETAGENT_PACKETCHAT_INTEROP_CALLBACK_SECRET",
] as const;
const LIVE_PACKETCHAT_INTEROP_REQUESTED = LIVE_PACKETCHAT_INTEROP_ENV_KEYS.some(
  (key) => process.env[key],
);

test(
  "live PacketChat endpoint accepts a bounded Worker card",
  {
    skip: LIVE_PACKETCHAT_INTEROP_REQUESTED
      ? false
      : `set ${LIVE_PACKETCHAT_INTEROP_ENV_KEYS.join(", ")} to run live interoperability`,
  },
  async () => {
    const harness = packetChatHarness();
    const request = harness.notification();
    const bearerToken = process.env.PACKETAGENT_PACKETCHAT_INTEROP_BEARER_TOKEN?.trim();
    const transport = createPacketChatNotificationTransport({
      loadStore: () => harness.data,
      credentialService: configCredentialService(
        JSON.stringify({
          schemaVersion: PACKETCHAT_ROUTE_SCHEMA_VERSION,
          endpoint: requiredInteropEnv("PACKETAGENT_PACKETCHAT_INTEROP_ENDPOINT"),
          ...(bearerToken ? { bearerToken } : {}),
          callbackBaseUrl: requiredInteropEnv("PACKETAGENT_PACKETCHAT_INTEROP_CALLBACK_BASE_URL"),
          callbackSecret: requiredInteropEnv("PACKETAGENT_PACKETCHAT_INTEROP_CALLBACK_SECRET"),
          timeoutMs: 15_000,
          callbackTtlSeconds: 60,
        }),
      ),
      now: () => new Date(),
    });

    const result = await transport.deliver({
      route: harness.route,
      envelope: request.envelope,
      idempotencyKey: request.idempotencyKey,
      signal: AbortSignal.timeout(20_000),
    });

    assert.equal(result.metadata?.provider, "packetchat");
    assert.ok(result.deliveryReference);
  },
);

function packetChatHarness(workspaceId = "workspace-1") {
  const data = createSeedStore();
  const content = makeWorkerVersionContent({
    credentialRefs: ["vault:release-api", ROUTE_REFERENCE],
    notificationRoutes: [
      {
        id: "operations-chat",
        kind: "packetchat",
        reference: ROUTE_REFERENCE,
        events: ["attention", "progress", "terminal"],
      },
    ],
  });
  const version = makeWorkerVersion({
    workspaceId,
    status: "validated",
    content,
  });
  data.workerDefinitions.push(
    makeWorkerDefinition({
      workspaceId,
      status: "active",
      currentVersionId: version.id,
    }),
  );
  data.workerVersions.push(version);
  data.workerDeployments.push(
    makeWorkerDeployment({
      workspaceId,
      status: "active",
    }),
  );
  data.workerRuns.push(
    makeWorkerRun({
      workspaceId,
      status: "running",
      latestCheckpointId: "checkpoint-1",
      budgetUsage: {
        elapsedMs: 12_000,
        iterations: 2,
        providerCostUsd: 0.25,
        consecutiveFailures: 0,
        toolCalls: 3,
      },
    }),
  );
  data.workerCheckpoints.push(
    makeWorkerCheckpoint({
      workspaceId,
      cursor: { phase: "checkpoint", iteration: 2, actionIndex: 1 },
    }),
  );
  const route = content.notificationRoutes[0]!;
  let notification:
    | {
        readonly route: typeof route;
        readonly envelope: ReturnType<
          typeof appendWorkerEventWithNotifications
        >["outboxItems"][number]["envelope"];
        readonly idempotencyKey: string;
        readonly outboxId: string;
        readonly jobPayload: Record<string, unknown>;
      }
    | undefined;
  return {
    data,
    route,
    versionDigest: version.contentDigest,
    notification() {
      if (notification) return notification;
      const appended = appendWorkerEventWithNotifications(data, {
        journal: {
          id: `event-progress-${workspaceId}`,
          workspaceId,
          type: "worker.checkpoint.persisted",
          source: "checkpoint",
          workerDefinitionId: "worker-1",
          workerVersionId: "worker-version-1",
          workerDeploymentId: "deployment-1",
          workerRunId: "run-1",
          actor: { type: "system", id: "packetagent.worker-supervisor" },
          summary: "Checkpoint 2 persisted; release verification remains within budget.",
          data: { checkpointId: "checkpoint-1" },
          occurredAt: NOW.toISOString(),
        },
        notification: {
          event: "progress",
          title: "Release verification progress",
          data: { requiredAction: "none" },
        },
        id: (kind) => `${kind}-packetchat-${workspaceId}`,
      });
      const outbox = appended.outboxItems[0]!;
      notification = {
        route,
        envelope: outbox.envelope,
        idempotencyKey: outbox.idempotencyKey,
        outboxId: outbox.id,
        jobPayload: appended.jobs[0]!.payload,
      };
      return notification;
    },
  };
}

function routeConfig(
  overrides: {
    readonly callbackSecret?: string;
  } = {},
): string {
  return JSON.stringify({
    schemaVersion: PACKETCHAT_ROUTE_SCHEMA_VERSION,
    endpoint: ROUTE_ENDPOINT,
    bearerToken: BEARER_TOKEN,
    callbackBaseUrl: "https://agent.example.test",
    callbackSecret: overrides.callbackSecret ?? CALLBACK_SECRET,
    timeoutMs: 5_000,
    callbackTtlSeconds: 60,
  });
}

function testCredentialVault(data: PacketAgentData): WorkerCredentialService {
  let nextId = 0;
  return createWorkerCredentialService({
    mutateStore: async (mutator) => mutator(data),
    masterKey: () => Buffer.alloc(32, 7),
    generateId: () => `credential-${++nextId}`,
    now: () => NOW.toISOString(),
  });
}

function configCredentialService(rawConfig: string): WorkerCredentialService {
  const metadata: WorkerCredentialMetadata = {
    schemaVersion: WORKER_CREDENTIAL_SCHEMA_VERSION,
    id: "credential-packetchat",
    workspaceId: "workspace-1",
    reference: ROUTE_REFERENCE,
    kind: "opaque",
    label: "PacketChat operations route",
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

function captureMessage(set: (message: PacketChatWorkerMessage) => void): WorkerNetworkPort {
  return {
    async request(input) {
      set(JSON.parse(input.body ?? "{}") as PacketChatWorkerMessage);
      return {
        status: 202,
        headers: {},
        body: "{}",
        connectedAddress: "8.8.8.8",
      };
    },
  };
}

function requiredInteropEnv(key: (typeof LIVE_PACKETCHAT_INTEROP_ENV_KEYS)[number]): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required live PacketChat interoperability setting ${key}.`);
  }
  return value;
}

function extractToken(callbackUrl: string): string {
  const token = new URL(callbackUrl).searchParams.get("token");
  assert.ok(token);
  return token;
}
