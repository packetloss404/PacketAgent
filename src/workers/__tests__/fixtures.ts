import {
  WORKER_CONTRACT_SCHEMA_VERSION,
  type WorkerCheckpoint,
  type WorkerDefinition,
  type WorkerDeployment,
  type WorkerDeploymentStatus,
  type WorkerRun,
  type WorkerRunStatus,
  type WorkerRunTerminalReason,
  type WorkerVersion,
  type WorkerVersionContent,
  type WorkerVersionStatus,
} from "../types.js";
import { computeWorkerVersionContentDigest } from "../validation.js";
import {
  WORKER_APPROVAL_GRANT_SCHEMA_VERSION,
  WORKER_ATTENTION_REQUEST_SCHEMA_VERSION,
  WORKER_CONTROL_COMMAND_SCHEMA_VERSION,
  WORKER_NOTIFICATION_DELIVERY_SCHEMA_VERSION,
  type WorkerApprovalGrant,
  type WorkerAttentionRequest,
  type WorkerControlCommand,
  type LegacyWorkerNotificationDeliveryReference,
} from "../control-types.js";

export const TEST_NOW = "2026-07-27T12:00:00.000Z";
export const TEST_LATER = "2026-07-27T12:05:00.000Z";

export function makeWorkerDefinition(overrides: Partial<WorkerDefinition> = {}): WorkerDefinition {
  return {
    schemaVersion: WORKER_CONTRACT_SCHEMA_VERSION,
    id: "worker-1",
    workspaceId: "workspace-1",
    name: "Release watcher",
    description: "Watches release evidence and reports blockers.",
    status: "draft",
    createdBy: { type: "user", id: "user-1" },
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...overrides,
  };
}

export function makeWorkerVersionContent(
  overrides: Partial<WorkerVersionContent> = {},
): WorkerVersionContent {
  return {
    objective: "Verify release readiness and report a bounded result.",
    instructions:
      "Inspect the supplied evidence, report blockers, and stop when the release decision is clear.",
    inputSchema: {
      fields: [
        {
          key: "release_id",
          label: "Release ID",
          type: "string",
          required: true,
        },
      ],
      additionalProperties: false,
    },
    execution: {
      routeKey: "smart",
      target: { kind: "packetagent" },
    },
    tools: [
      {
        id: "release-read",
        tool: "http_fetch",
        verbs: ["GET"],
        resources: ["https://releases.example.test/*"],
        effect: "read",
        approval: "never",
      },
    ],
    credentialRefs: ["vault:release-api"],
    triggers: [
      {
        id: "manual",
        kind: "manual",
        enabled: true,
      },
    ],
    policy: {
      budgets: {
        maxElapsedMs: 300_000,
        maxIterations: 8,
        maxProviderCostUsd: 2,
        maxConsecutiveFailures: 3,
        maxToolCalls: 20,
        rolling: {
          windowMs: 24 * 60 * 60 * 1_000,
          workspace: {
            maxProviderCostUsd: 200,
            maxBillableActions: 2_000,
          },
          deployment: {
            maxProviderCostUsd: 200,
            maxBillableActions: 2_000,
          },
        },
      },
      retry: {
        maxAttempts: 2,
        initialBackoffMs: 1_000,
        maxBackoffMs: 30_000,
        backoffMultiplier: 2,
      },
      permissions: {
        default: "deny",
        allowedCapabilityIds: ["release-read"],
      },
      attention: {
        approvalTimeoutMs: 30 * 60 * 1_000,
        escalationAfterMs: 10 * 60 * 1_000,
        onExpiration: "pause",
      },
    },
    exitPredicates: [
      {
        id: "release-decision",
        kind: "objective_satisfied",
        description: "A release-ready or blocked decision has been produced with evidence.",
      },
    ],
    acceptanceCommands: ["npm run test:api"],
    notificationRoutes: [
      {
        id: "local-attention",
        kind: "packetagent",
        reference: "workspace:workspace-1",
        events: ["attention", "terminal"],
      },
    ],
    ...overrides,
  };
}

function versionStatusTimestamps(status: WorkerVersionStatus): Partial<WorkerVersion> {
  if (status === "validated") return { validatedAt: TEST_LATER };
  if (status === "rejected") return { rejectedAt: TEST_LATER };
  if (status === "retired") return { retiredAt: TEST_LATER };
  return {};
}

