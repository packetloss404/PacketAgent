import type { ToolDefinition } from "./types.js";

export type FetchImpl = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type EnvMap = Record<string, string | undefined>;
export type EnvSource = EnvMap | (() => EnvMap);

export interface SlackPostWebhookOptions {
  fetchImpl?: FetchImpl;
  env?: EnvSource;
}

export interface GithubApiOptions {
  fetchImpl?: FetchImpl;
  env?: EnvSource;
  apiBaseUrl?: string;
}

type SlackPostWebhookInput = Record<string, unknown> & {
  webhookUrl?: string;
  text?: string;
  blocks?: unknown;
  username?: string;
  iconEmoji?: string;
  channel?: string;
};

type GithubOperation = "list_prs" | "get_pr" | "get_comments" | "create_comment";
type PullRequestState = "open" | "closed" | "all";

type GithubApiInput = Record<string, unknown> & {
  token?: string;
  owner?: string;
  repo?: string;
  operation?: GithubOperation;
  pullNumber?: number;
  issueNumber?: number;
  body?: string;
  state?: PullRequestState;
};

const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const MAX_RESPONSE_TEXT = 4096;

function resolveFetch(fetchImpl?: FetchImpl): FetchImpl {
  return fetchImpl ?? globalThis.fetch.bind(globalThis);
}

function resolveEnv(source?: EnvSource): EnvMap {
  if (!source) return process.env;
  return typeof source === "function" ? source() : source;
}

function valueOrEnv(inputValue: unknown, env: EnvMap, names: string[]): string | undefined {
  if (typeof inputValue === "string" && inputValue.trim()) return inputValue.trim();
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function redactText(text: string, secrets: Array<string | undefined>): string {
  let redacted = text;
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}

function redactUnknown(value: unknown, secrets: Array<string | undefined>): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, secrets));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, redactUnknown(nested, secrets)]),
  );
}

function truncate(text: string): string {
  return text.length > MAX_RESPONSE_TEXT ? `${text.slice(0, MAX_RESPONSE_TEXT)}\n...[truncated]` : text;
}

async function readResponseBody(response: Response, secrets: Array<string | undefined>): Promise<unknown> {
  const raw = await response.text();
  if (!raw) return "";

  const redactedRaw = truncate(redactText(raw, secrets));
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("json")) return redactedRaw;

  try {
    return redactUnknown(JSON.parse(raw), secrets);
  } catch {
    return redactedRaw;
  }
}

function responseDetail(body: unknown): string {
  if (body === undefined || body === null || body === "") return "";
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text ? ` - ${truncate(text)}` : "";
}

function requiredString(value: unknown, name: string): string | { error: string } {
  if (typeof value !== "string" || !value.trim()) return { error: `${name} is required` };
  return value.trim();
}

function requiredPositiveInteger(value: unknown, name: string): number | { error: string } {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return { error: `${name} must be a positive integer` };
  }
  return value;
}

function parseWebhookUrl(value: string): URL | { error: string } {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { error: "webhookUrl must use http or https" };
    }
    return parsed;
  } catch {
    return { error: "webhookUrl must be a valid URL" };
  }
}

