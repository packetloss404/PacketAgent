import assert from "node:assert/strict";
import test from "node:test";
import { createHttpFetchTool } from "../../tools/http-fetch.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { ToolDefinition } from "../../tools/types.js";
import type { ToolPolicyDecision } from "../../tools/types.js";
import { compileWorkerCapabilityPolicy } from "../capabilities.js";
import type { WorkerEffectCoordinator, WorkerEffectExecutionInput } from "../effects.js";
import { makeWorkerVersionContent } from "../__tests__/fixtures.js";
import { createPermissiveWorkerBudgetPort } from "../__tests__/budget-port.js";
import type { WorkerRollingBudgetPort } from "../budget-types.js";
import { WorkerRollingBudgetExceededError } from "../rolling-budget.js";
import type { WorkerCompiledPolicy, WorkerVersionContent } from "../types.js";
import { computeWorkerVersionContentDigest } from "../validation.js";
import { createWorkerToolPort } from "./adapters.js";

test("Worker tool adapter routes mutations through the effect coordinator", async () => {
  const registry = new ToolRegistry();
  const order: string[] = [];
  let receivedEffectKey: string | undefined;
  const tool: ToolDefinition = {
    name: "http_fetch",
    description: "Mutates an external test target.",
    inputSchema: {},
    side: "write",
    effect: {
      describe: () => ({
        classification: "idempotent_mutation",
        operation: "test_target.set",
        billableAction: true,
      }),
    },
    authorization: {
      describe: (input) => ({
        verb: "POST",
        effect: "write",
        resources: [String(input.url ?? "")],
      }),
    },
    async handle(_input, context) {
      order.push("tool");
      receivedEffectKey = context.effectKey;
      return { ok: true, output: { applied: true } };
    },
  };
  registry.register(tool);
  let coordinated: WorkerEffectExecutionInput | undefined;
  const effects: WorkerEffectCoordinator = {
    async execute(input) {
      order.push("effect");
      coordinated = input;
      return await input.execute("sha256:test-effect-key");
    },
  };
  const permissive = createPermissiveWorkerBudgetPort();
  const budgets: WorkerRollingBudgetPort = {
    ...permissive,
    async reserve(input) {
      order.push("budget.reserve");
      return await permissive.reserve(input);
    },
    async settle(input) {
      order.push("budget.settle");
      return await permissive.settle(input);
    },
  };
  const port = createWorkerToolPort(registry, effects, undefined, budgets);
  const policy = compiledPolicy("POST", "write");
  const decisions: ToolPolicyDecision[] = [];

  const result = await port.execute({
    workspaceId: "workspace-1",
    workerDefinitionId: "worker-1",
    workerRunId: "run-1",
    workerVersionId: "worker-version-1",
    workerVersionContentDigest: policy.workerVersionContentDigest,
    declaredCredentialRefs: [],
    workerDeploymentId: "deployment-1",
    workerDeploymentRevision: 1,
    compiledPolicy: policy,
    budgetUsage: budgetUsage(),
    budgetPolicy: makeWorkerVersionContent().policy.budgets,
    actor: { type: "system", id: "test-supervisor" },
    iteration: 2,
    fencingToken: 7,
    reservedAt: new Date("2026-07-27T12:00:00.000Z"),
    call: {
      id: "call-1",
      name: tool.name,
      input: { url: "https://releases.example.test/api" },
    },
    recordPolicyDecision: async (decision) => {
      decisions.push(decision);
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.status, "ok");
  assert.equal(coordinated?.classification, "idempotent_mutation");
  assert.equal(coordinated?.operation, "test_target.set");
  assert.equal(receivedEffectKey, "sha256:test-effect-key");
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].allowed, true);
  assert.equal(decisions[0].capabilityId, "test-capability");
  assert.deepEqual(order, ["budget.reserve", "effect", "tool", "budget.settle"]);
});

