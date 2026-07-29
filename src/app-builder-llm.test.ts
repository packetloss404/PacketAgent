import assert from "node:assert/strict";
import test from "node:test";
import {
  generateAppDraftViaLLM,
  generateAppDraftWithLLM,
  modelForPreset,
} from "./app-builder-service.js";
import type { AnthropicClient, AnthropicClientFactory } from "./providers/anthropic.js";
import type {
  LLMProvider,
  ProviderCallOptions,
  ProviderCallResult,
  ProviderStreamChunk,
} from "./providers/types.js";

type AnthropicStream = NonNullable<AnthropicClient["messages"]["stream"]>;

const SAMPLE_TOOL_INPUT = {
  prompt: "Build a CRM for boutique sales teams to track leads and deals.",
  templateId: "crm",
  appName: "Boutique CRM",
  summary: "Internal CRM for boutique sales teams.",
  pageMap: [
    {
      path: "/login",
      name: "Sign in",
      access: "public",
      purpose: "Authenticate users.",
      actions: ["sign in"],
    },
    {
      path: "/leads",
      name: "Leads",
      access: "private",
      purpose: "List leads.",
      primaryEntity: "lead",
      actions: ["create lead"],
    },
  ],
  components: [
    { name: "LeadTable", type: "list", usedOn: ["/leads"], responsibilities: ["list leads"] },
  ],
  apiRouteStubs: [
    {
      method: "GET",
      path: "/api/app/generated/boutique-crm/leads",
      access: "private",
      purpose: "List leads.",
      responseShape: "lead[]",
    },
  ],
  dataSchema: {
    database: "postgres",
    entities: [
      {
        name: "lead",
        primaryKey: "id",
        fields: [
          { name: "id", type: "uuid", required: true },
          { name: "name", type: "string", required: true },
          { name: "status", type: "enum", required: true, enumValues: ["new", "qualified"] },
        ],
        indexes: ["status"],
        relations: [],
      },
    ],
    notes: ["Use uuid primary keys."],
  },
  seedData: {
    lead: [{ id: "lead_001", name: "Morgan", status: "new" }],
  },
  crudFlows: [
    {
      entity: "lead",
      create: ["Open form", "Validate", "POST"],
      read: ["GET list", "GET one"],
      update: ["PATCH editable fields", "Refresh list"],
      delete: ["Confirm", "DELETE"],
    },
  ],
  auth: {
    defaultPolicy: "authenticated-by-default",
    publicRoutes: ["/login"],
    privateRoutes: ["/leads"],
    roleRoutes: [],
    decisions: ["Public is opt-in."],
  },
  acceptanceChecks: ["Users can create leads."],
};

function streamingClient(opts: {
  proseChunks?: string[];
  toolInput?: unknown;
  emitError?: string;
  omitToolCall?: boolean;
}): AnthropicClient {
  const proseChunks = opts.proseChunks ?? [];
  const toolInputJson = JSON.stringify(opts.toolInput ?? SAMPLE_TOOL_INPUT);
  async function* events() {
    yield { type: "message_start", message: { usage: { input_tokens: 50, output_tokens: 0 } } };
    // Prose narration block.
    yield { type: "content_block_start", index: 0, content_block: { type: "text" } };
    for (const chunk of proseChunks) {
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } };
    }
    yield { type: "content_block_stop", index: 0 };
    if (opts.emitError) {
      throw new Error(opts.emitError);
    }
    if (!opts.omitToolCall) {
      // Tool call block.
      yield {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tu_1", name: "submit_app_draft" },
      };
      yield {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: toolInputJson },
      };
      yield { type: "content_block_stop", index: 1 };
    }
    yield { type: "message_delta", usage: { output_tokens: 200 } };
  }
  return {
    messages: {
      create: (async () => {
        throw new Error("not used in stream test");
      }) as AnthropicClient["messages"]["create"],
      stream: (async () => events()) as unknown as AnthropicStream,
    },
  };
}

/**
 * Clear every provider key the preset resolver knows about. Tests that assert
 * "no provider configured → null" must scrub all of them, otherwise the
 * resolver would pick a different provider and the assertion would flap on
 * developer machines that happen to have e.g. OPENAI_API_KEY set.
 */
const PROVIDER_KEY_ENV = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "MINIMAX_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "PACKETAGENT_PROVIDER_PRIORITY",
] as const;

