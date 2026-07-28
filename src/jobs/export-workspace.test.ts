import assert from "node:assert/strict";
import test from "node:test";
import { exportWorkspaceData, type ExportWorkspaceDeps } from "./export-workspace.js";
import type { PacketAgentData } from "../packetagent-store.js";
import { maskSecret } from "../security/redaction.js";
import { createWorkerRepository } from "../workers/repository.js";
import { createWorkerLifecycleService } from "../workers/service.js";
import {
  makeWorkerApprovalGrant,
  makeWorkerAttentionRequest,
  makeWorkerControlCommand,
  makeWorkerNotificationDelivery,
  makeWorkerVersionContent,
} from "../workers/__tests__/fixtures.js";

test("exportWorkspaceData throws 404 when the workspace does not exist", () => {
  const data = makeStore();
  try {
    exportWorkspaceData({ workspaceId: "missing" }, makeDeps(data));
    assert.fail("expected error");
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "workspace not found");
    assert.equal((error as { status?: number }).status, 404);
  }
});

test("exportWorkspaceData isolates entries belonging to the requested workspace", () => {
  const data = makeStore();
  const result = exportWorkspaceData({ workspaceId: "alpha" }, makeDeps(data));

  assert.equal(result.command, "export-workspace");
  assert.equal(result.workspaceId, "alpha");
  assert.ok(!Number.isNaN(Date.parse(result.exportedAt)));
  assert.equal(result.data.requirements.length, 1);
  assert.equal(result.data.requirements[0].id, "req_alpha");
  assert.equal(result.data.implementationPlanItems.length, 1);
  assert.equal(result.data.workflowConcerns.length, 1);
  assert.equal(result.data.activities.length, 1);
  assert.equal(result.data.invitations.length, 1);
  assert.equal(result.data.shareTokens.length, 1);
  assert.equal(result.data.workspaceEnvVars.length, 1);
  assert.equal(result.data.agents.length, 2);
  assert.equal(result.data.providers.length, 1);
  assert.equal(result.data.jobs.length, 1);
  assert.equal(result.data.memberships.length, 1);
  assert.equal(result.data.users.length, 1);
  assert.equal(result.data.users[0].id, "user_alpha");
});

test("exportWorkspaceData masks invitation and share tokens", () => {
  const data = makeStore();
  const result = exportWorkspaceData({ workspaceId: "alpha" }, makeDeps(data));

  const invitation = result.data.invitations[0];
  assert.equal((invitation as { token?: unknown }).token, undefined);
  assert.equal(invitation.tokenPreview, maskSecret("super-secret-invite-token-1234"));
  assert.ok(invitation.tokenPreview.endsWith(":1234"));

  const shareToken = result.data.shareTokens[0];
  assert.equal((shareToken as { token?: unknown }).token, undefined);
  assert.equal(shareToken.tokenPreview, maskSecret("share-secret-token-abcd"));
  assert.ok(shareToken.tokenPreview.endsWith(":abcd"));

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("super-secret-invite-token-1234"), false);
  assert.equal(serialized.includes("share-secret-token-abcd"), false);
});

test("exportWorkspaceData masks agent webhook tokens", () => {
  const data = makeStore();
  const result = exportWorkspaceData({ workspaceId: "alpha" }, makeDeps(data));

  const agentWithHook = result.data.agents.find((entry) => entry.id === "agent_alpha_hook");
  const agentWithoutHook = result.data.agents.find((entry) => entry.id === "agent_alpha_plain");
  assert.ok(agentWithHook);
  assert.ok(agentWithoutHook);
  assert.equal((agentWithHook as { webhookToken?: unknown }).webhookToken, undefined);
  assert.equal(agentWithHook.hasWebhookToken, true);
  assert.equal(agentWithHook.webhookTokenPreview, maskSecret("whk_secret_1234"));
  assert.equal(agentWithoutHook.hasWebhookToken, false);
  assert.equal(agentWithoutHook.webhookTokenPreview, "");

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("whk_secret_1234"), false);
});

test("exportWorkspaceData masks workspace env var secret values", () => {
  const data = makeStore();
  const result = exportWorkspaceData({ workspaceId: "alpha" }, makeDeps(data));

  const envVar = result.data.workspaceEnvVars[0];
  assert.equal((envVar as { value?: unknown }).value, undefined);
  assert.equal(envVar.hasValue, true);
  assert.equal(envVar.valuePreview, maskSecret("super-secret-env-value-xyzw"));

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("super-secret-env-value-xyzw"), false);
});

