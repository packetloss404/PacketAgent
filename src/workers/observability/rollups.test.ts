import assert from "node:assert/strict";
import test from "node:test";
import { createSeedStore, type PacketAgentData } from "../../packetagent-store.js";
import type { ProviderCallRecord } from "../../store/types.js";
import {
  WORKER_BUDGET_RESERVATION_SCHEMA_VERSION,
  type WorkerBudgetReservationRecord,
} from "../budget-types.js";
import {
  makeWorkerApprovalGrant,
  makeWorkerAttentionRequest,
  makeWorkerCheckpoint,
  makeWorkerDefinition,
  makeWorkerDeployment,
  makeWorkerRun,
  makeWorkerVersion,
} from "../__tests__/fixtures.js";
import { WORKER_EFFECT_RECEIPT_SCHEMA_VERSION, type WorkerEffectReceipt } from "../effect-types.js";
import { appendWorkerJournalEntry } from "./journal.js";
import { WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION, type WorkerArtifactManifest } from "./types.js";
import { computeWorkerArtifactManifestDigest } from "./validation.js";
import { buildWorkerObservabilityRollups, createWorkerRollupRepository } from "./rollups.js";

const NOW = "2026-07-27T18:00:00.000Z";
const LATER = "2026-07-27T18:05:00.000Z";
const ACTOR = {
  type: "system" as const,
  id: "packetagent.rollup-test",
};

