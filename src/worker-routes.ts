import { Hono, type Context } from "hono";
import { requirePrivateWorkspaceRoleAsync } from "./rbac.js";
import { redactedErrorMessage } from "./security/redaction.js";
import { createWorkerLifecycleService, type WorkerLifecycleService } from "./workers/service.js";
import type {
  WorkerActorReference,
  WorkerDeploymentCapabilityGrant,
  WorkerSourceProvenance,
  WorkerVersionContent,
} from "./workers/types.js";
import { WorkerLifecycleError } from "./workers/errors.js";
import {
  createWorkerActivationService,
  workerTraceFromTraceparent,
  type WorkerActivationService,
} from "./workers/activation.js";
import type { JsonObject } from "./workers/types.js";

type WorkerRouteRole = "viewer" | "member" | "admin";

export interface AuthorizedWorkerRouteContext {
  readonly workspaceId: string;
  readonly actor: WorkerActorReference;
}

export interface WorkerRoutesDependencies {
  readonly service?: WorkerLifecycleService;
  readonly activationService?: WorkerActivationService;
  readonly authorize?: (
    context: Context,
    minimumRole: WorkerRouteRole,
  ) => Promise<AuthorizedWorkerRouteContext>;
}

export function createWorkerRoutes(dependencies: WorkerRoutesDependencies = {}): Hono {
  const routes = new Hono();
  const service = dependencies.service ?? createWorkerLifecycleService();
  const activationService =
    dependencies.activationService ?? createWorkerActivationService();
  const authorize = dependencies.authorize ?? authorizeWorkerRoute;

  routes.get("/definitions", async (c) => {
    try {
      const auth = await authorize(c, "viewer");
      return c.json({ definitions: await service.listDefinitions(auth.workspaceId) });
    } catch (error) {
      return workerRouteError(c, error);
    }
  });

  routes.post("/definitions", async (c) => {
    try {
      const auth = await authorize(c, "member");
      const body = await readObjectBody(c);
      const response = await service.createDefinition({
        ...commandContext(auth, requireIdempotencyKey(c)),
        definitionId: optionalString(body.definitionId, "definitionId"),
        versionId: optionalString(body.versionId, "versionId"),
        name: requiredString(body.name, "name"),
        description: requiredString(body.description, "description"),
        content: requiredObject(body.content, "content") as unknown as WorkerVersionContent,
        source: requiredObject(body.source, "source") as unknown as WorkerSourceProvenance,
      });
      return c.json(response, 201);
    } catch (error) {
      return workerRouteError(c, error);
    }
  });

  routes.get("/definitions/:workerDefinitionId", async (c) => {
    try {
      const auth = await authorize(c, "viewer");
      return c.json(
        await service.getDefinition(
          auth.workspaceId,
          requiredPathParameter(c, "workerDefinitionId"),
        ),
      );
    } catch (error) {
      return workerRouteError(c, error);
    }
  });

  routes.post("/definitions/:workerDefinitionId/versions", async (c) => {
    try {
      const auth = await authorize(c, "member");
      const body = await readObjectBody(c);
      return c.json(
        await service.createVersion({
          ...commandContext(auth, requireIdempotencyKey(c)),
          workerDefinitionId: requiredPathParameter(c, "workerDefinitionId"),
          versionId: optionalString(body.versionId, "versionId"),
          content: requiredObject(body.content, "content") as unknown as WorkerVersionContent,
          source: requiredObject(body.source, "source") as unknown as WorkerSourceProvenance,
        }),
        201,
      );
    } catch (error) {
      return workerRouteError(c, error);
    }
  });

  routes.post("/definitions/:workerDefinitionId/retire", async (c) => {
    try {
      const auth = await authorize(c, "admin");
      const body = await readObjectBody(c);
      return c.json(
        await service.retireDefinition({
          ...commandContext(auth, requireIdempotencyKey(c)),
          workerDefinitionId: requiredPathParameter(c, "workerDefinitionId"),
          expectedUpdatedAt: requiredString(body.expectedUpdatedAt, "expectedUpdatedAt"),
        }),
      );
    } catch (error) {
      return workerRouteError(c, error);
    }
  });

  routes.get("/versions/:workerVersionId", async (c) => {
    try {
      const auth = await authorize(c, "viewer");
      return c.json(
        await service.getVersion(auth.workspaceId, requiredPathParameter(c, "workerVersionId")),
      );
    } catch (error) {
      return workerRouteError(c, error);
    }
  });

  routes.patch("/versions/:workerVersionId", async (c) => {
    try {
      const auth = await authorize(c, "member");
      const body = await readObjectBody(c);
      return c.json(
        await service.updateDraftVersion({
          ...commandContext(auth, requireIdempotencyKey(c)),
          workerVersionId: requiredPathParameter(c, "workerVersionId"),
          expectedContentDigest: requiredString(
            body.expectedContentDigest,
            "expectedContentDigest",
          ),
          content: requiredObject(body.content, "content") as unknown as WorkerVersionContent,
        }),
      );
    } catch (error) {
      return workerRouteError(c, error);
    }
  });

  routes.post("/versions/:workerVersionId/validate", async (c) => {
    return changeVersionStatus(c, service, authorize, "validate");
  });

  routes.post("/versions/:workerVersionId/reject", async (c) => {
    return changeVersionStatus(c, service, authorize, "reject");
  });

  routes.post("/deployments", async (c) => {
    try {
      const auth = await authorize(c, "member");
      const body = await readObjectBody(c);
      return c.json(
        await service.createDeployment({
          ...commandContext(auth, requireIdempotencyKey(c)),
          deploymentId: optionalString(body.deploymentId, "deploymentId"),
          workerVersionId: requiredString(body.workerVersionId, "workerVersionId"),
          capabilityGrants: optionalCapabilityGrants(body.capabilityGrants),
        }),
        201,
      );
    } catch (error) {
      return workerRouteError(c, error);
    }
  });

  routes.get("/deployments/:workerDeploymentId", async (c) => {
    try {
      const auth = await authorize(c, "viewer");
      return c.json(
        await service.getDeployment(
          auth.workspaceId,
          requiredPathParameter(c, "workerDeploymentId"),
        ),
      );
    } catch (error) {
      return workerRouteError(c, error);
    }
  });

  routes.post("/deployments/:workerDeploymentId/runs", async (c) => {
    try {
      const auth = await authorize(c, "member");
      const body = await readObjectBody(c);
      const result = await activationService.admit({
        workspaceId: auth.workspaceId,
        workerDeploymentId: requiredPathParameter(c, "workerDeploymentId"),
        triggerId: optionalString(body.triggerId, "triggerId") ?? "manual",
        source: "manual",
        deliveryId: requireIdempotencyKey(c),
        occurredAt: optionalTimestamp(body.occurredAt, "occurredAt"),
        actor: auth.actor,
        payload:
          body.input === undefined
            ? {}
            : (requiredObject(body.input, "input") as JsonObject),
        trace: workerTraceFromTraceparent(
          c.req.header("traceparent"),
          c.req.header("tracestate"),
        ),
      });
      return c.json(result, 202);
    } catch (error) {
      return workerRouteError(c, error);
    }
  });

  routes.post("/deployments/:workerDeploymentId/validate", async (c) => {
    return transitionDeployment(c, service, authorize, "member", "validateDeployment");
  });

  routes.post("/deployments/:workerDeploymentId/deploy", async (c) => {
    return transitionDeployment(c, service, authorize, "member", "deploy");
  });

  routes.post("/deployments/:workerDeploymentId/activate", async (c) => {
    return transitionDeployment(c, service, authorize, "admin", "activate");
  });

  routes.post("/deployments/:workerDeploymentId/pause", async (c) => {
    return transitionDeployment(c, service, authorize, "admin", "pause");
  });

  routes.post("/deployments/:workerDeploymentId/resume", async (c) => {
    return transitionDeployment(c, service, authorize, "admin", "resume");
  });

  routes.post("/deployments/:workerDeploymentId/retire", async (c) => {
    return transitionDeployment(c, service, authorize, "admin", "retireDeployment");
  });

  routes.post("/deployments/:workerDeploymentId/rollback", async (c) => {
    try {
      const auth = await authorize(c, "admin");
      const body = await readObjectBody(c);
      return c.json(
        await service.rollback({
          ...commandContext(auth, requireIdempotencyKey(c)),
          workerDeploymentId: requiredPathParameter(c, "workerDeploymentId"),
          expectedRevision: requiredRevision(body.expectedRevision),
          targetWorkerVersionId: requiredString(
            body.targetWorkerVersionId,
            "targetWorkerVersionId",
          ),
          replacementDeploymentId: optionalString(
            body.replacementDeploymentId,
            "replacementDeploymentId",
          ),
          statusReason: optionalString(body.statusReason, "statusReason"),
        }),
        201,
      );
    } catch (error) {
      return workerRouteError(c, error);
    }
  });

  routes.get("/events", async (c) => {
    try {
      const auth = await authorize(c, "viewer");
      return c.json({
        events: await service.listEvents(
          auth.workspaceId,
          optionalSequence(c.req.query("afterSequence")),
        ),
      });
    } catch (error) {
      return workerRouteError(c, error);
    }
  });

  routes.get("/activations", async (c) => {
    try {
      const auth = await authorize(c, "viewer");
      return c.json({
        activations: await activationService.listInboxes(auth.workspaceId, {
          workerDeploymentId: optionalString(
            c.req.query("workerDeploymentId"),
            "workerDeploymentId",
          ),
          limit: optionalLimit(c.req.query("limit")),
        }),
      });
    } catch (error) {
      return workerRouteError(c, error);
    }
  });

  return routes;
}

