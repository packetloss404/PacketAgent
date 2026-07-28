import assert from "node:assert/strict";
import test from "node:test";
import { compileWorkerCapabilityPolicy } from "../../workers/capabilities.js";
import { makeWorkerVersionContent } from "../../workers/__tests__/fixtures.js";
import type { WorkerCompiledPolicy } from "../../workers/types.js";
import type { WorkerToolRuntimeServices } from "../../workers/runtime-services.js";
import { WORKER_CREDENTIAL_SCHEMA_VERSION } from "../../workers/credential-types.js";
import { computeWorkerVersionContentDigest } from "../../workers/validation.js";
import { executeTool } from "../executor.js";
import { createHttpFetchTool } from "../http-fetch.js";
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

test("Worker credentials resolve only after policy approval and immediately before hardened I/O", async () => {
  const order: string[] = [];
  const policy = policyFor("https://releases.example.test/api/*");
  const services: WorkerToolRuntimeServices = {
    credentials: {
      async use(reference, expectedKinds, consumer) {
        order.push("credential");
        assert.equal(reference, "vault:release-api");
        assert.deepEqual(expectedKinds, ["api_key", "bearer_token", "opaque"]);
        return consumer("resolved-secret", {
          schemaVersion: WORKER_CREDENTIAL_SCHEMA_VERSION,
          id: "credential-1",
          workspaceId: "workspace-1",
          reference,
          kind: "bearer_token",
          label: "Release API",
          createdAt: "2026-07-27T12:00:00.000Z",
          updatedAt: "2026-07-27T12:00:00.000Z",
          encrypted: true,
        });
      },
    },
    network: {
      async request(input) {
        order.push("network");
        assert.equal(input.headers?.authorization, "Bearer resolved-secret");
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: '{"ok":true}',
          connectedAddress: "93.184.216.34",
        };
      },
    },
    sandbox: {
      async execute() {
        throw new Error("unused");
      },
    },
  };
  const tool = createHttpFetchTool();

  const denied = await executeTool({
    tool,
    input: {
      url: "https://admin.example.test/api/releases",
      credentialRef: "vault:release-api",
    },
    context: workerContext(
      policy,
      async () => {
        order.push("deny");
      },
      services,
    ),
  });
  assert.equal(denied.status, "error");
  assert.deepEqual(order, ["deny"]);

  order.length = 0;
  const allowed = await executeTool({
    tool,
    input: {
      url: "https://releases.example.test/api/releases",
      credentialRef: "vault:release-api",
    },
    context: workerContext(
      policy,
      async () => {
        order.push("allow");
      },
      services,
    ),
  });
  assert.equal(allowed.status, "ok");
  assert.deepEqual(order, ["allow", "credential", "network"]);
  assert.doesNotMatch(JSON.stringify(allowed), /resolved-secret/);
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
  services?: WorkerToolRuntimeServices,
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
        declaredCredentialRefs: ["vault:release-api"],
      },
      budget: {
        elapsedMs: 10,
        iterations: 1,
        providerCostUsd: 0,
        consecutiveFailures: 0,
        toolCalls: 1,
      },
      actor: { type: "system", id: "test-supervisor" },
      ...(services ? { services } : {}),
      recordPolicyDecision,
    },
  };
}
