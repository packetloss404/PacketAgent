import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AnthropicProvider,
  ANTHROPIC_MODEL_PRICING,
  resolveEffort,
  supportedEffortLevels,
  supportsAdaptiveThinking,
  supportsSamplingParameters,
  type AnthropicClient,
} from "../anthropic.js";

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

test("call() maps the canonical structured-output contract to output_config", async () => {
  let receivedParams: Record<string, unknown> = {};
  const provider = new AnthropicProvider({
    apiKeyResolver: async () => "test-key",
    clientFactory: () =>
      fakeClient({
        create: (async (params: Record<string, unknown>) => {
          receivedParams = params;
          return {
            id: "msg_1",
            content: [{ type: "text", text: '{"ok":true}' }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
            model: "claude-sonnet-4-6",
          };
        }) as unknown as AnthropicCreate,
      }),
  });
  const schema = {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  };
  await provider.call({
    model: "claude-sonnet-4-6",
    workspaceId: "ws-1",
    routeKey: "workflow.draft",
    messages: [{ role: "user", content: "return JSON" }],
    structuredOutput: { name: "result", schema },
  });
  assert.deepEqual(receivedParams.output_config, {
    format: { type: "json_schema", schema },
  });
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

test("call() prices cache read and cache write tokens and reports the full prompt size", async () => {
  const provider = new AnthropicProvider({
    apiKeyResolver: async () => "test-key",
    clientFactory: () =>
      fakeClient({
        create: (async () => ({
          id: "msg_1",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 1000,
            cache_creation_input_tokens: 200,
          },
          model: "claude-opus-4-7",
        })) as unknown as AnthropicCreate,
      }),
  });
  const result = await provider.call({
    model: "claude-opus-4-7",
    workspaceId: "ws-1",
    routeKey: "agent.reasoning",
    messages: [{ role: "user", content: "x" }],
  });
  const pricing = ANTHROPIC_MODEL_PRICING["claude-opus-4-7"];
  const expectedCost =
    (100 * pricing.input +
      1000 * pricing.input * 0.1 +
      200 * pricing.input * 1.25 +
      50 * pricing.output) /
    1_000_000;
  assert.equal(result.usage.promptTokens, 1300);
  assert.equal(result.usage.completionTokens, 50);
  assert.ok(Math.abs(result.usage.costUsd - expectedCost) < 1e-9);
});

test("supportsSamplingParameters() drops temperature only for models that reject it", () => {
  assert.equal(supportsSamplingParameters("claude-sonnet-4-6"), true);
  assert.equal(supportsSamplingParameters("claude-opus-4-6"), true);
  assert.equal(supportsSamplingParameters("claude-haiku-4-5-20251001"), true);
  assert.equal(supportsSamplingParameters("claude-opus-4-7"), false);
  assert.equal(supportsSamplingParameters("claude-opus-4-7[1m]"), false);
  assert.equal(supportsSamplingParameters("claude-opus-4-8"), false);
  assert.equal(supportsSamplingParameters("claude-opus-5"), false);
  assert.equal(supportsSamplingParameters("claude-sonnet-5"), false);
  assert.equal(supportsSamplingParameters("claude-fable-5-1"), false);
  assert.equal(supportsSamplingParameters("claude-mythos-5-1"), false);
  assert.equal(supportsSamplingParameters("some-custom-model"), true);
});

test("call() omits temperature for models that reject sampling parameters", async () => {
  const received: Record<string, unknown>[] = [];
  const provider = new AnthropicProvider({
    apiKeyResolver: async () => "test-key",
    clientFactory: () =>
      fakeClient({
        create: (async (params: Record<string, unknown>) => {
          received.push(params);
          return {
            id: "msg_1",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
            model: String(params.model),
          };
        }) as unknown as AnthropicCreate,
      }),
  });
  await provider.call({
    model: "claude-opus-4-7",
    workspaceId: "ws-1",
    routeKey: "agent.reasoning",
    temperature: 0.2,
    messages: [{ role: "user", content: "x" }],
  });
  await provider.call({
    model: "claude-sonnet-4-6",
    workspaceId: "ws-1",
    routeKey: "agent.reasoning",
    temperature: 0.2,
    messages: [{ role: "user", content: "x" }],
  });
  assert.equal("temperature" in received[0], false);
  assert.equal(received[1].temperature, 0.2);
});

test("stream() omits temperature for models that reject sampling parameters", async () => {
  let receivedParams: Record<string, unknown> = {};
  async function* events() {
    yield { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } };
    yield { type: "message_stop" };
  }
  const provider = new AnthropicProvider({
    apiKeyResolver: async () => "test-key",
    clientFactory: () =>
      fakeClient({
        stream: (async (params: Record<string, unknown>) => {
          receivedParams = params;
          return events();
        }) as unknown as StreamCreate,
      }),
  });
  for await (const _chunk of provider.stream({
    model: "claude-opus-4-8",
    workspaceId: "ws-1",
    routeKey: "workflow.draft",
    temperature: 0.2,
    messages: [{ role: "user", content: "hi" }],
  })) {
    // drain
  }
  assert.equal("temperature" in receivedParams, false);
});

test("call() replays assistant tool calls as tool_use blocks ahead of tool_result blocks", async () => {
  let receivedParams: { messages?: unknown[] } = {};
  const provider = new AnthropicProvider({
    apiKeyResolver: async () => "test-key",
    clientFactory: () =>
      fakeClient({
        create: (async (params: { messages?: unknown[] }) => {
          receivedParams = params;
          return {
            id: "msg_2",
            content: [{ type: "text", text: "done" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
            model: "claude-opus-4-7",
          };
        }) as unknown as AnthropicCreate,
      }),
  });
  await provider.call({
    model: "claude-opus-4-7",
    workspaceId: "ws-1",
    routeKey: "agent.reasoning",
    messages: [
      { role: "user", content: "search please" },
      {
        role: "assistant",
        content: "Searching.",
        toolCalls: [{ id: "tu_1", name: "search", input: { q: "x" } }],
      },
      { role: "tool", toolCallId: "tu_1", toolName: "search", content: '{"result":1}' },
    ],
  });
  assert.deepEqual(receivedParams.messages, [
    { role: "user", content: "search please" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Searching." },
        { type: "tool_use", id: "tu_1", name: "search", input: { q: "x" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: '{"result":1}' }],
    },
  ]);
});

test("call() sends adaptive thinking on 4.6+ models and omits it where unsupported", async () => {
  const received: Record<string, unknown>[] = [];
  const provider = new AnthropicProvider({
    apiKeyResolver: async () => "test-key",
    clientFactory: () =>
      fakeClient({
        create: (async (params: Record<string, unknown>) => {
          received.push(params);
          return {
            id: "msg_1",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
            model: String(params.model),
          };
        }) as unknown as AnthropicCreate,
      }),
  });
  const base = {
    workspaceId: "ws-1",
    routeKey: "agent.reasoning",
    messages: [{ role: "user" as const, content: "x" }],
  };
  await provider.call({ ...base, model: "claude-opus-4-7" });
  await provider.call({ ...base, model: "claude-sonnet-4-6" });
  await provider.call({ ...base, model: "claude-fable-5-1" });
  await provider.call({ ...base, model: "claude-haiku-4-5" });
  // A caller temperature wins over thinking on models that accept both.
  await provider.call({ ...base, model: "claude-sonnet-4-6", temperature: 0.3 });
  assert.deepEqual(received[0].thinking, { type: "adaptive" });
  assert.deepEqual(received[1].thinking, { type: "adaptive" });
  assert.deepEqual(received[2].thinking, { type: "adaptive" });
  assert.equal("thinking" in received[3], false);
  assert.equal("thinking" in received[4], false);
  assert.equal(received[4].temperature, 0.3);
  for (const params of received) {
    assert.equal("budget_tokens" in ((params.thinking as object | undefined) ?? {}), false);
  }
});

test("call() maps effort to output_config.effort and clamps levels the model rejects", async () => {
  const received: Record<string, unknown>[] = [];
  const provider = new AnthropicProvider({
    apiKeyResolver: async () => "test-key",
    clientFactory: () =>
      fakeClient({
        create: (async (params: Record<string, unknown>) => {
          received.push(params);
          return {
            id: "msg_1",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
            model: String(params.model),
          };
        }) as unknown as AnthropicCreate,
      }),
  });
  const base = {
    workspaceId: "ws-1",
    routeKey: "agent.reasoning",
    messages: [{ role: "user" as const, content: "x" }],
  };
  await provider.call({ ...base, model: "claude-opus-4-7", effort: "xhigh" });
  await provider.call({ ...base, model: "claude-sonnet-4-6", effort: "xhigh" });
  await provider.call({ ...base, model: "claude-haiku-4-5", effort: "low" });
  await provider.call({
    ...base,
    model: "claude-opus-5",
    effort: "max",
    structuredOutput: { name: "r", schema: { type: "object" } },
  });
  assert.deepEqual(received[0].output_config, { effort: "xhigh" });
  assert.deepEqual(received[1].output_config, { effort: "high" });
  assert.equal("output_config" in received[2], false);
  assert.deepEqual(received[3].output_config, {
    effort: "max",
    format: { type: "json_schema", schema: { type: "object" } },
  });
});

test("resolveEffort() and supportedEffortLevels() follow the per-model matrix", () => {
  assert.deepEqual(supportedEffortLevels("claude-opus-4-6"), ["low", "medium", "high", "max"]);
  assert.deepEqual(supportedEffortLevels("claude-opus-4-5"), ["low", "medium", "high"]);
  assert.deepEqual(supportedEffortLevels("claude-sonnet-4-5"), []);
  assert.equal(supportedEffortLevels("claude-sonnet-5").length, 5);
  assert.equal(resolveEffort("claude-opus-4-5", "max"), "high");
  assert.equal(resolveEffort("claude-sonnet-4-5", "low"), undefined);
  assert.equal(resolveEffort("claude-opus-4-7"), undefined);
  assert.equal(supportsAdaptiveThinking("claude-opus-4-5"), false);
  assert.equal(supportsAdaptiveThinking("claude-mythos-5-1"), true);
});

test("call() surfaces a refusal stop reason with structured stop details", async () => {
  const provider = new AnthropicProvider({
    apiKeyResolver: async () => "test-key",
    clientFactory: () =>
      fakeClient({
        create: (async () => ({
          id: "msg_1",
          content: [],
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: "cyber", explanation: "declined" },
          usage: { input_tokens: 10, output_tokens: 0 },
          model: "claude-opus-5",
        })) as unknown as AnthropicCreate,
      }),
  });
  const result = await provider.call({
    model: "claude-opus-5",
    workspaceId: "ws-1",
    routeKey: "agent.reasoning",
    messages: [{ role: "user", content: "x" }],
  });
  assert.equal(result.finishReason, "refusal");
  assert.equal(result.content, "");
  assert.deepEqual(result.stopDetails, { category: "cyber", explanation: "declined" });
});

test("stream() reports finishReason and stopDetails on the done chunk", async () => {
  async function* events() {
    yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } };
    yield {
      type: "message_delta",
      delta: {
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: null, explanation: "no" },
      },
      usage: { output_tokens: 1 },
    };
    yield { type: "message_stop" };
  }
  const provider = new AnthropicProvider({
    apiKeyResolver: async () => "test-key",
    clientFactory: () => fakeClient({ stream: (async () => events()) as unknown as StreamCreate }),
  });
  const chunks = [];
  for await (const chunk of provider.stream({
    model: "claude-opus-5",
    workspaceId: "ws-1",
    routeKey: "agent.reasoning",
    messages: [{ role: "user", content: "x" }],
  })) {
    chunks.push(chunk);
  }
  const done = chunks.at(-1);
  assert.equal(done?.done, true);
  assert.equal(done?.finishReason, "refusal");
  assert.deepEqual(done?.stopDetails, { category: null, explanation: "no" });
});

test("stream() reports an error when the injected client cannot stream", async () => {
  const provider = new AnthropicProvider({
    apiKeyResolver: async () => "test-key",
    clientFactory: () => fakeClient({}),
  });
  const chunks = [];
  for await (const chunk of provider.stream({
    model: "claude-opus-5",
    workspaceId: "ws-1",
    routeKey: "agent.reasoning",
    messages: [{ role: "user", content: "x" }],
  })) {
    chunks.push(chunk);
  }
  assert.deepEqual(chunks, [{ error: "anthropic: client does not support streaming" }]);
});
