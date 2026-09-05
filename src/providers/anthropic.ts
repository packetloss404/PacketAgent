import Anthropic from "@anthropic-ai/sdk";
import type {
  ApiKeyResolver,
  LLMProvider,
  ProviderCallOptions,
  ProviderCallResult,
  ProviderEffort,
  ProviderFinishReason,
  ProviderMessage,
  ProviderStopDetails,
  ProviderStreamChunk,
  ProviderToolCall,
  ProviderToolDef,
  ProviderUsage,
} from "./types.js";
import { parseToolInput } from "./tool-input.js";

/** Per-request options the provider forwards to the SDK client. */
export interface AnthropicRequestOptions {
  signal?: AbortSignal | null;
}

export type AnthropicStreamEvents = AsyncIterable<Anthropic.MessageStreamEvent>;

/**
 * Structural subset of the official `Anthropic` client that the provider
 * depends on. A real `new Anthropic()` instance satisfies it; tests inject
 * hand-written fakes or the strict fake server in `__tests__/`.
 */
export interface AnthropicClient {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: AnthropicRequestOptions,
    ): Promise<Anthropic.Message>;
    stream?(
      params: Anthropic.MessageStreamParams,
      options?: AnthropicRequestOptions,
    ): AnthropicStreamEvents | Promise<AnthropicStreamEvents>;
  };
}

export interface AnthropicClientFactory {
  (apiKey: string): AnthropicClient;
}

/**
 * USD per 1M tokens for uncached input and output. Cache reads are billed at
 * 10% of the input rate and cache writes at 125% (see priceUsage).
 */
export const ANTHROPIC_MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-mythos-5-1": { input: 10, output: 50 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-7[1m]": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
};

const CACHE_READ_INPUT_MULTIPLIER = 0.1;
const CACHE_WRITE_INPUT_MULTIPLIER = 1.25;

export const ANTHROPIC_EFFORT_LEVELS: readonly ProviderEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export interface ClaudeModelId {
  family: "opus" | "sonnet" | "haiku" | "fable" | "mythos";
  major: number;
  minor: number;
}

/** Parses `claude-<family>-<major>[-<minor>]...` ids; null for anything else. */
export function parseClaudeModelId(model: string): ClaudeModelId | null {
  const match = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/.exec(model);
  if (!match) return null;
  const [, family, majorRaw, minorRaw] = match;
  return {
    family: family as ClaudeModelId["family"],
    major: Number(majorRaw),
    minor: minorRaw === undefined ? 0 : Number(minorRaw),
  };
}

function atLeast(id: ClaudeModelId, major: number, minor: number): boolean {
  return id.major > major || (id.major === major && id.minor >= minor);
}

/**
 * Sampling parameters (temperature/top_p/top_k) were removed from the Messages
 * API for Opus 4.7 and later, Sonnet 5 and later, and the Fable/Mythos tier;
 * sending them returns HTTP 400. Older models still accept them.
 */
export function supportsSamplingParameters(model: string): boolean {
  const id = parseClaudeModelId(model);
  if (!id) return true;
  switch (id.family) {
    case "fable":
    case "mythos":
      return false;
    case "opus":
      return !atLeast(id, 4, 7);
    case "sonnet":
      return !atLeast(id, 5, 0);
    default:
      return true;
  }
}

/**
 * `thinking: { type: "adaptive" }` is accepted on Opus 4.6+, Sonnet 4.6+ and
 * the Fable/Mythos tier (where thinking is always on). Older models need
 * `budget_tokens`, which this provider never sends.
 */
export function supportsAdaptiveThinking(model: string): boolean {
  const id = parseClaudeModelId(model);
  if (!id) return false;
  switch (id.family) {
    case "fable":
    case "mythos":
      return true;
    case "opus":
    case "sonnet":
      return atLeast(id, 4, 6);
    default:
      return false;
  }
}