test("rollups deterministically aggregate Worker source records by run, deployment, and version", () => {
  const data = canonicalData();
  const run = data.workerRuns[0]!;
  data.workerRuns[0] = {
    ...run,
    status: "completed",
    terminalReason: "objective_satisfied",
    budgetUsage: {
      elapsedMs: 12_000,
      iterations: 2,
      providerCostUsd: 0.25,
      consecutiveFailures: 0,
      toolCalls: 2,
    },
    startedAt: "2026-07-27T18:00:05.000Z",
    completedAt: LATER,
    updatedAt: LATER,
  };
  data.jobs.push({
    id: "job-1",
    workspaceId: "alpha",
    type: "worker.run",
    payload: { workerRunId: "run-1" },
    status: "success",
    attempts: 2,
    maxAttempts: 3,
    scheduledAt: NOW,
    startedAt: "2026-07-27T18:00:05.000Z",
    completedAt: LATER,
    createdAt: NOW,
    updatedAt: LATER,
  });
  data.providerCalls.push(providerCall());
  data.workerEffectReceipts.push(effectReceipt());
  data.workerBudgetReservations.push(
    budgetReservation({
      id: "budget-provider",
      reservationKey: "provider:1",
      kind: "provider_cost_usd",
      reservedAmount: 1,
      settledAmount: 0.25,
    }),
    budgetReservation({
      id: "budget-action",
      reservationKey: "action:1",
      kind: "billable_action",
      reservedAmount: 1,
      settledAmount: 1,
    }),
  );
  data.workerAttentionRequests.push(
    makeWorkerAttentionRequest({
      id: "attention-1",
      workspaceId: "alpha",
      workerDefinitionId: "definition-1",
      workerVersionId: "version-1",
      workerDeploymentId: "deployment-1",
      workerRunId: "run-1",
      status: "approved",
      resolvedAt: LATER,
      resolvedBy: ACTOR,
      resolutionCommandId: "command-1",
    }),
  );
  data.workerApprovalGrants.push(
    makeWorkerApprovalGrant({
      id: "grant-1",
      attentionRequestId: "attention-1",
      workspaceId: "alpha",
      workerDefinitionId: "definition-1",
      workerVersionId: "version-1",
      workerDeploymentId: "deployment-1",
      workerRunId: "run-1",
      status: "consumed",
      consumedAt: LATER,
      consumedByActionId: "tool-1",
    }),
  );
  data.workerCheckpoints.push(
    makeWorkerCheckpoint({
      id: "checkpoint-1",
      workspaceId: "alpha",
      workerRunId: "run-1",
      workerVersionId: "version-1",
      sequence: 2,
      createdAt: LATER,
    }),
  );
  data.activities.push({
    id: "activity-1",
    workspaceId: "alpha",
    scope: "workspace",
    event: "worker.completed",
    occurredAt: LATER,
    actor: ACTOR,
    data: { workerRunId: "run-1" },
  });

  append("event-provider", "worker.provider.completed", data, {
    source: "provider",
    correlation: { providerCallId: "provider-call-1" },
    data: {
      providerCallId: "provider-call-1",
      promptTokens: 100,
      completionTokens: 20,
      costUsd: 0.25,
    },
  });
  const tool = append("event-tool", "worker.tool.completed", data, {
    source: "tool",
    correlation: { toolCallId: "tool-1", effectReceiptId: "effect-1" },
    data: {
      callId: "tool-1",
      effectReceiptId: "effect-1",
      status: "ok",
      durationMs: 50,
    },
  });
  append("event-tool-failed", "worker.tool.failed", data, {
    source: "tool",
    correlation: { toolCallId: "tool-2" },
    data: {
      callId: "tool-2",
      status: "error",
      durationMs: 25,
    },
  });
  append("event-phase-failed", "worker.phase.failed", data, {
    source: "supervisor",
    data: {
      phase: "act",
      consecutiveFailures: 1,
      backoffMs: 100,
    },
  });
  append("event-evaluated", "worker.phase.evaluated", data, {
    source: "supervisor",
    data: {
      predicateId: "objective-satisfied",
      matched: true,
    },
  });
  append("event-checkpoint", "worker.checkpoint.persisted", data, {
    source: "checkpoint",
    correlation: { checkpointId: "checkpoint-1" },
  });
  append("event-attention", "worker.attention.requested", data, {
    source: "approval",
    correlation: { attentionRequestId: "attention-1" },
  });
  append("event-terminal", "worker.run.terminal", data, {
    source: "terminal",
    data: { status: "completed", terminalReason: "objective_satisfied" },
  });
  data.workerArtifactManifests.push(artifactManifest(tool.evidence.id));

  const first = buildWorkerObservabilityRollups(data, "alpha");
  const shuffled = structuredClone(data);
  reverseSourceArrays(shuffled);
  const rebuilt = buildWorkerObservabilityRollups(shuffled, "alpha");
  assert.deepEqual(rebuilt, first);

  assert.equal(first.runs.length, 1);
  const rollup = first.runs[0]!;
  assert.equal(rollup.events, 8);
  assert.equal(rollup.evidenceEntries, 8);
  assert.equal(rollup.relatedActivities, 1);
  assert.deepEqual(rollup.providers, {
    calls: 1,
    succeeded: 1,
    failed: 0,
    canceled: 0,
    missingSourceRecords: 0,
    uncorrelatedEvents: 0,
    promptTokens: 100,
    completionTokens: 20,
    costUsd: 0.25,
    durationMs: 80,
    byProvider: {
      stub: { calls: 1, costUsd: 0.25 },
    },
  });
  assert.deepEqual(rollup.tools, {
    attempted: 2,
    completed: 2,
    succeeded: 1,
    failed: 1,
    unresolved: 0,
    denied: 0,
    durationMs: 75,
  });
  assert.deepEqual(rollup.effects, {
    total: 1,
    prepared: 0,
    completed: 1,
    succeeded: 1,
    failed: 0,
    timedOut: 0,
    durationMs: 50,
  });
  assert.deepEqual(rollup.retries, {
    executionAttempts: 2,
    jobRetries: 1,
    recoveryRequeues: 0,
    providerFailures: 0,
    phaseFailures: 1,
    scheduledBackoffMs: 100,
  });
  assert.equal(rollup.queue.averageDurationMs, 5_000);
  assert.equal(rollup.approvals.requestStatusCounts.approved, 1);
  assert.equal(rollup.approvals.grantStatusCounts.consumed, 1);
  assert.deepEqual(rollup.checkpoints, {
    count: 1,
    latestId: "checkpoint-1",
    latestSequence: 2,
    latestCreatedAt: LATER,
  });
  assert.equal(rollup.budget.reportedUsage.providerCostUsd, 0.25);
  assert.equal(rollup.budget.settledProviderCostUsd, 0.25);
  assert.equal(rollup.budget.settledBillableActions, 1);
  assert.equal(rollup.artifacts.count, 1);
  assert.equal(rollup.artifacts.totalBytes, 128);
  assert.equal(rollup.outcomes.statusCounts.completed, 1);
  assert.equal(rollup.outcomes.terminalReasonCounts.objective_satisfied, 1);
  assert.equal(rollup.outcomes.exitEvaluations, 1);
  assert.equal(rollup.outcomes.matchedExitPredicates, 1);
  assert.equal(rollup.sourceGaps.total, 0);

  assert.equal(first.deployments[0]!.providers.costUsd, 0.25);
  assert.equal(first.versions[0]!.artifacts.count, 1);
});

