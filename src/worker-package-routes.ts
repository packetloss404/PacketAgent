import { Hono, type Context } from "hono";
import { redactedErrorMessage } from "./security/redaction.js";
import {
  createPacketProductDeploymentService,
  type PacketProductDeploymentControlInput,
  type PacketProductDeploymentService,
  type PacketProductPackageInput,
} from "./workers/package/deployment.js";
import { PacketProductTrustError } from "./workers/package/trust.js";
import { WorkerLifecycleError } from "./workers/errors.js";
import { workerTraceFromTraceparent } from "./workers/activation.js";
import type {
  JsonObject,
  WorkerDeploymentCapabilityGrant,
  WorkerRunStatus,
} from "./workers/types.js";

const WORKSPACE_HEADER = "PacketAgent-Workspace-Id";

export interface WorkerPackageRoutesDependencies {
  readonly service?: PacketProductDeploymentService;
}

export function createWorkerPackageRoutes(
  dependencies: WorkerPackageRoutesDependencies = {},
): Hono {
  const routes = new Hono();
  const service = dependencies.service ?? createPacketProductDeploymentService();

  routes.post("/worker-packages/validate", async (c) => {
    try {
      const body = await packageBody(c);
      return c.json(await service.validatePackage(packageInput(c, body)));
    } catch (error) {
      return packetProductRouteError(c, error);
    }
  });

  routes.post("/worker-deployments", async (c) => {
    try {
      const body = await packageBody(c);
      return c.json(await service.deployPackage(packageInput(c, body)), 201);
    } catch (error) {
      return packetProductRouteError(c, error);
    }
  });

  routes.put("/worker-deployments/:workerDeploymentId", async (c) => {
    try {
      const body = await readObjectBody(c);
      assertAllowedFields(body, [
        "workerPackage",
        "acceptedCapabilityIds",
        "capabilityGrants",
        "expectedRevision",
        "statusReason",
      ]);
      return c.json(
        await service.updatePackage({
          ...packageInput(c, body),
          workerDeploymentId: requiredPathParameter(c, "workerDeploymentId"),
          expectedRevision: requiredRevision(body.expectedRevision),
          ...(optionalString(body.statusReason, "$.statusReason")
            ? { statusReason: optionalString(body.statusReason, "$.statusReason") }
            : {}),
        }),
      );
    } catch (error) {
      return packetProductRouteError(c, error);
    }
  });

  routes.post("/worker-deployments/:workerDeploymentId/activate", async (c) => {
    try {
      const body = await readObjectBody(c);
      assertAllowedFields(body, [
        "expectedRevision",
        "statusReason",
        "startRun",
        "triggerId",
        "input",
      ]);
      const trace = workerTraceFromTraceparent(c.req.header("traceparent"));
      return c.json(
        await service.activate({
          ...controlInput(c, body),
          startRun: optionalBoolean(body.startRun, "$.startRun") ?? true,
          ...(optionalString(body.triggerId, "$.triggerId")
            ? { triggerId: optionalString(body.triggerId, "$.triggerId") }
            : {}),
          ...(body.input === undefined ? {} : { input: requiredJsonObject(body.input, "$.input") }),
          ...(trace ? { trace } : {}),
        }),
        202,
      );
    } catch (error) {
      return packetProductRouteError(c, error);
    }
  });

  routes.get("/worker-deployments/:workerDeploymentId", async (c) => {
    try {
      return c.json(
        await service.inspect({
          ...readContext(c),
          workerDeploymentId: requiredPathParameter(c, "workerDeploymentId"),
        }),
      );
    } catch (error) {
      return packetProductRouteError(c, error);
    }
  });

  routes.get("/worker-deployments/:workerDeploymentId/runs", async (c) => {
    try {
      return c.json(
        await service.listRuns(
          {
            ...readContext(c),
            workerDeploymentId: requiredPathParameter(c, "workerDeploymentId"),
          },
          {
            ...(optionalRunStatus(c.req.query("status")) !== undefined
              ? { status: optionalRunStatus(c.req.query("status")) }
              : {}),
            ...(optionalString(c.req.query("cursor"), "$.query.cursor")
              ? { cursor: optionalString(c.req.query("cursor"), "$.query.cursor") }
              : {}),
            limit: optionalLimit(c.req.query("limit")),
          },
        ),
      );
    } catch (error) {
      return packetProductRouteError(c, error);
    }
  });

  for (const operation of ["pause", "resume"] as const) {
    routes.post(`/worker-deployments/:workerDeploymentId/${operation}`, async (c) => {
      try {
        const body = await readObjectBody(c);
        assertAllowedFields(body, ["expectedRevision", "statusReason"]);
        return c.json(await service[operation](controlInput(c, body)));
      } catch (error) {
        return packetProductRouteError(c, error);
      }
    });
  }

  routes.post("/worker-deployments/:workerDeploymentId/rollback", async (c) => {
    try {
      const body = await readObjectBody(c);
      assertAllowedFields(body, ["expectedRevision", "targetPackageVersion", "statusReason"]);
      return c.json(
        await service.rollback({
          ...controlInput(c, body),
          targetPackageVersion: requiredPositiveInteger(
            body.targetPackageVersion,
            "$.targetPackageVersion",
          ),
        }),
      );
    } catch (error) {
      return packetProductRouteError(c, error);
    }
  });

  routes.post("/worker-deployments/:workerDeploymentId/revoke", async (c) => {
    try {
      const body = await readObjectBody(c);
      assertAllowedFields(body, ["expectedRevision"]);
      return c.json(await service.revoke(controlInput(c, body)));
    } catch (error) {
      return packetProductRouteError(c, error);
    }
  });

  return routes;
}

