import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Hono } from "hono";
import { createSeedStore, normalizeStore, type PacketAgentData } from "./packetagent-store.js";
import { createWorkerPackageEventRoutes } from "./worker-package-event-routes.js";
import { createWorkerPackageRoutes } from "./worker-package-routes.js";
import { createWorkerActivationRepository } from "./workers/activation-repository.js";
import { createWorkerActivationService } from "./workers/activation.js";
import { createWorkerControlService } from "./workers/control-service.js";
import { createWorkerOperationsReadModel } from "./workers/observability/read-model.js";
import { createPacketProductDeploymentService } from "./workers/package/deployment.js";
import {
  createPacketProductEventService,
  type PacketProductEventPage,
} from "./workers/package/events.js";
import { createPacketProductTrustService } from "./workers/package/trust.js";
import type { WorkerPackage } from "./workers/package/types.js";
import { sealWorkerPackage } from "./workers/package/validation.js";
import { createWorkerRepository } from "./workers/repository.js";
import { createWorkerLifecycleService } from "./workers/service.js";

const PACKAGE_FIXTURE_URL = new URL(
  "./workers/package/fixtures/worker-package-v1.valid.json",
  import.meta.url,
);
const HANDOFF_FIXTURE_URL = new URL(
  "./workers/package/fixtures/packetade-handoff-v1.valid.json",
  import.meta.url,
);
const TEST_SECRET = "h".repeat(43);

interface PacketAdeHandoffScenario {
  readonly schemaVersion: "packetagent.packetade-handoff-scenario/v1";
  readonly workspaceId: string;
  readonly subjectId: string;
  readonly acceptedCapabilityIds: readonly string[];
  readonly capabilityGrants: readonly {
    readonly capabilityId: string;
    readonly verbs: readonly string[];
    readonly resources: readonly string[];
    readonly approval: "never" | "always";
  }[];
  readonly activation: {
    readonly idempotencyKey: string;
    readonly input: { readonly release_id: string };
  };
  readonly update: {
    readonly packageVersion: number;
    readonly idempotencyKey: string;
    readonly instructions: string;
    readonly statusReason: string;
  };
  readonly controls: {
    readonly pauseIdempotencyKey: string;
    readonly resumeIdempotencyKey: string;
    readonly rollbackIdempotencyKey: string;
    readonly revokeIdempotencyKey: string;
  };
  readonly expectedEventTypes: readonly string[];
}

interface DeploymentEnvelope {
  readonly dryRun?: boolean;
  readonly replayed?: boolean;
  readonly receipt: { readonly id: string };
  readonly binding?: {
    readonly workerDeploymentId: string;
    readonly operation: "deploy" | "update" | "rollback";
  };
  readonly definition?: { readonly id: string };
  readonly version?: { readonly id: string; readonly version: number };
  readonly deployment?: {
    readonly id: string;
    readonly status: string;
    readonly revision: number;
    readonly capabilityGrants: readonly unknown[];
  };
  readonly previousDeployment?: {
    readonly id: string;
    readonly status: string;
  };
  readonly activation?: {
    readonly disposition: string;
    readonly runId: string;
  };
}