type WorkerRouteAuthorization = NonNullable<WorkerRoutesDependencies["authorize"]>;

async function changeVersionStatus(
  c: Context,
  service: WorkerLifecycleService,
  authorize: WorkerRouteAuthorization,
  operation: "validate" | "reject",
) {
  try {
    const auth = await authorize(c, "member");
    const body = await readObjectBody(c);
    const input = {
      ...commandContext(auth, requireIdempotencyKey(c)),
      workerVersionId: requiredPathParameter(c, "workerVersionId"),
      expectedContentDigest: requiredString(body.expectedContentDigest, "expectedContentDigest"),
    };
    return c.json(
      operation === "validate"
        ? await service.validateVersion(input)
        : await service.rejectVersion(input),
    );
  } catch (error) {
    return workerRouteError(c, error);
  }
}

type DeploymentTransitionMethod =
  | "validateDeployment"
  | "deploy"
  | "activate"
  | "pause"
  | "resume"
  | "retireDeployment";

async function transitionDeployment(
  c: Context,
  service: WorkerLifecycleService,
  authorize: WorkerRouteAuthorization,
  minimumRole: WorkerRouteRole,
  operation: DeploymentTransitionMethod,
) {
  try {
    const auth = await authorize(c, minimumRole);
    const body = await readObjectBody(c);
    return c.json(
      await service[operation]({
        ...commandContext(auth, requireIdempotencyKey(c)),
        workerDeploymentId: requiredPathParameter(c, "workerDeploymentId"),
        expectedRevision: requiredRevision(body.expectedRevision),
        statusReason: optionalString(body.statusReason, "statusReason"),
      }),
    );
  } catch (error) {
    return workerRouteError(c, error);
  }
}

