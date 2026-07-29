import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ROUTES, ProviderRouter, StubProvider } from "../index.js";
import type {
  LLMProvider,
  ProviderCallOptions,
  ProviderCallResult,
  ProviderStreamChunk,
} from "../types.js";

function callOpts(overrides: Partial<ProviderCallOptions> = {}): ProviderCallOptions {
  return {
    model: "",
    messages: [{ role: "user", content: "hello world" }],
    workspaceId: "ws-1",
    routeKey: "workflow.draft",
    ...overrides,
  };
}

test("DEFAULT_ROUTES resolves to expected provider+model for each registered route", () => {
  const router = new ProviderRouter();
  for (const [routeKey, route] of Object.entries(DEFAULT_ROUTES)) {
    assert.deepEqual(router.resolve(routeKey), route);
  }
});

test("resolve returns fallback route for unknown key", () => {
  const router = new ProviderRouter();
  const route = router.resolve("does.not.exist");
  assert.equal(route.provider, "stub");
  assert.equal(route.model, "stub-small");
});

test("registering a provider replaces stub for that name", () => {
  const router = new ProviderRouter();
  let called = false;
  const fakeAnthropic: LLMProvider = {
    name: "anthropic",
    async call(opts): Promise<ProviderCallResult> {
      called = true;
      return {
        content: `fake:${opts.routeKey}`,
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 },
        model: opts.model,
        providerName: "anthropic",
      };
    },
    async *stream(): AsyncIterable<ProviderStreamChunk> {
      yield { delta: "x" };
      yield { done: true, usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 } };
    },
    async models() {
      return ["claude-opus-4-7"];
    },
  };
  router.register("anthropic", fakeAnthropic);
  return router.call(callOpts({ routeKey: "workflow.draft" })).then((res) => {
    assert.equal(called, true);
    assert.equal(res.providerName, "anthropic");
    assert.equal(res.content, "fake:workflow.draft");
  });
});

test("call() round-trip via stub is deterministic", async () => {
  const router = new ProviderRouter();
  const result = await router.call(callOpts({ routeKey: "unknown.route" }));
  assert.equal(result.content, "[stub:unknown.route] dlrow olleh");
  assert.equal(result.finishReason, "stop");
  assert.equal(result.usage.costUsd, 0);
  assert.equal(result.providerName, "stub");
});

test("stream() yields chunks summing to full content and ends with done", async () => {
  const router = new ProviderRouter();
  let assembled = "";
  let saw = false;
  for await (const chunk of router.stream(callOpts({ routeKey: "stream.unknown" }))) {
    if (chunk.delta) assembled += chunk.delta;
    if (chunk.done) {
      saw = true;
      assert.ok(chunk.usage);
      assert.equal(chunk.usage!.costUsd, 0);
    }
  }
  assert.equal(saw, true);
  assert.equal(assembled, "[stub:stream.unknown] dlrow olleh");
});

test("missing-provider fallback emits warn and routes to stub", async () => {
  const router = new ProviderRouter();
  const original = console.warn;
  const calls: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    calls.push(args);
  };
  try {
    const res = await router.call(callOpts({ routeKey: "code.generation" }));
    assert.equal(res.providerName, "stub");
    assert.ok(calls.some((c) => String(c[0]).includes('no provider registered for "minimax"')));
  } finally {
    console.warn = original;
  }
});

test("model override on call uses the supplied model when non-empty", async () => {
  const router = new ProviderRouter();
  router.register("stub", new StubProvider());
  const result = await router.call(callOpts({ routeKey: "workflow.draft", model: "stub-large" }));
  assert.equal(result.model, "stub-large");
});

test("provider override routes calls through the selected provider and model", async () => {
  const router = new ProviderRouter();
  let seenModel = "";
  const fakeOpenAI: LLMProvider = {
    name: "openai",
    async call(opts): Promise<ProviderCallResult> {
      seenModel = opts.model;
      return {
        content: "openai response",
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 },
        model: opts.model,
        providerName: "openai",
      };
    },
    async *stream(): AsyncIterable<ProviderStreamChunk> {
      yield { done: true, usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 } };
    },
    async models() {
      return ["gpt-agent"];
    },
  };
  router.register("openai", fakeOpenAI);

  const result = await router.call({
    ...callOpts({ routeKey: "agent.reasoning" }),
    provider: "openai",
    model: "gpt-agent",
  });

  assert.equal(result.providerName, "openai");
  assert.equal(result.model, "gpt-agent");
  assert.equal(seenModel, "gpt-agent");
});

test("setRoute overrides a route in the table", () => {
  const router = new ProviderRouter();
  router.setRoute("workflow.draft", { provider: "ollama", model: "llama3.2" });
  assert.deepEqual(router.resolve("workflow.draft"), { provider: "ollama", model: "llama3.2" });
});