test("Worker tool adapter denies a mutation declared through a read capability", async () => {
  const registry = new ToolRegistry();
  let handled = 0;
  registry.register({
    name: "http_fetch",
    description: "Mutates an external test target.",
    inputSchema: {},
    side: "write",
    effect: {
      describe: () => ({
        classification: "non_replayable_mutation",
        operation: "test_target.append",
        billableAction: true,
      }),
    },
    authorization: {
      describe: (input) => ({
        verb: "POST",
        effect: "write",
        resources: [String(input.url ?? "")],
      }),
    },
    async handle() {
      handled += 1;
      return { ok: true };
    },
  });
  let coordinated = 0;
  let budgetReservations = 0;
  const permissive = createPermissiveWorkerBudgetPort();
  const budgets: WorkerRollingBudgetPort = {
    ...permissive,
    async reserve(input) {
      budgetReservations += 1;
      return await permissive.reserve(input);
    },
  };
  const port = createWorkerToolPort(
    registry,
    {
      async execute(input) {
        coordinated += 1;
        return await input.execute();
      },
    },
    undefined,
    budgets,
  );
  const policy = compiledPolicy("GET", "read");
  const decisions: ToolPolicyDecision[] = [];

  const result = await port.execute({
    workspaceId: "workspace-1",
    workerDefinitionId: "worker-1",
    workerRunId: "run-1",
    workerVersionId: "worker-version-1",
    workerVersionContentDigest: policy.workerVersionContentDigest,
    declaredCredentialRefs: [],
    workerDeploymentId: "deployment-1",
    workerDeploymentRevision: 1,
    compiledPolicy: policy,
    budgetUsage: budgetUsage(),
    budgetPolicy: makeWorkerVersionContent().policy.budgets,
    actor: { type: "system", id: "test-supervisor" },
    iteration: 1,
    fencingToken: 1,
    reservedAt: new Date("2026-07-27T12:00:00.000Z"),
    call: {
      id: "call-1",
      name: "http_fetch",
      input: { url: "https://releases.example.test/api" },
    },
    recordPolicyDecision: async (decision) => {
      decisions.push(decision);
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /Worker policy denied/);
  assert.equal(coordinated, 0);
  assert.equal(handled, 0);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].allowed, false);
  assert.equal(decisions[0].code, "capability_not_granted");
  assert.equal(budgetReservations, 0);
});

test("Worker tool adapter refuses a billable action when rolling reservation is denied", async () => {
  const registry = new ToolRegistry();
  let handled = 0;
  registry.register({
    name: "http_fetch",
    description: "Reads an external test target.",
    inputSchema: {},
    side: "read",
    effect: {
      describe: () => ({
        classification: "read_only",
        operation: "test_target.read",
        billableAction: true,
      }),
    },
    authorization: {
      describe: (input) => ({
        verb: "GET",
        effect: "read",
        resources: [String(input.url ?? "")],
      }),
    },
    async handle() {
      handled += 1;
      return { ok: true };
    },
  });
  let coordinated = 0;
  const permissive = createPermissiveWorkerBudgetPort();
  const budgets: WorkerRollingBudgetPort = {
    ...permissive,
    async reserve(input) {
      return {
        allowed: false,
        code: "deployment_limit",
        kind: input.kind,
        requestedAmount: input.amount,
        reservedAndSettledAmount: 1,
        limit: 1,
      };
    },
  };
  const port = createWorkerToolPort(
    registry,
    {
      async execute(input) {
        coordinated += 1;
        return await input.execute();
      },
    },
    undefined,
    budgets,
  );
  const policy = compiledPolicy("GET", "read");

  await assert.rejects(
    port.execute({
      workspaceId: "workspace-1",
      workerDefinitionId: "worker-1",
      workerRunId: "run-1",
      workerVersionId: "worker-version-1",
      workerVersionContentDigest: policy.workerVersionContentDigest,
      declaredCredentialRefs: [],
      workerDeploymentId: "deployment-1",
      workerDeploymentRevision: 1,
      compiledPolicy: policy,
      budgetUsage: budgetUsage(),
      budgetPolicy: makeWorkerVersionContent().policy.budgets,
      actor: { type: "system", id: "test-supervisor" },
      iteration: 1,
      fencingToken: 1,
      reservedAt: new Date("2026-07-27T12:00:00.000Z"),
      call: {
        id: "call-1",
        name: "http_fetch",
        input: { url: "https://releases.example.test/api" },
      },
      recordPolicyDecision: async () => undefined,
      signal: new AbortController().signal,
    }),
    (error) =>
      error instanceof WorkerRollingBudgetExceededError &&
      error.kind === "billable_action" &&
      error.scope === "deployment",
  );
  assert.equal(coordinated, 0);
  assert.equal(handled, 0);
});