/** `thinking.budget_tokens` is rejected (400) on Opus 4.7+, Sonnet 5+ and Fable/Mythos. */
export function supportsThinkingBudget(model: string): boolean {
  const id = parseClaudeModelId(model);
  if (!id) return true;
  switch (id.family) {
    case "fable":
    case "mythos":
      return false;
    case "opus":
      return !atLeast(id, 4, 7);
    case "sonnet":
      return !atLeast(id, 5, 0);
    default:
      return true;
  }
}

/** Forced `tool_choice` (`any` / `tool`) returns 400 on Fable 5.1 / Mythos 5.1 and later. */
export function supportsForcedToolChoice(model: string): boolean {
  const id = parseClaudeModelId(model);
  if (!id) return true;
  if (id.family === "fable" || id.family === "mythos") return !atLeast(id, 5, 1);
  return true;
}

/** Last-assistant-turn prefill returns 400 on the 4.6+ family and Fable/Mythos. */
export function supportsAssistantPrefill(model: string): boolean {
  const id = parseClaudeModelId(model);
  if (!id) return true;
  switch (id.family) {
    case "fable":
    case "mythos":
      return false;
    case "opus":
    case "sonnet":
      return !atLeast(id, 4, 6);
    default:
      return true;
  }
}

/**
 * Effort levels a model accepts in `output_config.effort`. Empty when the
 * model rejects the parameter (Haiku, Sonnet 4.5 and older, unknown ids).
 */
export function supportedEffortLevels(model: string): readonly ProviderEffort[] {
  const id = parseClaudeModelId(model);
  if (!id) return [];
  switch (id.family) {
    case "fable":
    case "mythos":
      return ANTHROPIC_EFFORT_LEVELS;
    case "opus":
      if (atLeast(id, 4, 7)) return ANTHROPIC_EFFORT_LEVELS;
      if (atLeast(id, 4, 6)) return ["low", "medium", "high", "max"];
      if (atLeast(id, 4, 5)) return ["low", "medium", "high"];
      return [];
    case "sonnet":
      if (atLeast(id, 5, 0)) return ANTHROPIC_EFFORT_LEVELS;
      if (atLeast(id, 4, 6)) return ["low", "medium", "high", "max"];
      return [];
    default:
      return [];
  }
}

/**
 * Clamps a requested effort to what the model accepts. Levels above the
 * model's ceiling fall back to `high`; models without effort get undefined.
 */
export function resolveEffort(model: string, effort?: ProviderEffort): ProviderEffort | undefined {
  if (!effort) return undefined;
  const levels = supportedEffortLevels(model);
  if (levels.length === 0) return undefined;
  if (levels.includes(effort)) return effort;
  return levels.includes("high") ? "high" : undefined;
}

const APPROX_TOKENS_FOR_CACHE_THRESHOLD = 1024;

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

type AssistantBlockParam = Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam;

export function buildSystemAndMessages(messages: ProviderMessage[]): {
  system?: string | Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
} {
  const systemTexts: string[] = [];
  const out: Anthropic.MessageParam[] = [];
  let toolBuffer: Anthropic.ToolResultBlockParam[] | null = null;

  for (const msg of messages) {
    if (msg.role === "system") {
      systemTexts.push(msg.content);
      continue;
    }
    if (msg.role === "tool") {
      const block: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: msg.toolCallId ?? "",
        content: msg.content,
      };
      if (toolBuffer) toolBuffer.push(block);
      else {
        toolBuffer = [block];
        out.push({ role: "user", content: toolBuffer });
      }
      continue;
    }
    toolBuffer = null;
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      // Replay the assistant's tool_use blocks so the following tool_result
      // blocks reference an id the API can see; otherwise the request is 400.
      const blocks: AssistantBlockParam[] = [];
      if (msg.content.length > 0) blocks.push({ type: "text", text: msg.content });
      for (const toolCall of msg.toolCalls) {
        blocks.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input ?? {},
        });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    out.push({ role: msg.role, content: msg.content });
  }

  if (systemTexts.length === 0) return { messages: out };

  const combined = systemTexts.join("\n\n");
  if (approxTokens(combined) >= APPROX_TOKENS_FOR_CACHE_THRESHOLD) {
    return {
      system: [{ type: "text", text: combined, cache_control: { type: "ephemeral" } }],
      messages: out,
    };
  }
  return { system: combined, messages: out };
}

