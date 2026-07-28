import type { JsonValue } from "./types.js";

export const WORKER_EFFECT_RECEIPT_SCHEMA_VERSION = "packetagent.worker-effect-receipt/v1" as const;

export type WorkerToolEffectClassification =
  | "read_only"
  | "idempotent_mutation"
  | "reconcilable_mutation"
  | "non_replayable_mutation";

export type WorkerEffectReceiptStatus = "prepared" | "completed";

export interface WorkerEffectRetainedResultReference {
  readonly kind: "inline_redacted";
  readonly status: "ok" | "error" | "timeout";
  readonly output?: JsonValue;
  readonly error?: string;
  readonly artifactRefs?: readonly string[];
  readonly durationMs: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly digest: string;
}

export interface WorkerEffectRetentionTombstone {
  readonly kind: "retention_tombstone";
  readonly status: "ok" | "error" | "timeout";
  readonly durationMs: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly originalDigest: string;
  readonly deletedAt: string;
  readonly tombstoneEventId: string;
  readonly digest: string;
}

export type WorkerEffectResultReference =
  | WorkerEffectRetainedResultReference
  | WorkerEffectRetentionTombstone;

export interface WorkerEffectReceipt {
  readonly schemaVersion: typeof WORKER_EFFECT_RECEIPT_SCHEMA_VERSION;
  readonly id: string;
  readonly workspaceId: string;
  readonly workerRunId: string;
  readonly workerVersionId: string;
  readonly workerDeploymentId: string;
  readonly effectKey: string;
  readonly iteration: number;
  readonly actionId: string;
  readonly capabilityId: string;
  readonly toolName: string;
  readonly operation: string;
  readonly inputDigest: string;
  readonly classification: Exclude<WorkerToolEffectClassification, "read_only">;
  readonly status: WorkerEffectReceiptStatus;
  readonly preparedAt: string;
  readonly completedAt?: string;
  readonly result?: WorkerEffectResultReference;
}
