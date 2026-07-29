import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenRouterProvider, OPENROUTER_MODEL_PRICING } from "../openrouter.js";
import { registerDefaultProviders, resetRegisteredProvidersForTests } from "../bootstrap.js";
import { getDefaultRouter, resetDefaultRouterForTests } from "../router.js";

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

test("openrouter: call() sends bearer auth + HTTP-Referer + X-Title attribution headers", async () => {
  const captured: { url?: string; body?: string; headers?: Record<string, string> } = {};
  const provider = new OpenRouterProvider({
    apiKeyResolver: async () => "or-key",
    appName: "PacketAgent",
    siteUrl: "PacketAgent",
    fetchFn: (async (url: string | URL, init?: RequestInit) => {
      captured.url = url.toString();
      captured.body = init?.body as string;
      captured.headers = init?.headers as Record<string, string>;
      return fakeResponse({
        id: "c1",
        model: "anthropic/claude-haiku-4-5",
        choices: [
          { index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      });
    }) as unknown as typeof fetch,
  });
  const res = await provider.call({
    model: "anthropic/claude-haiku-4-5",
    workspaceId: "w",
    routeKey: "byok.openrouter.fast",
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(res.content, "hi");
  assert.equal(res.providerName, "openrouter");
  assert.match(captured.url ?? "", /\/chat\/completions$/);
  assert.equal(captured.headers?.authorization, "Bearer or-key");
  assert.equal(captured.headers?.["HTTP-Referer"], "PacketAgent");
  assert.equal(captured.headers?.["X-Title"], "PacketAgent");
  // Body should carry the unmodified provider-prefixed model id and OpenAI shape.
  const body = JSON.parse(captured.body ?? "{}") as {
    model: string;
    messages: Array<{ role: string }>;
  };
  assert.equal(body.model, "anthropic/claude-haiku-4-5");
  assert.equal(body.messages[0]?.role, "user");
  const pricing = OPENROUTER_MODEL_PRICING["anthropic/claude-haiku-4-5"];
  const expected = (10 * pricing.input + 20 * pricing.output) / 1_000_000;
  assert.ok(Math.abs(res.usage.costUsd - expected) < 1e-9);
});

test("openrouter: env-overridden attribution headers reach the request", async () => {
  let headers: Record<string, string> = {};
  const provider = new OpenRouterProvider({
    apiKeyResolver: async () => "or-key",
    appName: "Custom App",
    siteUrl: "https://example.com",
    fetchFn: (async (_url: string | URL, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return fakeResponse({
        id: "c1",
        model: "openai/gpt-4o-mini",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }) as unknown as typeof fetch,
  });
  await provider.call({
    model: "openai/gpt-4o-mini",
    workspaceId: "w",
    routeKey: "byok.openrouter.fast",
    messages: [{ role: "user", content: "x" }],
  });
  assert.equal(headers["HTTP-Referer"], "https://example.com");
  assert.equal(headers["X-Title"], "Custom App");
});

test("openrouter: stream() yields text deltas, a parsed tool_use, and final usage", async () => {
  const toolArgs = JSON.stringify({ q: "hi" });
  const events = [
    "data: " +
      JSON.stringify({
        model: "anthropic/claude-haiku-4-5",
        choices: [{ index: 0, delta: { content: "hi " }, finish_reason: null }],
      }) +
      "\n\n",
    "data: " +
      JSON.stringify({
        model: "anthropic/claude-haiku-4-5",
        choices: [{ index: 0, delta: { content: "world" }, finish_reason: null }],
      }) +
      "\n\n",
    "data: " +
      JSON.stringify({
        model: "anthropic/claude-haiku-4-5",
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
  const provider = new OpenRouterProvider({
    apiKeyResolver: async () => "or-key",
    fetchFn: (async () => sseStream(events)) as unknown as typeof fetch,
  });
  const text: string[] = [];
  let toolCall: { id: string; name: string; input: Record<string, unknown> } | undefined;
  let done = false;
  for await (const c of provider.stream({
    model: "anthropic/claude-haiku-4-5",
    workspaceId: "w",
    routeKey: "byok.openrouter.fast",
    messages: [{ role: "user", content: "x" }],
  })) {
    if (c.delta) text.push(c.delta);
    if (c.toolCall) toolCall = c.toolCall;
    if (c.done) {
      done = true;
      assert.equal(c.usage?.promptTokens, 5);
      assert.equal(c.usage?.completionTokens, 10);
    }
  }
  assert.equal(text.join(""), "hi world");
  assert.deepEqual(toolCall, { id: "tc", name: "search", input: { q: "hi" } });
  assert.equal(done, true);
});

test("openrouter: HTTP 401 surfaces as a clear auth-failure error", async () => {
  const provider = new OpenRouterProvider({
    apiKeyResolver: async () => "bad",
    fetchFn: (async () => fakeResponse("invalid key", { status: 401 })) as unknown as typeof fetch,
  });
  await assert.rejects(
    () =>
      provider.call({
        model: "openai/gpt-4o-mini",
        workspaceId: "w",
        routeKey: "byok.openrouter.fast",
        messages: [{ role: "user", content: "x" }],
      }),
    /authentication failed/i,
  );
});

test('openrouter: 200 OK with body.error (e.g. "No endpoints found that support tool use") throws verbatim', async () => {
  const provider = new OpenRouterProvider({
    apiKeyResolver: async () => "or-key",
    fetchFn: (async () =>
      fakeResponse({
        id: "c1",
        model: "meta-llama/llama-3.3-70b-instruct:free",
        choices: [],
        error: { message: "No endpoints found that support tool use", code: 404 },
      })) as unknown as typeof fetch,
  });
  await assert.rejects(
    () =>
      provider.call({
        model: "meta-llama/llama-3.3-70b-instruct:free",
        workspaceId: "w",
        routeKey: "byok.openrouter.cheap",
        messages: [{ role: "user", content: "x" }],
        tools: [{ name: "search", description: "search", inputSchema: { type: "object" } }],
      }),
    /No endpoints found that support tool use/,
  );
});

test("openrouter: apiKeyResolver null falls back to env, both null throws", async () => {
  const original = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  const provider = new OpenRouterProvider({
    apiKeyResolver: async () => null,
    fetchFn: (async () => fakeResponse({})) as unknown as typeof fetch,
  });
  await assert.rejects(
    () =>
      provider.call({
        model: "openai/gpt-4o-mini",
        workspaceId: "w",
        routeKey: "byok.openrouter.fast",
        messages: [{ role: "user", content: "x" }],
      }),
    /no API key/,
  );
  process.env.OPENROUTER_API_KEY = "from-env";
  let auth = "";
  const provider2 = new OpenRouterProvider({
    apiKeyResolver: async () => null,
    fetchFn: (async (_url: string | URL, init?: RequestInit) => {
      auth = (init?.headers as Record<string, string>).authorization;
      return fakeResponse({
        id: "c1",
        model: "openai/gpt-4o-mini",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }) as unknown as typeof fetch,
  });
  await provider2.call({
    model: "openai/gpt-4o-mini",
    workspaceId: "w",
    routeKey: "byok.openrouter.fast",
    messages: [{ role: "user", content: "x" }],
  });
  assert.equal(auth, "Bearer from-env");
  if (original === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = original;
});

test("openrouter: not registered by registerDefaultProviders when OPENROUTER_API_KEY is absent", () => {
  const original = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  resetDefaultRouterForTests();
  resetRegisteredProvidersForTests();
  try {
    registerDefaultProviders();
    const router = getDefaultRouter();
    assert.equal(
      router.has("openrouter"),
      false,
      "openrouter should not be registered without an API key",
    );
  } finally {
    resetDefaultRouterForTests();
    resetRegisteredProvidersForTests();
    if (original === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = original;
  }
});

test("openrouter: registered by registerDefaultProviders when OPENROUTER_API_KEY is set", () => {
  const original = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  resetDefaultRouterForTests();
  resetRegisteredProvidersForTests();
  try {
    registerDefaultProviders();
    const router = getDefaultRouter();
    assert.equal(
      router.has("openrouter"),
      true,
      "openrouter should be registered when env key is present",
    );
  } finally {
    resetDefaultRouterForTests();
    resetRegisteredProvidersForTests();
    if (original === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = original;
  }
});
