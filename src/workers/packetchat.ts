import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { loadStoreAsync as defaultLoadStore, type PacketAgentData } from "../packetagent-store.js";
import { createWorkerCredentialService, type WorkerCredentialService } from "./credentials.js";
import type { WorkerNotificationEnvelope } from "./control-types.js";
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
import {
  createWorkerOperationsReadModel,
  type WorkerOperationsReadModel,
  type WorkerRunDetailReadModel,
} from "./observability/read-model.js";
import { validateWorkerPersistence } from "./repository.js";
import type {
  WorkerCheckpoint,
  WorkerDeployment,
  WorkerNotificationRouteReference,
  WorkerRun,
  WorkerVersion,
} from "./types.js";

type MaybePromise<T> = T | Promise<T>;

export const PACKETCHAT_ROUTE_SCHEMA_VERSION = "packetagent.packetchat-route/v1" as const;
export const PACKETCHAT_MESSAGE_SCHEMA_VERSION =
  "packetagent.packetchat-worker-message/v1" as const;
export const PACKETCHAT_CALLBACK_ISSUER = "PacketAgent" as const;
export const PACKETCHAT_CALLBACK_AUDIENCE = "PacketChat" as const;
export const PACKETCHAT_CALLBACK_PATH = "/api/packet-products/packetchat/worker-callback" as const;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CALLBACK_TTL_SECONDS = 10 * 60;
const MAX_CONFIG_BYTES = 32 * 1_024;
const MAX_TITLE_LENGTH = 160;
const MAX_SUMMARY_LENGTH = 1_000;
const CLOCK_SKEW_SECONDS = 60;

export interface PacketChatRouteConfig {
  readonly schemaVersion: typeof PACKETCHAT_ROUTE_SCHEMA_VERSION;
  readonly endpoint: string;
  readonly bearerToken?: string;
  readonly callbackBaseUrl: string;
  readonly callbackSecret: string;
  readonly timeoutMs: number;
  readonly callbackTtlSeconds: number;
}

export interface PacketChatWorkerMessage {
  readonly schemaVersion: typeof PACKETCHAT_MESSAGE_SCHEMA_VERSION;
  readonly thread: {
    readonly key: string;
    readonly messageKey: string;
    readonly behavior: "append" | "replace";
  };
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
    readonly run: WorkerRun["status"];
    readonly version: WorkerVersion["status"];
    readonly versionNumber: number;
    readonly reason?: string;
  };
  readonly budget: {
    readonly usage: WorkerRun["budgetUsage"];
    readonly limits: WorkerVersion["content"]["policy"]["budgets"];
  };
  readonly checkpoint?: {
    readonly id: string;
    readonly sequence: number;
    readonly phase: WorkerCheckpoint["cursor"]["phase"];
    readonly iteration: number;
    readonly stateDigest: string;
  };
  readonly evidence: {
    readonly id: string;
    readonly href: string;
  };
  readonly requiredAction: string;
  readonly title: string;
  readonly summary: string;
  readonly callbacks: {
    readonly open: string;
    readonly inspect: string;
  };
}

type PacketChatCallbackAction = "open" | "inspect";

interface PacketChatCallbackClaims {
  readonly v: 1;
  readonly iss: typeof PACKETCHAT_CALLBACK_ISSUER;
  readonly aud: typeof PACKETCHAT_CALLBACK_AUDIENCE;
  readonly sub: string;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
  readonly action: PacketChatCallbackAction;
  readonly workspaceId: string;
  readonly workerDefinitionId: string;
  readonly workerDeploymentId: string;
  readonly workerRunId: string;
  readonly workerVersionId: string;
  readonly workerVersionContentDigest: string;
  readonly notificationRouteId: string;
  readonly notificationRouteReference: string;
}

interface BoundWorkerContext {
  readonly run: WorkerRun;
  readonly version: WorkerVersion;
  readonly deployment: WorkerDeployment;
  readonly route: WorkerNotificationRouteReference;
  readonly checkpoint?: WorkerCheckpoint;
}

export interface PacketChatDependencies {
  readonly loadStore?: () => MaybePromise<PacketAgentData>;
  readonly credentialService?: WorkerCredentialService;
  readonly network?: WorkerNetworkPort;
  readonly readModel?: WorkerOperationsReadModel;
  readonly now?: () => Date;
}

export interface PacketChatCallbackResult {
  readonly action: PacketChatCallbackAction;
  readonly openUrl?: string;
  readonly detail?: WorkerRunDetailReadModel;
}

