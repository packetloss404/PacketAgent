import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GEMINI_DEFAULT_BASE_URL,
  GEMINI_DEFAULT_MODELS,
  GeminiProvider,
  readGeminiEnvKey,
} from "./gemini.js";
import { ProviderRouter, getDefaultRouter, resetDefaultRouterForTests } from "./router.js";
import { registerDefaultProviders, resetRegisteredProvidersForTests } from "./bootstrap.js";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function captureFetch(response: () => Response): {
  fetchFn: typeof fetch;
  captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers as Record<string, string> | undefined;
    if (rawHeaders) {
      for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = String(v);
    }
    let parsedBody: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    captured.push({
      url: url.toString(),
      method: (init?.method ?? "GET").toUpperCase(),
      headers,
      body: parsedBody,
    });
    return response();
  }) as unknown as typeof fetch;
  return { fetchFn, captured };
}

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function sseResponse(events: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const e of events) controller.enqueue(enc.encode(e));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

// ---------------------------------------------------------------------------
// (a) auth header is set correctly
// ---------------------------------------------------------------------------

test("call() sets Authorization: Bearer <key> and POSTs to /chat/completions", async () => {
  const { fetchFn, captured } = captureFetch(() =>
    jsonResponse({
      id: "g1",
      model: "gemini-2.0-flash-exp",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hi from gemini" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    }),
  );
  const provider = new GeminiProvider({
    apiKeyResolver: async () => "secret-key-123",
    fetchFn,
  });

  const result = await provider.call({
    model: "gemini-2.0-flash-exp",
    workspaceId: "ws-1",
    routeKey: "gemini.fast",
    messages: [{ role: "user", content: "ping" }],
  });

  assert.equal(captured.length, 1);
  const req = captured[0];
  assert.equal(req.method, "POST");
  assert.equal(req.url, `${GEMINI_DEFAULT_BASE_URL}/chat/completions`);
  assert.equal(req.headers["authorization"], "Bearer secret-key-123");
  assert.equal(req.headers["content-type"], "application/json");
  const body = req.body as { model: string; messages: { role: string; content: string }[] };
  assert.equal(body.model, "gemini-2.0-flash-exp");
  assert.deepEqual(body.messages, [{ role: "user", content: "ping" }]);
  assert.equal(result.content, "hi from gemini");
  assert.equal(result.providerName, "gemini");
});

// ---------------------------------------------------------------------------
// (b) text deltas reach the emit callback
// ---------------------------------------------------------------------------

test("stream() emits text deltas in order, then a done chunk with usage", async () => {
  const events = [
    sseEvent({
      id: "g1",
      model: "gemini-2.0-flash-exp",
      choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: null }],
    }),
    sseEvent({
      id: "g1",
      model: "gemini-2.0-flash-exp",
      choices: [{ index: 0, delta: { content: "lo " }, finish_reason: null }],
    }),
    sseEvent({
      id: "g1",
      model: "gemini-2.0-flash-exp",
      choices: [{ index: 0, delta: { content: "world" }, finish_reason: null }],
    }),
    sseEvent({
      id: "g1",
      model: "gemini-2.0-flash-exp",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 7, completion_tokens: 11, total_tokens: 18 },
    }),
    "data: [DONE]\n\n",
  ];
  const { fetchFn } = captureFetch(() => sseResponse(events));
  const provider = new GeminiProvider({
    apiKeyResolver: async () => "k",
    fetchFn,
  });

  const deltas: string[] = [];
  let saw = false;
  let usagePrompt = -1;
  for await (const chunk of provider.stream({
    model: "gemini-2.0-flash-exp",
    workspaceId: "ws-1",
    routeKey: "gemini.fast",
    messages: [{ role: "user", content: "hi" }],
  })) {
    if (chunk.delta) deltas.push(chunk.delta);
    if (chunk.done) {
      saw = true;
      usagePrompt = chunk.usage?.promptTokens ?? -1;
    }
    if (chunk.error) assert.fail(`unexpected error: ${chunk.error}`);
  }
  assert.equal(deltas.join(""), "Hello world");
  assert.equal(saw, true);
  assert.equal(usagePrompt, 7);
});

