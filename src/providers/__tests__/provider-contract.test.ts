import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { ProviderRouter, resetDefaultRouterForTests, setDefaultRouter } from "../router.js";
import { resetStoreForTests } from "../../packetagent-store.js";
import { getDefaultToolRegistry, resetDefaultToolRegistryForTests } from "../../tools/registry.js";
import { runAgentLoop } from "../../tools/agent-loop.js";
import type { ToolDefinition } from "../../tools/types.js";
import type { LLMProvider, ProviderMessage, ProviderName, ProviderStreamChunk } from "../types.js";
import { AnthropicProvider } from "../anthropic.js";
import { OpenAIProvider } from "../openai.js";
import { StrictAnthropicServer, loadAnthropicTranscript } from "./strict-anthropic-server.js";
import { StrictOpenAIServer, loadOpenAITranscript } from "./strict-openai-server.js";

/**
 * End-to-end contract tests: `runAgentLoop` -> `ProviderRouter` -> real
 * provider adapter -> strict fake server that enforces the wire protocol and
 * answers from a recorded transcript. Anything the live API would 400 on
 * (missing tool_use replay, sampling params on the wrong model, unanswered
 * tool calls) fails here instead.
 */

const weatherTool: ToolDefinition = {
  name: "get_weather",
  description: "Current weather for a city",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  },
  side: "read",
  async handle(input) {
    const { city } = input as { city: string };
    return { ok: true, output: { city, tempC: 24, sky: "sunny" } };
  },
};

const timeTool: ToolDefinition = {
  name: "get_time",
  description: "Local time for an IANA zone",
  inputSchema: {
    type: "object",
    properties: { zone: { type: "string" } },
    required: ["zone"],
    additionalProperties: false,
  },
  side: "read",
  async handle(input) {
    const { zone } = input as { zone: string };
    return { ok: true, output: { zone, time: "09:30" } };
  },
};

const SYSTEM_PROMPT = "You are a weather assistant. Use tools for live data.";
const USER_PROMPT = "What is the weather like?";

function installRouter(name: ProviderName, provider: LLMProvider): void {
  resetStoreForTests();
  resetDefaultToolRegistryForTests();
  resetDefaultRouterForTests();
  const registry = getDefaultToolRegistry();
  registry.register(weatherTool);
  registry.register(timeTool);
  const router = new ProviderRouter();
  router.register(name, provider);
  setDefaultRouter(router);
}

function anthropicScenario(name: string) {
  const fixture = loadAnthropicTranscript();
  const scenario = fixture.scenarios[name];
  assert.ok(scenario, `anthropic fixture scenario "${name}" exists`);
  const server = new StrictAnthropicServer(scenario.turns);
  const provider = new AnthropicProvider({
    apiKeyResolver: async () => "test-key",
    clientFactory: () => server,
  });
  installRouter("anthropic", provider);
  return { server, provider, model: fixture.model };
}

function openAIScenario(name: string) {
  const fixture = loadOpenAITranscript();
  const scenario = fixture.scenarios[name];
  assert.ok(scenario, `openai fixture scenario "${name}" exists`);
  const server = new StrictOpenAIServer(scenario.turns);
  const provider = new OpenAIProvider({
    apiKeyResolver: async () => "test-key",
    clientFactory: () => server,
  });
  installRouter("openai", provider);
  return { server, provider, model: fixture.model };
}

function loop(providerName: ProviderName, model: string) {
  return runAgentLoop({
    workspaceId: "alpha",
    userId: "user-1",
    routeKey: "agent.reasoning",
    providerName,
    model,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: USER_PROMPT,
    toolNames: ["get_weather", "get_time"],
  });
}