export function makeWorkerVersion(overrides: Partial<WorkerVersion> = {}): WorkerVersion {
  const content = overrides.content ?? makeWorkerVersionContent();
  const status = overrides.status ?? "draft";
  return {
    schemaVersion: WORKER_CONTRACT_SCHEMA_VERSION,
    id: "worker-version-1",
    workspaceId: "workspace-1",
    workerDefinitionId: "worker-1",
    version: 1,
    status,
    content,
    contentDigest: overrides.contentDigest ?? computeWorkerVersionContentDigest(content),
    source: {
      product: "PacketAgent",
      kind: "native",
    },
    createdBy: { type: "user", id: "user-1" },
    createdAt: TEST_NOW,
    ...versionStatusTimestamps(status),
    ...overrides,
  };
}

function deploymentStatusTimestamps(status: WorkerDeploymentStatus): Partial<WorkerDeployment> {
  if (status === "validated") return { validatedAt: TEST_LATER };
  if (status === "deployed") return { deployedAt: TEST_LATER };
  if (status === "active") return { activatedAt: TEST_LATER };
  if (status === "paused") return { pausedAt: TEST_LATER };
  if (status === "attention") return { attentionAt: TEST_LATER };
  if (status === "retired") return { retiredAt: TEST_LATER };
  if (status === "rejected") return { rejectedAt: TEST_LATER };
  if (status === "revoked") return { revokedAt: TEST_LATER };
  return {};
}

export function makeWorkerDeployment(overrides: Partial<WorkerDeployment> = {}): WorkerDeployment {
  const status = overrides.status ?? "draft";
  return {
    schemaVersion: WORKER_CONTRACT_SCHEMA_VERSION,
    id: "deployment-1",
    workspaceId: "workspace-1",
    workerDefinitionId: "worker-1",
    workerVersionId: "worker-version-1",
    status,
    revision: 1,
    createdBy: { type: "user", id: "user-1" },
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...deploymentStatusTimestamps(status),
    ...overrides,
  };
}

function terminalReasonFor(status: WorkerRunStatus): WorkerRunTerminalReason | undefined {
  if (status === "completed") return "objective_satisfied";
  if (status === "failed") return "unhandled_error";
  if (status === "budget_exhausted") return "iteration_limit";
  if (status === "cancelled") return "operator_cancelled";
  if (status === "quarantined") return "unsafe_replay";
  return undefined;
}

export function makeWorkerRun(overrides: Partial<WorkerRun> = {}): WorkerRun {
  const status = overrides.status ?? "queued";
  const terminalReason = overrides.terminalReason ?? terminalReasonFor(status);
  const terminal = terminalReason !== undefined;
  return {
    schemaVersion: WORKER_CONTRACT_SCHEMA_VERSION,
    id: "run-1",
    workspaceId: "workspace-1",
    workerDefinitionId: "worker-1",
    workerVersionId: "worker-version-1",
    workerDeploymentId: "deployment-1",
    triggerId: "manual",
    triggerKind: "manual",
    status,
    attempt: 1,
    revision: 1,
    runtimeFence: 0,
    input: { release_id: "release-42" },
    budgetUsage: {
      elapsedMs: 0,
      iterations: 0,
      providerCostUsd: 0,
      consecutiveFailures: 0,
      toolCalls: 0,
    },
    trace: {
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
    },
    createdAt: TEST_NOW,
    updatedAt: terminal || status !== "queued" ? TEST_LATER : TEST_NOW,
    ...(status !== "queued" ? { startedAt: TEST_NOW } : {}),
    ...(terminal ? { terminalReason, completedAt: TEST_LATER } : {}),
    ...overrides,
  };
}

export function makeWorkerCheckpoint(overrides: Partial<WorkerCheckpoint> = {}): WorkerCheckpoint {
  return {
    schemaVersion: WORKER_CONTRACT_SCHEMA_VERSION,
    id: "checkpoint-1",
    workspaceId: "workspace-1",
    workerRunId: "run-1",
    workerVersionId: "worker-version-1",
    sequence: 0,
    cursor: {
      phase: "plan",
      iteration: 0,
      actionIndex: 0,
    },
    workingMemory: {
      objective: "Verify release readiness.",
    },
    completedActionIds: [],
    pendingApprovalIds: [],
    artifactRefs: [],
    effectReceiptIds: [],
    remainingBudget: {
      elapsedMs: 300_000,
      iterations: 8,
      providerCostUsd: 2,
      consecutiveFailures: 3,
      toolCalls: 20,
    },
    trace: {
      traceId: "0123456789abcdef0123456789abcdef",
    },
    createdAt: TEST_NOW,
    stateDigest: `sha256:${"a".repeat(64)}`,
    ...overrides,
  };
}

