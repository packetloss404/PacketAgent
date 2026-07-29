import assert from "node:assert/strict";
import test from "node:test";
import { applyAppIterationViaLLM, type GeneratedAppDraftLike } from "./app-iteration-service.js";
import { AnthropicProvider, type AnthropicClient } from "./providers/anthropic.js";

function draftFixture(): GeneratedAppDraftLike {
  return {
    appName: "Test app",
    pageMap: [
      { path: "/login", name: "Sign in", access: "public", purpose: "Auth", actions: ["sign in"] },
    ],
    apiRouteStubs: [
      { method: "GET", path: "/api/test", access: "private", purpose: "list", responseShape: "[]" },
    ],
    dataSchema: { database: "postgres", entities: [{ name: "thing", primaryKey: "id" }] },
  };
}

function makeStreamingProvider(
  toolInput: Record<string, unknown> | null,
  prose: string[],
): AnthropicProvider {
  async function* events() {
    yield { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } };
    yield { type: "content_block_start", index: 0, content_block: { type: "text" } };
    for (const chunk of prose) {
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } };
    }
    yield { type: "content_block_stop", index: 0 };
    if (toolInput) {
      yield {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tu_1", name: "submit_iteration_diff" },
      };
      yield {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(toolInput) },
      };
      yield { type: "content_block_stop", index: 1 };
    }
    yield { type: "message_delta", usage: { output_tokens: 12 } };
    yield { type: "message_stop" };
  }
  const fakeClient: AnthropicClient = {
    messages: {
      create: (async () => {
        throw new Error("call should not be used in stream test");
      }) as AnthropicClient["messages"]["create"],
      stream: (async () => events()) as unknown as NonNullable<
        AnthropicClient["messages"]["stream"]
      >,
    },
  };
  return new AnthropicProvider({
    apiKeyResolver: async () => "test-key",
    clientFactory: () => fakeClient,
  });
}

const PROVIDER_KEY_ENV = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "MINIMAX_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "PACKETAGENT_PROVIDER_PRIORITY",
] as const;

async function withNoProviderKeys(body: () => Promise<void>): Promise<void> {
  const originals: Partial<Record<string, string | undefined>> = {};
  for (const key of PROVIDER_KEY_ENV) {
    originals[key] = process.env[key];
    delete process.env[key];
  }
  // Force ollama out of consideration by setting an explicit priority that
  // excludes it. The resolver assumes ollama is always reachable otherwise.
  process.env.PACKETAGENT_PROVIDER_PRIORITY = "anthropic,openai,minimax,gemini,openrouter";
  try {
    await body();
  } finally {
    for (const key of PROVIDER_KEY_ENV) {
      const original = originals[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  }
}

test("applyAppIterationViaLLM returns null when no provider key and no provider override is set", async () => {
  await withNoProviderKeys(async () => {
    const result = await applyAppIterationViaLLM(
      draftFixture(),
      { kind: "page", path: "/login" },
      "add a forgot-password link",
      { workspaceId: "ws-1" },
    );
    assert.equal(result, null);
  });
});

test("applyAppIterationViaLLM streams prose deltas and parses the tool_use diff when an injected provider is used", async () => {
  const prose = ["I'll ", "add ", "a forgot-password link."];
  const toolInput = {
    changedSummary: "Add forgot-password link to /login",
    files: [
      {
        path: "app/pages/login.tsx",
        changeType: "modified",
        summary: "Add link",
        diff: '+ <a href="/forgot">Forgot?</a>',
      },
    ],
  };
  const provider = makeStreamingProvider(toolInput, prose);
  const seen: string[] = [];

  const result = await applyAppIterationViaLLM(
    draftFixture(),
    { kind: "page", path: "/login" },
    "add a forgot-password link",
    { workspaceId: "ws-1", provider },
    (chunk) => {
      seen.push(chunk);
    },
  );

  assert.ok(result, "LLM result should not be null");
  assert.equal(result?.changedSummary, "Add forgot-password link to /login");
  assert.equal(result?.files.length, 1);
  assert.equal(result?.files[0].path, "app/pages/login.tsx");
  assert.equal(result?.files[0].changeType, "modified");
  assert.equal(seen.join(""), prose.join(""));
  assert.equal(result?.prose, prose.join(""));
  assert.equal(result?.model, "claude-sonnet-4-6");
});

test("applyAppIterationViaLLM returns null when tool_use has no files", async () => {
  const provider = makeStreamingProvider({ changedSummary: "no-op", files: [] }, ["thinking..."]);
  const result = await applyAppIterationViaLLM(
    draftFixture(),
    { kind: "page", path: "/login" },
    "no change",
    { workspaceId: "ws-1", provider },
  );
  assert.equal(result, null);
});

test("applyAppIterationViaLLM resolves the cheap preset to the haiku model", async () => {
  let observedModel = "";
  const fakeClient: AnthropicClient = {
    messages: {
      create: (async () => {
        throw new Error("call should not be used");
      }) as AnthropicClient["messages"]["create"],
      stream: (async (params: { model: string }) => {
        observedModel = params.model;
        async function* events() {
          yield {
            type: "message_start",
            message: { usage: { input_tokens: 1, output_tokens: 0 } },
          };
          yield {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "tu_1", name: "submit_iteration_diff" },
          };
          yield {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify({
                changedSummary: "ok",
                files: [{ path: "a.ts", changeType: "added", summary: "s", diff: "+ x" }],
              }),
            },
          };
          yield { type: "content_block_stop", index: 0 };
          yield { type: "message_stop" };
        }
        return events();
      }) as unknown as NonNullable<AnthropicClient["messages"]["stream"]>,
    },
  };
  const provider = new AnthropicProvider({
    apiKeyResolver: async () => "test-key",
    clientFactory: () => fakeClient,
  });
  const result = await applyAppIterationViaLLM(draftFixture(), { kind: "page" }, "rename", {
    workspaceId: "ws-1",
    preset: "cheap",
    provider,
  });
  assert.ok(result);
  assert.equal(observedModel, "claude-haiku-4-5-20251001");
});
