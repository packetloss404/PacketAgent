import { createHash } from "node:crypto";
import { redactSensitiveValue } from "../../security/redaction.js";
import { canonicalWorkerJson } from "../validation.js";
import type {
  JsonObject,
  JsonValue,
  WorkerBudgetUsage,
  WorkerCheckpoint,
  WorkerRemainingBudget,
} from "../types.js";
import type {
  WorkerEvaluationRecord,
  WorkerRuntimeToolCall,
  WorkerRuntimeToolResult,
  WorkerSupervisorLimits,
} from "./ports.js";
import type { WorkerSupervisorState } from "./reducer.js";

export const WORKER_MEMORY_SCHEMA_VERSION = "packetagent.worker-memory/v1";

export class WorkerCheckpointRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerCheckpointRecoveryError";
  }
}

export function snapshotWorkerSupervisorState(state: WorkerSupervisorState): JsonObject {
  const memory: JsonObject = {
    schemaVersion: WORKER_MEMORY_SCHEMA_VERSION,
    iterationOpen: state.iterationOpen,
    pendingTools: state.pendingTools.map((call) => ({
      id: call.id,
      name: call.name,
      input: asJsonObject(redactSensitiveValue(call.input)),
    })),
    toolResults: state.toolResults.map((result) => ({
      callId: result.callId,
      toolName: result.toolName,
      status: result.status,
      ...(result.output !== undefined
        ? { output: asJsonValue(redactSensitiveValue(result.output)) }
        : {}),
      ...(result.error ? { error: redactedString(result.error) } : {}),
      ...(result.artifactRefs ? { artifactRefs: [...result.artifactRefs] } : {}),
      durationMs: result.durationMs,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
    })),
    candidateOutputPresent: state.candidateOutput !== undefined,
    ...(state.candidateOutput !== undefined
      ? { candidateOutput: asJsonValue(redactSensitiveValue(state.candidateOutput)) }
      : {}),
    ...(state.evaluation
      ? {
          evaluation: {
            ...state.evaluation,
            evidence: redactedString(state.evaluation.evidence),
          },
        }
      : {}),
    ...(state.lastError ? { lastError: redactedString(state.lastError) } : {}),
  };
  return memory;
}

export function restoreWorkerSupervisorState(
  checkpoint: WorkerCheckpoint,
  usage: WorkerBudgetUsage,
  limits: WorkerSupervisorLimits,
): WorkerSupervisorState {
  assertCheckpointBudget(checkpoint, usage, limits);
  const memory = checkpoint.workingMemory as Record<string, unknown>;
  if (memory.schemaVersion !== WORKER_MEMORY_SCHEMA_VERSION) {
    throw new WorkerCheckpointRecoveryError(
      `Checkpoint ${checkpoint.id} has an unsupported working-memory schema.`,
    );
  }
  if (typeof memory.iterationOpen !== "boolean") {
    throw new WorkerCheckpointRecoveryError(
      `Checkpoint ${checkpoint.id} is missing its iteration state.`,
    );
  }
  const pendingTools = parseToolCalls(memory.pendingTools, checkpoint.id);
  const toolResults = parseToolResults(memory.toolResults, checkpoint.id);
  const evaluation =
    memory.evaluation === undefined ? undefined : parseEvaluation(memory.evaluation, checkpoint.id);
  const candidateOutput =
    memory.candidateOutputPresent === true ? asJsonValue(memory.candidateOutput) : undefined;
  if (memory.candidateOutputPresent !== true && memory.candidateOutputPresent !== false) {
    throw new WorkerCheckpointRecoveryError(
      `Checkpoint ${checkpoint.id} has an invalid candidate-output marker.`,
    );
  }
  if (checkpoint.cursor.phase === "act" && !pendingTools[checkpoint.cursor.actionIndex]) {
    throw new WorkerCheckpointRecoveryError(
      `Checkpoint ${checkpoint.id} has an impossible action cursor.`,
    );
  }
  if (
    (checkpoint.cursor.phase === "evaluate" ||
      checkpoint.cursor.phase === "checkpoint" ||
      checkpoint.cursor.phase === "decide") &&
    checkpoint.cursor.actionIndex > pendingTools.length
  ) {
    throw new WorkerCheckpointRecoveryError(
      `Checkpoint ${checkpoint.id} advances beyond its planned actions.`,
    );
  }
  if (checkpoint.cursor.phase === "decide" && !evaluation) {
    throw new WorkerCheckpointRecoveryError(
      `Checkpoint ${checkpoint.id} cannot decide without an evaluation.`,
    );
  }

  return {
    phase: checkpoint.cursor.phase,
    iterationOpen: memory.iterationOpen,
    cursor: checkpoint.cursor,
    usage,
    limits,
    pendingTools,
    toolResults,
    completedActionIds: [...checkpoint.completedActionIds],
    pendingApprovalIds: [...checkpoint.pendingApprovalIds],
    artifactRefs: [...checkpoint.artifactRefs],
    effectReceiptIds: [...checkpoint.effectReceiptIds],
    ...(candidateOutput !== undefined ? { candidateOutput } : {}),
    ...(evaluation ? { evaluation } : {}),
    ...(typeof memory.lastError === "string" ? { lastError: memory.lastError } : {}),
  };
}

