import type {
  ApiKeyResolver,
  LLMProvider,
  ProviderCallOptions,
  ProviderCallResult,
  ProviderMessage,
  ProviderStreamChunk,
  ProviderToolCall,
  ProviderToolDef,
} from "./types.js";

// =============================================================================
// Local / self-hosted LLM provider.
//
// The provider is named "ollama" for historical reasons but is intentionally
// generic — it can talk to ANY OpenAI-compatible local LLM server (Ollama, vLLM,
// LM Studio, llama.cpp's --api-server) running on the same machine OR a remote
// host (think: a 1.5 TB RAM GPU box on the same LAN).
//
// Three env vars control where requests go and how they're shaped:
//   - LOCAL_LLM_BASE_URL    overrides the base URL (takes precedence over
//                           OLLAMA_BASE_URL); communicates intent that the
//                           endpoint is "some OpenAI-compatible local server",
//                           not specifically Ollama.
//   - OLLAMA_BASE_URL       legacy synonym for LOCAL_LLM_BASE_URL.
//   - LOCAL_LLM_API_FORMAT  "ollama" (default) sends Ollama-native /api/chat
//                           payloads. "openai" sends OpenAI-compatible
//                           /v1/chat/completions payloads — required for vLLM,
//                           LM Studio, llama.cpp, and most other servers.
//   - LOCAL_LLM_MODEL       overrides the per-call model when the router asks
//                           for the local provider's default. Useful when the
//                           remote server only serves one specific model
//                           (e.g. vLLM serving qwen2.5-coder-32b-instruct).
// =============================================================================

export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434";

export type LocalLLMApiFormat = "ollama" | "openai";

/**
 * Returns the effective base URL to talk to, applying the LOCAL_LLM_BASE_URL →
 * OLLAMA_BASE_URL → default precedence. Trailing slashes are trimmed so callers
 * can concatenate paths without doubled separators.
 */
export function resolveLocalLlmBaseURL(env: NodeJS.ProcessEnv = process.env): string {
  const local = env.LOCAL_LLM_BASE_URL;
  if (typeof local === "string" && local.trim().length > 0) return local.trim().replace(/\/+$/, "");
  const ollama = env.OLLAMA_BASE_URL;
  if (typeof ollama === "string" && ollama.trim().length > 0)
    return ollama.trim().replace(/\/+$/, "");
  return OLLAMA_DEFAULT_BASE_URL;
}

/**
 * Returns the API format the server expects. Defaults to the Ollama-native
 * format for backwards compatibility. Any value other than the two known
 * formats falls back to "ollama" rather than throwing — bad config should not
 * crash the bootstrap path.
 */
export function resolveLocalLlmApiFormat(env: NodeJS.ProcessEnv = process.env): LocalLLMApiFormat {
  const raw = env.LOCAL_LLM_API_FORMAT;
  if (typeof raw !== "string") return "ollama";
  const lower = raw.trim().toLowerCase();
  if (lower === "openai") return "openai";
  return "ollama";
}

/**
 * Returns the model name to use, applying LOCAL_LLM_MODEL as an override. The
 * router passes in whatever model name it resolved from the preset table; if
 * the operator wants every local call to hit a specific model on their server,
 * this lets them set it once instead of editing the preset map.
 */
export function resolveLocalLlmModel(
  requested: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.LOCAL_LLM_MODEL;
  if (typeof override === "string" && override.trim().length > 0) return override.trim();
  return requested;
}

// ---------------------------------------------------------------------------
// Ollama-native /api/chat shape
// ---------------------------------------------------------------------------

interface OllamaChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
}

interface OllamaToolDef {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  tools?: OllamaToolDef[];
  options?: { temperature?: number; num_predict?: number };
  stream?: boolean;
}

interface OllamaChatResponse {
  model: string;
  message: {
    role: string;
    content: string;
    tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  };
  done: boolean;
  done_reason?: "stop" | "length" | string;
  prompt_eval_count?: number;
  eval_count?: number;
}

