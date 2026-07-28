import { Hono, type Context } from "hono";
import { loadStoreAsync as defaultLoadStore, type PacketAgentData } from "./packetagent-store.js";
import { requirePrivateWorkspacePermissionAsync, type WorkspacePermission } from "./rbac.js";
import { redactedErrorMessage } from "./security/redaction.js";
import {
  createWorkerControlService,
  type WorkerControlResult,
  type WorkerControlService,
} from "./workers/control-service.js";
import type {
  WorkerApprovalGrant,
  WorkerAttentionRequest,
  WorkerAttentionRequestStatus,
  WorkerControlCommand,
} from "./workers/control-types.js";
import { WorkerLifecycleError } from "./workers/errors.js";
import type { WorkerEvent } from "./workers/persistence-types.js";
import { validateWorkerPersistence } from "./workers/repository.js";
import type { WorkerActorReference, WorkerDeployment, WorkerRun } from "./workers/types.js";

type MaybePromise<T> = T | Promise<T>;

export type WorkerOperatorPermission = "inspect" | "control_run" | "control_deployment" | "approve";

export interface AuthorizedWorkerOperatorContext {
  readonly workspaceId: string;
  readonly actor: WorkerActorReference;
}

export interface WorkerOperatorRoutesDependencies {
  readonly control?: WorkerControlService;
  readonly loadStore?: () => MaybePromise<PacketAgentData>;
  readonly authorize?: (
    context: Context,
    permission: WorkerOperatorPermission,
  ) => Promise<AuthorizedWorkerOperatorContext>;
}

export interface WorkerOperatorRunView {
  readonly id: string;
  readonly workerDefinitionId: string;
  readonly workerDeploymentId: string;
  readonly workerVersionId: string;
  readonly status: WorkerRun["status"];
  readonly revision: number;
  readonly attempt: number;
  readonly budgetUsage: WorkerRun["budgetUsage"];
  readonly terminalReason?: WorkerRun["terminalReason"];
  readonly latestCheckpointId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly attention: readonly WorkerOperatorAttentionView[];
}

export interface WorkerOperatorAttentionView {
  readonly id: string;
  readonly workerDefinitionId: string;
  readonly workerDeploymentId: string;
  readonly workerRunId: string;
  readonly workerVersionId: string;
  readonly status: WorkerAttentionRequestStatus;
  readonly runRevision: number;
  readonly capabilityId: string;
  readonly operationDigest: string;
  readonly operation?: {
    readonly tool: string;
    readonly verb: string;
    readonly effect: string;
    readonly resourceCount: number;
    readonly resourceSchemes: readonly string[];
  };
  readonly expirationDisposition: WorkerAttentionRequest["expirationDisposition"];
  readonly requestedAt: string;
  readonly escalatesAt?: string;
  readonly expiresAt: string;
  readonly resolvedAt?: string;
  readonly resolvedBy?: WorkerActorReference;
}

