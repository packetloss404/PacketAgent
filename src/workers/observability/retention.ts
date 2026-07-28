import { createHash, randomUUID } from "node:crypto";
import {
  loadStoreAsync as defaultLoadStore,
  mutateStoreAsync as defaultMutateStore,
  type PacketAgentData,
} from "../../packetagent-store.js";
import { validateWorkerActivationPersistence } from "../activation-repository.js";
import { WORKER_NOTIFICATION_OUTBOX_SCHEMA_VERSION } from "../control-types.js";
import type { WorkerEffectRetentionTombstone } from "../effect-types.js";
import { appendWorkerJournalEntry, isWorkerEventV2 } from "./journal.js";
import type { WorkerEvent } from "../persistence-types.js";
import type { JsonObject, WorkerRun } from "../types.js";
import { canonicalWorkerJson } from "../validation.js";
import {
  assertWorkerRetentionPolicy,
  type WorkerRetentionCategory,
  type WorkerRetentionCategoryMetrics,
  type WorkerRetentionCleanupInput,
  type WorkerRetentionCleanupResult,
  type WorkerRetentionResourceKind,
} from "./retention-types.js";

type MaybePromise<T> = T | Promise<T>;

const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_ITEMS = 100;
const DEFAULT_MAX_DURATION_MS = 5_000;
const MAX_ITEMS = 500;
const MAX_DURATION_MS = 60_000;
const RETENTION_ACTOR = {
  type: "system" as const,
  id: "packetagent.worker-retention",
  displayName: "PacketAgent Worker Retention",
};
const TERMINAL_RUN_STATUSES = new Set<WorkerRun["status"]>([
  "completed",
  "failed",
  "budget_exhausted",
  "cancelled",
  "quarantined",
]);

export interface WorkerArtifactRetentionDeleteInput {
  readonly workspaceId: string;
  readonly manifestId: string;
  readonly reference: string;
  readonly expectedDigest: string;
}

export interface WorkerArtifactRetentionPort {
  delete(input: WorkerArtifactRetentionDeleteInput): Promise<"deleted" | "already_absent">;
}

export interface WorkerRetentionServiceDependencies {
  readonly loadStore?: () => MaybePromise<PacketAgentData>;
  readonly mutateStore?: <T>(
    mutator: (data: PacketAgentData) => MaybePromise<T>,
  ) => MaybePromise<T>;
  readonly artifactPort?: WorkerArtifactRetentionPort;
  readonly now?: () => Date;
  readonly monotonicMs?: () => number;
  readonly id?: () => string;
}

export interface WorkerRetentionService {
  cleanup(input: WorkerRetentionCleanupInput): Promise<WorkerRetentionCleanupResult>;
}

interface MutableCategoryMetrics {
  scanned: number;
  eligible: number;
  deleted: number;
  skipped: number;
  failed: number;
}

interface RetentionCandidate {
  readonly key: string;
  readonly eligibleAt: number;
  readonly category: WorkerRetentionCategory;
  apply(data: PacketAgentData, timestamp: string): Promise<"deleted" | "skipped">;
}

interface TombstoneContext {
  readonly workspaceId: string;
  readonly workerDefinitionId: string;
  readonly workerVersionId?: string;
  readonly workerDeploymentId?: string;
  readonly workerRunId?: string;
}

interface TombstoneInput {
  readonly eventId: string;
  readonly category: WorkerRetentionCategory;
  readonly resourceKind: WorkerRetentionResourceKind;
  readonly resourceIds: readonly string[];
  readonly contentDigest?: string;
  readonly recordCount?: number;
  readonly originalOccurredAt?: string;
}

interface BuildCandidateInput {
  readonly data: PacketAgentData;
  readonly workspaceId: string;
  readonly policy: WorkerRetentionCleanupInput["policy"];
  readonly executionTime: Date;
  readonly categories: Record<WorkerRetentionCategory, MutableCategoryMetrics>;
  readonly artifactPort: WorkerArtifactRetentionPort | undefined;
  readonly id: () => string;
}

