import OpenAI from "openai";
import type {
  ApiKeyResolver,
  LLMProvider,
  ProviderCallOptions,
  ProviderCallResult,
  ProviderFinishReason,
  ProviderMessage,
  ProviderStopDetails,
  ProviderStreamChunk,
  ProviderToolCall,
  ProviderToolDef,
  ProviderUsage,
} from "./types.js";
import { openAiToolCalls, parseToolInput } from "./tool-input.js";

type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion;
type ChatCompletionChunk = OpenAI.Chat.Completions.ChatCompletionChunk;
type ChatCompletionMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatCompletionTool = OpenAI.Chat.Completions.ChatCompletionTool;
type ChatCompletionCreateParamsNonStreaming =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type ChatCompletionCreateParamsStreaming =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
type ChatCompletionResponseFormat =
  OpenAI.Chat.Completions.ChatCompletionCreateParams["response_format"];
type ChatCompletionFinishReason = OpenAI.Chat.Completions.ChatCompletion.Choice["finish_reason"];

/** Per-request options the provider forwards to the SDK client. */
export interface OpenAIRequestOptions {
  signal?: AbortSignal | null;
}

export type OpenAIChatStream = AsyncIterable<ChatCompletionChunk>;

/**
 * Structural subset of the official `OpenAI` client that the provider depends
 * on. A real `new OpenAI()` instance satisfies it; tests inject fakes or the
 * strict fake server in `__tests__/`.
 */
export interface OpenAIClient {
  chat: {
    completions: {
      create(
        params: ChatCompletionCreateParamsNonStreaming,
        options?: OpenAIRequestOptions,
      ): Promise<ChatCompletion>;
      create(
        params: ChatCompletionCreateParamsStreaming,
        options?: OpenAIRequestOptions,
      ): Promise<OpenAIChatStream>;
    };
  };
}

export interface OpenAIClientFactory {
  (apiKey: string, baseURL?: string): OpenAIClient;
}

export const OPENAI_MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "o1-mini": { input: 3, output: 12 },
  "o3-mini": { input: 1.1, output: 4.4 },
  "gpt-4.1": { input: 2.5, output: 10 },
  "gpt-4.1-mini": { input: 0.15, output: 0.6 },
};

/**
 * Maps provider messages onto Chat Completions messages, replaying assistant
 * `tool_calls` so the `tool` messages that follow reference a known id.
 */
export function buildOpenAIChatMessages(messages: ProviderMessage[]): ChatCompletionMessageParam[] {
  return messages.map((m): ChatCompletionMessageParam => {
    switch (m.role) {
      case "tool":
        return { role: "tool", content: m.content, tool_call_id: m.toolCallId ?? "" };
      case "assistant":
        if (m.toolCalls && m.toolCalls.length > 0) {
          return {
            role: "assistant",
            content: m.content.length > 0 ? m.content : null,
            tool_calls: openAiToolCalls(m.toolCalls),
          };
        }
        return { role: "assistant", content: m.content };
      case "system":
        return { role: "system", content: m.content };
      default:
        return { role: "user", content: m.content };
    }
  });
}

function mapTools(tools: ProviderToolDef[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

function mapStructuredOutput(
  structuredOutput: NonNullable<ProviderCallOptions["structuredOutput"]>,
): ChatCompletionResponseFormat {
  return {
    type: "json_schema",
    json_schema: {
      name: structuredOutput.name,
      ...(structuredOutput.description ? { description: structuredOutput.description } : {}),
      schema: structuredOutput.schema,
      strict: structuredOutput.strict ?? true,
    },
  };
}

function mapFinishReason(reason: ChatCompletionFinishReason | null): ProviderFinishReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "refusal";
    default:
      return "error";
  }
}

function refusalDetails(
  finishReason: ChatCompletionFinishReason | null,
  refusal: string | null | undefined,
): ProviderStopDetails | undefined {
  if (finishReason !== "content_filter" && !refusal) return undefined;
  return {
    category: finishReason === "content_filter" ? "content_filter" : null,
    explanation: refusal ?? null,
  };
}

function priceUsage(model: string, prompt: number, completion: number): ProviderUsage {
  const pricing = OPENAI_MODEL_PRICING[model];
  const costUsd = pricing ? (prompt * pricing.input + completion * pricing.output) / 1_000_000 : 0;
  return { promptTokens: prompt, completionTokens: completion, costUsd };
}

function buildRequest(opts: ProviderCallOptions): ChatCompletionCreateParamsNonStreaming {
  return {
    model: opts.model,
    messages: buildOpenAIChatMessages(opts.messages),
    ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.tools && opts.tools.length > 0 ? { tools: mapTools(opts.tools) } : {}),
    ...(opts.structuredOutput
      ? { response_format: mapStructuredOutput(opts.structuredOutput) }
      : {}),
  };
}

