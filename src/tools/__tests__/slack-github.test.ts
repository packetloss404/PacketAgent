import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createGithubApiTool,
  createSlackPostWebhookTool,
  type FetchImpl,
} from "../slack-github.js";
import type { ToolContext } from "../types.js";

function context(signal = new AbortController().signal): ToolContext {
  return { workspaceId: "w", userId: "u", signal };
}

function header(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

test("slack_post_webhook posts JSON to the supplied webhook", async () => {
  const webhookUrl = "https://hooks.slack.com/services/T/B/secret";
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const ctrl = new AbortController();
  const fetchImpl: FetchImpl = async (url, init) => {
    seenUrl = url.toString();
    seenInit = init;
    return new Response("ok", { status: 200 });
  };

  const tool = createSlackPostWebhookTool({ fetchImpl, env: {} });
  const result = await tool.handle({
    webhookUrl,
    text: "Build finished",
    username: "PacketAgent",
    iconEmoji: ":white_check_mark:",
    channel: "#deploys",
    blocks: [{ type: "section", text: { type: "mrkdwn", text: "Build finished" } }],
  }, context(ctrl.signal));

  assert.equal(result.ok, true);
  assert.equal(seenUrl, webhookUrl);
  assert.equal(seenInit?.method, "POST");
  assert.equal(header(seenInit, "content-type"), "application/json");
  assert.equal(seenInit?.signal, ctrl.signal);
  assert.deepEqual(JSON.parse(seenInit?.body as string), {
    text: "Build finished",
    username: "PacketAgent",
    icon_emoji: ":white_check_mark:",
    channel: "#deploys",
    blocks: [{ type: "section", text: { type: "mrkdwn", text: "Build finished" } }],
  });
  assert.deepEqual(result.output, { status: 200, body: "ok" });
});

test("slack_post_webhook can read env URL and redacts it from errors", async () => {
  const webhookUrl = "https://hooks.slack.com/services/T/B/secret";
  const fetchImpl: FetchImpl = async () => {
    throw new Error(`could not reach ${webhookUrl}`);
  };
  const tool = createSlackPostWebhookTool({
    fetchImpl,
    env: () => ({ SLACK_WEBHOOK_URL: webhookUrl }),
  });

  const result = await tool.handle({ text: "Hello" }, context());

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /\[redacted\]/);
  assert.doesNotMatch(result.error ?? "", /hooks\.slack\.com\/services\/T\/B\/secret/);
});

test("github_api routes supported operations to GitHub REST paths", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    calls.push({ url: url.toString(), init });
    const requestUrl = new URL(url.toString());
    const responseInit = { headers: { "content-type": "application/json" } };

    if (requestUrl.pathname === "/repos/octo/packetagent/pulls" && requestUrl.searchParams.get("state") === "closed") {
      return Response.json([{ number: 12, title: "Fix bug" }], responseInit);
    }
    if (requestUrl.pathname === "/repos/octo/packetagent/pulls/12") {
      return Response.json({ number: 12, title: "Fix bug" }, responseInit);
    }
    if (requestUrl.pathname === "/repos/octo/packetagent/issues/12/comments") {
      if (init?.method === "POST") return Response.json({ id: 45, body: "Looks good" }, { ...responseInit, status: 201 });
      return Response.json([{ id: 44, body: "Prior comment" }], responseInit);
    }
    return Response.json({ message: "not found" }, { ...responseInit, status: 404 });
  };

  const tool = createGithubApiTool({
    fetchImpl,
    env: { GITHUB_TOKEN: "ghp_envsecret" },
    apiBaseUrl: "https://github.test",
  });

  const listed = await tool.handle({
    owner: "octo",
    repo: "packetagent",
    operation: "list_prs",
    state: "closed",
  }, context());
  const pr = await tool.handle({
    owner: "octo",
    repo: "packetagent",
    operation: "get_pr",
    pullNumber: 12,
  }, context());
  const comments = await tool.handle({
    owner: "octo",
    repo: "packetagent",
    operation: "get_comments",
    pullNumber: 12,
  }, context());
  const created = await tool.handle({
    owner: "octo",
    repo: "packetagent",
    operation: "create_comment",
    issueNumber: 12,
    body: "Looks good",
  }, context());

  assert.equal(listed.ok, true);
  assert.equal(pr.ok, true);
  assert.equal(comments.ok, true);
  assert.equal(created.ok, true);
  assert.deepEqual(calls.map((call) => `${call.init?.method} ${new URL(call.url).pathname}${new URL(call.url).search}`), [
    "GET /repos/octo/packetagent/pulls?state=closed",
    "GET /repos/octo/packetagent/pulls/12",
    "GET /repos/octo/packetagent/issues/12/comments",
    "POST /repos/octo/packetagent/issues/12/comments",
  ]);
  for (const call of calls) {
    assert.equal(header(call.init, "authorization"), "Bearer ghp_envsecret");
    assert.equal(header(call.init, "accept"), "application/vnd.github+json");
    assert.equal(header(call.init, "x-github-api-version"), "2022-11-28");
  }
  assert.deepEqual(JSON.parse(calls[3].init?.body as string), { body: "Looks good" });
});

test("github_api prefers explicit token and redacts it from errors", async () => {
  let seenAuth: string | null = null;
  const fetchImpl: FetchImpl = async (_url, init) => {
    seenAuth = header(init, "authorization");
    throw new Error("network failed for ghp_explicitsecret");
  };
  const tool = createGithubApiTool({
    fetchImpl,
    env: { GITHUB_TOKEN: "ghp_envsecret" },
    apiBaseUrl: "https://github.test",
  });

  const result = await tool.handle({
    token: "ghp_explicitsecret",
    owner: "octo",
    repo: "packetagent",
    operation: "list_prs",
  }, context());

  assert.equal(seenAuth, "Bearer ghp_explicitsecret");
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /\[redacted\]/);
  assert.doesNotMatch(result.error ?? "", /ghp_explicitsecret/);
});

test("github_api validates required token and create_comment body", async () => {
  const fetchImpl: FetchImpl = async () => {
    throw new Error("fetch should not be called");
  };
  const toolWithoutToken = createGithubApiTool({ fetchImpl, env: {}, apiBaseUrl: "https://github.test" });
  const missingToken = await toolWithoutToken.handle({
    owner: "octo",
    repo: "packetagent",
    operation: "list_prs",
  }, context());

  assert.equal(missingToken.ok, false);
  assert.match(missingToken.error ?? "", /token is required/);

  const tool = createGithubApiTool({ fetchImpl, env: { GITHUB_TOKEN: "ghp_envsecret" }, apiBaseUrl: "https://github.test" });
  const missingBody = await tool.handle({
    owner: "octo",
    repo: "packetagent",
    operation: "create_comment",
    issueNumber: 1,
  }, context());

  assert.equal(missingBody.ok, false);
  assert.match(missingBody.error ?? "", /body is required/);
});