export function createWorkerRetentionService(
  dependencies: WorkerRetentionServiceDependencies = {},
): WorkerRetentionService {
  const loadStore = dependencies.loadStore ?? defaultLoadStore;
  const mutateStore = dependencies.mutateStore ?? defaultMutateStore;
  const artifactPort = dependencies.artifactPort;
  const now = dependencies.now ?? (() => new Date());
  const monotonicMs = dependencies.monotonicMs ?? (() => performance.now());
  const id = dependencies.id ?? (() => `worker-retention-event_${randomUUID()}`);

  return {
    async cleanup(input) {
      assertCleanupInput(input);
      const maxItems = input.maxItems ?? DEFAULT_MAX_ITEMS;
      const maxDurationMs = input.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
      const dryRun = input.dryRun ?? false;
      const executionTime = now();
      const startedAt = executionTime.toISOString();
      const startedMonotonic = monotonicMs();

      const execute = async (
        data: PacketAgentData,
        applyChanges: boolean,
      ): Promise<WorkerRetentionCleanupResult> => {
        validateWorkerActivationPersistence(data);
        const categories = emptyMetrics();
        const candidates = buildCandidates({
          data,
          workspaceId: input.workspaceId,
          policy: input.policy,
          executionTime,
          categories,
          artifactPort,
          id,
        }).sort(compareCandidates);

        let processed = 0;
        let deleted = 0;
        let timedOut = false;
        for (const candidate of candidates) {
          if (processed >= maxItems || monotonicMs() - startedMonotonic >= maxDurationMs) {
            timedOut = true;
            break;
          }
          processed += 1;
          if (!applyChanges) continue;
          try {
            const outcome = await candidate.apply(data, startedAt);
            if (outcome === "deleted") {
              categories[candidate.category].deleted += 1;
              deleted += 1;
            } else {
              categories[candidate.category].skipped += 1;
            }
          } catch {
            categories[candidate.category].failed += 1;
          }
        }

        validateWorkerActivationPersistence(data);
        const completedAt = now().toISOString();
        return {
          workspaceId: input.workspaceId,
          policy: structuredClone(input.policy),
          dryRun,
          maxItems,
          maxDurationMs,
          processed,
          deleted,
          hasMore: timedOut || candidates.length > processed,
          startedAt,
          completedAt,
          elapsedMs: Math.max(0, Math.round(monotonicMs() - startedMonotonic)),
          categories: cloneMetrics(categories),
        };
      };

      if (dryRun) {
        return execute(await loadStore(), false);
      }
      return await mutateStore((data) => execute(data, true));
    },
  };
}

