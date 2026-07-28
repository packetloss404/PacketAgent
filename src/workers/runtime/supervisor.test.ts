import assert from "node:assert/strict";
import test from "node:test";
import {
  makeWorkerDefinition,
  makeWorkerDeployment,
  makeWorkerRun,
  makeWorkerVersion,
  makeWorkerVersionContent,
} from "../__tests__/fixtures.js";
import type {
  JsonObject,
  WorkerBudgetPolicy,
  WorkerRetryPolicy,
  WorkerRun,
  WorkerSupervisorPhase,
} from "../types.js";
import { createSystemWorkerClock } from "./adapters.js";
import type {
  WorkerLease,
  WorkerRuntimeContext,
  WorkerRuntimeProviderRequest,
  WorkerRuntimeProviderResult,
  WorkerRuntimeToolResult,
  WorkerSupervisorPorts,
} from "./ports.js";
import {
  initialWorkerSupervisorState,
  parseWorkerEvaluation,
  reduceWorkerSupervisor,
} from "./reducer.js";
import { runWorkerSupervisor, WorkerRuntimeReleasedError } from "./supervisor.js";

const DEFAULT_BUDGETS: WorkerBudgetPolicy = {
  maxElapsedMs: 1_000,
  maxIterations: 3,
  maxProviderCostUsd: 10,
  maxConsecutiveFailures: 3,
  maxToolCalls: 5,
};
const DEFAULT_RETRY: WorkerRetryPolicy = {
  maxAttempts: 3,
  initialBackoffMs: 1,
  maxBackoffMs: 2,
  backoffMultiplier: 2,
};

test("phase reducer alone selects explicit completion and budget terminal reasons", () => {
  let state = initialWorkerSupervisorState(
    {
      elapsedMs: 0,
      iterations: 0,
      providerCostUsd: 0,
      consecutiveFailures: 0,
      toolCalls: 0,
    },
    DEFAULT_BUDGETS,
  );
  state = reduceWorkerSupervisor(state, { type: "iteration.begin" });
  state = reduceWorkerSupervisor(state, {
    type: "provider.plan_succeeded",
    result: providerResult({ content: "ready" }),
  });
  const evaluation = parseWorkerEvaluation(
    '{"predicateId":"done","matched":true,"evidence":"verified"}',
    [{ id: "done", kind: "objective_satisfied", description: "done" }],
    1,
  );
  assert.ok(evaluation);
  state = reduceWorkerSupervisor(state, { type: "evaluation.accepted", evaluation });
  state = reduceWorkerSupervisor(state, { type: "checkpoint.saved" });
  state = reduceWorkerSupervisor(state, { type: "decide" });
  assert.deepEqual(state.terminal, {
    status: "completed",
    reason: "objective_satisfied",
    output: "ready",
  });

  const exhausted = reduceWorkerSupervisor(
    initialWorkerSupervisorState(
      {
        elapsedMs: 0,
        iterations: 0,
        providerCostUsd: 0,
        consecutiveFailures: 0,
        toolCalls: 0,
      },
      DEFAULT_BUDGETS,
    ),
    { type: "bound.reached", reason: "tool_call_limit" },
  );
  assert.equal(exhausted.terminal?.status, "budget_exhausted");
  assert.equal(exhausted.terminal?.reason, "tool_call_limit");
});

test("supervisor completes plan-act-evaluate-checkpoint-decide deterministically", async () => {
  const harness = runtimeHarness({
    provider: async (request) =>
      request.phase === "plan"
        ? providerResult({
            content: "release ready",
            toolCalls: [{ id: "call-1", name: "http_fetch", input: { url: "https://test" } }],
          })
        : providerResult({
            content: '{"predicateId":"release-decision","matched":true,"evidence":"checks passed"}',
          }),
  });

  const result = await runWorkerSupervisor(harness.input);

  assert.equal(result.run.status, "completed");
  assert.equal(result.run.terminalReason, "objective_satisfied");
  assert.equal(harness.providerCalls, 2);
  assert.equal(harness.toolCalls, 1);
  assert.equal(harness.checkpoints, 1);
  assert.equal(result.run.budgetUsage.iterations, 1);
  assert.equal(result.run.budgetUsage.toolCalls, 1);
  assert.equal(
    harness.events.some(
      (event) =>
        event.type === "worker.phase.evaluated" &&
        !Object.prototype.hasOwnProperty.call(event.data ?? {}, "evidence"),
    ),
    true,
  );
});

