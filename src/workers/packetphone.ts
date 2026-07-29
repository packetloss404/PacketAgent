import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { loadStoreAsync as defaultLoadStore, type PacketAgentData } from "../packetagent-store.js";
import {
  hasWorkspacePermission,
  isWorkspaceRole,
  type WorkspacePermission,
  type WorkspaceRole,
} from "../rbac.js";
import {
  createWorkerControlService,
  type WorkerControlResult,
  type WorkerControlService,
} from "./control-service.js";
import type {
  WorkerAttentionRequest,
  WorkerNotificationEnvelope,
  WorkerRemoteControlAuthorization,
} from "./control-types.js";
import { createWorkerCredentialService, type WorkerCredentialService } from "./credentials.js";
import { WorkerLifecycleError } from "./errors.js";
import {
  createWorkerNetworkClient,
  WorkerNetworkError,
  type WorkerNetworkPort,
} from "./network.js";
import {
  WorkerNotificationDeliveryError,
  type WorkerNotificationTransport,
} from "./notifications.js";
import { WORKER_EVENT_SCHEMA_VERSION, type WorkerEventV2 } from "./persistence-types.js";
import { validateWorkerPersistence } from "./repository.js";
import { isTerminalWorkerRunStatus } from "./transitions.js";
import type {
  WorkerDeployment,
  WorkerNotificationRouteReference,
  WorkerRun,
  WorkerVersion,
} from "./types.js";
import { canonicalWorkerJson } from "./validation.js";

type MaybePromise<T> = T | Promise<T>;

export const PACKETPHONE_ROUTE_SCHEMA_VERSION = "packetagent.packetphone-route/v1" as const;
export const PACKETPHONE_MESSAGE_SCHEMA_VERSION =
  "packetagent.packetphone-worker-control/v1" as const;
export const PACKETPHONE_CALLBACK_ISSUER = "PacketAgent" as const;
export const PACKETPHONE_CALLBACK_AUDIENCE = "PacketPhone" as const;
export const PACKETPHONE_CALLBACK_TYPE = "packetagent-packetphone-control+jwt" as const;
export const PACKETPHONE_CALLBACK_PATH = "/api/packet-products/packetphone/worker-control" as const;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CALLBACK_TTL_SECONDS = 10 * 60;
const MAX_CALLBACK_TTL_SECONDS = 15 * 60;
const MAX_CONFIG_BYTES = 32 * 1_024;
const MAX_TITLE_LENGTH = 160;
const MAX_SUMMARY_LENGTH = 1_000;
const CLOCK_SKEW_SECONDS = 60;

export type PacketPhoneControlAction =
  | "approve_once"
  | "reject_attention"
  | "pause_run"
  | "stop_run"
  | "revoke_deployment";

export interface PacketPhoneRouteConfig {
  readonly schemaVersion: typeof PACKETPHONE_ROUTE_SCHEMA_VERSION;
  readonly endpoint: string;
  readonly bearerToken?: string;
  readonly callbackBaseUrl: string;
  readonly callbackSecret: string;
  readonly actorId: string;
  readonly actorRole: WorkspaceRole;
  readonly allowedActions: readonly PacketPhoneControlAction[];
  readonly timeoutMs: number;
  readonly callbackTtlSeconds: number;
}

export interface PacketPhoneWorkerControlMessage {
  readonly schemaVersion: typeof PACKETPHONE_MESSAGE_SCHEMA_VERSION;
  readonly messageKey: string;
  readonly worker: {
    readonly workspaceId: string;
    readonly definitionId: string;
    readonly deploymentId: string;
    readonly runId: string;
    readonly versionId: string;
    readonly versionContentDigest: string;
  };
  readonly state: {
    readonly deployment: WorkerDeployment["status"];
    readonly deploymentRevision: number;
    readonly run: WorkerRun["status"];
    readonly runRevision: number;
    readonly reason?: string;
  };
  readonly attention?: {
    readonly id: string;
    readonly status: WorkerAttentionRequest["status"];
    readonly capabilityId: string;
    readonly expiresAt: string;
  };
  readonly evidence: {
    readonly id: string;
    readonly href: string;
  };
  readonly title: string;
  readonly summary: string;
  readonly actions: readonly {
    readonly action: PacketPhoneControlAction;
    readonly label: string;
    readonly expiresAt: string;
    readonly callback: {
      readonly method: "POST";
      readonly href: string;
      readonly contentType: "application/json";
      readonly body: {
        readonly token: string;
      };
    };
  }[];
}