test("serialized PacketADE handoff survives client disconnect and process reconstruction", async () => {
  const scenario = await readScenario();
  const packageV1 = await readPackage();
  assert.equal(packageV1.idempotencyKey, "packetade:flight-42:release-watcher:v1");
  assert.equal(JSON.stringify(scenario).includes("token"), false);
  assert.equal(JSON.stringify(scenario).includes("secret"), false);

  const clock = deterministicClock();
  let data = createSeedStore();
  let runtime = createPacketProductProcess(data, "before_restart", clock);
  const issued = await runtime.trust.issueCredential({
    workspaceId: scenario.workspaceId,
    subjectId: scenario.subjectId,
    allowedOperations: [
      "package.validate",
      "package.deploy",
      "package.update",
      "deployment.activate",
      "deployment.inspect",
      "deployment.list_runs",
      "deployment.pause",
      "deployment.resume",
      "deployment.rollback",
      "deployment.revoke",
      "run.list_events",
      "run.ack_events",
    ],
    createdBy: { type: "user", id: "user_alpha" },
  });

  const validatedResponse = await writeJson(
    runtime.app,
    "POST",
    "/api/worker-packages/validate",
    packageRequest(packageV1, scenario),
    packageV1.idempotencyKey,
    issued.token,
    scenario.workspaceId,
  );
  const validated = (await validatedResponse.json()) as DeploymentEnvelope;
  assert.equal(validatedResponse.status, 200);
  assert.equal(validated.dryRun, true);
  assert.equal(validated.deployment, undefined);

  const deployedResponse = await writeJson(
    runtime.app,
    "POST",
    "/api/worker-deployments",
    packageRequest(packageV1, scenario),
    packageV1.idempotencyKey,
    issued.token,
    scenario.workspaceId,
  );
  const deployed = (await deployedResponse.json()) as DeploymentEnvelope;
  assert.equal(deployedResponse.status, 201);
  assert.equal(deployed.binding?.operation, "deploy");
  assert.equal(deployed.binding?.workerDeploymentId, deployed.deployment?.id);
  assert.deepEqual(deployed.deployment?.capabilityGrants, scenario.capabilityGrants);
  assert.ok(deployed.deployment);

  const activatedResponse = await writeJson(
    runtime.app,
    "POST",
    `/api/worker-deployments/${deployed.deployment.id}/activate`,
    {
      expectedRevision: deployed.deployment.revision,
      input: scenario.activation.input,
    },
    scenario.activation.idempotencyKey,
    issued.token,
    scenario.workspaceId,
    {
      traceparent: `00-${"1".repeat(32)}-${"2".repeat(16)}-01`,
    },
  );
  const activated = (await activatedResponse.json()) as DeploymentEnvelope;
  assert.equal(activatedResponse.status, 202);
  assert.equal(activated.deployment?.status, "active");
  assert.equal(activated.activation?.disposition, "accepted");
  assert.ok(activated.activation?.runId);

  const firstPageResponse = await read(
    runtime.app,
    `/api/worker-deployments/${deployed.deployment.id}/events?from=beginning&limit=1`,
    issued.token,
    scenario.workspaceId,
  );
  const firstPage = (await firstPageResponse.json()) as PacketProductEventPage;
  assert.equal(firstPageResponse.status, 200);
  assert.equal(firstPage.events.length, 1);
  const acknowledgedEvent = firstPage.events[0]!;
  const acknowledgementResponse = await writeJson(
    runtime.app,
    "PUT",
    `/api/worker-deployments/${deployed.deployment.id}/events/cursor`,
    { cursor: acknowledgedEvent.id },
    "packetade:handoff:ack-before-disconnect",
    issued.token,
    scenario.workspaceId,
    { "if-match": firstPage.acknowledgement.etag },
  );
  assert.equal(acknowledgementResponse.status, 200);

  const disconnect = new AbortController();
  const streamResponse = await runtime.app.request(
    `/api/worker-deployments/${deployed.deployment.id}/events/stream`,
    {
      headers: {
        ...readHeaders(issued.token, scenario.workspaceId),
        "Last-Event-ID": acknowledgedEvent.id,
      },
      signal: disconnect.signal,
    },
  );
  assert.equal(streamResponse.status, 200);
  const reader = streamResponse.body!.getReader();
  const firstChunk = await reader.read();
  assert.equal(firstChunk.done, false);
  assert.ok((firstChunk.value?.byteLength ?? 0) > 0);
  disconnect.abort();
  await reader.cancel();
  assert.equal(data.packetProductEventAcknowledgements.length, 1);

  const serializedStore = JSON.stringify(data);
  assert.equal(serializedStore.includes(issued.token), false);
  assert.equal(serializedStore.includes(TEST_SECRET), false);
  data = normalizeStore(JSON.parse(serializedStore) as Partial<PacketAgentData>);
  runtime = createPacketProductProcess(data, "after_restart", clock);

  const inspectedResponse = await read(
    runtime.app,
    `/api/worker-deployments/${deployed.deployment.id}`,
    issued.token,
    scenario.workspaceId,
  );
  const inspected = (await inspectedResponse.json()) as DeploymentEnvelope;
  assert.equal(inspectedResponse.status, 200);
  assert.equal(inspected.deployment?.status, "active");
  assert.equal(inspected.version?.id, deployed.version?.id);
  assert.equal(inspected.receipt.id, validated.receipt.id);

  const runsResponse = await read(
    runtime.app,
    `/api/worker-deployments/${deployed.deployment.id}/runs`,
    issued.token,
    scenario.workspaceId,
  );
  const runs = (await runsResponse.json()) as {
    runs: Array<{ id: string; status: string; version: { id: string } }>;
  };
  assert.equal(runsResponse.status, 200);
  assert.deepEqual(
    runs.runs.map((run) => run.id),
    [activated.activation.runId],
  );
  assert.equal(runs.runs[0]!.status, "queued");
  assert.equal(runs.runs[0]!.version.id, deployed.version?.id);
  assert.equal(
    data.jobs.filter(
      (job) => job.type === "worker.run" && job.payload.workerRunId === activated.activation!.runId,
    ).length,
    1,
  );

  const reconnectedResponse = await read(
    runtime.app,
    `/api/worker-deployments/${deployed.deployment.id}/events`,
    issued.token,
    scenario.workspaceId,
  );
  const reconnected = (await reconnectedResponse.json()) as PacketProductEventPage;
  assert.equal(reconnectedResponse.status, 200);
  assert.equal(reconnected.page.cursorSource, "acknowledged");
  assert.ok(reconnected.events.length > 0);
  assert.equal(reconnected.acknowledgement.cursor, acknowledgedEvent.id);
  assert.equal(
    reconnected.events.some((event) => event.id === acknowledgedEvent.id),
    false,
  );
  assert.equal(
    reconnected.events.some((event) => event.type === "worker.activated"),
    true,
  );
  assert.equal(
    reconnected.events.some((event) => event.traceId === "1".repeat(32)),
    true,
  );

  const evidenceResponse = await read(
    runtime.app,
    reconnected.events[0]!.evidence.href,
    issued.token,
    scenario.workspaceId,
  );
  const evidence = (await evidenceResponse.json()) as {
    eventId: string;
    evidence: { id: string; sourceEventId: string };
  };
  assert.equal(evidenceResponse.status, 200);
  assert.equal(evidence.eventId, reconnected.events[0]!.id);
  assert.equal(evidence.evidence.id, reconnected.events[0]!.evidence.id);
  assert.equal(evidence.evidence.sourceEventId, reconnected.events[0]!.source.eventId);

  const packageV2 = packageVersion(packageV1, scenario);
  const updatedResponse = await writeJson(
    runtime.app,
    "PUT",
    `/api/worker-deployments/${deployed.deployment.id}`,
    {
      ...packageRequest(packageV2, scenario),
      expectedRevision: inspected.deployment!.revision,
      statusReason: scenario.update.statusReason,
    },
    scenario.update.idempotencyKey,
    issued.token,
    scenario.workspaceId,
  );
  const updated = (await updatedResponse.json()) as DeploymentEnvelope;
  assert.equal(updatedResponse.status, 200);
  assert.equal(updated.binding?.operation, "update");
  assert.equal(updated.version?.version, scenario.update.packageVersion);
  assert.equal(updated.deployment?.status, "active");
  assert.equal(updated.previousDeployment?.status, "retired");
  assert.deepEqual(updated.deployment?.capabilityGrants, scenario.capabilityGrants);
  assert.ok(updated.deployment);

  const paused = await control(
    runtime.app,
    updated.deployment.id,
    "pause",
    updated.deployment.revision,
    scenario.controls.pauseIdempotencyKey,
    issued.token,
    scenario.workspaceId,
  );
  assert.equal(paused.deployment?.status, "paused");
  const resumed = await control(
    runtime.app,
    updated.deployment.id,
    "resume",
    paused.deployment!.revision,
    scenario.controls.resumeIdempotencyKey,
    issued.token,
    scenario.workspaceId,
  );
  assert.equal(resumed.deployment?.status, "active");

  const rolledBackResponse = await writeJson(
    runtime.app,
    "POST",
    `/api/worker-deployments/${updated.deployment.id}/rollback`,
    {
      expectedRevision: resumed.deployment!.revision,
      targetPackageVersion: packageV1.packageVersion,
    },
    scenario.controls.rollbackIdempotencyKey,
    issued.token,
    scenario.workspaceId,
  );
  const rolledBack = (await rolledBackResponse.json()) as DeploymentEnvelope;
  assert.equal(rolledBackResponse.status, 200);
  assert.equal(rolledBack.binding?.operation, "rollback");
  assert.equal(rolledBack.version?.version, packageV1.packageVersion);
  assert.equal(rolledBack.deployment?.status, "active");
  assert.deepEqual(rolledBack.deployment?.capabilityGrants, scenario.capabilityGrants);
  assert.ok(rolledBack.deployment);

  const revokedResponse = await writeJson(
    runtime.app,
    "POST",
    `/api/worker-deployments/${rolledBack.deployment.id}/revoke`,
    { expectedRevision: rolledBack.deployment.revision },
    scenario.controls.revokeIdempotencyKey,
    issued.token,
    scenario.workspaceId,
  );
  const revoked = (await revokedResponse.json()) as {
    control: { disposition: string; deployment: { status: string } };
  };
  assert.equal(revokedResponse.status, 200);
  assert.equal(revoked.control.disposition, "applied");
  assert.equal(revoked.control.deployment.status, "revoked");

  const projectedTypes = new Set<string>();
  for (const deploymentId of [
    deployed.deployment.id,
    updated.deployment.id,
    rolledBack.deployment.id,
  ]) {
    const response = await read(
      runtime.app,
      `/api/worker-deployments/${deploymentId}/events?from=beginning&limit=200`,
      issued.token,
      scenario.workspaceId,
    );
    assert.equal(response.status, 200);
    const page = (await response.json()) as PacketProductEventPage;
    for (const event of page.events) projectedTypes.add(event.type);
  }
  for (const eventType of scenario.expectedEventTypes) {
    assert.equal(projectedTypes.has(eventType), true, `${eventType} was projected`);
  }

  const finalInspectResponse = await read(
    runtime.app,
    `/api/worker-deployments/${rolledBack.deployment.id}`,
    issued.token,
    scenario.workspaceId,
  );
  const finalInspect = (await finalInspectResponse.json()) as DeploymentEnvelope;
  assert.equal(finalInspectResponse.status, 200);
  assert.equal(finalInspect.deployment?.status, "revoked");
  assert.equal(JSON.stringify(data).includes(issued.token), false);
  assert.equal(JSON.stringify(data).includes(TEST_SECRET), false);
});