export class PacketChatCallbackError extends Error {
  readonly code: "invalid_token" | "expired_token" | "binding_mismatch";
  readonly status = 401 as const;

  constructor(code: PacketChatCallbackError["code"]) {
    super("PacketChat Worker callback authentication failed.");
    this.name = "PacketChatCallbackError";
    this.code = code;
  }
}

export function createPacketChatNotificationTransport(
  dependencies: PacketChatDependencies = {},
): WorkerNotificationTransport {
  const loadStore = dependencies.loadStore ?? defaultLoadStore;
  const credentialService = dependencies.credentialService ?? createWorkerCredentialService();
  const network = dependencies.network ?? createWorkerNetworkClient();
  const now = dependencies.now ?? (() => new Date());

  return {
    async deliver(input) {
      if (input.route.kind !== "packetchat") {
        throw new WorkerNotificationDeliveryError("packetchat_route_mismatch", false);
      }
      let context: BoundWorkerContext;
      try {
        context = await resolveBoundContext(loadStore, input.envelope, input.route);
      } catch {
        throw new WorkerNotificationDeliveryError("packetchat_binding_invalid", false);
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
            const config = parsePacketChatRouteConfig(rawConfig);
            const message = buildPacketChatMessage(context, input.envelope, config, now());
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
                  `packetchat_network_${error.code}`,
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
                `packetchat_http_${response.status}`,
                retryable,
              );
            }
            return {
              deliveryReference:
                response.headers["x-request-id"] ??
                response.headers["request-id"] ??
                `packetchat:${input.envelope.id}`,
              metadata: {
                provider: "packetchat",
                responseCode: response.status,
              },
            };
          },
        );
      } catch (error) {
        if (error instanceof WorkerNotificationDeliveryError) throw error;
        throw new WorkerNotificationDeliveryError("packetchat_route_config_invalid", false);
      }
    },
  };
}

export function createPacketChatCallbackService(dependencies: PacketChatDependencies = {}): {
  authenticate(token: string): Promise<PacketChatCallbackResult>;
} {
  const loadStore = dependencies.loadStore ?? defaultLoadStore;
  const credentialService = dependencies.credentialService ?? createWorkerCredentialService();
  const readModel = dependencies.readModel ?? createWorkerOperationsReadModel({ loadStore });
  const now = dependencies.now ?? (() => new Date());

  return {
    async authenticate(token) {
      const untrusted = decodeUntrustedClaims(token);
      const data = await loadStore();
      validateWorkerPersistence(data);
      const context = resolveCallbackContext(data, untrusted);
      return credentialService
        .use<PacketChatCallbackResult>(
          {
            workspaceId: context.run.workspaceId,
            reference: context.route.reference,
            declaredCredentialRefs: context.version.content.credentialRefs,
            expectedKinds: ["opaque"],
          },
          async (rawConfig) => {
            let config: PacketChatRouteConfig;
            try {
              config = parsePacketChatRouteConfig(rawConfig);
            } catch {
              throw new PacketChatCallbackError("binding_mismatch");
            }
            const claims = verifyCallbackToken(token, config.callbackSecret, now());
            assertClaimsBound(claims, context);
            if (claims.action === "open") {
              return {
                action: "open",
                openUrl: absoluteUrl(
                  config.callbackBaseUrl,
                  `/runs/worker/${encodeURIComponent(context.run.id)}`,
                ),
              };
            }
            return {
              action: "inspect",
              detail: await readModel.getRun(context.run.workspaceId, context.run.id),
            };
          },
        )
        .catch((error: unknown) => {
          if (error instanceof PacketChatCallbackError) throw error;
          throw new PacketChatCallbackError("binding_mismatch");
        });
    },
  };
}

