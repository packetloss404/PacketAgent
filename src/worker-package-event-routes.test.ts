import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createSeedStore, type PacketAgentData } from "./packetagent-store.js";
import {
  createWorkerPackageEventRoutes,
  type WorkerPackageEventRoutesDependencies,
} from "./worker-package-event-routes.js";
import { createWorkerActivationRepository } from "./workers/activation-repository.js";
import { createWorkerActivationService } from "./workers/activation.js";
import { createWorkerControlService } from "./workers/control-service.js";
import { createWorkerOperationsReadModel } from "./workers/observability/read-model.js";
import { appendWorkerJournalEntry } from "./workers/observability/journal.js";
import { createPacketProductDeploymentService } from "./workers/package/deployment.js";
import {
  createPacketProductEventService,
  type PacketProductEventPage,
} from "./workers/package/events.js";
import { createPacketProductTrustService } from "./workers/package/trust.js";
import type { WorkerPackage } from "./workers/package/types.js";
import { createWorkerRepository } from "./workers/repository.js";
import { createWorkerLifecycleService } from "./workers/service.js";

const FIXTURE_URL = new URL(
  "./workers/package/fixtures/worker-package-v1.valid.json",
  import.meta.url,
);
const TEST_SECRET = "e".repeat(43);

test("PacketADE event pages project stable versioned events and linked evidence", async () => {
  const harness = await createHarness();
  for (const [index, event] of (
    [
      {
        type: "worker.runtime.phase_started",
        summary: "Worker made bounded progress.",
        data: { phase: "act" },
      },
      {
        type: "worker.attention.requested",
        summary: "Worker requires approval.",
        data: { attentionRequestId: "attention-contract" },
      },
      {
        type: "worker.run.terminal",
        summary: "Worker completed.",
        data: { status: "completed" },
      },
      {
        type: "worker.run.terminal",
        summary: "Worker failed.",
        data: { status: "failed" },
      },
      {
        type: "worker.run.terminal",
        summary: "Worker exhausted its budget.",
        data: { status: "budget_exhausted" },
      },
    ] as const
  ).entries()) {
    appendWorkerJournalEntry(harness.data, {
      id: `event_contract_${index}`,
      workspaceId: "alpha",
      type: event.type,
      source: event.type === "worker.attention.requested" ? "approval" : "supervisor",
      workerDefinitionId: harness.workerDefinitionId,
      workerVersionId: harness.workerVersionId,
      workerDeploymentId: harness.deploymentId,
      workerRunId: harness.runId,
      actor: { type: "system", id: "packetagent.event-contract-test" },
      summary: event.summary,
      data: { workerRunId: harness.runId, ...event.data },
      trace: {
        traceId: "1".repeat(32),
        spanId: "2".repeat(16),
      },
      occurredAt: `2026-07-28T22:00:0${index}.000Z`,
    });
  }
  const firstResponse = await harness.routes.request(
    `/worker-deployments/${harness.deploymentId}/events?from=beginning&limit=1`,
    { headers: readHeaders(harness.token) },
  );
  assert.equal(firstResponse.status, 200);
  assert.equal(firstResponse.headers.get("etag"), '"packet-product-event-cursor-0"');
  const first = (await firstResponse.json()) as PacketProductEventPage;
  assert.equal(first.schemaVersion, "packetagent.packet-product-event-page/v1");
  assert.equal(first.stream.kind, "deployment");
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0]!.schemaVersion, "packetagent.packet-product-worker-event/v1");
  assert.equal(first.events[0]!.deploymentId, harness.deploymentId);
  assert.match(first.events[0]!.id, /^pkevt\./);
  assert.equal(first.events[0]!.evidence.available, true);
  assert.equal(first.events[0]!.traceGap, "source_trace_unavailable");

  const replayResponse = await harness.routes.request(
    `/worker-deployments/${harness.deploymentId}/events?from=beginning&limit=1`,
    { headers: readHeaders(harness.token) },
  );
  const replay = (await replayResponse.json()) as PacketProductEventPage;
  assert.equal(replay.events[0]!.id, first.events[0]!.id);

  const evidenceResponse = await harness.routes.request(
    first.events[0]!.evidence.href.replace("/api", ""),
    { headers: readHeaders(harness.token) },
  );
  const evidence = (await evidenceResponse.json()) as {
    eventId: string;
    evidence: { id: string; sourceEventId: string };
  };
  assert.equal(evidenceResponse.status, 200);
  assert.equal(evidence.eventId, first.events[0]!.id);
  assert.equal(evidence.evidence.id, first.events[0]!.evidence.id);
  assert.equal(evidence.evidence.sourceEventId, first.events[0]!.source.eventId);

  const runResponse = await harness.routes.request(
    `/worker-runs/${harness.runId}/events?from=beginning`,
    { headers: readHeaders(harness.token) },
  );
  const runPage = (await runResponse.json()) as PacketProductEventPage;
  assert.equal(runResponse.status, 200);
  assert.equal(runPage.stream.kind, "run");
  assert.ok(runPage.events.length > 0);
  assert.ok(
    runPage.events.some(
      (event) => event.traceId === "1".repeat(32) && event.runId === harness.runId,
    ),
  );
  const projectedTypes = new Set(runPage.events.map((event) => event.type));
  for (const type of [
    "worker.run.progress",
    "worker.run.approval_required",
    "worker.run.completed",
    "worker.run.failed",
    "worker.run.budget_exhausted",
  ]) {
    assert.equal(projectedTypes.has(type as never), true, `${type} was projected`);
  }
  assert.equal(JSON.stringify(runPage).includes(harness.token), false);
  assert.equal(JSON.stringify(harness.data).includes(TEST_SECRET), false);
});