function mapOllamaMessages(messages: ProviderMessage[]): OllamaChatMessage[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

function mapOllamaTools(tools: ProviderToolDef[] | undefined): OllamaToolDef[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

function mapOllamaDoneReason(reason?: string): ProviderCallResult["finishReason"] {
  if (reason === "length") return "length";
  return "stop";
}

// ---------------------------------------------------------------------------
// OpenAI-compatible /v1/chat/completions shape (subset we emit / parse)
// ---------------------------------------------------------------------------

interface OpenAICompatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
}

interface OpenAICompatToolDef {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

interface OpenAICompatChatRequest {
  model: string;
  messages: OpenAICompatMessage[];
  tools?: OpenAICompatToolDef[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

interface OpenAICompatChatResponse {
  id?: string;
  model?: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content?: string | null;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    };
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

interface OpenAICompatStreamDelta {
  role?: string;
  content?: string;
  tool_calls?: {
    index: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }[];
}

interface OpenAICompatStreamChunk {
  id?: string;
  model?: string;
  choices: Array<{
    index: number;
    delta: OpenAICompatStreamDelta;
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

function mapOpenAIMessages(messages: ProviderMessage[]): OpenAICompatMessage[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", content: m.content, tool_call_id: m.toolCallId };
    }
    return { role: m.role, content: m.content };
  });
}

function mapOpenAITools(tools: ProviderToolDef[] | undefined): OpenAICompatToolDef[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

function mapOpenAIFinishReason(
  reason: OpenAICompatChatResponse["choices"][number]["finish_reason"],
): ProviderCallResult["finishReason"] {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
      return "tool_use";
    default:
      return "stop";
  }
}

export interface OllamaProviderOptions {
  apiKeyResolver?: ApiKeyResolver;
  baseURL?: string;
  fetchFn?: typeof fetch;
  modelsCacheMs?: number;
  /** Overrides the env-derived API format. Mostly for tests. */
  apiFormat?: LocalLLMApiFormat;
  /** Overrides the env-derived model. Mostly for tests. */
  modelOverride?: string;
}

export class OllamaProvider implements LLMProvider {
  name = "ollama" as const;
  private baseURL: string;
  private fetchFn: typeof fetch;
  private modelsCacheMs: number;
  private modelsCache: { value: string[]; at: number } | null = null;
  private apiFormat: LocalLLMApiFormat;
  private modelOverride: string | undefined;

  constructor(opts: OllamaProviderOptions = {}) {
    this.baseURL = opts.baseURL ?? resolveLocalLlmBaseURL();
    this.fetchFn = opts.fetchFn ?? fetch;
    this.modelsCacheMs = opts.modelsCacheMs ?? 60_000;
    this.apiFormat = opts.apiFormat ?? resolveLocalLlmApiFormat();
    this.modelOverride = opts.modelOverride ?? process.env.LOCAL_LLM_MODEL;
    if (this.modelOverride !== undefined && this.modelOverride.trim().length === 0) {
      this.modelOverride = undefined;
    }
  }

  /** Exposed for tests + diagnostics. */
  getBaseURL(): string {
    return this.baseURL;
  }
  getApiFormat(): LocalLLMApiFormat {
    return this.apiFormat;
  }
  getModelOverride(): string | undefined {
    return this.modelOverride;
  }

  private effectiveModel(model: string): string {
    if (this.modelOverride && this.modelOverride.length > 0) return this.modelOverride;
    return model;
  }

  async call(opts: ProviderCallOptions): Promise<ProviderCallResult> {
    if (this.apiFormat === "openai") return this.callOpenAI(opts);
    return this.callOllama(opts);
  }

  async *stream(opts: ProviderCallOptions): AsyncIterable<ProviderStreamChunk> {
    if (this.apiFormat === "openai") {
      yield* this.streamOpenAI(opts);
      return;
    }
    yield* this.streamOllama(opts);
  }

  // -------------------------------------------------------------------------
  // Ollama-native path
  // -------------------------------------------------------------------------

  private async callOllama(opts: ProviderCallOptions): Promise<ProviderCallResult> {
    const body: OllamaChatRequest = {
      model: this.effectiveModel(opts.model),
      messages: mapOllamaMessages(opts.messages),
      stream: false,
      ...(opts.tools ? { tools: mapOllamaTools(opts.tools) } : {}),
      ...(opts.temperature !== undefined || opts.maxTokens !== undefined
        ? {
            options: {
              ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
              ...(opts.maxTokens !== undefined ? { num_predict: opts.maxTokens } : {}),
            },
          }
        : {}),
    };
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseURL}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (error) {
      throw new Error(
        `ollama: connection failed (is Ollama running at ${this.baseURL}?): ${(error as Error).message}`,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ollama: HTTP ${res.status} ${text}`);
    }
    const json = (await res.json()) as OllamaChatResponse;
    const toolCalls: ProviderToolCall[] = [];
    if (json.message.tool_calls) {
      for (const tc of json.message.tool_calls) {
        toolCalls.push({
          id: `ollama-${toolCalls.length}`,
          name: tc.function.name,
          input: tc.function.arguments,
        });
      }
    }
    return {
      content: json.message.content ?? "",
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      finishReason: mapOllamaDoneReason(json.done_reason),
      usage: {
        promptTokens: json.prompt_eval_count ?? 0,
        completionTokens: json.eval_count ?? 0,
        costUsd: 0,
      },
      model: json.model,
      providerName: "ollama",
    };
  }

  private async *streamOllama(opts: ProviderCallOptions): AsyncIterable<ProviderStreamChunk> {
    const body: OllamaChatRequest = {
      model: this.effectiveModel(opts.model),
      messages: mapOllamaMessages(opts.messages),
      stream: true,
      ...(opts.tools ? { tools: mapOllamaTools(opts.tools) } : {}),
      ...(opts.temperature !== undefined || opts.maxTokens !== undefined
        ? {
            options: {
              ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
              ...(opts.maxTokens !== undefined ? { num_predict: opts.maxTokens } : {}),
            },
          }
        : {}),
    };
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseURL}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (error) {
      yield {
        error: `ollama: connection failed (is Ollama running at ${this.baseURL}?): ${(error as Error).message}`,
      };
      return;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      yield { error: `ollama: HTTP ${res.status} ${text}` };
      return;
    }
    if (!res.body) {
      yield { error: "ollama: empty stream body" };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let prompt = 0,
      completion = 0;

    try {
      while (true) {
        if (opts.signal?.aborted) {
          yield { error: "aborted" };
          return;
        }
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let parsed: OllamaChatResponse;
          try {
            parsed = JSON.parse(trimmed) as OllamaChatResponse;
          } catch {
            continue;
          }
          if (parsed.message?.content) yield { delta: parsed.message.content };
          if (parsed.message?.tool_calls) {
            for (const tc of parsed.message.tool_calls) {
              yield {
                toolCall: {
                  id: `ollama-${tc.function.name}`,
                  name: tc.function.name,
                  input: tc.function.arguments,
                },
              };
            }
          }
          if (parsed.done) {
            prompt = parsed.prompt_eval_count ?? prompt;
            completion = parsed.eval_count ?? completion;
          }
        }
      }
    } catch (error) {
      yield { error: (error as Error).message };
      return;
    }

    yield { done: true, usage: { promptTokens: prompt, completionTokens: completion, costUsd: 0 } };
  }

  // -------------------------------------------------------------------------
  // OpenAI-compatible path (vLLM / LM Studio / llama.cpp server / etc.)
  // -------------------------------------------------------------------------

  private async callOpenAI(opts: ProviderCallOptions): Promise<ProviderCallResult> {
    const body: OpenAICompatChatRequest = {
      model: this.effectiveModel(opts.model),
      messages: mapOpenAIMessages(opts.messages),
      stream: false,
      ...(opts.tools ? { tools: mapOpenAITools(opts.tools) } : {}),
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    };
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseURL}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (error) {
      throw new Error(
        `ollama: connection failed (is the local LLM server running at ${this.baseURL}?): ${(error as Error).message}`,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ollama: HTTP ${res.status} ${text}`);
    }
    const json = (await res.json()) as OpenAICompatChatResponse;
    const choice = json.choices?.[0];
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
      finishReason: mapOpenAIFinishReason(choice?.finish_reason ?? null),
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
        costUsd: 0,
      },
      model: json.model ?? body.model,
      providerName: "ollama",
    };
  }

  private async *streamOpenAI(opts: ProviderCallOptions): AsyncIterable<ProviderStreamChunk> {
    const body: OpenAICompatChatRequest = {
      model: this.effectiveModel(opts.model),
      messages: mapOpenAIMessages(opts.messages),
      stream: true,
      ...(opts.tools ? { tools: mapOpenAITools(opts.tools) } : {}),
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    };
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseURL}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (error) {
      yield {
        error: `ollama: connection failed (is the local LLM server running at ${this.baseURL}?): ${(error as Error).message}`,
      };
      return;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      yield { error: `ollama: HTTP ${res.status} ${text}` };
      return;
    }
    if (!res.body) {
      yield { error: "ollama: empty stream body" };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let prompt = 0,
      completion = 0;
    const partials = new Map<number, { id?: string; name?: string; argsAccum: string }>();

    try {
      while (true) {
        if (opts.signal?.aborted) {
          yield { error: "aborted" };
          return;
        }
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by blank lines. Each frame may have multiple
        // `data:` lines that should be concatenated.
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const dataLines = frame
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim());
          if (dataLines.length === 0) continue;
          const payload = dataLines.join("");
          if (!payload || payload === "[DONE]") continue;
          let parsed: OpenAICompatStreamChunk;
          try {
            parsed = JSON.parse(payload) as OpenAICompatStreamChunk;
          } catch {
            continue;
          }
          const choice = parsed.choices?.[0];
          if (!choice) {
            if (parsed.usage) {
              prompt = parsed.usage.prompt_tokens ?? prompt;
              completion = parsed.usage.completion_tokens ?? completion;
            }
            continue;
          }
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
            prompt = parsed.usage.prompt_tokens ?? prompt;
            completion = parsed.usage.completion_tokens ?? completion;
          }
        }
      }
    } catch (error) {
      yield { error: (error as Error).message };
      return;
    }

    yield { done: true, usage: { promptTokens: prompt, completionTokens: completion, costUsd: 0 } };
  }

  // -------------------------------------------------------------------------
  // Model discovery
  // -------------------------------------------------------------------------

  async models(): Promise<string[]> {
    if (this.modelsCache && Date.now() - this.modelsCache.at < this.modelsCacheMs) {
      return this.modelsCache.value.slice();
    }
    // In OpenAI-compat mode, try /v1/models first; fall back to Ollama's
    // /api/tags so a misconfigured server doesn't hard-fail discovery.
    if (this.apiFormat === "openai") {
      try {
        const res = await this.fetchFn(`${this.baseURL}/v1/models`);
        if (res.ok) {
          const json = (await res.json()) as { data?: { id: string }[] };
          const names = (json.data ?? []).map((m) => m.id);
          this.modelsCache = { value: names, at: Date.now() };
          return names.slice();
        }
      } catch {
        // fall through to /api/tags
      }
    }
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseURL}/api/tags`);
    } catch {
      return [];
    }
    if (!res.ok) return [];
    const json = (await res.json()) as { models?: { name: string }[] };
    const names = (json.models ?? []).map((m) => m.name);
    this.modelsCache = { value: names, at: Date.now() };
    return names.slice();
  }
}
