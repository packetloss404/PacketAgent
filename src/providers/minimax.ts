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

export const MINIMAX_DEFAULT_BASE_URL = "https://api.minimaxi.chat/v1";

export const MINIMAX_MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "MiniMax-M2": { input: 1.2, output: 4.8 },
  "MiniMax-M1": { input: 0.8, output: 3.2 },
  "abab6.5-chat": { input: 1, output: 2 },
  "abab6.5s-chat": { input: 0.5, output: 1.5 },
  "MiniMax-Text-01": { input: 0.4, output: 1.6 },
};

interface MiniMaxChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
}

interface MiniMaxChatRequest {
  model: string;
  messages: MiniMaxChatMessage[];
  tools?: {
    type: "function";
    function: { name: string; description?: string; parameters: Record<string, unknown> };
  }[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

interface MiniMaxChatChoice {
  index: number;
  message: MiniMaxChatMessage;
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

interface MiniMaxChatResponse {
  id: string;
  model: string;
  choices: MiniMaxChatChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  base_resp?: { status_code: number; status_msg: string };
}

interface MiniMaxStreamDelta {
  role?: string;
  content?: string;
  tool_calls?: {
    index: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }[];
}

interface MiniMaxStreamChunk {
  id?: string;
  model?: string;
  choices?: {
    index: number;
    delta: MiniMaxStreamDelta;
    finish_reason: MiniMaxChatChoice["finish_reason"];
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

function mapMessages(messages: ProviderMessage[]): MiniMaxChatMessage[] {
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
  reason: MiniMaxChatChoice["finish_reason"],
): ProviderCallResult["finishReason"] {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
      return "tool_use";
    default:
      return "error";
  }
}

function priceUsage(model: string, prompt: number, completion: number): ProviderUsage {
  const pricing = MINIMAX_MODEL_PRICING[model];
  const costUsd = pricing ? (prompt * pricing.input + completion * pricing.output) / 1_000_000 : 0;
  return { promptTokens: prompt, completionTokens: completion, costUsd };
}

export interface MiniMaxProviderOptions {
  apiKeyResolver?: ApiKeyResolver;
  baseURL?: string;
  groupId?: string;
  fetchFn?: typeof fetch;
}

export class MiniMaxProvider implements LLMProvider {
  name = "minimax" as const;
  private apiKeyResolver?: ApiKeyResolver;
  private baseURL: string;
  private groupId?: string;
  private fetchFn: typeof fetch;

  constructor(opts: MiniMaxProviderOptions = {}) {
    this.apiKeyResolver = opts.apiKeyResolver;
    this.baseURL = opts.baseURL ?? process.env.MINIMAX_BASE_URL ?? MINIMAX_DEFAULT_BASE_URL;
    this.groupId = opts.groupId ?? process.env.MINIMAX_GROUP_ID;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private async resolveApiKey(workspaceId: string): Promise<string> {
    if (this.apiKeyResolver) {
      const fromVault = await this.apiKeyResolver(workspaceId, "minimax");
      if (fromVault) return fromVault;
    }
    const env = process.env.MINIMAX_API_KEY;
    if (env) return env;
    throw new Error(
      "minimax: no API key available (vault returned null and MINIMAX_API_KEY not set)",
    );
  }

  private buildHeaders(apiKey: string): Record<string, string> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    };
    if (this.groupId) h["x-minimax-group-id"] = this.groupId;
    return h;
  }

  async call(opts: ProviderCallOptions): Promise<ProviderCallResult> {
    const apiKey = await this.resolveApiKey(opts.workspaceId);
    const body: MiniMaxChatRequest = {
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
      throw new Error(`minimax: HTTP ${res.status} ${text}`);
    }
    const json = (await res.json()) as MiniMaxChatResponse;
    if (json.base_resp && json.base_resp.status_code !== 0) {
      throw new Error(
        `minimax: ${json.base_resp.status_msg} (status ${json.base_resp.status_code})`,
      );
    }
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
      providerName: "minimax",
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

    const body: MiniMaxChatRequest = {
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
      yield { error: `minimax: HTTP ${res.status} ${text}` };
      return;
    }
    if (!res.body) {
      yield { error: "minimax: empty stream body" };
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
            let parsed: MiniMaxStreamChunk;
            try {
              parsed = JSON.parse(data) as MiniMaxStreamChunk;
            } catch {
              continue;
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
    return Object.keys(MINIMAX_MODEL_PRICING);
  }
}
