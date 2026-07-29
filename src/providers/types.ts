export type ProviderName =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "minimax"
  | "ollama"
  | "gemini"
  | "stub";

export interface ProviderMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolName?: string;
}

export interface ProviderToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ProviderStructuredOutput {
  name: string;
  description?: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

export interface ProviderCallOptions {
  model: string;
  messages: ProviderMessage[];
  tools?: ProviderToolDef[];
  structuredOutput?: ProviderStructuredOutput;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  workspaceId: string;
  routeKey: string;
}

export interface ProviderUsage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface ProviderToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  inputError?: "malformed_json" | "not_an_object";
}

export interface ProviderCallResult {
  content: string;
  toolCalls?: ProviderToolCall[];
  finishReason: "stop" | "tool_use" | "length" | "error";
  usage: ProviderUsage;
  model: string;
  providerName: ProviderName;
}

export interface ProviderStreamChunk {
  delta?: string;
  toolCall?: ProviderToolCall;
  done?: boolean;
  usage?: ProviderUsage;
  error?: string;
}

export interface LLMProvider {
  name: ProviderName;
  call(opts: ProviderCallOptions): Promise<ProviderCallResult>;
  stream(opts: ProviderCallOptions): AsyncIterable<ProviderStreamChunk>;
  models(): Promise<string[]>;
}

export interface ApiKeyResolver {
  (workspaceId: string, provider: ProviderName): Promise<string | null>;
}
