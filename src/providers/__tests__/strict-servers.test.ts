import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  ANTHROPIC_MODEL_PRICING,
  buildAnthropicRequest,
  supportedEffortLevels,
} from "../anthropic.js";
import type { ProviderEffort } from "../types.js";
import { validateAnthropicRequest } from "./strict-anthropic-server.js";
import { validateOpenAIRequest } from "./strict-openai-server.js";

/**
 * The strict servers are only useful if they reject what the live APIs
 * reject. These tests pin the rules down, then prove the provider adapters
 * never build a request that trips them.
 */

/** The SDK renders Anthropic errors as `400 {json body}`; match on the body's message. */
function anthropicErrorMessage(error: InstanceType<typeof Anthropic.BadRequestError>): string {
  const body = error.error as { error?: { message?: string } } | undefined;
  return body?.error?.message ?? error.message;
}

function rejectsAnthropic(params: unknown, pattern: RegExp): void {
  assert.throws(
    () => validateAnthropicRequest(params),
    (error: unknown) => {
      assert.ok(error instanceof Anthropic.BadRequestError, "throws the SDK BadRequestError");
      assert.equal(error.status, 400);
      assert.match(error.message, /^400 /);
      assert.match(anthropicErrorMessage(error), pattern);
      return true;
    },
  );
}

function rejectsOpenAI(params: unknown, pattern: RegExp): void {
  assert.throws(
    () => validateOpenAIRequest(params),
    (error: unknown) => {
      assert.ok(error instanceof OpenAI.BadRequestError, "throws the SDK BadRequestError");
      assert.equal(error.status, 400);
      assert.match(error.message, pattern);
      return true;
    },
  );
}

const tools = [
  {
    name: "lookup",
    description: "look something up",
    input_schema: { type: "object", properties: { q: { type: "string" } } },
  },
];

function anthropicBase(model = "claude-opus-4-7") {
  return { model, max_tokens: 256, messages: [{ role: "user", content: "hi" }] };
}

test("strict anthropic: structural rules", () => {
  rejectsAnthropic(
    { model: "claude-opus-4-7", messages: [{ role: "user", content: "hi" }] },
    /max_tokens/,
  );
  rejectsAnthropic({ ...anthropicBase(), messages: [] }, /at least one message/);
  rejectsAnthropic(
    { ...anthropicBase(), messages: [{ role: "assistant", content: "hi" }] },
    /first message must use the "user" role/,
  );
  rejectsAnthropic(
    {
      ...anthropicBase(),
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: "x" },
      ],
    },
    /role/,
  );
  rejectsAnthropic(
    { ...anthropicBase(), messages: [{ role: "user", content: "   " }] },
    /non-empty/,
  );
  rejectsAnthropic({ ...anthropicBase(), output_format: {} }, /output_format: Extra inputs/);
  rejectsAnthropic(
    { ...anthropicBase(), tools: [{ name: "bad name", input_schema: {} }] },
    /tools.0.name/,
  );
  rejectsAnthropic(
    { ...anthropicBase(), tools: [{ name: "a", input_schema: { type: "string" } }] },
    /input_schema/,
  );
  assert.doesNotThrow(() => validateAnthropicRequest({ ...anthropicBase(), tools }));
});

test("strict anthropic: tool_result must answer a tool_use in the immediately preceding assistant message", () => {
  const request = (messages: unknown[]) => ({ ...anthropicBase(), tools, messages });
  // No tool_use at all.
  rejectsAnthropic(
    request([
      { role: "user", content: "hi" },
      { role: "assistant", content: "sure" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "{}" }] },
    ]),
    /unexpected tool_use_id found in tool_result blocks: toolu_1/,
  );
  // Wrong id: the real call is left unanswered.
  rejectsAnthropic(
    request([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "lookup", input: {} }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "{}" }] },
    ]),
    /without tool_result blocks immediately after: toolu_1/,
  );
  // Assistant tool_use with no tool_result at all.
  rejectsAnthropic(
    request([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "lookup", input: {} }],
      },
      { role: "user", content: "thanks" },
    ]),
    /tool_use ids were found without tool_result blocks immediately after: toolu_1/,
  );
  // Only one of two parallel calls answered.
  rejectsAnthropic(
    request([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_1", name: "lookup", input: {} },
          { type: "tool_use", id: "toolu_2", name: "lookup", input: {} },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "{}" }] },
    ]),
    /toolu_2/,
  );
  // tool_result after a text block in the same message.
  rejectsAnthropic(
    request([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "lookup", input: {} }],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "here" },
          { type: "tool_result", tool_use_id: "toolu_1", content: "{}" },
        ],
      },
    ]),
    /must come before other content blocks/,
  );
  // Trailing assistant tool_use (nothing after it).
  rejectsAnthropic(
    request([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "lookup", input: {} }],
      },
    ]),
    /without tool_result/,
  );
  // The happy path, including a follow-up user text message after the results.
  assert.doesNotThrow(() =>
    validateAnthropicRequest(
      request([
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "on it" },
            { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } },
            { type: "tool_use", id: "toolu_2", name: "lookup", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "{}" },
            { type: "tool_result", tool_use_id: "toolu_2", content: "{}" },
          ],
        },
        { role: "user", content: "please fix the call" },
      ]),
    ),
  );
});