interface PacketPhoneControlClaims {
  readonly v: 1;
  readonly iss: typeof PACKETPHONE_CALLBACK_ISSUER;
  readonly aud: typeof PACKETPHONE_CALLBACK_AUDIENCE;
  readonly sub: string;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
  readonly nonce: string;
  readonly action: PacketPhoneControlAction;
  readonly workspaceId: string;
  readonly workerDefinitionId: string;
  readonly workerDeploymentId: string;
  readonly workerRunId: string;
  readonly workerVersionId: string;
  readonly workerVersionContentDigest: string;
  readonly attentionRequestId: string | null;
  readonly expectedRevision: number;
  readonly actorId: string;
  readonly actorRole: WorkspaceRole;
  readonly notificationRouteId: string;
  readonly notificationRouteReference: string;
  readonly sourceEventId: string;
  readonly sourceEventDigest: string;
}

interface BoundWorkerContext {
  readonly run: WorkerRun;
  readonly version: WorkerVersion;
  readonly deployment: WorkerDeployment;
  readonly route: WorkerNotificationRouteReference;
  readonly sourceEvent: WorkerEventV2;
  readonly attention?: WorkerAttentionRequest;
}

export interface PacketPhoneDependencies {
  readonly loadStore?: () => MaybePromise<PacketAgentData>;
  readonly credentialService?: WorkerCredentialService;
  readonly network?: WorkerNetworkPort;
  readonly control?: WorkerControlService;
  readonly now?: () => Date;
}

export interface PacketPhoneCallbackResult {
  readonly action: PacketPhoneControlAction;
  readonly disposition: "applied";
  readonly command: {
    readonly id: string;
    readonly kind: WorkerControlResult["command"]["kind"];
    readonly status: "applied";
  };
  readonly run?: {
    readonly id: string;
    readonly status: WorkerRun["status"];
    readonly revision: number;
  };
  readonly deployment?: {
    readonly id: string;
    readonly status: WorkerDeployment["status"];
    readonly revision: number;
  };
  readonly attention?: {
    readonly id: string;
    readonly status: WorkerAttentionRequest["status"];
  };
  readonly approval?: {
    readonly id: string;
    readonly scope: "once";
    readonly status: string;
    readonly expiresAt: string;
  };
}

export type PacketPhoneCallbackErrorCode =
  | "invalid_token"
  | "expired_token"
  | "binding_mismatch"
  | "actor_forbidden"
  | "replayed_callback"
  | "stale_callback"
  | "action_resolved";

export class PacketPhoneCallbackError extends Error {
  readonly code: PacketPhoneCallbackErrorCode;
  readonly status: 401 | 403 | 409;

  constructor(code: PacketPhoneCallbackErrorCode) {
    super("PacketPhone Worker control callback was rejected.");
    this.name = "PacketPhoneCallbackError";
    this.code = code;
    this.status =
      code === "actor_forbidden"
        ? 403
        : ["replayed_callback", "stale_callback", "action_resolved"].includes(code)
          ? 409
          : 401;
  }
}

