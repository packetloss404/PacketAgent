import type {
  ToolAuthorizationDefinition,
  ToolAuthorizationDescriptor,
  ToolContext,
} from "./types.js";
import type { WorkerCapabilityEffect } from "../workers/types.js";

export function workspaceAuthorization<TInput>(
  verb: string,
  effect: WorkerCapabilityEffect,
): ToolAuthorizationDefinition<TInput> {
  return {
    describe(_input, context) {
      return {
        verb,
        effect,
        resources: [`workspace:${context.workspaceId}`],
      };
    },
  };
}

export function browserAuthorization<TInput>(
  verb: string,
  effect: WorkerCapabilityEffect,
): ToolAuthorizationDefinition<TInput> {
  return {
    describe(_input, context) {
      return {
        verb,
        effect,
        resources: [`browser:${context.runId ?? context.worker?.run.id ?? "missing-run"}`],
      };
    },
  };
}

export function inputAuthorization<TInput>(
  describe: (input: TInput, context: ToolContext) => ToolAuthorizationDescriptor,
): ToolAuthorizationDefinition<TInput> {
  return { describe };
}

export function stringInput(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function recipientResources(value: unknown): string[] {
  const candidates = Array.isArray(value) ? value : [value];
  const recipients = candidates
    .flatMap((candidate) => (typeof candidate === "string" ? candidate.split(",") : []))
    .map((candidate) => {
      const trimmed = candidate.trim();
      const bracketed = trimmed.match(/<([^<>]+)>$/)?.[1];
      return (bracketed ?? trimmed).trim().toLowerCase();
    })
    .filter(Boolean)
    .map((recipient) => `mailto:${recipient}`);
  return [...new Set(recipients)].sort();
}