async function drain(stream: AsyncIterable<ProviderStreamChunk>): Promise<ProviderStreamChunk[]> {
  const chunks: ProviderStreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function anthropicBlocks(message: Anthropic.MessageParam): Anthropic.ContentBlockParam[] {
  assert.ok(Array.isArray(message.content), "message content is a block array");
  return message.content;
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

test("anthropic contract: text-only turn sends the current request surface", async () => {
  const { server, model } = anthropicScenario("text_only");
  const result = await loop("anthropic", model);

  assert.equal(result.finishReason, "stop");
  assert.equal(result.finalContent, "Lisbon is the capital of Portugal.");
  assert.equal(result.turnsUsed, 1);
  assert.equal(server.remainingTurns, 0);

  const [request] = server.requests;
  assert.equal(request.model, model);
  assert.equal(request.max_tokens, 2048);
  assert.equal(request.system, SYSTEM_PROMPT);
  assert.deepEqual(request.thinking, { type: "adaptive" });
  assert.equal("temperature" in request, false);
  assert.deepEqual(
    request.tools?.map((tool) => tool.name),
    ["get_weather", "get_time"],
  );
  assert.deepEqual(request.messages, [{ role: "user", content: USER_PROMPT }]);
});

test("anthropic contract: single tool call is replayed as tool_use before its tool_result", async () => {
  const { server, model } = anthropicScenario("single_tool_call");
  const result = await loop("anthropic", model);

  assert.equal(result.finishReason, "stop");
  assert.equal(result.finalContent, "It is 24C and sunny in Lisbon.");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].status, "ok");
  assert.deepEqual(result.toolCalls[0].output, { city: "Lisbon", tempC: 24, sky: "sunny" });
  assert.equal(server.requests.length, 2);
  assert.equal(server.remainingTurns, 0);

  const second = server.requests[1].messages;
  assert.equal(second.length, 3);
  assert.deepEqual(second[1], {
    role: "assistant",
    content: [
      { type: "text", text: "Let me check the weather." },
      { type: "tool_use", id: "toolu_01A1", name: "get_weather", input: { city: "Lisbon" } },
    ],
  });
  const [toolResult] = anthropicBlocks(second[2]);
  assert.equal(toolResult.type, "tool_result");
  assert.equal(toolResult.tool_use_id, "toolu_01A1");
  assert.deepEqual(JSON.parse(toolResult.content as string), {
    result: { city: "Lisbon", tempC: 24, sky: "sunny" },
  });
});

test("anthropic contract: parallel tool calls return every result in one user message", async () => {
  const { server, model } = anthropicScenario("parallel_tool_calls");
  const result = await loop("anthropic", model);

  assert.equal(result.finishReason, "stop");
  assert.deepEqual(
    result.toolCalls.map((call) => [call.toolName, call.status]),
    [
      ["get_weather", "ok"],
      ["get_time", "ok"],
    ],
  );
  const second = server.requests[1].messages;
  assert.equal(second.length, 3, "both results are folded into a single user message");
  assert.deepEqual(
    anthropicBlocks(second[2]).map((block) => [
      block.type,
      (block as { tool_use_id: string }).tool_use_id,
    ]),
    [
      ["tool_result", "toolu_02A1"],
      ["tool_result", "toolu_02A2"],
    ],
  );
  assert.equal(server.remainingTurns, 0);
});

test("anthropic contract: malformed tool input gets one correction and every id a tool_result", async () => {
  const { server, model } = anthropicScenario("malformed_then_correction");
  const result = await loop("anthropic", model);

  assert.equal(result.finishReason, "stop");
  assert.equal(result.turnsUsed, 3);
  assert.equal(result.finalContent, "Lisbon is 24C and sunny.");
  assert.deepEqual(
    result.toolCalls.map((call) => call.id),
    ["toolu_03B1"],
    "only the corrected call is executed",
  );
  assert.equal(server.requests.length, 3);
  assert.equal(server.remainingTurns, 0);

  const correction = server.requests[1].messages;
  assert.equal(correction[1].role, "assistant");
  assert.deepEqual(
    anthropicBlocks(correction[1]).map((block) => block.type),
    ["tool_use", "tool_use"],
  );
  assert.deepEqual(
    anthropicBlocks(correction[2]).map((block) => (block as { tool_use_id: string }).tool_use_id),
    ["toolu_03A1", "toolu_03A2"],
    "the garbled call and its sibling both get a tool_result",
  );
  assert.equal(correction[3].role, "user");
  assert.match(String(correction[3].content), /malformed JSON arguments/);

  const final = server.requests[2].messages;
  assert.equal(final.length, 6);
  assert.equal(final[5].role, "user");
  assert.equal(anthropicBlocks(final[5])[0].type, "tool_result");
});

test("anthropic contract: refusal stop reason ends the loop with stop details", async () => {
  const { server, model } = anthropicScenario("refusal");
  const result = await loop("anthropic", model);

  assert.equal(result.finishReason, "refusal");
  assert.equal(result.turnsUsed, 1);
  assert.equal(result.toolCalls.length, 0);
  assert.deepEqual(result.stopDetails, {
    category: "cyber",
    explanation: "The request was declined by a safety classifier.",
  });
  assert.equal(server.requests.length, 1, "no retry after a refusal");
  assert.equal(server.remainingTurns, 0);
});