test("strict anthropic: model-specific parameter rules", () => {
  rejectsAnthropic(
    { ...anthropicBase("claude-opus-4-7"), temperature: 0.2 },
    /sampling parameters/,
  );
  rejectsAnthropic({ ...anthropicBase("claude-sonnet-5"), top_p: 0.9 }, /sampling parameters/);
  rejectsAnthropic({ ...anthropicBase("claude-fable-5-1"), top_k: 4 }, /sampling parameters/);
  assert.doesNotThrow(() =>
    validateAnthropicRequest({ ...anthropicBase("claude-sonnet-4-6"), temperature: 0.2 }),
  );
  rejectsAnthropic(
    { ...anthropicBase("claude-sonnet-4-6"), temperature: 0.2, top_p: 0.9 },
    /cannot both be specified/,
  );

  rejectsAnthropic(
    { ...anthropicBase("claude-sonnet-5"), thinking: { type: "enabled", budget_tokens: 2048 } },
    /budget_tokens is not supported/,
  );
  rejectsAnthropic(
    { ...anthropicBase("claude-opus-4-7"), thinking: { type: "adaptive", budget_tokens: 2048 } },
    /budget_tokens: not allowed with adaptive/,
  );
  assert.doesNotThrow(() =>
    validateAnthropicRequest({
      ...anthropicBase("claude-sonnet-4-6"),
      max_tokens: 4096,
      thinking: { type: "enabled", budget_tokens: 2048 },
    }),
  );
  rejectsAnthropic(
    { ...anthropicBase("claude-haiku-4-5"), thinking: { type: "adaptive" } },
    /adaptive thinking is not supported/,
  );
  rejectsAnthropic(
    { ...anthropicBase("claude-fable-5-1"), thinking: { type: "disabled" } },
    /cannot be disabled/,
  );
  rejectsAnthropic(
    { ...anthropicBase("claude-sonnet-4-6"), thinking: { type: "adaptive" }, temperature: 0.2 },
    /may only be set to 1 when thinking is enabled/,
  );

  rejectsAnthropic(
    { ...anthropicBase("claude-fable-5-1"), tools, tool_choice: { type: "any" } },
    /not supported for this model/,
  );
  rejectsAnthropic(
    { ...anthropicBase("claude-fable-5-1"), tools, tool_choice: { type: "tool", name: "lookup" } },
    /not supported for this model/,
  );
  assert.doesNotThrow(() =>
    validateAnthropicRequest({
      ...anthropicBase("claude-opus-4-7"),
      tools,
      tool_choice: { type: "any" },
    }),
  );
  rejectsAnthropic(
    { ...anthropicBase("claude-opus-4-7"), tool_choice: { type: "any" } },
    /requires at least one tool/,
  );

  rejectsAnthropic(
    { ...anthropicBase("claude-sonnet-4-6"), output_config: { effort: "xhigh" } },
    /effort: "xhigh" is not supported/,
  );
  rejectsAnthropic(
    { ...anthropicBase("claude-haiku-4-5"), output_config: { effort: "low" } },
    /effort: "low" is not supported/,
  );
  assert.doesNotThrow(() =>
    validateAnthropicRequest({
      ...anthropicBase("claude-opus-4-7"),
      output_config: { effort: "xhigh" },
    }),
  );
  rejectsAnthropic(
    {
      ...anthropicBase("claude-opus-4-7"),
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "The answer is" },
      ],
    },
    /prefill/,
  );
});