export function createWorkerOperatorRoutes(
  dependencies: WorkerOperatorRoutesDependencies = {},
): Hono {
  const routes = new Hono();
  const control = dependencies.control ?? createWorkerControlService();
  const loadStore = dependencies.loadStore ?? defaultLoadStore;
  const authorize = dependencies.authorize ?? authorizeWorkerOperatorRoute;

  routes.get("/runs/:workerRunId", async (c) => {
    try {
      const auth = await authorize(c, "inspect");
      const data = await readStore(loadStore);
      const run = requireRun(data, auth.workspaceId, requiredPathParameter(c, "workerRunId"));
      return c.json({ run: projectRun(data, run) });
    } catch (error) {
      return workerOperatorRouteError(c, error);
    }
  });

  routes.get("/attention", async (c) => {
    try {
      const auth = await authorize(c, "inspect");
      const status = optionalAttentionStatus(c.req.query("status"));
      const workerRunId = optionalString(c.req.query("workerRunId"), "workerRunId");
      const limit = optionalLimit(c.req.query("limit"));
      const data = await readStore(loadStore);
      const attention = data.workerAttentionRequests
        .filter(
          (record) =>
            record.workspaceId === auth.workspaceId &&
            (status === undefined || record.status === status) &&
            (workerRunId === undefined || record.workerRunId === workerRunId),
        )
        .sort((left, right) => {
          const byRequestedAt = right.requestedAt.localeCompare(left.requestedAt);
          return byRequestedAt === 0 ? right.id.localeCompare(left.id) : byRequestedAt;
        })
        .slice(0, limit)
        .map((record) => projectAttention(data, record));
      return c.json({ attention });
    } catch (error) {
      return workerOperatorRouteError(c, error);
    }
  });

  routes.get("/attention/:attentionRequestId", async (c) => {
    try {
      const auth = await authorize(c, "inspect");
      const data = await readStore(loadStore);
      const attention = requireAttention(
        data,
        auth.workspaceId,
        requiredPathParameter(c, "attentionRequestId"),
      );
      return c.json({ attention: projectAttention(data, attention) });
    } catch (error) {
      return workerOperatorRouteError(c, error);
    }
  });

  routes.post("/runs/:workerRunId/pause", async (c) => {
    return executeRunControl(c, "pauseRun", control, loadStore, authorize);
  });

  routes.post("/runs/:workerRunId/resume", async (c) => {
    return executeRunControl(c, "resumeRun", control, loadStore, authorize);
  });

  routes.post("/runs/:workerRunId/stop", async (c) => {
    return executeRunControl(c, "stopRun", control, loadStore, authorize);
  });

  routes.post("/deployments/:workerDeploymentId/revoke", async (c) => {
    try {
      const auth = await authorize(c, "control_deployment");
      const body = await readObjectBody(c);
      assertAllowedFields(body, ["expectedRevision"]);
      const result = await control.revokeDeployment({
        ...controlContext(auth, c, body),
        workerDeploymentId: requiredPathParameter(c, "workerDeploymentId"),
      });
      return await controlResponse(c, loadStore, result);
    } catch (error) {
      return workerOperatorRouteError(c, error);
    }
  });

  routes.post("/attention/:attentionRequestId/approve-once", async (c) => {
    return executeAttentionControl(c, "approveOnce", control, loadStore, authorize);
  });

  routes.post("/attention/:attentionRequestId/approve-for-run", async (c) => {
    return executeAttentionControl(c, "approveForRun", control, loadStore, authorize);
  });

  routes.post("/attention/:attentionRequestId/reject", async (c) => {
    return executeAttentionControl(c, "rejectAttention", control, loadStore, authorize);
  });

  return routes;
}

type RunControlMethod = "pauseRun" | "resumeRun" | "stopRun";

async function executeRunControl(
  c: Context,
  method: RunControlMethod,
  control: WorkerControlService,
  loadStore: () => MaybePromise<PacketAgentData>,
  authorize: NonNullable<WorkerOperatorRoutesDependencies["authorize"]>,
) {
  try {
    const auth = await authorize(c, "control_run");
    const body = await readObjectBody(c);
    assertAllowedFields(body, ["expectedRevision"]);
    const result = await control[method]({
      ...controlContext(auth, c, body),
      workerRunId: requiredPathParameter(c, "workerRunId"),
    });
    return await controlResponse(c, loadStore, result);
  } catch (error) {
    return workerOperatorRouteError(c, error);
  }
}

type AttentionControlMethod = "approveOnce" | "approveForRun" | "rejectAttention";

