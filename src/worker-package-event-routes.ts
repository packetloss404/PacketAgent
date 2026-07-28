import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { redactedErrorMessage } from "./security/redaction.js";
import { WorkerLifecycleError } from "./workers/errors.js";
import {
  PacketProductEventError,
  createPacketProductEventService,
  parsePacketProductCursorEtag,
  type PacketProductEventListInput,
  type PacketProductEventPage,
  type PacketProductEventScopeInput,
  type PacketProductEventService,
} from "./workers/package/events.js";
import { PacketProductTrustError } from "./workers/package/trust.js";

type MaybePromise<T> = T | Promise<T>;

const WORKSPACE_HEADER = "PacketAgent-Workspace-Id";
const DEFAULT_STREAM_DURATION_MS = 25_000;
const DEFAULT_STREAM_POLL_INTERVAL_MS = 1_000;
const DEFAULT_STREAM_EVENT_LIMIT = 500;
const STREAM_PAGE_LIMIT = 100;

export interface WorkerPackageEventRoutesDependencies {
  readonly service?: PacketProductEventService;
  readonly now?: () => number;
  readonly wait?: (durationMs: number) => MaybePromise<void>;
  readonly streamDurationMs?: number;
  readonly streamPollIntervalMs?: number;
  readonly streamEventLimit?: number;
}

export function createWorkerPackageEventRoutes(
  dependencies: WorkerPackageEventRoutesDependencies = {},
): Hono {
  const routes = new Hono();
  const service = dependencies.service ?? createPacketProductEventService();
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.wait ?? defaultWait;
  const streamDurationMs = boundedInteger(
    dependencies.streamDurationMs,
    DEFAULT_STREAM_DURATION_MS,
    1,
    60_000,
    "streamDurationMs",
  );
  const streamPollIntervalMs = boundedInteger(
    dependencies.streamPollIntervalMs,
    DEFAULT_STREAM_POLL_INTERVAL_MS,
    1,
    30_000,
    "streamPollIntervalMs",
  );
  const streamEventLimit = boundedInteger(
    dependencies.streamEventLimit,
    DEFAULT_STREAM_EVENT_LIMIT,
    1,
    2_000,
    "streamEventLimit",
  );

  registerEventStreamRoutes(routes, service, {
    kind: "deployment",
    listPath: "/worker-deployments/:workerDeploymentId/events",
    streamPath: "/worker-deployments/:workerDeploymentId/events/stream",
    acknowledgementPath: "/worker-deployments/:workerDeploymentId/events/cursor",
    now,
    wait,
    streamDurationMs,
    streamPollIntervalMs,
    streamEventLimit,
  });
  registerEventStreamRoutes(routes, service, {
    kind: "run",
    listPath: "/worker-runs/:workerRunId/events",
    streamPath: "/worker-runs/:workerRunId/events/stream",
    acknowledgementPath: "/worker-runs/:workerRunId/events/cursor",
    now,
    wait,
    streamDurationMs,
    streamPollIntervalMs,
    streamEventLimit,
  });

  routes.get("/worker-events/:eventId/evidence", async (c) => {
    try {
      return c.json(
        await service.getEvidence({
          ...readContext(c),
          eventId: requiredPathParameter(c, "eventId"),
        }),
      );
    } catch (error) {
      return packetProductEventRouteError(c, error);
    }
  });

  return routes;
}

interface StreamRouteOptions {
  readonly kind: "deployment" | "run";
  readonly listPath: string;
  readonly streamPath: string;
  readonly acknowledgementPath: string;
  readonly now: () => number;
  readonly wait: (durationMs: number) => MaybePromise<void>;
  readonly streamDurationMs: number;
  readonly streamPollIntervalMs: number;
  readonly streamEventLimit: number;
}

