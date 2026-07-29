import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileWorkerCapabilityPolicy } from "../../workers/capabilities.js";
import { makeWorkerVersionContent } from "../../workers/__tests__/fixtures.js";
import type { WorkerToolRuntimeServices } from "../../workers/runtime-services.js";
import { computeWorkerVersionContentDigest } from "../../workers/validation.js";
import { listDefaultTools } from "../bootstrap.js";
import { executeTool } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { createSandboxedShellTool } from "../sandbox.js";
import { createShellForAgentTool } from "../shell-agent.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolPolicyDecision,
  WorkerToolContext,
} from "../types.js";

test("every production registry entry denies direct Worker handler access", async () => {
  const registry = new ToolRegistry();
  registry.registerMany(listDefaultTools());
  let policyDecisions = 0;
  const context = directWorkerContext(async () => {
    policyDecisions += 1;
  });

  for (const tool of registry.list()) {
    const result = await tool.handle({}, context);
    assert.equal(result.ok, false, tool.name);
    assert.match(result.error ?? "", /must execute through executeTool/, tool.name);
    assert.equal(
      tool.effect?.reconcile,
      undefined,
      `${tool.name} adds an alternate effect path that needs the Worker execution guard`,
    );
  }

  assert.equal(policyDecisions, 0);
});

test("every production registry entry reaches fail-closed Worker policy through executeTool", async () => {
  const registry = new ToolRegistry();
  registry.registerMany(listDefaultTools());
  const decisions: ToolPolicyDecision[] = [];

  for (const tool of registry.list()) {
    const result = await executeTool({
      tool,
      input: {},
      context: {
        workspaceId: "workspace-1",
        userId: "packetagent.worker-supervisor",
        runId: "run-1",
        worker: worker(undefined, async (decision) => {
          decisions.push(decision);
        }),
      },
    });
    assert.equal(result.status, "error", tool.name);
    assert.match(result.error ?? "", /Worker policy denied/, tool.name);
  }

  assert.equal(decisions.length, registry.list().length);
  assert.equal(
    decisions.every((decision) => !decision.allowed),
    true,
  );
});

test("registered Worker execution permit is tool-bound and consumed before the handler", async () => {
  const registry = new ToolRegistry();
  const policy = policyFor("https://releases.example.test/api/*");
  let handled = 0;
  let nestedResult: Awaited<ReturnType<ToolDefinition["handle"]>> | undefined;
  let registeredTool: ToolDefinition;
  registry.register({
    name: "http_fetch",
    description: "Guarded test tool.",
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
    async handle(input, context) {
      handled += 1;
      nestedResult = await registeredTool.handle(input, context);
      return { ok: true };
    },
  });
  registeredTool = registry.get("http_fetch")!;

  const result = await executeTool({
    tool: registeredTool,
    input: { url: "https://releases.example.test/api/releases" },
    context: {
      workspaceId: "workspace-1",
      userId: "packetagent.worker-supervisor",
      worker: worker(policy, async () => {}),
    },
  });

  assert.equal(result.status, "ok");
  assert.equal(handled, 1);
  assert.equal(nestedResult?.ok, false);
  assert.match(nestedResult?.error ?? "", /must execute through executeTool/);
});

test("Worker command tools reject link and case-alias host cwd inputs before sandbox execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "packetagent-worker-cwd-"));
  const target = join(root, "target");
  const link = join(root, "linked-work");
  mkdirSync(target);
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  const caseAlias = process.platform === "win32" ? target.toUpperCase() : join(root, "TARGET");
  let sandboxExecutions = 0;
  const services = runtimeServices(async () => {
    sandboxExecutions += 1;
  });

  try {
    for (const entry of [
      {
        tool: createSandboxedShellTool({ allowedCommands: ["node"] }),
        input: { command: "node", args: ["--version"], cwd: link },
      },
      {
        tool: createShellForAgentTool({ allowedCommands: ["node"], projectRoot: root }),
        input: { command: "node", args: ["--version"], cwd: caseAlias },
      },
    ]) {
      const policy = policyForTool(entry.tool, entry.input);
      const result = await executeTool({
        tool: entry.tool,
        input: entry.input,
        context: {
          workspaceId: "workspace-1",
          userId: "packetagent.worker-supervisor",
          runId: "run-1",
          agentId: "worker-1",
          worker: {
            ...worker(policy, async () => {}),
            services,
          },
        },
      });

      assert.equal(result.status, "error", entry.tool.name);
      assert.match(result.error ?? "", /cannot use a host working directory/, entry.tool.name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  assert.equal(sandboxExecutions, 0);
});

function directWorkerContext(
  recordPolicyDecision: (decision: ToolPolicyDecision) => Promise<void>,
): ToolContext {
  return {
    workspaceId: "workspace-1",
    userId: "packetagent.worker-supervisor",
    runId: "run-1",
    signal: new AbortController().signal,
    worker: worker(undefined, recordPolicyDecision),
  };
}

function worker(
  compiledPolicy: ReturnType<typeof policyFor> | undefined,
  recordPolicyDecision: (decision: ToolPolicyDecision) => Promise<void>,
): WorkerToolContext {
  return {
    run: { id: "run-1" },
    deployment: {
      id: "deployment-1",
      revision: 3,
      ...(compiledPolicy ? { compiledPolicy } : {}),
    },
    version: {
      id: "worker-version-1",
      contentDigest: compiledPolicy?.workerVersionContentDigest ?? `sha256:${"1".repeat(64)}`,
      declaredCredentialRefs: [],
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
  };
}

function policyFor(resource: string) {
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

function policyForTool(tool: ToolDefinition, input: Record<string, unknown>) {
  const context: ToolContext = {
    workspaceId: "workspace-1",
    userId: "packetagent.worker-supervisor",
    runId: "run-1",
    agentId: "worker-1",
    signal: new AbortController().signal,
  };
  const descriptor = tool.authorization!.describe(input, context);
  const capability = {
    id: "command-execute",
    tool: tool.name,
    verbs: [descriptor.verb],
    resources: [...descriptor.resources],
    effect: descriptor.effect,
    approval: "never" as const,
  };
  const content = makeWorkerVersionContent({
    tools: [capability],
    credentialRefs: [],
    policy: {
      ...makeWorkerVersionContent().policy,
      permissions: {
        default: "deny",
        allowedCapabilityIds: [capability.id],
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

function runtimeServices(onSandboxExecute: () => Promise<void>): WorkerToolRuntimeServices {
  return {
    credentials: {
      async use() {
        throw new Error("credential resolution must not run");
      },
    },
    network: {
      async request() {
        throw new Error("network must not run");
      },
    },
    sandbox: {
      async execute() {
        await onSandboxExecute();
        throw new Error("sandbox must not run");
      },
    },
    smtp: {
      async send() {
        throw new Error("SMTP must not run");
      },
    },
  };
}