// ---------------------------------------------------------------------------
// (c) tool_use is parsed correctly (call + stream)
// ---------------------------------------------------------------------------

test("call() parses tool_calls in non-streaming response", async () => {
  const { fetchFn } = captureFetch(() =>
    jsonResponse({
      id: "g1",
      model: "gemini-2.5-pro",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: { name: "search", arguments: '{"q":"packetagent"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 8, total_tokens: 12 },
    }),
  );
  const provider = new GeminiProvider({ apiKeyResolver: async () => "k", fetchFn });
  const result = await provider.call({
    model: "gemini-2.5-pro",
    workspaceId: "ws-1",
    routeKey: "gemini.smart",
    messages: [{ role: "user", content: "find it" }],
    tools: [{ name: "search", description: "search the web", inputSchema: { type: "object" } }],
  });
  assert.equal(result.finishReason, "tool_use");
  assert.equal(result.toolCalls?.length, 1);
  assert.equal(result.toolCalls?.[0].id, "call_abc");
  assert.equal(result.toolCalls?.[0].name, "search");
  assert.deepEqual(result.toolCalls?.[0].input, { q: "packetagent" });
});

test("stream() aggregates split tool_call argument deltas into a parsed object", async () => {
  const events = [
    sseEvent({
      id: "g1",
      model: "gemini-2.5-pro",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_xyz",
                type: "function",
                function: { name: "lookup", arguments: '{"q":' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    sseEvent({
      id: "g1",
      model: "gemini-2.5-pro",
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '"hi"}' } }] },
          finish_reason: null,
        },
      ],
    }),
    sseEvent({
      id: "g1",
      model: "gemini-2.5-pro",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    }),
  ];
  const { fetchFn } = captureFetch(() => sseResponse(events));
  const provider = new GeminiProvider({ apiKeyResolver: async () => "k", fetchFn });

  let tool: { id: string; name: string; input: Record<string, unknown> } | undefined;
  let done = false;
  for await (const chunk of provider.stream({
    model: "gemini-2.5-pro",
    workspaceId: "ws-1",
    routeKey: "gemini.smart",
    messages: [{ role: "user", content: "x" }],
    tools: [{ name: "lookup", description: "search", inputSchema: { type: "object" } }],
  })) {
    if (chunk.toolCall) tool = chunk.toolCall;
    if (chunk.done) done = true;
    if (chunk.error) assert.fail(`unexpected error: ${chunk.error}`);
  }
  assert.deepEqual(tool, { id: "call_xyz", name: "lookup", input: { q: "hi" } });
  assert.equal(done, true);
});

// ---------------------------------------------------------------------------
// (d) on missing key the provider isn't registered
// ---------------------------------------------------------------------------

test("registerDefaultProviders skips gemini when no GOOGLE_API_KEY / GEMINI_API_KEY is set", () => {
  const originalGoogle = process.env.GOOGLE_API_KEY;
  const originalGemini = process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    resetDefaultRouterForTests();
    resetRegisteredProvidersForTests();
    registerDefaultProviders();
    const router = getDefaultRouter();
    assert.equal(router.has("gemini"), false, "gemini should NOT be registered when env keys are absent");
    assert.equal(readGeminiEnvKey(), undefined);
  } finally {
    if (originalGoogle !== undefined) process.env.GOOGLE_API_KEY = originalGoogle;
    if (originalGemini !== undefined) process.env.GEMINI_API_KEY = originalGemini;
    resetDefaultRouterForTests();
    resetRegisteredProvidersForTests();
  }
});