export function createPacketPhoneNotificationTransport(
  dependencies: PacketPhoneDependencies = {},
): WorkerNotificationTransport {
  const loadStore = dependencies.loadStore ?? defaultLoadStore;
  const credentialService = dependencies.credentialService ?? createWorkerCredentialService();
  const network = dependencies.network ?? createWorkerNetworkClient();

  return {
    async deliver(input) {
      if (input.route.kind !== "packetphone") {
        throw new WorkerNotificationDeliveryError("packetphone_route_mismatch", false);
      }
      let context: BoundWorkerContext;
      try {
        context = await resolveBoundContext(loadStore, input.envelope, input.route);
      } catch {
        throw new WorkerNotificationDeliveryError("packetphone_binding_invalid", false);
      }

      try {
        return await credentialService.use(
          {
            workspaceId: context.run.workspaceId,
            reference: context.route.reference,
            declaredCredentialRefs: context.version.content.credentialRefs,
            expectedKinds: ["opaque"],
          },
          async (rawConfig) => {
            const config = parsePacketPhoneRouteConfig(rawConfig);
            const message = buildPacketPhoneMessage(context, input.envelope, config);
            let response;
            try {
              response = await network.request({
                url: config.endpoint,
                method: "POST",
                headers: {
                  accept: "application/json",
                  "content-type": "application/json",
                  "idempotency-key": input.idempotencyKey,
                  ...(config.bearerToken ? { authorization: `Bearer ${config.bearerToken}` } : {}),
                },
                body: JSON.stringify(message),
                signal: input.signal,
                timeoutMs: config.timeoutMs,
                maxResponseBytes: 64 * 1_024,
              });
            } catch (error) {
              if (error instanceof WorkerNetworkError) {
                throw new WorkerNotificationDeliveryError(
                  `packetphone_network_${error.code}`,
                  ![
                    "invalid_url",
                    "blocked_host",
                    "blocked_address",
                    "connected_address_mismatch",
                    "redirect_denied",
                  ].includes(error.code),
                );
              }
              throw error;
            }
            if (response.status < 200 || response.status >= 300) {
              const retryable = [408, 425, 429].includes(response.status) || response.status >= 500;
              throw new WorkerNotificationDeliveryError(
                `packetphone_http_${response.status}`,
                retryable,
              );
            }
            return {
              deliveryReference:
                response.headers["x-request-id"] ??
                response.headers["request-id"] ??
                `packetphone:${input.envelope.id}`,
              metadata: {
                provider: "packetphone",
                responseCode: response.status,
              },
            };
          },
        );
      } catch (error) {
        if (error instanceof WorkerNotificationDeliveryError) throw error;
        throw new WorkerNotificationDeliveryError("packetphone_route_config_invalid", false);
      }
    },
  };
}

export function createPacketPhoneCallbackService(dependencies: PacketPhoneDependencies = {}): {
  consume(token: string): Promise<PacketPhoneCallbackResult>;
} {
  const loadStore = dependencies.loadStore ?? defaultLoadStore;
  const credentialService = dependencies.credentialService ?? createWorkerCredentialService();
  const control = dependencies.control ?? createWorkerControlService();
  const now = dependencies.now ?? (() => new Date());

  return {
    async consume(token) {
      const untrusted = decodeUntrustedClaims(token);
      const data = await loadStore();
      validateWorkerPersistence(data);
      const context = resolveCallbackContext(data, untrusted);
      try {
        return await credentialService.use<PacketPhoneCallbackResult>(
          {
            workspaceId: context.run.workspaceId,
            reference: context.route.reference,
            declaredCredentialRefs: context.version.content.credentialRefs,
            expectedKinds: ["opaque"],
          },
          async (rawConfig) => {
            let config: PacketPhoneRouteConfig;
            try {
              config = parsePacketPhoneRouteConfig(rawConfig);
            } catch {
              throw new PacketPhoneCallbackError("binding_mismatch");
            }
            const claims = verifyCallbackToken(token, config.callbackSecret, now());
            assertClaimsBound(claims, context, config);
            let result: WorkerControlResult;
            try {
              result = await executeControl(control, claims, context);
            } catch (error) {
              if (error instanceof PacketPhoneCallbackError) throw error;
              if (error instanceof WorkerLifecycleError) {
                if (error.code === "idempotency_mismatch") {
                  throw new PacketPhoneCallbackError("replayed_callback");
                }
                if (error.code === "conflict") {
                  throw new PacketPhoneCallbackError("stale_callback");
                }
                throw new PacketPhoneCallbackError("binding_mismatch");
              }
              throw error;
            }
            if (result.disposition === "replayed") {
              throw new PacketPhoneCallbackError("replayed_callback");
            }
            if (result.command.status === "rejected") {
              const attentionAlreadyResolved =
                (claims.action === "approve_once" || claims.action === "reject_attention") &&
                context.attention?.status !== "open";
              throw new PacketPhoneCallbackError(
                result.command.rejectionCode === "revision_conflict" && !attentionAlreadyResolved
                  ? "stale_callback"
                  : "action_resolved",
              );
            }
            return projectCallbackResult(claims.action, result);
          },
        );
      } catch (error) {
        if (error instanceof PacketPhoneCallbackError) throw error;
        throw new PacketPhoneCallbackError("binding_mismatch");
      }
    },
  };
}

