import { createHash, randomUUID } from "node:crypto";
import {
  loadStoreAsync as defaultLoadStore,
  mutateStoreAsync as defaultMutateStore,
  type PacketAgentData,
} from "../packetagent-store.js";
import { redactSensitiveString, redactSensitiveValue } from "../security/redaction.js";
import { WorkerLifecycleError } from "./errors.js";
import {
  WORKER_EFFECT_RECEIPT_SCHEMA_VERSION,
  type WorkerEffectReceipt,
  type WorkerEffectResultReference,
  type WorkerToolEffectClassification,
} from "./effect-types.js";
import { WORKER_EVENT_SCHEMA_VERSION, type WorkerEvent } from "./persistence-types.js";
import { validateWorkerPersistence } from "./repository.js";
import type { JsonValue, WorkerRun } from "./types.js";
import { canonicalWorkerJson } from "./validation.js";
import type { WorkerRuntimeToolCall, WorkerRuntimeToolResult } from "./runtime/ports.js";

type MaybePromise<T> = T | Promise<T>;

const RUNTIME_ACTOR = {
  type: "system" as const,
  id: "packetagent.worker-effect-coordinator",
  displayName: "PacketAgent Worker Effect Coordinator",
};

export type WorkerEffectCommitPhase = "after_prepare" | "after_external_effect" | "after_complete";

export class WorkerUnsafeReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerUnsafeReplayError";
  }
}

export class WorkerEffectInterruptionError extends Error {
  constructor(readonly phase: WorkerEffectCommitPhase) {
    super(`Injected Worker effect interruption after ${phase}.`);
    this.name = "WorkerEffectInterruptionError";
  }
}

export interface WorkerEffectRepositoryDependencies {
  readonly loadStore?: () => MaybePromise<PacketAgentData>;
  readonly mutateStore?: <T>(
    mutator: (data: PacketAgentData) => MaybePromise<T>,
  ) => MaybePromise<T>;
  readonly id?: (kind: "effect_receipt" | "event") => string;
  readonly now?: () => Date;
}

export interface WorkerEffectPrepareInput {
  readonly workspaceId: string;
  readonly workerRunId: string;
  readonly workerVersionId: string;
  readonly workerDeploymentId: string;
  readonly fencingToken: number;
  readonly iteration: number;
  readonly actionId: string;
  readonly capabilityId: string;
  readonly toolName: string;
  readonly operation: string;
  readonly inputDigest: string;
  readonly effectKey: string;
  readonly classification: Exclude<WorkerToolEffectClassification, "read_only">;
}

export type WorkerEffectPreparation =
  | {
      readonly disposition: "prepared";
      readonly receipt: WorkerEffectReceipt;
    }
  | {
      readonly disposition: "existing_prepared";
      readonly receipt: WorkerEffectReceipt;
    }
  | {
      readonly disposition: "completed";
      readonly receipt: WorkerEffectReceipt;
    };

export interface WorkerEffectRepository {
  prepare(input: WorkerEffectPrepareInput): Promise<WorkerEffectPreparation>;
  complete(input: {
    readonly workspaceId: string;
    readonly workerRunId: string;
    readonly fencingToken: number;
    readonly effectKey: string;
    readonly result: WorkerRuntimeToolResult;
  }): Promise<WorkerEffectReceipt>;
  listForRun(workspaceId: string, workerRunId: string): Promise<readonly WorkerEffectReceipt[]>;
}

