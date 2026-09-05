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
  /**
   * Tool calls the assistant made in this turn. Providers must replay these so
   * the following `tool` messages reference a tool call the model can see.
   */
  toolCalls?: ProviderToolCall[];
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

/**
 * Reasoning effort. Providers map it onto their own control (Anthropic
 * `output_config.effort`) and clamp or drop it for models that reject it.
 */
export type ProviderEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ProviderCallOptions {
  model: string;
  messages: ProviderMessage[];
  tools?: ProviderToolDef[];
  structuredOutput?: ProviderStructuredOutput;
  maxTokens?: number;
  temperature?: number;
  effort?: ProviderEffort;
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

/** Structured detail attached to a `refusal` finish reason. */
export interface ProviderStopDetails {
  category: string | null;
  explanation: string | null;
}

export type ProviderFinishReason = "stop" | "tool_use" | "length" | "refusal" | "error";

export interface ProviderCallResult {
  content: string;
  toolCalls?: ProviderToolCall[];
  finishReason: ProviderFinishReason;
  /** Present when `finishReason` is `refusal` and the provider explained it. */
  stopDetails?: ProviderStopDetails;
  usage: ProviderUsage;
  model: string;
  providerName: ProviderName;
}

export interface ProviderStreamChunk {
  delta?: string;
  toolCall?: ProviderToolCall;
  done?: boolean;
  usage?: ProviderUsage;
  /** Set on the `done` chunk when the provider reported why the turn ended. */
  finishReason?: ProviderFinishReason;
  stopDetails?: ProviderStopDetails;
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
