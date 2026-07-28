import { createHash, randomUUID } from "node:crypto";
import {
  loadStoreAsync as defaultLoadStore,
  mutateStoreAsync as defaultMutateStore,
  type PacketAgentData,
} from "../../packetagent-store.js";
import { WorkerLifecycleError } from "../errors.js";
import {
  createWorkerOperationsReadModel,
  type WorkerOperationsReadModel,
} from "../observability/read-model.js";
import { isWorkerEventV2 } from "../observability/journal.js";
import type { WorkerEvidenceEntry } from "../observability/types.js";
import type { WorkerEvent } from "../persistence-types.js";
import { validateWorkerPersistence } from "../repository.js";
import type { WorkerVersion } from "../types.js";
import { canonicalWorkerJson } from "../validation.js";
import {
  createPacketProductTrustService,
  type PacketProductAuthContext,
  type PacketProductTrustService,
} from "./trust.js";
import type { WorkerPackageDeploymentRecord } from "./trust-types.js";
import {
  PACKET_PRODUCT_EVENT_ACKNOWLEDGEMENT_SCHEMA_VERSION,
  PACKET_PRODUCT_EVENT_PAGE_SCHEMA_VERSION,
  PACKET_PRODUCT_WORKER_EVENT_SCHEMA_VERSION,
  assertValidPacketProductEventAcknowledgementRecord,
  type PacketProductEventAcknowledgementRecord,
  type PacketProductEventCursorState,
  type PacketProductEventStreamKind,
  type PacketProductWorkerEvent,
  type PacketProductWorkerEventType,
} from "./event-types.js";

type MaybePromise<T> = T | Promise<T>;

const EVENT_CURSOR_VERSION = 1;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 200;
const MAX_CURSOR_LENGTH = 4_096;

export type PacketProductEventErrorCode =
  | "invalid_cursor"
  | "cursor_expired"
  | "precondition_failed"
  | "not_found"
  | "invalid_input";

export class PacketProductEventError extends Error {
  constructor(
    readonly code: PacketProductEventErrorCode,
    message: string,
    readonly status: 400 | 404 | 410 | 412,
    readonly options: {
      readonly minimumCursor?: string;
      readonly minimumWorkspaceSequence?: number;
    } = {},
  ) {
    super(message);
    this.name = "PacketProductEventError";
  }
}

export interface PacketProductEventScopeInput {
  readonly authorization: string | null | undefined;
  readonly workspaceId: string;
  readonly workerDeploymentId?: string;
  readonly workerRunId?: string;
}

export interface PacketProductEventListInput extends PacketProductEventScopeInput {
  readonly cursor?: string;
  readonly resumeFromAcknowledgement?: boolean;
  readonly limit?: number;
}

export interface PacketProductEventPage {
  readonly schemaVersion: typeof PACKET_PRODUCT_EVENT_PAGE_SCHEMA_VERSION;
  readonly stream: {
    readonly kind: PacketProductEventStreamKind;
    readonly workerDeploymentId: string;
    readonly workerRunId?: string;
  };
  readonly events: readonly PacketProductWorkerEvent[];
  readonly page: {
    readonly hasMore: boolean;
    readonly limit: number;
    readonly nextCursor?: string;
    readonly cursorSource: "explicit" | "acknowledged" | "beginning";
  };
  readonly acknowledgement: PacketProductEventCursorState;
}

export interface PacketProductEventAcknowledgementResult {
  readonly record: PacketProductEventAcknowledgementRecord;
  readonly cursor: PacketProductEventCursorState;
  readonly replayed: boolean;
}

export interface PacketProductEventServiceDependencies {
  readonly trust?: PacketProductTrustService;
  readonly readModel?: WorkerOperationsReadModel;
  readonly loadStore?: () => MaybePromise<PacketAgentData>;
  readonly mutateStore?: <T>(
    mutation: (data: PacketAgentData) => MaybePromise<T>,
  ) => MaybePromise<T>;
  readonly now?: () => string;
  readonly id?: () => string;
}

