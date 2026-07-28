import type {
  JsonValue,
  WorkerBudgetUsage,
  WorkerCheckpointCursor,
  WorkerExitPredicate,
  WorkerRunStatus,
  WorkerRunTerminalReason,
  WorkerSupervisorPhase,
} from "../types.js";
import type {
  WorkerEvaluationRecord,
  WorkerRuntimeProviderResult,
  WorkerRuntimeToolCall,
  WorkerRuntimeToolResult,
  WorkerSupervisorLimits,
} from "./ports.js";

export interface WorkerSupervisorTerminal {
  readonly status: Extract<
    WorkerRunStatus,
    "completed" | "failed" | "budget_exhausted" | "cancelled" | "quarantined"
  >;
  readonly reason: WorkerRunTerminalReason;
  readonly output?: JsonValue;
  readonly error?: string;
}

export interface WorkerSupervisorState {
  readonly phase: WorkerSupervisorPhase;
  readonly iterationOpen: boolean;
  readonly cursor: WorkerCheckpointCursor;
  readonly usage: WorkerBudgetUsage;
  readonly limits: WorkerSupervisorLimits;
  readonly pendingTools: readonly WorkerRuntimeToolCall[];
  readonly toolResults: readonly WorkerRuntimeToolResult[];
  readonly candidateOutput?: JsonValue;
  readonly evaluation?: WorkerEvaluationRecord;
  readonly lastError?: string;
  readonly terminal?: WorkerSupervisorTerminal;
}

export type WorkerSupervisorEvent =
  | { readonly type: "elapsed.observed"; readonly elapsedMs: number }
  | { readonly type: "iteration.begin" }
  | { readonly type: "provider.plan_succeeded"; readonly result: WorkerRuntimeProviderResult }
  | { readonly type: "provider.evaluation_charged"; readonly result: WorkerRuntimeProviderResult }
  | { readonly type: "tool.reserve" }
  | { readonly type: "tool.succeeded"; readonly result: WorkerRuntimeToolResult }
  | { readonly type: "phase.failed"; readonly error: string }
  | { readonly type: "evaluation.accepted"; readonly evaluation: WorkerEvaluationRecord }
  | { readonly type: "checkpoint.saved" }
  | { readonly type: "decide" }
  | {
      readonly type: "bound.reached";
      readonly reason: Extract<
        WorkerRunTerminalReason,
        "elapsed_time" | "iteration_limit" | "provider_cost" | "tool_call_limit"
      >;
    }
  | {
      readonly type: "cancelled";
      readonly reason: Extract<
        WorkerRunTerminalReason,
        "operator_cancelled" | "deployment_revoked" | "lease_lost"
      >;
    }
  | { readonly type: "quarantined"; readonly error: string };

export function initialWorkerSupervisorState(
  usage: WorkerBudgetUsage,
  limits: WorkerSupervisorLimits,
): WorkerSupervisorState {
  return {
    phase: "plan",
    iterationOpen: false,
    cursor: { phase: "plan", iteration: usage.iterations, actionIndex: 0 },
    usage,
    limits,
    pendingTools: [],
    toolResults: [],
  };
}

