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

test("loop makes exactly one correction attempt for malformed tool input", async () => {
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
        toolCalls: [
          {
            id: "bad-call",
            name: "echo_tool",
            input: {},
            inputError: "malformed_json",
          },
        ],
        usage: { promptTokens: 5, completionTokens: 2, costUsd: 0.001 },
        model: "claude-opus-4-7",
        providerName: "anthropic",
      },
      {
        content: "",
        finishReason: "tool_use",
        toolCalls: [{ id: "fixed-call", name: "echo_tool", input: { text: "fixed" } }],
        usage: { promptTokens: 6, completionTokens: 2, costUsd: 0.001 },
        model: "claude-opus-4-7",
        providerName: "anthropic",
      },
      {
        content: "Corrected.",
        finishReason: "stop",
        usage: { promptTokens: 8, completionTokens: 1, costUsd: 0.001 },
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
    userPrompt: "echo fixed",
    toolNames: ["echo_tool"],
  });

  assert.equal(result.finishReason, "stop");
  assert.equal(result.turnsUsed, 3);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].id, "fixed-call");
  assert.deepEqual(result.toolCalls[0].output, { echo: "fixed" });
});

test("loop never executes a second malformed tool call", async () => {
  resetStoreForTests();
  resetDefaultToolRegistryForTests();
  resetDefaultRouterForTests();
  getDefaultToolRegistry().register(echoTool);
  const malformed = (id: string): ProviderCallResult => ({
    content: "",
    finishReason: "tool_use",
    toolCalls: [
      {
        id,
        name: "echo_tool",
        input: {},
        inputError: "malformed_json",
      },
    ],
    usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 },
    model: "claude-opus-4-7",
    providerName: "anthropic",
  });
  const router = new ProviderRouter();
  router.register("anthropic", scriptedProvider([malformed("bad-1"), malformed("bad-2")]));
  setDefaultRouter(router);

  const result = await runAgentLoop({
    workspaceId: "alpha",
    userId: "user-1",
    routeKey: "agent.reasoning",
    systemPrompt: "you are a helper",
    userPrompt: "echo fixed",
    toolNames: ["echo_tool"],
  });

  assert.equal(result.finishReason, "error");
  assert.equal(result.turnsUsed, 2);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].status, "error");
  assert.match(result.toolCalls[0].error ?? "", /after one correction attempt/);
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

test("loop replays the assistant tool-call turn before tool results on the next call", async () => {
  resetStoreForTests();
  resetDefaultToolRegistryForTests();
  resetDefaultRouterForTests();
  getDefaultToolRegistry().register(echoTool);
  const seen: ProviderCallOptions["messages"][] = [];
  const scripts: ProviderCallResult[] = [
    {
      content: "",
      finishReason: "tool_use",
      toolCalls: [{ id: "call-1", name: "echo_tool", input: { text: "hello" } }],
      usage: { promptTokens: 5, completionTokens: 5, costUsd: 0 },
      model: "claude-opus-4-7",
      providerName: "anthropic",
    },
    {
      content: "done",
      finishReason: "stop",
      usage: { promptTokens: 5, completionTokens: 5, costUsd: 0 },
      model: "claude-opus-4-7",
      providerName: "anthropic",
    },
  ];
  let cursor = 0;
  const router = new ProviderRouter();
  router.register("anthropic", {
    name: "anthropic",
    async call(opts) {
      seen.push(opts.messages.map((message) => ({ ...message })));
      return scripts[cursor++]!;
    },
    async *stream() {
      yield { done: true, usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 } };
    },
    async models() {
      return ["scripted"];
    },
  });
  setDefaultRouter(router);
  await runAgentLoop({
    workspaceId: "alpha",
    userId: "user-1",
    routeKey: "agent.reasoning",
    systemPrompt: "you are a helper",
    userPrompt: "echo hello",
    toolNames: ["echo_tool"],
  });
  assert.equal(seen.length, 2);
  const second = seen[1];
  const assistantIndex = second.findIndex((message) => message.role === "assistant");
  const toolIndex = second.findIndex((message) => message.role === "tool");
  assert.ok(assistantIndex >= 0, "assistant turn is replayed");
  assert.ok(toolIndex > assistantIndex, "tool result follows the assistant turn");
  assert.deepEqual(second[assistantIndex].toolCalls, [
    { id: "call-1", name: "echo_tool", input: { text: "hello" } },
  ]);
  assert.equal(second[toolIndex].toolCallId, "call-1");
});

