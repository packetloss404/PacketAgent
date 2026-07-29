import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OLLAMA_DEFAULT_BASE_URL,
  OllamaProvider,
  resolveLocalLlmApiFormat,
  resolveLocalLlmBaseURL,
  resolveLocalLlmModel,
  resolveLocalStructuredOutputMode,
} from "./ollama.js";

// =============================================================================
// Helpers
// =============================================================================

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

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const keys = Object.keys(overrides);
  const originals: Record<string, string | undefined> = {};
  for (const k of keys) originals[k] = process.env[k];
  try {
    for (const k of keys) {
      const v = overrides[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const k of keys) {
      const orig = originals[k];
      if (orig === undefined) delete process.env[k];
      else process.env[k] = orig;
    }
  }
}

// =============================================================================
// (A) env precedence: LOCAL_LLM_BASE_URL > OLLAMA_BASE_URL > default
// =============================================================================

test("resolveLocalLlmBaseURL: defaults to localhost when nothing is set", () => {
  withEnv({ LOCAL_LLM_BASE_URL: undefined, OLLAMA_BASE_URL: undefined }, () => {
    assert.equal(resolveLocalLlmBaseURL(), OLLAMA_DEFAULT_BASE_URL);
  });
});

test("resolveLocalLlmBaseURL: OLLAMA_BASE_URL is honored", () => {
  withEnv({ LOCAL_LLM_BASE_URL: undefined, OLLAMA_BASE_URL: "http://ollama-box:11434" }, () => {
    assert.equal(resolveLocalLlmBaseURL(), "http://ollama-box:11434");
  });
});

test("resolveLocalLlmBaseURL: LOCAL_LLM_BASE_URL takes precedence over OLLAMA_BASE_URL", () => {
  withEnv(
    { LOCAL_LLM_BASE_URL: "http://gpu-box:8000", OLLAMA_BASE_URL: "http://ollama-box:11434" },
    () => {
      assert.equal(resolveLocalLlmBaseURL(), "http://gpu-box:8000");
    },
  );
});

test("resolveLocalLlmBaseURL: trailing slashes are trimmed", () => {
  withEnv({ LOCAL_LLM_BASE_URL: "http://gpu-box:8000///", OLLAMA_BASE_URL: undefined }, () => {
    assert.equal(resolveLocalLlmBaseURL(), "http://gpu-box:8000");
  });
});

test("OllamaProvider constructor: LOCAL_LLM_BASE_URL wins over OLLAMA_BASE_URL", () => {
  withEnv(
    { LOCAL_LLM_BASE_URL: "http://gpu-box:8000", OLLAMA_BASE_URL: "http://ollama-box:11434" },
    () => {
      const p = new OllamaProvider();
      assert.equal(p.getBaseURL(), "http://gpu-box:8000");
    },
  );
});

// =============================================================================
// (B) API format selection
// =============================================================================

test("resolveLocalLlmApiFormat: defaults to ollama", () => {
  withEnv({ LOCAL_LLM_API_FORMAT: undefined }, () => {
    assert.equal(resolveLocalLlmApiFormat(), "ollama");
  });
});

test("resolveLocalLlmApiFormat: case-insensitive openai", () => {
  withEnv({ LOCAL_LLM_API_FORMAT: "OpenAI" }, () => {
    assert.equal(resolveLocalLlmApiFormat(), "openai");
  });
});

test("resolveLocalLlmApiFormat: unknown values fall back to ollama (no crash)", () => {
  withEnv({ LOCAL_LLM_API_FORMAT: "vllm-native-thing" }, () => {
    assert.equal(resolveLocalLlmApiFormat(), "ollama");
  });
});

test("resolveLocalStructuredOutputMode defaults to auto and supports an explicit off switch", () => {
  withEnv({ LOCAL_LLM_STRUCTURED_OUTPUTS: undefined }, () => {
    assert.equal(resolveLocalStructuredOutputMode(), "auto");
  });
  withEnv({ LOCAL_LLM_STRUCTURED_OUTPUTS: "OFF" }, () => {
    assert.equal(resolveLocalStructuredOutputMode(), "off");
  });
});