function githubUrl(apiBaseUrl: string, segments: string[], searchParams?: Record<string, string | undefined>): string {
  const url = new URL(apiBaseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  const path = segments.map((segment) => encodeURIComponent(segment)).join("/");
  url.pathname = `${basePath}/${path}`.replace(/\/{2,}/g, "/");
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

function githubIssueNumber(input: GithubApiInput): number | { error: string } {
  if (input.issueNumber !== undefined) return requiredPositiveInteger(input.issueNumber, "issueNumber");
  return requiredPositiveInteger(input.pullNumber, "pullNumber or issueNumber");
}

export function createSlackPostWebhookTool(options: SlackPostWebhookOptions = {}): ToolDefinition<SlackPostWebhookInput> {
  const fetchImpl = resolveFetch(options.fetchImpl);
  return {
    name: "slack_post_webhook",
    description: "Post a message to Slack using an incoming webhook URL supplied by input or SLACK_WEBHOOK_URL.",
    inputSchema: {
      type: "object",
      properties: {
        webhookUrl: { type: "string", format: "uri" },
        text: { type: "string", minLength: 1 },
        blocks: { type: "array" },
        username: { type: "string" },
        iconEmoji: { type: "string" },
        channel: { type: "string" },
      },
      required: ["text"],
      additionalProperties: false,
    },
    side: "write",
    effect: {
      describe: () => ({
        classification: "non_replayable_mutation",
        operation: "slack.webhook.post",
      }),
    },
    timeoutMs: 15_000,
    async handle(input, ctx) {
      const env = resolveEnv(options.env);
      const webhookUrl = valueOrEnv(input.webhookUrl, env, ["SLACK_WEBHOOK_URL"]);
      if (!webhookUrl) return { ok: false, error: "webhookUrl is required or SLACK_WEBHOOK_URL must be set" };

      const parsed = parseWebhookUrl(webhookUrl);
      if ("error" in parsed) return { ok: false, error: parsed.error };

      const text = requiredString(input.text, "text");
      if (typeof text !== "string") return { ok: false, error: text.error };

      const payload: Record<string, unknown> = { text };
      if (input.blocks !== undefined) payload.blocks = input.blocks;
      if (input.username) payload.username = input.username;
      if (input.iconEmoji) payload.icon_emoji = input.iconEmoji;
      if (input.channel) payload.channel = input.channel;

      try {
        const response = await fetchImpl(parsed.toString(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: ctx.signal,
        });
        const body = await readResponseBody(response, [webhookUrl]);
        const output = { status: response.status, body };
        if (!response.ok) {
          return {
            ok: false,
            output,
            error: redactText(`Slack webhook POST failed: HTTP ${response.status}${responseDetail(body)}`, [webhookUrl]),
          };
        }
        return { ok: true, output };
      } catch (error) {
        return {
          ok: false,
          error: redactText(`Slack webhook POST failed: ${(error as Error).message}`, [webhookUrl]),
        };
      }
    },
  };
}

export function createGithubApiTool(options: GithubApiOptions = {}): ToolDefinition<GithubApiInput> {
  const fetchImpl = resolveFetch(options.fetchImpl);
  const apiBaseUrl = options.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL;
  return {
    name: "github_api",
    description: "Call selected GitHub REST API operations with a PAT from input, GITHUB_TOKEN, or GITHUB_PAT.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string" },
        owner: { type: "string", minLength: 1 },
        repo: { type: "string", minLength: 1 },
        operation: { type: "string", enum: ["list_prs", "get_pr", "get_comments", "create_comment"] },
        pullNumber: { type: "number", minimum: 1 },
        issueNumber: { type: "number", minimum: 1 },
        body: { type: "string", minLength: 1 },
        state: { type: "string", enum: ["open", "closed", "all"], default: "open" },
      },
      required: ["owner", "repo", "operation"],
      additionalProperties: false,
    },
    side: "write",
    effect: {
      describe: (input) => ({
        classification:
          input.operation === "create_comment"
            ? ("non_replayable_mutation" as const)
            : ("read_only" as const),
        operation: `github.${input.operation ?? "unknown"}`,
      }),
    },
    timeoutMs: 20_000,
    async handle(input, ctx) {
      const env = resolveEnv(options.env);
      const token = valueOrEnv(input.token, env, ["GITHUB_TOKEN", "GITHUB_PAT"]);
      if (!token) return { ok: false, error: "GitHub token is required via token, GITHUB_TOKEN, or GITHUB_PAT" };

      const owner = requiredString(input.owner, "owner");
      if (typeof owner !== "string") return { ok: false, error: owner.error };
      const repo = requiredString(input.repo, "repo");
      if (typeof repo !== "string") return { ok: false, error: repo.error };

      const operation = input.operation;
      if (!operation || !["list_prs", "get_pr", "get_comments", "create_comment"].includes(operation)) {
        return { ok: false, error: "operation must be one of list_prs, get_pr, get_comments, create_comment" };
      }

      let method = "GET";
      let url: string;
      let requestBody: string | undefined;

      if (operation === "list_prs") {
        const state = input.state ?? "open";
        if (!["open", "closed", "all"].includes(state)) return { ok: false, error: "state must be open, closed, or all" };
        url = githubUrl(apiBaseUrl, ["repos", owner, repo, "pulls"], { state });
      } else if (operation === "get_pr") {
        const pullNumber = requiredPositiveInteger(input.pullNumber, "pullNumber");
        if (typeof pullNumber !== "number") return { ok: false, error: pullNumber.error };
        url = githubUrl(apiBaseUrl, ["repos", owner, repo, "pulls", String(pullNumber)]);
      } else if (operation === "get_comments") {
        const issueNumber = githubIssueNumber(input);
        if (typeof issueNumber !== "number") return { ok: false, error: issueNumber.error };
        url = githubUrl(apiBaseUrl, ["repos", owner, repo, "issues", String(issueNumber), "comments"]);
      } else {
        const issueNumber = githubIssueNumber(input);
        if (typeof issueNumber !== "number") return { ok: false, error: issueNumber.error };
        const body = requiredString(input.body, "body");
        if (typeof body !== "string") return { ok: false, error: body.error };
        method = "POST";
        requestBody = JSON.stringify({ body });
        url = githubUrl(apiBaseUrl, ["repos", owner, repo, "issues", String(issueNumber), "comments"]);
      }

      try {
        const response = await fetchImpl(url, {
          method,
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "user-agent": "packetagent-agent-tools",
            "x-github-api-version": "2022-11-28",
          },
          ...(requestBody ? { body: requestBody } : {}),
          signal: ctx.signal,
        });
        const body = await readResponseBody(response, [token]);
        const output = { status: response.status, data: body };
        if (!response.ok) {
          return {
            ok: false,
            output,
            error: redactText(`GitHub API ${operation} failed: HTTP ${response.status}${responseDetail(body)}`, [token]),
          };
        }
        return { ok: true, output };
      } catch (error) {
        return {
          ok: false,
          error: redactText(`GitHub API ${operation} failed: ${(error as Error).message}`, [token]),
        };
      }
    },
  };
}

export const slackPostWebhookTool = createSlackPostWebhookTool();
export const githubApiTool = createGithubApiTool();