export function createWorkerEffectRepository(
  dependencies: WorkerEffectRepositoryDependencies = {},
): WorkerEffectRepository {
  const loadStore = dependencies.loadStore ?? defaultLoadStore;
  const mutateStore = dependencies.mutateStore ?? defaultMutateStore;
  const id = dependencies.id ?? ((kind: "effect_receipt" | "event") => `${kind}_${randomUUID()}`);
  const now = dependencies.now ?? (() => new Date());

  return {
    async prepare(input) {
      return await mutateStore((data) => {
        validateWorkerPersistence(data);
        const run = requireFencedRun(
          data,
          input.workspaceId,
          input.workerRunId,
          input.fencingToken,
          now(),
        );
        assertEffectRunIdentity(run, input);
        const existingByAction = data.workerEffectReceipts.find(
          (receipt) =>
            receipt.workspaceId === input.workspaceId &&
            receipt.workerRunId === input.workerRunId &&
            receipt.iteration === input.iteration &&
            receipt.actionId === input.actionId,
        );
        if (existingByAction) {
          assertMatchingEffect(existingByAction, input);
          return {
            disposition:
              existingByAction.status === "completed"
                ? ("completed" as const)
                : ("existing_prepared" as const),
            receipt: clone(existingByAction),
          };
        }
        const existingKey = data.workerEffectReceipts.find(
          (receipt) =>
            receipt.workspaceId === input.workspaceId && receipt.effectKey === input.effectKey,
        );
        if (existingKey) {
          throw new WorkerLifecycleError(
            "idempotency_mismatch",
            "Worker effect key already identifies a different action.",
          );
        }
        const preparedAt = now().toISOString();
        const receipt: WorkerEffectReceipt = {
          schemaVersion: WORKER_EFFECT_RECEIPT_SCHEMA_VERSION,
          id: id("effect_receipt"),
          workspaceId: input.workspaceId,
          workerRunId: input.workerRunId,
          workerVersionId: input.workerVersionId,
          workerDeploymentId: input.workerDeploymentId,
          effectKey: input.effectKey,
          iteration: input.iteration,
          actionId: input.actionId,
          capabilityId: input.capabilityId,
          toolName: input.toolName,
          operation: redactSensitiveString(input.operation),
          inputDigest: input.inputDigest,
          classification: input.classification,
          status: "prepared",
          preparedAt,
        };
        data.workerEffectReceipts.push(receipt);
        appendEffectEvent(data, id("event"), run, {
          type: "worker.effect.prepared",
          summary: `Worker tool effect prepared for ${receipt.toolName}.`,
          data: {
            workerRunId: run.id,
            effectReceiptId: receipt.id,
            effectKey: receipt.effectKey,
            actionId: receipt.actionId,
            capabilityId: receipt.capabilityId,
            tool: receipt.toolName,
            operation: receipt.operation,
            classification: receipt.classification,
          },
          occurredAt: preparedAt,
        });
        validateWorkerPersistence(data);
        return {
          disposition: "prepared" as const,
          receipt: clone(receipt),
        };
      });
    },

    async complete(input) {
      return await mutateStore((data) => {
        validateWorkerPersistence(data);
        const run = requireFencedRun(
          data,
          input.workspaceId,
          input.workerRunId,
          input.fencingToken,
          now(),
        );
        const index = data.workerEffectReceipts.findIndex(
          (receipt) =>
            receipt.workspaceId === input.workspaceId &&
            receipt.workerRunId === input.workerRunId &&
            receipt.effectKey === input.effectKey,
        );
        if (index < 0) {
          throw new WorkerLifecycleError(
            "not_found",
            "Prepared Worker effect receipt was not found.",
          );
        }
        const current = data.workerEffectReceipts[index];
        if (current.status === "completed") {
          assertWorkerEffectResultDigest(current);
          return clone(current);
        }
        const completedAt = now().toISOString();
        const completed: WorkerEffectReceipt = {
          ...current,
          status: "completed",
          completedAt,
          result: effectResultReference(input.result),
        };
        data.workerEffectReceipts[index] = completed;
        appendEffectEvent(data, id("event"), run, {
          type: "worker.effect.completed",
          summary: `Worker tool effect completed for ${completed.toolName}.`,
          data: {
            workerRunId: run.id,
            effectReceiptId: completed.id,
            effectKey: completed.effectKey,
            actionId: completed.actionId,
            capabilityId: completed.capabilityId,
            tool: completed.toolName,
            operation: completed.operation,
            status: input.result.status,
          },
          occurredAt: completedAt,
        });
        validateWorkerPersistence(data);
        return clone(completed);
      });
    },

    async listForRun(workspaceId, workerRunId) {
      const data = await loadStore();
      validateWorkerPersistence(data);
      return data.workerEffectReceipts
        .filter(
          (receipt) => receipt.workspaceId === workspaceId && receipt.workerRunId === workerRunId,
        )
        .sort((left, right) => left.preparedAt.localeCompare(right.preparedAt))
        .map(clone);
    },
  };
}

export interface WorkerEffectCoordinatorDependencies {
  readonly repository?: WorkerEffectRepository;
  readonly onPhase?: (
    phase: WorkerEffectCommitPhase,
    receipt: WorkerEffectReceipt,
  ) => MaybePromise<void>;
}