test("strict anthropic: the provider never builds a request the protocol rejects", () => {
  const efforts: ProviderEffort[] = ["low", "medium", "high", "xhigh", "max"];
  for (const model of Object.keys(ANTHROPIC_MODEL_PRICING)) {
    for (const effort of efforts) {
      for (const temperature of [undefined, 0.2]) {
        const request = buildAnthropicRequest({
          model,
          workspaceId: "ws",
          routeKey: "agent.reasoning",
          effort,
          ...(temperature !== undefined ? { temperature } : {}),
          maxTokens: 2048,
          tools: [{ name: "lookup", description: "look", inputSchema: { type: "object" } }],
          structuredOutput: { name: "r", schema: { type: "object" } },
          messages: [
            { role: "system", content: "sys" },
            { role: "user", content: "hi" },
            {
              role: "assistant",
              content: "",
              toolCalls: [
                { id: "toolu_1", name: "lookup", input: { q: "x" } },
                { id: "toolu_2", name: "lookup", input: {}, inputError: "malformed_json" },
              ],
            },
            { role: "tool", toolCallId: "toolu_1", toolName: "lookup", content: "{}" },
            { role: "tool", toolCallId: "toolu_2", toolName: "lookup", content: "{}" },
            { role: "user", content: "fix it" },
          ],
        });
        assert.doesNotThrow(
          () => validateAnthropicRequest(request),
          `${model} effort=${effort} temperature=${String(temperature)}`,
        );
        if (supportedEffortLevels(model).length === 0) {
          assert.equal(request.output_config?.effort, undefined, `${model} drops effort`);
        }
        assert.equal("budget_tokens" in (request.thinking ?? {}), false);
      }
    }
  }
});

function openAIBase(model = "gpt-4o") {
  return { model, messages: [{ role: "user", content: "hi" }] };
}

const openAITools = [
  { type: "function", function: { name: "lookup", parameters: { type: "object" } } },
];

test("strict openai: structural rules", () => {
  rejectsOpenAI({ messages: [{ role: "user", content: "hi" }] }, /model/);
  rejectsOpenAI({ ...openAIBase(), messages: [] }, /non-empty array/);
  rejectsOpenAI({ ...openAIBase(), messages: [{ role: "robot", content: "hi" }] }, /role/);
  rejectsOpenAI(
    { ...openAIBase(), output_config: {} },
    /Unrecognized request argument supplied: output_config/,
  );
  rejectsOpenAI({ ...openAIBase(), tools: [{ type: "function", function: {} }] }, /function\.name/);
  rejectsOpenAI(
    { ...openAIBase(), tools: [{ function: { name: "x" } }] },
    /must be \{type: "function"/,
  );
  rejectsOpenAI(
    { ...openAIBase(), response_format: { type: "json_schema", json_schema: {} } },
    /json_schema\.name/,
  );
  rejectsOpenAI({ ...openAIBase(), tool_choice: "auto" }, /requires 'tools'/);
  assert.doesNotThrow(() =>
    validateOpenAIRequest({
      ...openAIBase(),
      tools: openAITools,
      tool_choice: "auto",
      max_tokens: 10,
      temperature: 0.2,
      response_format: {
        type: "json_schema",
        json_schema: { name: "r", schema: { type: "object" }, strict: true },
      },
    }),
  );
});

test("strict openai: tool messages must answer a preceding assistant tool_calls entry", () => {
  const call = (id: string) => ({
    id,
    type: "function",
    function: { name: "lookup", arguments: "{}" },
  });
  rejectsOpenAI(
    {
      ...openAIBase(),
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "sure" },
        { role: "tool", tool_call_id: "call_1", content: "{}" },
      ],
    },
    /must be a response to a preceding message with 'tool_calls'/,
  );
  rejectsOpenAI(
    {
      ...openAIBase(),
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: null, tool_calls: [call("call_1")] },
        { role: "tool", tool_call_id: "call_2", content: "{}" },
      ],
    },
    /call_2/,
  );
  rejectsOpenAI(
    {
      ...openAIBase(),
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: null, tool_calls: [call("call_1"), call("call_2")] },
        { role: "tool", tool_call_id: "call_1", content: "{}" },
        { role: "user", content: "next" },
      ],
    },
    /did not have response messages: call_2/,
  );
  rejectsOpenAI(
    {
      ...openAIBase(),
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: null, tool_calls: [call("call_1")] },
      ],
    },
    /did not have response messages: call_1/,
  );
  rejectsOpenAI(
    {
      ...openAIBase(),
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: null },
      ],
    },
    /must have 'content' or 'tool_calls'/,
  );
  assert.doesNotThrow(() =>
    validateOpenAIRequest({
      ...openAIBase(),
      tools: openAITools,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        { role: "assistant", content: null, tool_calls: [call("call_1"), call("call_2")] },
        { role: "tool", tool_call_id: "call_1", content: "{}" },
        { role: "tool", tool_call_id: "call_2", content: "{}" },
        { role: "user", content: "fix it" },
      ],
    }),
  );
});
