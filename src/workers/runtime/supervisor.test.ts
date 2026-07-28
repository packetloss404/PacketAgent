import assert from "node:assert/strict";
import test from "node:test";
import {
  makeWorkerAttentionRequest,
  makeWorkerDefinition,
  makeWorkerDeployment,
  makeWorkerRun,
  makeWorkerVersion,
  makeWorkerVersionContent,
} from "../__tests__/fixtures.js";
import { createPermissiveWorkerBudgetPort } from "../__tests__/budget-port.js";
import type { WorkerRollingBudgetPort } from "../budget-types.js";
import { compileWorkerCapabilityPolicy } from "../capabilities.js";
import { WorkerLifecycleError } from "../errors.js";
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
import { WorkerRollingBudgetExceededError } from "../rolling-budget.js";

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
  assert.equal(harness.checkpoints, 4);
  assert.equal(result.run.budgetUsage.iterations, 1);
  assert.equal(result.run.budgetUsage.toolCalls, 1);
  assert.equal(
    harness.events.some((event) => event.type === "worker.policy.allowed"),
    true,
  );
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
    assert.equal(harness.events.filter((event) => event.type === "worker.phase.failed").length, 3);
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

test("failed tool attempts and their retry backoff remain journaled", async () => {
  const harness = runtimeHarness({
    provider: async (request) =>
      request.phase === "plan"
        ? providerResult({
            toolCalls: [
              {
                id: "failing-tool",
                name: "http_fetch",
                input: { url: "https://test" },
              },
            ],
          })
        : providerResult(),
    toolError: new Error("scripted tool failure"),
  });

  const result = await runWorkerSupervisor(harness.input);

  assert.equal(result.run.status, "failed");
  assert.equal(result.run.terminalReason, "failure_limit");
  assert.equal(harness.events.filter((event) => event.type === "worker.tool.failed").length, 3);
  assert.equal(harness.events.filter((event) => event.type === "worker.phase.failed").length, 3);
  assert.equal(
    harness.events
      .filter((event) => event.type === "worker.phase.failed")
      .every((event) => typeof event.data?.backoffMs === "number"),
    true,
  );
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

test("provider calls reserve the worst-case remaining run cost before execution", async () => {
  const calls: string[] = [];
  const reservedAmounts: number[] = [];
  const settledAmounts: number[] = [];
  const permissive = createPermissiveWorkerBudgetPort();
  const rollingBudgets: WorkerRollingBudgetPort = {
    ...permissive,
    async reserve(input) {
      calls.push("reserve");
      reservedAmounts.push(input.amount);
      return await permissive.reserve(input);
    },
    async settle(input) {
      calls.push("settle");
      settledAmounts.push(input.actualAmount);
      return await permissive.settle(input);
    },
  };
  const harness = runtimeHarness({
    budgets: { ...DEFAULT_BUDGETS, maxProviderCostUsd: 0.5 },
    rollingBudgets,
    provider: async () => {
      calls.push("provider");
      return providerResult({ costUsd: 0.1 });
    },
  });

  await runWorkerSupervisor(harness.input);

  assert.deepEqual(calls.slice(0, 3), ["reserve", "provider", "settle"]);
  assert.equal(reservedAmounts[0], 0.5);
  assert.equal(settledAmounts[0], 0.1);
});

test("rolling provider exhaustion prevents the provider call", async () => {
  const permissive = createPermissiveWorkerBudgetPort();
  const rollingBudgets: WorkerRollingBudgetPort = {
    ...permissive,
    async reserve(input) {
      return {
        allowed: false,
        code: "workspace_limit",
        kind: input.kind,
        requestedAmount: input.amount,
        reservedAndSettledAmount: input.policy.workspace.maxProviderCostUsd,
        limit: input.policy.workspace.maxProviderCostUsd,
      };
    },
  };
  const harness = runtimeHarness({ rollingBudgets });

  const result = await runWorkerSupervisor(harness.input);

  assert.equal(result.run.status, "budget_exhausted");
  assert.equal(result.run.terminalReason, "rolling_provider_cost");
  assert.equal(harness.providerCalls, 0);
  assert.equal(harness.toolCalls, 0);
});

test("rolling billable-action exhaustion prevents tool execution", async () => {
  const harness = runtimeHarness({
    provider: async () =>
      providerResult({
        toolCalls: [
          {
            id: "billable-call",
            name: "http_fetch",
            input: { url: "https://test" },
          },
        ],
      }),
    toolError: new WorkerRollingBudgetExceededError("billable_action", "deployment"),
  });

  const result = await runWorkerSupervisor(harness.input);

  assert.equal(result.run.status, "budget_exhausted");
  assert.equal(result.run.terminalReason, "rolling_billable_actions");
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

test("approval-required work returns a durable waiting run without a tool or terminal write", async () => {
  const harness = runtimeHarness({
    attentionResolution: "waiting",
    provider: async () =>
      providerResult({
        toolCalls: [
          {
            id: "call-approval",
            name: "http_fetch",
            input: { url: "https://releases.example.test/latest" },
          },
        ],
      }),
  });

  const result = await runWorkerSupervisor(harness.input);

  assert.equal(result.run.status, "waiting_for_approval");
  assert.equal(harness.attentionCalls, 1);
  assert.equal(harness.toolCalls, 0);
  assert.equal(harness.finalizations, 0);
  assert.equal(harness.events.filter((event) => event.type === "worker.policy.denied").length, 1);
});

test("an exact approval is rechecked at execution and completes the pending tool", async () => {
  const harness = runtimeHarness({
    attentionResolution: "approved",
    provider: async (request) =>
      request.phase === "plan"
        ? providerResult({
            toolCalls: [
              {
                id: "call-approval",
                name: "http_fetch",
                input: {
                  url: "https://releases.example.test/latest",
                },
              },
            ],
          })
        : providerResult({
            content: '{"predicateId":"release-decision","matched":true,"evidence":"approved"}',
          }),
  });

  const result = await runWorkerSupervisor(harness.input);

  assert.equal(result.run.status, "completed");
  assert.equal(harness.attentionCalls, 1);
  assert.equal(harness.toolCalls, 1);
  assert.equal(
    harness.events.some(
      (event) =>
        event.type === "worker.policy.allowed" && event.data?.approvalGrantId === "approval-1",
    ),
    true,
  );
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
    const expectedCheckpoints = {
      plan: 0,
      act: 2,
      evaluate: 3,
      checkpoint: 4,
      decide: 4,
      attention: 0,
    } satisfies Record<WorkerSupervisorPhase, number>;
    assert.equal(harness.checkpoints, expectedCheckpoints[phase]);
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

test("durable pause releases the supervisor before another action or terminal write", async () => {
  const harness = runtimeHarness({
    cancelAtPhase: "plan",
    cancellationKind: "paused",
    provider: async () =>
      providerResult({
        toolCalls: [{ id: "call-1", name: "http_fetch", input: { url: "https://test" } }],
      }),
  });

  await assert.rejects(
    runWorkerSupervisor(harness.input),
    (error: unknown) =>
      error instanceof WorkerRuntimeReleasedError && error.reason === "operator_paused",
  );
  assert.equal(harness.providerCalls, 0);
  assert.equal(harness.toolCalls, 0);
  assert.equal(harness.finalizations, 0);
});

test("pause detected through a fenced checkpoint conflict releases in-flight planning", async () => {
  const harness = runtimeHarness({
    cancellationKind: "paused",
    cancelAfterProviderCall: true,
    rejectCheckpointWhenCancelled: true,
    provider: async () =>
      providerResult({
        toolCalls: [{ id: "call-1", name: "http_fetch", input: { url: "https://test" } }],
      }),
  });

  await assert.rejects(
    runWorkerSupervisor(harness.input),
    (error: unknown) =>
      error instanceof WorkerRuntimeReleasedError && error.reason === "operator_paused",
  );
  assert.equal(harness.providerCalls, 1);
  assert.equal(harness.toolCalls, 0);
  assert.equal(harness.finalizations, 0);
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
  readonly cancellationKind?: "paused" | "operator_cancelled" | "deployment_revoked";
  readonly cancelAfterProviderCall?: boolean;
  readonly rejectCheckpointWhenCancelled?: boolean;
  readonly loseLeaseAfterRenewals?: number;
  readonly rollingBudgets?: WorkerRollingBudgetPort;
  readonly toolError?: Error;
  readonly attentionResolution?: "waiting" | "approved";
}

function runtimeHarness(options: RuntimeHarnessOptions = {}) {
  const clock = createSystemWorkerClock();
  const budgets = options.budgets ?? DEFAULT_BUDGETS;
  const retry = options.retry ?? DEFAULT_RETRY;
  const baseContent = makeWorkerVersionContent();
  const content = makeWorkerVersionContent({
    ...(options.attentionResolution
      ? {
          tools: baseContent.tools.map((capability) => ({
            ...capability,
            approval: "always" as const,
          })),
        }
      : {}),
    policy: {
      budgets,
      retry,
      permissions: {
        default: "deny",
        allowedCapabilityIds: ["release-read"],
      },
      attention: baseContent.policy.attention,
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
  let attentionCalls = 0;
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
  const version = makeWorkerVersion({
    status: "validated",
    content,
    createdAt: now.toISOString(),
    validatedAt: now.toISOString(),
  });
  const compilation = compileWorkerCapabilityPolicy({
    workerVersionContentDigest: version.contentDigest,
    requestedCapabilities: content.tools,
    allowedCapabilityIds: content.policy.permissions.allowedCapabilityIds,
    credentialRefs: content.credentialRefs,
  });
  const context: WorkerRuntimeContext = {
    definition: makeWorkerDefinition({ status: "active" }),
    version,
    deployment: makeWorkerDeployment({
      status: "active",
      capabilityGrants: compilation.grants,
      compiledPolicy: compilation.policy,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      activatedAt: now.toISOString(),
    }),
    run,
    input: run.input ?? {},
  };

  const ports: WorkerSupervisorPorts = {
    budgets: options.rollingBudgets ?? createPermissiveWorkerBudgetPort(),
    clock,
    provider: {
      async call(request) {
        providerCalls += 1;
        const result = options.provider
          ? options.provider(request)
          : providerResult({
              content: '{"predicateId":"release-decision","matched":true,"evidence":"done"}',
            });
        const resolved = await result;
        if (options.cancelAfterProviderCall) cancelled = true;
        return resolved;
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
      async authorize(input) {
        const matched = input.compiledPolicy?.capabilities.find(
          (entry) => entry.tool === input.call.name,
        );
        const capability =
          matched?.approval === "never" ||
          (matched?.approval === "always" &&
            input.approval?.capabilityId === matched.capabilityId &&
            input.approval.operationDigest === `sha256:${"a".repeat(64)}` &&
            input.approval.policyDigest === input.compiledPolicy?.policyDigest)
            ? matched
            : undefined;
        return {
          allowed: Boolean(capability),
          code: capability
            ? "allowed"
            : matched?.approval === "always"
              ? "approval_required"
              : "capability_not_granted",
          tool: input.call.name,
          verb: matched?.verb ?? "UNKNOWN",
          effect: matched?.effect ?? "execute",
          operationDigest: `sha256:${"a".repeat(64)}`,
          resourceCount: 1,
          resourceSchemes: ["https"],
          ...(input.compiledPolicy ? { policyDigest: input.compiledPolicy.policyDigest } : {}),
          ...(matched ? { capabilityId: matched.capabilityId } : {}),
        };
      },
      async execute(input): Promise<WorkerRuntimeToolResult> {
        const capability = input.compiledPolicy?.capabilities.find(
          (entry) =>
            entry.tool === input.call.name &&
            (entry.approval === "never" ||
              (entry.approval === "always" && input.approval?.capabilityId === entry.capabilityId)),
        );
        await input.recordPolicyDecision({
          allowed: Boolean(capability),
          code: capability ? "allowed" : "capability_not_granted",
          tool: input.call.name,
          verb: capability?.verb ?? "UNKNOWN",
          effect: capability?.effect ?? "execute",
          operationDigest: `sha256:${"a".repeat(64)}`,
          resourceCount: 1,
          resourceSchemes: ["https"],
          ...(input.compiledPolicy ? { policyDigest: input.compiledPolicy.policyDigest } : {}),
          ...(capability ? { capabilityId: capability.capabilityId } : {}),
          ...(input.approval
            ? {
                approvalGrantId: input.approval.grantId,
                attentionRequestId: input.approval.attentionRequestId,
              }
            : {}),
        });
        const timestamp = clock.now().toISOString();
        if (!capability) {
          return {
            callId: input.call.id,
            toolName: input.call.name,
            status: "error",
            error: "Worker policy denied test tool.",
            durationMs: 0,
            startedAt: timestamp,
            completedAt: timestamp,
          };
        }
        if (options.toolError) throw options.toolError;
        toolCalls += 1;
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
    attention: {
      async resolve(input) {
        attentionCalls += 1;
        if (options.attentionResolution === "approved") {
          return {
            disposition: "approved" as const,
            approval: {
              grantId: "approval-1",
              attentionRequestId: "attention-1",
              actionId: input.actionId,
              capabilityId: input.policyDecision.capabilityId!,
              operationDigest: input.policyDecision.operationDigest,
              policyDigest: input.policyDecision.policyDigest!,
              scope: "once" as const,
              expiresAt: new Date(clock.now().getTime() + 30_000).toISOString(),
            },
          };
        }
        if (options.attentionResolution === "waiting") {
          const { runtimeLease: _lease, ...withoutLease } = context.run;
          return {
            disposition: "waiting" as const,
            attention: makeWorkerAttentionRequest({
              workerVersionContentDigest: context.version.contentDigest,
              policyDigest: context.deployment.compiledPolicy!.policyDigest,
              operationDigest: input.policyDecision.operationDigest,
              capabilityId: input.policyDecision.capabilityId!,
            }),
            run: {
              ...withoutLease,
              status: "waiting_for_approval" as const,
              revision: context.run.revision + 1,
              updatedAt: clock.now().toISOString(),
            },
            checkpointId: "checkpoint-attention",
            checkpointSequence: 0,
            runRevision: context.run.revision + 1,
          };
        }
        throw new Error("No approval attention was expected in this harness.");
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
        if (cancelled && options.rejectCheckpointWhenCancelled) {
          throw new WorkerLifecycleError("conflict", "run revision changed by control command");
        }
        checkpoints += 1;
        revision += 1;
        return {
          checkpointId: `checkpoint-${checkpoints}`,
          checkpointSequence: checkpoints - 1,
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
    get attentionCalls() {
      return attentionCalls;
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