test("Worker policy denial precedes credential, budget, effect, and network boundaries", async () => {
  const registry = new ToolRegistry();
  registry.register(createHttpFetchTool());
  const order: string[] = [];
  const permissive = createPermissiveWorkerBudgetPort();
  const port = createWorkerToolPort(
    registry,
    {
      async execute(input) {
        order.push("effect");
        return await input.execute();
      },
    },
    {
      credentials: {
        async list() {
          throw new Error("credential list must not run");
        },
        async upsert() {
          throw new Error("credential upsert must not run");
        },
        async remove() {
          throw new Error("credential removal must not run");
        },
        async use() {
          order.push("credential");
          throw new Error("credential resolution must not run");
        },
      },
      network: {
        async request() {
          order.push("network");
          throw new Error("network must not run");
        },
      },
      sandbox: {
        async execute() {
          throw new Error("sandbox must not run");
        },
      },
    },
    {
      ...permissive,
      async reserve(input) {
        order.push("budget");
        return await permissive.reserve(input);
      },
    },
  );
  const policy = compiledPolicy("GET", "read");

  const result = await port.execute({
    workspaceId: "workspace-1",
    workerDefinitionId: "worker-1",
    workerRunId: "run-1",
    workerVersionId: "worker-version-1",
    workerVersionContentDigest: policy.workerVersionContentDigest,
    declaredCredentialRefs: ["vault:release-api"],
    workerDeploymentId: "deployment-1",
    workerDeploymentRevision: 1,
    compiledPolicy: policy,
    budgetUsage: budgetUsage(),
    budgetPolicy: makeWorkerVersionContent().policy.budgets,
    actor: { type: "system", id: "test-supervisor" },
    iteration: 1,
    fencingToken: 1,
    reservedAt: new Date("2026-07-27T12:00:00.000Z"),
    call: {
      id: "call-1",
      name: "http_fetch",
      input: {
        url: "https://admin.example.test/api",
        credentialRef: "vault:release-api",
      },
    },
    recordPolicyDecision: async (decision) => {
      order.push(decision.allowed ? "allow" : "deny");
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.status, "error");
  assert.deepEqual(order, ["deny"]);
});

test("Worker tool adapter accepts only exact operation-bound approval evidence", async () => {
  const registry = new ToolRegistry();
  let handled = 0;
  registry.register({
    name: "http_fetch",
    description: "Reads an approved external target.",
    inputSchema: {},
    side: "read",
    authorization: {
      describe: (input) => ({
        verb: "GET",
        effect: "read",
        resources: [String(input.url ?? "")],
      }),
    },
    async handle() {
      handled += 1;
      return { ok: true };
    },
  });
  const port = createWorkerToolPort(registry);
  const policy = compiledPolicy("GET", "read", "always");
  const base = {
    workspaceId: "workspace-1",
    workerDefinitionId: "worker-1",
    workerRunId: "run-1",
    workerVersionId: "worker-version-1",
    workerVersionContentDigest: policy.workerVersionContentDigest,
    declaredCredentialRefs: [] as string[],
    workerDeploymentId: "deployment-1",
    workerDeploymentRevision: 1,
    compiledPolicy: policy,
    budgetUsage: budgetUsage(),
    actor: { type: "system" as const, id: "test-supervisor" },
    call: {
      id: "call-approved",
      name: "http_fetch",
      input: { url: "https://releases.example.test/api" },
    },
    authorizedAt: new Date("2026-07-27T12:00:00.000Z"),
    signal: new AbortController().signal,
  };
  const denied = await port.authorize(base);
  assert.equal(denied.code, "approval_required");
  const approval = {
    grantId: "approval-1",
    attentionRequestId: "attention-1",
    actionId: base.call.id,
    capabilityId: denied.capabilityId!,
    operationDigest: denied.operationDigest,
    policyDigest: denied.policyDigest!,
    scope: "once" as const,
    expiresAt: "2026-07-27T12:30:00.000Z",
  };
  const allowed = await port.authorize({ ...base, approval });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.approvalGrantId, "approval-1");

  const result = await port.execute({
    ...base,
    approval,
    budgetPolicy: makeWorkerVersionContent().policy.budgets,
    iteration: 1,
    fencingToken: 1,
    reservedAt: new Date("2026-07-27T12:00:00.000Z"),
    recordPolicyDecision: async () => undefined,
  });
  assert.equal(result.status, "ok");
  assert.equal(handled, 1);

  const mismatched = await port.authorize({
    ...base,
    approval: {
      ...approval,
      operationDigest: `sha256:${"f".repeat(64)}`,
    },
  });
  assert.equal(mismatched.code, "approval_required");

  const expired = await port.execute({
    ...base,
    approval: {
      ...approval,
      expiresAt: "2026-07-27T11:59:59.000Z",
    },
    budgetPolicy: makeWorkerVersionContent().policy.budgets,
    iteration: 1,
    fencingToken: 1,
    reservedAt: new Date("2026-07-27T12:00:00.000Z"),
    recordPolicyDecision: async () => undefined,
  });
  assert.equal(expired.status, "error");
  assert.equal(handled, 1);
});

function compiledPolicy(
  verb: "GET" | "POST",
  effect: "read" | "write",
  approval: "never" | "always" = "never",
): WorkerCompiledPolicy {
  const content: WorkerVersionContent = makeWorkerVersionContent({
    tools: [
      {
        id: "test-capability",
        tool: "http_fetch",
        verbs: [verb],
        resources: ["https://releases.example.test/api"],
        effect,
        approval,
      },
    ],
    policy: {
      ...makeWorkerVersionContent().policy,
      permissions: {
        default: "deny",
        allowedCapabilityIds: ["test-capability"],
      },
    },
  });
  const contentDigest = computeWorkerVersionContentDigest(content);
  return compileWorkerCapabilityPolicy({
    workerVersionContentDigest: contentDigest,
    requestedCapabilities: content.tools,
    allowedCapabilityIds: content.policy.permissions.allowedCapabilityIds,
    credentialRefs: content.credentialRefs,
  }).policy;
}

function budgetUsage() {
  return {
    elapsedMs: 1,
    iterations: 1,
    providerCostUsd: 0,
    consecutiveFailures: 0,
    toolCalls: 1,
  };
}