async function executeAttentionControl(
  c: Context,
  method: AttentionControlMethod,
  control: WorkerControlService,
  loadStore: () => MaybePromise<PacketAgentData>,
  authorize: NonNullable<WorkerOperatorRoutesDependencies["authorize"]>,
) {
  try {
    const auth = await authorize(c, "approve");
    const body = await readObjectBody(c);
    assertAllowedFields(
      body,
      method === "rejectAttention" ? ["expectedRevision"] : ["expectedRevision", "expiresAt"],
    );
    const result = await control[method]({
      ...controlContext(auth, c, body),
      attentionRequestId: requiredPathParameter(c, "attentionRequestId"),
      ...(method === "rejectAttention"
        ? {}
        : {
            expiresAt: optionalTimestamp(body.expiresAt, "expiresAt"),
          }),
    });
    return await controlResponse(c, loadStore, result);
  } catch (error) {
    return workerOperatorRouteError(c, error);
  }
}

function controlContext(
  auth: AuthorizedWorkerOperatorContext,
  c: Context,
  body: Record<string, unknown>,
) {
  return {
    workspaceId: auth.workspaceId,
    actor: auth.actor,
    idempotencyKey: requireIdempotencyKey(c),
    expectedRevision: requiredRevision(body.expectedRevision),
  };
}

async function controlResponse(
  c: Context,
  loadStore: () => MaybePromise<PacketAgentData>,
  result: WorkerControlResult,
) {
  const data = await readStore(loadStore);
  const body = projectControlResult(data, result);
  if (result.approvalNonce) {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
  }
  if (result.command.status === "rejected") {
    return c.json(body, 409);
  }
  return c.json(body);
}

function projectControlResult(data: PacketAgentData, result: WorkerControlResult) {
  return {
    disposition: result.disposition,
    command: projectCommand(result.command),
    ...(result.run ? { run: projectRun(data, result.run) } : {}),
    ...(result.deployment ? { deployment: projectDeployment(result.deployment) } : {}),
    ...(result.attentionRequest
      ? { attention: projectAttention(data, result.attentionRequest) }
      : {}),
    ...(result.approvalGrant ? { approval: projectApproval(result.approvalGrant) } : {}),
    ...(result.approvalNonce ? { approvalNonce: result.approvalNonce } : {}),
    ...(result.executionJobId ? { executionJobId: result.executionJobId } : {}),
    ...(result.affectedRunIds ? { affectedRunIds: [...result.affectedRunIds] } : {}),
  };
}

function projectRun(data: PacketAgentData, run: WorkerRun): WorkerOperatorRunView {
  const attention = data.workerAttentionRequests
    .filter((record) => record.workspaceId === run.workspaceId && record.workerRunId === run.id)
    .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))
    .map((record) => projectAttention(data, record));
  return {
    id: run.id,
    workerDefinitionId: run.workerDefinitionId,
    workerDeploymentId: run.workerDeploymentId,
    workerVersionId: run.workerVersionId,
    status: run.status,
    revision: run.revision,
    attempt: run.attempt,
    budgetUsage: structuredClone(run.budgetUsage),
    ...(run.terminalReason ? { terminalReason: run.terminalReason } : {}),
    ...(run.latestCheckpointId ? { latestCheckpointId: run.latestCheckpointId } : {}),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    attention,
  };
}

function projectDeployment(deployment: WorkerDeployment) {
  return {
    id: deployment.id,
    workerDefinitionId: deployment.workerDefinitionId,
    workerVersionId: deployment.workerVersionId,
    status: deployment.status,
    revision: deployment.revision,
    ...(deployment.statusReason ? { statusReason: deployment.statusReason } : {}),
    createdAt: deployment.createdAt,
    updatedAt: deployment.updatedAt,
    ...(deployment.revokedAt ? { revokedAt: deployment.revokedAt } : {}),
  };
}