export interface WorkerEffectExecutionInput {
  readonly workspaceId: string;
  readonly workerRunId: string;
  readonly workerVersionId: string;
  readonly workerDeploymentId: string;
  readonly fencingToken: number;
  readonly iteration: number;
  readonly capabilityId: string;
  readonly call: WorkerRuntimeToolCall;
  readonly classification: WorkerToolEffectClassification;
  readonly operation: string;
  readonly execute: (effectKey?: string) => Promise<WorkerRuntimeToolResult>;
  readonly reconcile?: (effectKey: string) => Promise<
    | { readonly disposition: "absent" }
    | {
        readonly disposition: "completed";
        readonly result: WorkerRuntimeToolResult;
      }
    | { readonly disposition: "uncertain"; readonly reason: string }
  >;
}

export interface WorkerEffectCoordinator {
  execute(input: WorkerEffectExecutionInput): Promise<WorkerRuntimeToolResult>;
}

export function createWorkerEffectCoordinator(
  dependencies: WorkerEffectCoordinatorDependencies = {},
): WorkerEffectCoordinator {
  const repository = dependencies.repository ?? createWorkerEffectRepository();
  const onPhase = dependencies.onPhase ?? (() => undefined);

  return {
    async execute(input) {
      if (input.classification === "read_only") {
        return await input.execute();
      }
      const operation = redactSensitiveString(input.operation);
      const { inputDigest, effectKey } = workerEffectIdentity({
        workerRunId: input.workerRunId,
        iteration: input.iteration,
        actionId: input.call.id,
        capabilityId: input.capabilityId,
        toolName: input.call.name,
        operation,
        toolInput: input.call.input,
      });
      const preparation = await repository.prepare({
        workspaceId: input.workspaceId,
        workerRunId: input.workerRunId,
        workerVersionId: input.workerVersionId,
        workerDeploymentId: input.workerDeploymentId,
        fencingToken: input.fencingToken,
        iteration: input.iteration,
        actionId: input.call.id,
        capabilityId: input.capabilityId,
        toolName: input.call.name,
        operation,
        inputDigest,
        effectKey,
        classification: input.classification,
      });
      if (preparation.disposition === "completed") {
        return resultFromReceipt(preparation.receipt);
      }
      await onPhase("after_prepare", preparation.receipt);

      let result: WorkerRuntimeToolResult;
      if (preparation.disposition === "existing_prepared") {
        if (preparation.receipt.classification === "non_replayable_mutation") {
          throw new WorkerUnsafeReplayError(
            `Worker effect ${preparation.receipt.id} may have occurred and cannot be replayed safely.`,
          );
        }
        if (preparation.receipt.classification === "reconcilable_mutation") {
          if (!input.reconcile) {
            throw new WorkerUnsafeReplayError(
              `Worker effect ${preparation.receipt.id} requires reconciliation, but the tool provides none.`,
            );
          }
          const reconciliation = await input.reconcile(effectKey);
          if (reconciliation.disposition === "uncertain") {
            throw new WorkerUnsafeReplayError(
              `Worker effect ${preparation.receipt.id} could not be reconciled: ${redactSensitiveString(
                reconciliation.reason,
              )}`,
            );
          }
          if (reconciliation.disposition === "completed") {
            result = reconciliation.result;
          } else {
            result = await input.execute(effectKey);
            await onPhase("after_external_effect", preparation.receipt);
          }
        } else {
          result = await input.execute(effectKey);
          await onPhase("after_external_effect", preparation.receipt);
        }
      } else {
        result = await input.execute(effectKey);
        await onPhase("after_external_effect", preparation.receipt);
      }

      const receipt = await repository.complete({
        workspaceId: input.workspaceId,
        workerRunId: input.workerRunId,
        fencingToken: input.fencingToken,
        effectKey,
        result,
      });
      await onPhase("after_complete", receipt);
      return resultFromReceipt(receipt);
    },
  };
}

export function workerEffectIdentity(input: {
  readonly workerRunId: string;
  readonly iteration: number;
  readonly actionId: string;
  readonly capabilityId: string;
  readonly toolName: string;
  readonly operation: string;
  readonly toolInput: unknown;
}): { readonly inputDigest: string; readonly effectKey: string } {
  const inputDigest = digest(input.toolInput);
  return {
    inputDigest,
    effectKey: digest({
      workerRunId: input.workerRunId,
      iteration: input.iteration,
      actionId: input.actionId,
      capabilityId: input.capabilityId,
      toolName: input.toolName,
      operation: redactSensitiveString(input.operation),
      inputDigest,
    }),
  };
}

function effectResultReference(result: WorkerRuntimeToolResult): WorkerEffectResultReference {
  const content: Omit<WorkerEffectResultReference, "digest"> = {
    kind: "inline_redacted",
    status: result.status,
    ...(result.output !== undefined
      ? { output: asJsonValue(redactSensitiveValue(result.output)) }
      : {}),
    ...(result.error ? { error: redactSensitiveString(result.error) } : {}),
    ...(result.artifactRefs ? { artifactRefs: [...result.artifactRefs] } : {}),
    durationMs: result.durationMs,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
  };
  return {
    ...content,
    digest: digest(content),
  };
}