test("anthropic contract: streamed tool input deltas are reassembled and replay cleanly", async () => {
  const { server, provider, model } = anthropicScenario("streaming_tool_input_deltas");
  const messages: ProviderMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: USER_PROMPT },
  ];
  const tools = [weatherTool, timeTool].map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  const chunks = await drain(
    provider.stream({ model, workspaceId: "alpha", routeKey: "agent.reasoning", messages, tools }),
  );

  assert.equal(
    chunks.some((chunk) => chunk.error),
    false,
  );
  assert.equal(
    chunks
      .filter((chunk) => chunk.delta)
      .map((chunk) => chunk.delta)
      .join(""),
    "Checking the weather.",
  );
  const toolCall = chunks.find((chunk) => chunk.toolCall)?.toolCall;
  assert.deepEqual(toolCall, {
    id: "toolu_stream_01",
    name: "get_weather",
    input: { city: "Oslo" },
  });
  const done = chunks.at(-1);
  assert.equal(done?.done, true);
  assert.equal(done?.finishReason, "tool_use");
  assert.equal(done?.usage?.promptTokens, 210);
  assert.equal(done?.usage?.completionTokens, 48);

  // Replay the streamed call the way the loop does and make sure the strict
  // server accepts the second turn.
  messages.push({ role: "assistant", content: "Checking the weather.", toolCalls: [toolCall!] });
  messages.push({
    role: "tool",
    toolCallId: toolCall!.id,
    toolName: toolCall!.name,
    content: JSON.stringify({ result: { city: "Oslo", tempC: 24, sky: "sunny" } }),
  });
  const final = await provider.call({
    model,
    workspaceId: "alpha",
    routeKey: "agent.reasoning",
    messages,
    tools,
  });
  assert.equal(final.finishReason, "stop");
  assert.equal(final.content, "Oslo is 24C and sunny.");
  assert.equal(server.requests.length, 2);
  assert.equal(server.remainingTurns, 0);
});

test("anthropic contract: malformed streamed tool input is flagged, not thrown", async () => {
  const { provider, model } = anthropicScenario("streaming_malformed_tool_input");
  const chunks = await drain(
    provider.stream({
      model,
      workspaceId: "alpha",
      routeKey: "agent.reasoning",
      messages: [{ role: "user", content: USER_PROMPT }],
    }),
  );
  const toolCall = chunks.find((chunk) => chunk.toolCall)?.toolCall;
  assert.deepEqual(toolCall, {
    id: "toolu_stream_bad_01",
    name: "get_weather",
    input: {},
    inputError: "malformed_json",
  });
  assert.equal(chunks.at(-1)?.finishReason, "tool_use");
});

test("anthropic contract: streamed refusal surfaces on the done chunk", async () => {
  const { provider, model } = anthropicScenario("streaming_refusal");
  const chunks = await drain(
    provider.stream({
      model,
      workspaceId: "alpha",
      routeKey: "agent.reasoning",
      messages: [{ role: "user", content: USER_PROMPT }],
    }),
  );
  const done = chunks.at(-1);
  assert.equal(done?.done, true);
  assert.equal(done?.finishReason, "refusal");
  assert.deepEqual(done?.stopDetails, {
    category: "bio",
    explanation: "The request was declined by a safety classifier.",
  });
});

