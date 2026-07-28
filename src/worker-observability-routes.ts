import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { requirePrivateWorkspacePermissionAsync } from "./rbac.js";
import { redactedErrorMessage } from "./security/redaction.js";
import type {
  AuthorizedWorkerOperatorContext,
  WorkerOperatorPermission,
} from "./worker-operator-routes.js";
import { WorkerLifecycleError } from "./workers/errors.js";
import type { WorkerEventSource } from "./workers/persistence-types.js";
import {
  createWorkerOperationsReadModel,
  type WorkerArtifactListFilters,
  type WorkerEventListFilters,
  type WorkerEvidenceListFilters,
  type WorkerOperationsReadModel,
} from "./workers/observability/read-model.js";
import type {
  WorkerEvidenceRedactionClassification,
  WorkerEvidenceSourceKind,
} from "./workers/observability/types.js";
import type { WorkerRunStatus } from "./workers/types.js";

type MaybePromise<T> = T | Promise<T>;

const DEFAULT_STREAM_DURATION_MS = 25_000;
const DEFAULT_STREAM_POLL_INTERVAL_MS = 1_000;
const DEFAULT_STREAM_EVENT_LIMIT = 500;
const STREAM_PAGE_LIMIT = 100;

const RUN_STATUSES: readonly WorkerRunStatus[] = [
  "queued",
  "running",
  "waiting_for_approval",
  "paused",
  "completed",
  "failed",
  "budget_exhausted",
  "cancelled",
  "quarantined",
];
const EVENT_SOURCES: readonly WorkerEventSource[] = [
  "lifecycle",
  "activation",
  "queue",
  "supervisor",
  "provider",
  "tool",
  "effect",
  "approval",
  "checkpoint",
  "control",
  "recovery",
  "retention",
  "terminal",
];
const CLASSIFICATIONS: readonly WorkerEvidenceRedactionClassification[] = [
  "public_metadata",
  "internal",
  "sensitive_reference",
];
const EVIDENCE_SOURCE_KINDS: readonly WorkerEvidenceSourceKind[] = [
  "worker_event",
  "activation_inbox",
  "execution_job",
  "provider_call",
  "tool_call",
  "effect_receipt",
  "checkpoint",
  "attention_request",
  "approval_grant",
  "control_command",
];

export interface WorkerObservabilityRoutesDependencies {
  readonly readModel?: WorkerOperationsReadModel;
  readonly authorize?: (
    context: Context,
    permission: WorkerOperatorPermission,
  ) => Promise<AuthorizedWorkerOperatorContext>;
  readonly now?: () => number;
  readonly wait?: (durationMs: number) => MaybePromise<void>;
  readonly streamDurationMs?: number;
  readonly streamPollIntervalMs?: number;
  readonly streamEventLimit?: number;
}