function buildCandidates(input: BuildCandidateInput): RetentionCandidate[] {
  const candidates: RetentionCandidate[] = [];
  const cutoff = (days: number) => input.executionTime.getTime() - days * DAY_MS;

  for (const payload of input.data.workerActivationPayloads) {
    if (payload.workspaceId !== input.workspaceId) continue;
    input.categories.prompt.scanned += 1;
    const eligibleAt = Math.min(
      Date.parse(payload.expiresAt),
      Date.parse(payload.createdAt) + input.policy.promptDays * DAY_MS,
    );
    if (eligibleAt > input.executionTime.getTime()) continue;
    const inbox = input.data.workerActivationInboxes.find(
      (record) =>
        record.workspaceId === input.workspaceId &&
        record.envelope.payloadReference?.reference === payload.reference,
    );
    const run = inbox ? findRun(input.data, input.workspaceId, inbox.workerRunId) : undefined;
    if (!inbox || !run) continue;
    input.categories.prompt.eligible += 1;
    candidates.push({
      key: `prompt:activation:${payload.id}`,
      eligibleAt,
      category: "prompt",
      async apply(data, timestamp) {
        const index = data.workerActivationPayloads.findIndex(
          (record) => record.workspaceId === input.workspaceId && record.id === payload.id,
        );
        if (index < 0) return "skipped";
        const eventId = input.id();
        appendTombstone(
          data,
          runContext(run),
          {
            eventId,
            category: "prompt",
            resourceKind: "activation_payload",
            resourceIds: [payload.id],
            contentDigest: payload.digest,
          },
          timestamp,
        );
        data.workerActivationPayloads.splice(index, 1);
        return "deleted";
      },
    });
  }

  for (const run of input.data.workerRuns) {
    if (run.workspaceId !== input.workspaceId || !isTerminal(run) || !run.completedAt) continue;
    const completedAt = Date.parse(run.completedAt);
    input.categories.prompt.scanned += 1;
    if (run.input !== undefined && completedAt <= cutoff(input.policy.promptDays)) {
      input.categories.prompt.eligible += 1;
      candidates.push({
        key: `prompt:run:${run.id}`,
        eligibleAt: completedAt + input.policy.promptDays * DAY_MS,
        category: "prompt",
        async apply(data, timestamp) {
          const index = findRunIndex(data, input.workspaceId, run.id);
          if (index < 0 || data.workerRuns[index].input === undefined) return "skipped";
          const current = data.workerRuns[index];
          appendTombstone(
            data,
            runContext(current),
            {
              eventId: input.id(),
              category: "prompt",
              resourceKind: "worker_run_input",
              resourceIds: [run.id],
            },
            timestamp,
          );
          const { input: _input, ...withoutInput } = current;
          data.workerRuns[index] = {
            ...withoutInput,
            revision: current.revision + 1,
            updatedAt: timestamp,
          };
          return "deleted";
        },
      });
    }

    input.categories.summary.scanned += 1;
    if (
      (run.output !== undefined || run.error !== undefined) &&
      completedAt <= cutoff(input.policy.summaryDays)
    ) {
      input.categories.summary.eligible += 1;
      candidates.push({
        key: `summary:run:${run.id}`,
        eligibleAt: completedAt + input.policy.summaryDays * DAY_MS,
        category: "summary",
        async apply(data, timestamp) {
          const index = findRunIndex(data, input.workspaceId, run.id);
          if (index < 0) return "skipped";
          const current = data.workerRuns[index];
          if (current.output === undefined && current.error === undefined) return "skipped";
          appendTombstone(
            data,
            runContext(current),
            {
              eventId: input.id(),
              category: "summary",
              resourceKind: "worker_run_summary",
              resourceIds: [run.id],
            },
            timestamp,
          );
          const { output: _output, error: _error, ...withoutSummary } = current;
          data.workerRuns[index] = {
            ...withoutSummary,
            revision: current.revision + 1,
            updatedAt: timestamp,
          };
          return "deleted";
        },
      });
    }

    const checkpoints = input.data.workerCheckpoints.filter(
      (record) => record.workspaceId === input.workspaceId && record.workerRunId === run.id,
    );
    input.categories.tool_payload.scanned += checkpoints.length;
    if (checkpoints.length > 0 && completedAt <= cutoff(input.policy.toolPayloadDays)) {
      input.categories.tool_payload.eligible += 1;
      candidates.push({
        key: `tool:checkpoints:${run.id}`,
        eligibleAt: completedAt + input.policy.toolPayloadDays * DAY_MS,
        category: "tool_payload",
        async apply(data, timestamp) {
          const retained = data.workerCheckpoints.filter(
            (record) => record.workspaceId !== input.workspaceId || record.workerRunId !== run.id,
          );
          const removed = data.workerCheckpoints.length - retained.length;
          if (removed === 0) return "skipped";
          const runIndex = findRunIndex(data, input.workspaceId, run.id);
          if (runIndex < 0 || !isTerminal(data.workerRuns[runIndex])) return "skipped";
          const current = data.workerRuns[runIndex];
          appendTombstone(
            data,
            runContext(current),
            {
              eventId: input.id(),
              category: "tool_payload",
              resourceKind: "checkpoint_chain",
              resourceIds: checkpoints.map((checkpoint) => checkpoint.id),
              recordCount: removed,
            },
            timestamp,
          );
          const { latestCheckpointId: _latestCheckpointId, ...withoutCheckpoint } = current;
          data.workerRuns[runIndex] = {
            ...withoutCheckpoint,
            revision: current.revision + 1,
            updatedAt: timestamp,
          };
          data.workerCheckpoints = retained;
          return "deleted";
        },
      });
    }
  }

  for (const receipt of input.data.workerEffectReceipts) {
    if (receipt.workspaceId !== input.workspaceId) continue;
    input.categories.tool_payload.scanned += 1;
    const run = findRun(input.data, input.workspaceId, receipt.workerRunId);
    if (
      !run ||
      !isTerminal(run) ||
      receipt.status !== "completed" ||
      receipt.result?.kind !== "inline_redacted"
    ) {
      continue;
    }
    const completedAt = Date.parse(receipt.result.completedAt);
    if (completedAt > cutoff(input.policy.toolPayloadDays)) continue;
    input.categories.tool_payload.eligible += 1;
    candidates.push({
      key: `tool:effect:${receipt.id}`,
      eligibleAt: completedAt + input.policy.toolPayloadDays * DAY_MS,
      category: "tool_payload",
      async apply(data, timestamp) {
        const index = data.workerEffectReceipts.findIndex(
          (record) => record.workspaceId === input.workspaceId && record.id === receipt.id,
        );
        const current = index >= 0 ? data.workerEffectReceipts[index] : undefined;
        if (!current || current.result?.kind !== "inline_redacted") return "skipped";
        const eventId = input.id();
        appendTombstone(
          data,
          runContext(run),
          {
            eventId,
            category: "tool_payload",
            resourceKind: "effect_result",
            resourceIds: [receipt.id],
            contentDigest: current.result.digest,
          },
          timestamp,
        );
        const tombstoneContent: Omit<WorkerEffectRetentionTombstone, "digest"> = {
          kind: "retention_tombstone",
          status: current.result.status,
          durationMs: current.result.durationMs,
          startedAt: current.result.startedAt,
          completedAt: current.result.completedAt,
          originalDigest: current.result.digest,
          deletedAt: timestamp,
          tombstoneEventId: eventId,
        };
        data.workerEffectReceipts[index] = {
          ...current,
          result: {
            ...tombstoneContent,
            digest: digest(tombstoneContent),
          },
        };
        return "deleted";
      },
    });
  }

  for (const manifest of input.data.workerArtifactManifests) {
    if (manifest.workspaceId !== input.workspaceId) continue;
    input.categories.artifact.scanned += 1;
    const eligibleAt = Math.min(
      manifest.expiresAt ? Date.parse(manifest.expiresAt) : Number.POSITIVE_INFINITY,
      Date.parse(manifest.createdAt) + input.policy.artifactDays * DAY_MS,
    );
    if (
      eligibleAt > input.executionTime.getTime() ||
      hasTombstone(input.data, input.workspaceId, "artifact", "artifact_bytes", [manifest.id])
    ) {
      continue;
    }
    input.categories.artifact.eligible += 1;
    candidates.push({
      key: `artifact:${manifest.id}`,
      eligibleAt,
      category: "artifact",
      async apply(data, timestamp) {
        if (!input.artifactPort) return "skipped";
        if (hasTombstone(data, input.workspaceId, "artifact", "artifact_bytes", [manifest.id])) {
          return "skipped";
        }
        await input.artifactPort.delete({
          workspaceId: input.workspaceId,
          manifestId: manifest.id,
          reference: manifest.artifact.reference,
          expectedDigest: manifest.artifact.contentDigest,
        });
        appendTombstone(
          data,
          manifest,
          {
            eventId: input.id(),
            category: "artifact",
            resourceKind: "artifact_bytes",
            resourceIds: [manifest.id],
            contentDigest: manifest.artifact.contentDigest,
          },
          timestamp,
        );
        return "deleted";
      },
    });
  }

  buildEventCandidates(input, candidates);
  return candidates;
}