function mapTools(tools: ProviderToolDef[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: { ...t.inputSchema, type: "object" },
  }));
}

/**
 * Builds the Messages API request for a provider call. Exported so tests can
 * assert the exact wire shape without going through a client.
 */
export function buildAnthropicRequest(
  opts: ProviderCallOptions,
): Anthropic.MessageCreateParamsNonStreaming {
  const { system, messages } = buildSystemAndMessages(opts.messages);
  const sendTemperature = opts.temperature !== undefined && supportsSamplingParameters(opts.model);
  // Thinking is incompatible with a non-default temperature, so an explicit
  // caller temperature wins on the 4.6 models that still accept both.
  const thinking: Anthropic.ThinkingConfigAdaptive | undefined =
    supportsAdaptiveThinking(opts.model) && !sendTemperature ? { type: "adaptive" } : undefined;
  const effort = resolveEffort(opts.model, opts.effort);
  const outputConfig: Anthropic.OutputConfig = {
    ...(effort ? { effort } : {}),
    ...(opts.structuredOutput
      ? { format: { type: "json_schema" as const, schema: opts.structuredOutput.schema } }
      : {}),
  };
  return {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 1024,
    messages,
    ...(system !== undefined ? { system } : {}),
    ...(sendTemperature ? { temperature: opts.temperature } : {}),
    ...(thinking ? { thinking } : {}),
    ...(opts.tools && opts.tools.length > 0 ? { tools: mapTools(opts.tools) } : {}),
    ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
  };
}

type UsageCounts = Pick<
  Anthropic.Usage,
  "input_tokens" | "output_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens"
>;

function mergeUsage(
  target: UsageCounts,
  source: Partial<Record<keyof UsageCounts, number | null | undefined>> | undefined,
): void {
  if (!source) return;
  for (const key of Object.keys(target) as (keyof UsageCounts)[]) {
    const value = source[key];
    if (typeof value === "number") target[key] = value;
  }
}

function priceUsage(model: string, usage: Partial<UsageCounts>): ProviderUsage {
  const pricing = ANTHROPIC_MODEL_PRICING[model];
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const costUsd = pricing
    ? (input * pricing.input +
        cacheRead * pricing.input * CACHE_READ_INPUT_MULTIPLIER +
        cacheWrite * pricing.input * CACHE_WRITE_INPUT_MULTIPLIER +
        output * pricing.output) /
      1_000_000
    : 0;
  // input_tokens excludes cached tokens; report the full prompt size.
  return { promptTokens: input + cacheRead + cacheWrite, completionTokens: output, costUsd };
}

function mapStopReason(reason: Anthropic.StopReason | null | undefined): ProviderFinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_use";
    case "refusal":
      return "refusal";
    default:
      return "error";
  }
}

function mapStopDetails(
  details: Anthropic.RefusalStopDetails | null | undefined,
): ProviderStopDetails | undefined {
  if (!details) return undefined;
  return { category: details.category ?? null, explanation: details.explanation ?? null };
}

function defaultClientFactory(apiKey: string): AnthropicClient {
  return new Anthropic({ apiKey });
}

export interface AnthropicProviderOptions {
  apiKeyResolver?: ApiKeyResolver;
  clientFactory?: AnthropicClientFactory;
}

