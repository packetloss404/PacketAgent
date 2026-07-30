import assert from "node:assert/strict";
import test from "node:test";
import {
  createSeedStore,
  type AgentRecord,
  type PacketAgentData,
  type ProviderRecord,
} from "../packetagent-store.js";
import { createWorkerRepository } from "../workers/repository.js";
import { createWorkerLifecycleService } from "../workers/service.js";
import { materializeLegacyAgentWorker } from "./canonical-materialization.js";

test("legacy Agent materialization is replay-safe and rolls immutable content forward", async () => {
  const data = createSeedStore();
  clearWorkerCollections(data);
  const lifecycle = createWorkerLifecycleService({
    repository: createWorkerRepository({
      loadStore: () => data,
      mutateStore: (mutation) => mutation(data),
    }),
  });
  const agent = makeAgent();
  const first = await materializeLegacyAgentWorker(agent, makeProvider(), {
    lifecycle,
  });
  const replay = await materializeLegacyAgentWorker(agent, makeProvider(), {
    lifecycle,
  });

  assert.equal(first.createdVersion, true);
  assert.equal(replay.createdVersion, false);
  assert.equal(replay.version.id, first.version.id);
  assert.equal(replay.deployment.id, first.deployment.id);
  assert.equal(replay.deployment.status, "active");
  assert.equal(data.workerDefinitions.length, 1);
  assert.equal(data.workerVersions.length, 1);
  assert.equal(data.workerDeployments.length, 1);

  const updated = await materializeLegacyAgentWorker(
    {
      ...agent,
      instructions: `${agent.instructions} Include rollback risk.`,
      updatedAt: "2026-07-29T13:00:00.000Z",
    },
    makeProvider(),
    { lifecycle },
  );
  assert.equal(updated.createdVersion, true);
  assert.equal(updated.version.version, 2);
  assert.notEqual(updated.version.id, first.version.id);
  assert.equal(updated.deployment.status, "active");
  assert.equal(data.workerVersions.length, 2);
  assert.equal(data.workerDeployments.length, 2);
  assert.equal(
    data.workerDeployments.find((entry) => entry.id === first.deployment.id)?.status,
    "retired",
  );
  assert.equal(data.workerDefinitions[0].currentVersionId, updated.version.id);
});

test("paused Agent materialization reaches a paused deployment and can resume deterministically", async () => {
  const data = createSeedStore();
  clearWorkerCollections(data);
  const lifecycle = createWorkerLifecycleService({
    repository: createWorkerRepository({
      loadStore: () => data,
      mutateStore: (mutation) => mutation(data),
    }),
  });
  const paused = await materializeLegacyAgentWorker(
    makeAgent({ status: "paused" }),
    makeProvider(),
    { lifecycle },
  );
  assert.equal(paused.deployment.status, "paused");

  const resumed = await materializeLegacyAgentWorker(
    makeAgent({ status: "active" }),
    makeProvider(),
    { lifecycle },
  );
  assert.equal(resumed.deployment.id, paused.deployment.id);
  assert.equal(resumed.deployment.status, "active");
});

function clearWorkerCollections(data: PacketAgentData): void {
  data.workerDefinitions = [];
  data.workerVersions = [];
  data.workerDeployments = [];
  data.workerRuns = [];
  data.workerCheckpoints = [];
  data.workerEffectReceipts = [];
  data.workerActivationInboxes = [];
  data.workerActivationPayloads = [];
  data.workerCommandReceipts = [];
  data.workerDeploymentRollouts = [];
  data.workerEvents = [];
  data.workerEvidenceEntries = [];
  data.workerArtifactManifests = [];
  data.workerBudgetReservations = [];
}

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-materialized",
    workspaceId: "alpha",
    name: "Release reviewer",
    description: "Review release evidence.",
    instructions: "Inspect the supplied release evidence and summarize risks.",
    providerId: "provider-materialized",
    model: "gpt-test",
    tools: ["http_fetch"],
    enabledTools: ["http_fetch"],
    triggerKind: "manual",
    playbook: [],
    memory: [],
    evaluationSpec: { expectedOutput: "", requiredTools: [] },
    status: "active",
    inputSchema: [],
    createdByUserId: "user_alpha",
    createdAt: "2026-07-29T12:00:00.000Z",
    updatedAt: "2026-07-29T12:00:00.000Z",
    ...overrides,
  };
}

function makeProvider(): ProviderRecord {
  return {
    id: "provider-materialized",
    workspaceId: "alpha",
    name: "Production OpenAI",
    kind: "openai",
    defaultModel: "gpt-test",
    apiKeyConfigured: true,
    status: "connected",
    createdAt: "2026-07-29T12:00:00.000Z",
    updatedAt: "2026-07-29T12:00:00.000Z",
  };
}
