import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRecord, ProviderRecord } from "../packetagent-store.js";
import { compileWorkerCapabilityPolicy } from "../workers/capabilities.js";
import { validateWorkerVersionContent } from "../workers/validation.js";
import { projectLegacyAgentToExecutableWorker } from "./canonical-projection.js";

test("executable Agent projection is provider-routable, approval-bound, and memory complete", () => {
  const agent = makeAgent({
    triggerKind: "schedule",
    schedule: "0 * * * *",
    enabledTools: ["http_fetch"],
    tools: ["http_fetch"],
    memory: [{ id: "memory-local", label: "Audience", content: "Release operators" }],
    providerId: "provider-install-local",
  });
  const projection = projectLegacyAgentToExecutableWorker(agent, makeProvider());

  assert.equal(projection.version.content.execution.providerId, "openai");
  assert.equal(projection.version.content.execution.routeKey, "agent.provider.openai");
  assert.doesNotMatch(
    JSON.stringify(projection.version.content),
    /provider-install-local|memory-local/,
  );
  assert.match(projection.version.content.instructions, /Release operators/);
  assert.deepEqual(
    projection.version.content.triggers.map((trigger) => [
      trigger.id,
      trigger.kind,
      trigger.enabled,
    ]),
    [
      ["legacy-trigger-manual", "manual", true],
      ["legacy-trigger-schedule", "cron", true],
    ],
  );
  assert.deepEqual(
    projection.version.content.tools.map((tool) => [
      tool.id,
      tool.effect,
      tool.approval,
      tool.resources,
    ]),
    [
      [
        `legacy-agent:${agent.id}:http_fetch:read`,
        "read",
        "always",
        ["packetagent:approval-bound"],
      ],
      [
        `legacy-agent:${agent.id}:http_fetch:write`,
        "write",
        "always",
        ["packetagent:approval-bound"],
      ],
    ],
  );
  assert.equal(validateWorkerVersionContent(projection.version.content).ok, true);
  assert.doesNotThrow(() =>
    compileWorkerCapabilityPolicy({
      workerVersionContentDigest: projection.version.contentDigest,
      requestedCapabilities: projection.version.content.tools,
      allowedCapabilityIds: projection.version.content.policy.permissions.allowedCapabilityIds,
      credentialRefs: projection.version.content.credentialRefs,
    }),
  );
});

test("paused Agent projection keeps manual compatibility available but disables automatic delivery", () => {
  const projection = projectLegacyAgentToExecutableWorker(
    makeAgent({
      status: "paused",
      triggerKind: "webhook",
      webhookToken: "install-local-token",
    }),
    null,
  );

  assert.deepEqual(
    projection.version.content.triggers.map((trigger) => [trigger.kind, trigger.enabled]),
    [
      ["manual", true],
      ["webhook", false],
    ],
  );
  assert.equal(JSON.stringify(projection.version.content).includes("install-local-token"), false);
});

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-canonical",
    workspaceId: "workspace-canonical",
    name: "Release reviewer",
    description: "Review release evidence.",
    instructions: "Inspect the supplied release evidence and summarize risks.",
    providerId: undefined,
    model: "gpt-test",
    tools: [],
    enabledTools: [],
    routeKey: undefined,
    triggerKind: "manual",
    playbook: [],
    memory: [],
    evaluationSpec: { expectedOutput: "", requiredTools: [] },
    status: "active",
    inputSchema: [],
    createdByUserId: "user-canonical",
    createdAt: "2026-07-29T12:00:00.000Z",
    updatedAt: "2026-07-29T12:00:00.000Z",
    ...overrides,
  };
}

function makeProvider(): ProviderRecord {
  return {
    id: "provider-install-local",
    workspaceId: "workspace-canonical",
    name: "Production OpenAI",
    kind: "openai",
    defaultModel: "gpt-test",
    apiKeyConfigured: true,
    status: "connected",
    createdAt: "2026-07-29T12:00:00.000Z",
    updatedAt: "2026-07-29T12:00:00.000Z",
  };
}