function registerEventStreamRoutes(
  routes: Hono,
  service: PacketProductEventService,
  options: StreamRouteOptions,
): void {
  routes.get(options.listPath, async (c) => {
    try {
      const page = await service.listEvents(eventListInput(c, options.kind));
      c.header("ETag", page.acknowledgement.etag);
      c.header("Cache-Control", "private, no-store");
      return c.json(page);
    } catch (error) {
      return packetProductEventRouteError(c, error);
    }
  });

  routes.get(options.streamPath, async (c) => {
    let initialPage: PacketProductEventPage;
    let initialInput: PacketProductEventListInput;
    try {
      initialInput = eventListInput(c, options.kind, true);
      initialPage = await service.listEvents(initialInput);
      c.header("ETag", initialPage.acknowledgement.etag);
    } catch (error) {
      return packetProductEventRouteError(c, error);
    }

    c.header("Cache-Control", "private, no-cache, no-store");
    c.header("X-Accel-Buffering", "no");
    const deadline = options.now() + options.streamDurationMs;

    return streamSSE(c, async (stream) => {
      let page = initialPage;
      let sent = 0;
      let cursor = page.events.at(-1)?.id ?? page.page.nextCursor ?? initialInput.cursor;
      let reason: "duration" | "event_limit" | "client_closed" = "duration";
      try {
        while (
          !c.req.raw.signal.aborted &&
          options.now() < deadline &&
          sent < options.streamEventLimit
        ) {
          for (const event of page.events) {
            if (sent >= options.streamEventLimit) break;
            await stream.writeSSE({
              id: event.id,
              event: event.type,
              data: JSON.stringify(event),
              retry: 3_000,
            });
            cursor = event.id;
            sent += 1;
          }
          if (sent >= options.streamEventLimit) {
            reason = "event_limit";
            break;
          }
          if (page.page.hasMore) {
            page = await service.listEvents({
              ...streamScope(initialInput),
              ...(cursor ? { cursor } : {}),
              resumeFromAcknowledgement: false,
              limit: Math.min(STREAM_PAGE_LIMIT, options.streamEventLimit - sent),
            });
            continue;
          }
          await stream.writeSSE({
            event: "packetagent.heartbeat",
            data: JSON.stringify({
              schemaVersion: "packetagent.packet-product-event-heartbeat/v1",
              cursor: cursor ?? null,
            }),
          });
          if (options.now() >= deadline) break;
          await options.wait(
            Math.min(options.streamPollIntervalMs, Math.max(deadline - options.now(), 1)),
          );
          page = await service.listEvents({
            ...streamScope(initialInput),
            ...(cursor ? { cursor } : {}),
            resumeFromAcknowledgement: false,
            limit: Math.min(STREAM_PAGE_LIMIT, options.streamEventLimit - sent),
          });
        }
        if (c.req.raw.signal.aborted) reason = "client_closed";
        if (!c.req.raw.signal.aborted) {
          await stream.writeSSE({
            event: "packetagent.stream.closed",
            data: JSON.stringify({
              schemaVersion: "packetagent.packet-product-event-stream-close/v1",
              cursor: cursor ?? null,
              reason,
            }),
          });
        }
      } catch (error) {
        if (!c.req.raw.signal.aborted) {
          await stream.writeSSE({
            event: "packetagent.stream.error",
            data: JSON.stringify({
              schemaVersion: "packetagent.packet-product-event-stream-error/v1",
              error: redactedErrorMessage(error),
            }),
          });
        }
      }
    });
  });

  routes.put(options.acknowledgementPath, async (c) => {
    try {
      const body = await readObjectBody(c);
      assertAllowedFields(body, ["cursor"]);
      const result = await service.acknowledge({
        ...eventScope(c, options.kind),
        cursor: requiredString(body.cursor, "$.cursor"),
        idempotencyKey: requireHeader(c, "Idempotency-Key"),
        expectedRevision: parsePacketProductCursorEtag(c.req.header("if-match")),
      });
      c.header("ETag", result.cursor.etag);
      c.header("Cache-Control", "private, no-store");
      return c.json(result);
    } catch (error) {
      return packetProductEventRouteError(c, error);
    }
  });
}

function eventListInput(
  c: Context,
  kind: "deployment" | "run",
  sse = false,
): PacketProductEventListInput {
  const queryCursor = optionalQueryString(c, "cursor");
  const lastEventId = sse ? optionalHeader(c, "Last-Event-ID") : undefined;
  if (lastEventId && queryCursor && lastEventId !== queryCursor) {
    throw invalidInput(
      "$.headers.Last-Event-ID",
      "request.cursor_conflict",
      "Last-Event-ID and the cursor query parameter must match when both are supplied",
    );
  }
  const cursor = lastEventId ?? queryCursor;
  const from = optionalQueryString(c, "from");
  if (from !== undefined && from !== "beginning") {
    throw invalidInput("$.query.from", "request.event_origin", 'must be "beginning" when supplied');
  }
  if (cursor && from === "beginning") {
    throw invalidInput(
      "$.query.from",
      "request.cursor_conflict",
      "cannot be combined with an explicit event cursor",
    );
  }
  return {
    ...eventScope(c, kind),
    ...(cursor ? { cursor } : {}),
    resumeFromAcknowledgement: from !== "beginning",
    limit: optionalLimit(c),
  };
}

function eventScope(c: Context, kind: "deployment" | "run"): PacketProductEventScopeInput {
  return {
    ...readContext(c),
    ...(kind === "deployment"
      ? {
          workerDeploymentId: requiredPathParameter(c, "workerDeploymentId"),
        }
      : { workerRunId: requiredPathParameter(c, "workerRunId") }),
  };
}