test("exportWorkspaceData masks provider credentials and reports presence", () => {
  const data = makeStore();
  const result = exportWorkspaceData({ workspaceId: "alpha" }, makeDeps(data));

  const provider = result.data.providers[0];
  assert.equal(provider.hasApiKey, true);
  assert.equal((provider as { apiKeyConfigured: unknown }).apiKeyConfigured, "[redacted]");
});

test("exportWorkspaceData recursively redacts nested sensitive values inside job payloads", () => {
  const data = makeStore();
  const result = exportWorkspaceData({ workspaceId: "alpha" }, makeDeps(data));

  const job = result.data.jobs[0];
  const payload = job.payload as { authorization: string; safe: string };
  assert.notEqual(payload.authorization, "Bearer abc-secret-token-7777");
  assert.equal(payload.safe, "ok");
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("abc-secret-token-7777"), false);
});

test("exportWorkspaceData includes only the selected workspace's Worker lifecycle", async () => {
  const data = makeStore();
  data.workerActivationPayloads.push({
    schemaVersion: "packetagent.worker-activation-payload/v1",
    id: "payload-export-alpha",
    reference: "worker-activation-payload:payload-export-alpha",
    workspaceId: "alpha",
    digest: `sha256:${"a".repeat(64)}`,
    byteLength: 42,
    classification: "sensitive",
    ciphertext: "encrypted-secret-material",
    iv: "secret-iv",
    authTag: "secret-auth-tag",
    createdAt: "2026-07-27T12:00:00.000Z",
    expiresAt: "2026-08-03T12:00:00.000Z",
  });
  const repository = createWorkerRepository({
    loadStore: () => data,
    mutateStore: (mutator) => mutator(data),
  });
  const service = createWorkerLifecycleService({
    repository,
    now: () => new Date("2026-07-27T12:00:00.000Z"),
    id: (kind) => `${kind}-export`,
  });
  await service.createDefinition({
    workspaceId: "alpha",
    actor: { type: "user", id: "user_alpha" },
    idempotencyKey: "export-worker-alpha",
    definitionId: "worker-export-alpha",
    versionId: "worker-export-alpha-v1",
    name: "Export Worker",
    description: "Verifies Worker export coverage.",
    content: makeWorkerVersionContent(),
    source: { product: "PacketAgent", kind: "native" },
  });
  await service.createDefinition({
    workspaceId: "beta",
    actor: { type: "user", id: "user_beta" },
    idempotencyKey: "export-worker-beta",
    definitionId: "worker-export-beta",
    versionId: "worker-export-beta-v1",
    name: "Hidden Worker",
    description: "Must not cross the workspace export boundary.",
    content: makeWorkerVersionContent(),
    source: { product: "PacketAgent", kind: "native" },
  });
  data.workerAttentionRequests.push(
    makeWorkerAttentionRequest({ id: "attention-alpha", workspaceId: "alpha" }),
    makeWorkerAttentionRequest({ id: "attention-beta", workspaceId: "beta" }),
  );
  data.workerApprovalGrants.push(
    makeWorkerApprovalGrant({ id: "approval-alpha", workspaceId: "alpha" }),
    makeWorkerApprovalGrant({ id: "approval-beta", workspaceId: "beta" }),
  );
  data.workerControlCommands.push(
    makeWorkerControlCommand({ id: "control-alpha", workspaceId: "alpha" }),
    makeWorkerControlCommand({ id: "control-beta", workspaceId: "beta" }),
  );
  data.workerNotificationDeliveries.push(
    makeWorkerNotificationDelivery({ id: "notification-alpha", workspaceId: "alpha" }),
    makeWorkerNotificationDelivery({ id: "notification-beta", workspaceId: "beta" }),
  );

  const result = exportWorkspaceData({ workspaceId: "alpha" }, makeDeps(data));

  assert.deepEqual(
    result.data.workerDefinitions.map((record) => record.id),
    ["worker-export-alpha"],
  );
  assert.deepEqual(
    result.data.workerVersions.map((record) => record.id),
    ["worker-export-alpha-v1"],
  );
  assert.equal(result.data.workerCommandReceipts.length, 1);
  assert.equal(result.data.workerEvents.length, 1);
  assert.deepEqual(
    result.data.workerAttentionRequests.map((record) => record.id),
    ["attention-alpha"],
  );
  assert.deepEqual(
    result.data.workerApprovalGrants.map((record) => record.id),
    ["approval-alpha"],
  );
  assert.deepEqual(
    result.data.workerControlCommands.map((record) => record.id),
    ["control-alpha"],
  );
  assert.deepEqual(
    result.data.workerNotificationDeliveries.map((record) => record.id),
    ["notification-alpha"],
  );
  assert.deepEqual(result.data.workerActivationPayloads, [
    {
      schemaVersion: "packetagent.worker-activation-payload/v1",
      id: "payload-export-alpha",
      reference: "worker-activation-payload:payload-export-alpha",
      workspaceId: "alpha",
      digest: `sha256:${"a".repeat(64)}`,
      byteLength: 42,
      classification: "sensitive",
      createdAt: "2026-07-27T12:00:00.000Z",
      expiresAt: "2026-08-03T12:00:00.000Z",
      encrypted: true,
    },
  ]);
  assert.equal(JSON.stringify(result).includes("encrypted-secret-material"), false);
  assert.equal(JSON.stringify(result).includes("worker-export-beta"), false);
});