export interface PacketProductEventService {
  listEvents(input: PacketProductEventListInput): Promise<PacketProductEventPage>;
  getEvidence(
    input: PacketProductEventScopeInput & {
      readonly eventId: string;
    },
  ): Promise<{
    readonly eventId: string;
    readonly evidence: WorkerEvidenceEntry;
  }>;
  acknowledge(
    input: PacketProductEventScopeInput & {
      readonly cursor: string;
      readonly idempotencyKey: string;
      readonly expectedRevision: number;
    },
  ): Promise<PacketProductEventAcknowledgementResult>;
}

export function createPacketProductEventService(
  dependencies: PacketProductEventServiceDependencies = {},
): PacketProductEventService {
  const loadStore = dependencies.loadStore ?? defaultLoadStore;
  const mutateStore = dependencies.mutateStore ?? defaultMutateStore;
  const trust = dependencies.trust ?? createPacketProductTrustService({ loadStore, mutateStore });
  const readModel =
    dependencies.readModel ??
    createWorkerOperationsReadModel({
      loadStore,
    });
  const now = dependencies.now ?? (() => new Date().toISOString());
  const id = dependencies.id ?? (() => `event_ack_${randomUUID()}`);

  async function listEvents(input: PacketProductEventListInput): Promise<PacketProductEventPage> {
    const auth = await trust.authenticate({
      authorization: input.authorization,
      workspaceId: input.workspaceId,
      operation: "run.list_events",
    });
    const data = await loadStore();
    validateWorkerPersistence(data);
    const scope = resolveScope(data, input);
    const acknowledgement = currentCursor(data, auth, scope);
    const explicitCursor = normalizeCursor(input.cursor);
    const selectedCursor =
      explicitCursor ??
      (input.resumeFromAcknowledgement === false ? undefined : acknowledgement.cursor);
    const cursorSource = explicitCursor
      ? "explicit"
      : selectedCursor
        ? "acknowledged"
        : "beginning";
    const afterSequence = selectedCursor
      ? resolveCursor(data, selectedCursor, scope).workspaceSequence
      : 0;
    const limit = pageLimit(input.limit);
    const page = await readModel.listEvents(input.workspaceId, {
      ...(scope.streamKind === "run"
        ? { workerRunId: scope.workerRunId }
        : { workerDeploymentId: scope.workerDeploymentId }),
      afterSequence,
      limit,
    });
    const events = page.events.map((event) => projectEvent(data, event, scope));
    return {
      schemaVersion: PACKET_PRODUCT_EVENT_PAGE_SCHEMA_VERSION,
      stream: streamIdentity(scope),
      events,
      page: {
        hasMore: page.page.hasMore,
        limit,
        ...((events.at(-1)?.id ?? selectedCursor)
          ? { nextCursor: events.at(-1)?.id ?? selectedCursor }
          : {}),
        cursorSource,
      },
      acknowledgement,
    };
  }

  async function getEvidence(
    input: PacketProductEventScopeInput & { readonly eventId: string },
  ): Promise<{ readonly eventId: string; readonly evidence: WorkerEvidenceEntry }> {
    await trust.authenticate({
      authorization: input.authorization,
      workspaceId: input.workspaceId,
      operation: "run.list_events",
    });
    const data = await loadStore();
    validateWorkerPersistence(data);
    const requested = decodeEventCursor(input.eventId);
    if (requested.workspaceId !== input.workspaceId) throw invalidCursor();
    const scope = resolveScope(data, {
      workspaceId: input.workspaceId,
      workerDeploymentId: requested.workerDeploymentId,
      ...(requested.workerRunId ? { workerRunId: requested.workerRunId } : {}),
    });
    const cursor = resolveCursor(data, input.eventId, scope);
    const event = data.workerEvents.find(
      (record) =>
        record.workspaceId === input.workspaceId &&
        record.id === cursor.sourceEventId &&
        record.sequence === cursor.workspaceSequence,
    );
    if (!event) {
      throw cursorExpired(data, scope);
    }
    if (!isWorkerEventV2(event)) {
      throw new PacketProductEventError(
        "not_found",
        "This legacy Packet-product event has no evidence envelope.",
        404,
      );
    }
    const evidencePage = await readModel.listEvidence(input.workspaceId, {
      ...(scope.streamKind === "run"
        ? { workerRunId: scope.workerRunId }
        : { workerDeploymentId: scope.workerDeploymentId }),
      afterSequence: Math.max(event.sequence - 1, 0),
      limit: 2,
    });
    const evidence = evidencePage.evidence.find((record) => record.id === event.evidenceId);
    if (!evidence) {
      throw new PacketProductEventError(
        "not_found",
        "Packet-product event evidence is no longer available.",
        404,
      );
    }
    return { eventId: input.eventId, evidence };
  }

  async function acknowledge(
    input: PacketProductEventScopeInput & {
      readonly cursor: string;
      readonly idempotencyKey: string;
      readonly expectedRevision: number;
    },
  ): Promise<PacketProductEventAcknowledgementResult> {
    requireNonEmpty(input.idempotencyKey, "Idempotency-Key");
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new PacketProductEventError(
        "invalid_input",
        "Event cursor revision must be a non-negative integer.",
        400,
      );
    }
    const auth = await trust.authorizeWrite({
      authorization: input.authorization,
      workspaceId: input.workspaceId,
      operation: "run.ack_events",
    });
    const loaded = await loadStore();
    validateWorkerPersistence(loaded);
    const loadedScope = resolveScope(loaded, input);
    const decoded = resolveCursor(loaded, input.cursor, loadedScope);
    const requestDigest = digest({
      credentialId: auth.credentialId,
      packageDeploymentId: loadedScope.binding.id,
      streamKind: loadedScope.streamKind,
      workerRunId: loadedScope.workerRunId ?? null,
      eventId: input.cursor,
      workspaceSequence: decoded.workspaceSequence,
      expectedRevision: input.expectedRevision,
    });

    return await mutateStore((data) => {
      validateWorkerPersistence(data);
      const scope = resolveScope(data, input);
      const existing = data.packetProductEventAcknowledgements.find(
        (record) =>
          record.workspaceId === input.workspaceId &&
          record.idempotencyKey === input.idempotencyKey,
      );
      if (existing) {
        if (
          existing.requestDigest !== requestDigest ||
          existing.credentialId !== auth.credentialId
        ) {
          throw new WorkerLifecycleError(
            "idempotency_mismatch",
            "Packet-product event acknowledgement key was reused with different input.",
          );
        }
        return {
          record: structuredClone(existing),
          cursor: cursorFromRecord(existing),
          replayed: true,
        };
      }
      const cursor = resolveCursor(data, input.cursor, scope);
      const current = currentCursor(data, auth, scope);
      if (current.revision !== input.expectedRevision) {
        throw new PacketProductEventError(
          "precondition_failed",
          "Packet-product event cursor revision no longer matches If-Match.",
          412,
        );
      }
      const advanced = cursor.workspaceSequence > current.workspaceSequence;
      const effectiveEventId = advanced ? input.cursor : current.cursor;
      if (!effectiveEventId) {
        throw new WorkerLifecycleError(
          "integrity",
          "A positive event acknowledgement cannot resolve an effective cursor.",
        );
      }
      const record: PacketProductEventAcknowledgementRecord = {
        schemaVersion: PACKET_PRODUCT_EVENT_ACKNOWLEDGEMENT_SCHEMA_VERSION,
        id: id(),
        workspaceId: input.workspaceId,
        credentialId: auth.credentialId,
        packageDeploymentId: scope.binding.id,
        workerDeploymentId: scope.workerDeploymentId,
        streamKind: scope.streamKind,
        ...(scope.workerRunId ? { workerRunId: scope.workerRunId } : {}),
        idempotencyKey: input.idempotencyKey,
        requestDigest,
        eventId: input.cursor,
        workspaceSequence: cursor.workspaceSequence,
        effectiveEventId,
        effectiveWorkspaceSequence: advanced ? cursor.workspaceSequence : current.workspaceSequence,
        expectedRevision: input.expectedRevision,
        disposition: advanced ? "advanced" : "unchanged",
        appliedRevision: advanced ? input.expectedRevision + 1 : input.expectedRevision,
        actor: structuredClone(auth.actor),
        acknowledgedAt: now(),
      };
      assertValidPacketProductEventAcknowledgementRecord(record);
      data.packetProductEventAcknowledgements.push(record);
      validateWorkerPersistence(data);
      return {
        record: structuredClone(record),
        cursor: cursorFromRecord(record),
        replayed: false,
      };
    });
  }

  return { listEvents, getEvidence, acknowledge };
}