async function packageBody(c: Context): Promise<Record<string, unknown>> {
  const body = await readObjectBody(c);
  assertAllowedFields(body, ["workerPackage", "acceptedCapabilityIds", "capabilityGrants"]);
  return body;
}

function packageInput(c: Context, body: Record<string, unknown>): PacketProductPackageInput {
  const idempotencyKey = requireIdempotencyKey(c);
  const packageIdempotencyKey =
    body.workerPackage &&
    typeof body.workerPackage === "object" &&
    !Array.isArray(body.workerPackage) &&
    typeof (body.workerPackage as Record<string, unknown>).idempotencyKey === "string"
      ? ((body.workerPackage as Record<string, unknown>).idempotencyKey as string)
      : undefined;
  if (packageIdempotencyKey !== undefined && packageIdempotencyKey !== idempotencyKey) {
    throw invalidField(
      "$.headers.Idempotency-Key",
      "request.package_idempotency_mismatch",
      "must equal $.workerPackage.idempotencyKey",
    );
  }
  if (!Array.isArray(body.acceptedCapabilityIds)) {
    throw invalidField(
      "$.acceptedCapabilityIds",
      "request.array_required",
      "must explicitly contain the locally accepted capability IDs",
    );
  }
  if (!body.acceptedCapabilityIds.every((value) => typeof value === "string" && value.trim())) {
    throw invalidField(
      "$.acceptedCapabilityIds",
      "request.string_array",
      "must contain only non-empty strings",
    );
  }
  return {
    ...readContext(c),
    idempotencyKey,
    workerPackage: body.workerPackage,
    acceptedCapabilityIds: body.acceptedCapabilityIds as string[],
    capabilityGrants: optionalCapabilityGrants(body.capabilityGrants),
  };
}

function controlInput(
  c: Context,
  body: Record<string, unknown>,
): PacketProductDeploymentControlInput {
  const statusReason = optionalString(body.statusReason, "$.statusReason");
  return {
    ...writeContext(c),
    workerDeploymentId: requiredPathParameter(c, "workerDeploymentId"),
    expectedRevision: requiredRevision(body.expectedRevision),
    ...(statusReason ? { statusReason } : {}),
  };
}

function readContext(c: Context) {
  return {
    authorization: c.req.header("authorization"),
    workspaceId: requireWorkspaceId(c),
  };
}

function writeContext(c: Context) {
  return {
    ...readContext(c),
    idempotencyKey: requireIdempotencyKey(c),
  };
}

function requireWorkspaceId(c: Context): string {
  const value = c.req.header(WORKSPACE_HEADER)?.trim() ?? "";
  if (!value) {
    throw invalidField(
      `$.headers.${WORKSPACE_HEADER}`,
      "request.header_required",
      `${WORKSPACE_HEADER} header is required`,
    );
  }
  if (value.length > 256) {
    throw invalidField(
      `$.headers.${WORKSPACE_HEADER}`,
      "request.header_too_long",
      `${WORKSPACE_HEADER} header must be at most 256 characters`,
    );
  }
  return value;
}