test("missing retained provider records remain explained rollup gaps", () => {
  const data = canonicalData();
  append("event-provider", "worker.provider.completed", data, {
    source: "provider",
    correlation: { providerCallId: "expired-provider-call" },
    data: {
      providerCallId: "expired-provider-call",
      promptTokens: 12,
      completionTokens: 3,
      costUsd: 0.04,
    },
  });

  const rollup = buildWorkerObservabilityRollups(data, "alpha").runs[0]!;
  assert.equal(rollup.providers.calls, 1);
  assert.equal(rollup.providers.succeeded, 1);
  assert.equal(rollup.providers.costUsd, 0.04);
  assert.equal(rollup.providers.missingSourceRecords, 1);
  assert.deepEqual(rollup.sourceGaps, {
    total: 1,
    byKind: { provider_call: 1 },
  });
});

test("rollup repository rebuilds valid journal state after restart and isolates workspaces", async () => {
  const data = canonicalData();
  append("event-terminal", "worker.run.terminal", data, {
    source: "terminal",
    data: { status: "completed" },
  });
  const firstRepository = createWorkerRollupRepository({
    loadStore: () => structuredClone(data),
  });
  const restartedRepository = createWorkerRollupRepository({
    loadStore: () => JSON.parse(JSON.stringify(data)) as PacketAgentData,
  });

  assert.deepEqual(
    await restartedRepository.rebuild("alpha"),
    await firstRepository.rebuild("alpha"),
  );
  assert.deepEqual(await restartedRepository.rebuild("workspace-2"), {
    schemaVersion: "packetagent.worker-observability-rollup/v1",
    workspaceId: "workspace-2",
    computedThroughSequence: 0,
    versions: [],
    deployments: [],
    runs: [],
  });
});