const LIVE_INTEROP_ENV_KEYS = [
  "PACKETAGENT_PACKETADE_INTEROP_BASE_URL",
  "PACKETAGENT_PACKETADE_INTEROP_TOKEN",
  "PACKETAGENT_PACKETADE_INTEROP_WORKSPACE_ID",
] as const;
const LIVE_INTEROP_REQUESTED = LIVE_INTEROP_ENV_KEYS.some((key) => process.env[key]);

test(
  "live PacketADE credential validates the serialized WorkerPackage fixture",
  {
    skip: LIVE_INTEROP_REQUESTED
      ? false
      : `set ${LIVE_INTEROP_ENV_KEYS.join(", ")} to run live interoperability`,
  },
  async () => {
    const baseUrl = requiredInteropEnv("PACKETAGENT_PACKETADE_INTEROP_BASE_URL");
    const token = requiredInteropEnv("PACKETAGENT_PACKETADE_INTEROP_TOKEN");
    const workspaceId = requiredInteropEnv("PACKETAGENT_PACKETADE_INTEROP_WORKSPACE_ID");
    const target = new URL("/api/worker-packages/validate", baseUrl);
    if (
      target.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "::1"].includes(target.hostname)
    ) {
      throw new Error("Live PacketADE interoperability requires HTTPS except on loopback.");
    }
    const [workerPackage, scenario] = await Promise.all([readPackage(), readScenario()]);
    const response = await fetch(target, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": workerPackage.idempotencyKey,
        "packetagent-workspace-id": workspaceId,
      },
      body: JSON.stringify(packageRequest(workerPackage, scenario)),
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(
      response.status,
      200,
      `Live PacketADE validation returned HTTP ${response.status}.`,
    );
    const result = (await response.json()) as {
      schemaVersion: string;
      dryRun: boolean;
      resultingIds: { receiptId: string };
    };
    assert.equal(result.schemaVersion, "packetagent.packet-product-deployment-result/v1");
    assert.equal(result.dryRun, true);
    assert.ok(result.resultingIds.receiptId);
  },
);