export function makeWorkerAttentionRequest(
  overrides: Partial<WorkerAttentionRequest> = {},
): WorkerAttentionRequest {
  return {
    schemaVersion: WORKER_ATTENTION_REQUEST_SCHEMA_VERSION,
    id: "attention-1",
    requestKey: "run-1:iteration-1:action-1",
    workspaceId: "workspace-1",
    workerDefinitionId: "worker-1",
    workerDeploymentId: "deployment-1",
    workerRunId: "run-1",
    workerVersionId: "worker-version-1",
    workerVersionContentDigest: `sha256:${"d".repeat(64)}`,
    status: "open",
    capabilityId: "release-read",
    operationDigest: `sha256:${"e".repeat(64)}`,
    policyDigest: `sha256:${"f".repeat(64)}`,
    expirationDisposition: "pause",
    requestedBy: { type: "system", id: "packetagent.worker-supervisor" },
    requestedAt: TEST_NOW,
    escalatesAt: "2026-07-27T12:30:00.000Z",
    expiresAt: "2026-07-27T13:00:00.000Z",
    notificationRouteIds: ["local-attention"],
    ...overrides,
  };
}

export function makeWorkerApprovalGrant(
  overrides: Partial<WorkerApprovalGrant> = {},
): WorkerApprovalGrant {
  return {
    schemaVersion: WORKER_APPROVAL_GRANT_SCHEMA_VERSION,
    id: "approval-1",
    attentionRequestId: "attention-1",
    workspaceId: "workspace-1",
    workerDefinitionId: "worker-1",
    workerDeploymentId: "deployment-1",
    workerRunId: "run-1",
    workerVersionId: "worker-version-1",
    workerVersionContentDigest: `sha256:${"d".repeat(64)}`,
    capabilityId: "release-read",
    operationDigest: `sha256:${"e".repeat(64)}`,
    policyDigest: `sha256:${"f".repeat(64)}`,
    scope: "once",
    status: "active",
    nonceDigest: `sha256:${"9".repeat(64)}`,
    grantedBy: { type: "user", id: "operator-1" },
    grantedAt: TEST_NOW,
    expiresAt: "2026-07-27T13:00:00.000Z",
    ...overrides,
  };
}

export function makeWorkerControlCommand(
  overrides: Partial<WorkerControlCommand> = {},
): WorkerControlCommand {
  return {
    schemaVersion: WORKER_CONTROL_COMMAND_SCHEMA_VERSION,
    id: "control-command-1",
    workspaceId: "workspace-1",
    workerDefinitionId: "worker-1",
    workerDeploymentId: "deployment-1",
    workerRunId: "run-1",
    workerVersionId: "worker-version-1",
    workerVersionContentDigest: `sha256:${"d".repeat(64)}`,
    kind: "pause_run",
    status: "pending",
    expectedRevision: 1,
    idempotencyKey: "pause-run-1",
    requestDigest: `sha256:${"f".repeat(64)}`,
    actor: { type: "user", id: "operator-1" },
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...overrides,
  };
}

export function makeWorkerNotificationDelivery(
  overrides: Partial<LegacyWorkerNotificationDeliveryReference> = {},
): LegacyWorkerNotificationDeliveryReference {
  return {
    schemaVersion: WORKER_NOTIFICATION_DELIVERY_SCHEMA_VERSION,
    id: "notification-1",
    deliveryKey: "attention-1:local-attention:requested",
    workspaceId: "workspace-1",
    workerDefinitionId: "worker-1",
    workerDeploymentId: "deployment-1",
    workerRunId: "run-1",
    workerVersionId: "worker-version-1",
    workerVersionContentDigest: `sha256:${"d".repeat(64)}`,
    event: "attention",
    attentionRequestId: "attention-1",
    notificationRouteId: "local-attention",
    notificationRouteKind: "packetagent",
    notificationRouteReference: "workspace:workspace-1",
    status: "queued",
    attemptCount: 0,
    scheduledAt: TEST_NOW,
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...overrides,
  };
}