export function parsePacketPhoneRouteConfig(raw: string): PacketPhoneRouteConfig {
  if (!raw || Buffer.byteLength(raw, "utf8") > MAX_CONFIG_BYTES) {
    throw new Error("PacketPhone route configuration is invalid.");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("PacketPhone route configuration is invalid.");
  }
  if (!isRecord(value) || value.schemaVersion !== PACKETPHONE_ROUTE_SCHEMA_VERSION) {
    throw new Error("PacketPhone route configuration is invalid.");
  }
  const endpoint = requiredString(value.endpoint);
  const callbackBaseUrl = requiredString(value.callbackBaseUrl);
  const callbackSecret = requiredString(value.callbackSecret);
  const actorId = requiredString(value.actorId);
  const actorRole = value.actorRole;
  const bearerToken =
    value.bearerToken === undefined ? undefined : requiredString(value.bearerToken);
  const timeoutMs = boundedInteger(value.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 60_000);
  const callbackTtlSeconds = boundedInteger(
    value.callbackTtlSeconds,
    DEFAULT_CALLBACK_TTL_SECONDS,
    60,
    MAX_CALLBACK_TTL_SECONDS,
  );
  if (!isWorkspaceRole(actorRole)) {
    throw new Error("PacketPhone route configuration is invalid.");
  }
  const allowedActions = parseAllowedActions(value.allowedActions, actorRole);
  assertHttpsUrl(endpoint);
  assertCallbackBaseUrl(callbackBaseUrl);
  const callbackSecretBytes = Buffer.byteLength(callbackSecret, "utf8");
  if (callbackSecretBytes < 32 || callbackSecretBytes > 4_096 || actorId.length > 512) {
    throw new Error("PacketPhone route configuration is invalid.");
  }
  return {
    schemaVersion: PACKETPHONE_ROUTE_SCHEMA_VERSION,
    endpoint,
    ...(bearerToken ? { bearerToken } : {}),
    callbackBaseUrl,
    callbackSecret,
    actorId,
    actorRole,
    allowedActions,
    timeoutMs,
    callbackTtlSeconds,
  };
}

function buildPacketPhoneMessage(
  context: BoundWorkerContext,
  envelope: WorkerNotificationEnvelope,
  config: PacketPhoneRouteConfig,
): PacketPhoneWorkerControlMessage {
  const actions = availableActions(context, config).map((action) => {
    const claims = makeControlClaims(context, envelope, config, action);
    return {
      action,
      label: actionLabel(action),
      expiresAt: new Date(claims.exp * 1_000).toISOString(),
      callback: {
        method: "POST" as const,
        href: absoluteUrl(config.callbackBaseUrl, PACKETPHONE_CALLBACK_PATH),
        contentType: "application/json" as const,
        body: {
          token: signCallbackToken(claims, config.callbackSecret),
        },
      },
    };
  });
  return {
    schemaVersion: PACKETPHONE_MESSAGE_SCHEMA_VERSION,
    messageKey: envelope.id,
    worker: {
      workspaceId: context.run.workspaceId,
      definitionId: context.run.workerDefinitionId,
      deploymentId: context.run.workerDeploymentId,
      runId: context.run.id,
      versionId: context.run.workerVersionId,
      versionContentDigest: context.version.contentDigest,
    },
    state: {
      deployment: context.deployment.status,
      deploymentRevision: context.deployment.revision,
      run: context.run.status,
      runRevision: context.run.revision,
      ...(context.run.terminalReason || context.deployment.statusReason
        ? {
            reason:
              context.run.terminalReason ??
              boundedText(context.deployment.statusReason!, MAX_SUMMARY_LENGTH),
          }
        : {}),
    },
    ...(context.attention
      ? {
          attention: {
            id: context.attention.id,
            status: context.attention.status,
            capabilityId: context.attention.capabilityId,
            expiresAt: context.attention.expiresAt,
          },
        }
      : {}),
    evidence: {
      id: envelope.evidenceId,
      href: absoluteUrl(
        config.callbackBaseUrl,
        `/api/app/workers/evidence?workerRunId=${encodeURIComponent(context.run.id)}`,
      ),
    },
    title: boundedText(envelope.title, MAX_TITLE_LENGTH),
    summary: boundedText(envelope.summary, MAX_SUMMARY_LENGTH),
    actions,
  };
}