interface PacketProductProcess {
  readonly app: Hono;
  readonly trust: ReturnType<typeof createPacketProductTrustService>;
}

interface TestClock {
  readonly date: () => Date;
  readonly iso: () => string;
}

function createPacketProductProcess(
  data: PacketAgentData,
  session: string,
  clock: TestClock,
): PacketProductProcess {
  let mutationChain: Promise<unknown> = Promise.resolve();
  let generatedId = 0;
  const mutateStore = <T>(mutation: (store: PacketAgentData) => T | Promise<T>) => {
    const result = mutationChain.then(() => mutation(data));
    mutationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const repository = createWorkerRepository({
    loadStore: () => data,
    mutateStore,
  });
  const lifecycle = createWorkerLifecycleService({
    repository,
    now: clock.date,
    id: (kind) => `${kind}_handoff_${session}_${++generatedId}`,
  });
  const activation = createWorkerActivationService({
    repository: createWorkerActivationRepository({
      loadStore: () => data,
      mutateStore,
    }),
    now: clock.date,
    id: (kind) => `${kind}_handoff_${session}_${++generatedId}`,
  });
  const control = createWorkerControlService({
    mutateStore,
    now: clock.date,
    id: (kind) => `${kind}_handoff_${session}_${++generatedId}`,
  });
  const trust = createPacketProductTrustService({
    loadStore: () => data,
    mutateStore,
    now: clock.iso,
    generateSecret: () => TEST_SECRET,
    generateId: (kind) => `${kind}_handoff_${session}_${++generatedId}`,
  });
  const readModel = createWorkerOperationsReadModel({
    loadStore: () => data,
  });
  const deployment = createPacketProductDeploymentService({
    trust,
    lifecycle,
    activation,
    control,
    readModel,
    loadStore: () => data,
    mutateStore,
    now: clock.iso,
  });
  const events = createPacketProductEventService({
    trust,
    readModel,
    loadStore: () => data,
    mutateStore,
    now: clock.iso,
    id: () => `event_ack_handoff_${session}_${++generatedId}`,
  });
  const app = new Hono();
  app.route("/api", createWorkerPackageRoutes({ service: deployment }));
  app.route(
    "/api",
    createWorkerPackageEventRoutes({
      service: events,
      streamDurationMs: 500,
      streamPollIntervalMs: 10,
    }),
  );
  return { app, trust };
}

function packageRequest(workerPackage: WorkerPackage, scenario: PacketAdeHandoffScenario) {
  return {
    workerPackage,
    acceptedCapabilityIds: scenario.acceptedCapabilityIds,
    capabilityGrants: scenario.capabilityGrants,
  };
}

function packageVersion(
  workerPackage: WorkerPackage,
  scenario: PacketAdeHandoffScenario,
): WorkerPackage {
  const { integrity: _integrity, ...subject } = workerPackage;
  return sealWorkerPackage({
    ...subject,
    packageVersion: scenario.update.packageVersion,
    idempotencyKey: scenario.update.idempotencyKey,
    worker: {
      ...workerPackage.worker,
      content: {
        ...workerPackage.worker.content,
        instructions: scenario.update.instructions,
      },
    },
  });
}

async function control(
  app: Hono,
  workerDeploymentId: string,
  operation: "pause" | "resume",
  expectedRevision: number,
  idempotencyKey: string,
  token: string,
  workspaceId: string,
): Promise<DeploymentEnvelope> {
  const response = await writeJson(
    app,
    "POST",
    `/api/worker-deployments/${workerDeploymentId}/${operation}`,
    { expectedRevision },
    idempotencyKey,
    token,
    workspaceId,
  );
  assert.equal(response.status, 200);
  return (await response.json()) as DeploymentEnvelope;
}

function read(app: Hono, path: string, token: string, workspaceId: string): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      headers: readHeaders(token, workspaceId),
    }),
  );
}