function requireIdempotencyKey(c: Context): string {
  const value = c.req.header("Idempotency-Key")?.trim() ?? "";
  if (!value) {
    throw invalidField(
      "$.headers.Idempotency-Key",
      "request.header_required",
      "Idempotency-Key header is required",
    );
  }
  if (value.length > 256) {
    throw invalidField(
      "$.headers.Idempotency-Key",
      "request.header_too_long",
      "Idempotency-Key header must be at most 256 characters",
    );
  }
  return value;
}

async function readObjectBody(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw invalidField("$", "request.content_type", "request body must be application/json");
  }
  try {
    const value: unknown = await c.req.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw invalidField("$", "request.object_required", "request body must be a JSON object");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof PacketProductTrustError) throw error;
    throw invalidField("$", "request.invalid_json", "request body must be valid JSON");
  }
}

function assertAllowedFields(
  body: Record<string, unknown>,
  allowedFields: readonly string[],
): void {
  const allowed = new Set(allowedFields);
  const unexpected = Object.keys(body)
    .filter((field) => !allowed.has(field))
    .sort();
  if (unexpected.length > 0) {
    throw invalidField(
      `$.${unexpected[0]}`,
      "request.unknown_field",
      `unexpected request field${unexpected.length === 1 ? "" : "s"}: ${unexpected.join(", ")}`,
    );
  }
}

function optionalCapabilityGrants(
  value: unknown,
): readonly WorkerDeploymentCapabilityGrant[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw invalidField("$.capabilityGrants", "request.array_required", "must be an array");
  }
  return value as WorkerDeploymentCapabilityGrant[];
}

function requiredJsonObject(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidField(path, "request.object_required", "must be a JSON object");
  }
  try {
    JSON.stringify(value);
  } catch {
    throw invalidField(path, "request.json_value", "must contain only JSON values");
  }
  return value as JsonObject;
}

function requiredPathParameter(c: Context, name: string): string {
  const value = c.req.param(name)?.trim();
  if (!value) {
    throw invalidField(`$.path.${name}`, "request.path_required", "must be non-empty");
  }
  return value;
}

function requiredRevision(value: unknown): number {
  return requiredPositiveInteger(value, "$.expectedRevision");
}

function requiredPositiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw invalidField(path, "request.positive_integer", "must be a positive integer");
  }
  return value as number;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw invalidField(path, "request.non_empty_string", "must be a non-empty string");
  }
  return value.trim();
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw invalidField(path, "request.boolean", "must be a boolean");
  }
  return value;
}

function optionalLimit(value: string | undefined): number {
  if (value === undefined || value === "") return 50;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw invalidField("$.query.limit", "request.limit", "must be an integer between 1 and 200");
  }
  return limit;
}

function optionalRunStatus(value: string | undefined): WorkerRunStatus | undefined {
  if (value === undefined || value === "") return undefined;
  if (
    ![
      "queued",
      "running",
      "waiting_for_approval",
      "paused",
      "completed",
      "failed",
      "budget_exhausted",
      "cancelled",
      "quarantined",
    ].includes(value)
  ) {
    throw invalidField("$.query.status", "request.run_status", "is not a supported run status");
  }
  return value as WorkerRunStatus;
}

function invalidField(path: string, code: string, message: string): PacketProductTrustError {
  return new PacketProductTrustError("invalid_input", "Packet-product request is invalid.", 400, {
    issues: [{ path, code, message }],
  });
}

function packetProductRouteError(c: Context, error: unknown) {
  const status =
    error instanceof PacketProductTrustError || error instanceof WorkerLifecycleError
      ? error.status
      : 500;
  if (status === 401) {
    c.header("WWW-Authenticate", 'Bearer realm="PacketAgent Packet-product API"');
  }
  if (error instanceof PacketProductTrustError && error.options.retryAt) {
    c.header("Retry-After", new Date(error.options.retryAt).toUTCString());
  }
  c.status(status as 400 | 401 | 403 | 404 | 409 | 429 | 500);
  const message = redactedErrorMessage(error);
  const issues =
    error instanceof PacketProductTrustError
      ? error.options.issues?.map((issue) => ({
          ...issue,
          message: redactedErrorMessage(new Error(issue.message)),
        }))
      : error instanceof WorkerLifecycleError
        ? [{ path: "$", code: error.code, message }]
        : undefined;
  return c.json({
    error: message,
    ...(error instanceof PacketProductTrustError || error instanceof WorkerLifecycleError
      ? { code: error.code }
      : {}),
    ...(issues ? { issues } : {}),
  });
}

export const workerPackageRoutes = createWorkerPackageRoutes();