async function resolveBoundContext(
  loadStore: () => MaybePromise<PacketAgentData>,
  envelope: WorkerNotificationEnvelope,
  requestedRoute: WorkerNotificationRouteReference,
): Promise<BoundWorkerContext> {
  const data = await loadStore();
  validateWorkerPersistence(data);
  const context = resolveCoreContext(data, {
    workspaceId: envelope.workspaceId,
    workerDefinitionId: envelope.workerDefinitionId,
    workerDeploymentId: envelope.workerDeploymentId,
    workerRunId: envelope.workerRunId,
    workerVersionId: envelope.workerVersionId,
    workerVersionContentDigest: envelope.workerVersionContentDigest,
    notificationRouteId: requestedRoute.id,
    notificationRouteReference: requestedRoute.reference,
    sourceEventId: envelope.sourceEventId,
    sourceEventDigest: envelope.sourceEventDigest,
    attentionRequestId: stringOrNull(envelope.data.attentionRequestId),
  });
  if (
    context.route.kind !== "packetphone" ||
    requestedRoute.kind !== "packetphone" ||
    !context.route.events.includes(envelope.event)
  ) {
    throw new WorkerLifecycleError("integrity", "PacketPhone route binding is invalid.");
  }
  return context;
}

function resolveCallbackContext(
  data: PacketAgentData,
  claims: PacketPhoneControlClaims,
): BoundWorkerContext {
  try {
    return resolveCoreContext(data, claims);
  } catch {
    throw new PacketPhoneCallbackError("binding_mismatch");
  }
}

function resolveCoreContext(
  data: PacketAgentData,
  binding: {
    readonly workspaceId: string;
    readonly workerDefinitionId: string;
    readonly workerDeploymentId: string;
    readonly workerRunId: string;
    readonly workerVersionId: string;
    readonly workerVersionContentDigest: string;
    readonly attentionRequestId: string | null;
    readonly notificationRouteId: string;
    readonly notificationRouteReference: string;
    readonly sourceEventId: string;
    readonly sourceEventDigest: string;
  },
): BoundWorkerContext {
  const run = data.workerRuns.find(
    (record) => record.workspaceId === binding.workspaceId && record.id === binding.workerRunId,
  );
  const version = data.workerVersions.find(
    (record) => record.workspaceId === binding.workspaceId && record.id === binding.workerVersionId,
  );
  const deployment = data.workerDeployments.find(
    (record) =>
      record.workspaceId === binding.workspaceId && record.id === binding.workerDeploymentId,
  );
  const route = version?.content.notificationRoutes.find(
    (record) =>
      record.kind === "packetphone" &&
      record.id === binding.notificationRouteId &&
      record.reference === binding.notificationRouteReference,
  );
  const sourceEvent = data.workerEvents.find(
    (record): record is WorkerEventV2 =>
      record.schemaVersion === WORKER_EVENT_SCHEMA_VERSION &&
      record.workspaceId === binding.workspaceId &&
      record.id === binding.sourceEventId &&
      record.eventDigest === binding.sourceEventDigest,
  );
  const attention =
    binding.attentionRequestId === null
      ? undefined
      : data.workerAttentionRequests.find(
          (record) =>
            record.workspaceId === binding.workspaceId && record.id === binding.attentionRequestId,
        );
  if (
    !run ||
    !version ||
    !deployment ||
    !route ||
    !sourceEvent ||
    run.workerDefinitionId !== binding.workerDefinitionId ||
    run.workerDeploymentId !== deployment.id ||
    run.workerVersionId !== version.id ||
    version.workerDefinitionId !== run.workerDefinitionId ||
    version.contentDigest !== binding.workerVersionContentDigest ||
    deployment.workerDefinitionId !== run.workerDefinitionId ||
    deployment.workerVersionId !== run.workerVersionId ||
    sourceEvent.workerDefinitionId !== run.workerDefinitionId ||
    sourceEvent.workerDeploymentId !== run.workerDeploymentId ||
    sourceEvent.workerVersionId !== run.workerVersionId ||
    sourceEvent.workerRunId !== run.id ||
    !version.content.credentialRefs.includes(route.reference) ||
    (attention !== undefined &&
      (attention.workerDefinitionId !== run.workerDefinitionId ||
        attention.workerDeploymentId !== run.workerDeploymentId ||
        attention.workerVersionId !== run.workerVersionId ||
        attention.workerVersionContentDigest !== version.contentDigest ||
        attention.workerRunId !== run.id))
  ) {
    throw new WorkerLifecycleError("integrity", "PacketPhone Worker binding is invalid.");
  }
  return {
    run,
    version,
    deployment,
    route,
    sourceEvent,
    ...(attention ? { attention } : {}),
  };
}