function defaultClientFactory(apiKey: string, baseURL?: string): OpenAIClient {
  return new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
}

export interface OpenAIProviderOptions {
  apiKeyResolver?: ApiKeyResolver;
  baseURL?: string;
  clientFactory?: OpenAIClientFactory;
}

export class OpenAIProvider implements LLMProvider {
  name = "openai" as const;
  private apiKeyResolver?: ApiKeyResolver;
  private baseURL?: string;
  private clientFactory: OpenAIClientFactory;

  constructor(opts: OpenAIProviderOptions = {}) {
    this.apiKeyResolver = opts.apiKeyResolver;
    this.baseURL = opts.baseURL;
    this.clientFactory = opts.clientFactory ?? defaultClientFactory;
  }

  private async resolveApiKey(workspaceId: string): Promise<string> {
    if (this.apiKeyResolver) {
      const fromVault = await this.apiKeyResolver(workspaceId, "openai");
      if (fromVault) return fromVault;
    }
    const env = process.env.OPENAI_API_KEY;
    if (env) return env;
    throw new Error(
      "openai: no API key available (vault returned null and OPENAI_API_KEY not set)",
    );
  }

  async call(opts: ProviderCallOptions): Promise<ProviderCallResult> {
    const apiKey = await this.resolveApiKey(opts.workspaceId);
    const client = this.clientFactory(apiKey, this.baseURL);
    const response = await client.chat.completions.create(buildRequest(opts), {
      signal: opts.signal,
    });
    const choice = response.choices[0];
    const message = choice?.message;
    const toolCalls: ProviderToolCall[] = [];
    for (const tc of message?.tool_calls ?? []) {
      if (tc.type !== "function") continue;
      toolCalls.push({
        id: tc.id,
        name: tc.function.name,
        ...parseToolInput(tc.function.arguments),
      });
    }
    const rawFinish = choice?.finish_reason ?? null;
    const refusal = message?.refusal ?? null;
    const stopDetails = refusalDetails(rawFinish, refusal);
    const usage = response.usage;
    return {
      content: message?.content ?? "",
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      finishReason: refusal ? "refusal" : mapFinishReason(rawFinish),
      ...(stopDetails ? { stopDetails } : {}),
      usage: priceUsage(response.model, usage?.prompt_tokens ?? 0, usage?.completion_tokens ?? 0),
      model: response.model,
      providerName: "openai",
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
    const client = this.clientFactory(apiKey, this.baseURL);
    const params: ChatCompletionCreateParamsStreaming = { ...buildRequest(opts), stream: true };

    let stream: OpenAIChatStream;
    try {
      stream = await client.chat.completions.create(params, { signal: opts.signal });
    } catch (error) {
      yield { error: (error as Error).message };
      return;
    }

    const partials = new Map<number, { id?: string; name?: string; argsAccum: string }>();
    let prompt = 0;
    let completion = 0;
    let model = opts.model;
    let finishReason: ProviderFinishReason | undefined;
    let refusal = "";

    try {
      for await (const chunk of stream) {
        if (opts.signal?.aborted) {
          yield { error: "aborted" };
          return;
        }
        if (chunk.model) model = chunk.model;
        const choice = chunk.choices[0];
        if (choice) {
          if (choice.delta.content) yield { delta: choice.delta.content };
          if (choice.delta.refusal) refusal += choice.delta.refusal;
          for (const tc of choice.delta.tool_calls ?? []) {
            const slot = partials.get(tc.index) ?? { argsAccum: "" };
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name = tc.function.name;
            if (tc.function?.arguments) slot.argsAccum += tc.function.arguments;
            partials.set(tc.index, slot);
          }
          if (choice.finish_reason) {
            finishReason = refusal ? "refusal" : mapFinishReason(choice.finish_reason);
            for (const slot of partials.values()) {
              if (!slot.id || !slot.name) continue;
              yield {
                toolCall: { id: slot.id, name: slot.name, ...parseToolInput(slot.argsAccum) },
              };
            }
            partials.clear();
          }
        }
        if (chunk.usage) {
          prompt = chunk.usage.prompt_tokens;
          completion = chunk.usage.completion_tokens;
        }
      }
    } catch (error) {
      yield { error: (error as Error).message };
      return;
    }

    yield {
      done: true,
      usage: priceUsage(model, prompt, completion),
      ...(finishReason ? { finishReason } : {}),
      ...(finishReason === "refusal"
        ? { stopDetails: { category: null, explanation: refusal || null } }
        : {}),
    };
  }

  async models(): Promise<string[]> {
    return Object.keys(OPENAI_MODEL_PRICING);
  }
}