interface ResolvedEventScope {
  readonly workspaceId: string;
  readonly streamKind: PacketProductEventStreamKind;
  readonly workerDeploymentId: string;
  readonly workerRunId?: string;
  readonly binding: WorkerPackageDeploymentRecord;
}

interface EventCursorEnvelope {
  readonly v: typeof EVENT_CURSOR_VERSION;
  readonly workspaceId: string;
  readonly streamKind: PacketProductEventStreamKind;
  readonly workerDeploymentId: string;
  readonly workerRunId?: string;
  readonly workspaceSequence: number;
  readonly sourceEventId: string;
}

function resolveScope(
  data: PacketAgentData,
  input: Pick<PacketProductEventScopeInput, "workspaceId" | "workerDeploymentId" | "workerRunId">,
): ResolvedEventScope {
  requireNonEmpty(input.workspaceId, "PacketAgent-Workspace-Id");
  const run = input.workerRunId
    ? data.workerRuns.find(
        (record) => record.workspaceId === input.workspaceId && record.id === input.workerRunId,
      )
    : undefined;
  if (input.workerRunId && !run) {
    throw new PacketProductEventError(
      "not_found",
      `Packet-product WorkerRun ${input.workerRunId} was not found.`,
      404,
    );
  }
  const workerDeploymentId = run?.workerDeploymentId ?? input.workerDeploymentId;
  if (!workerDeploymentId) {
    throw new PacketProductEventError(
      "invalid_input",
      "A Worker deployment or run event stream target is required.",
      400,
    );
  }
  if (input.workerDeploymentId && input.workerDeploymentId !== workerDeploymentId) {
    throw new PacketProductEventError(
      "invalid_input",
      "Worker run does not belong to the requested deployment event stream.",
      400,
    );
  }
  const binding = data.workerPackageDeployments.find(
    (record) =>
      record.workspaceId === input.workspaceId && record.workerDeploymentId === workerDeploymentId,
  );
  if (!binding) {
    throw new PacketProductEventError(
      "not_found",
      `Packet-product WorkerDeployment ${workerDeploymentId} was not found.`,
      404,
    );
  }
  return {
    workspaceId: input.workspaceId,
    streamKind: run ? "run" : "deployment",
    workerDeploymentId,
    ...(run ? { workerRunId: run.id } : {}),
    binding,
  };
}