function canonicalData(): PacketAgentData {
  const data = createSeedStore();
  data.workerDefinitions.push(
    makeWorkerDefinition({
      id: "definition-1",
      workspaceId: "alpha",
    }),
  );
  data.workerVersions.push(
    makeWorkerVersion({
      id: "version-1",
      workspaceId: "alpha",
      workerDefinitionId: "definition-1",
    }),
  );
  data.workerDeployments.push(
    makeWorkerDeployment({
      id: "deployment-1",
      workspaceId: "alpha",
      workerDefinitionId: "definition-1",
      workerVersionId: "version-1",
    }),
  );
  data.workerRuns.push(
    makeWorkerRun({
      id: "run-1",
      workspaceId: "alpha",
      workerDefinitionId: "definition-1",
      workerVersionId: "version-1",
      workerDeploymentId: "deployment-1",
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
  return data;
}

function append(
  id: string,
  type: string,
  data: PacketAgentData,
  overrides: {
    source: "provider" | "tool" | "supervisor" | "checkpoint" | "approval" | "terminal";
    correlation?: {
      providerCallId?: string;
      toolCallId?: string;
      effectReceiptId?: string;
      checkpointId?: string;
      attentionRequestId?: string;
    };
    data?: Record<string, string | number | boolean | null>;
  },
) {
  return appendWorkerJournalEntry(data, {
    id,
    workspaceId: "alpha",
    type,
    source: overrides.source,
    workerDefinitionId: "definition-1",
    workerVersionId: "version-1",
    workerDeploymentId: "deployment-1",
    workerRunId: "run-1",
    actor: ACTOR,
    summary: `${type} occurred.`,
    ...(overrides.correlation ? { correlation: overrides.correlation } : {}),
    ...(overrides.data ? { data: overrides.data } : {}),
    occurredAt: LATER,
  });
}

function providerCall(): ProviderCallRecord {
  return {
    id: "provider-call-1",
    workspaceId: "alpha",
    routeKey: "smart",
    provider: "stub",
    model: "stub",
    promptTokens: 100,
    completionTokens: 20,
    costUsd: 0.25,
    durationMs: 80,
    status: "success",
    startedAt: NOW,
    completedAt: LATER,
  };
}

function effectReceipt(): WorkerEffectReceipt {
  return {
    schemaVersion: WORKER_EFFECT_RECEIPT_SCHEMA_VERSION,
    id: "effect-1",
    workspaceId: "alpha",
    workerRunId: "run-1",
    workerVersionId: "version-1",
    workerDeploymentId: "deployment-1",
    effectKey: "effect-key-1",
    iteration: 1,
    actionId: "tool-1",
    capabilityId: "release-read",
    toolName: "http_fetch",
    operation: "GET https://example.test",
    inputDigest: `sha256:${"a".repeat(64)}`,
    classification: "idempotent_mutation",
    status: "completed",
    preparedAt: NOW,
    completedAt: LATER,
    result: {
      kind: "inline_redacted",
      status: "ok",
      durationMs: 50,
      startedAt: NOW,
      completedAt: LATER,
      digest: `sha256:${"b".repeat(64)}`,
    },
  };
}

function budgetReservation(
  overrides: Pick<
    WorkerBudgetReservationRecord,
    "id" | "reservationKey" | "kind" | "reservedAmount" | "settledAmount"
  >,
): WorkerBudgetReservationRecord {
  return {
    schemaVersion: WORKER_BUDGET_RESERVATION_SCHEMA_VERSION,
    workspaceId: "alpha",
    workerDeploymentId: "deployment-1",
    workerRunId: "run-1",
    workerVersionId: "version-1",
    fencingToken: 1,
    status: "settled",
    windowMs: 86_400_000,
    workspaceLimit: 100,
    deploymentLimit: 10,
    reservedAt: NOW,
    settledAt: LATER,
    updatedAt: LATER,
    ...overrides,
  };
}

function artifactManifest(sourceEvidenceId: string): WorkerArtifactManifest {
  const unsigned = {
    schemaVersion: WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION,
    id: "artifact-1",
    workspaceId: "alpha",
    workerDefinitionId: "definition-1",
    workerVersionId: "version-1",
    workerDeploymentId: "deployment-1",
    workerRunId: "run-1",
    artifact: {
      reference: "artifact:report",
      mediaType: "application/json",
      byteLength: 128,
      contentDigest: `sha256:${"c".repeat(64)}`,
    },
    classification: "internal" as const,
    provenance: {
      producerKind: "worker_tool" as const,
      producerId: "tool-1",
      sourceEvidenceIds: [sourceEvidenceId],
      materials: [],
    },
    createdAt: LATER,
  };
  return {
    ...unsigned,
    manifestDigest: computeWorkerArtifactManifestDigest(unsigned),
  };
}

function reverseSourceArrays(data: PacketAgentData): void {
  data.workerEvents.reverse();
  data.workerEvidenceEntries.reverse();
  data.workerRuns.reverse();
  data.jobs.reverse();
  data.providerCalls.reverse();
  data.workerEffectReceipts.reverse();
  data.workerBudgetReservations.reverse();
  data.workerAttentionRequests.reverse();
  data.workerApprovalGrants.reverse();
  data.workerCheckpoints.reverse();
  data.workerArtifactManifests.reverse();
  data.activities.reverse();
}
