import { test } from "node:test";
import assert from "node:assert/strict";
import { WORKER_TOOL_CAPABILITY_SCHEMAS } from "../../workers/capabilities.js";
import { ToolRegistry } from "../registry.js";
import { executeTool } from "../executor.js";
import { listDefaultToolSummaries, listDefaultWorkerAuthorizationGaps } from "../bootstrap.js";
import type { ToolDefinition } from "../types.js";

const echoTool: ToolDefinition = {
  name: "echo",
  description: "Echo back the input string.",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  side: "read",
  async handle(input) {
    return { ok: true, output: { echo: (input as { text: string }).text } };
  },
};

const slowTool: ToolDefinition = {
  name: "slow",
  description: "Hangs forever.",
  inputSchema: { type: "object" },
  side: "read",
  timeoutMs: 50,
  async handle(_input, ctx) {
    await new Promise<void>((_, reject) => {
      const id = setTimeout(() => {}, 10_000);
      ctx.signal.addEventListener("abort", () => {
        clearTimeout(id);
        reject(new Error("aborted"));
      });
    });
    return { ok: true };
  },
};

const failingTool: ToolDefinition = {
  name: "boom",
  description: "Throws.",
  inputSchema: { type: "object" },
  side: "read",
  async handle() {
    throw new Error("kaboom");
  },
};

const artifactTool: ToolDefinition = {
  name: "artifact",
  description: "Returns an artifact.",
  inputSchema: { type: "object" },
  side: "read",
  async handle() {
    return {
      ok: true,
      output: { path: "data/artifacts/run-1/page.png" },
      artifacts: [{ path: "data/artifacts/run-1/page.png", bytes: 12, kind: "image/png" }],
    };
  },
};

test("register and list", () => {
  const r = new ToolRegistry();
  r.register(echoTool);
  r.register(slowTool);
  assert.equal(r.list().length, 2);
  assert.deepEqual(
    r
      .list()
      .map((t) => t.name)
      .sort(),
    ["echo", "slow"],
  );
  assert.equal(r.get("echo")?.name, "echo");
  assert.equal(r.hasName("echo"), true);
  assert.equal(r.hasName("missing"), false);
});

test("filter returns only known names in order", () => {
  const r = new ToolRegistry();
  r.registerMany([echoTool, slowTool]);
  const tools = r.filter(["echo", "missing", "slow"]);
  assert.equal(tools.length, 2);
  assert.equal(tools[0].name, "echo");
  assert.equal(tools[1].name, "slow");
});

test("default tool summaries include the Track D agent catalog", () => {
  const names = new Set(listDefaultToolSummaries().map((tool) => tool.name));
  for (const name of [
    "http_fetch",
    "slack_post_webhook",
    "github_api",
    "email_send",
    "sql_query",
    "shell_for_agent",
  ]) {
    assert.equal(names.has(name), true, `${name} should be registered in the default catalog`);
  }
});

test("every production-registered tool exposes a Worker authorization descriptor", () => {
  assert.deepEqual(listDefaultWorkerAuthorizationGaps(), []);
  assert.deepEqual(
    listDefaultToolSummaries()
      .map((tool) => tool.name)
      .sort(),
    Object.keys(WORKER_TOOL_CAPABILITY_SCHEMAS).sort(),
  );
});

test("executeTool returns ok status with output", async () => {
  const ctrl = new AbortController();
  const record = await executeTool({
    tool: echoTool,
    input: { text: "hi" },
    context: { workspaceId: "w", userId: "u", signal: ctrl.signal },
  });
  assert.equal(record.status, "ok");
  assert.deepEqual(record.output, { echo: "hi" });
  assert.equal(record.toolName, "echo");
  assert.ok(record.durationMs >= 0);
});

test("executeTool preserves artifact metadata", async () => {
  const record = await executeTool({
    tool: artifactTool,
    input: {},
    context: { workspaceId: "w", userId: "u" },
  });
  assert.equal(record.status, "ok");
  assert.deepEqual(record.artifacts, [
    { path: "data/artifacts/run-1/page.png", bytes: 12, kind: "image/png" },
  ]);
});

test("executeTool catches thrown errors and returns error status", async () => {
  const record = await executeTool({
    tool: failingTool,
    input: {},
    context: { workspaceId: "w", userId: "u" },
  });
  assert.equal(record.status, "error");
  assert.equal(record.error, "kaboom");
});

test("executeTool times out via tool.timeoutMs", async () => {
  const record = await executeTool({
    tool: slowTool,
    input: {},
    context: { workspaceId: "w", userId: "u" },
  });
  assert.equal(record.status, "timeout");
  assert.match(record.error ?? "", /timed out/);
});

test("executeTool propagates outer abort", async () => {
  const ctrl = new AbortController();
  const promise = executeTool({
    tool: slowTool,
    input: {},
    context: { workspaceId: "w", userId: "u", signal: ctrl.signal },
  });
  ctrl.abort();
  const record = await promise;
  assert.equal(record.status, "timeout");
});