function makeDeps(data: PacketAgentData): ExportWorkspaceDeps {
  return { loadStore: () => data };
}

function makeStore(): PacketAgentData {
  return {
    users: [
      {
        id: "user_alpha",
        email: "alpha@example.com",
        displayName: "Alpha User",
        timezone: "UTC",
        passwordHash: "hash",
        createdAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:00:00.000Z",
      },
      {
        id: "user_beta",
        email: "beta@example.com",
        displayName: "Beta User",
        timezone: "UTC",
        passwordHash: "hash",
        createdAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:00:00.000Z",
      },
    ],
    sessions: [],
    rateLimits: [],
    workspaces: [
      {
        id: "alpha",
        slug: "alpha",
        name: "Alpha",
        website: "",
        automationGoal: "",
        createdAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:00:00.000Z",
      },
      {
        id: "beta",
        slug: "beta",
        name: "Beta",
        website: "",
        automationGoal: "",
        createdAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:00:00.000Z",
      },
    ],
    memberships: [
      {
        workspaceId: "alpha",
        userId: "user_alpha",
        role: "owner",
        joinedAt: "2026-04-20T10:00:00.000Z",
      },
      {
        workspaceId: "beta",
        userId: "user_beta",
        role: "owner",
        joinedAt: "2026-04-20T10:00:00.000Z",
      },
    ],
    workspaceInvitations: [
      {
        id: "inv_alpha",
        workspaceId: "alpha",
        email: "guest@example.com",
        role: "member",
        token: "super-secret-invite-token-1234",
        invitedByUserId: "user_alpha",
        expiresAt: "2026-05-01T10:00:00.000Z",
        createdAt: "2026-04-20T10:00:00.000Z",
      },
      {
        id: "inv_beta",
        workspaceId: "beta",
        email: "guest2@example.com",
        role: "member",
        token: "beta-only-token-9999",
        invitedByUserId: "user_beta",
        expiresAt: "2026-05-01T10:00:00.000Z",
        createdAt: "2026-04-20T10:00:00.000Z",
      },
    ],
    invitationEmailDeliveries: [
      {
        id: "del_alpha",
        workspaceId: "alpha",
        invitationId: "inv_alpha",
        recipientEmail: "guest@example.com",
        subject: "Invitation",
        status: "sent",
        provider: "dev",
        mode: "dev",
        createdAt: "2026-04-20T10:00:00.000Z",
        sentAt: "2026-04-20T10:00:00.000Z",
      },
    ],
    workspaceBriefs: [],
    workspaceBriefVersions: [],
    requirements: [
      {
        id: "req_alpha",
        workspaceId: "alpha",
        title: "Requirement",
        priority: "must",
        status: "accepted",
        createdAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:00:00.000Z",
      },
      {
        id: "req_beta",
        workspaceId: "beta",
        title: "Beta requirement",
        priority: "must",
        status: "accepted",
        createdAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:00:00.000Z",
      },
    ],
    implementationPlanItems: [
      {
        id: "plan_alpha",
        workspaceId: "alpha",
        requirementIds: ["req_alpha"],
        title: "Build",
        description: "Build it",
        status: "done",
        order: 0,
        createdAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:00:00.000Z",
      },
    ],
    workflowConcerns: [
      {
        id: "concern_alpha",
        workspaceId: "alpha",
        kind: "blocker",
        title: "Blocker",
        description: "blocked",
        status: "open",
        severity: "high",
        createdAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:00:00.000Z",
      },
    ],
    validationEvidence: [],
    releaseConfirmations: [],
    onboardingStates: [],
    activities: [
      {
        id: "act_alpha",
        workspaceId: "alpha",
        scope: "workspace",
        event: "workspace.updated",
        actor: { type: "user", id: "user_alpha" },
        data: {},
        occurredAt: "2026-04-20T10:00:00.000Z",
      },
      {
        id: "act_beta",
        workspaceId: "beta",
        scope: "workspace",
        event: "workspace.updated",
        actor: { type: "user", id: "user_beta" },
        data: {},
        occurredAt: "2026-04-20T10:00:00.000Z",
      },
    ],
    activationSignals: [],
    activationFacts: {},
    agents: [
      {
        id: "agent_alpha_hook",
        workspaceId: "alpha",
        name: "Hook Agent",
        description: "",
        instructions: "",
        tools: [],
        webhookToken: "whk_secret_1234",
        status: "active",
        createdByUserId: "user_alpha",
        inputSchema: [],
        createdAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:00:00.000Z",
      },
      {
        id: "agent_alpha_plain",
        workspaceId: "alpha",
        name: "Plain Agent",
        description: "",
        instructions: "",
        tools: [],
        status: "active",
        createdByUserId: "user_alpha",
        inputSchema: [],
        createdAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:00:00.000Z",
      },
      {
        id: "agent_beta",
        workspaceId: "beta",
        name: "Beta Agent",
        description: "",
        instructions: "",
        tools: [],
        webhookToken: "whk_beta_5678",
        status: "active",
        createdByUserId: "user_beta",
        inputSchema: [],
        createdAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:00:00.000Z",
      },
    ],
    providers: [
      {
        id: "prov_alpha",
        workspaceId: "alpha",
        name: "OpenAI",
        kind: "openai",
        defaultModel: "gpt-4",
        apiKeyConfigured: true,
        status: "connected",
        createdAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:00:00.000Z",
      },
    ],
    agentRuns: [],
    workspaceEnvVars: [
      {
        id: "env_alpha",
        workspaceId: "alpha",
        key: "API_TOKEN",
        value: "super-secret-env-value-xyzw",
        scope: "all",
        secret: true,
        createdAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:00:00.000Z",
      },
      {
        id: "env_beta",
        workspaceId: "beta",
        key: "BETA",
        value: "beta-secret-only",
        scope: "all",
        secret: true,
        createdAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:00:00.000Z",
      },
    ],
    apiKeys: [],
    providerCalls: [],
    jobs: [
      {
        id: "job_alpha",
        workspaceId: "alpha",
        type: "send-email",
        payload: { authorization: "Bearer abc-secret-token-7777", safe: "ok" },
        status: "queued",
        attempts: 0,
        maxAttempts: 3,
        scheduledAt: "2026-04-20T10:00:00.000Z",
        createdAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:00:00.000Z",
      },
    ],
    jobMetricSnapshots: [],
    alertEvents: [],
    shareTokens: [
      {
        id: "share_alpha",
        workspaceId: "alpha",
        token: "share-secret-token-abcd",
        scope: "brief",
        createdByUserId: "user_alpha",
        readCount: 0,
        createdAt: "2026-04-20T10:00:00.000Z",
      },
      {
        id: "share_beta",
        workspaceId: "beta",
        token: "share-beta-token-efgh",
        scope: "brief",
        createdByUserId: "user_beta",
        readCount: 0,
        createdAt: "2026-04-20T10:00:00.000Z",
      },
    ],
    workerCredentials: [],
    packetProductCredentials: [],
    workerPackageReceipts: [],
    workerPackageDeployments: [],
    packetProductEventAcknowledgements: [],
    workerDefinitions: [],
    workerVersions: [],
    workerDeployments: [],
    workerRuns: [],
    workerCheckpoints: [],
    workerEffectReceipts: [],
    workerBudgetReservations: [],
    workerAttentionRequests: [],
    workerApprovalGrants: [],
    workerControlCommands: [],
    workerNotificationDeliveries: [],
    workerDeploymentRollouts: [],
    workerCommandReceipts: [],
    workerEvents: [],
    workerEvidenceEntries: [],
    workerArtifactManifests: [],
    workerActivationInboxes: [],
    workerActivationPayloads: [],
    activationMilestones: {},
    activationReadModels: {},
  };
}
