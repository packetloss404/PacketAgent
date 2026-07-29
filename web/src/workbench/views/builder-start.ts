import type { BuilderKind } from "./builder/types";

export const BUILDER_STARTER_PROMPTS: Array<{
  kind: BuilderKind;
  label: string;
  prompt: string;
}> = [
  {
    kind: "app",
    label: "Lightweight CRM",
    prompt:
      "Build a lightweight CRM for account managers to track companies, contacts, opportunities, and renewal risk.",
  },
  {
    kind: "app",
    label: "Customer portal",
    prompt:
      "Build a customer portal where customers can manage profile details, open requests, and upload documents.",
  },
  {
    kind: "agent",
    label: "Standup digest agent",
    prompt:
      "Build an agent that posts a daily standup digest summarising the team's overnight progress and today's plan.",
  },
  {
    kind: "agent",
    label: "Support triage agent",
    prompt:
      "Create a webhook agent to triage customer incidents, open blockers for critical risks, and post a summary to Slack.",
  },
];

export function shouldRouteToAgentBuilder(prompt: string): boolean {
  const text = prompt
    .toLowerCase()
    .replace(/[\u2019']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;

  const appSurfaceRequest =
    /\b(?:build|create|make|design|draft|configure|generate|set up|setup)\s+(?:me\s+)?(?:a|an|the)?\s*(?:[a-z0-9-]+\s+){0,3}(?:app|application|portal|dashboard|crm|website|site|tool|system)\b/;
  if (appSurfaceRequest.test(text)) return false;

  const appSurfaceAfterAgent =
    /\b(?:agent|assistant|bot|chatbot)\s+(?:app|application|portal|dashboard|crm|website|site|tool|system)\b/;
  if (appSurfaceAfterAgent.test(text)) return false;

  return [
    /\b(?:build|create|make|design|draft|configure|generate|set up|setup)\s+(?:me\s+)?(?:a|an|the)?\s*(?:ai\s+)?(?:[a-z0-9-]+\s+){0,3}(?:agent|assistant|bot|chatbot)\b/,
    /\b(?:need|want|looking for|would like)\s+(?:me\s+)?(?:a|an|the|my|our)?\s*(?:ai\s+)?(?:[a-z0-9-]+\s+){0,4}(?:agent|assistant|bot|chatbot)\b/,
    /\b(?:a|an|the|my|our)\s+(?:ai\s+)?(?:[a-z0-9-]+\s+){0,3}(?:agent|assistant|bot|chatbot)\s+(?:that|to|which)\b/,
    /\bwebhook\s+(?:agent|assistant|bot)\b/,
  ].some((pattern) => pattern.test(text));
}

export function resolveBuilderStartKind(prompt: string): BuilderKind {
  return shouldRouteToAgentBuilder(prompt) ? "agent" : "app";
}

export function builderPrimaryActionCopy(prompt: string, working: boolean): string {
  if (working) return "Generating";
  return shouldRouteToAgentBuilder(prompt) ? "Open agent builder" : "Build";
}
