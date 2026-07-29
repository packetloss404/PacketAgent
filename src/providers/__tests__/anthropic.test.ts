import { test } from "node:test";
import assert from "node:assert/strict";
import { AnthropicProvider, ANTHROPIC_MODEL_PRICING, type AnthropicClient } from "../anthropic.js";
import type {} from "../anthropic.js";

type AnthropicCreate = AnthropicClient["messages"]["create"];

function fakeClient(impl: Partial<AnthropicClient["messages"]>): AnthropicClient {
  return {
    messages: {
      create: (impl.create ??
        (async () => {
          throw new Error("not implemented");
        })) as AnthropicClient["messages"]["create"],
      ...(impl.stream ? { stream: impl.stream } : {}),
    },
  };
}

type StreamCreate = NonNullable<AnthropicClient["messages"]["stream"]>;

test("call() maps system messages and returns content + cost", async () => {
  let receivedParams: { system?: string | unknown[] } = {};
  const provider = new AnthropicProvider({
    apiKeyResolver: async () => "test-key",
    clientFactory: () =>
      fakeClient({
        create: (async (params: { system?: string | unknown[] }) => {
          receivedParams = params;
          return {
            id: "msg_1",
            content: [{ type: "text", text: "hello back" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 100, output_tokens: 50 },
            model: "claude-opus-4-7",
          };
        }) as unknown as AnthropicCreate,
      }),
  });
  const result = await provider.call({
    model: "claude-opus-4-7",
    workspaceId: "ws-1",
    routeKey: "workflow.draft",
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ],
  });
  assert.equal(result.content, "hello back");
  assert.equal(result.providerName, "anthropic");
  assert.equal(result.finishReason, "stop");
  assert.equal(result.model, "claude-opus-4-7");
  assert.equal(receivedParams?.system, "be brief");
  const expectedCost =
    (100 * ANTHROPIC_MODEL_PRICING["claude-opus-4-7"].input +
      50 * ANTHROPIC_MODEL_PRICING["claude-opus-4-7"].output) /
    1_000_000;
  assert.ok(Math.abs(result.usage.costUsd - expectedCost) < 1e-9);
});

test("call() returns toolCalls for tool_use blocks", async () => {
  const provider = new AnthropicProvider({
    apiKeyResolver: async () => "test-key",
    clientFactory: () =>
      fakeClient({
        create: (async () => ({
          id: "msg_1",
          content: [
            { type: "text", text: "thinking" },
            { type: "tool_use", id: "tool_1", name: "lookup", input: { q: "x" } },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 5 },
          model: "claude-sonnet-4-6",
        })) as unknown as AnthropicCreate,
      }),
  });
  const result = await provider.call({
    model: "claude-sonnet-4-6",
    workspaceId: "ws-1",
    routeKey: "agent.summary",
    messages: [{ role: "user", content: "do thing" }],
    tools: [{ name: "lookup", description: "search", inputSchema: { type: "object" } }],
  });
  assert.equal(result.finishReason, "tool_use");
  assert.equal(result.toolCalls?.length, 1);
  assert.equal(result.toolCalls?.[0].name, "lookup");
  assert.deepEqual(result.toolCalls?.[0].input, { q: "x" });
});

test("call() unknown model has cost = 0", async () => {
  const provider = new AnthropicProvider({
    apiKeyResolver: async () => "test-key",
    clientFactory: () =>
      fakeClient({
        create: (async () => ({
          id: "msg_1",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 50 },
          model: "claude-future-9999",
        })) as unknown as AnthropicCreate,
      }),
  });
  const result = await provider.call({
    model: "claude-future-9999",
    workspaceId: "ws-1",
    routeKey: "agent.reasoning",
    messages: [{ role: "user", content: "x" }],
  });
  assert.equal(result.usage.costUsd, 0);
});

