import OpenAI from "openai";
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
import { parseToolInput } from "./tool-input.js";

interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
}

interface OpenAIToolDef {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

interface OpenAIChatParams {
  model: string;
  messages: OpenAIChatMessage[];
  tools?: OpenAIToolDef[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  response_format?: {
    type: "json_schema";
    json_schema: {
      name: string;
      description?: string;
      schema: Record<string, unknown>;
      strict: boolean;
    };
  };
}

interface OpenAIChatChoice {
  index: number;
  message: OpenAIChatMessage;
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | "function_call" | null;
}

interface OpenAIChatResponse {
  id: string;
  model: string;
  choices: OpenAIChatChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface OpenAIChatStreamDelta {
  role?: string;
  content?: string;
  tool_calls?: {
    index: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }[];
}

interface OpenAIChatStreamChunk {
  id: string;
  model: string;
  choices: {
    index: number;
    delta: OpenAIChatStreamDelta;
    finish_reason: OpenAIChatChoice["finish_reason"];
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface OpenAIClient {
  chat: {
    completions: {
      create(
        params: OpenAIChatParams,
        opts?: { signal?: AbortSignal },
      ): Promise<OpenAIChatResponse>;
      create(
        params: OpenAIChatParams & { stream: true },
        opts?: { signal?: AbortSignal },
      ): Promise<AsyncIterable<OpenAIChatStreamChunk>>;
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

function mapMessages(messages: ProviderMessage[]): OpenAIChatMessage[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", content: m.content, tool_call_id: m.toolCallId };
    }
    return { role: m.role, content: m.content };
  });
}

function mapTools(tools: ProviderToolDef[] | undefined): OpenAIToolDef[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

function mapStructuredOutput(
  structuredOutput: ProviderCallOptions["structuredOutput"],
): OpenAIChatParams["response_format"] {
  if (!structuredOutput) return undefined;
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

function mapFinishReason(
  reason: OpenAIChatChoice["finish_reason"],
): ProviderCallResult["finishReason"] {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    default:
      return "error";
  }
}

function priceUsage(model: string, prompt: number, completion: number): ProviderUsage {
  const pricing = OPENAI_MODEL_PRICING[model];
  const costUsd = pricing ? (prompt * pricing.input + completion * pricing.output) / 1_000_000 : 0;
  return { promptTokens: prompt, completionTokens: completion, costUsd };
}

function defaultClientFactory(apiKey: string, baseURL?: string): OpenAIClient {
  return new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) }) as OpenAIClient;
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
    const params: OpenAIChatParams = {
      model: opts.model,
      messages: mapMessages(opts.messages),
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.tools ? { tools: mapTools(opts.tools) } : {}),
      ...(opts.structuredOutput
        ? { response_format: mapStructuredOutput(opts.structuredOutput) }
        : {}),
    };
    const response = await client.chat.completions.create(params, { signal: opts.signal });
    const choice = response.choices[0];
    const toolCalls: ProviderToolCall[] = [];
    if (choice?.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        toolCalls.push({
          id: tc.id,
          name: tc.function.name,
          ...parseToolInput(tc.function.arguments),
        });
      }
    }
    const usage = response.usage;
    return {
      content: choice?.message.content ?? "",
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      finishReason: mapFinishReason(choice?.finish_reason ?? null),
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
    const params: OpenAIChatParams & { stream: true } = {
      model: opts.model,
      messages: mapMessages(opts.messages),
      stream: true,
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.tools ? { tools: mapTools(opts.tools) } : {}),
      ...(opts.structuredOutput
        ? { response_format: mapStructuredOutput(opts.structuredOutput) }
        : {}),
    };

    let stream: AsyncIterable<OpenAIChatStreamChunk>;
    try {
      const result = await (
        client.chat.completions.create as unknown as (
          p: OpenAIChatParams & { stream: true },
          o?: { signal?: AbortSignal },
        ) => Promise<AsyncIterable<OpenAIChatStreamChunk>>
      )(params, { signal: opts.signal });
      stream = result;
    } catch (error) {
      yield { error: (error as Error).message };
      return;
    }

    const partials = new Map<number, { id?: string; name?: string; argsAccum: string }>();
    let prompt = 0,
      completion = 0,
      model = opts.model;

    try {
      for await (const chunk of stream) {
        if (opts.signal?.aborted) {
          yield { error: "aborted" };
          return;
        }
        if (chunk.model) model = chunk.model;
        const choice = chunk.choices[0];
        if (!choice) continue;
        if (choice.delta.content) yield { delta: choice.delta.content };
        if (choice.delta.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const slot = partials.get(tc.index) ?? { argsAccum: "" };
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name = tc.function.name;
            if (tc.function?.arguments) slot.argsAccum += tc.function.arguments;
            partials.set(tc.index, slot);
          }
        }
        if (choice.finish_reason && partials.size > 0) {
          for (const slot of partials.values()) {
            if (!slot.id || !slot.name) continue;
            yield {
              toolCall: {
                id: slot.id,
                name: slot.name,
                ...parseToolInput(slot.argsAccum),
              },
            };
          }
          partials.clear();
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

    yield { done: true, usage: priceUsage(model, prompt, completion) };
  }

  async models(): Promise<string[]> {
    return Object.keys(OPENAI_MODEL_PRICING);
  }
}