test("call() with apiFormat=openai posts to /v1/chat/completions with OpenAI payload", async () => {
  const { fetchFn, captured } = captureFetch(() =>
    jsonResponse({
      id: "x1",
      model: "qwen2.5-coder-32b-instruct",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hi from vllm" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
    }),
  );
  const provider = new OllamaProvider({
    baseURL: "http://gpu-box:8000",
    apiFormat: "openai",
    fetchFn,
  });
  const result = await provider.call({
    model: "qwen2.5-coder-32b-instruct",
    workspaceId: "ws-1",
    routeKey: "ollama.smart",
    messages: [{ role: "user", content: "ping" }],
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].method, "POST");
  assert.equal(captured[0].url, "http://gpu-box:8000/v1/chat/completions");
  const body = captured[0].body as {
    model: string;
    messages: { role: string; content: string }[];
    stream: boolean;
  };
  assert.equal(body.model, "qwen2.5-coder-32b-instruct");
  assert.equal(body.stream, false);
  assert.deepEqual(body.messages, [{ role: "user", content: "ping" }]);
  assert.equal(result.content, "hi from vllm");
  assert.equal(result.providerName, "ollama");
  assert.equal(result.usage.promptTokens, 5);
  assert.equal(result.usage.completionTokens, 4);
});

test("vLLM requests use structured_outputs JSON schema", async () => {
  const { fetchFn, captured } = captureFetch(() =>
    jsonResponse({
      id: "x1",
      model: "qwen",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: '{"ok":true}' },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  );
  const provider = new OllamaProvider({
    baseURL: "http://gpu-box:8000",
    apiFormat: "openai",
    fetchFn,
  });
  const schema = {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
  };
  await provider.call({
    model: "qwen",
    workspaceId: "ws-1",
    routeKey: "workflow.draft",
    messages: [{ role: "user", content: "return JSON" }],
    structuredOutput: { name: "result", schema },
  });
  assert.deepEqual((captured[0].body as { structured_outputs?: unknown }).structured_outputs, {
    json: schema,
  });
});

test("vLLM structured decoding falls back once to schema-prompted JSON", async () => {
  const captured: CapturedRequest[] = [];
  let calls = 0;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({
      url: url.toString(),
      method: String(init?.method ?? "GET"),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body)) as unknown,
    });
    calls++;
    if (calls === 1)
      return jsonResponse({ error: "unsupported structured_outputs" }, { status: 400 });
    return jsonResponse({
      id: "x2",
      model: "qwen",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: '{"ok":true}' },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 2 },
    });
  }) as unknown as typeof fetch;
  const provider = new OllamaProvider({
    baseURL: "http://generic-openai-server:8000",
    apiFormat: "openai",
    fetchFn,
  });
  const result = await provider.call({
    model: "qwen",
    workspaceId: "ws-1",
    routeKey: "workflow.draft",
    messages: [{ role: "user", content: "return JSON" }],
    structuredOutput: {
      name: "result",
      schema: { type: "object", properties: { ok: { type: "boolean" } } },
    },
  });
  assert.equal(result.content, '{"ok":true}');
  assert.equal(captured.length, 2);
  assert.ok("structured_outputs" in (captured[0].body as Record<string, unknown>));
  assert.equal("structured_outputs" in (captured[1].body as Record<string, unknown>), false);
  const fallbackMessages = (
    captured[1].body as { messages: Array<{ role: string; content: string }> }
  ).messages;
  assert.equal(fallbackMessages[0].role, "system");
  assert.match(fallbackMessages[0].content, /Return only valid JSON matching this JSON Schema/);
});