export function remainingWorkerBudget(
  limits: WorkerSupervisorLimits,
  usage: WorkerBudgetUsage,
): WorkerRemainingBudget {
  return {
    elapsedMs: Math.max(0, limits.maxElapsedMs - usage.elapsedMs),
    iterations: Math.max(0, limits.maxIterations - usage.iterations),
    providerCostUsd: Math.max(0, limits.maxProviderCostUsd - usage.providerCostUsd),
    consecutiveFailures: Math.max(0, limits.maxConsecutiveFailures - usage.consecutiveFailures),
    toolCalls: Math.max(0, limits.maxToolCalls - usage.toolCalls),
  };
}

export function workerCheckpointStateDigest(
  checkpoint: Omit<WorkerCheckpoint, "stateDigest"> | WorkerCheckpoint,
): string {
  const { stateDigest: _stateDigest, ...content } = checkpoint as WorkerCheckpoint;
  return `sha256:${createHash("sha256").update(canonicalWorkerJson(content)).digest("hex")}`;
}

export function assertCheckpointDigest(checkpoint: WorkerCheckpoint): void {
  if (workerCheckpointStateDigest(checkpoint) !== checkpoint.stateDigest) {
    throw new WorkerCheckpointRecoveryError(
      `Checkpoint ${checkpoint.id} state digest does not match its contents.`,
    );
  }
}

function assertCheckpointBudget(
  checkpoint: WorkerCheckpoint,
  usage: WorkerBudgetUsage,
  limits: WorkerSupervisorLimits,
): void {
  const expected = remainingWorkerBudget(limits, usage);
  for (const key of Object.keys(expected) as Array<keyof WorkerRemainingBudget>) {
    if (Math.abs(expected[key] - checkpoint.remainingBudget[key]) > Number.EPSILON) {
      throw new WorkerCheckpointRecoveryError(
        `Checkpoint ${checkpoint.id} remaining ${key} does not match the run budget ledger.`,
      );
    }
  }
}

function parseToolCalls(value: unknown, checkpointId: string): WorkerRuntimeToolCall[] {
  if (!Array.isArray(value)) {
    throw new WorkerCheckpointRecoveryError(
      `Checkpoint ${checkpointId} has invalid pending tools.`,
    );
  }
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.name !== "string" ||
      !isRecord(entry.input)
    ) {
      throw new WorkerCheckpointRecoveryError(
        `Checkpoint ${checkpointId} contains an invalid pending tool.`,
      );
    }
    return {
      id: entry.id,
      name: entry.name,
      input: asJsonObject(entry.input),
    };
  });
}

function parseToolResults(value: unknown, checkpointId: string): WorkerRuntimeToolResult[] {
  if (!Array.isArray(value)) {
    throw new WorkerCheckpointRecoveryError(`Checkpoint ${checkpointId} has invalid tool results.`);
  }
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.callId !== "string" ||
      typeof entry.toolName !== "string" ||
      !["ok", "error", "timeout"].includes(String(entry.status)) ||
      typeof entry.durationMs !== "number" ||
      typeof entry.startedAt !== "string" ||
      typeof entry.completedAt !== "string"
    ) {
      throw new WorkerCheckpointRecoveryError(
        `Checkpoint ${checkpointId} contains an invalid tool result.`,
      );
    }
    const artifactRefs = Array.isArray(entry.artifactRefs)
      ? entry.artifactRefs.filter((item): item is string => typeof item === "string")
      : undefined;
    return {
      callId: entry.callId,
      toolName: entry.toolName,
      status: entry.status as WorkerRuntimeToolResult["status"],
      ...(entry.output !== undefined ? { output: asJsonValue(entry.output) } : {}),
      ...(typeof entry.error === "string" ? { error: entry.error } : {}),
      ...(artifactRefs ? { artifactRefs } : {}),
      durationMs: entry.durationMs,
      startedAt: entry.startedAt,
      completedAt: entry.completedAt,
    };
  });
}

function parseEvaluation(value: unknown, checkpointId: string): WorkerEvaluationRecord {
  if (
    !isRecord(value) ||
    typeof value.predicateId !== "string" ||
    ![
      "objective_satisfied",
      "output_matches",
      "acceptance_checks_pass",
      "manual_completion",
    ].includes(String(value.predicateKind)) ||
    typeof value.testedAtIteration !== "number" ||
    typeof value.evidence !== "string" ||
    typeof value.matched !== "boolean"
  ) {
    throw new WorkerCheckpointRecoveryError(
      `Checkpoint ${checkpointId} contains an invalid evaluation.`,
    );
  }
  return value as unknown as WorkerEvaluationRecord;
}

function asJsonObject(value: unknown): JsonObject {
  if (!isRecord(value)) return {};
  return value as JsonObject;
}

function asJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  return value as JsonValue;
}

function redactedString(value: string): string {
  const redacted = redactSensitiveValue(value);
  return typeof redacted === "string" ? redacted : "[redacted]";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