test("endless tool requests stop at the pre-execution tool-call bound", async () => {
  const harness = runtimeHarness({
    budgets: { ...DEFAULT_BUDGETS, maxToolCalls: 2, maxIterations: 8 },
    provider: async (request) =>
      request.phase === "plan"
        ? providerResult({
            toolCalls: [
              {
                id: "repeated-tool",
                name: "http_fetch",
                input: { url: "https://test" },
              },
            ],
          })
        : providerResult({
            content: '{"predicateId":"release-decision","matched":false,"evidence":"more work"}',
          }),
  });

  const result = await runWorkerSupervisor(harness.input);

  assert.equal(result.run.status, "budget_exhausted");
  assert.equal(result.run.terminalReason, "tool_call_limit");
  assert.equal(harness.toolCalls, 2);
  assert.ok(harness.providerCalls <= 5);
});

test("a provider that never settles is cut off by elapsed time", async () => {
  const harness = runtimeHarness({
    budgets: { ...DEFAULT_BUDGETS, maxElapsedMs: 25 },
    provider: async () => await new Promise<WorkerRuntimeProviderResult>(() => undefined),
  });

  const result = await runWorkerSupervisor(harness.input);

  assert.equal(result.run.status, "budget_exhausted");
  assert.equal(result.run.terminalReason, "elapsed_time");
  assert.equal(harness.providerCalls, 1);
  assert.equal(harness.toolCalls, 0);
});

test("operator abort interrupts a provider that ignores its signal", async () => {
  const harness = runtimeHarness({
    budgets: { ...DEFAULT_BUDGETS, maxElapsedMs: 5_000 },
    provider: async () => await new Promise<WorkerRuntimeProviderResult>(() => undefined),
  });
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort("operator requested stop"), 10);
  try {
    const result = await runWorkerSupervisor({
      ...harness.input,
      signal: controller.signal,
    });
    assert.equal(result.run.status, "cancelled");
    assert.equal(result.run.terminalReason, "operator_cancelled");
    assert.ok(Date.now() - startedAt < 500);
    assert.equal(harness.providerCalls, 1);
    assert.equal(harness.toolCalls, 0);
  } finally {
    clearTimeout(timer);
  }
});

test("provider failures and invalid exit output have finite retry ceilings", async (t) => {
  await t.test("repeated provider errors", async () => {
    const harness = runtimeHarness({
      provider: async () => {
        throw new Error("scripted provider failure");
      },
    });
    const result = await runWorkerSupervisor(harness.input);
    assert.equal(result.run.status, "failed");
    assert.equal(result.run.terminalReason, "failure_limit");
    assert.equal(harness.providerCalls, 3);
    assert.equal(harness.toolCalls, 0);
  });

  await t.test("invalid evaluation", async () => {
    const harness = runtimeHarness({
      retry: { ...DEFAULT_RETRY, maxAttempts: 2 },
      provider: async (request) =>
        request.phase === "plan"
          ? providerResult({ content: "candidate" })
          : providerResult({ content: "not-json" }),
    });
    const result = await runWorkerSupervisor(harness.input);
    assert.equal(result.run.status, "failed");
    assert.equal(result.run.terminalReason, "failure_limit");
    assert.equal(harness.providerCalls, 3);
  });
});

test("provider cost is charged before any subsequent phase can execute", async () => {
  const harness = runtimeHarness({
    budgets: { ...DEFAULT_BUDGETS, maxProviderCostUsd: 0.5 },
    provider: async () => providerResult({ costUsd: 0.5 }),
  });

  const result = await runWorkerSupervisor(harness.input);

  assert.equal(result.run.status, "budget_exhausted");
  assert.equal(result.run.terminalReason, "provider_cost");
  assert.equal(result.run.budgetUsage.providerCostUsd, 0.5);
  assert.equal(harness.providerCalls, 1);
  assert.equal(harness.toolCalls, 0);
});

