import assert from "node:assert/strict";
import test from "node:test";
import type {
  LLMProvider,
  ProviderCallOptions,
  ProviderCallResult,
  ProviderStreamChunk,
} from "../providers/types.js";
import { generateAgentTemplateViaLlm } from "./llm-template.js";

const validTemplate = {
  category: "research",
  name: "Evidence research agent",
  summary: "Researches supplied evidence and reports a bounded decision.",
  description: "Reviews one evidence URL and stops after reporting findings and open risks.",
  instructions:
    "Read only the supplied evidence. Never reuse authorization=temporary-value. Report findings, risks, and the next action. Stop after one report.",
  tools: ["http_fetch", "not_registered"],
  triggerKind: "manual",
  schedule: "",
  inputSchema: [
    {
      key: "source_url",
      label: "Source URL",
      type: "url",
      required: true,
      description: "Public evidence URL to inspect.",
      options: [],
      defaultValue: "https://example.com/evidence",
    },
    {
      key: "depth",
      label: "Depth",
      type: "enum",
      required: false,
      description: "Research depth.",
      options: ["quick", "deep"],
      defaultValue: "quick",
    },
  ],
  playbook: [
    { title: "Validate input", instruction: "Confirm the URL and requested depth." },
    { title: "Research", instruction: "Read the source with the allowed HTTP tool." },
    { title: "Report", instruction: "Return findings, risks, and the next action, then stop." },
  ],
  acceptanceChecks: ["The report cites the supplied source and names unresolved risks."],
  openQuestions: ["Should later versions compare more than one source?"],
};

test("LLM AgentTemplate authoring uses structured output and semantically constrains values", async () => {
  let captured: ProviderCallOptions | undefined;
  const provider = fakeProvider("openai", async (options) => {
    captured = options;
    return response(JSON.stringify(validTemplate), "openai", "gpt-test");
  });

  const result = await generateAgentTemplateViaLlm(
    {
      prompt: "Build a manual research agent that reviews an evidence URL and reports risks.",
      workspaceId: "alpha",
      allowedTools: ["http_fetch", "email_send"],
      recommendedTools: ["http_fetch"],
      triggerKind: "manual",
    },
    { provider, model: "gpt-test" },
  );

  assert.equal(result.source, "llm");
  if (result.source !== "llm") return;
  assert.equal(result.provider, "openai");
  assert.equal(result.model, "gpt-test");
  assert.deepEqual(result.template.tools, ["http_fetch"]);
  assert.match(result.template.instructions, /authorization=\[redacted\]/);
  assert.doesNotMatch(result.template.instructions, /temporary-value/);
  assert.equal(result.template.triggerKind, "manual");
  assert.equal(result.template.schedule, undefined);
  assert.deepEqual(
    result.template.inputSchema.map((field) => ({
      key: field.key,
      type: field.type,
      defaultValue: field.defaultValue,
    })),
    [
      {
        key: "source_url",
        type: "url",
        defaultValue: "https://example.com/evidence",
      },
      { key: "depth", type: "enum", defaultValue: "quick" },
    ],
  );
  assert.equal(result.template.playbook[0].id, "llm_step_1");
  assert.equal(captured?.structuredOutput?.name, "packetagent_agent_template");
  const properties = captured?.structuredOutput?.schema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  assert.deepEqual((properties?.tools?.items as { enum?: string[] } | undefined)?.enum, [
    "http_fetch",
    "email_send",
  ]);
  assert.deepEqual(properties?.triggerKind?.enum, ["manual"]);
  assert.deepEqual(properties?.schedule?.enum, [""]);
  assert.match(captured?.messages[0]?.content ?? "", /untrusted data/);
});

test("LLM AgentTemplate authoring uses bounded best-effort JSON for providers without schema mode", async () => {
  let captured: ProviderCallOptions | undefined;
  const provider = fakeProvider("minimax", async (options) => {
    captured = options;
    return response(
      `Here is the draft:\n\`\`\`json\n${JSON.stringify(validTemplate)}\n\`\`\``,
      "minimax",
      "minimax-test",
    );
  });

  const result = await generateAgentTemplateViaLlm(
    {
      prompt: "Build a manual research agent that reviews an evidence URL and reports risks.",
      workspaceId: "alpha",
      allowedTools: ["http_fetch"],
      recommendedTools: ["http_fetch"],
      triggerKind: "manual",
    },
    { provider, model: "minimax-test" },
  );

  assert.equal(result.source, "llm");
  assert.equal(captured?.structuredOutput, undefined);
  assert.match(captured?.messages.at(-1)?.content ?? "", /JSON Schema/);
});

