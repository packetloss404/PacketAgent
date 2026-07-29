import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAIProvider, OPENAI_MODEL_PRICING, type OpenAIClient } from "../openai.js";

type Create = OpenAIClient["chat"]["completions"]["create"];

function fakeClient(impl: Partial<{ create: Create }>): OpenAIClient {
  return {
    chat: {
      completions: {
        create:
          impl.create ??
          ((async () => {
            throw new Error("not impl");
          }) as unknown as Create),
      },
    },
  };
}

test("call() maps roles correctly and returns content + cost", async () => {
  const provider = new OpenAIProvider({
    apiKeyResolver: async () => "k",
    clientFactory: () =>
      fakeClient({
        create: (async () => ({
          id: "c1",
          model: "gpt-4o-mini",
          choices: [
            { index: 0, message: { role: "assistant", content: "hi back" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
        })) as unknown as Create,
      }),
  });
  const result = await provider.call({
    model: "gpt-4o-mini",
    workspaceId: "ws-1",
    routeKey: "agent.summary",
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
    ],
  });
  assert.equal(result.content, "hi back");
  assert.equal(result.providerName, "openai");
  const expected =
    (100 * OPENAI_MODEL_PRICING["gpt-4o-mini"].input +
      200 * OPENAI_MODEL_PRICING["gpt-4o-mini"].output) /
    1_000_000;
  assert.ok(Math.abs(result.usage.costUsd - expected) < 1e-9);
});

test("call() maps the canonical structured-output contract to response_format", async () => {
  let captured: Record<string, unknown> = {};
  const provider = new OpenAIProvider({
    apiKeyResolver: async () => "k",
    clientFactory: () =>
      fakeClient({
        create: (async (params: Record<string, unknown>) => {
          captured = params;
          return {
            id: "c1",
            model: "gpt-4o-mini",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: '{"ok":true}' },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        }) as unknown as Create,
      }),
  });
  await provider.call({
    model: "gpt-4o-mini",
    workspaceId: "ws-1",
    routeKey: "workflow.draft",
    messages: [{ role: "user", content: "return JSON" }],
    structuredOutput: {
      name: "result",
      schema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
  });
  assert.deepEqual(captured.response_format, {
    type: "json_schema",
    json_schema: {
      name: "result",
      schema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
      strict: true,
    },
  });
});

test("call() maps tool_calls in response", async () => {
  const provider = new OpenAIProvider({
    apiKeyResolver: async () => "k",
    clientFactory: () =>
      fakeClient({
        create: (async () => ({
          id: "c1",
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "tc_1",
                    type: "function",
                    function: { name: "lookup", arguments: '{"q":"x"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
        })) as unknown as Create,
      }),
  });
  const result = await provider.call({
    model: "gpt-4o",
    workspaceId: "ws-1",
    routeKey: "agent.summary",
    messages: [{ role: "user", content: "do it" }],
    tools: [{ name: "lookup", description: "search", inputSchema: { type: "object" } }],
  });
  assert.equal(result.finishReason, "tool_use");
  assert.equal(result.toolCalls?.[0].name, "lookup");
  assert.deepEqual(result.toolCalls?.[0].input, { q: "x" });
});

test("stream() yields deltas, then aggregated tool call, then done", async () => {
  async function* events() {
    yield {
      id: "c1",
      model: "gpt-4o-mini",
      choices: [{ index: 0, delta: { content: "he" }, finish_reason: null }],
    };
    yield {
      id: "c1",
      model: "gpt-4o-mini",
      choices: [{ index: 0, delta: { content: "llo" }, finish_reason: null }],
    };
    yield {
      id: "c1",
      model: "gpt-4o-mini",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "tc1",
                type: "function",
                function: { name: "lookup", arguments: '{"q":' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    };
    yield {
      id: "c1",
      model: "gpt-4o-mini",
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '"hi"}' } }] },
          finish_reason: null,
        },
      ],
    };
    yield {
      id: "c1",
      model: "gpt-4o-mini",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    };
  }
  const provider = new OpenAIProvider({
    apiKeyResolver: async () => "k",
    clientFactory: () =>
      fakeClient({
        create: (async () => events()) as unknown as Create,
      }),
  });
  const text: string[] = [];
  let toolCall: { name: string; input: Record<string, unknown> } | undefined;
  let done = false;
  for await (const chunk of provider.stream({
    model: "gpt-4o-mini",
    workspaceId: "ws-1",
    routeKey: "agent.summary",
    messages: [{ role: "user", content: "hi" }],
  })) {
    if (chunk.delta) text.push(chunk.delta);
    if (chunk.toolCall) toolCall = chunk.toolCall;
    if (chunk.done) {
      done = true;
      assert.equal(chunk.usage?.promptTokens, 3);
    }
  }
  assert.equal(text.join(""), "hello");
  assert.deepEqual(toolCall, { name: "lookup", input: { q: "hi" }, id: "tc1" });
  assert.equal(done, true);
});