export function createWorkerObservabilityRoutes(
  dependencies: WorkerObservabilityRoutesDependencies = {},
): Hono {
  const routes = new Hono();
  const readModel = dependencies.readModel ?? createWorkerOperationsReadModel();
  const authorize = dependencies.authorize ?? authorizeWorkerObservabilityRoute;
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

  routes.get("/health", async (c) => {
    try {
      const auth = await authorize(c, "inspect");
      return c.json({ health: await readModel.health(auth.workspaceId) });
    } catch (error) {
      return routeError(c, error);
    }
  });

  routes.get("/runs", async (c) => {
    try {
      const auth = await authorize(c, "inspect");
      return c.json(
        await readModel.listRuns(auth.workspaceId, {
          status: optionalEnum(c.req.query("status"), "status", RUN_STATUSES),
          workerDefinitionId: optionalQueryString(c, "workerDefinitionId"),
          workerVersionId: optionalQueryString(c, "workerVersionId"),
          workerDeploymentId: optionalQueryString(c, "workerDeploymentId"),
          cursor: optionalCursor(c),
          limit: optionalLimit(c),
        }),
      );
    } catch (error) {
      return routeError(c, error);
    }
  });

  routes.get("/runs/:workerRunId/detail", async (c) => {
    try {
      const auth = await authorize(c, "inspect");
      const detail = await readModel.getRun(
        auth.workspaceId,
        requiredPathParameter(c, "workerRunId"),
        optionalLimit(c),
      );
      return c.json({ detail });
    } catch (error) {
      return routeError(c, error);
    }
  });

  routes.get("/events", async (c) => {
    try {
      const auth = await authorize(c, "inspect");
      return c.json(await readModel.listEvents(auth.workspaceId, eventFilters(c)));
    } catch (error) {
      return routeError(c, error);
    }
  });

  routes.get("/evidence", async (c) => {
    try {
      const auth = await authorize(c, "inspect");
      const filters: WorkerEvidenceListFilters = {
        workerDeploymentId: optionalQueryString(c, "workerDeploymentId"),
        workerRunId: optionalQueryString(c, "workerRunId"),
        classification: optionalEnum(
          c.req.query("classification"),
          "classification",
          CLASSIFICATIONS,
        ),
        sourceKind: optionalEnum(c.req.query("sourceKind"), "sourceKind", EVIDENCE_SOURCE_KINDS),
        afterSequence: optionalNonNegativeInteger(c.req.query("afterSequence"), "afterSequence"),
        cursor: optionalCursor(c),
        limit: optionalLimit(c),
      };
      return c.json(await readModel.listEvidence(auth.workspaceId, filters));
    } catch (error) {
      return routeError(c, error);
    }
  });

  routes.get("/artifacts", async (c) => {
    try {
      const auth = await authorize(c, "inspect");
      const filters: WorkerArtifactListFilters = {
        workerDeploymentId: optionalQueryString(c, "workerDeploymentId"),
        workerRunId: optionalQueryString(c, "workerRunId"),
        classification: optionalEnum(
          c.req.query("classification"),
          "classification",
          CLASSIFICATIONS,
        ),
        cursor: optionalCursor(c),
        limit: optionalLimit(c),
      };
      return c.json(await readModel.listArtifacts(auth.workspaceId, filters));
    } catch (error) {
      return routeError(c, error);
    }
  });

  routes.get("/events/stream", async (c) => {
    let auth: AuthorizedWorkerOperatorContext;
    let filters: WorkerEventListFilters;
    try {
      auth = await authorize(c, "inspect");
      filters = eventFilters(c);
      if (filters.cursor) {
        throw invalidRequest(
          "SSE resume uses Last-Event-ID or afterSequence; use cursor with the paginated event endpoint.",
        );
      }
      const lastEventId = optionalNonNegativeInteger(
        c.req.header("last-event-id"),
        "Last-Event-ID",
      );
      if (lastEventId !== undefined) {
        filters = { ...filters, afterSequence: lastEventId, cursor: undefined };
      }
    } catch (error) {
      return routeError(c, error);
    }

    c.header("Cache-Control", "no-cache, no-store");
    c.header("X-Accel-Buffering", "no");
    const deadline = now() + streamDurationMs;

    return streamSSE(c, async (stream) => {
      let sent = 0;
      let afterSequence = filters.afterSequence ?? 0;
      let reason: "duration" | "event_limit" | "client_closed" = "duration";
      try {
        while (!c.req.raw.signal.aborted && now() < deadline && sent < streamEventLimit) {
          const remaining = streamEventLimit - sent;
          const page = await readModel.listEvents(auth.workspaceId, {
            ...filters,
            afterSequence,
            cursor: undefined,
            limit: Math.min(STREAM_PAGE_LIMIT, remaining),
          });
          for (const event of page.events) {
            await stream.writeSSE({
              id: String(event.sequence),
              event: "worker.event",
              data: JSON.stringify(event),
              retry: 3_000,
            });
            afterSequence = event.sequence;
            sent += 1;
          }
          if (sent >= streamEventLimit) {
            reason = "event_limit";
            break;
          }
          if (page.page.hasMore) continue;
          await stream.writeSSE({
            event: "worker.heartbeat",
            data: JSON.stringify({ afterSequence }),
          });
          if (now() >= deadline) break;
          await wait(Math.min(streamPollIntervalMs, Math.max(deadline - now(), 1)));
        }
        if (c.req.raw.signal.aborted) reason = "client_closed";
        if (!c.req.raw.signal.aborted) {
          await stream.writeSSE({
            event: "worker.stream.closed",
            data: JSON.stringify({ afterSequence, reason }),
          });
        }
      } catch (error) {
        if (!c.req.raw.signal.aborted) {
          await stream.writeSSE({
            event: "worker.stream.error",
            data: JSON.stringify({ error: redactedErrorMessage(error) }),
          });
        }
      }
    });
  });

  return routes;
}