function availableActions(
  context: BoundWorkerContext,
  config: PacketPhoneRouteConfig,
): PacketPhoneControlAction[] {
  const allowed = new Set(config.allowedActions);
  const candidates: PacketPhoneControlAction[] = [];
  if (
    context.attention?.status === "open" &&
    ["waiting_for_approval", "paused"].includes(context.run.status)
  ) {
    candidates.push("approve_once", "reject_attention");
  }
  if (["queued", "running", "waiting_for_approval"].includes(context.run.status)) {
    candidates.push("pause_run");
  }
  if (!isTerminalWorkerRunStatus(context.run.status)) {
    candidates.push("stop_run");
  }
  if (["deployed", "active", "paused", "attention"].includes(context.deployment.status)) {
    candidates.push("revoke_deployment");
  }
  return candidates.filter(
    (action) => allowed.has(action) && roleAllowsAction(config.actorRole, action),
  );
}

function makeControlClaims(
  context: BoundWorkerContext,
  envelope: WorkerNotificationEnvelope,
  config: PacketPhoneRouteConfig,
  action: PacketPhoneControlAction,
): PacketPhoneControlClaims {
  const iat = Math.floor(Date.parse(envelope.time) / 1_000);
  const base = {
    v: 1 as const,
    iss: PACKETPHONE_CALLBACK_ISSUER,
    aud: PACKETPHONE_CALLBACK_AUDIENCE,
    sub: context.run.id,
    iat,
    exp: iat + config.callbackTtlSeconds,
    action,
    workspaceId: context.run.workspaceId,
    workerDefinitionId: context.run.workerDefinitionId,
    workerDeploymentId: context.run.workerDeploymentId,
    workerRunId: context.run.id,
    workerVersionId: context.run.workerVersionId,
    workerVersionContentDigest: context.version.contentDigest,
    attentionRequestId: context.attention?.id ?? null,
    expectedRevision:
      action === "revoke_deployment" ? context.deployment.revision : context.run.revision,
    actorId: config.actorId,
    actorRole: config.actorRole,
    notificationRouteId: context.route.id,
    notificationRouteReference: context.route.reference,
    sourceEventId: context.sourceEvent.id,
    sourceEventDigest: context.sourceEvent.eventDigest,
  };
  const nonce = createHmac("sha256", config.callbackSecret)
    .update(canonicalWorkerJson(base))
    .digest("base64url");
  return {
    ...base,
    jti: digestString(
      canonicalWorkerJson({ nonce, action, sourceEventId: context.sourceEvent.id }),
    ),
    nonce,
  };
}

function assertClaimsBound(
  claims: PacketPhoneControlClaims,
  context: BoundWorkerContext,
  config: PacketPhoneRouteConfig,
): void {
  if (
    claims.sub !== context.run.id ||
    claims.workspaceId !== context.run.workspaceId ||
    claims.workerDefinitionId !== context.run.workerDefinitionId ||
    claims.workerDeploymentId !== context.run.workerDeploymentId ||
    claims.workerRunId !== context.run.id ||
    claims.workerVersionId !== context.run.workerVersionId ||
    claims.workerVersionContentDigest !== context.version.contentDigest ||
    claims.attentionRequestId !== (context.attention?.id ?? null) ||
    claims.notificationRouteId !== context.route.id ||
    claims.notificationRouteReference !== context.route.reference ||
    claims.sourceEventId !== context.sourceEvent.id ||
    claims.sourceEventDigest !== context.sourceEvent.eventDigest ||
    claims.actorId !== config.actorId ||
    claims.actorRole !== config.actorRole ||
    !config.allowedActions.includes(claims.action)
  ) {
    throw new PacketPhoneCallbackError("binding_mismatch");
  }
  if (!roleAllowsAction(config.actorRole, claims.action)) {
    throw new PacketPhoneCallbackError("actor_forbidden");
  }
}

