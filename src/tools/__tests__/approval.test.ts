import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TOOL_APPROVAL_TTL_MS,
  buildToolCapabilityApprovalRequest,
  toolCapabilityInputsHash,
  toolCapabilityRisk,
  verifyToolCapabilityApproval,
} from "../approval.js";
import type { ToolDefinition } from "../types.js";

const secret = "approval-test-secret";
const now = new Date("2026-05-18T12:00:00.000Z");

function tool(name: string, side: ToolDefinition["side"]): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { type: "object" },
    side,
    async handle() {
      return { ok: true };
    },
  };
}

function decodeTokenBody(token: string): Record<string, unknown> {
  const body = token.split(".")[0] ?? "";
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
}

test("builds a readable request with risk summaries", () => {
  const inputs = { ticket: "APP-42", token: "super-secret-input-value" };
  const tools = [
    tool("http_fetch", "read"),
    tool("slack_post_webhook", "write"),
    tool("shell_for_agent", "exec"),
  ];

  const request = buildToolCapabilityApprovalRequest({
    workspaceId: "workspace-1",
    agentId: "agent-1",
    triggerKind: "manual",
    tools,
    inputs,
    now,
    secret,
  });

  assert.equal(request.required, true);
  assert.equal(request.workspaceId, "workspace-1");
  assert.equal(request.agentId, "agent-1");
  assert.equal(
    request.expiresAt,
    new Date(now.getTime() + DEFAULT_TOOL_APPROVAL_TTL_MS).toISOString(),
  );
  assert.match(request.summary, /http_fetch \(low\)/);
  assert.match(request.summary, /slack_post_webhook \(medium\)/);
  assert.match(request.summary, /shell_for_agent \(high\)/);
  assert.deepEqual(
    request.tools.map((approvalTool) => ({
      name: approvalTool.name,
      risk: approvalTool.risk,
      riskSummary: approvalTool.riskSummary,
    })),
    [
      {
        name: "http_fetch",
        risk: "low",
        riskSummary: "http_fetch is read-only.",
      },
      {
        name: "slack_post_webhook",
        risk: "medium",
        riskSummary: "slack_post_webhook can make changes or call external side-effect APIs.",
      },
      {
        name: "shell_for_agent",
        risk: "high",
        riskSummary: "shell_for_agent can execute commands or high-impact operations.",
      },
    ],
  );
  assert.equal(toolCapabilityRisk(tool("shell_for_agent", "read")), "high");

  const tokenBody = decodeTokenBody(request.approvalToken);
  assert.equal(tokenBody.inputsHash, toolCapabilityInputsHash(inputs));
  assert.doesNotMatch(JSON.stringify(tokenBody), /super-secret-input-value/);
});

test("verifies a valid launch token", () => {
  const tools = [tool("email_send", "write"), tool("http_fetch", "read")];
  const request = buildToolCapabilityApprovalRequest({
    workspaceId: "workspace-1",
    agentId: "agent-1",
    triggerKind: "webhook",
    tools,
    inputs: { b: 2, a: 1 },
    now,
    secret,
  });

  const result = verifyToolCapabilityApproval({
    workspaceId: "workspace-1",
    agentId: "agent-1",
    triggerKind: "webhook",
    tools,
    inputs: { a: 1, b: 2 },
    now,
    secret,
    decision: "launch",
    token: request.approvalToken,
    approvedTools: ["http_fetch", "email_send"],
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.approvedTools, ["email_send", "http_fetch"]);
    assert.equal(result.expiresAt, request.expiresAt);
  }

  const nestedPayloadResult = verifyToolCapabilityApproval(
    {
      decision: "launch",
      token: request.approvalToken,
      approvedTools: ["email_send", "http_fetch"],
    },
    {
      workspaceId: "workspace-1",
      agentId: "agent-1",
      triggerKind: "webhook",
      tools,
      inputs: { a: 1, b: 2 },
      now,
      secret,
    },
  );
  assert.equal(nestedPayloadResult.ok, true);
});

