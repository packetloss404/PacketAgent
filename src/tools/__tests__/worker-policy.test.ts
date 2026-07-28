import assert from "node:assert/strict";
import test from "node:test";
import { compileWorkerCapabilityPolicy } from "../../workers/capabilities.js";
import { makeWorkerVersionContent } from "../../workers/__tests__/fixtures.js";
import type { WorkerCompiledPolicy } from "../../workers/types.js";
import { computeWorkerVersionContentDigest } from "../../workers/validation.js";
import { executeTool } from "../executor.js";
import type { ToolContext, ToolDefinition, ToolPolicyDecision } from "../types.js";

test("executeTool records an allow decision before the Worker handler receives full context", async () => {
  const order: string[] = [];
  const decisions: ToolPolicyDecision[] = [];
  const policy = policyFor("https://releases.example.test/api/*");
  const tool = workerHttpTool(async (_input, context) => {
    order.push("handle");
    assert.equal(context.worker?.run.id, "run-1");
    assert.equal(context.worker?.deployment.id, "deployment-1");
    assert.equal(context.worker?.version.contentDigest, policy.workerVersionContentDigest);
    assert.equal(context.worker?.capability?.id, "release-read");
    assert.equal(context.worker?.budget.toolCalls, 1);
    assert.equal(context.worker?.effect?.effect, "read");
    assert.equal(context.worker?.actor.id, "test-supervisor");
    return { ok: true, output: { observed: true } };
  });

  const result = await executeTool({
    tool,
    input: { url: "https://releases.example.test/api/releases?token=secret" },
    context: workerContext(policy, async (decision) => {
      order.push("decision");
      decisions.push(decision);
    }),
  });

  assert.equal(result.status, "ok");
  assert.deepEqual(order, ["decision", "handle"]);
  assert.equal(decisions[0].allowed, true);
  assert.equal(decisions[0].capabilityId, "release-read");
  assert.doesNotMatch(JSON.stringify(decisions[0]), /token|secret|releases\.example/);
});

test("executeTool denies an undeclared Worker resource before the handler", async () => {
  let handled = 0;
  const decisions: ToolPolicyDecision[] = [];
  const policy = policyFor("https://releases.example.test/api/*");
  const tool = workerHttpTool(async () => {
    handled += 1;
    return { ok: true };
  });

  const result = await executeTool({
    tool,
    input: { url: "https://admin.example.test/api/releases" },
    context: workerContext(policy, async (decision) => {
      decisions.push(decision);
    }),
  });

  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /capability_not_granted/);
  assert.equal(handled, 0);
  assert.equal(decisions[0].allowed, false);
  assert.equal(decisions[0].code, "capability_not_granted");
});

test("executeTool fails closed for a missing descriptor or tampered compiled policy", async () => {
  let handled = 0;
  const policy = policyFor("https://releases.example.test/api/*");
  const withoutDescriptor: ToolDefinition = {
    name: "http_fetch",
    description: "Missing authorization metadata.",
    inputSchema: {},
    side: "read",
    async handle() {
      handled += 1;
      return { ok: true };
    },
  };
  const missingDecisions: ToolPolicyDecision[] = [];
  const missing = await executeTool({
    tool: withoutDescriptor,
    input: { url: "https://releases.example.test/api/releases" },
    context: workerContext(policy, async (decision) => {
      missingDecisions.push(decision);
    }),
  });
  assert.equal(missing.status, "error");
  assert.equal(missingDecisions[0].code, "missing_authorization_descriptor");

  const tamperedDecisions: ToolPolicyDecision[] = [];
  const tampered = await executeTool({
    tool: workerHttpTool(async () => {
      handled += 1;
      return { ok: true };
    }),
    input: { url: "https://releases.example.test/api/releases" },
    context: workerContext(
      { ...policy, policyDigest: `sha256:${"0".repeat(64)}` },
      async (decision) => {
        tamperedDecisions.push(decision);
      },
    ),
  });
  assert.equal(tampered.status, "error");
  assert.equal(tamperedDecisions[0].code, "tampered_policy");
  assert.equal(handled, 0);
});

function workerHttpTool(handle: ToolDefinition["handle"]): ToolDefinition {
  return {
    name: "http_fetch",
    description: "Test Worker HTTP tool.",
    inputSchema: {},
    side: "read",
    effect: {
      describe: () => ({
        classification: "read_only",
        operation: "http.get",
      }),
    },
    authorization: {
      describe: (input) => ({
        verb: "GET",
        effect: "read",
        resources: [String(input.url ?? "")],
      }),
    },
    handle,
  };
}

function policyFor(resource: string): WorkerCompiledPolicy {
  const content = makeWorkerVersionContent({
    tools: [
      {
        id: "release-read",
        tool: "http_fetch",
        verbs: ["GET"],
        resources: [resource],
        effect: "read",
        approval: "never",
      },
    ],
  });
  const contentDigest = computeWorkerVersionContentDigest(content);
  return compileWorkerCapabilityPolicy({
    workerVersionContentDigest: contentDigest,
    requestedCapabilities: content.tools,
    allowedCapabilityIds: content.policy.permissions.allowedCapabilityIds,
    credentialRefs: content.credentialRefs,
  }).policy;
}

function workerContext(
  policy: WorkerCompiledPolicy,
  recordPolicyDecision: (decision: ToolPolicyDecision) => Promise<void>,
): Omit<ToolContext, "signal"> {
  return {
    workspaceId: "workspace-1",
    userId: "packetagent.worker-supervisor",
    runId: "run-1",
    worker: {
      run: { id: "run-1" },
      deployment: {
        id: "deployment-1",
        revision: 3,
        compiledPolicy: policy,
      },
      version: {
        id: "worker-version-1",
        contentDigest: policy.workerVersionContentDigest,
      },
      budget: {
        elapsedMs: 10,
        iterations: 1,
        providerCostUsd: 0,
        consecutiveFailures: 0,
        toolCalls: 1,
      },
      actor: { type: "system", id: "test-supervisor" },
      recordPolicyDecision,
    },
  };
}