function currentCursor(
  data: PacketAgentData,
  auth: PacketProductAuthContext,
  scope: ResolvedEventScope,
): PacketProductEventCursorState {
  const advanced = data.packetProductEventAcknowledgements
    .filter(
      (record) =>
        record.workspaceId === scope.workspaceId &&
        record.credentialId === auth.credentialId &&
        record.packageDeploymentId === scope.binding.id &&
        record.streamKind === scope.streamKind &&
        record.workerRunId === scope.workerRunId &&
        record.disposition === "advanced",
    )
    .sort(
      (left, right) =>
        left.appliedRevision - right.appliedRevision ||
        left.acknowledgedAt.localeCompare(right.acknowledgedAt) ||
        left.id.localeCompare(right.id),
    )
    .at(-1);
  if (!advanced) {
    return {
      workspaceSequence: 0,
      revision: 0,
      etag: cursorEtag(0),
    };
  }
  return {
    cursor: advanced.effectiveEventId,
    workspaceSequence: advanced.effectiveWorkspaceSequence,
    revision: advanced.appliedRevision,
    etag: cursorEtag(advanced.appliedRevision),
  };
}

function cursorFromRecord(
  record: PacketProductEventAcknowledgementRecord,
): PacketProductEventCursorState {
  return {
    cursor: record.effectiveEventId,
    workspaceSequence: record.effectiveWorkspaceSequence,
    revision: record.appliedRevision,
    etag: cursorEtag(record.appliedRevision),
  };
}