export class AnthropicProvider implements LLMProvider {
  name = "anthropic" as const;
  private apiKeyResolver?: ApiKeyResolver;
  private clientFactory: AnthropicClientFactory;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.apiKeyResolver = opts.apiKeyResolver;
    this.clientFactory = opts.clientFactory ?? defaultClientFactory;
  }

  private async resolveApiKey(workspaceId: string): Promise<string> {
    if (this.apiKeyResolver) {
      const fromVault = await this.apiKeyResolver(workspaceId, "anthropic");
      if (fromVault) return fromVault;
    }
    const env = process.env.ANTHROPIC_API_KEY;
    if (env) return env;
    throw new Error(
      "anthropic: no API key available (vault returned null and ANTHROPIC_API_KEY not set)",
    );
  }

  async call(opts: ProviderCallOptions): Promise<ProviderCallResult> {
    const apiKey = await this.resolveApiKey(opts.workspaceId);
    const client = this.clientFactory(apiKey);
    const params = buildAnthropicRequest(opts);
    const response = await client.messages.create(params, { signal: opts.signal });
    const text: string[] = [];
    const toolCalls: ProviderToolCall[] = [];
    for (const block of response.content) {
      if (block.type === "text") {
        if (block.text) text.push(block.text);
      } else if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, name: block.name, ...parseToolInput(block.input) });
      }
    }
    const stopDetails = mapStopDetails(response.stop_details);
    return {
      content: text.join(""),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      finishReason: mapStopReason(response.stop_reason),
      ...(stopDetails ? { stopDetails } : {}),
      usage: priceUsage(response.model, response.usage),
      model: response.model,
      providerName: "anthropic",
    };
  }

  async *stream(opts: ProviderCallOptions): AsyncIterable<ProviderStreamChunk> {
    let apiKey: string;
    try {
      apiKey = await this.resolveApiKey(opts.workspaceId);
    } catch (error) {
      yield { error: (error as Error).message };
      return;
    }
    const client = this.clientFactory(apiKey);
    if (!client.messages.stream) {
      yield { error: "anthropic: client does not support streaming" };
      return;
    }
    const params = buildAnthropicRequest(opts);

    let stream: AnthropicStreamEvents;
    try {
      stream = await client.messages.stream(params, { signal: opts.signal });
    } catch (error) {
      yield { error: (error as Error).message };
      return;
    }

    const partialTools = new Map<number, { id: string; name: string; jsonAccum: string }>();
    const usage: UsageCounts = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
    };
    let finishReason: ProviderFinishReason | undefined;
    let stopDetails: ProviderStopDetails | undefined;

    try {
      for await (const event of stream) {
        if (opts.signal?.aborted) {
          yield { error: "aborted" };
          return;
        }
        switch (event.type) {
          case "message_start":
            mergeUsage(usage, event.message?.usage);
            break;
          case "content_block_start": {
            const block = event.content_block;
            if (block?.type === "tool_use") {
              partialTools.set(event.index, { id: block.id, name: block.name, jsonAccum: "" });
            }
            break;
          }
          case "content_block_delta": {
            const delta = event.delta;
            if (delta?.type === "text_delta" && delta.text) {
              yield { delta: delta.text };
            } else if (delta?.type === "input_json_delta" && delta.partial_json) {
              const tool = partialTools.get(event.index);
              if (tool) tool.jsonAccum += delta.partial_json;
            }
            break;
          }
          case "content_block_stop": {
            const tool = partialTools.get(event.index);
            if (tool) {
              yield {
                toolCall: { id: tool.id, name: tool.name, ...parseToolInput(tool.jsonAccum) },
              };
              partialTools.delete(event.index);
            }
            break;
          }
          case "message_delta":
            // message_delta carries cumulative output tokens; cache fields may
            // also appear here on newer API versions.
            mergeUsage(usage, event.usage);
            if (event.delta?.stop_reason) finishReason = mapStopReason(event.delta.stop_reason);
            stopDetails = mapStopDetails(event.delta?.stop_details) ?? stopDetails;
            break;
          default:
            break;
        }
      }
    } catch (error) {
      yield { error: (error as Error).message };
      return;
    }

    yield {
      done: true,
      usage: priceUsage(opts.model, usage),
      ...(finishReason ? { finishReason } : {}),
      ...(stopDetails ? { stopDetails } : {}),
    };
  }

  async models(): Promise<string[]> {
    return Object.keys(ANTHROPIC_MODEL_PRICING);
  }
}
