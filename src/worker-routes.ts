import { Hono, type Context } from "hono";
import { requirePrivateWorkspaceRoleAsync } from "./rbac.js";
import { redactedErrorMessage } from "./security/redaction.js";
import { createWorkerLifecycleService, type WorkerLifecycleService } from "./workers/service.js";
import type {
  WorkerActorReference,
  WorkerSourceProvenance,
  WorkerVersionContent,
} from "./workers/types.js";
import { WorkerLifecycleError } from "./workers/errors.js";

type WorkerRouteRole = "viewer" | "member" | "admin";

export interface AuthorizedWorkerRouteContext {
  readonly workspaceId: string;
  readonly actor: WorkerActorReference;
}

export interface WorkerRoutesDependencies {
  readonly service?: WorkerLifecycleService;
  readonly authorize?: (
    context: Context,
    minimumRole: WorkerRouteRole,
  ) => Promise<AuthorizedWorkerRouteContext>;
}

export function createWorkerRoutes(dependencies: WorkerRoutesDependencies = {}): Hono {
  const routes = new Hono();
  const service = dependencies.service ?? createWorkerLifecycleService();
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