function cursorEtag(revision: number): string {
  return `"packet-product-event-cursor-${revision}"`;
}

export function parsePacketProductCursorEtag(value: string | null | undefined): number {
  const match = value?.trim().match(/^"packet-product-event-cursor-(0|[1-9]\d*)"$/);
  if (!match) {
    throw new PacketProductEventError(
      "invalid_input",
      'If-Match must contain the current strong event cursor ETag, for example "packet-product-event-cursor-0".',
      400,
    );
  }
  const revision = Number(match[1]);
  if (!Number.isSafeInteger(revision)) {
    throw new PacketProductEventError(
      "invalid_input",
      "If-Match event cursor revision is too large.",
      400,
    );
  }
  return revision;
}

function projectEvent(
  data: PacketAgentData,
  event: WorkerEvent,
  scope: ResolvedEventScope,
): PacketProductWorkerEvent {
  const workerVersionId = event.workerVersionId;
  const version = workerVersionId
    ? data.workerVersions.find(
        (record) => record.workspaceId === event.workspaceId && record.id === workerVersionId,
      )
    : undefined;
  if (!version || event.workerDeploymentId !== scope.workerDeploymentId) {
    throw new WorkerLifecycleError(
      "integrity",
      `Worker event ${event.id} does not resolve to its immutable deployment version.`,
    );
  }
  const workerRunId = isWorkerEventV2(event)
    ? event.workerRunId
    : typeof event.data?.workerRunId === "string"
      ? event.data.workerRunId
      : undefined;
  const evidenceId = isWorkerEventV2(event) ? event.evidenceId : undefined;
  const evidenceAvailable =
    evidenceId !== undefined &&
    data.workerEvidenceEntries.some(
      (record) => record.workspaceId === event.workspaceId && record.id === evidenceId,
    );
  return {
    schemaVersion: PACKET_PRODUCT_WORKER_EVENT_SCHEMA_VERSION,
    id: encodeEventCursor(event, scope),
    type: packetProductEventType(event),
    workspaceSequence: event.sequence,
    ...(isWorkerEventV2(event) && event.deploymentSequence
      ? { deploymentSequence: event.deploymentSequence }
      : {}),
    ...(isWorkerEventV2(event) && event.runSequence ? { runSequence: event.runSequence } : {}),
    occurredAt: event.occurredAt,
    deploymentId: scope.workerDeploymentId,
    workerVersion: projectVersion(version),
    ...(workerRunId ? { runId: workerRunId } : {}),
    ...(isWorkerEventV2(event) && event.trace?.traceId
      ? { traceId: event.trace.traceId }
      : { traceGap: "source_trace_unavailable" as const }),
    summary: event.summary,
    evidence: {
      ...(evidenceId ? { id: evidenceId } : {}),
      href: `/api/worker-events/${encodeURIComponent(encodeEventCursor(event, scope))}/evidence`,
      available: evidenceAvailable,
    },
    source: {
      eventId: event.id,
      eventType: event.type,
      ...(isWorkerEventV2(event) ? { eventDigest: event.eventDigest } : {}),
    },
    ...(event.data ? { data: structuredClone(event.data) } : {}),
  };
}