function streamScope(input: PacketProductEventListInput): PacketProductEventScopeInput {
  return {
    authorization: input.authorization,
    workspaceId: input.workspaceId,
    ...(input.workerDeploymentId ? { workerDeploymentId: input.workerDeploymentId } : {}),
    ...(input.workerRunId ? { workerRunId: input.workerRunId } : {}),
  };
}

function readContext(c: Context) {
  return {
    authorization: c.req.header("authorization"),
    workspaceId: requireHeader(c, WORKSPACE_HEADER),
  };
}

function requireHeader(c: Context, name: string): string {
  const value = c.req.header(name)?.trim() ?? "";
  if (!value) {
    throw invalidInput(
      `$.headers.${name}`,
      "request.header_required",
      `${name} header is required`,
    );
  }
  if (value.length > 4_096) {
    throw invalidInput(
      `$.headers.${name}`,
      "request.header_too_long",
      `${name} header is too long`,
    );
  }
  return value;
}

function optionalHeader(c: Context, name: string): string | undefined {
  const value = c.req.header(name)?.trim();
  if (!value) return undefined;
  if (value.length > 4_096 || /[\u0000\r\n]/.test(value)) {
    throw invalidInput(`$.headers.${name}`, "request.invalid_header", `${name} header is invalid`);
  }
  return value;
}

function requiredPathParameter(c: Context, name: string): string {
  const value = c.req.param(name)?.trim();
  if (!value) {
    throw invalidInput(`$.path.${name}`, "request.path_required", "must be non-empty");
  }
  return value;
}

function optionalQueryString(c: Context, name: string): string | undefined {
  const value = c.req.query(name);
  if (value === undefined || value === "") return undefined;
  if (!value.trim()) {
    throw invalidInput(`$.query.${name}`, "request.non_empty_string", "must be non-empty");
  }
  return value.trim();
}

function optionalLimit(c: Context): number {
  const value = c.req.query("limit");
  if (value === undefined || value === "") return 100;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw invalidInput("$.query.limit", "request.limit", "must be an integer between 1 and 200");
  }
  return limit;
}

async function readObjectBody(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw invalidInput("$", "request.content_type", "request body must be application/json");
  }
  try {
    const value: unknown = await c.req.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw invalidInput("$", "request.object_required", "request body must be a JSON object");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof PacketProductTrustError) throw error;
    throw invalidInput("$", "request.invalid_json", "request body must be valid JSON");
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
    throw invalidInput(
      `$.${unexpected[0]}`,
      "request.unknown_field",
      `unexpected request field${unexpected.length === 1 ? "" : "s"}: ${unexpected.join(", ")}`,
    );
  }
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalidInput(path, "request.non_empty_string", "must be a non-empty string");
  }
  return value.trim();
}

function invalidInput(path: string, code: string, message: string): PacketProductTrustError {
  return new PacketProductTrustError(
    "invalid_input",
    "Packet-product event request is invalid.",
    400,
    { issues: [{ path, code, message }] },
  );
}

function packetProductEventRouteError(c: Context, error: unknown) {
  const status =
    error instanceof PacketProductEventError ||
    error instanceof PacketProductTrustError ||
    error instanceof WorkerLifecycleError
      ? error.status
      : 500;
  if (status === 401) {
    c.header("WWW-Authenticate", 'Bearer realm="PacketAgent Packet-product API"');
  }
  if (error instanceof PacketProductTrustError && error.options.retryAt) {
    c.header("Retry-After", new Date(error.options.retryAt).toUTCString());
  }
  c.status(status as 400 | 401 | 403 | 404 | 409 | 410 | 412 | 429 | 500);
  const message = redactedErrorMessage(error);
  const issues =
    error instanceof PacketProductTrustError
      ? error.options.issues?.map((issue) => ({
          ...issue,
          message: redactedErrorMessage(new Error(issue.message)),
        }))
      : error instanceof PacketProductEventError
        ? [{ path: "$", code: error.code, message }]
        : error instanceof WorkerLifecycleError
          ? [{ path: "$", code: error.code, message }]
          : undefined;
  return c.json({
    error: message,
    ...(error instanceof PacketProductEventError ||
    error instanceof PacketProductTrustError ||
    error instanceof WorkerLifecycleError
      ? { code: error.code }
      : {}),
    ...(issues ? { issues } : {}),
    ...(error instanceof PacketProductEventError && error.options.minimumCursor
      ? {
          minimumCursor: error.options.minimumCursor,
          minimumWorkspaceSequence: error.options.minimumWorkspaceSequence,
        }
      : {}),
  });
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return selected;
}

function defaultWait(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

export const workerPackageEventRoutes = createWorkerPackageEventRoutes();