function writeJson(
  app: Hono,
  method: "POST" | "PUT",
  path: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
  token: string,
  workspaceId: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method,
      headers: {
        ...readHeaders(token, workspaceId),
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    }),
  );
}

function readHeaders(token: string, workspaceId: string) {
  return {
    authorization: `Bearer ${token}`,
    "packetagent-workspace-id": workspaceId,
  };
}

function deterministicClock(): TestClock {
  let tick = 0;
  const date = () => new Date(Date.UTC(2026, 6, 28, 23, 0, tick++));
  return {
    date,
    iso: () => date().toISOString(),
  };
}

async function readPackage(): Promise<WorkerPackage> {
  return JSON.parse(await readFile(PACKAGE_FIXTURE_URL, "utf8")) as WorkerPackage;
}

async function readScenario(): Promise<PacketAdeHandoffScenario> {
  const scenario = JSON.parse(
    await readFile(HANDOFF_FIXTURE_URL, "utf8"),
  ) as PacketAdeHandoffScenario;
  assert.equal(scenario.schemaVersion, "packetagent.packetade-handoff-scenario/v1");
  assert.equal(scenario.workspaceId, "alpha");
  assert.equal(scenario.update.packageVersion, 2);
  assert.ok(scenario.expectedEventTypes.length > 0);
  return scenario;
}

function requiredInteropEnv(name: (typeof LIVE_INTEROP_ENV_KEYS)[number]): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for live PacketADE interoperability.`);
  return value;
}