test("a provider cannot invoke an undeclared or approval-required tool", async () => {
  const harness = runtimeHarness({
    provider: async () =>
      providerResult({
        toolCalls: [{ id: "call-unsafe", name: "shell_for_agent", input: { command: "echo" } }],
      }),
  });

  const result = await runWorkerSupervisor(harness.input);

  assert.equal(result.run.status, "failed");
  assert.equal(result.run.terminalReason, "failure_limit");
  assert.equal(harness.providerCalls, 1);
  assert.equal(harness.toolCalls, 0);
});

for (const phase of [
  "plan",
  "act",
  "evaluate",
  "checkpoint",
  "decide",
] satisfies readonly WorkerSupervisorPhase[]) {
  test(`operator cancellation at ${phase} prevents later Worker actions`, async () => {
    const harness = runtimeHarness({
      cancelAtPhase: phase,
      provider: async (request) =>
        request.phase === "plan"
          ? providerResult({
              content: "candidate",
              toolCalls: [{ id: "call-1", name: "http_fetch", input: { url: "https://test" } }],
            })
          : providerResult({
              content: '{"predicateId":"release-decision","matched":true,"evidence":"done"}',
            }),
    });

    const result = await runWorkerSupervisor(harness.input);

    assert.equal(result.run.status, "cancelled");
    assert.equal(result.run.terminalReason, "operator_cancelled");
    if (phase === "plan" || phase === "act") assert.equal(harness.toolCalls, 0);
    if (phase === "plan" || phase === "act" || phase === "evaluate") {
      assert.equal(harness.checkpoints, 0);
    }
    assert.ok(harness.providerCalls <= 2);
    assert.ok(harness.toolCalls <= 1);
  });
}

test("deployment revocation is a distinct cancellation outcome", async () => {
  const harness = runtimeHarness({
    cancelAtPhase: "act",
    cancellationKind: "deployment_revoked",
    provider: async () =>
      providerResult({
        toolCalls: [{ id: "call-1", name: "http_fetch", input: { url: "https://test" } }],
      }),
  });

  const result = await runWorkerSupervisor(harness.input);

  assert.equal(result.run.status, "cancelled");
  assert.equal(result.run.terminalReason, "deployment_revoked");
  assert.equal(harness.toolCalls, 0);
});

test("lease theft releases execution without a post-theft tool or terminal write", async () => {
  const harness = runtimeHarness({
    loseLeaseAfterRenewals: 3,
    provider: async () =>
      providerResult({
        toolCalls: [{ id: "call-1", name: "http_fetch", input: { url: "https://test" } }],
      }),
  });

  await assert.rejects(
    runWorkerSupervisor(harness.input),
    (error: unknown) =>
      error instanceof WorkerRuntimeReleasedError && error.reason === "lease_lost",
  );
  assert.equal(harness.providerCalls, 1);
  assert.equal(harness.toolCalls, 0);
  assert.equal(harness.finalizations, 0);
});

interface RuntimeHarnessOptions {
  readonly budgets?: WorkerBudgetPolicy;
  readonly retry?: WorkerRetryPolicy;
  readonly provider?: (
    request: WorkerRuntimeProviderRequest,
  ) => Promise<WorkerRuntimeProviderResult>;
  readonly cancelAtPhase?: WorkerSupervisorPhase;
  readonly cancellationKind?: "operator_cancelled" | "deployment_revoked";
  readonly loseLeaseAfterRenewals?: number;
}