test("event cursor acknowledgement is durable, monotonic, idempotent, and ETag guarded", async () => {
  const harness = await createHarness();
  const all = await listAllDeploymentEvents(harness);
  assert.ok(all.events.length >= 2);
  const firstCursor = all.events[0]!.id;
  const lastCursor = all.events.at(-1)!.id;

  const firstAck = await acknowledge(
    harness,
    firstCursor,
    "ack-first",
    '"packet-product-event-cursor-0"',
  );
  assert.equal(firstAck.response.status, 200);
  assert.equal(firstAck.response.headers.get("etag"), '"packet-product-event-cursor-1"');
  assert.equal(firstAck.body.record.disposition, "advanced");
  assert.equal(firstAck.body.replayed, false);

  const replay = await acknowledge(
    harness,
    firstCursor,
    "ack-first",
    '"packet-product-event-cursor-0"',
  );
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.record.id, firstAck.body.record.id);

  const stale = await acknowledge(
    harness,
    lastCursor,
    "ack-stale",
    '"packet-product-event-cursor-0"',
  );
  assert.equal(stale.response.status, 412);
  assert.equal(stale.body.code, "precondition_failed");

  const advanced = await acknowledge(
    harness,
    lastCursor,
    "ack-last",
    '"packet-product-event-cursor-1"',
  );
  assert.equal(advanced.response.status, 200);
  assert.equal(advanced.body.record.disposition, "advanced");
  assert.equal(advanced.body.cursor.revision, 2);

  const lower = await acknowledge(
    harness,
    firstCursor,
    "ack-lower",
    '"packet-product-event-cursor-2"',
  );
  assert.equal(lower.response.status, 200);
  assert.equal(lower.body.record.disposition, "unchanged");
  assert.equal(lower.body.cursor.cursor, lastCursor);
  assert.equal(lower.body.cursor.revision, 2);

  const reconstructedRoutes = createWorkerPackageEventRoutes({
    service: createPacketProductEventService({
      trust: harness.trust,
      readModel: createWorkerOperationsReadModel({
        loadStore: () => harness.data,
      }),
      loadStore: () => harness.data,
      mutateStore: harness.mutateStore,
    }),
  });
  const resumedResponse = await reconstructedRoutes.request(
    `/worker-deployments/${harness.deploymentId}/events`,
    { headers: readHeaders(harness.token) },
  );
  const resumed = (await resumedResponse.json()) as PacketProductEventPage;
  assert.equal(resumedResponse.status, 200);
  assert.equal(resumed.page.cursorSource, "acknowledged");
  assert.deepEqual(resumed.events, []);
  assert.equal(resumed.acknowledgement.cursor, lastCursor);
  assert.equal(resumed.acknowledgement.revision, 2);

  const fromBeginningResponse = await reconstructedRoutes.request(
    `/worker-deployments/${harness.deploymentId}/events?from=beginning`,
    { headers: readHeaders(harness.token) },
  );
  const fromBeginning = (await fromBeginningResponse.json()) as PacketProductEventPage;
  assert.equal(fromBeginning.page.cursorSource, "beginning");
  assert.equal(fromBeginning.events.length, all.events.length);
  assert.equal(harness.data.packetProductEventAcknowledgements.length, 3);
});