function buildEventCandidates(input: BuildCandidateInput, candidates: RetentionCandidate[]): void {
  const nowMs = input.executionTime.getTime();
  const summaryMs = input.policy.summaryDays * DAY_MS;
  const metadataMs = input.policy.metadataDays * DAY_MS;
  for (const event of input.data.workerEvents) {
    if (event.workspaceId !== input.workspaceId) continue;
    if (event.type.startsWith("worker.retention.")) {
      if (event.type !== "worker.retention.summary_deleted") continue;
      input.categories.metadata.scanned += 1;
      const originalOccurredAt =
        typeof event.data?.originalOccurredAt === "string"
          ? event.data.originalOccurredAt
          : event.occurredAt;
      const eligibleAt = Date.parse(originalOccurredAt) + metadataMs;
      if (eligibleAt > nowMs) continue;
      input.categories.metadata.eligible += 1;
      candidates.push(eventCandidate(input, event, "metadata", eligibleAt));
      continue;
    }

    input.categories.summary.scanned += 1;
    input.categories.metadata.scanned += 1;
    const occurredAt = Date.parse(event.occurredAt);
    const summaryEligibleAt = occurredAt + summaryMs;
    const metadataEligibleAt = occurredAt + metadataMs;
    const category = metadataEligibleAt <= summaryEligibleAt ? "metadata" : "summary";
    const eligibleAt = Math.min(summaryEligibleAt, metadataEligibleAt);
    if (eligibleAt > nowMs) continue;
    input.categories[category].eligible += 1;
    candidates.push(eventCandidate(input, event, category, eligibleAt));
  }
}

