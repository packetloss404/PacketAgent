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

// OpenRouter (https://openrouter.ai) is a meta-provider that proxies ~200 models
// behind a single OpenAI-compatible Chat Completions API. We hit it over HTTP
// directly (no SDK) and reuse the OpenAI-shape request/response.
//
// Gotcha: free-tier OpenRouter routes for many otherwise-tool-capable models
// will respond with "No endpoints found that support tool use". When you see
// that surface verbatim from us, switch to a paid model slug (anthropic/...,
// openai/..., google/...) rather than a `:free` variant.

export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_DEFAULT_APP_NAME = "PacketAgent";
const OPENROUTER_DEFAULT_SITE_URL = "PacketAgent";

// OpenRouter exposes per-model unit prices via its /models endpoint at runtime;
// we keep a small static table for the curated preset defaults so the ledger
// can attribute cost without a network hop. Prices are USD per 1M tokens.
export const OPENROUTER_MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "qwen/qwen3-coder": { input: 0.2, output: 0.8 },
  "meta-llama/llama-3.3-70b-instruct": { input: 0.13, output: 0.4 },
  "anthropic/claude-haiku-4-5": { input: 1, output: 5 },
  "anthropic/claude-sonnet-4-6": { input: 3, output: 15 },
  "openai/gpt-4o-mini": { input: 0.15, output: 0.6 },
  "openai/gpt-4o": { input: 2.5, output: 10 },
};

interface OpenRouterChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
}

interface OpenRouterChatRequest {
  model: string;
  messages: OpenRouterChatMessage[];
  tools?: {
    type: "function";
    function: { name: string; description?: string; parameters: Record<string, unknown> };
  }[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

interface OpenRouterChatChoice {
  index: number;
  message: OpenRouterChatMessage;
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | "function_call" | null;
}

interface OpenRouterChatResponse {
  id: string;
  model: string;
  choices: OpenRouterChatChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  error?: { message: string; code?: number | string };
}

interface OpenRouterStreamDelta {
  role?: string;
  content?: string;
  tool_calls?: {
    index: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }[];
}

interface OpenRouterStreamChunk {
  id?: string;
  model?: string;
  choices?: {
    index: number;
    delta: OpenRouterStreamDelta;
    finish_reason: OpenRouterChatChoice["finish_reason"];
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  error?: { message: string; code?: number | string };
}

function mapMessages(messages: ProviderMessage[]): OpenRouterChatMessage[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", content: m.content, tool_call_id: m.toolCallId };
    }
    return { role: m.role, content: m.content };
  });
}

function mapTools(tools: ProviderToolDef[] | undefined) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

function mapFinishReason(
  reason: OpenRouterChatChoice["finish_reason"],
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
  const pricing = OPENROUTER_MODEL_PRICING[model];
  const costUsd = pricing ? (prompt * pricing.input + completion * pricing.output) / 1_000_000 : 0;
  return { promptTokens: prompt, completionTokens: completion, costUsd };
}

function authErrorMessage(status: number, body: string): string {
  if (status === 401 || status === 403) {
    return `openrouter: authentication failed (HTTP ${status}). Check OPENROUTER_API_KEY or the workspace vault entry. ${body}`.trim();
  }
  if (status === 404) {
    return `openrouter: model not found (HTTP 404). ${body}`.trim();
  }
  return `openrouter: HTTP ${status} ${body}`.trim();
}

export interface OpenRouterProviderOptions {
  apiKeyResolver?: ApiKeyResolver;
  baseURL?: string;
  appName?: string;
  siteUrl?: string;
  fetchFn?: typeof fetch;
}

export class OpenRouterProvider implements LLMProvider {
  name = "openrouter" as const;
  private apiKeyResolver?: ApiKeyResolver;
  private baseURL: string;
  private appName: string;
  private siteUrl: string;
  private fetchFn: typeof fetch;