test("apiKeyResolver null falls back to env, both null throws", async () => {
  const original = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const provider = new OpenAIProvider({
    apiKeyResolver: async () => null,
    clientFactory: () => fakeClient({}),
  });
  await assert.rejects(
    () =>
      provider.call({
        model: "gpt-4o",
        workspaceId: "ws-1",
        routeKey: "agent.summary",
        messages: [{ role: "user", content: "x" }],
      }),
    /no API key/,
  );
  process.env.OPENAI_API_KEY = "from-env";
  let receivedKey = "";
  const provider2 = new OpenAIProvider({
    apiKeyResolver: async () => null,
    clientFactory: (key) => {
      receivedKey = key;
      return fakeClient({
        create: (async () => ({
          id: "1",
          model: "gpt-4o",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })) as unknown as Create,
      });
    },
  });
  await provider2.call({
    model: "gpt-4o",
    workspaceId: "ws-1",
    routeKey: "agent.summary",
    messages: [{ role: "user", content: "x" }],
  });
  assert.equal(receivedKey, "from-env");
  if (original === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = original;
});

test("unknown model has cost = 0", async () => {
  const provider = new OpenAIProvider({
    apiKeyResolver: async () => "k",
    clientFactory: () =>
      fakeClient({
        create: (async () => ({
          id: "c",
          model: "future-model",
          choices: [
            { index: 0, message: { role: "assistant", content: "x" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        })) as unknown as Create,
      }),
  });
  const result = await provider.call({
    model: "future-model",
    workspaceId: "ws-1",
    routeKey: "agent.summary",
    messages: [{ role: "user", content: "x" }],
  });
  assert.equal(result.usage.costUsd, 0);
});

test("signal abort short-circuits stream", async () => {
  const ctrl = new AbortController();
  async function* events() {
    yield {
      id: "c",
      model: "gpt-4o",
      choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }],
    };
    ctrl.abort();
    await new Promise((r) => setImmediate(r));
    yield {
      id: "c",
      model: "gpt-4o",
      choices: [{ index: 0, delta: { content: "y" }, finish_reason: null }],
    };
    yield { id: "c", model: "gpt-4o", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
  }
  const provider = new OpenAIProvider({
    apiKeyResolver: async () => "k",
    clientFactory: () => fakeClient({ create: (async () => events()) as unknown as Create }),
  });
  const out: string[] = [];
  let sawError = false;
  for await (const chunk of provider.stream({
    model: "gpt-4o",
    workspaceId: "ws-1",
    routeKey: "agent.summary",
    messages: [{ role: "user", content: "x" }],
    signal: ctrl.signal,
  })) {
    if (chunk.delta) out.push(chunk.delta);
    if (chunk.error === "aborted") sawError = true;
    if (chunk.done) break;
  }
  assert.equal(sawError, true);
});