function eventCandidate(
  input: BuildCandidateInput,
  event: WorkerEvent,
  category: "metadata" | "summary",
  eligibleAt: number,
): RetentionCandidate {
  return {
    key: `${category}:event:${event.id}`,
    eligibleAt,
    category,
    async apply(data, timestamp) {
      const eventIndex = data.workerEvents.findIndex(
        (record) => record.workspaceId === input.workspaceId && record.id === event.id,
      );
      if (eventIndex < 0) return "skipped";
      const current = data.workerEvents[eventIndex];
      if (
        data.workerNotificationDeliveries.some(
          (delivery) =>
            delivery.schemaVersion === WORKER_NOTIFICATION_OUTBOX_SCHEMA_VERSION &&
            delivery.sourceEventId === current.id &&
            ["queued", "sending", "failed"].includes(delivery.status),
        )
      ) {
        return "skipped";
      }
      const evidence = isWorkerEventV2(current)
        ? data.workerEvidenceEntries.find(
            (record) =>
              record.workspaceId === input.workspaceId && record.id === current.evidenceId,
          )
        : undefined;
      if (
        evidence &&
        (evidence.artifactManifestIds?.length ||
          data.workerArtifactManifests.some(
            (manifest) =>
              manifest.workspaceId === input.workspaceId &&
              manifest.provenance.sourceEvidenceIds.includes(evidence.id),
          ))
      ) {
        return "skipped";
      }
      const context = eventContext(data, current);
      if (!context) return "skipped";
      const originalOccurredAt =
        current.type === "worker.retention.summary_deleted" &&
        typeof current.data?.originalOccurredAt === "string"
          ? current.data.originalOccurredAt
          : current.occurredAt;
      appendTombstone(
        data,
        context,
        {
          eventId: input.id(),
          category,
          resourceKind: "worker_event",
          resourceIds: [current.id],
          contentDigest: isWorkerEventV2(current) ? current.eventDigest : undefined,
          ...(category === "summary" ? { originalOccurredAt } : {}),
        },
        timestamp,
      );
      data.workerEvents.splice(eventIndex, 1);
      if (evidence) {
        const evidenceIndex = data.workerEvidenceEntries.findIndex(
          (record) => record.workspaceId === input.workspaceId && record.id === evidence.id,
        );
        if (evidenceIndex >= 0) data.workerEvidenceEntries.splice(evidenceIndex, 1);
      }
      return "deleted";
    },
  };
}

function appendTombstone(
  data: PacketAgentData,
  context: TombstoneContext,
  input: TombstoneInput,
  timestamp: string,
): void {
  const resourceIdDigests = input.resourceIds.map(resourceIdDigest).sort();
  appendWorkerJournalEntry(data, {
    id: input.eventId,
    workspaceId: context.workspaceId,
    type: `worker.retention.${input.category}_deleted`,
    source: "retention",
    workerDefinitionId: context.workerDefinitionId,
    ...(context.workerVersionId ? { workerVersionId: context.workerVersionId } : {}),
    ...(context.workerDeploymentId ? { workerDeploymentId: context.workerDeploymentId } : {}),
    ...(context.workerRunId ? { workerRunId: context.workerRunId } : {}),
    actor: RETENTION_ACTOR,
    summary: `Worker retention removed expired ${input.category} data.`,
    data: {
      category: input.category,
      resourceKind: input.resourceKind,
      resourceIdDigests,
      ...(input.contentDigest ? { contentDigest: input.contentDigest } : {}),
      ...(input.recordCount !== undefined ? { recordCount: input.recordCount } : {}),
      ...(input.originalOccurredAt ? { originalOccurredAt: input.originalOccurredAt } : {}),
      deletedAt: timestamp,
    } as JsonObject,
    dataClassification: "public_metadata",
    occurredAt: timestamp,
  });
}