function projectVersion(version: WorkerVersion) {
  return {
    id: version.id,
    version: version.version,
    contentDigest: version.contentDigest,
  };
}

function packetProductEventType(event: WorkerEvent): PacketProductWorkerEventType {
  if (event.type === "worker.deployment.deployed") return "worker.deployed";
  if (event.type === "worker.deployment.active") return "worker.activated";
  if (event.type === "worker.deployment.paused") return "worker.deployment.paused";
  if (
    event.type === "worker.deployment.revoked" ||
    event.type === "worker.control.revoke_deployment.applied"
  ) {
    return "worker.deployment.revoked";
  }
  if (event.type === "worker.run.started") return "worker.run.started";
  if (event.type.startsWith("worker.checkpoint.")) return "worker.run.checkpointed";
  if (event.type === "worker.attention.requested") return "worker.run.approval_required";
  if (event.type === "worker.attention.halted" || event.type === "worker.run.quarantined") {
    return "worker.run.blocked";
  }
  if (event.type === "worker.run.terminal") {
    const status = event.data?.status;
    if (status === "completed") return "worker.run.completed";
    if (status === "budget_exhausted") return "worker.run.budget_exhausted";
    if (status === "cancelled") return "worker.run.cancelled";
    return "worker.run.failed";
  }
  const runId =
    isWorkerEventV2(event) && event.workerRunId
      ? event.workerRunId
      : typeof event.data?.workerRunId === "string"
        ? event.data.workerRunId
        : undefined;
  return runId ? "worker.run.progress" : "worker.deployment.progress";
}

function encodeEventCursor(event: WorkerEvent, scope: ResolvedEventScope): string {
  const envelope: EventCursorEnvelope = {
    v: EVENT_CURSOR_VERSION,
    workspaceId: scope.workspaceId,
    streamKind: scope.streamKind,
    workerDeploymentId: scope.workerDeploymentId,
    ...(scope.workerRunId ? { workerRunId: scope.workerRunId } : {}),
    workspaceSequence: event.sequence,
    sourceEventId: event.id,
  };
  const payload = Buffer.from(canonicalWorkerJson(envelope), "utf8").toString("base64url");
  return `pkevt.${payload}.${cursorDigest(payload).slice("sha256:".length)}`;
}

function resolveCursor(
  data: PacketAgentData,
  value: string,
  scope: ResolvedEventScope,
): EventCursorEnvelope {
  const envelope = decodeEventCursor(value);
  if (
    envelope.workspaceId !== scope.workspaceId ||
    envelope.streamKind !== scope.streamKind ||
    envelope.workerDeploymentId !== scope.workerDeploymentId ||
    envelope.workerRunId !== scope.workerRunId
  ) {
    throw new PacketProductEventError(
      "invalid_cursor",
      "Packet-product event cursor belongs to another workspace or stream.",
      400,
    );
  }
  const source = data.workerEvents.find(
    (event) =>
      event.workspaceId === scope.workspaceId &&
      event.id === envelope.sourceEventId &&
      event.sequence === envelope.workspaceSequence &&
      event.workerDeploymentId === scope.workerDeploymentId &&
      (scope.streamKind === "deployment" || eventRunId(event) === scope.workerRunId),
  );
  if (!source) throw cursorExpired(data, scope);
  return envelope;
}

