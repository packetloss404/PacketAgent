import { test } from "node:test";
import assert from "node:assert/strict";
import { MiniMaxProvider, MINIMAX_MODEL_PRICING } from "../minimax.js";

function fakeResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function sseStream(events: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const e of events) {
        controller.enqueue(enc.encode(e));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("call() POSTs JSON and returns content + cost", async () => {
  let captured: { url?: string; body?: string; headers?: Record<string, string> } = {};
  const provider = new MiniMaxProvider({
    apiKeyResolver: async () => "k",
    fetchFn: (async (url: string | URL, init?: RequestInit) => {
      captured.url = url.toString();
      captured.body = init?.body as string;
      captured.headers = init?.headers as Record<string, string>;
      return fakeResponse({
        id: "c1",
        model: "abab6.5-chat",
        choices: [
          { index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
        base_resp: { status_code: 0, status_msg: "ok" },
      });
    }) as unknown as typeof fetch,
  });
  const res = await provider.call({
    model: "abab6.5-chat",
    workspaceId: "w",
    routeKey: "code.generation",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(res.content, "hello");
  assert.equal(res.providerName, "minimax");
  const expected =
    (100 * MINIMAX_MODEL_PRICING["abab6.5-chat"].input +
      200 * MINIMAX_MODEL_PRICING["abab6.5-chat"].output) /
    1_000_000;
  assert.ok(Math.abs(res.usage.costUsd - expected) < 1e-9);
  assert.match(captured.url ?? "", /\/chat\/completions$/);
  assert.equal(captured.headers?.authorization, "Bearer k");
});

test("HTTP 4xx surfaces as thrown error", async () => {
  const provider = new MiniMaxProvider({
    apiKeyResolver: async () => "k",
    fetchFn: (async () => fakeResponse("bad request", { status: 400 })) as unknown as typeof fetch,
  });
  await assert.rejects(
    () =>
      provider.call({
        model: "abab6.5-chat",
        workspaceId: "w",
        routeKey: "x",
        messages: [{ role: "user", content: "x" }],
      }),
    /HTTP 400/,
  );
});

test("base_resp non-zero throws", async () => {
  const provider = new MiniMaxProvider({
    apiKeyResolver: async () => "k",
    fetchFn: (async () =>
      fakeResponse({
        id: "c1",
        model: "abab6.5-chat",
        choices: [],
        base_resp: { status_code: 1004, status_msg: "rate limited" },
      })) as unknown as typeof fetch,
  });
  await assert.rejects(
    () =>
      provider.call({
        model: "abab6.5-chat",
        workspaceId: "w",
        routeKey: "x",
        messages: [{ role: "user", content: "x" }],
      }),
    /rate limited/,
  );
});

test("stream() parses SSE deltas, tool calls, and final usage", async () => {
  const toolArgs = JSON.stringify({ q: "hi" });
  const events = [
    "data: " +
      JSON.stringify({
        model: "abab6.5-chat",
        choices: [{ index: 0, delta: { content: "hi " }, finish_reason: null }],
      }) +
      "\n\n",
    "data: " +
      JSON.stringify({
        model: "abab6.5-chat",
        choices: [{ index: 0, delta: { content: "world" }, finish_reason: null }],
      }) +
      "\n\n",
    "data: " +
      JSON.stringify({
        model: "abab6.5-chat",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "tc",
                  type: "function",
                  function: { name: "search", arguments: toolArgs },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
      }) +
      "\n\n",
    "data: [DONE]\n\n",
  ];
  const provider = new MiniMaxProvider({
    apiKeyResolver: async () => "k",
    fetchFn: (async () => sseStream(events)) as unknown as typeof fetch,
  });
  const text: string[] = [];
  let toolCall: { name: string; input: Record<string, unknown> } | undefined;
  let done = false;
  for await (const c of provider.stream({
    model: "abab6.5-chat",
    workspaceId: "w",
    routeKey: "code.generation",
    messages: [{ role: "user", content: "x" }],
  })) {
    if (c.delta) text.push(c.delta);
    if (c.toolCall) toolCall = c.toolCall;
    if (c.done) {
      done = true;
      assert.equal(c.usage?.promptTokens, 5);
    }
  }
  assert.equal(text.join(""), "hi world");
  assert.deepEqual(toolCall, { id: "tc", name: "search", input: { q: "hi" } });
  assert.equal(done, true);
});

test("apiKeyResolver null falls back to env, both null throws", async () => {
  const original = process.env.MINIMAX_API_KEY;
  delete process.env.MINIMAX_API_KEY;
  const provider = new MiniMaxProvider({
    apiKeyResolver: async () => null,
    fetchFn: (async () => fakeResponse({})) as unknown as typeof fetch,
  });
  await assert.rejects(
    () =>
      provider.call({
        model: "abab6.5-chat",
        workspaceId: "w",
        routeKey: "x",
        messages: [{ role: "user", content: "x" }],
      }),
    /no API key/,
  );
  process.env.MINIMAX_API_KEY = "from-env";
  let receivedAuth = "";
  const provider2 = new MiniMaxProvider({
    apiKeyResolver: async () => null,
    fetchFn: (async (_url: string | URL, init?: RequestInit) => {
      receivedAuth = (init?.headers as Record<string, string>).authorization;
      return fakeResponse({
        id: "c1",
        model: "abab6.5-chat",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        base_resp: { status_code: 0, status_msg: "ok" },
      });
    }) as unknown as typeof fetch,
  });
  await provider2.call({
    model: "abab6.5-chat",
    workspaceId: "w",
    routeKey: "x",
    messages: [{ role: "user", content: "x" }],
  });
  assert.equal(receivedAuth, "Bearer from-env");
  if (original === undefined) delete process.env.MINIMAX_API_KEY;
  else process.env.MINIMAX_API_KEY = original;
});

test("signal abort propagates to fetch", async () => {
  let receivedSignal: AbortSignal | undefined;
  const provider = new MiniMaxProvider({
    apiKeyResolver: async () => "k",
    fetchFn: (async (_url: string | URL, init?: RequestInit) => {
      receivedSignal = init?.signal as AbortSignal | undefined;
      return fakeResponse({
        id: "c1",
        model: "abab6.5-chat",
        choices: [
          { index: 0, message: { role: "assistant", content: "x" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        base_resp: { status_code: 0, status_msg: "ok" },
      });
    }) as unknown as typeof fetch,
  });
  const ctrl = new AbortController();
  await provider.call({
    model: "abab6.5-chat",
    workspaceId: "w",
    routeKey: "x",
    messages: [{ role: "user", content: "x" }],
    signal: ctrl.signal,
  });
  assert.equal(receivedSignal, ctrl.signal);
});