function eventContext(data: PacketAgentData, event: WorkerEvent): TombstoneContext | undefined {
  if (
    !data.workerDefinitions.some(
      (record) =>
        record.workspaceId === event.workspaceId && record.id === event.workerDefinitionId,
    )
  ) {
    return undefined;
  }
  return {
    workspaceId: event.workspaceId,
    workerDefinitionId: event.workerDefinitionId,
    ...(event.workerVersionId ? { workerVersionId: event.workerVersionId } : {}),
    ...(event.workerDeploymentId ? { workerDeploymentId: event.workerDeploymentId } : {}),
    ...(isWorkerEventV2(event) && event.workerRunId ? { workerRunId: event.workerRunId } : {}),
  };
}

function hasTombstone(
  data: PacketAgentData,
  workspaceId: string,
  category: WorkerRetentionCategory,
  resourceKind: WorkerRetentionResourceKind,
  resourceIds: readonly string[],
): boolean {
  const digests = resourceIds.map(resourceIdDigest).sort();
  return data.workerEvents.some(
    (event) =>
      event.workspaceId === workspaceId &&
      event.type === `worker.retention.${category}_deleted` &&
      event.data?.resourceKind === resourceKind &&
      Array.isArray(event.data.resourceIdDigests) &&
      canonicalWorkerJson(event.data.resourceIdDigests) === canonicalWorkerJson(digests),
  );
}

function findRun(data: PacketAgentData, workspaceId: string, runId: string): WorkerRun | undefined {
  return data.workerRuns.find(
    (record) => record.workspaceId === workspaceId && record.id === runId,
  );
}

function findRunIndex(data: PacketAgentData, workspaceId: string, runId: string): number {
  return data.workerRuns.findIndex(
    (record) => record.workspaceId === workspaceId && record.id === runId,
  );
}

function isTerminal(run: WorkerRun): boolean {
  return TERMINAL_RUN_STATUSES.has(run.status);
}

function runContext(run: WorkerRun): TombstoneContext {
  return {
    workspaceId: run.workspaceId,
    workerDefinitionId: run.workerDefinitionId,
    workerVersionId: run.workerVersionId,
    workerDeploymentId: run.workerDeploymentId,
    workerRunId: run.id,
  };
}

function resourceIdDigest(value: string): string {
  return digest({ resourceId: value });
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalWorkerJson(value)).digest("hex")}`;
}

function emptyMetrics(): Record<WorkerRetentionCategory, MutableCategoryMetrics> {
  return {
    metadata: metric(),
    summary: metric(),
    prompt: metric(),
    tool_payload: metric(),
    artifact: metric(),
  };
}

function metric(): MutableCategoryMetrics {
  return { scanned: 0, eligible: 0, deleted: 0, skipped: 0, failed: 0 };
}

function cloneMetrics(
  metrics: Record<WorkerRetentionCategory, MutableCategoryMetrics>,
): Record<WorkerRetentionCategory, WorkerRetentionCategoryMetrics> {
  return structuredClone(metrics);
}

function compareCandidates(left: RetentionCandidate, right: RetentionCandidate): number {
  const eligible = left.eligibleAt - right.eligibleAt;
  return eligible !== 0 ? eligible : left.key.localeCompare(right.key);
}

function assertCleanupInput(input: WorkerRetentionCleanupInput): void {
  if (!input.workspaceId.trim()) {
    throw new Error("Worker retention cleanup requires an explicit workspaceId.");
  }
  assertWorkerRetentionPolicy(input.policy);
  assertBoundedInteger(input.maxItems, "maxItems", DEFAULT_MAX_ITEMS, MAX_ITEMS);
  assertBoundedInteger(
    input.maxDurationMs,
    "maxDurationMs",
    DEFAULT_MAX_DURATION_MS,
    MAX_DURATION_MS,
  );
  if (input.dryRun !== undefined && typeof input.dryRun !== "boolean") {
    throw new Error("Worker retention dryRun must be a boolean.");
  }
}

function assertBoundedInteger(
  value: number | undefined,
  label: string,
  fallback: number,
  maximum: number,
): void {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`Worker retention ${label} must be an integer from 1 to ${maximum}.`);
  }
}
