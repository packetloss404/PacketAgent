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
import { PROVIDER_CATALOG } from "./catalog.js";

/**
 * Gemini provider — talks to Google's OpenAI-compatible endpoint.
 * Docs: https://ai.google.dev/gemini-api/docs/openai
 * Base URL is `/v1beta/openai/`, request/response shape mirrors OpenAI
 * `chat/completions`, auth is `Authorization: Bearer ${GOOGLE_API_KEY}`.
 *
 * Implemented with plain `fetch` (rather than going through the OpenAI SDK
 * with a custom baseURL) so tests can stub the network without dragging in
 * the SDK and so SSE parsing stays explicit.
 */

export const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

// Pricing (USD per 1M tokens). Values are best-effort approximations as of
// late 2026; unknown models simply fall through to costUsd = 0.
export const GEMINI_MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini-2.0-flash-exp": { input: 0, output: 0 },
  "gemini-1.5-pro": { input: 1.25, output: 5 },
  "gemini-1.5-flash": { input: 0.075, output: 0.3 },
};

export const GEMINI_DEFAULT_MODELS = PROVIDER_CATALOG.gemini.defaultModels;

interface GeminiChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
}

interface GeminiToolDef {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

interface GeminiChatRequest {
  model: string;
  messages: GeminiChatMessage[];
  tools?: GeminiToolDef[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
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

interface GeminiChatChoice {
  index: number;
  message: GeminiChatMessage;
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | "function_call" | null;
}

interface GeminiChatResponse {
  id: string;
  model: string;
  choices: GeminiChatChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface GeminiStreamDelta {
  role?: string;
  content?: string;
  tool_calls?: {
    index: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }[];
}

interface GeminiStreamChunk {
  id: string;
  model: string;
  choices: {
    index: number;
    delta: GeminiStreamDelta;
    finish_reason: GeminiChatChoice["finish_reason"];
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

function mapMessages(messages: ProviderMessage[]): GeminiChatMessage[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", content: m.content, tool_call_id: m.toolCallId };
    }
    return { role: m.role, content: m.content };
  });
}

function mapTools(tools: ProviderToolDef[] | undefined): GeminiToolDef[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

function mapFinishReason(
  reason: GeminiChatChoice["finish_reason"],
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
  const pricing = GEMINI_MODEL_PRICING[model];
  const costUsd = pricing ? (prompt * pricing.input + completion * pricing.output) / 1_000_000 : 0;
  return { promptTokens: prompt, completionTokens: completion, costUsd };
}

/** Read GOOGLE_API_KEY first, then GEMINI_API_KEY as a synonym. */
export function readGeminiEnvKey(): string | undefined {
  return process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
}

export interface GeminiProviderOptions {
  apiKeyResolver?: ApiKeyResolver;
  baseURL?: string;
  fetchFn?: typeof fetch;
}

export class GeminiProvider implements LLMProvider {
  name = "gemini" as const;
  private apiKeyResolver?: ApiKeyResolver;
  private baseURL: string;
  private fetchFn: typeof fetch;

  constructor(opts: GeminiProviderOptions = {}) {
    this.apiKeyResolver = opts.apiKeyResolver;
    this.baseURL = (opts.baseURL ?? GEMINI_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private async resolveApiKey(workspaceId: string): Promise<string> {
    if (this.apiKeyResolver) {
      const fromVault = await this.apiKeyResolver(workspaceId, "gemini");
      if (fromVault) return fromVault;
    }
    const env = readGeminiEnvKey();
    if (env) return env;
    throw new Error(
      "gemini: no API key available (vault returned null and GOOGLE_API_KEY / GEMINI_API_KEY not set)",
    );
  }

  private buildHeaders(apiKey: string): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    };
  }

  private buildBody(opts: ProviderCallOptions, stream: boolean): GeminiChatRequest {
    return {
      model: opts.model,
      messages: mapMessages(opts.messages),
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.tools ? { tools: mapTools(opts.tools) } : {}),
      ...(opts.structuredOutput
        ? {
            response_format: {
              type: "json_schema" as const,
              json_schema: {
                name: opts.structuredOutput.name,
                ...(opts.structuredOutput.description
                  ? { description: opts.structuredOutput.description }
                  : {}),
                schema: opts.structuredOutput.schema,
                strict: opts.structuredOutput.strict ?? true,
              },
            },
          }
        : {}),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    };
  }

  private async errorFromResponse(res: Response): Promise<string> {
    const text = await res.text().catch(() => "");
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string; status?: string } };
      if (parsed?.error?.message) detail = parsed.error.message;
    } catch {
      /* not JSON, keep raw text */
    }
    if (res.status === 401 || res.status === 403) {
      return `gemini: authentication failed (HTTP ${res.status}): ${detail || "check GOOGLE_API_KEY"}`;
    }
    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      const suffix = retryAfter ? ` (retry-after: ${retryAfter})` : "";
      return `gemini: rate limited (HTTP 429)${suffix}: ${detail}`;
    }
    return `gemini: HTTP ${res.status} ${detail}`;
  }

  async call(opts: ProviderCallOptions): Promise<ProviderCallResult> {
    const apiKey = await this.resolveApiKey(opts.workspaceId);
    const res = await this.fetchFn(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: this.buildHeaders(apiKey),
      body: JSON.stringify(this.buildBody(opts, false)),
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(await this.errorFromResponse(res));
    const json = (await res.json()) as GeminiChatResponse;
    const choice = json.choices[0];
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
    const usage = json.usage;
    return {
      content: choice?.message.content ?? "",
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      finishReason: mapFinishReason(choice?.finish_reason ?? null),
      usage: priceUsage(json.model, usage?.prompt_tokens ?? 0, usage?.completion_tokens ?? 0),
      model: json.model,
      providerName: "gemini",
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

    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: this.buildHeaders(apiKey),
        body: JSON.stringify(this.buildBody(opts, true)),
        signal: opts.signal,
      });
    } catch (error) {
      yield { error: `gemini: request failed: ${(error as Error).message}` };
      return;
    }

    if (!res.ok) {
      yield { error: await this.errorFromResponse(res) };
      return;
    }
    if (!res.body) {
      yield { error: "gemini: empty stream body" };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const partials = new Map<number, { id?: string; name?: string; argsAccum: string }>();
    let prompt = 0;
    let completion = 0;
    let model = opts.model;

    const flushPartials = function* (this: void): Generator<ProviderStreamChunk> {
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
    };

    try {
      while (true) {
        if (opts.signal?.aborted) {
          yield { error: "aborted" };
          return;
        }
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by blank lines (\n\n). Split, keep tail.
        let sepIdx: number;
        while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + 2);
          for (const line of rawEvent.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            let chunk: GeminiStreamChunk;
            try {
              chunk = JSON.parse(payload) as GeminiStreamChunk;
            } catch {
              continue;
            }
            if (chunk.model) model = chunk.model;
            const choice = chunk.choices?.[0];
            if (choice) {
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
                yield* flushPartials();
              }
            }
            if (chunk.usage) {
              prompt = chunk.usage.prompt_tokens;
              completion = chunk.usage.completion_tokens;
            }
          }
        }
      }
    } catch (error) {
      yield { error: `gemini: stream read failed: ${(error as Error).message}` };
      return;
    }

    // Drain any tool slots that survived without a finish_reason marker.
    if (partials.size > 0) yield* flushPartials();

    yield { done: true, usage: priceUsage(model, prompt, completion) };
  }

  async models(): Promise<string[]> {
    return Object.keys(GEMINI_MODEL_PRICING);
  }
}
