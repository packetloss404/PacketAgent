import OpenAI from "openai";
import { readFileSync } from "node:fs";
import type { OpenAIChatStream, OpenAIClient, OpenAIRequestOptions } from "../openai.js";

type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion;
type ChatCompletionChunk = OpenAI.Chat.Completions.ChatCompletionChunk;
type ChatCompletionCreateParams = OpenAI.Chat.Completions.ChatCompletionCreateParams;
type ChatCompletionCreateParamsNonStreaming =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type ChatCompletionCreateParamsStreaming =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;

/**
 * A strict fake of the Chat Completions API. Like the Anthropic twin it
 * answers from a scripted transcript only after enforcing the protocol rules
 * the real endpoint enforces, throwing the SDK's `BadRequestError` (400).
 * OpenRouter, MiniMax and other OpenAI-compatible providers speak the same
 * wire format, so the same rules apply to them.
 */

export interface OpenAIScriptedToolCall {
  id: string;
  name: string;
  /** Raw JSON text; malformed text simulates a garbled tool call. */
  arguments: string;
}

export interface OpenAIScriptedCompletion {
  id?: string;
  model?: string;
  content: string | null;
  tool_calls?: OpenAIScriptedToolCall[];
  refusal?: string | null;
  finish_reason: OpenAI.Chat.Completions.ChatCompletion.Choice["finish_reason"];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export interface OpenAIScriptedTurn {
  completion?: OpenAIScriptedCompletion;
  /** Recorded stream chunks; only usable with `stream: true`. */
  chunks?: ChatCompletionChunk[];
}

export interface OpenAIScenario {
  description?: string;
  turns: OpenAIScriptedTurn[];
}

export interface OpenAITranscriptFixture {
  model: string;
  scenarios: Record<string, OpenAIScenario>;
}

export function loadOpenAITranscript(name = "openai-tool-loop"): OpenAITranscriptFixture {
  const url = new URL(`./fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as OpenAITranscriptFixture;
}

export function openAIBadRequest(
  message: string,
  param: string | null = null,
): InstanceType<typeof OpenAI.BadRequestError> {
  return new OpenAI.BadRequestError(
    400,
    { message, type: "invalid_request_error", param, code: null },
    message,
    new Headers(),
  );
}

const KNOWN_TOP_LEVEL_KEYS = new Set([
  "model",
  "messages",
  "tools",
  "tool_choice",
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "stream",
  "stream_options",
  "response_format",
  "stop",
  "n",
  "presence_penalty",
  "frequency_penalty",
  "seed",
  "user",
  "parallel_tool_calls",
  "reasoning_effort",
  "logit_bias",
  "logprobs",
  "top_logprobs",
  "metadata",
  "store",
  "service_tier",
  "modalities",
  "prediction",
  "audio",
  "web_search_options",
  "verbosity",
  "prompt_cache_key",
  "safety_identifier",
  "functions",
  "function_call",
]);

const FUNCTION_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const ROLES = new Set(["system", "developer", "user", "assistant", "tool", "function"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string, param: string | null = null): never {
  throw openAIBadRequest(message, param);
}

function validateTools(params: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  if (params.tools === undefined) return names;
  if (!Array.isArray(params.tools)) fail("tools: must be an array", "tools");
  params.tools.forEach((tool, index) => {
    const path = `tools[${index}]`;
    if (!isRecord(tool) || tool.type !== "function" || !isRecord(tool.function)) {
      fail(`${path}: must be {type: "function", function: {...}}`, path);
    }
    const fn = tool.function;
    if (typeof fn.name !== "string" || !FUNCTION_NAME_PATTERN.test(fn.name)) {
      fail(`${path}.function.name: must match ${FUNCTION_NAME_PATTERN}`, `${path}.function.name`);
    }
    if (names.has(fn.name)) fail(`${path}.function.name: duplicate tool name "${fn.name}"`);
    names.add(fn.name);
    if (fn.parameters !== undefined && !isRecord(fn.parameters)) {
      fail(`${path}.function.parameters: must be a JSON schema object`);
    }
    if (fn.description !== undefined && typeof fn.description !== "string") {
      fail(`${path}.function.description: must be a string`);
    }
  });
  return names;
}

function validateMessages(params: Record<string, unknown>): void {
  const messages = params.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    fail("messages: must be a non-empty array", "messages");
  }
  let pending = new Set<string>();
  const flushPending = (path: string) => {
    if (pending.size > 0) {
      fail(
        `${path}: An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. The following tool_call_ids did not have response messages: ${[...pending].join(", ")}`,
        "messages",
      );
    }
  };

  messages.forEach((message, index) => {
    const path = `messages[${index}]`;
    if (!isRecord(message)) fail(`${path}: must be an object`, path);
    if (typeof message.role !== "string" || !ROLES.has(message.role)) {
      fail(`${path}.role: must be one of ${[...ROLES].join(", ")}`, `${path}.role`);
    }
    if (message.role === "tool") {
      if (typeof message.tool_call_id !== "string" || message.tool_call_id.length === 0) {
        fail(`${path}.tool_call_id: must be a non-empty string`, `${path}.tool_call_id`);
      }
      if (typeof message.content !== "string" && !Array.isArray(message.content)) {
        fail(`${path}.content: tool message content must be a string or array`, `${path}.content`);
      }
      if (!pending.has(message.tool_call_id)) {
        fail(
          `${path}: Invalid parameter: messages with role 'tool' must be a response to a preceding message with 'tool_calls' containing tool_call_id "${message.tool_call_id}".`,
          `${path}.tool_call_id`,
        );
      }
      pending.delete(message.tool_call_id);
      return;
    }

    flushPending(path);

    if (message.role === "assistant") {
      const toolCalls = message.tool_calls;
      const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
      if (toolCalls !== undefined && !Array.isArray(toolCalls)) {
        fail(`${path}.tool_calls: must be an array`, `${path}.tool_calls`);
      }
      const content = message.content;
      const hasContent =
        typeof content === "string" || (Array.isArray(content) && content.length > 0);
      if (!hasContent && !hasToolCalls) {
        fail(
          `${path}: Invalid value for 'content': expected a string or array, got null. Assistant messages must have 'content' or 'tool_calls'.`,
          `${path}.content`,
        );
      }
      pending = new Set();
      if (hasToolCalls) {
        (toolCalls as unknown[]).forEach((call, callIndex) => {
          const callPath = `${path}.tool_calls[${callIndex}]`;
          if (!isRecord(call) || typeof call.id !== "string" || call.id.length === 0) {
            fail(`${callPath}.id: must be a non-empty string`, `${callPath}.id`);
          }
          if (call.type !== "function" || !isRecord(call.function)) {
            fail(`${callPath}: must be {type: "function", function: {...}}`, callPath);
          }
          if (typeof call.function.name !== "string" || call.function.name.length === 0) {
            fail(`${callPath}.function.name: must be a non-empty string`);
          }
          if (typeof call.function.arguments !== "string") {
            fail(`${callPath}.function.arguments: must be a JSON string`);
          }
          if (pending.has(call.id)) fail(`${callPath}.id: duplicate tool_call id "${call.id}"`);
          pending.add(call.id);
        });
      }
      return;
    }

    if (typeof message.content !== "string" && !Array.isArray(message.content)) {
      fail(
        `${path}.content: Invalid value: expected a string or array of content parts`,
        `${path}.content`,
      );
    }
  });

  flushPending(`messages[${messages.length}]`);
}

function validateToolChoice(params: Record<string, unknown>, toolNames: Set<string>): void {
  const choice = params.tool_choice;
  if (choice === undefined) return;
  if (toolNames.size === 0 && choice !== "none") {
    fail("tool_choice: requires 'tools' to be specified", "tool_choice");
  }
  if (typeof choice === "string") {
    if (!["none", "auto", "required"].includes(choice)) {
      fail(`tool_choice: unknown value "${choice}"`, "tool_choice");
    }
    return;
  }
  if (!isRecord(choice) || choice.type !== "function" || !isRecord(choice.function)) {
    fail('tool_choice: must be "none" | "auto" | "required" | {type: "function", ...}');
  }
  if (typeof choice.function.name !== "string" || !toolNames.has(choice.function.name)) {
    fail("tool_choice.function.name: must name one of the provided tools");
  }
}

function validateResponseFormat(params: Record<string, unknown>): void {
  const format = params.response_format;
  if (format === undefined) return;
  if (!isRecord(format) || typeof format.type !== "string") {
    fail("response_format: must be an object with a string type", "response_format");
  }
  if (format.type === "text" || format.type === "json_object") return;
  if (format.type !== "json_schema") fail(`response_format.type: unknown type "${format.type}"`);
  const schema = format.json_schema;
  if (
    !isRecord(schema) ||
    typeof schema.name !== "string" ||
    !FUNCTION_NAME_PATTERN.test(schema.name)
  ) {
    fail("response_format.json_schema.name: must be a valid schema name");
  }
  if (schema.schema !== undefined && !isRecord(schema.schema)) {
    fail("response_format.json_schema.schema: must be a JSON schema object");
  }
}

/** Throws `OpenAI.BadRequestError` when `params` would be rejected by the API. */
export function validateOpenAIRequest(params: unknown): void {
  if (!isRecord(params)) fail("request body must be an object");
  for (const key of Object.keys(params)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) fail(`Unrecognized request argument supplied: ${key}`, key);
  }
  if (typeof params.model !== "string" || params.model.length === 0) {
    fail("you must provide a model parameter", "model");
  }
  for (const key of ["max_tokens", "max_completion_tokens"]) {
    const value = params[key];
    if (value !== undefined && value !== null) {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        fail(`${key}: must be a positive integer`, key);
      }
    }
  }
  if (params.temperature !== undefined && params.temperature !== null) {
    if (
      typeof params.temperature !== "number" ||
      params.temperature < 0 ||
      params.temperature > 2
    ) {
      fail("temperature: must be a number between 0 and 2", "temperature");
    }
  }
  if (params.stream !== undefined && params.stream !== null && typeof params.stream !== "boolean") {
    fail("stream: must be a boolean", "stream");
  }
  validateMessages(params);
  const toolNames = validateTools(params);
  validateToolChoice(params, toolNames);
  validateResponseFormat(params);
}

export function toChatCompletion(
  scripted: OpenAIScriptedCompletion,
  requestModel: string,
  sequence: number,
): ChatCompletion {
  const toolCalls = scripted.tool_calls?.map((call) => ({
    id: call.id,
    type: "function" as const,
    function: { name: call.name, arguments: call.arguments },
  }));
  return {
    id: scripted.id ?? `chatcmpl_strict_${sequence}`,
    object: "chat.completion",
    created: 1_700_000_000 + sequence,
    model: scripted.model ?? requestModel,
    choices: [
      {
        index: 0,
        finish_reason: scripted.finish_reason,
        logprobs: null,
        message: {
          role: "assistant",
          content: scripted.content,
          refusal: scripted.refusal ?? null,
          ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
    usage: {
      prompt_tokens: scripted.usage?.prompt_tokens ?? 0,
      completion_tokens: scripted.usage?.completion_tokens ?? 0,
      total_tokens: (scripted.usage?.prompt_tokens ?? 0) + (scripted.usage?.completion_tokens ?? 0),
    },
  };
}

const STREAM_PIECE = 5;

function pieces(text: string): string[] {
  const out: string[] = [];
  for (let index = 0; index < text.length; index += STREAM_PIECE) {
    out.push(text.slice(index, index + STREAM_PIECE));
  }
  return out;
}

/** Turns a complete completion into the SDK's chunk sequence. */
export function synthesizeOpenAIStream(completion: ChatCompletion): ChatCompletionChunk[] {
  const choice = completion.choices[0];
  const base = {
    id: completion.id,
    object: "chat.completion.chunk" as const,
    created: completion.created,
    model: completion.model,
  };
  const chunk = (
    delta: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta,
    finish: OpenAI.Chat.Completions.ChatCompletionChunk.Choice["finish_reason"] = null,
  ): ChatCompletionChunk => ({
    ...base,
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
  });
  const chunks: ChatCompletionChunk[] = [chunk({ role: "assistant", content: "" })];
  if (typeof choice.message.content === "string") {
    for (const piece of pieces(choice.message.content)) chunks.push(chunk({ content: piece }));
  }
  if (choice.message.refusal) chunks.push(chunk({ refusal: choice.message.refusal }));
  (choice.message.tool_calls ?? []).forEach((call, index) => {
    if (call.type !== "function") return;
    const [first = "", ...rest] = pieces(call.function.arguments);
    chunks.push(
      chunk({
        tool_calls: [
          {
            index,
            id: call.id,
            type: "function",
            function: { name: call.function.name, arguments: first },
          },
        ],
      }),
    );
    for (const piece of rest) {
      chunks.push(chunk({ tool_calls: [{ index, function: { arguments: piece } }] }));
    }
  });
  chunks.push(chunk({}, choice.finish_reason));
  chunks.push({ ...base, choices: [], usage: completion.usage ?? null });
  return chunks;
}

async function* replay<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

export class StrictOpenAIServer implements OpenAIClient {
  /** Every request that passed validation, in order, deep-copied. */
  readonly requests: ChatCompletionCreateParams[] = [];
  private cursor = 0;
  readonly chat: OpenAIClient["chat"];

  constructor(private readonly turns: readonly OpenAIScriptedTurn[]) {
    this.chat = { completions: this };
  }

  get remainingTurns(): number {
    return this.turns.length - this.cursor;
  }

  create(
    params: ChatCompletionCreateParamsNonStreaming,
    options?: OpenAIRequestOptions,
  ): Promise<ChatCompletion>;
  create(
    params: ChatCompletionCreateParamsStreaming,
    options?: OpenAIRequestOptions,
  ): Promise<OpenAIChatStream>;
  async create(
    params: ChatCompletionCreateParams,
    options?: OpenAIRequestOptions,
  ): Promise<ChatCompletion | OpenAIChatStream> {
    if (options?.signal?.aborted) throw new OpenAI.APIUserAbortError();
    validateOpenAIRequest(params);
    this.requests.push(structuredClone(params));
    const turn = this.turns[this.cursor];
    if (!turn) throw new Error("strict-openai-server: transcript has no more turns");
    this.cursor++;
    if (params.stream) {
      if (turn.chunks) return replay(turn.chunks);
      if (!turn.completion) throw new Error("strict-openai-server: empty scripted turn");
      return replay(
        synthesizeOpenAIStream(toChatCompletion(turn.completion, params.model, this.cursor)),
      );
    }
    if (!turn.completion) throw new Error("strict-openai-server: scripted turn is stream-only");
    return toChatCompletion(turn.completion, params.model, this.cursor);
  }
}