async function executeControl(
  control: WorkerControlService,
  claims: PacketPhoneControlClaims,
  context: BoundWorkerContext,
): Promise<WorkerControlResult> {
  const authorization: WorkerRemoteControlAuthorization = {
    source: "packetphone",
    audience: PACKETPHONE_CALLBACK_AUDIENCE,
    actorRole: claims.actorRole,
    tokenIdDigest: digestString(claims.jti),
    nonceDigest: digestString(claims.nonce),
  };
  const controlContext = {
    workspaceId: claims.workspaceId,
    actor: {
      type: "packet_product" as const,
      id: claims.actorId,
      displayName: `PacketPhone ${claims.actorRole} remote actor`,
      product: "PacketPhone" as const,
    },
    idempotencyKey: `packetphone:${digestHex(
      canonicalWorkerJson({ jti: claims.jti, nonce: claims.nonce }),
    )}`,
    expectedRevision: claims.expectedRevision,
    remoteControl: authorization,
  };
  if (claims.action === "approve_once") {
    return control.approveOnce({
      ...controlContext,
      attentionRequestId: requireAttention(context).id,
      expiresAt: requireAttention(context).expiresAt,
    });
  }
  if (claims.action === "reject_attention") {
    return control.rejectAttention({
      ...controlContext,
      attentionRequestId: requireAttention(context).id,
    });
  }
  if (claims.action === "pause_run") {
    return control.pauseRun({ ...controlContext, workerRunId: context.run.id });
  }
  if (claims.action === "stop_run") {
    return control.stopRun({ ...controlContext, workerRunId: context.run.id });
  }
  return control.revokeDeployment({
    ...controlContext,
    workerDeploymentId: context.deployment.id,
  });
}

function projectCallbackResult(
  action: PacketPhoneControlAction,
  result: WorkerControlResult,
): PacketPhoneCallbackResult {
  return {
    action,
    disposition: "applied",
    command: {
      id: result.command.id,
      kind: result.command.kind,
      status: "applied",
    },
    ...(result.run
      ? {
          run: {
            id: result.run.id,
            status: result.run.status,
            revision: result.run.revision,
          },
        }
      : {}),
    ...(result.deployment
      ? {
          deployment: {
            id: result.deployment.id,
            status: result.deployment.status,
            revision: result.deployment.revision,
          },
        }
      : {}),
    ...(result.attentionRequest
      ? {
          attention: {
            id: result.attentionRequest.id,
            status: result.attentionRequest.status,
          },
        }
      : {}),
    ...(result.approvalGrant
      ? {
          approval: {
            id: result.approvalGrant.id,
            scope: "once",
            status: result.approvalGrant.status,
            expiresAt: result.approvalGrant.expiresAt,
          },
        }
      : {}),
  };
}

function signCallbackToken(claims: PacketPhoneControlClaims, secret: string): string {
  const header = encodeBase64Url(JSON.stringify({ alg: "HS256", typ: PACKETPHONE_CALLBACK_TYPE }));
  const payload = encodeBase64Url(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

function verifyCallbackToken(token: string, secret: string, now: Date): PacketPhoneControlClaims {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new PacketPhoneCallbackError("invalid_token");
  }
  let header: unknown;
  let claims: PacketPhoneControlClaims;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    claims = parseClaims(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
  } catch {
    throw new PacketPhoneCallbackError("invalid_token");
  }
  if (
    !isRecord(header) ||
    header.alg !== "HS256" ||
    header.typ !== PACKETPHONE_CALLBACK_TYPE ||
    Object.keys(header).some((key) => !["alg", "typ"].includes(key))
  ) {
    throw new PacketPhoneCallbackError("invalid_token");
  }
  const expected = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(parts[2], "base64url");
  } catch {
    throw new PacketPhoneCallbackError("invalid_token");
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new PacketPhoneCallbackError("invalid_token");
  }
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  if (claims.exp <= nowSeconds) {
    throw new PacketPhoneCallbackError("expired_token");
  }
  if (
    claims.iat > nowSeconds + CLOCK_SKEW_SECONDS ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > MAX_CALLBACK_TTL_SECONDS
  ) {
    throw new PacketPhoneCallbackError("invalid_token");
  }
  return claims;
}

function decodeUntrustedClaims(token: string): PacketPhoneControlClaims {
  if (!token || token.length > 16_384) {
    throw new PacketPhoneCallbackError("invalid_token");
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1].length > 12_000) {
    throw new PacketPhoneCallbackError("invalid_token");
  }
  try {
    return parseClaims(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
  } catch {
    throw new PacketPhoneCallbackError("invalid_token");
  }
}