function projectAttention(
  data: PacketAgentData,
  attention: WorkerAttentionRequest,
): WorkerOperatorAttentionView {
  const run = requireRun(data, attention.workspaceId, attention.workerRunId);
  const operation = findOperationSummary(data.workerEvents, attention);
  return {
    id: attention.id,
    workerDefinitionId: attention.workerDefinitionId,
    workerDeploymentId: attention.workerDeploymentId,
    workerRunId: attention.workerRunId,
    workerVersionId: attention.workerVersionId,
    status: attention.status,
    runRevision: run.revision,
    capabilityId: attention.capabilityId,
    operationDigest: attention.operationDigest,
    ...(operation ? { operation } : {}),
    expirationDisposition: attention.expirationDisposition,
    requestedAt: attention.requestedAt,
    ...(attention.escalatesAt ? { escalatesAt: attention.escalatesAt } : {}),
    expiresAt: attention.expiresAt,
    ...(attention.resolvedAt ? { resolvedAt: attention.resolvedAt } : {}),
    ...(attention.resolvedBy ? { resolvedBy: structuredClone(attention.resolvedBy) } : {}),
  };
}

function findOperationSummary(
  events: readonly WorkerEvent[],
  attention: WorkerAttentionRequest,
): WorkerOperatorAttentionView["operation"] | undefined {
  const event = [...events]
    .reverse()
    .find(
      (candidate) =>
        candidate.workspaceId === attention.workspaceId &&
        candidate.workerDeploymentId === attention.workerDeploymentId &&
        (candidate.type === "worker.policy.denied" || candidate.type === "worker.policy.allowed") &&
        candidate.data?.workerRunId === attention.workerRunId &&
        candidate.data.operationDigest === attention.operationDigest &&
        candidate.data.capabilityId === attention.capabilityId,
    );
  const data = event?.data;
  if (
    typeof data?.tool !== "string" ||
    typeof data.verb !== "string" ||
    typeof data.effect !== "string" ||
    typeof data.resourceCount !== "number" ||
    !Number.isSafeInteger(data.resourceCount) ||
    data.resourceCount < 0 ||
    !Array.isArray(data.resourceSchemes) ||
    !data.resourceSchemes.every((value) => typeof value === "string")
  ) {
    return undefined;
  }
  return {
    tool: data.tool,
    verb: data.verb,
    effect: data.effect,
    resourceCount: data.resourceCount,
    resourceSchemes: data.resourceSchemes,
  };
}

function projectCommand(command: WorkerControlCommand) {
  return {
    id: command.id,
    kind: command.kind,
    status: command.status,
    expectedRevision: command.expectedRevision,
    createdAt: command.createdAt,
    updatedAt: command.updatedAt,
    ...(command.appliedAt ? { appliedAt: command.appliedAt } : {}),
    ...(command.appliedRevision ? { appliedRevision: command.appliedRevision } : {}),
    ...(command.rejectedAt ? { rejectedAt: command.rejectedAt } : {}),
    ...(command.rejectionCode ? { rejectionCode: command.rejectionCode } : {}),
  };
}

function projectApproval(grant: WorkerApprovalGrant) {
  return {
    id: grant.id,
    attentionRequestId: grant.attentionRequestId,
    scope: grant.scope,
    status: grant.status,
    grantedAt: grant.grantedAt,
    expiresAt: grant.expiresAt,
    ...(grant.consumedAt ? { consumedAt: grant.consumedAt } : {}),
  };
}

async function readStore(loadStore: () => MaybePromise<PacketAgentData>): Promise<PacketAgentData> {
  const data = await loadStore();
  validateWorkerPersistence(data);
  return data;
}

function requireRun(data: PacketAgentData, workspaceId: string, workerRunId: string): WorkerRun {
  const run = data.workerRuns.find(
    (record) => record.workspaceId === workspaceId && record.id === workerRunId,
  );
  if (!run) {
    throw new WorkerLifecycleError("not_found", `WorkerRun ${workerRunId} was not found.`);
  }
  return run;
}

