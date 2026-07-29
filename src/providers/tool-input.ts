import type { ProviderToolCall } from "./types.js";

export type ParsedToolInput = Pick<ProviderToolCall, "input" | "inputError">;

export function parseToolInput(value: unknown): ParsedToolInput {
  if (typeof value === "string") {
    if (value.trim().length === 0) return { input: {} };
    try {
      return parseToolInput(JSON.parse(value) as unknown);
    } catch {
      return { input: {}, inputError: "malformed_json" };
    }
  }
  if (value === undefined) return { input: {} };
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return { input: {}, inputError: "not_an_object" };
  }
  return { input: value as Record<string, unknown> };
}

export function malformedToolCalls(
  toolCalls: readonly ProviderToolCall[] | undefined,
): ProviderToolCall[] {
  return toolCalls?.filter((toolCall) => toolCall.inputError !== undefined) ?? [];
}