test("LLM AgentTemplate authoring falls back for trigger substitution or incomplete output", async () => {
  const substituted = await generateAgentTemplateViaLlm(
    {
      prompt: "Build a manual research agent that reviews evidence and reports risks.",
      workspaceId: "alpha",
      allowedTools: ["http_fetch"],
      recommendedTools: ["http_fetch"],
      triggerKind: "manual",
    },
    {
      provider: fakeProvider("openai", async () =>
        response(
          JSON.stringify({ ...validTemplate, triggerKind: "schedule", schedule: "0 * * * *" }),
          "openai",
          "gpt-test",
        ),
      ),
      model: "gpt-test",
    },
  );
  assert.deepEqual(substituted, { source: "heuristic", fallbackReason: "invalid_output" });

  const incomplete = await generateAgentTemplateViaLlm(
    {
      prompt: "Build a manual research agent that reviews evidence and reports risks.",
      workspaceId: "alpha",
      allowedTools: ["http_fetch"],
      recommendedTools: ["http_fetch"],
      triggerKind: "manual",
    },
    {
      provider: fakeProvider("openai", async () => ({
        ...response("{}", "openai", "gpt-test"),
        finishReason: "length",
      })),
      model: "gpt-test",
    },
  );
  assert.deepEqual(incomplete, { source: "heuristic", fallbackReason: "incomplete_output" });

  const unexpectedToolUse = await generateAgentTemplateViaLlm(
    {
      prompt: "Build a manual research agent that reviews evidence and reports risks.",
      workspaceId: "alpha",
      allowedTools: ["http_fetch"],
      recommendedTools: ["http_fetch"],
      triggerKind: "manual",
    },
    {
      provider: fakeProvider("openai", async () => ({
        ...response(JSON.stringify(validTemplate), "openai", "gpt-test"),
        finishReason: "tool_use",
      })),
      model: "gpt-test",
    },
  );
  assert.deepEqual(unexpectedToolUse, {
    source: "heuristic",
    fallbackReason: "incomplete_output",
  });

  const sensitiveInput = await generateAgentTemplateViaLlm(
    {
      prompt: "Build a manual research agent that reviews evidence and reports risks.",
      workspaceId: "alpha",
      allowedTools: ["http_fetch"],
      recommendedTools: ["http_fetch"],
      triggerKind: "manual",
    },
    {
      provider: fakeProvider("openai", async () =>
        response(
          JSON.stringify({
            ...validTemplate,
            inputSchema: [{ ...validTemplate.inputSchema[0], key: "api_key" }],
          }),
          "openai",
          "gpt-test",
        ),
      ),
      model: "gpt-test",
    },
  );
  assert.deepEqual(sensitiveInput, { source: "heuristic", fallbackReason: "invalid_output" });

  const credentialUrl = await generateAgentTemplateViaLlm(
    {
      prompt: "Build a manual research agent that reviews evidence and reports risks.",
      workspaceId: "alpha",
      allowedTools: ["http_fetch"],
      recommendedTools: ["http_fetch"],
      triggerKind: "manual",
    },
    {
      provider: fakeProvider("openai", async () =>
        response(
          JSON.stringify({
            ...validTemplate,
            inputSchema: [
              {
                ...validTemplate.inputSchema[0],
                defaultValue: "https://operator:secret@example.com/evidence",
              },
            ],
          }),
          "openai",
          "gpt-test",
        ),
      ),
      model: "gpt-test",
    },
  );
  assert.deepEqual(credentialUrl, { source: "heuristic", fallbackReason: "invalid_output" });
});

function fakeProvider(
  name: LLMProvider["name"],
  call: (options: ProviderCallOptions) => Promise<ProviderCallResult>,
): LLMProvider {
  return {
    name,
    call,
    async *stream(): AsyncIterable<ProviderStreamChunk> {
      yield { done: true };
    },
    async models() {
      return ["test-model"];
    },
  };
}

function response(
  content: string,
  providerName: ProviderCallResult["providerName"],
  model: string,
): ProviderCallResult {
  return {
    content,
    finishReason: "stop",
    usage: { promptTokens: 100, completionTokens: 100, costUsd: 0.01 },
    model,
    providerName,
  };
}