test("anthropic contract: a history that drops the tool_use replay is rejected with 400", async () => {
  const { provider, model } = anthropicScenario("single_tool_call");
  // This is exactly what the loop used to send: the assistant turn without
  // its tool_use blocks, followed by a tool_result nobody asked for.
  await assert.rejects(
    provider.call({
      model,
      workspaceId: "alpha",
      routeKey: "agent.reasoning",
      messages: [
        { role: "user", content: USER_PROMPT },
        { role: "assistant", content: "Let me check the weather." },
        { role: "tool", toolCallId: "toolu_01A1", toolName: "get_weather", content: "{}" },
      ],
    }),
    (error: unknown) => {
      assert.ok(error instanceof Anthropic.BadRequestError);
      assert.equal(error.status, 400);
      assert.match(error.message, /tool_use_id found in tool_result/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// OpenAI (and, by wire format, OpenRouter / MiniMax / Ollama-compatible)
// ---------------------------------------------------------------------------

test("openai contract: text-only turn", async () => {
  const { server, model } = openAIScenario("text_only");
  const result = await loop("openai", model);

  assert.equal(result.finishReason, "stop");
  assert.equal(result.finalContent, "Lisbon is the capital of Portugal.");
  assert.equal(server.remainingTurns, 0);
  const [request] = server.requests;
  assert.equal(request.model, model);
  assert.equal(request.max_tokens, 2048);
  assert.deepEqual(request.messages, [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: USER_PROMPT },
  ]);
  assert.deepEqual(
    request.tools?.map((tool) => (tool.type === "function" ? tool.function.name : tool.type)),
    ["get_weather", "get_time"],
  );
});

test("openai contract: single tool call is replayed as assistant tool_calls before the tool message", async () => {
  const { server, model } = openAIScenario("single_tool_call");
  const result = await loop("openai", model);

  assert.equal(result.finishReason, "stop");
  assert.equal(result.finalContent, "It is 24C and sunny in Lisbon.");
  assert.deepEqual(result.toolCalls[0].output, { city: "Lisbon", tempC: 24, sky: "sunny" });
  assert.equal(server.requests.length, 2);
  assert.equal(server.remainingTurns, 0);

  const second = server.requests[1].messages;
  assert.equal(second.length, 4);
  assert.deepEqual(second[2], {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call_A1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Lisbon"}' },
      },
    ],
  });
  assert.equal(second[3].role, "tool");
  assert.equal((second[3] as { tool_call_id: string }).tool_call_id, "call_A1");
});

test("openai contract: parallel tool calls each get a tool message", async () => {
  const { server, model } = openAIScenario("parallel_tool_calls");
  const result = await loop("openai", model);

  assert.equal(result.finishReason, "stop");
  assert.deepEqual(
    result.toolCalls.map((call) => call.toolName),
    ["get_weather", "get_time"],
  );
  const second = server.requests[1].messages;
  assert.deepEqual(
    second.filter((message) => message.role === "tool").map((message) => message.tool_call_id),
    ["call_B1", "call_B2"],
  );
  assert.equal(server.remainingTurns, 0);
});

test("openai contract: malformed tool arguments get one correction and every id a tool message", async () => {
  const { server, model } = openAIScenario("malformed_then_correction");
  const result = await loop("openai", model);

  assert.equal(result.finishReason, "stop");
  assert.equal(result.turnsUsed, 3);
  assert.deepEqual(
    result.toolCalls.map((call) => call.id),
    ["call_C3"],
  );
  const correction = server.requests[1].messages;
  assert.deepEqual(
    correction.filter((message) => message.role === "tool").map((message) => message.tool_call_id),
    ["call_C1", "call_C2"],
  );
  assert.equal(correction.at(-1)?.role, "user");
  assert.equal(server.requests.length, 3);
  assert.equal(server.remainingTurns, 0);
});

test("openai contract: content_filter refusal ends the loop with stop details", async () => {
  const { server, model } = openAIScenario("refusal");
  const result = await loop("openai", model);

  assert.equal(result.finishReason, "refusal");
  assert.equal(result.turnsUsed, 1);
  assert.deepEqual(result.stopDetails, {
    category: "content_filter",
    explanation: "I can't help with that request.",
  });
  assert.equal(server.requests.length, 1);
});

test("openai contract: streamed tool arguments are reassembled and replay cleanly", async () => {
  const { server, provider, model } = openAIScenario("streaming_tool_input_deltas");
  const messages: ProviderMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: USER_PROMPT },
  ];
  const tools = [weatherTool].map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  const chunks = await drain(
    provider.stream({ model, workspaceId: "alpha", routeKey: "agent.reasoning", messages, tools }),
  );
  assert.equal(
    chunks.some((chunk) => chunk.error),
    false,
  );
  assert.equal(
    chunks
      .filter((chunk) => chunk.delta)
      .map((chunk) => chunk.delta)
      .join(""),
    "Checking the weather.",
  );
  const toolCall = chunks.find((chunk) => chunk.toolCall)?.toolCall;
  assert.deepEqual(toolCall, { id: "call_S1", name: "get_weather", input: { city: "Oslo" } });
  const done = chunks.at(-1);
  assert.equal(done?.finishReason, "tool_use");
  assert.equal(done?.usage?.promptTokens, 205);

  messages.push({ role: "assistant", content: "Checking the weather.", toolCalls: [toolCall!] });
  messages.push({
    role: "tool",
    toolCallId: toolCall!.id,
    toolName: toolCall!.name,
    content: JSON.stringify({ result: { city: "Oslo", tempC: 24, sky: "sunny" } }),
  });
  const final = await provider.call({
    model,
    workspaceId: "alpha",
    routeKey: "agent.reasoning",
    messages,
    tools,
  });
  assert.equal(final.content, "Oslo is 24C and sunny.");
  assert.equal(server.remainingTurns, 0);
});

test("openai contract: a history that drops the tool_calls replay is rejected with 400", async () => {
  const { provider, model } = openAIScenario("single_tool_call");
  await assert.rejects(
    provider.call({
      model,
      workspaceId: "alpha",
      routeKey: "agent.reasoning",
      messages: [
        { role: "user", content: USER_PROMPT },
        { role: "assistant", content: "Let me check the weather." },
        { role: "tool", toolCallId: "call_A1", toolName: "get_weather", content: "{}" },
      ],
    }),
    (error: unknown) => {
      assert.ok(error instanceof OpenAI.BadRequestError);
      assert.equal(error.status, 400);
      assert.match(error.message, /must be a response to a preceding message with 'tool_calls'/);
      return true;
    },
  );
});