test("registerDefaultProviders registers gemini when GOOGLE_API_KEY is set", () => {
  const originalGoogle = process.env.GOOGLE_API_KEY;
  const originalGemini = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  process.env.GOOGLE_API_KEY = "test-google-key";
  try {
    resetDefaultRouterForTests();
    resetRegisteredProvidersForTests();
    registerDefaultProviders();
    const router = getDefaultRouter();
    assert.equal(router.has("gemini"), true, "gemini should be registered when GOOGLE_API_KEY is set");
  } finally {
    if (originalGoogle === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = originalGoogle;
    if (originalGemini !== undefined) process.env.GEMINI_API_KEY = originalGemini;
    resetDefaultRouterForTests();
    resetRegisteredProvidersForTests();
  }
});

test("readGeminiEnvKey falls back to GEMINI_API_KEY when GOOGLE_API_KEY is absent", () => {
  const originalGoogle = process.env.GOOGLE_API_KEY;
  const originalGemini = process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  process.env.GEMINI_API_KEY = "fallback-key";
  try {
    assert.equal(readGeminiEnvKey(), "fallback-key");
  } finally {
    if (originalGoogle !== undefined) process.env.GOOGLE_API_KEY = originalGoogle;
    if (originalGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGemini;
  }
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

test("call() surfaces a clear auth error on HTTP 401", async () => {
  const { fetchFn } = captureFetch(() =>
    jsonResponse(
      { error: { message: "invalid api key", status: "UNAUTHENTICATED" } },
      { status: 401 },
    ),
  );
  const provider = new GeminiProvider({ apiKeyResolver: async () => "bad", fetchFn });
  await assert.rejects(
    () =>
      provider.call({
        model: "gemini-2.0-flash-exp",
        workspaceId: "ws-1",
        routeKey: "gemini.fast",
        messages: [{ role: "user", content: "x" }],
      }),
    /authentication failed/i,
  );
});

test("stream() yields an error chunk with retry-after on HTTP 429", async () => {
  const provider = new GeminiProvider({
    apiKeyResolver: async () => "k",
    fetchFn: (async () =>
      new Response(JSON.stringify({ error: { message: "slow down" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "30" },
      })) as unknown as typeof fetch,
  });
  let sawError = "";
  for await (const chunk of provider.stream({
    model: "gemini-2.0-flash-exp",
    workspaceId: "ws-1",
    routeKey: "gemini.fast",
    messages: [{ role: "user", content: "x" }],
  })) {
    if (chunk.error) sawError = chunk.error;
  }
  assert.match(sawError, /rate limited/i);
  assert.match(sawError, /retry-after: 30/);
});

test("missing API key (vault null, env unset) yields error chunk in stream", async () => {
  const originalGoogle = process.env.GOOGLE_API_KEY;
  const originalGemini = process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const provider = new GeminiProvider({
      apiKeyResolver: async () => null,
      fetchFn: (async () => {
        throw new Error("should not fetch");
      }) as unknown as typeof fetch,
    });
    let saw = "";
    for await (const chunk of provider.stream({
      model: "gemini-2.0-flash-exp",
      workspaceId: "ws-1",
      routeKey: "gemini.fast",
      messages: [{ role: "user", content: "x" }],
    })) {
      if (chunk.error) saw = chunk.error;
    }
    assert.match(saw, /no API key/);
  } finally {
    if (originalGoogle !== undefined) process.env.GOOGLE_API_KEY = originalGoogle;
    if (originalGemini !== undefined) process.env.GEMINI_API_KEY = originalGemini;
  }
});

// ---------------------------------------------------------------------------
// Defaults sanity check
// ---------------------------------------------------------------------------

test("GEMINI_DEFAULT_MODELS exposes cheap/fast/smart entries", () => {
  assert.ok(GEMINI_DEFAULT_MODELS.cheap);
  assert.ok(GEMINI_DEFAULT_MODELS.fast);
  assert.ok(GEMINI_DEFAULT_MODELS.smart);
});

test("models() returns the known model list", async () => {
  const provider = new GeminiProvider({ apiKeyResolver: async () => "k" });
  const models = await provider.models();
  assert.ok(models.includes("gemini-2.5-pro"));
  assert.ok(models.includes("gemini-2.0-flash-exp"));
});

test("router has gemini.* default routes pointing at the gemini provider", () => {
  const router = new ProviderRouter();
  assert.equal(router.resolve("gemini.smart").provider, "gemini");
  assert.equal(router.resolve("gemini.fast").provider, "gemini");
  assert.equal(router.resolve("gemini.cheap").provider, "gemini");
});
