import { test } from "node:test";
import assert from "node:assert/strict";
import { OllamaProvider } from "../ollama.js";

function fakeResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function ndjsonStream(lines: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(l + "\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

test("call() POSTs to /api/chat and returns content with cost = 0", async () => {
  let captured: { url?: string } = {};
  const provider = new OllamaProvider({
    fetchFn: (async (url: string | URL) => {
      captured.url = url.toString();
      return fakeResponse({
        model: "llama3.2",
        message: { role: "assistant", content: "hello" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 12,
        eval_count: 8,
      });
    }) as unknown as typeof fetch,
  });
  const res = await provider.call({
    model: "llama3.2",
    workspaceId: "w",
    routeKey: "local.dev",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(res.content, "hello");
  assert.equal(res.providerName, "ollama");
  assert.equal(res.usage.costUsd, 0);
  assert.equal(res.usage.promptTokens, 12);
  assert.equal(res.usage.completionTokens, 8);
  assert.match(captured.url ?? "", /\/api\/chat$/);
});

test("call() maps tool_calls", async () => {
  const provider = new OllamaProvider({
    fetchFn: (async () =>
      fakeResponse({
        model: "llama3.2",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "search", arguments: { q: "x" } } }],
        },
        done: true,
        done_reason: "stop",
      })) as unknown as typeof fetch,
  });
  const res = await provider.call({
    model: "llama3.2",
    workspaceId: "w",
    routeKey: "local.dev",
    messages: [{ role: "user", content: "x" }],
    tools: [{ name: "search", description: "s", inputSchema: { type: "object" } }],
  });
  assert.equal(res.toolCalls?.[0].name, "search");
  assert.deepEqual(res.toolCalls?.[0].input, { q: "x" });
});

test("stream() parses NDJSON, accumulates content, emits final usage", async () => {
  const lines = [
    JSON.stringify({
      model: "llama3.2",
      message: { role: "assistant", content: "hi " },
      done: false,
    }),
    JSON.stringify({
      model: "llama3.2",
      message: { role: "assistant", content: "world" },
      done: false,
    }),
    JSON.stringify({
      model: "llama3.2",
      message: { role: "assistant", content: "" },
      done: true,
      prompt_eval_count: 5,
      eval_count: 7,
      done_reason: "stop",
    }),
  ];
  const provider = new OllamaProvider({
    fetchFn: (async () => ndjsonStream(lines)) as unknown as typeof fetch,
  });
  const text: string[] = [];
  let done = false;
  for await (const c of provider.stream({
    model: "llama3.2",
    workspaceId: "w",
    routeKey: "local.dev",
    messages: [{ role: "user", content: "x" }],
  })) {
    if (c.delta) text.push(c.delta);
    if (c.done) {
      done = true;
      assert.equal(c.usage?.promptTokens, 5);
      assert.equal(c.usage?.completionTokens, 7);
      assert.equal(c.usage?.costUsd, 0);
    }
  }
  assert.equal(text.join(""), "hi world");
  assert.equal(done, true);
});

test("models() calls /api/tags and caches", async () => {
  let calls = 0;
  const provider = new OllamaProvider({
    modelsCacheMs: 60_000,
    fetchFn: (async () => {
      calls++;
      return fakeResponse({ models: [{ name: "llama3.2" }, { name: "qwen2.5" }] });
    }) as unknown as typeof fetch,
  });
  const a = await provider.models();
  const b = await provider.models();
  assert.deepEqual(a, ["llama3.2", "qwen2.5"]);
  assert.deepEqual(b, ["llama3.2", "qwen2.5"]);
  assert.equal(calls, 1);
});

test("connection refused surfaces clear error", async () => {
  const provider = new OllamaProvider({
    fetchFn: (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch,
  });
  await assert.rejects(
    () =>
      provider.call({
        model: "llama3.2",
        workspaceId: "w",
        routeKey: "local.dev",
        messages: [{ role: "user", content: "x" }],
      }),
    /Ollama running/,
  );
});

test("signal abort propagates to fetch on call()", async () => {
  let receivedSignal: AbortSignal | undefined;
  const provider = new OllamaProvider({
    fetchFn: (async (_url: string | URL, init?: RequestInit) => {
      receivedSignal = init?.signal as AbortSignal | undefined;
      return fakeResponse({
        model: "llama3.2",
        message: { role: "assistant", content: "x" },
        done: true,
        done_reason: "stop",
      });
    }) as unknown as typeof fetch,
  });
  const ctrl = new AbortController();
  await provider.call({
    model: "llama3.2",
    workspaceId: "w",
    routeKey: "local.dev",
    messages: [{ role: "user", content: "x" }],
    signal: ctrl.signal,
  });
  assert.equal(receivedSignal, ctrl.signal);
});