function parseClaims(value: unknown): PacketPhoneControlClaims {
  if (
    !isRecord(value) ||
    value.v !== 1 ||
    value.iss !== PACKETPHONE_CALLBACK_ISSUER ||
    value.aud !== PACKETPHONE_CALLBACK_AUDIENCE ||
    !isControlAction(value.action) ||
    !isSafeInteger(value.iat) ||
    !isSafeInteger(value.exp) ||
    !isSafeInteger(value.expectedRevision) ||
    value.expectedRevision < 1 ||
    !isWorkspaceRole(value.actorRole) ||
    !(value.attentionRequestId === null || isRequiredClaim(value.attentionRequestId))
  ) {
    throw new PacketPhoneCallbackError("invalid_token");
  }
  return {
    v: 1,
    iss: PACKETPHONE_CALLBACK_ISSUER,
    aud: PACKETPHONE_CALLBACK_AUDIENCE,
    sub: requiredClaim(value.sub),
    iat: value.iat,
    exp: value.exp,
    jti: requiredClaim(value.jti),
    nonce: requiredClaim(value.nonce),
    action: value.action,
    workspaceId: requiredClaim(value.workspaceId),
    workerDefinitionId: requiredClaim(value.workerDefinitionId),
    workerDeploymentId: requiredClaim(value.workerDeploymentId),
    workerRunId: requiredClaim(value.workerRunId),
    workerVersionId: requiredClaim(value.workerVersionId),
    workerVersionContentDigest: requiredClaim(value.workerVersionContentDigest),
    attentionRequestId: value.attentionRequestId,
    expectedRevision: value.expectedRevision,
    actorId: requiredClaim(value.actorId),
    actorRole: value.actorRole,
    notificationRouteId: requiredClaim(value.notificationRouteId),
    notificationRouteReference: requiredClaim(value.notificationRouteReference),
    sourceEventId: requiredClaim(value.sourceEventId),
    sourceEventDigest: requiredClaim(value.sourceEventDigest),
  };
}

function parseAllowedActions(value: unknown, actorRole: WorkspaceRole): PacketPhoneControlAction[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 5 ||
    !value.every(isControlAction) ||
    new Set(value).size !== value.length ||
    !value.every((action) => roleAllowsAction(actorRole, action))
  ) {
    throw new Error("PacketPhone route configuration is invalid.");
  }
  return [...value];
}

function roleAllowsAction(role: WorkspaceRole, action: PacketPhoneControlAction): boolean {
  const permission: WorkspacePermission =
    action === "revoke_deployment"
      ? "controlWorkerDeployments"
      : action === "approve_once" || action === "reject_attention"
        ? "approveWorkerActions"
        : "controlWorkerRuns";
  return hasWorkspacePermission({ role }, permission);
}

function requireAttention(context: BoundWorkerContext): WorkerAttentionRequest {
  if (!context.attention) {
    throw new PacketPhoneCallbackError("binding_mismatch");
  }
  return context.attention;
}

function actionLabel(action: PacketPhoneControlAction): string {
  return (
    {
      approve_once: "Approve once",
      reject_attention: "Reject",
      pause_run: "Pause",
      stop_run: "Stop",
      revoke_deployment: "Revoke deployment",
    } as const
  )[action];
}

function boundedText(value: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, Math.max(0, maximum - 1))}…`;
}

function absoluteUrl(base: string, path: string): string {
  return new URL(path, ensureTrailingSlash(base)).toString();
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function assertHttpUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PacketPhone route configuration is invalid.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("PacketPhone route configuration is invalid.");
  }
}

function assertCallbackBaseUrl(value: string): void {
  assertHttpsUrl(value);
  const url = new URL(value);
  if ((url.pathname !== "" && url.pathname !== "/") || url.search || url.hash) {
    throw new Error("PacketPhone route configuration is invalid.");
  }
}

function assertHttpsUrl(value: string): void {
  assertHttpUrl(value);
  if (new URL(value).protocol !== "https:") {
    throw new Error("PacketPhone route configuration is invalid.");
  }
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 8_192) {
    throw new Error("PacketPhone route configuration is invalid.");
  }
  return value.trim();
}

function requiredClaim(value: unknown): string {
  if (!isRequiredClaim(value)) {
    throw new PacketPhoneCallbackError("invalid_token");
  }
  return value;
}

function isRequiredClaim(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const selected = value ?? fallback;
  if (
    typeof selected !== "number" ||
    !Number.isSafeInteger(selected) ||
    selected < minimum ||
    selected > maximum
  ) {
    throw new Error("PacketPhone route configuration is invalid.");
  }
  return selected;
}

function stringOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value) {
    throw new WorkerLifecycleError("integrity", "PacketPhone attention binding is invalid.");
  }
  return value;
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function digestString(value: string): string {
  return `sha256:${digestHex(value)}`;
}

function digestHex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isControlAction(value: unknown): value is PacketPhoneControlAction {
  return (
    value === "approve_once" ||
    value === "reject_attention" ||
    value === "pause_run" ||
    value === "stop_run" ||
    value === "revoke_deployment"
  );
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
