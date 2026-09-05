import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import type {
  AnthropicClient,
  AnthropicRequestOptions,
  AnthropicStreamEvents,
} from "../anthropic.js";
import {
  supportedEffortLevels,
  supportsAdaptiveThinking,
  supportsAssistantPrefill,
  supportsForcedToolChoice,
  supportsSamplingParameters,
  supportsThinkingBudget,
} from "../anthropic.js";

/**
 * A strict fake of the Messages API. It answers from a scripted transcript
 * but first enforces the protocol rules the real API enforces, throwing the
 * SDK's `BadRequestError` (HTTP 400) on any violation. The point is to make
 * the fake fail exactly where production would: a loop that forgets to replay
 * `tool_use` blocks, or a provider that sends `temperature` to Opus 4.7, is
 * rejected here instead of only against the live API.
 */

export interface AnthropicScriptedTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicScriptedToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  /** A string value simulates a garbled tool input the provider must flag. */
  input: unknown;
}

export interface AnthropicScriptedMessage {
  id?: string;
  model?: string;
  content: (AnthropicScriptedTextBlock | AnthropicScriptedToolUseBlock)[];
  stop_reason: Anthropic.StopReason;
  stop_details?: Anthropic.RefusalStopDetails | null;
  usage?: Partial<
    Pick<
      Anthropic.Usage,
      "input_tokens" | "output_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens"
    >
  >;
}

export interface AnthropicScriptedTurn {
  /** Non-streaming response; `stream()` synthesises SDK events from it. */
  message?: AnthropicScriptedMessage;
  /** Recorded stream events; only usable through `stream()`. */
  events?: Anthropic.MessageStreamEvent[];
}

export interface AnthropicScenario {
  description?: string;
  turns: AnthropicScriptedTurn[];
}

export interface AnthropicTranscriptFixture {
  model: string;
  scenarios: Record<string, AnthropicScenario>;
}

