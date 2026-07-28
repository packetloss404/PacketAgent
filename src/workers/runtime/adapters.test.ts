import assert from "node:assert/strict";
import test from "node:test";
import { ToolRegistry } from "../../tools/registry.js";
import type { ToolDefinition } from "../../tools/types.js";
import type { WorkerEffectCoordinator, WorkerEffectExecutionInput } from "../effects.js";
import type { WorkerToolCapability } from "../types.js";
import { createWorkerToolPort } from "./adapters.js";

test("Worker tool adapter routes mutations through the effect coordinator", async () => {
  const registry = new ToolRegistry();
  let receivedEffectKey: string | undefined;
  const tool: ToolDefinition = {
    name: "mutating_test_tool",
    description: "Mutates an external test target.",
    inputSchema: {},
    side: "write",
    effect: {
      describe: () => ({
        classification: "idempotent_mutation",
        operation: "test_target.set",
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

  const result = await port.execute({
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    workerVersionId: "worker-version-1",
    workerDeploymentId: "deployment-1",
    iteration: 2,
    fencingToken: 7,
    call: {
      id: "call-1",
      name: tool.name,
      input: { value: "ready" },
    },
    capability: capability({ effect: "write" }),
    signal: new AbortController().signal,
  });

  assert.equal(result.status, "ok");
  assert.equal(coordinated?.classification, "idempotent_mutation");
  assert.equal(coordinated?.operation, "test_target.set");
  assert.equal(receivedEffectKey, "sha256:test-effect-key");
});

test("Worker tool adapter denies a mutation declared through a read capability", async () => {
  const registry = new ToolRegistry();
  let handled = 0;
  registry.register({
    name: "mutating_test_tool",
    description: "Mutates an external test target.",
    inputSchema: {},
    side: "write",
    effect: {
      describe: () => ({
        classification: "non_replayable_mutation",
        operation: "test_target.append",
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

  const result = await port.execute({
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    workerVersionId: "worker-version-1",
    workerDeploymentId: "deployment-1",
    iteration: 1,
    fencingToken: 1,
    call: {
      id: "call-1",
      name: "mutating_test_tool",
      input: {},
    },
    capability: capability({ effect: "read" }),
    signal: new AbortController().signal,
  });

  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /outside capability/);
  assert.equal(coordinated, 0);
  assert.equal(handled, 0);
});

function capability(overrides: Partial<WorkerToolCapability> = {}): WorkerToolCapability {
  return {
    id: "test-capability",
    tool: "mutating_test_tool",
    verbs: ["SET"],
    resources: ["test://target"],
    effect: "write",
    approval: "never",
    ...overrides,
  };
}