test("loop gives every replayed tool call a result during a malformed-input correction", async () => {
  resetStoreForTests();
  resetDefaultToolRegistryForTests();
  resetDefaultRouterForTests();
  getDefaultToolRegistry().register(echoTool);
  const seen: ProviderCallOptions["messages"][] = [];
  const scripts: ProviderCallResult[] = [
    {
      content: "",
      finishReason: "tool_use",
      toolCalls: [
        { id: "bad-1", name: "echo_tool", input: {}, inputError: "malformed_json" },
        { id: "ok-1", name: "echo_tool", input: { text: "fine" } },
      ],
      usage: { promptTokens: 5, completionTokens: 5, costUsd: 0 },
      model: "claude-opus-4-7",
      providerName: "anthropic",
    },
    {
      content: "done",
      finishReason: "stop",
      usage: { promptTokens: 5, completionTokens: 5, costUsd: 0 },
      model: "claude-opus-4-7",
      providerName: "anthropic",
    },
  ];
  let cursor = 0;
  const router = new ProviderRouter();
  router.register("anthropic", {
    name: "anthropic",
    async call(opts) {
      seen.push(opts.messages.map((message) => ({ ...message })));
      return scripts[cursor++]!;
    },
    async *stream() {
      yield { done: true, usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 } };
    },
    async models() {
      return ["scripted"];
    },
  });
  setDefaultRouter(router);
  const result = await runAgentLoop({
    workspaceId: "alpha",
    userId: "user-1",
    routeKey: "agent.reasoning",
    systemPrompt: "you are a helper",
    userPrompt: "echo",
    toolNames: ["echo_tool"],
  });
  assert.equal(result.finishReason, "stop");
  assert.equal(result.toolCalls.length, 0, "nothing executed during the correction turn");
  const second = seen[1];
  const toolResultIds = second
    .filter((message) => message.role === "tool")
    .map((message) => message.toolCallId);
  assert.deepEqual(toolResultIds, ["bad-1", "ok-1"]);
  assert.equal(second.at(-1)?.role, "user");
});

test("loop treats a refusal as terminal and records the stop details", async () => {
  resetStoreForTests();
  resetDefaultToolRegistryForTests();
  resetDefaultRouterForTests();
  getDefaultToolRegistry().register(echoTool);
  let calls = 0;
  const router = new ProviderRouter();
  router.register("anthropic", {
    name: "anthropic",
    async call() {
      calls++;
      return {
        content: "",
        finishReason: "refusal",
        stopDetails: { category: "cyber", explanation: "declined" },
        usage: { promptTokens: 5, completionTokens: 0, costUsd: 0.0001 },
        model: "claude-opus-5",
        providerName: "anthropic",
      };
    },
    async *stream() {
      yield { done: true, usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 } };
    },
    async models() {
      return [];
    },
  });
  setDefaultRouter(router);
  const result = await runAgentLoop({
    workspaceId: "alpha",
    userId: "user-1",
    routeKey: "agent.reasoning",
    systemPrompt: "you are a helper",
    userPrompt: "do the thing",
    toolNames: ["echo_tool"],
    maxTurns: 4,
  });
  assert.equal(calls, 1, "no retry after a refusal");
  assert.equal(result.finishReason, "refusal");
  assert.equal(result.turnsUsed, 1);
  assert.deepEqual(result.stopDetails, { category: "cyber", explanation: "declined" });
  assert.equal(result.toolCalls.length, 0);
});