function runtimeHarness(options: RuntimeHarnessOptions = {}) {
  const clock = createSystemWorkerClock();
  const budgets = options.budgets ?? DEFAULT_BUDGETS;
  const retry = options.retry ?? DEFAULT_RETRY;
  const content = makeWorkerVersionContent({
    policy: {
      budgets,
      retry,
      permissions: {
        default: "deny",
        allowedCapabilityIds: ["release-read"],
      },
    },
  });
  const now = clock.now();
  const lease: WorkerLease = {
    ownerId: "test-owner",
    fencingToken: 7,
    acquiredAt: now.toISOString(),
    renewedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  };
  let currentLease = lease;
  let revision = 2;
  let cancelled = false;
  let providerCalls = 0;
  let toolCalls = 0;
  let checkpoints = 0;
  let renewals = 0;
  let finalizations = 0;
  const events: Array<{
    type: string;
    phase: WorkerSupervisorPhase;
    data?: JsonObject;
  }> = [];
  const run = makeWorkerRun({
    status: "running",
    revision,
    runtimeLease: lease,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    startedAt: now.toISOString(),
  });
  const context: WorkerRuntimeContext = {
    definition: makeWorkerDefinition({ status: "active" }),
    version: makeWorkerVersion({
      status: "validated",
      content,
      createdAt: now.toISOString(),
      validatedAt: now.toISOString(),
    }),
    deployment: makeWorkerDeployment({
      status: "active",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      activatedAt: now.toISOString(),
    }),
    run,
    input: run.input ?? {},
  };

  const ports: WorkerSupervisorPorts = {
    clock,
    provider: {
      async call(request) {
        providerCalls += 1;
        return options.provider
          ? options.provider(request)
          : providerResult({
              content: '{"predicateId":"release-decision","matched":true,"evidence":"done"}',
            });
      },
    },
    tools: {
      definitions(capabilities) {
        return capabilities.map((capability) => ({
          name: capability.tool,
          description: capability.tool,
          inputSchema: {},
        }));
      },
      async execute(input): Promise<WorkerRuntimeToolResult> {
        toolCalls += 1;
        const timestamp = clock.now().toISOString();
        return {
          callId: input.call.id,
          toolName: input.call.name,
          status: "ok",
          output: { ok: true },
          durationMs: 0,
          startedAt: timestamp,
          completedAt: timestamp,
        };
      },
    },
    cancellation: {
      async inspect() {
        return cancelled
          ? { kind: options.cancellationKind ?? ("operator_cancelled" as const) }
          : { kind: "active" as const };
      },
    },
    leases: {
      async renew(input) {
        renewals += 1;
        if (
          options.loseLeaseAfterRenewals !== undefined &&
          renewals > options.loseLeaseAfterRenewals
        ) {
          return null;
        }
        currentLease = {
          ...input.lease,
          renewedAt: input.now.toISOString(),
          expiresAt: new Date(input.now.getTime() + 60_000).toISOString(),
        };
        return currentLease;
      },
      async release() {
        return;
      },
    },
    events: {
      async append(input) {
        events.push({
          type: input.event.type,
          phase: input.event.phase,
          ...(input.event.data ? { data: input.event.data } : {}),
        });
        if (input.event.phase === options.cancelAtPhase) cancelled = true;
      },
    },
    checkpoints: {
      async save() {
        checkpoints += 1;
        revision += 1;
        return {
          checkpointId: `checkpoint-${checkpoints}`,
          runRevision: revision,
        };
      },
    },
    runs: {
      async finalize(input) {
        finalizations += 1;
        revision += 1;
        const { runtimeLease: _lease, ...withoutLease } = context.run;
        return {
          ...withoutLease,
          revision,
          status: input.finalization.status,
          terminalReason: input.finalization.terminalReason,
          budgetUsage: input.finalization.budgetUsage,
          ...(input.finalization.output !== undefined ? { output: input.finalization.output } : {}),
          ...(input.finalization.error !== undefined ? { error: input.finalization.error } : {}),
          updatedAt: input.now.toISOString(),
          completedAt: input.now.toISOString(),
        } as WorkerRun;
      },
    },
  };

  return {
    input: {
      context,
      lease,
      ports,
      signal: new AbortController().signal,
    },
    events,
    get providerCalls() {
      return providerCalls;
    },
    get toolCalls() {
      return toolCalls;
    },
    get checkpoints() {
      return checkpoints;
    },
    get finalizations() {
      return finalizations;
    },
  };
}

function providerResult(
  overrides: Partial<WorkerRuntimeProviderResult> & { readonly costUsd?: number } = {},
): WorkerRuntimeProviderResult {
  return {
    content: "",
    toolCalls: [],
    finishReason: "stop",
    usage: {
      promptTokens: 1,
      completionTokens: 1,
      costUsd: overrides.usage?.costUsd ?? 0.01,
    },
    model: "test-model",
    provider: "test-provider",
    ...overrides,
    ...(overrides.costUsd !== undefined
      ? {
          usage: {
            promptTokens: 1,
            completionTokens: 1,
            costUsd: overrides.costUsd,
          },
        }
      : {}),
  } as WorkerRuntimeProviderResult;
}