test("stream() yields text deltas then done with usage", async () => {
  async function* events() {
    yield { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } };
    yield { type: "content_block_start", index: 0, content_block: { type: "text" } };
    yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello " } };
    yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } };
    yield { type: "content_block_stop", index: 0 };
    yield { type: "message_delta", usage: { output_tokens: 4 } };
    yield { type: "message_stop" };
  }
  const provider = new AnthropicProvider({
    apiKeyResolver: async () => "test-key",
    clientFactory: () =>
      fakeClient({
        stream: (async () => events()) as unknown as StreamCreate,
      }),
  });
  const chunks: string[] = [];
  let done = false;
  for await (const chunk of provider.stream({
    model: "claude-opus-4-7",
    workspaceId: "ws-1",
    routeKey: "workflow.draft",
    messages: [{ role: "user", content: "hi" }],
  })) {
    if (chunk.delta) chunks.push(chunk.delta);
    if (chunk.done) {
      done = true;
      assert.equal(chunk.usage?.promptTokens, 10);
      assert.equal(chunk.usage?.completionTokens, 4);
      assert.ok(chunk.usage!.costUsd > 0);
    }
  }
  assert.equal(done, true);
  assert.equal(chunks.join(""), "hello world");
});

test("stream() emits a tool call when content block has streamed json", async () => {
  async function* events() {
    yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } };
    yield {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tu_1", name: "search" },
    };
    yield {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"q":' },
    };
    yield {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '"hi"}' },
    };
    yield { type: "content_block_stop", index: 0 };
    yield { type: "message_delta", usage: { output_tokens: 3 } };
  }
  const provider = new AnthropicProvider({
    apiKeyResolver: async () => "test-key",
    clientFactory: () =>
      fakeClient({
        stream: (async () => events()) as unknown as StreamCreate,
      }),
  });
  let toolCall: { name: string; input: Record<string, unknown> } | undefined;
  for await (const chunk of provider.stream({
    model: "claude-opus-4-7",
    workspaceId: "ws-1",
    routeKey: "agent.reasoning",
    messages: [{ role: "user", content: "search hi" }],
  })) {
    if (chunk.toolCall) toolCall = chunk.toolCall;
  }
  assert.equal(toolCall?.name, "search");
  assert.deepEqual(toolCall?.input, { q: "hi" });
});

test("apiKeyResolver null falls back to env var; both null throws", async () => {
  const original = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const provider = new AnthropicProvider({
    apiKeyResolver: async () => null,
    clientFactory: () => fakeClient({}),
  });
  await assert.rejects(
    () =>
      provider.call({
        model: "claude-opus-4-7",
        workspaceId: "ws-1",
        routeKey: "workflow.draft",
        messages: [{ role: "user", content: "hi" }],
      }),
    /no API key/,
  );
  process.env.ANTHROPIC_API_KEY = "from-env";
  let receivedKey = "";
  const provider2 = new AnthropicProvider({
    apiKeyResolver: async () => null,
    clientFactory: (key) => {
      receivedKey = key;
      return fakeClient({
        create: (async () => ({
          id: "1",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
          model: "claude-opus-4-7",
        })) as unknown as AnthropicCreate,
      });
    },
  });
  await provider2.call({
    model: "claude-opus-4-7",
    workspaceId: "ws-1",
    routeKey: "workflow.draft",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(receivedKey, "from-env");
  if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = original;
});

test("signal abort short-circuits the stream", async () => {
  const ctrl = new AbortController();
  async function* events() {
    yield { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } };
    yield { type: "content_block_start", index: 0, content_block: { type: "text" } };
    yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } };
    ctrl.abort();
    await new Promise((resolve) => setImmediate(resolve));
    yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "y" } };
    yield { type: "message_stop" };
  }
  const provider = new AnthropicProvider({
    apiKeyResolver: async () => "k",
    clientFactory: () => fakeClient({ stream: (async () => events()) as unknown as StreamCreate }),
  });
  const out: string[] = [];
  let sawError = false;
  for await (const chunk of provider.stream({
    model: "claude-opus-4-7",
    workspaceId: "ws-1",
    routeKey: "workflow.draft",
    messages: [{ role: "user", content: "hi" }],
    signal: ctrl.signal,
  })) {
    if (chunk.delta) out.push(chunk.delta);
    if (chunk.error === "aborted") sawError = true;
    if (chunk.done) break;
  }
  assert.equal(sawError, true);
});