  constructor(opts: OpenRouterProviderOptions = {}) {
    this.apiKeyResolver = opts.apiKeyResolver;
    this.baseURL = opts.baseURL ?? process.env.OPENROUTER_BASE_URL ?? OPENROUTER_DEFAULT_BASE_URL;
    this.appName = opts.appName ?? process.env.OPENROUTER_APP_NAME ?? OPENROUTER_DEFAULT_APP_NAME;
    this.siteUrl = opts.siteUrl ?? process.env.OPENROUTER_SITE_URL ?? OPENROUTER_DEFAULT_SITE_URL;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private async resolveApiKey(workspaceId: string): Promise<string> {
    if (this.apiKeyResolver) {
      const fromVault = await this.apiKeyResolver(workspaceId, "openrouter");
      if (fromVault) return fromVault;
    }
    const env = process.env.OPENROUTER_API_KEY;
    if (env) return env;
    throw new Error(
      "openrouter: no API key available (vault returned null and OPENROUTER_API_KEY not set)",
    );
  }

  private buildHeaders(apiKey: string): Record<string, string> {
    // HTTP-Referer + X-Title are optional OpenRouter attribution headers used
    // for their public leaderboard. We always send both — PacketAgent by default,
    // overridable via OPENROUTER_SITE_URL and OPENROUTER_APP_NAME.
    return {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": this.siteUrl,
      "X-Title": this.appName,
    };
  }

  async call(opts: ProviderCallOptions): Promise<ProviderCallResult> {
    const apiKey = await this.resolveApiKey(opts.workspaceId);
    const body: OpenRouterChatRequest = {
      model: opts.model,
      messages: mapMessages(opts.messages),
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.tools ? { tools: mapTools(opts.tools) } : {}),
    };
    const res = await this.fetchFn(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: this.buildHeaders(apiKey),
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(authErrorMessage(res.status, text));
    }
    const json = (await res.json()) as OpenRouterChatResponse;
    if (json.error) {
      // OpenRouter surfaces detailed errors in the response body even with 200 OK
      // (e.g. "No endpoints found that support tool use" on free models).
      throw new Error(`openrouter: ${json.error.message}`);
    }
    const choice = json.choices[0];
    const toolCalls: ProviderToolCall[] = [];
    if (choice?.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          parsed = {};
        }
        toolCalls.push({ id: tc.id, name: tc.function.name, input: parsed });
      }
    }
    return {
      content: choice?.message.content ?? "",
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      finishReason: mapFinishReason(choice?.finish_reason ?? null),
      usage: priceUsage(
        json.model,
        json.usage?.prompt_tokens ?? 0,
        json.usage?.completion_tokens ?? 0,
      ),
      model: json.model,
      providerName: "openrouter",
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

    const body: OpenRouterChatRequest = {
      model: opts.model,
      messages: mapMessages(opts.messages),
      stream: true,
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.tools ? { tools: mapTools(opts.tools) } : {}),
    };

    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: this.buildHeaders(apiKey),
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (error) {
      yield { error: (error as Error).message };
      return;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      yield { error: authErrorMessage(res.status, text) };
      return;
    }
    if (!res.body) {
      yield { error: "openrouter: empty stream body" };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const partials = new Map<number, { id?: string; name?: string; argsAccum: string }>();
    let buffer = "";
    let prompt = 0,
      completion = 0,
      model = opts.model;

    try {
      while (true) {
        if (opts.signal?.aborted) {
          yield { error: "aborted" };
          return;
        }
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const event of events) {
          for (const line of event.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (data === "[DONE]") continue;
            let parsed: OpenRouterStreamChunk;
            try {
              parsed = JSON.parse(data) as OpenRouterStreamChunk;
            } catch {
              continue;
            }
            if (parsed.error) {
              yield { error: `openrouter: ${parsed.error.message}` };
              return;
            }
            if (parsed.model) model = parsed.model;
            const choice = parsed.choices?.[0];
            if (choice?.delta.content) yield { delta: choice.delta.content };
            if (choice?.delta.tool_calls) {
              for (const tc of choice.delta.tool_calls) {
                const slot = partials.get(tc.index) ?? { argsAccum: "" };
                if (tc.id) slot.id = tc.id;
                if (tc.function?.name) slot.name = tc.function.name;
                if (tc.function?.arguments) slot.argsAccum += tc.function.arguments;
                partials.set(tc.index, slot);
              }
            }
            if (choice?.finish_reason && partials.size > 0) {
              for (const slot of partials.values()) {
                if (!slot.id || !slot.name) continue;
                let parsedArgs: Record<string, unknown> = {};
                try {
                  parsedArgs = slot.argsAccum ? JSON.parse(slot.argsAccum) : {};
                } catch {
                  parsedArgs = {};
                }
                yield { toolCall: { id: slot.id, name: slot.name, input: parsedArgs } };
              }
              partials.clear();
            }
            if (parsed.usage) {
              prompt = parsed.usage.prompt_tokens;
              completion = parsed.usage.completion_tokens;
            }
          }
        }
      }
    } catch (error) {
      yield { error: (error as Error).message };
      return;
    }

    yield { done: true, usage: priceUsage(model, prompt, completion) };
  }

  async models(): Promise<string[]> {
    return Object.keys(OPENROUTER_MODEL_PRICING);
  }
}