function eventFilters(c: Context): WorkerEventListFilters {
  return {
    workerDeploymentId: optionalQueryString(c, "workerDeploymentId"),
    workerRunId: optionalQueryString(c, "workerRunId"),
    source: optionalEnum(c.req.query("source"), "source", EVENT_SOURCES),
    type: optionalQueryString(c, "type"),
    afterSequence: optionalNonNegativeInteger(c.req.query("afterSequence"), "afterSequence"),
    cursor: optionalCursor(c),
    limit: optionalLimit(c),
  };
}

async function authorizeWorkerObservabilityRoute(
  context: Context,
  _permission: WorkerOperatorPermission,
): Promise<AuthorizedWorkerOperatorContext> {
  const auth = await requirePrivateWorkspacePermissionAsync(context, "inspectWorkers");
  return {
    workspaceId: auth.workspace.id,
    actor: {
      type: "user",
      id: auth.user.id,
      ...(auth.user.displayName ? { displayName: auth.user.displayName } : {}),
    },
  };
}

function requiredPathParameter(c: Context, name: string): string {
  const value = c.req.param(name)?.trim();
  if (!value) throw invalidRequest(`${name} is required.`);
  return value;
}

function optionalQueryString(c: Context, name: string): string | undefined {
  const value = c.req.query(name);
  if (value === undefined || value === "") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256) {
    throw invalidRequest(`${name} must be a non-empty string of at most 256 characters.`);
  }
  return trimmed;
}

function optionalCursor(c: Context): string | undefined {
  const cursor = c.req.query("cursor");
  if (cursor === undefined || cursor === "") return undefined;
  if (cursor.length > 4_096) throw invalidRequest("cursor is too long.");
  return cursor;
}

function optionalLimit(c: Context): number | undefined {
  return optionalBoundedInteger(c.req.query("limit"), "limit", 1, 200);
}

function optionalNonNegativeInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^\d+$/.test(value)) {
    throw invalidRequest(`${name} must be a non-negative integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw invalidRequest(`${name} must be a non-negative safe integer.`);
  }
  return parsed;
}

function optionalBoundedInteger(
  value: string | undefined,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^\d+$/.test(value)) {
    throw invalidRequest(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw invalidRequest(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function optionalEnum<T extends string>(
  value: string | undefined,
  name: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined || value === "") return undefined;
  if (!allowed.includes(value as T)) {
    throw invalidRequest(`${name} is invalid.`);
  }
  return value as T;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return selected;
}

function invalidRequest(message: string): WorkerLifecycleError {
  return new WorkerLifecycleError("invalid_input", message);
}

function routeError(c: Context, error: unknown) {
  const status = (error as Error & { status?: number }).status ?? 500;
  c.status(status as 400 | 403 | 404 | 409 | 500);
  return c.json({
    error: redactedErrorMessage(error),
    ...(error instanceof WorkerLifecycleError ? { code: error.code } : {}),
  });
}

function defaultWait(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

export const workerObservabilityRoutes = createWorkerObservabilityRoutes();