function resultFromReceipt(receipt: WorkerEffectReceipt): WorkerRuntimeToolResult {
  assertWorkerEffectResultDigest(receipt);
  const result = receipt.result;
  if (!result) {
    throw new WorkerUnsafeReplayError(
      `Completed Worker effect ${receipt.id} is missing its result.`,
    );
  }
  return {
    callId: receipt.actionId,
    toolName: receipt.toolName,
    status: result.status,
    ...(result.output !== undefined ? { output: result.output } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.artifactRefs ? { artifactRefs: [...result.artifactRefs] } : {}),
    effectReceiptId: receipt.id,
    durationMs: result.durationMs,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
  };
}

export function assertWorkerEffectResultDigest(receipt: WorkerEffectReceipt): void {
  if (receipt.status !== "completed" || !receipt.result) {
    throw new WorkerUnsafeReplayError(`Worker effect ${receipt.id} has no completed result.`);
  }
  const { digest: _digest, ...content } = receipt.result;
  if (digest(content) !== receipt.result.digest) {
    throw new WorkerUnsafeReplayError(
      `Worker effect ${receipt.id} result digest does not match its contents.`,
    );
  }
}

function assertMatchingEffect(receipt: WorkerEffectReceipt, input: WorkerEffectPrepareInput): void {
  for (const [label, actual, expected] of [
    ["effectKey", receipt.effectKey, input.effectKey],
    ["workerVersionId", receipt.workerVersionId, input.workerVersionId],
    ["workerDeploymentId", receipt.workerDeploymentId, input.workerDeploymentId],
    ["capabilityId", receipt.capabilityId, input.capabilityId],
    ["toolName", receipt.toolName, input.toolName],
    ["operation", receipt.operation, redactSensitiveString(input.operation)],
    ["inputDigest", receipt.inputDigest, input.inputDigest],
    ["classification", receipt.classification, input.classification],
  ]) {
    if (actual !== expected) {
      throw new WorkerLifecycleError(
        "idempotency_mismatch",
        `Worker effect action was replayed with a different ${label}.`,
      );
    }
  }
}

function assertEffectRunIdentity(run: WorkerRun, input: WorkerEffectPrepareInput): void {
  if (
    run.workerVersionId !== input.workerVersionId ||
    run.workerDeploymentId !== input.workerDeploymentId
  ) {
    throw new WorkerLifecycleError(
      "integrity",
      "Worker effect attempted to change the run's pinned version or deployment.",
    );
  }
}

function requireFencedRun(
  data: PacketAgentData,
  workspaceId: string,
  workerRunId: string,
  fencingToken: number,
  now: Date,
): WorkerRun {
  const run = data.workerRuns.find(
    (record) => record.workspaceId === workspaceId && record.id === workerRunId,
  );
  if (!run) {
    throw new WorkerLifecycleError("not_found", `WorkerRun ${workerRunId} was not found.`);
  }
  if (
    !run.runtimeLease ||
    run.runtimeLease.fencingToken !== fencingToken ||
    Date.parse(run.runtimeLease.expiresAt) <= now.getTime()
  ) {
    throw new WorkerLifecycleError("conflict", `WorkerRun ${run.id} execution lease was lost.`);
  }
  return run;
}

function appendEffectEvent(
  data: PacketAgentData,
  eventId: string,
  run: WorkerRun,
  input: Pick<WorkerEvent, "type" | "summary" | "data" | "occurredAt">,
): void {
  const sequence =
    data.workerEvents
      .filter((record) => record.workspaceId === run.workspaceId)
      .reduce((maximum, record) => Math.max(maximum, record.sequence), 0) + 1;
  data.workerEvents.push({
    schemaVersion: WORKER_EVENT_SCHEMA_VERSION,
    id: eventId,
    workspaceId: run.workspaceId,
    sequence,
    type: input.type,
    workerDefinitionId: run.workerDefinitionId,
    workerVersionId: run.workerVersionId,
    workerDeploymentId: run.workerDeploymentId,
    actor: RUNTIME_ACTOR,
    summary: input.summary,
    ...(input.data ? { data: input.data } : {}),
    occurredAt: input.occurredAt,
  });
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalWorkerJson(value)).digest("hex")}`;
}

function asJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  return value as JsonValue;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
