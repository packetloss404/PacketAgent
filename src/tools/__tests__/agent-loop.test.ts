import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resetDefaultRouterForTests,
  ProviderRouter,
  getDefaultRouter,
  setDefaultRouter,
} from "../../providers/router.js";
import { resetStoreForTests } from "../../packetagent-store.js";
import { resetDefaultToolRegistryForTests, getDefaultToolRegistry } from "../registry.js";
import type {
  LLMProvider,
  ProviderCallOptions,
  ProviderCallResult,
  ProviderStreamChunk,
} from "../../providers/types.js";
import { runAgentLoop } from "../agent-loop.js";
import type { ToolDefinition } from "../types.js";

function scriptedProvider(scripts: ProviderCallResult[]): LLMProvider {
  let cursor = 0;
  return {
    name: "anthropic",
    async call(_opts: ProviderCallOptions): Promise<ProviderCallResult> {
      const next = scripts[cursor++];
      if (!next) throw new Error("no more scripted responses");
      return next;
    },
    async *stream(): AsyncIterable<ProviderStreamChunk> {
      yield { done: true, usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 } };
    },
    async models() {
      return ["scripted"];
    },
  };
}

const echoTool: ToolDefinition = {
  name: "echo_tool",
  description: "Echo input",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  side: "read",
  async handle(input) {
    return { ok: true, output: { echo: (input as { text: string }).text } };
  },
};

test("loop returns immediately when model finishes without tool calls", async () => {
  resetStoreForTests();
  resetDefaultToolRegistryForTests();
  resetDefaultRouterForTests();
  getDefaultToolRegistry().register(echoTool);
  const router = new ProviderRouter();
  router.register(
    "anthropic",
    scriptedProvider([
      {
        content: "Done.",
        finishReason: "stop",
        usage: { promptTokens: 5, completionTokens: 2, costUsd: 0.001 },
        model: "claude-opus-4-7",
        providerName: "anthropic",
      },
    ]),
  );
  setDefaultRouter(router);
  const result = await runAgentLoop({
    workspaceId: "alpha",
    userId: "user-1",
    routeKey: "agent.reasoning",
    systemPrompt: "you are a helper",
    userPrompt: "hi",
    toolNames: ["echo_tool"],
  });
  assert.equal(result.finishReason, "stop");
  assert.equal(result.finalContent, "Done.");
  assert.equal(result.toolCalls.length, 0);
  assert.equal(result.turnsUsed, 1);
});

test("loop executes tool calls and returns final answer", async () => {
  resetStoreForTests();
  resetDefaultToolRegistryForTests();
  resetDefaultRouterForTests();
  getDefaultToolRegistry().register(echoTool);
  const router = new ProviderRouter();
  router.register(
    "anthropic",
    scriptedProvider([
      {
        content: "",
        finishReason: "tool_use",
        toolCalls: [{ id: "call-1", name: "echo_tool", input: { text: "hello" } }],
        usage: { promptTokens: 5, completionTokens: 5, costUsd: 0.002 },
        model: "claude-opus-4-7",
        providerName: "anthropic",
      },
      {
        content: "I echoed: hello",
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 3, costUsd: 0.001 },
        model: "claude-opus-4-7",
        providerName: "anthropic",
      },
    ]),
  );
  setDefaultRouter(router);
  const result = await runAgentLoop({
    workspaceId: "alpha",
    userId: "user-1",
    routeKey: "agent.reasoning",
    systemPrompt: "you are a helper",
    userPrompt: "echo hello",
    toolNames: ["echo_tool"],
  });
  assert.equal(result.finishReason, "stop");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].toolName, "echo_tool");
  assert.equal(result.toolCalls[0].status, "ok");
  assert.deepEqual(result.toolCalls[0].output, { echo: "hello" });
  assert.equal(result.finalContent, "I echoed: hello");
  assert.equal(result.turnsUsed, 2);
});

test("loop terminates with max_turns when model keeps calling tools", async () => {
  resetStoreForTests();
  resetDefaultToolRegistryForTests();
  resetDefaultRouterForTests();
  getDefaultToolRegistry().register(echoTool);
  const router = new ProviderRouter();
  router.register(
    "anthropic",
    scriptedProvider(
      Array.from({ length: 5 }, () => ({
        content: "",
        finishReason: "tool_use" as const,
        toolCalls: [{ id: "call-x", name: "echo_tool", input: { text: "again" } }],
        usage: { promptTokens: 5, completionTokens: 5, costUsd: 0 },
        model: "claude-opus-4-7",
        providerName: "anthropic" as const,
      })),
    ),
  );
  setDefaultRouter(router);
  const result = await runAgentLoop({
    workspaceId: "alpha",
    userId: "user-1",
    routeKey: "agent.reasoning",
    systemPrompt: "you are a helper",
    userPrompt: "echo forever",
    toolNames: ["echo_tool"],
    maxTurns: 3,
  });
  assert.equal(result.finishReason, "max_turns");
  assert.equal(result.toolCalls.length, 3);
  assert.equal(result.turnsUsed, 3);
});

test("unknown tool produces a synthetic error result and the loop continues", async () => {
  resetStoreForTests();
  resetDefaultToolRegistryForTests();
  resetDefaultRouterForTests();
  getDefaultToolRegistry().register(echoTool);
  const router = new ProviderRouter();
  router.register(
    "anthropic",
    scriptedProvider([
      {
        content: "",
        finishReason: "tool_use",
        toolCalls: [{ id: "call-1", name: "missing_tool", input: {} }],
        usage: { promptTokens: 5, completionTokens: 5, costUsd: 0 },
        model: "claude-opus-4-7",
        providerName: "anthropic",
      },
      {
        content: "Sorry, that tool is not available.",
        finishReason: "stop",
        usage: { promptTokens: 5, completionTokens: 5, costUsd: 0 },
        model: "claude-opus-4-7",
        providerName: "anthropic",
      },
    ]),
  );
  setDefaultRouter(router);
  const result = await runAgentLoop({
    workspaceId: "alpha",
    userId: "user-1",
    routeKey: "agent.reasoning",
    systemPrompt: "you are a helper",
    userPrompt: "test missing tool",
    toolNames: ["echo_tool"],
  });
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].status, "error");
  assert.match(result.toolCalls[0].error ?? "", /not registered/);
  assert.equal(result.finishReason, "stop");
});
