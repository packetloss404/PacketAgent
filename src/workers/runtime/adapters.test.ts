import assert from "node:assert/strict";
import test from "node:test";
import { ToolRegistry } from "../../tools/registry.js";
import type { ToolDefinition } from "../../tools/types.js";
import type { ToolPolicyDecision } from "../../tools/types.js";
import { compileWorkerCapabilityPolicy } from "../capabilities.js";
import type { WorkerEffectCoordinator, WorkerEffectExecutionInput } from "../effects.js";
import { makeWorkerVersionContent } from "../__tests__/fixtures.js";
import type { WorkerCompiledPolicy, WorkerVersionContent } from "../types.js";
import { computeWorkerVersionContentDigest } from "../validation.js";
import { createWorkerToolPort } from "./adapters.js";

test("Worker tool adapter routes mutations through the effect coordinator", async () => {
  const registry = new ToolRegistry();
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
      receivedEffectKey = context.effectKey;
      return { ok: true, output: { applied: true } };
    },
  };
  registry.register(tool);
  let coordinated: WorkerEffectExecutionInput | undefined;
  const effects: WorkerEffectCoordinator = {
    async execute(input) {
      coordinated = input;
      return await input.execute("sha256:test-effect-key");
    },
  };
  const port = createWorkerToolPort(registry, effects);
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
    actor: { type: "system", id: "test-supervisor" },
    iteration: 2,
    fencingToken: 7,
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
  const port = createWorkerToolPort(registry, {
    async execute(input) {
      coordinated += 1;
      return await input.execute();
    },
  });
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
    actor: { type: "system", id: "test-supervisor" },
    iteration: 1,
    fencingToken: 1,
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
});

function compiledPolicy(verb: "GET" | "POST", effect: "read" | "write"): WorkerCompiledPolicy {
  const content: WorkerVersionContent = makeWorkerVersionContent({
    tools: [
      {
        id: "test-capability",
        tool: "http_fetch",
        verbs: [verb],
        resources: ["https://releases.example.test/api"],
        effect,
        approval: "never",
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