export function loadAnthropicTranscript(name = "anthropic-tool-loop"): AnthropicTranscriptFixture {
  const url = new URL(`./fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as AnthropicTranscriptFixture;
}

export function anthropicBadRequest(
  message: string,
): InstanceType<typeof Anthropic.BadRequestError> {
  return new Anthropic.BadRequestError(
    400,
    { type: "error", error: { type: "invalid_request_error", message } },
    message,
    new Headers(),
  );
}

const KNOWN_TOP_LEVEL_KEYS = new Set([
  "model",
  "max_tokens",
  "messages",
  "system",
  "tools",
  "tool_choice",
  "temperature",
  "top_p",
  "top_k",
  "stop_sequences",
  "stream",
  "metadata",
  "thinking",
  "output_config",
  "service_tier",
  "cache_control",
  "container",
  "context_management",
  "mcp_servers",
  "inference_geo",
  "speed",
]);

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw anthropicBadRequest(message);
}

type Block = Record<string, unknown> & { type: string };

function contentBlocks(content: unknown, path: string): Block[] {
  if (typeof content === "string") {
    if (content.trim().length === 0) fail(`${path}.content: text content blocks must be non-empty`);
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content) || content.length === 0) {
    fail(`${path}.content: must be a non-empty string or array of content blocks`);
  }
  return content.map((block, index) => {
    if (!isRecord(block) || typeof block.type !== "string") {
      fail(`${path}.content.${index}: content block must have a string "type"`);
    }
    return block as Block;
  });
}

function validateTools(params: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  if (params.tools === undefined) return names;
  if (!Array.isArray(params.tools)) fail("tools: must be an array");
  params.tools.forEach((tool, index) => {
    if (!isRecord(tool)) fail(`tools.${index}: must be an object`);
    if (typeof tool.name !== "string" || !TOOL_NAME_PATTERN.test(tool.name)) {
      fail(`tools.${index}.name: must match ${TOOL_NAME_PATTERN}`);
    }
    if (names.has(tool.name)) fail(`tools.${index}.name: duplicate tool name "${tool.name}"`);
    names.add(tool.name);
    if (typeof tool.type === "string" && tool.type !== "custom") return; // server tool
    if (!isRecord(tool.input_schema) || tool.input_schema.type !== "object") {
      fail(`tools.${index}.input_schema: must be a JSON schema with type "object"`);
    }
  });
  return names;
}

function validateMessages(params: Record<string, unknown>, model: string): void {
  const messages = params.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    fail("messages: at least one message is required");
  }
  const parsed = messages.map((message, index) => {
    const path = `messages.${index}`;
    if (!isRecord(message)) fail(`${path}: must be an object`);
    if (message.role !== "user" && message.role !== "assistant") {
      fail(`${path}.role: must be "user" or "assistant"`);
    }
    return {
      role: message.role,
      blocks: contentBlocks(message.content, path),
      path,
      toolUseIds: new Set<string>(),
    };
  });
  if (parsed[0].role !== "user")
    fail('messages.0.role: the first message must use the "user" role');

  for (let index = 0; index < parsed.length; index++) {
    const { role, blocks, path } = parsed[index];
    const previous = index > 0 ? parsed[index - 1] : null;
    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();
    let sawNonToolResult = false;

    blocks.forEach((block, blockIndex) => {
      const blockPath = `${path}.content.${blockIndex}`;
      switch (block.type) {
        case "text":
          if (typeof block.text !== "string" || block.text.trim().length === 0) {
            fail(`${blockPath}: text content blocks must be non-empty`);
          }
          sawNonToolResult = true;
          break;
        case "tool_use": {
          if (role !== "assistant") fail(`${blockPath}: tool_use blocks are assistant-only`);
          if (typeof block.id !== "string" || block.id.length === 0) {
            fail(`${blockPath}.id: must be a non-empty string`);
          }
          if (typeof block.name !== "string" || !TOOL_NAME_PATTERN.test(block.name)) {
            fail(`${blockPath}.name: must be a valid tool name`);
          }
          if (!isRecord(block.input)) fail(`${blockPath}.input: must be an object`);
          if (toolUseIds.has(block.id)) fail(`${blockPath}.id: duplicate tool_use id`);
          toolUseIds.add(block.id);
          sawNonToolResult = true;
          break;
        }
        case "tool_result": {
          if (role !== "user") fail(`${blockPath}: tool_result blocks are user-only`);
          if (sawNonToolResult) {
            fail(`${blockPath}: tool_result blocks must come before other content blocks`);
          }
          if (typeof block.tool_use_id !== "string" || block.tool_use_id.length === 0) {
            fail(`${blockPath}.tool_use_id: must be a non-empty string`);
          }
          if (
            block.content !== undefined &&
            typeof block.content !== "string" &&
            !Array.isArray(block.content)
          ) {
            fail(`${blockPath}.content: must be a string or array of blocks`);
          }
          if (toolResultIds.has(block.tool_use_id)) {
            fail(`${blockPath}.tool_use_id: duplicate tool_result for "${block.tool_use_id}"`);
          }
          const previousToolUseIds = previous?.role === "assistant" ? previous.toolUseIds : null;
          if (!previousToolUseIds || !previousToolUseIds.has(block.tool_use_id)) {
            fail(
              `${blockPath}: unexpected tool_use_id found in tool_result blocks: ${block.tool_use_id}. Each tool_result block must have a corresponding tool_use block in the previous message.`,
            );
          }
          toolResultIds.add(block.tool_use_id);
          break;
        }
        case "image":
        case "document":
        case "thinking":
        case "redacted_thinking":
          sawNonToolResult = true;
          break;
        default:
          fail(`${blockPath}.type: unsupported content block type "${block.type}"`);
      }
    });

    parsed[index].toolUseIds = toolUseIds;

    if (role === "assistant" && toolUseIds.size > 0) {
      const next = parsed[index + 1];
      const nextBlocks = next?.role === "user" ? next.blocks : [];
      const answered = new Set(
        nextBlocks
          .filter((block) => block.type === "tool_result")
          .map((block) => block.tool_use_id as string),
      );
      const unanswered = [...toolUseIds].filter((id) => !answered.has(id));
      if (unanswered.length > 0) {
        fail(
          `${path}: tool_use ids were found without tool_result blocks immediately after: ${unanswered.join(", ")}. Each tool_use block must have a corresponding tool_result block in the next message.`,
        );
      }
    }
  }

  const last = parsed[parsed.length - 1];
  if (last.role === "assistant" && !supportsAssistantPrefill(model)) {
    fail("messages: this model does not support assistant message prefill");
  }
}

function validateSystem(params: Record<string, unknown>): void {
  const system = params.system;
  if (system === undefined || typeof system === "string") return;
  if (!Array.isArray(system)) fail("system: must be a string or an array of text blocks");
  system.forEach((block, index) => {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      fail(`system.${index}: must be a text block`);
    }
  });
}

function validateSampling(params: Record<string, unknown>, model: string, thinkingOn: boolean) {
  const sampling = ["temperature", "top_p", "top_k"].filter((key) => params[key] !== undefined);
  if (sampling.length > 0 && !supportsSamplingParameters(model)) {
    fail(`${sampling[0]}: this model does not support sampling parameters`);
  }
  if (params.temperature !== undefined && params.top_p !== undefined) {
    fail("temperature and top_p cannot both be specified for this model");
  }
  if (params.temperature !== undefined) {
    if (
      typeof params.temperature !== "number" ||
      params.temperature < 0 ||
      params.temperature > 1
    ) {
      fail("temperature: must be a number between 0 and 1");
    }
    if (thinkingOn && params.temperature !== 1) {
      fail("temperature: may only be set to 1 when thinking is enabled");
    }
  }
  if (thinkingOn && params.top_k !== undefined) {
    fail("top_k: may not be set when thinking is enabled");
  }
}

function validateThinking(params: Record<string, unknown>, model: string): boolean {
  const thinking = params.thinking;
  if (thinking === undefined) return false;
  if (!isRecord(thinking) || typeof thinking.type !== "string") {
    fail("thinking: must be an object with a string type");
  }
  switch (thinking.type) {
    case "enabled": {
      if (!supportsThinkingBudget(model)) {
        fail(
          'thinking.type: "enabled" with budget_tokens is not supported on this model; use {type: "adaptive"}',
        );
      }
      const budget = thinking.budget_tokens;
      if (typeof budget !== "number" || !Number.isInteger(budget) || budget < 1024) {
        fail("thinking.budget_tokens: must be an integer >= 1024");
      }
      if (typeof params.max_tokens === "number" && budget >= params.max_tokens) {
        fail("thinking.budget_tokens: must be less than max_tokens");
      }
      return true;
    }
    case "adaptive":
      if (thinking.budget_tokens !== undefined) {
        fail("thinking.budget_tokens: not allowed with adaptive thinking");
      }
      if (!supportsAdaptiveThinking(model)) {
        fail("thinking.type: adaptive thinking is not supported on this model");
      }
      return true;
    case "disabled":
      if (/^claude-(fable|mythos)-/.test(model)) {
        fail("thinking.type: thinking cannot be disabled on this model");
      }
      return false;
    default:
      fail(`thinking.type: unknown thinking type "${thinking.type}"`);
  }
}

function validateToolChoice(
  params: Record<string, unknown>,
  model: string,
  toolNames: Set<string>,
  thinkingOn: boolean,
): void {
  const choice = params.tool_choice;
  if (choice === undefined) return;
  if (!isRecord(choice) || typeof choice.type !== "string") {
    fail("tool_choice: must be an object with a string type");
  }
  if (toolNames.size === 0 && choice.type !== "none") {
    fail("tool_choice: requires at least one tool");
  }
  switch (choice.type) {
    case "auto":
    case "none":
      return;
    case "any":
    case "tool":
      if (!supportsForcedToolChoice(model)) {
        fail('tool_choice: type "tool" and "any" are not supported for this model.');
      }
      if (thinkingOn) fail("tool_choice: forced tool use is incompatible with thinking");
      if (
        choice.type === "tool" &&
        (typeof choice.name !== "string" || !toolNames.has(choice.name))
      ) {
        fail("tool_choice.name: must name one of the provided tools");
      }
      return;
    default:
      fail(`tool_choice.type: unknown type "${choice.type}"`);
  }
}

function validateOutputConfig(params: Record<string, unknown>, model: string): void {
  const config = params.output_config;
  if (config === undefined) return;
  if (!isRecord(config)) fail("output_config: must be an object");
  for (const key of Object.keys(config)) {
    if (key !== "effort" && key !== "format")
      fail(`output_config.${key}: Extra inputs are not permitted`);
  }
  if (config.effort !== undefined && config.effort !== null) {
    const levels = supportedEffortLevels(model);
    if (
      typeof config.effort !== "string" ||
      !(levels as readonly string[]).includes(config.effort)
    ) {
      fail(`output_config.effort: "${String(config.effort)}" is not supported on this model`);
    }
  }
  if (config.format !== undefined && config.format !== null) {
    if (
      !isRecord(config.format) ||
      config.format.type !== "json_schema" ||
      !isRecord(config.format.schema)
    ) {
      fail('output_config.format: must be {type: "json_schema", schema: {...}}');
    }
  }
}

/** Throws `Anthropic.BadRequestError` when `params` would be rejected by the API. */
export function validateAnthropicRequest(params: unknown): void {
  if (!isRecord(params)) fail("request body must be an object");
  for (const key of Object.keys(params)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) fail(`${key}: Extra inputs are not permitted`);
  }
  if (typeof params.model !== "string" || params.model.length === 0) {
    fail("model: must be a non-empty string");
  }
  const model = params.model;
  if (
    typeof params.max_tokens !== "number" ||
    !Number.isInteger(params.max_tokens) ||
    params.max_tokens < 1
  ) {
    fail("max_tokens: Field required (must be a positive integer)");
  }
  if (params.stream !== undefined && typeof params.stream !== "boolean") {
    fail("stream: must be a boolean");
  }
  validateSystem(params);
  validateMessages(params, model);
  const toolNames = validateTools(params);
  const thinkingOn = validateThinking(params, model);
  validateSampling(params, model, thinkingOn);
  validateToolChoice(params, model, toolNames, thinkingOn);
  validateOutputConfig(params, model);
}

function fullUsage(usage: AnthropicScriptedMessage["usage"]): Anthropic.Usage {
  return {
    input_tokens: usage?.input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
    cache_creation: null,
    inference_geo: null,
    server_tool_use: null,
    service_tier: "standard",
  };
}

function toContentBlock(
  block: AnthropicScriptedTextBlock | AnthropicScriptedToolUseBlock,
): Anthropic.ContentBlock {
  if (block.type === "text") return { type: "text", text: block.text, citations: null };
  return {
    type: "tool_use",
    id: block.id,
    name: block.name,
    input: block.input,
    caller: { type: "direct" },
  };
}

export function toAnthropicMessage(
  scripted: AnthropicScriptedMessage,
  requestModel: string,
  sequence: number,
): Anthropic.Message {
  return {
    id: scripted.id ?? `msg_strict_${sequence}`,
    type: "message",
    role: "assistant",
    model: scripted.model ?? requestModel,
    content: scripted.content.map(toContentBlock),
    stop_reason: scripted.stop_reason,
    stop_sequence: null,
    stop_details: scripted.stop_details ?? null,
    container: null,
    usage: fullUsage(scripted.usage),
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

/** Turns a complete message into the SDK's raw stream event sequence. */
export function synthesizeAnthropicStream(
  message: Anthropic.Message,
): Anthropic.MessageStreamEvent[] {
  const events: Anthropic.MessageStreamEvent[] = [
    {
      type: "message_start",
      message: {
        ...message,
        content: [],
        stop_reason: null,
        stop_details: null,
        usage: { ...message.usage, output_tokens: 1 },
      },
    },
  ];
  message.content.forEach((block, index) => {
    if (block.type === "text") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "", citations: null },
      });
      for (const piece of pieces(block.text)) {
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: piece },
        });
      }
    } else if (block.type === "tool_use") {
      events.push({
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: {},
          caller: { type: "direct" },
        },
      });
      const raw = typeof block.input === "string" ? block.input : JSON.stringify(block.input);
      for (const piece of pieces(raw)) {
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: piece },
        });
      }
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({
    type: "message_delta",
    delta: {
      stop_reason: message.stop_reason,
      stop_sequence: null,
      stop_details: message.stop_details,
      container: null,
    },
    usage: {
      input_tokens: message.usage.input_tokens,
      output_tokens: message.usage.output_tokens,
      cache_creation_input_tokens: message.usage.cache_creation_input_tokens,
      cache_read_input_tokens: message.usage.cache_read_input_tokens,
      server_tool_use: null,
    },
  });
  events.push({ type: "message_stop" });
  return events;
}

async function* replay<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

export class StrictAnthropicServer implements AnthropicClient {
  /** Every request that passed validation, in order, deep-copied. */
  readonly requests: Anthropic.MessageStreamParams[] = [];
  private cursor = 0;

  constructor(private readonly turns: readonly AnthropicScriptedTurn[]) {}

  get remainingTurns(): number {
    return this.turns.length - this.cursor;
  }

  readonly messages = {
    create: async (
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: AnthropicRequestOptions,
    ): Promise<Anthropic.Message> => {
      this.accept(params, options);
      if (params.stream) fail("stream: use messages.stream() for streaming requests");
      const turn = this.nextTurn();
      if (!turn.message) {
        throw new Error("strict-anthropic-server: scripted turn is stream-only");
      }
      return toAnthropicMessage(turn.message, params.model, this.cursor);
    },
    stream: (
      params: Anthropic.MessageStreamParams,
      options?: AnthropicRequestOptions,
    ): AnthropicStreamEvents => {
      this.accept(params, options);
      const turn = this.nextTurn();
      if (turn.events) return replay(turn.events);
      if (!turn.message) throw new Error("strict-anthropic-server: empty scripted turn");
      return replay(
        synthesizeAnthropicStream(toAnthropicMessage(turn.message, params.model, this.cursor)),
      );
    },
  };

  private accept(params: Anthropic.MessageStreamParams, options?: AnthropicRequestOptions) {
    if (options?.signal?.aborted) throw new Anthropic.APIUserAbortError();
    validateAnthropicRequest(params);
    this.requests.push(structuredClone(params));
  }

  private nextTurn(): AnthropicScriptedTurn {
    const turn = this.turns[this.cursor];
    if (!turn) throw new Error("strict-anthropic-server: transcript has no more turns");
    this.cursor++;
    return turn;
  }
}