function requireAttention(
  data: PacketAgentData,
  workspaceId: string,
  attentionRequestId: string,
): WorkerAttentionRequest {
  const attention = data.workerAttentionRequests.find(
    (record) => record.workspaceId === workspaceId && record.id === attentionRequestId,
  );
  if (!attention) {
    throw new WorkerLifecycleError(
      "not_found",
      `Worker attention request ${attentionRequestId} was not found.`,
    );
  }
  return attention;
}

async function authorizeWorkerOperatorRoute(
  context: Context,
  permission: WorkerOperatorPermission,
): Promise<AuthorizedWorkerOperatorContext> {
  const workspacePermission: Record<WorkerOperatorPermission, WorkspacePermission> = {
    inspect: "inspectWorkers",
    control_run: "controlWorkerRuns",
    control_deployment: "controlWorkerDeployments",
    approve: "approveWorkerActions",
  };
  const auth = await requirePrivateWorkspacePermissionAsync(
    context,
    workspacePermission[permission],
  );
  return {
    workspaceId: auth.workspace.id,
    actor: {
      type: "user",
      id: auth.user.id,
      ...(auth.user.displayName ? { displayName: auth.user.displayName } : {}),
    },
  };
}

async function readObjectBody(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw invalidRequest("request body must be application/json.");
  }
  try {
    const body: unknown = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw invalidRequest("request body must be a JSON object.");
    }
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof WorkerLifecycleError) throw error;
    throw invalidRequest("request body must be valid JSON.");
  }
}

function requireIdempotencyKey(c: Context): string {
  const value = c.req.header("Idempotency-Key")?.trim() ?? "";
  if (!value) throw invalidRequest("Idempotency-Key header is required.");
  if (value.length > 256) {
    throw invalidRequest("Idempotency-Key header must be at most 256 characters.");
  }
  return value;
}

function requiredPathParameter(c: Context, name: string): string {
  return requiredString(c.req.param(name), name);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalidRequest(`${name} is required.`);
  }
  return value.trim();
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw invalidRequest(`${name} must be a non-empty string when supplied.`);
  }
  return value.trim();
}

function optionalTimestamp(value: unknown, name: string): string | undefined {
  const timestamp = optionalString(value, name);
  if (timestamp === undefined) return undefined;
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== timestamp) {
    throw invalidRequest(`${name} must be a canonical UTC ISO-8601 timestamp.`);
  }
  return timestamp;
}

function requiredRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw invalidRequest("expectedRevision must be a positive integer.");
  }
  return value as number;
}

function assertAllowedFields(
  body: Record<string, unknown>,
  allowedFields: readonly string[],
): void {
  const allowed = new Set(allowedFields);
  const unexpected = Object.keys(body).filter((field) => !allowed.has(field));
  if (unexpected.length > 0) {
    throw invalidRequest(`unexpected request field: ${unexpected.sort().join(", ")}.`);
  }
}

function optionalAttentionStatus(
  value: string | undefined,
): WorkerAttentionRequestStatus | undefined {
  if (value === undefined || value === "") return undefined;
  if (!["open", "approved", "rejected", "expired", "cancelled"].includes(value)) {
    throw invalidRequest("status must be open, approved, rejected, expired, or cancelled.");
  }
  return value as WorkerAttentionRequestStatus;
}

function optionalLimit(value: string | undefined): number {
  if (value === undefined || value === "") return 50;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw invalidRequest("limit must be an integer between 1 and 200.");
  }
  return limit;
}

function invalidRequest(message: string): WorkerLifecycleError {
  return new WorkerLifecycleError("invalid_input", message);
}

function workerOperatorRouteError(c: Context, error: unknown) {
  const status = (error as Error & { status?: number }).status ?? 500;
  c.status(status as 400 | 403 | 404 | 409 | 500);
  return c.json({
    error: redactedErrorMessage(error),
    ...(error instanceof WorkerLifecycleError ? { code: error.code } : {}),
  });
}

export const workerOperatorRoutes = createWorkerOperatorRoutes();