test("call() with apiFormat=ollama posts to /api/chat (default backwards-compat path)", async () => {
  const { fetchFn, captured } = captureFetch(() =>
    jsonResponse({
      model: "llama3.2",
      message: { role: "assistant", content: "hi from ollama" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 3,
      eval_count: 4,
    }),
  );
  const provider = new OllamaProvider({
    baseURL: "http://localhost:11434",
    apiFormat: "ollama",
    fetchFn,
  });
  const result = await provider.call({
    model: "llama3.2",
    workspaceId: "ws-1",
    routeKey: "ollama.fast",
    messages: [{ role: "user", content: "ping" }],
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, "http://localhost:11434/api/chat");
  assert.equal(result.content, "hi from ollama");
  assert.equal(result.providerName, "ollama");
});

test("stream() with apiFormat=openai posts to /v1/chat/completions and parses SSE deltas", async () => {
  const sse = [
    `data: ${JSON.stringify({ id: "1", model: "m", choices: [{ index: 0, delta: { content: "He" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "1", model: "m", choices: [{ index: 0, delta: { content: "llo" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "1", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2 } })}\n\n`,
    "data: [DONE]\n\n",
  ];
  const enc = new TextEncoder();
  const fetchFn = (async (url: string | URL | Request) => {
    assert.equal(url.toString(), "http://gpu-box:8000/v1/chat/completions");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of sse) controller.enqueue(enc.encode(f));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;

  const provider = new OllamaProvider({
    baseURL: "http://gpu-box:8000",
    apiFormat: "openai",
    fetchFn,
  });

  const deltas: string[] = [];
  let done = false;
  let promptTokens = -1;
  for await (const chunk of provider.stream({
    model: "m",
    workspaceId: "ws-1",
    routeKey: "ollama.smart",
    messages: [{ role: "user", content: "hi" }],
  })) {
    if (chunk.delta) deltas.push(chunk.delta);
    if (chunk.done) {
      done = true;
      promptTokens = chunk.usage?.promptTokens ?? -1;
    }
    if (chunk.error) assert.fail(`unexpected error: ${chunk.error}`);
  }
  assert.equal(deltas.join(""), "Hello");
  assert.equal(done, true);
  assert.equal(promptTokens, 1);
});

// =============================================================================
// (C) Model override
// =============================================================================

test("resolveLocalLlmModel: returns requested model when LOCAL_LLM_MODEL is unset", () => {
  withEnv({ LOCAL_LLM_MODEL: undefined }, () => {
    assert.equal(resolveLocalLlmModel("llama3.2"), "llama3.2");
  });
});

test("resolveLocalLlmModel: LOCAL_LLM_MODEL overrides requested model", () => {
  withEnv({ LOCAL_LLM_MODEL: "qwen2.5-coder-32b-instruct" }, () => {
    assert.equal(resolveLocalLlmModel("llama3.2"), "qwen2.5-coder-32b-instruct");
  });
});

test("OllamaProvider: LOCAL_LLM_MODEL overrides the per-call model in /api/chat body", async () => {
  await withEnv({ LOCAL_LLM_MODEL: "qwen2.5-coder-32b-instruct" }, async () => {
    const { fetchFn, captured } = captureFetch(() =>
      jsonResponse({
        model: "qwen2.5-coder-32b-instruct",
        message: { role: "assistant", content: "ok" },
        done: true,
        done_reason: "stop",
      }),
    );
    const provider = new OllamaProvider({
      baseURL: "http://localhost:11434",
      apiFormat: "ollama",
      fetchFn,
    });
    await provider.call({
      model: "llama3.2", // requested by caller; should be overridden
      workspaceId: "ws-1",
      routeKey: "ollama.fast",
      messages: [{ role: "user", content: "ping" }],
    });
    const body = captured[0].body as { model: string };
    assert.equal(body.model, "qwen2.5-coder-32b-instruct");
  });
});

test("OllamaProvider: LOCAL_LLM_MODEL also overrides the model in OpenAI-compat mode", async () => {
  await withEnv({ LOCAL_LLM_MODEL: "deepseek-coder-v2:236b" }, async () => {
    const { fetchFn, captured } = captureFetch(() =>
      jsonResponse({
        id: "x",
        model: "deepseek-coder-v2:236b",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    const provider = new OllamaProvider({
      baseURL: "http://gpu-box:8000",
      apiFormat: "openai",
      fetchFn,
    });
    await provider.call({
      model: "llama3.2",
      workspaceId: "ws-1",
      routeKey: "ollama.smart",
      messages: [{ role: "user", content: "ping" }],
    });
    const body = captured[0].body as { model: string };
    assert.equal(body.model, "deepseek-coder-v2:236b");
  });
});

// =============================================================================
// (D) Tool-call parity across formats
// =============================================================================

test("call() with apiFormat=openai parses tool_calls", async () => {
  const { fetchFn } = captureFetch(() =>
    jsonResponse({
      id: "x",
      model: "m",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "search", arguments: '{"q":"packetagent"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 6 },
    }),
  );
  const provider = new OllamaProvider({
    baseURL: "http://gpu-box:8000",
    apiFormat: "openai",
    fetchFn,
  });
  const result = await provider.call({
    model: "m",
    workspaceId: "ws-1",
    routeKey: "ollama.smart",
    messages: [{ role: "user", content: "find it" }],
    tools: [{ name: "search", description: "search", inputSchema: { type: "object" } }],
  });
  assert.equal(result.finishReason, "tool_use");
  assert.equal(result.toolCalls?.length, 1);
  assert.equal(result.toolCalls?.[0].name, "search");
  assert.deepEqual(result.toolCalls?.[0].input, { q: "packetagent" });
});