export function parsePacketChatRouteConfig(raw: string): PacketChatRouteConfig {
  if (!raw || Buffer.byteLength(raw, "utf8") > MAX_CONFIG_BYTES) {
    throw new Error("PacketChat route configuration is invalid.");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("PacketChat route configuration is invalid.");
  }
  if (!isRecord(value) || value.schemaVersion !== PACKETCHAT_ROUTE_SCHEMA_VERSION) {
    throw new Error("PacketChat route configuration is invalid.");
  }
  const endpoint = requiredString(value.endpoint);
  const callbackBaseUrl = requiredString(value.callbackBaseUrl);
  const callbackSecret = requiredString(value.callbackSecret);
  const bearerToken =
    value.bearerToken === undefined ? undefined : requiredString(value.bearerToken);
  const timeoutMs = boundedInteger(value.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 60_000);
  const callbackTtlSeconds = boundedInteger(
    value.callbackTtlSeconds,
    DEFAULT_CALLBACK_TTL_SECONDS,
    60,
    15 * 60,
  );
  assertHttpUrl(endpoint);
  assertCallbackBaseUrl(callbackBaseUrl);
  const callbackSecretBytes = Buffer.byteLength(callbackSecret, "utf8");
  if (callbackSecretBytes < 32 || callbackSecretBytes > 4_096) {
    throw new Error("PacketChat route configuration is invalid.");
  }
  return {
    schemaVersion: PACKETCHAT_ROUTE_SCHEMA_VERSION,
    endpoint,
    ...(bearerToken ? { bearerToken } : {}),
    callbackBaseUrl,
    callbackSecret,
    timeoutMs,
    callbackTtlSeconds,
  };
}