test("SSE resumes with Last-Event-ID, heartbeats, closes boundedly, and never acknowledges", async () => {
  const harness = await createHarness({
    route: {
      now: incrementingClock(),
      wait: () => undefined,
      streamDurationMs: 4,
      streamPollIntervalMs: 1,
      streamEventLimit: 20,
    },
  });
  const all = await listAllDeploymentEvents(harness);
  const firstCursor = all.events[0]!.id;
  const response = await harness.routes.request(
    `/worker-deployments/${harness.deploymentId}/events/stream`,
    {
      headers: {
        ...readHeaders(harness.token),
        "Last-Event-ID": firstCursor,
      },
    },
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const body = await response.text();
  assert.equal(body.includes(`id: ${firstCursor}\n`), false);
  assert.equal(body.includes(`id: ${all.events[1]!.id}\n`), true);
  assert.match(body, /event: packetagent\.heartbeat/);
  assert.match(body, /event: packetagent\.stream\.closed/);
  assert.equal(harness.data.packetProductEventAcknowledgements.length, 0);

  const conflict = await harness.routes.request(
    `/worker-deployments/${harness.deploymentId}/events/stream?cursor=other`,
    {
      headers: {
        ...readHeaders(harness.token),
        "Last-Event-ID": firstCursor,
      },
    },
  );
  assert.equal(conflict.status, 400);
});

test("event cursors are stream-bound and return a recoverable retention-window error", async () => {
  const harness = await createHarness();
  const all = await listAllDeploymentEvents(harness);
  assert.ok(all.events.length >= 2);
  const first = all.events[0]!;

  const crossed = await harness.routes.request(
    `/worker-runs/${harness.runId}/events?cursor=${encodeURIComponent(first.id)}`,
    { headers: readHeaders(harness.token) },
  );
  assert.equal(crossed.status, 400);
  assert.equal(((await crossed.json()) as { code: string }).code, "invalid_cursor");

  harness.data.workerEvents = harness.data.workerEvents.filter(
    (event) => event.id !== first.source.eventId,
  );
  harness.data.workerEvidenceEntries = harness.data.workerEvidenceEntries.filter(
    (evidence) => evidence.sourceEventId !== first.source.eventId,
  );
  const expired = await harness.routes.request(
    `/worker-deployments/${harness.deploymentId}/events?cursor=${encodeURIComponent(first.id)}`,
    { headers: readHeaders(harness.token) },
  );
  const expiredBody = (await expired.json()) as {
    code: string;
    minimumCursor: string;
    minimumWorkspaceSequence: number;
  };
  assert.equal(expired.status, 410);
  assert.equal(expiredBody.code, "cursor_expired");
  assert.match(expiredBody.minimumCursor, /^pkevt\./);
  assert.ok(expiredBody.minimumWorkspaceSequence > first.workspaceSequence);

  const unauthorized = await harness.routes.request(
    `/worker-deployments/${harness.deploymentId}/events`,
    {
      headers: {
        "packetagent-workspace-id": "alpha",
      },
    },
  );
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get("www-authenticate") ?? "", /^Bearer /);
});

interface EventPageBody {
  readonly events: PacketProductEventPage["events"];
}

interface AcknowledgementBody {
  readonly replayed: boolean;
  readonly code?: string;
  readonly record: {
    readonly id: string;
    readonly disposition: "advanced" | "unchanged";
  };
  readonly cursor: {
    readonly cursor?: string;
    readonly revision: number;
  };
}