async function authorizeWorkerRoute(
  context: Context,
  minimumRole: WorkerRouteRole,
): Promise<AuthorizedWorkerRouteContext> {
  const auth = await requirePrivateWorkspaceRoleAsync(context, minimumRole);
  return {
    workspaceId: auth.workspace.id,
    actor: {
      type: "user",
      id: auth.user.id,
      ...(auth.user.displayName ? { displayName: auth.user.displayName } : {}),
    },
  };
}

function commandContext(auth: AuthorizedWorkerRouteContext, idempotencyKey: string) {
  return {
    workspaceId: auth.workspaceId,
    actor: auth.actor,
    idempotencyKey,
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
  if (value.length > 256)
    throw invalidRequest("Idempotency-Key header must be at most 256 characters.");
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
  if (value === undefined || value === null) return undefined;
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

function optionalCapabilityGrants(
  value: unknown,
): readonly WorkerDeploymentCapabilityGrant[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw invalidRequest("capabilityGrants must be an array when supplied.");
  }
  return value.map((entry, index) => {
    const grant = requiredObject(entry, `capabilityGrants[${index}]`);
    if (!Array.isArray(grant.verbs) || !grant.verbs.every((verb) => typeof verb === "string")) {
      throw invalidRequest(`capabilityGrants[${index}].verbs must be an array of strings.`);
    }
    if (
      !Array.isArray(grant.resources) ||
      !grant.resources.every((resource) => typeof resource === "string")
    ) {
      throw invalidRequest(`capabilityGrants[${index}].resources must be an array of strings.`);
    }
    if (grant.approval !== "never" && grant.approval !== "always") {
      throw invalidRequest(`capabilityGrants[${index}].approval must be never or always.`);
    }
    return {
      capabilityId: requiredString(
        grant.capabilityId,
        `capabilityGrants[${index}].capabilityId`,
      ),
      verbs: grant.verbs,
      resources: grant.resources,
      approval: grant.approval,
    };
  });
}

function optionalLimit(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500) {
    throw invalidRequest("limit must be an integer between 1 and 500.");
  }
  return parsed;
}

function requiredObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidRequest(`${name} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function requiredRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw invalidRequest("expectedRevision must be a positive integer.");
  }
  return value as number;
}

function optionalSequence(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw invalidRequest("afterSequence must be a non-negative integer.");
  }
  return sequence;
}

function invalidRequest(message: string): WorkerLifecycleError {
  return new WorkerLifecycleError("invalid_input", message);
}

function workerRouteError(c: Context, error: unknown) {
  const status = (error as Error & { status?: number }).status ?? 500;
  c.status(status as 400 | 404 | 409 | 500);
  return c.json({
    error: redactedErrorMessage(error),
    ...(error instanceof WorkerLifecycleError ? { code: error.code } : {}),
  });
}

export const workerRoutes = createWorkerRoutes();