function buildPacketChatMessage(
  context: BoundWorkerContext,
  envelope: WorkerNotificationEnvelope,
  config: PacketChatRouteConfig,
  issuedAt: Date,
): PacketChatWorkerMessage {
  const progress = envelope.event === "progress";
  const makeCallback = (action: PacketChatCallbackAction): string => {
    const token = signCallbackToken(
      makeCallbackClaims(context, action, issuedAt, config.callbackTtlSeconds),
      config.callbackSecret,
    );
    const callback = new URL(absoluteUrl(config.callbackBaseUrl, PACKETCHAT_CALLBACK_PATH));
    callback.searchParams.set("token", token);
    return callback.toString();
  };
  return {
    schemaVersion: PACKETCHAT_MESSAGE_SCHEMA_VERSION,
    thread: {
      key: envelope.threadKey,
      messageKey: progress ? `${envelope.threadKey}:progress` : envelope.id,
      behavior: progress ? "replace" : "append",
    },
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
      run: context.run.status,
      version: context.version.status,
      versionNumber: context.version.version,
      ...(context.run.terminalReason || context.deployment.statusReason
        ? {
            reason:
              context.run.terminalReason ??
              boundedText(context.deployment.statusReason!, MAX_SUMMARY_LENGTH),
          }
        : {}),
    },
    budget: {
      usage: context.run.budgetUsage,
      limits: context.version.content.policy.budgets,
    },
    ...(context.checkpoint
      ? {
          checkpoint: {
            id: context.checkpoint.id,
            sequence: context.checkpoint.sequence,
            phase: context.checkpoint.cursor.phase,
            iteration: context.checkpoint.cursor.iteration,
            stateDigest: context.checkpoint.stateDigest,
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
    requiredAction: requiredAction(envelope),
    title: boundedText(envelope.title, MAX_TITLE_LENGTH),
    summary: boundedText(envelope.summary, MAX_SUMMARY_LENGTH),
    callbacks: {
      open: makeCallback("open"),
      inspect: makeCallback("inspect"),
    },
  };
}

async function resolveBoundContext(
  loadStore: () => MaybePromise<PacketAgentData>,
  envelope: WorkerNotificationEnvelope,
  requestedRoute: WorkerNotificationRouteReference,
): Promise<BoundWorkerContext> {
  const data = await loadStore();
  validateWorkerPersistence(data);
  const run = data.workerRuns.find(
    (record) => record.workspaceId === envelope.workspaceId && record.id === envelope.workerRunId,
  );
  if (
    !run ||
    run.workerDefinitionId !== envelope.workerDefinitionId ||
    run.workerDeploymentId !== envelope.workerDeploymentId ||
    run.workerVersionId !== envelope.workerVersionId
  ) {
    throw new WorkerLifecycleError("integrity", "PacketChat run binding is invalid.");
  }
  const version = data.workerVersions.find(
    (record) =>
      record.workspaceId === run.workspaceId &&
      record.id === run.workerVersionId &&
      record.workerDefinitionId === run.workerDefinitionId,
  );
  const deployment = data.workerDeployments.find(
    (record) =>
      record.workspaceId === run.workspaceId &&
      record.id === run.workerDeploymentId &&
      record.workerDefinitionId === run.workerDefinitionId &&
      record.workerVersionId === run.workerVersionId,
  );
  if (!version || !deployment || version.contentDigest !== envelope.workerVersionContentDigest) {
    throw new WorkerLifecycleError("integrity", "PacketChat version binding is invalid.");
  }
  const route = version.content.notificationRoutes.find(
    (record) =>
      record.kind === "packetchat" &&
      record.id === requestedRoute.id &&
      record.reference === requestedRoute.reference &&
      record.events.includes(envelope.event),
  );
  if (!route || !version.content.credentialRefs.includes(route.reference)) {
    throw new WorkerLifecycleError("integrity", "PacketChat route binding is invalid.");
  }
  const checkpoint = latestCheckpoint(data, run);
  return { run, version, deployment, route, ...(checkpoint ? { checkpoint } : {}) };
}

function resolveCallbackContext(
  data: PacketAgentData,
  claims: PacketChatCallbackClaims,
): BoundWorkerContext {
  const run = data.workerRuns.find(
    (record) => record.workspaceId === claims.workspaceId && record.id === claims.workerRunId,
  );
  const version = data.workerVersions.find(
    (record) => record.workspaceId === claims.workspaceId && record.id === claims.workerVersionId,
  );
  const deployment = data.workerDeployments.find(
    (record) =>
      record.workspaceId === claims.workspaceId && record.id === claims.workerDeploymentId,
  );
  const route = version?.content.notificationRoutes.find(
    (record) =>
      record.kind === "packetchat" &&
      record.id === claims.notificationRouteId &&
      record.reference === claims.notificationRouteReference,
  );
  if (!run || !version || !deployment || !route) {
    throw new PacketChatCallbackError("binding_mismatch");
  }
  const checkpoint = latestCheckpoint(data, run);
  const context: BoundWorkerContext = {
    run,
    version,
    deployment,
    route,
    ...(checkpoint ? { checkpoint } : {}),
  };
  assertClaimsBound(claims, context);
  return context;
}

function assertClaimsBound(claims: PacketChatCallbackClaims, context: BoundWorkerContext): void {
  if (
    claims.sub !== context.run.id ||
    claims.workspaceId !== context.run.workspaceId ||
    claims.workerDefinitionId !== context.run.workerDefinitionId ||
    claims.workerDeploymentId !== context.run.workerDeploymentId ||
    claims.workerRunId !== context.run.id ||
    claims.workerVersionId !== context.run.workerVersionId ||
    claims.workerVersionContentDigest !== context.version.contentDigest ||
    claims.workerDefinitionId !== context.version.workerDefinitionId ||
    context.deployment.workerDefinitionId !== context.run.workerDefinitionId ||
    context.deployment.workerVersionId !== context.run.workerVersionId ||
    claims.notificationRouteId !== context.route.id ||
    claims.notificationRouteReference !== context.route.reference ||
    !context.version.content.credentialRefs.includes(context.route.reference)
  ) {
    throw new PacketChatCallbackError("binding_mismatch");
  }
}

function latestCheckpoint(data: PacketAgentData, run: WorkerRun): WorkerCheckpoint | undefined {
  if (run.latestCheckpointId) {
    return data.workerCheckpoints.find(
      (record) =>
        record.workspaceId === run.workspaceId &&
        record.workerRunId === run.id &&
        record.id === run.latestCheckpointId &&
        record.workerVersionId === run.workerVersionId,
    );
  }
  return data.workerCheckpoints
    .filter(
      (record) =>
        record.workspaceId === run.workspaceId &&
        record.workerRunId === run.id &&
        record.workerVersionId === run.workerVersionId,
    )
    .sort((left, right) => right.sequence - left.sequence)[0];
}

function makeCallbackClaims(
  context: BoundWorkerContext,
  action: PacketChatCallbackAction,
  now: Date,
  ttlSeconds: number,
): PacketChatCallbackClaims {
  const iat = Math.floor(now.getTime() / 1_000);
  const stableBinding = [
    action,
    context.run.workspaceId,
    context.run.workerDeploymentId,
    context.run.id,
    context.version.contentDigest,
    context.route.id,
  ].join(":");
  return {
    v: 1,
    iss: PACKETCHAT_CALLBACK_ISSUER,
    aud: PACKETCHAT_CALLBACK_AUDIENCE,
    sub: context.run.id,
    iat,
    exp: iat + ttlSeconds,
    jti: createHash("sha256").update(stableBinding).update(String(iat)).digest("hex"),
    action,
    workspaceId: context.run.workspaceId,
    workerDefinitionId: context.run.workerDefinitionId,
    workerDeploymentId: context.run.workerDeploymentId,
    workerRunId: context.run.id,
    workerVersionId: context.run.workerVersionId,
    workerVersionContentDigest: context.version.contentDigest,
    notificationRouteId: context.route.id,
    notificationRouteReference: context.route.reference,
  };
}

function signCallbackToken(claims: PacketChatCallbackClaims, secret: string): string {
  const header = encodeBase64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = encodeBase64Url(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

function verifyCallbackToken(token: string, secret: string, now: Date): PacketChatCallbackClaims {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new PacketChatCallbackError("invalid_token");
  }
  let header: unknown;
  let claims: PacketChatCallbackClaims;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    claims = parseClaims(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
  } catch {
    throw new PacketChatCallbackError("invalid_token");
  }
  if (
    !isRecord(header) ||
    header.alg !== "HS256" ||
    header.typ !== "JWT" ||
    Object.keys(header).some((key) => !["alg", "typ"].includes(key))
  ) {
    throw new PacketChatCallbackError("invalid_token");
  }
  const expected = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(parts[2], "base64url");
  } catch {
    throw new PacketChatCallbackError("invalid_token");
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new PacketChatCallbackError("invalid_token");
  }
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  if (claims.exp <= nowSeconds) {
    throw new PacketChatCallbackError("expired_token");
  }
  if (
    claims.iat > nowSeconds + CLOCK_SKEW_SECONDS ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > 15 * 60
  ) {
    throw new PacketChatCallbackError("invalid_token");
  }
  return claims;
}

function decodeUntrustedClaims(token: string): PacketChatCallbackClaims {
  if (!token || token.length > 16_384) {
    throw new PacketChatCallbackError("invalid_token");
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1].length > 12_000) {
    throw new PacketChatCallbackError("invalid_token");
  }
  try {
    return parseClaims(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
  } catch {
    throw new PacketChatCallbackError("invalid_token");
  }
}

function parseClaims(value: unknown): PacketChatCallbackClaims {
  if (
    !isRecord(value) ||
    value.v !== 1 ||
    value.iss !== PACKETCHAT_CALLBACK_ISSUER ||
    value.aud !== PACKETCHAT_CALLBACK_AUDIENCE ||
    !isCallbackAction(value.action) ||
    !isSafeInteger(value.iat) ||
    !isSafeInteger(value.exp)
  ) {
    throw new PacketChatCallbackError("invalid_token");
  }
  const claims = {
    v: 1,
    iss: PACKETCHAT_CALLBACK_ISSUER,
    aud: PACKETCHAT_CALLBACK_AUDIENCE,
    sub: requiredClaim(value.sub),
    iat: value.iat,
    exp: value.exp,
    jti: requiredClaim(value.jti),
    action: value.action,
    workspaceId: requiredClaim(value.workspaceId),
    workerDefinitionId: requiredClaim(value.workerDefinitionId),
    workerDeploymentId: requiredClaim(value.workerDeploymentId),
    workerRunId: requiredClaim(value.workerRunId),
    workerVersionId: requiredClaim(value.workerVersionId),
    workerVersionContentDigest: requiredClaim(value.workerVersionContentDigest),
    notificationRouteId: requiredClaim(value.notificationRouteId),
    notificationRouteReference: requiredClaim(value.notificationRouteReference),
  } satisfies PacketChatCallbackClaims;
  return claims;
}

function requiredAction(envelope: WorkerNotificationEnvelope): string {
  const supplied = envelope.data.requiredAction;
  if (typeof supplied === "string" && supplied.trim()) {
    return boundedText(supplied, 240);
  }
  return envelope.event === "attention" ? "inspect" : "none";
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
    throw new Error("PacketChat route configuration is invalid.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("PacketChat route configuration is invalid.");
  }
}

function assertCallbackBaseUrl(value: string): void {
  assertHttpUrl(value);
  const url = new URL(value);
  if ((url.pathname !== "" && url.pathname !== "/") || url.search || url.hash) {
    throw new Error("PacketChat route configuration is invalid.");
  }
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 8_192) {
    throw new Error("PacketChat route configuration is invalid.");
  }
  return value.trim();
}

function requiredClaim(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4_096) {
    throw new PacketChatCallbackError("invalid_token");
  }
  return value;
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
    throw new Error("PacketChat route configuration is invalid.");
  }
  return selected;
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function isCallbackAction(value: unknown): value is PacketChatCallbackAction {
  return value === "open" || value === "inspect";
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