function withNoProviderKeys(body: () => Promise<void>): Promise<void> {
  const originals: Partial<Record<string, string | undefined>> = {};
  for (const key of PROVIDER_KEY_ENV) {
    originals[key] = process.env[key];
    delete process.env[key];
  }
  // Force ollama to be considered "not configured" too: the resolver assumes
  // ollama is always reachable, so we shadow it by setting a priority list that
  // excludes it. This keeps the "no provider configured" assertion pure.
  process.env.PACKETAGENT_PROVIDER_PRIORITY = "anthropic,openai,minimax,gemini,openrouter";
  return body().finally(() => {
    for (const key of PROVIDER_KEY_ENV) {
      const original = originals[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });
}

test("modelForPreset maps presets to Anthropic models", () => {
  assert.equal(modelForPreset("cheap"), "claude-haiku-4-5-20251001");
  assert.equal(modelForPreset("fast"), "claude-sonnet-4-6");
  assert.equal(modelForPreset("smart"), "claude-sonnet-4-6");
  assert.equal(modelForPreset("local"), "claude-haiku-4-5-20251001");
  assert.equal(modelForPreset(undefined), "claude-sonnet-4-6");
  assert.equal(modelForPreset("smart", "claude-opus-4-7"), "claude-opus-4-7");
});

test("generateAppDraftViaLLM returns null when no provider key is configured", async () => {
  await withNoProviderKeys(async () => {
    const emitted: string[] = [];
    const result = await generateAppDraftViaLLM(
      "Build a CRM for sales teams to track leads and deals.",
      {
        /* no apiKey override */
      },
      (text) => {
        emitted.push(text);
      },
    );
    assert.equal(result, null);
    assert.equal(emitted.length, 0, "no prose should be emitted when there is no key");
  });
});

test("generateAppDraftWithLLM falls back to the template generator when no key is configured", async () => {
  await withNoProviderKeys(async () => {
    const emitted: string[] = [];
    const { draft, source } = await generateAppDraftWithLLM(
      "Build a CRM for sales teams to track leads and deals.",
      {},
      (text) => {
        emitted.push(text);
      },
    );
    assert.equal(source, "template");
    assert.equal(draft.templateId, "crm");
    assert.ok(draft.appName.includes("CRM"));
    assert.equal(emitted.length, 0, "template fallback emits no prose deltas");
  });
});

test("generateAppDraftViaLLM streams prose deltas and returns the parsed tool input as an AppDraft", async () => {
  const factory: AnthropicClientFactory = () =>
    streamingClient({
      proseChunks: ["I'll add ", "a Leads page, ", "then wire CRUD."],
    });
  const emitted: string[] = [];
  const draft = await generateAppDraftViaLLM(
    "Build a CRM for boutique sales teams to track leads and deals.",
    { apiKey: "test-key", clientFactory: factory, preset: "smart" },
    (text) => {
      emitted.push(text);
    },
  );
  assert.ok(draft, "expected a draft from the LLM path");
  assert.equal(emitted.join(""), "I'll add a Leads page, then wire CRUD.");
  assert.equal(draft.templateId, "crm");
  assert.equal(draft.appName, "Boutique CRM");
  assert.equal(draft.prompt, "Build a CRM for boutique sales teams to track leads and deals.");
  assert.ok(draft.pageMap.some((page) => page.path === "/leads" && page.primaryEntity === "lead"));
  assert.ok(draft.auth.publicRoutes.includes("/login"));
  assert.ok(draft.auth.privateRoutes.includes("/leads"));
  assert.equal(draft.dataSchema.database, "postgres");
  assert.equal(draft.dataSchema.entities[0].name, "lead");
  assert.equal(draft.seedData.lead.length, 1);
  // Integration metadata defaults to empty when the model omits it.
  assert.deepEqual(draft.integrationMetadata.requested, []);
});

test("generateAppDraftViaLLM returns null when the model never calls the tool", async () => {
  const factory: AnthropicClientFactory = () =>
    streamingClient({
      proseChunks: ["just thinking out loud"],
      omitToolCall: true,
    });
  const draft = await generateAppDraftViaLLM("Build a CRM for sales teams to track leads.", {
    apiKey: "test-key",
    clientFactory: factory,
  });
  assert.equal(draft, null);
});

test("generateAppDraftViaLLM retries malformed tool JSON exactly once", async () => {
  let calls = 0;
  let correctionPrompt = "";
  const provider: LLMProvider = {
    name: "anthropic",
    async call(_opts: ProviderCallOptions): Promise<ProviderCallResult> {
      throw new Error("not used");
    },
    async *stream(opts: ProviderCallOptions): AsyncIterable<ProviderStreamChunk> {
      calls++;
      if (calls === 1) {
        yield {
          toolCall: {
            id: "bad",
            name: "submit_app_draft",
            input: {},
            inputError: "malformed_json",
          },
        };
      } else {
        correctionPrompt = opts.messages.at(-1)?.content ?? "";
        yield {
          toolCall: {
            id: "fixed",
            name: "submit_app_draft",
            input: SAMPLE_TOOL_INPUT,
          },
        };
      }
      yield {
        done: true,
        usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 },
      };
    },
    async models() {
      return [];
    },
  };

  const draft = await generateAppDraftViaLLM(
    "Build a CRM for boutique sales teams to track leads and deals.",
    { provider },
  );
  assert.ok(draft);
  assert.equal(calls, 2);
  assert.match(correctionPrompt, /single correction attempt/);
  assert.equal(draft.appName, "Boutique CRM");
});

test("generateAppDraftViaLLM stops after the one malformed-input correction", async () => {
  let calls = 0;
  const provider: LLMProvider = {
    name: "anthropic",
    async call(_opts: ProviderCallOptions): Promise<ProviderCallResult> {
      throw new Error("not used");
    },
    async *stream(): AsyncIterable<ProviderStreamChunk> {
      calls++;
      yield {
        toolCall: {
          id: `bad-${calls}`,
          name: "submit_app_draft",
          input: {},
          inputError: "malformed_json",
        },
      };
      yield {
        done: true,
        usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 },
      };
    },
    async models() {
      return [];
    },
  };

  const draft = await generateAppDraftViaLLM(
    "Build a CRM for boutique sales teams to track leads and deals.",
    { provider },
  );
  assert.equal(draft, null);
  assert.equal(calls, 2);
});
