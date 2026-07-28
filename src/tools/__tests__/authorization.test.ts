import assert from "node:assert/strict";
import test from "node:test";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeWorkerCapabilityOperation } from "../../workers/capabilities.js";
import { browserGotoTool } from "../builtins-browser.js";
import { readWorkflowBriefTool } from "../builtins-read.js";
import { emailSendTool, sqlQueryTool } from "../email-sql.js";
import { httpFetchTool } from "../http-fetch.js";
import { shellForAgentTool } from "../shell-agent.js";
import { githubApiTool, slackPostWebhookTool } from "../slack-github.js";
import type { ToolContext, ToolDefinition } from "../types.js";

test("registered adapters expose normalized Worker operations before authorization", () => {
  const cases: Array<{
    readonly tool: ToolDefinition;
    readonly input: Record<string, unknown>;
    readonly expected: {
      readonly verb: string;
      readonly effect: "read" | "write" | "execute";
      readonly resources: readonly string[];
    };
  }> = [
    {
      tool: readWorkflowBriefTool,
      input: {},
      expected: {
        verb: "READ",
        effect: "read",
        resources: ["workspace:workspace-1"],
      },
    },
    {
      tool: httpFetchTool,
      input: {
        method: "get",
        url: "https://RELEASES.example.test:443/api/releases?token=redacted",
      },
      expected: {
        verb: "GET",
        effect: "read",
        resources: ["https://releases.example.test/api/releases"],
      },
    },
    {
      tool: browserGotoTool,
      input: { url: "https://releases.example.test/dashboard#status" },
      expected: {
        verb: "NAVIGATE",
        effect: "execute",
        resources: ["https://releases.example.test/dashboard"],
      },
    },
    {
      tool: githubApiTool,
      input: {
        owner: "packet",
        repo: "agent",
        operation: "create_comment",
        issueNumber: 42,
      },
      expected: {
        verb: "CREATE_COMMENT",
        effect: "write",
        resources: ["github:packet/agent/issues/42/comments"],
      },
    },
    {
      tool: slackPostWebhookTool,
      input: { text: "ready", channel: "#releases" },
      expected: {
        verb: "POST",
        effect: "write",
        resources: ["slack:channel/releases"],
      },
    },
    {
      tool: emailSendTool,
      input: {
        to: ["Release Owner <OWNER@example.test>", "qa@example.test"],
        subject: "ready",
        text: "ready",
      },
      expected: {
        verb: "SEND",
        effect: "write",
        resources: ["mailto:owner@example.test", "mailto:qa@example.test"],
      },
    },
    {
      tool: sqlQueryTool,
      input: { sql: "UPDATE releases SET ready = 1", write: true },
      expected: {
        verb: "MUTATE",
        effect: "write",
        resources: ["database:workspace-1/worker-1"],
      },
    },
    {
      tool: shellForAgentTool,
      input: { command: "npm", args: ["test"], cwd: "work" },
      expected: {
        verb: "EXECUTE",
        effect: "execute",
        resources: ["command:npm", pathToFileURL(resolvePath(process.cwd(), "work")).toString()],
      },
    },
  ];

  for (const entry of cases) {
    const descriptor = entry.tool.authorization?.describe(entry.input, context());
    assert.ok(descriptor, `${entry.tool.name} must expose authorization metadata`);
    const normalized = normalizeWorkerCapabilityOperation({
      tool: entry.tool.name,
      ...descriptor,
    });
    assert.deepEqual(
      {
        verb: normalized.verb,
        effect: normalized.effect,
        resources: normalized.resources,
      },
      entry.expected,
      entry.tool.name,
    );
  }
});

function context(): ToolContext {
  return {
    workspaceId: "workspace-1",
    userId: "test-user",
    runId: "run-1",
    agentId: "worker-1",
    signal: new AbortController().signal,
  };
}