export function reduceWorkerSupervisor(
  state: WorkerSupervisorState,
  event: WorkerSupervisorEvent,
): WorkerSupervisorState {
  if (state.terminal) return state;

  switch (event.type) {
    case "elapsed.observed": {
      const next = {
        ...state,
        usage: {
          ...state.usage,
          elapsedMs: Math.max(state.usage.elapsedMs, Math.max(0, Math.floor(event.elapsedMs))),
        },
      };
      return next.usage.elapsedMs >= state.limits.maxElapsedMs
        ? terminal(next, "budget_exhausted", "elapsed_time")
        : next;
    }
    case "iteration.begin": {
      if (state.usage.iterations >= state.limits.maxIterations) {
        return terminal(state, "budget_exhausted", "iteration_limit");
      }
      const iteration = state.usage.iterations + 1;
      return {
        ...state,
        phase: "plan",
        iterationOpen: true,
        cursor: { phase: "plan", iteration, actionIndex: 0 },
        usage: { ...state.usage, iterations: iteration },
        pendingTools: [],
        toolResults: [],
        evaluation: undefined,
        lastError: undefined,
      };
    }
    case "provider.plan_succeeded": {
      const charged = chargeProvider(state, event.result.usage.costUsd);
      if (charged.terminal) return charged;
      const pendingTools = event.result.toolCalls;
      const phase = pendingTools.length > 0 ? "act" : "evaluate";
      return successfulPhase({
        ...charged,
        phase,
        cursor: {
          phase,
          iteration: charged.cursor.iteration,
          actionIndex: 0,
        },
        pendingTools,
        candidateOutput: event.result.content,
      });
    }
    case "provider.evaluation_charged":
      return chargeProvider(state, event.result.usage.costUsd);
    case "tool.reserve": {
      if (state.usage.toolCalls >= state.limits.maxToolCalls) {
        return terminal(state, "budget_exhausted", "tool_call_limit");
      }
      return {
        ...state,
        usage: { ...state.usage, toolCalls: state.usage.toolCalls + 1 },
      };
    }
    case "tool.succeeded": {
      const actionIndex = state.cursor.actionIndex + 1;
      const moreTools = actionIndex < state.pendingTools.length;
      const phase: WorkerSupervisorPhase = moreTools ? "act" : "evaluate";
      const next: WorkerSupervisorState = {
        ...state,
        phase,
        cursor: {
          phase,
          iteration: state.cursor.iteration,
          actionIndex,
        },
        toolResults: [...state.toolResults, event.result],
      };
      return moreTools ? next : successfulPhase(next);
    }
    case "phase.failed": {
      const consecutiveFailures = state.usage.consecutiveFailures + 1;
      const next = {
        ...state,
        usage: { ...state.usage, consecutiveFailures },
        lastError: event.error,
      };
      return consecutiveFailures >= state.limits.maxConsecutiveFailures
        ? terminal(next, "failed", "failure_limit", undefined, event.error)
        : next;
    }
    case "evaluation.accepted":
      return successfulPhase({
        ...state,
        phase: "checkpoint",
        cursor: {
          ...state.cursor,
          phase: "checkpoint",
        },
        evaluation: event.evaluation,
      });
    case "checkpoint.saved":
      return successfulPhase({
        ...state,
        phase: "decide",
        cursor: {
          ...state.cursor,
          phase: "decide",
        },
      });
    case "decide": {
      if (state.evaluation?.matched) {
        const reason =
          state.evaluation.predicateKind === "objective_satisfied"
            ? "objective_satisfied"
            : "exit_predicate_matched";
        return terminal(state, "completed", reason, state.candidateOutput);
      }
      if (state.usage.iterations >= state.limits.maxIterations) {
        return terminal(state, "budget_exhausted", "iteration_limit");
      }
      return {
        ...state,
        phase: "plan",
        iterationOpen: false,
        cursor: {
          phase: "plan",
          iteration: state.cursor.iteration,
          actionIndex: 0,
        },
      };
    }
    case "bound.reached":
      return terminal(state, "budget_exhausted", event.reason);
    case "cancelled":
      return terminal(state, "cancelled", event.reason);
    case "quarantined":
      return terminal(state, "quarantined", "unsafe_replay", undefined, event.error);
  }
}

export function parseWorkerEvaluation(
  content: string,
  predicates: readonly WorkerExitPredicate[],
  iteration: number,
): WorkerEvaluationRecord | null {
  let parsed: unknown;
  try {
    const trimmed = content
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.predicateId !== "string" ||
    typeof record.matched !== "boolean" ||
    typeof record.evidence !== "string"
  ) {
    return null;
  }
  const predicate = predicates.find((entry) => entry.id === record.predicateId);
  if (!predicate) return null;
  return {
    predicateId: predicate.id,
    predicateKind: predicate.kind,
    testedAtIteration: iteration,
    evidence: record.evidence,
    matched: record.matched,
  };
}

function chargeProvider(state: WorkerSupervisorState, costUsd: number): WorkerSupervisorState {
  const providerCostUsd = state.usage.providerCostUsd + Math.max(0, costUsd);
  const next = {
    ...state,
    usage: { ...state.usage, providerCostUsd },
  };
  return providerCostUsd >= state.limits.maxProviderCostUsd
    ? terminal(next, "budget_exhausted", "provider_cost")
    : next;
}

function successfulPhase(state: WorkerSupervisorState): WorkerSupervisorState {
  return {
    ...state,
    usage: { ...state.usage, consecutiveFailures: 0 },
    lastError: undefined,
  };
}

function terminal(
  state: WorkerSupervisorState,
  status: WorkerSupervisorTerminal["status"],
  reason: WorkerRunTerminalReason,
  output?: JsonValue,
  error?: string,
): WorkerSupervisorState {
  return {
    ...state,
    terminal: {
      status,
      reason,
      ...(output !== undefined ? { output } : {}),
      ...(error !== undefined ? { error } : {}),
    },
  };
}