async function createHarness(
  options: { readonly route?: WorkerPackageEventRoutesDependencies } = {},
) {
  const data = createSeedStore();
  let mutationChain: Promise<unknown> = Promise.resolve();
  const mutateStore = <T>(mutation: (store: PacketAgentData) => T | Promise<T>) => {
    const result = mutationChain.then(() => mutation(data));
    mutationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  let tick = 0;
  let generatedId = 0;
  const nowDate = () => new Date(Date.UTC(2026, 6, 28, 21, 0, tick++));
  const nowString = () => nowDate().toISOString();
  const repository = createWorkerRepository({
    loadStore: () => data,
    mutateStore,
  });
  const lifecycle = createWorkerLifecycleService({
    repository,
    now: nowDate,
    id: (kind) => `${kind}_event_route_${++generatedId}`,
  });
  const activation = createWorkerActivationService({
    repository: createWorkerActivationRepository({
      loadStore: () => data,
      mutateStore,
    }),
    now: nowDate,
    id: (kind) => `${kind}_event_route_${++generatedId}`,
  });
  const trust = createPacketProductTrustService({
    loadStore: () => data,
    mutateStore,
    now: nowString,
    generateSecret: () => TEST_SECRET,
    generateId: (kind) => `${kind}_event_route_${++generatedId}`,
  });
  const issued = await trust.issueCredential({
    workspaceId: "alpha",
    subjectId: "packetade:event-route-test",
    allowedOperations: [
      "package.validate",
      "package.deploy",
      "deployment.activate",
      "run.list_events",
      "run.ack_events",
    ],
    createdBy: { type: "user", id: "user_alpha" },
  });
  const readModel = createWorkerOperationsReadModel({
    loadStore: () => data,
  });
  const deploymentService = createPacketProductDeploymentService({
    trust,
    lifecycle,
    activation,
    control: createWorkerControlService({
      mutateStore,
      now: nowDate,
      id: (kind) => `${kind}_event_route_${++generatedId}`,
    }),
    readModel,
    loadStore: () => data,
    mutateStore,
    now: nowString,
  });
  const workerPackage = JSON.parse(await readFile(FIXTURE_URL, "utf8")) as WorkerPackage;
  const deployed = await deploymentService.deployPackage({
    authorization: `Bearer ${issued.token}`,
    workspaceId: "alpha",
    workerPackage,
    idempotencyKey: workerPackage.idempotencyKey,
    acceptedCapabilityIds: ["release-read"],
    capabilityGrants: [
      {
        capabilityId: "release-read",
        verbs: ["GET"],
        resources: ["https://releases.example.test/stable"],
        approval: "never",
      },
    ],
  });
  assert.ok(deployed.deployment);
  const activated = await deploymentService.activate({
    authorization: `Bearer ${issued.token}`,
    workspaceId: "alpha",
    workerDeploymentId: deployed.deployment.id,
    idempotencyKey: "activate-event-route",
    expectedRevision: deployed.deployment.revision,
    startRun: true,
    input: { release_id: "release-42" },
    trace: {
      traceId: "1".repeat(32),
      spanId: "2".repeat(16),
    },
  });
  assert.ok(activated.activation?.runId);
  const eventService = createPacketProductEventService({
    trust,
    readModel,
    loadStore: () => data,
    mutateStore,
    now: nowString,
    id: () => `event_ack_event_route_${++generatedId}`,
  });
  return {
    data,
    token: issued.token,
    trust,
    mutateStore,
    deploymentId: deployed.deployment.id,
    workerDefinitionId: deployed.definition!.id,
    workerVersionId: deployed.version!.id,
    runId: activated.activation.runId,
    routes: createWorkerPackageEventRoutes({
      ...options.route,
      service: eventService,
    }),
  };
}

async function listAllDeploymentEvents(
  harness: Awaited<ReturnType<typeof createHarness>>,
): Promise<EventPageBody> {
  const response = await harness.routes.request(
    `/worker-deployments/${harness.deploymentId}/events?from=beginning&limit=200`,
    { headers: readHeaders(harness.token) },
  );
  assert.equal(response.status, 200);
  return (await response.json()) as EventPageBody;
}

async function acknowledge(
  harness: Awaited<ReturnType<typeof createHarness>>,
  cursor: string,
  idempotencyKey: string,
  etag: string,
): Promise<{ response: Response; body: AcknowledgementBody }> {
  const response = await harness.routes.request(
    `/worker-deployments/${harness.deploymentId}/events/cursor`,
    {
      method: "PUT",
      headers: {
        ...readHeaders(harness.token),
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        "if-match": etag,
      },
      body: JSON.stringify({ cursor }),
    },
  );
  return {
    response,
    body: (await response.json()) as AcknowledgementBody,
  };
}

function readHeaders(token: string) {
  return {
    authorization: `Bearer ${token}`,
    "packetagent-workspace-id": "alpha",
  };
}

function incrementingClock(): () => number {
  let value = 0;
  return () => value++;
}