function decodeEventCursor(value: string): EventCursorEnvelope {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_CURSOR_LENGTH ||
    /[\u0000\r\n]/.test(value)
  ) {
    throw invalidCursor();
  }
  const parts = value.split(".");
  if (
    parts.length !== 3 ||
    parts[0] !== "pkevt" ||
    !parts[1] ||
    !/^[A-Za-z0-9_-]+$/.test(parts[1]) ||
    !/^[a-f0-9]{64}$/.test(parts[2] ?? "")
  ) {
    throw invalidCursor();
  }
  const expected = cursorDigest(parts[1]).slice("sha256:".length);
  if (parts[2] !== expected) throw invalidCursor();
  try {
    const decoded = Buffer.from(parts[1], "base64url");
    if (decoded.toString("base64url") !== parts[1]) throw invalidCursor();
    const parsed = JSON.parse(decoded.toString("utf8")) as Partial<EventCursorEnvelope>;
    const keys = Object.keys(parsed);
    if (
      keys.some(
        (key) =>
          ![
            "v",
            "workspaceId",
            "streamKind",
            "workerDeploymentId",
            "workerRunId",
            "workspaceSequence",
            "sourceEventId",
          ].includes(key),
      ) ||
      parsed.v !== EVENT_CURSOR_VERSION ||
      !nonEmpty(parsed.workspaceId) ||
      !["deployment", "run"].includes(parsed.streamKind ?? "") ||
      !nonEmpty(parsed.workerDeploymentId) ||
      (parsed.streamKind === "run") !== nonEmpty(parsed.workerRunId) ||
      !Number.isSafeInteger(parsed.workspaceSequence) ||
      (parsed.workspaceSequence ?? 0) < 1 ||
      !nonEmpty(parsed.sourceEventId)
    ) {
      throw invalidCursor();
    }
    return parsed as EventCursorEnvelope;
  } catch (error) {
    if (error instanceof PacketProductEventError) throw error;
    throw invalidCursor();
  }
}

function cursorExpired(data: PacketAgentData, scope: ResolvedEventScope): PacketProductEventError {
  const first = data.workerEvents
    .filter(
      (event) =>
        event.workspaceId === scope.workspaceId &&
        event.workerDeploymentId === scope.workerDeploymentId &&
        (scope.streamKind === "deployment" || eventRunId(event) === scope.workerRunId),
    )
    .sort((left, right) => left.sequence - right.sequence)
    .at(0);
  const minimumCursor = first ? encodeEventCursor(first, scope) : undefined;
  return new PacketProductEventError(
    "cursor_expired",
    "Packet-product event cursor is outside the retained event window.",
    410,
    {
      ...(minimumCursor ? { minimumCursor } : {}),
      ...(first ? { minimumWorkspaceSequence: first.sequence } : {}),
    },
  );
}

function invalidCursor(): PacketProductEventError {
  return new PacketProductEventError(
    "invalid_cursor",
    "Packet-product event cursor is invalid.",
    400,
  );
}

function eventRunId(event: WorkerEvent): string | undefined {
  return isWorkerEventV2(event)
    ? event.workerRunId
    : typeof event.data?.workerRunId === "string"
      ? event.data.workerRunId
      : undefined;
}

function streamIdentity(scope: ResolvedEventScope) {
  return {
    kind: scope.streamKind,
    workerDeploymentId: scope.workerDeploymentId,
    ...(scope.workerRunId ? { workerRunId: scope.workerRunId } : {}),
  };
}

function normalizeCursor(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (value.length > MAX_CURSOR_LENGTH) throw invalidCursor();
  return value;
}

function pageLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_LIMIT) {
    throw new PacketProductEventError(
      "invalid_input",
      `Event page limit must be an integer between 1 and ${MAX_PAGE_LIMIT}.`,
      400,
    );
  }
  return value;
}

function requireNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new PacketProductEventError("invalid_input", `${label} must be a non-empty string.`, 400);
  }
}

function nonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function cursorDigest(payload: string): string {
  return `sha256:${createHash("sha256")
    .update("packetagent.packet-product-event-cursor/v1\0")
    .update(payload)
    .digest("hex")}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalWorkerJson(value)).digest("hex")}`;
}
