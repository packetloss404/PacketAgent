import Anthropic from "@anthropic-ai/sdk";
import type {
  ApiKeyResolver,
  LLMProvider,
  ProviderCallOptions,
  ProviderCallResult,
  ProviderMessage,
  ProviderStreamChunk,
  ProviderToolCall,
  ProviderToolDef,
  ProviderUsage,
} from "./types.js";

interface AnthropicMessageBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicMessageBlock[];
}

interface AnthropicSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

interface AnthropicCreateParams {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | AnthropicSystemBlock[];
  tools?: { name: string; description: string; input_schema: Record<string, unknown> }[];
  temperature?: number;
  stream?: boolean;
}

interface AnthropicCreateResponse {
  id: string;
  content: AnthropicMessageBlock[];
  stop_reason: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | "error";
  usage: { input_tokens: number; output_tokens: number };
  model: string;
}

interface AnthropicStreamEvent {
  type:
    | "message_start"
    | "content_block_start"
    | "content_block_delta"
    | "content_block_stop"
    | "message_delta"
    | "message_stop";
  index?: number;
  delta?: { type: string; text?: string; partial_json?: string; stop_reason?: string };
  content_block?: AnthropicMessageBlock;
  message?: { usage?: { input_tokens: number; output_tokens: number } };
  usage?: { output_tokens: number };
}

export interface AnthropicClient {
  messages: {
    create(
      params: AnthropicCreateParams,
      opts?: { signal?: AbortSignal },
    ): Promise<AnthropicCreateResponse>;
    stream?(
      params: AnthropicCreateParams,
      opts?: { signal?: AbortSignal },
    ): AsyncIterable<AnthropicStreamEvent> | Promise<AsyncIterable<AnthropicStreamEvent>>;
  };
}

export interface AnthropicClientFactory {
  (apiKey: string): AnthropicClient;
}

export const ANTHROPIC_MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-7": { input: 15, output: 75 },
  "claude-opus-4-7[1m]": { input: 15, output: 75 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
};

const APPROX_TOKENS_FOR_CACHE_THRESHOLD = 1024;

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function buildSystemAndMessages(messages: ProviderMessage[]): {
  system?: string | AnthropicSystemBlock[];
  messages: AnthropicMessage[];
} {
  const systemTexts: string[] = [];
  const out: AnthropicMessage[] = [];
  let toolBuffer: AnthropicMessageBlock[] | null = null;

  for (const msg of messages) {
    if (msg.role === "system") {
      systemTexts.push(msg.content);
      continue;
    }
    if (msg.role === "tool") {
      const block: AnthropicMessageBlock = {
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

function mapTools(tools: ProviderToolDef[] | undefined) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

function priceUsage(model: string, input: number, output: number): ProviderUsage {
  const pricing = ANTHROPIC_MODEL_PRICING[model];
  const costUsd = pricing ? (input * pricing.input + output * pricing.output) / 1_000_000 : 0;
  return { promptTokens: input, completionTokens: output, costUsd };
}

function mapStopReason(
  reason: AnthropicCreateResponse["stop_reason"],
): ProviderCallResult["finishReason"] {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_use";
    default:
      return "error";
  }
}

function defaultClientFactory(apiKey: string): AnthropicClient {
  return new Anthropic({ apiKey }) as AnthropicClient;
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
    const { system, messages } = buildSystemAndMessages(opts.messages);
    const params: AnthropicCreateParams = {
      model: opts.model,
      max_tokens: opts.maxTokens ?? 1024,
      messages,
      ...(system !== undefined ? { system } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.tools ? { tools: mapTools(opts.tools) } : {}),
    };
    const response = await client.messages.create(params, { signal: opts.signal });
    const text: string[] = [];
    const toolCalls: ProviderToolCall[] = [];
    for (const block of response.content) {
      if (block.type === "text" && block.text) text.push(block.text);
      else if (block.type === "tool_use" && block.id && block.name) {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        });
      }
    }
    return {
      content: text.join(""),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      finishReason: mapStopReason(response.stop_reason),
      usage: priceUsage(response.model, response.usage.input_tokens, response.usage.output_tokens),
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
    const { system, messages } = buildSystemAndMessages(opts.messages);
    const params: AnthropicCreateParams & { stream: true } = {
      model: opts.model,
      max_tokens: opts.maxTokens ?? 1024,
      messages,
      stream: true,
      ...(system !== undefined ? { system } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.tools ? { tools: mapTools(opts.tools) } : {}),
    };

    let stream: AsyncIterable<AnthropicStreamEvent>;
    try {
      if (client.messages.stream) {
        stream = await client.messages.stream(params, { signal: opts.signal });
      } else {
        stream = await (
          client.messages.create as unknown as (
            p: AnthropicCreateParams,
            o?: { signal?: AbortSignal },
          ) => Promise<AsyncIterable<AnthropicStreamEvent>>
        )(params, { signal: opts.signal });
      }
    } catch (error) {
      yield { error: (error as Error).message };
      return;
    }

    const partialTools = new Map<number, { id: string; name: string; jsonAccum: string }>();
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      for await (const event of stream) {
        if (opts.signal?.aborted) {
          yield { error: "aborted" };
          return;
        }
        if (event.type === "message_start" && event.message?.usage) {
          inputTokens = event.message.usage.input_tokens;
          outputTokens = event.message.usage.output_tokens;
          continue;
        }
        if (event.type === "content_block_start") {
          if (
            event.content_block?.type === "tool_use" &&
            event.content_block.id &&
            event.content_block.name &&
            typeof event.index === "number"
          ) {
            partialTools.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              jsonAccum: "",
            });
          }
          continue;
        }
        if (event.type === "content_block_delta" && event.delta) {
          if (event.delta.type === "text_delta" && event.delta.text)
            yield { delta: event.delta.text };
          else if (
            event.delta.type === "input_json_delta" &&
            event.delta.partial_json &&
            typeof event.index === "number"
          ) {
            const tool = partialTools.get(event.index);
            if (tool) tool.jsonAccum += event.delta.partial_json;
          }
          continue;
        }
        if (event.type === "content_block_stop" && typeof event.index === "number") {
          const tool = partialTools.get(event.index);
          if (tool) {
            let parsed: Record<string, unknown> = {};
            try {
              parsed = tool.jsonAccum ? JSON.parse(tool.jsonAccum) : {};
            } catch {
              parsed = {};
            }
            yield { toolCall: { id: tool.id, name: tool.name, input: parsed } };
            partialTools.delete(event.index);
          }
          continue;
        }
        if (event.type === "message_delta" && event.usage) {
          outputTokens = event.usage.output_tokens;
          continue;
        }
      }
    } catch (error) {
      yield { error: (error as Error).message };
      return;
    }

    yield { done: true, usage: priceUsage(opts.model, inputTokens, outputTokens) };
  }

  async models(): Promise<string[]> {
    return Object.keys(ANTHROPIC_MODEL_PRICING);
  }
}