test("binds approval tokens to the approving user and consumes launch tokens once", () => {
  const tools = [tool("email_send", "write")];
  const request = buildToolCapabilityApprovalRequest({
    workspaceId: "workspace-1",
    userId: "user-a",
    agentId: "agent-1",
    triggerKind: "manual",
    tools,
    inputs: { ticket: "APP-42" },
    now,
    secret,
  });

  const wrongUser = verifyToolCapabilityApproval({
    workspaceId: "workspace-1",
    userId: "user-b",
    agentId: "agent-1",
    triggerKind: "manual",
    tools,
    inputs: { ticket: "APP-42" },
    now,
    secret,
    decision: "launch",
    token: request.approvalToken,
    approvedTools: ["email_send"],
    consume: true,
  });
  assert.equal(wrongUser.ok, false);
  if (wrongUser.ok) assert.fail("cross-user token should be rejected");
  assert.match(wrongUser.error, /user/);

  const firstUse = verifyToolCapabilityApproval({
    workspaceId: "workspace-1",
    userId: "user-a",
    agentId: "agent-1",
    triggerKind: "manual",
    tools,
    inputs: { ticket: "APP-42" },
    now,
    secret,
    decision: "launch",
    token: request.approvalToken,
    approvedTools: ["email_send"],
    consume: true,
  });
  assert.equal(firstUse.ok, true);

  const replay = verifyToolCapabilityApproval({
    workspaceId: "workspace-1",
    userId: "user-a",
    agentId: "agent-1",
    triggerKind: "manual",
    tools,
    inputs: { ticket: "APP-42" },
    now,
    secret,
    decision: "launch",
    token: request.approvalToken,
    approvedTools: ["email_send"],
    consume: true,
  });
  assert.equal(replay.ok, false);
  if (replay.ok) assert.fail("replayed token should be rejected");
  assert.match(replay.error, /already been used/);
});

test("rejects an expired token", () => {
  const tools = [tool("http_fetch", "read")];
  const request = buildToolCapabilityApprovalRequest({
    workspaceId: "workspace-1",
    agentId: "agent-1",
    triggerKind: "manual",
    tools,
    inputs: { q: "status" },
    now,
    secret,
  });

  const result = verifyToolCapabilityApproval({
    workspaceId: "workspace-1",
    agentId: "agent-1",
    triggerKind: "manual",
    tools,
    inputs: { q: "status" },
    now: now.getTime() + DEFAULT_TOOL_APPROVAL_TTL_MS + 1,
    secret,
    decision: "launch",
    token: request.approvalToken,
    approvedTools: ["http_fetch"],
  });

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expired token should be rejected");
  assert.match(result.error, /expired/);
});

test("rejects changed inputs or tools", () => {
  const tools = [tool("http_fetch", "read"), tool("email_send", "write")];
  const request = buildToolCapabilityApprovalRequest({
    workspaceId: "workspace-1",
    agentId: "agent-1",
    triggerKind: "manual",
    tools,
    inputs: { ticket: "APP-42" },
    now,
    secret,
  });

  const changedInputs = verifyToolCapabilityApproval({
    workspaceId: "workspace-1",
    agentId: "agent-1",
    triggerKind: "manual",
    tools,
    inputs: { ticket: "APP-43" },
    now,
    secret,
    decision: "launch",
    token: request.approvalToken,
    approvedTools: ["http_fetch", "email_send"],
  });
  assert.equal(changedInputs.ok, false);
  if (changedInputs.ok) assert.fail("changed inputs should be rejected");
  assert.match(changedInputs.error, /inputs/);

  const changedTools = verifyToolCapabilityApproval({
    workspaceId: "workspace-1",
    agentId: "agent-1",
    triggerKind: "manual",
    tools: [tool("http_fetch", "read"), tool("shell_for_agent", "exec")],
    inputs: { ticket: "APP-42" },
    now,
    secret,
    decision: "launch",
    token: request.approvalToken,
    approvedTools: ["http_fetch", "shell_for_agent"],
  });
  assert.equal(changedTools.ok, false);
  if (changedTools.ok) assert.fail("changed tools should be rejected");
  assert.match(changedTools.error, /tools/);
});

test("rejects cancel or a missing required approved tool", () => {
  const tools = [tool("http_fetch", "read"), tool("email_send", "write")];
  const request = buildToolCapabilityApprovalRequest({
    workspaceId: "workspace-1",
    agentId: "agent-1",
    triggerKind: "manual",
    tools,
    inputs: { ticket: "APP-42" },
    now,
    secret,
  });

  const canceled = verifyToolCapabilityApproval({
    workspaceId: "workspace-1",
    agentId: "agent-1",
    triggerKind: "manual",
    tools,
    inputs: { ticket: "APP-42" },
    now,
    secret,
    decision: "cancel",
    token: request.approvalToken,
    approvedTools: ["http_fetch", "email_send"],
  });
  assert.equal(canceled.ok, false);
  if (canceled.ok) assert.fail("cancel should be rejected");
  assert.match(canceled.error, /canceled/);

  const missingApprovedTool = verifyToolCapabilityApproval({
    workspaceId: "workspace-1",
    agentId: "agent-1",
    triggerKind: "manual",
    tools,
    inputs: { ticket: "APP-42" },
    now,
    secret,
    decision: "launch",
    token: request.approvalToken,
    approvedTools: ["http_fetch"],
  });
  assert.equal(missingApprovedTool.ok, false);
  if (missingApprovedTool.ok) assert.fail("missing approved tool should be rejected");
  assert.match(missingApprovedTool.error, /approvedTools/);
});
