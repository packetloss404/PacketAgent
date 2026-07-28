import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  loadStoreAsync as defaultLoadStore,
  mutateStoreAsync as defaultMutateStore,
  recordActivity,
  upsertRateLimit,
  type ActivityRecord,
  type PacketAgentData,
} from "../../packetagent-store.js";
import {
  compileWorkerCapabilityPolicy,
  WorkerCapabilityCompilationError,
} from "../capabilities.js";
import type { WorkerContractIssue } from "../validation.js";
import { canonicalWorkerJson, computeWorkerVersionContentDigest } from "../validation.js";
import type { WorkerActorReference, WorkerDeploymentCapabilityGrant } from "../types.js";
import { verifyWorkerPackage, type VerifyWorkerPackageOptions } from "./validation.js";
import {
  PACKET_PRODUCT_CREDENTIAL_SCHEMA_VERSION,
  PACKET_PRODUCT_OPERATIONS,
  WORKER_PACKAGE_RECEIPT_SCHEMA_VERSION,
  assertValidPacketProductCredentialRecord,
  assertValidWorkerPackageReceipt,
  packetProductCredentialMetadata,
  type PacketProductCredentialMetadata,
  type PacketProductCredentialRecord,
  type PacketProductOperation,
  type WorkerPackageReceipt,
} from "./trust-types.js";
import type { WorkerPackage, WorkerPackageSignatureVerificationInput } from "./types.js";

type MaybePromise<T> = T | Promise<T>;

const DEFAULT_WRITE_RATE_LIMIT = {
  maxAttempts: 120,
  windowMs: 60_000,
  maxBuckets: 5_000,
} as const;

interface PacketProductWriteRateLimit {
  readonly maxAttempts: number;
  readonly windowMs: number;
  readonly maxBuckets: number;
}

export type PacketProductTrustErrorCode =
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "not_found"
  | "invalid_input"
  | "invalid_package"
  | "capability_rejected"
  | "idempotency_mismatch"
  | "package_conflict";

export class PacketProductTrustError extends Error {
  constructor(
    readonly code: PacketProductTrustErrorCode,
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 429,
    readonly options: {
      readonly retryAt?: string;
      readonly issues?: readonly WorkerContractIssue[];
    } = {},
  ) {
    super(message);
    this.name = "PacketProductTrustError";
  }
}

export interface PacketProductAuthContext {
  readonly workspaceId: string;
  readonly credentialId: string;
  readonly product: "PacketADE";
  readonly actor: WorkerActorReference & {
    readonly type: "packet_product";
    readonly product: "PacketADE";
  };
  readonly operation: PacketProductOperation;
  readonly requirePackageSignature: boolean;
}

export interface IssuePacketProductCredentialInput {
  readonly workspaceId: string;
  readonly subjectId: string;
  readonly displayName?: string;
  readonly allowedOperations: readonly PacketProductOperation[];
  readonly requirePackageSignature?: boolean;
  readonly expiresAt?: string;
  readonly createdBy: WorkerActorReference;
}

export interface IssuedPacketProductCredential {
  readonly credential: PacketProductCredentialMetadata;
  /**
   * Returned once. PacketAgent persists only its one-way digest.
   */
  readonly token: string;
}

export interface AcceptWorkerPackageInput {
  readonly authorization: string | null | undefined;
  readonly workspaceId: string;
  readonly workerPackage: unknown;
  /**
   * Explicit local acceptance. These IDs must be a subset of the package's
   * own default-deny allow list.
   */
  readonly acceptedCapabilityIds: readonly string[];
  /**
   * Optional further narrowing of verbs/resources/approval. When omitted,
   * the accepted package bounds are used unchanged.
   */
  readonly capabilityGrants?: readonly WorkerDeploymentCapabilityGrant[];
}

export interface AcceptedWorkerPackage {
  readonly receipt: WorkerPackageReceipt;
  readonly replayed: boolean;
}

export interface AuthorizePacketProductWriteInput {
  readonly authorization: string | null | undefined;
  readonly workspaceId: string;
  readonly operation: PacketProductOperation;
}

export interface PacketProductTrustService {
  issueCredential(input: IssuePacketProductCredentialInput): Promise<IssuedPacketProductCredential>;
  revokeCredential(input: {
    readonly workspaceId: string;
    readonly credentialId: string;
    readonly revokedBy: WorkerActorReference;
  }): Promise<PacketProductCredentialMetadata>;
  authenticate(input: AuthorizePacketProductWriteInput): Promise<PacketProductAuthContext>;
  authorizeWrite(input: AuthorizePacketProductWriteInput): Promise<PacketProductAuthContext>;
  acceptPackage(input: AcceptWorkerPackageInput): Promise<AcceptedWorkerPackage>;
}

export interface PacketProductTrustDependencies {
  readonly loadStore?: () => MaybePromise<PacketAgentData>;
  readonly mutateStore?: <T>(
    mutator: (data: PacketAgentData) => MaybePromise<T>,
  ) => MaybePromise<T>;
  readonly now?: () => string;
  readonly generateId?: (kind: "credential" | "receipt" | "activity") => string;
  readonly generateSecret?: () => string;
  readonly verifySignature?: VerifyWorkerPackageOptions["verifySignature"];
  readonly writeRateLimit?: Partial<PacketProductWriteRateLimit>;
}

export function createPacketProductTrustService(
  dependencies: PacketProductTrustDependencies = {},
): PacketProductTrustService {
  const loadStore = dependencies.loadStore ?? defaultLoadStore;
  const mutateStore = dependencies.mutateStore ?? defaultMutateStore;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const generateId =
    dependencies.generateId ??
    ((kind: "credential" | "receipt" | "activity") => `${idPrefix(kind)}_${randomUUID()}`);
  const generateSecret =
    dependencies.generateSecret ?? (() => randomBytes(32).toString("base64url"));
  const rateLimit = {
    ...DEFAULT_WRITE_RATE_LIMIT,
    ...dependencies.writeRateLimit,
  };

  async function issueCredential(
    input: IssuePacketProductCredentialInput,
  ): Promise<IssuedPacketProductCredential> {
    requireNonEmpty(input.workspaceId, "workspaceId");
    requireNonEmpty(input.subjectId, "subjectId");
    requireActor(input.createdBy, "createdBy");
    const allowedOperations = validateOperations(input.allowedOperations);
    const timestamp = now();
    if (
      input.expiresAt !== undefined &&
      (!isCanonicalTimestamp(input.expiresAt) || input.expiresAt <= timestamp)
    ) {
      throw trustError("invalid_input", "expiresAt must be a future canonical timestamp.");
    }
    const credentialId = generateId("credential");
    if (!credentialId || credentialId.includes(".")) {
      throw trustError(
        "invalid_input",
        "Generated credential IDs must be non-empty and exclude dots.",
      );
    }
    const secret = generateSecret();
    if (!/^[A-Za-z0-9_-]{32,}$/.test(secret)) {
      throw trustError(
        "invalid_input",
        "Generated credential secrets must be high-entropy base64url.",
      );
    }
    const token = packetProductToken(credentialId, secret);
    const record: PacketProductCredentialRecord = {
      schemaVersion: PACKET_PRODUCT_CREDENTIAL_SCHEMA_VERSION,
      id: credentialId,
      workspaceId: input.workspaceId,
      product: "PacketADE",
      subjectId: input.subjectId,
      ...(input.displayName?.trim() ? { displayName: input.displayName.trim() } : {}),
      tokenDigest: digestPacketProductToken(credentialId, secret),
      allowedOperations,
      requirePackageSignature: input.requirePackageSignature ?? false,
      status: "active",
      createdBy: structuredClone(input.createdBy),
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    };
    assertValidPacketProductCredentialRecord(record);

    await mutateStore((data) => {
      if (!data.workspaces.some((workspace) => workspace.id === input.workspaceId)) {
        throw trustError("invalid_input", "The Packet-product workspace does not exist.");
      }
      if (
        data.packetProductCredentials.some(
          (credential) =>
            credential.workspaceId === record.workspaceId && credential.id === record.id,
        )
      ) {
        throw trustError("invalid_input", "The generated Packet-product credential ID conflicts.");
      }
      data.packetProductCredentials.push(record);
      recordTrustActivity(data, {
        id: generateId("activity"),
        workspaceId: record.workspaceId,
        actor: input.createdBy,
        event: "packet_product.credential_issued",
        occurredAt: timestamp,
        data: {
          title: "PacketADE service credential issued",
          product: record.product,
          credentialId: record.id,
          subjectId: record.subjectId,
          signatureRequired: record.requirePackageSignature,
        },
      });
    });

    return {
      credential: packetProductCredentialMetadata(record),
      token,
    };
  }

  async function revokeCredential(input: {
    readonly workspaceId: string;
    readonly credentialId: string;
    readonly revokedBy: WorkerActorReference;
  }): Promise<PacketProductCredentialMetadata> {
    requireActor(input.revokedBy, "revokedBy");
    const timestamp = now();
    const record = await mutateStore((data) => {
      const index = data.packetProductCredentials.findIndex(
        (credential) =>
          credential.workspaceId === input.workspaceId && credential.id === input.credentialId,
      );
      if (index < 0) {
        throw trustError("invalid_input", "Packet-product credential was not found.");
      }
      const existing = data.packetProductCredentials[index]!;
      const revoked: PacketProductCredentialRecord =
        existing.status === "revoked"
          ? existing
          : {
              ...existing,
              status: "revoked",
              revokedAt: timestamp,
              updatedAt: timestamp,
            };
      assertValidPacketProductCredentialRecord(revoked);
      data.packetProductCredentials[index] = revoked;
      recordTrustActivity(data, {
        id: generateId("activity"),
        workspaceId: input.workspaceId,
        actor: input.revokedBy,
        event: "packet_product.credential_revoked",
        occurredAt: timestamp,
        data: {
          title: "PacketADE service credential revoked",
          product: revoked.product,
          credentialId: revoked.id,
          subjectId: revoked.subjectId,
        },
      });
      return revoked;
    });
    return packetProductCredentialMetadata(record);
  }

  async function authenticate(
    input: AuthorizePacketProductWriteInput,
  ): Promise<PacketProductAuthContext> {
    validateAuthorizationInput(input);
    const data = await loadStore();
    const authenticated = authenticateCredential(
      data,
      input.authorization,
      input.workspaceId,
      now(),
    );
    assertOperationAllowed(authenticated.credential, input.operation);
    return authContext(authenticated.credential, input.operation);
  }

  async function authorizeWrite(
    input: AuthorizePacketProductWriteInput,
  ): Promise<PacketProductAuthContext> {
    validateAuthorizationInput(input);
    const timestamp = now();
    const decision = await mutateStore((data) => {
      const authenticated = authenticateCredential(
        data,
        input.authorization,
        input.workspaceId,
        timestamp,
      );
      const context = authContext(authenticated.credential, input.operation);
      if (!authenticated.credential.allowedOperations.includes(input.operation)) {
        recordAuthorizationActivity(data, generateId("activity"), context, timestamp, "denied");
        return {
          ok: false as const,
          error: new PacketProductTrustError(
            "forbidden",
            "The Packet-product credential does not allow this operation.",
            403,
          ),
        };
      }

      const limitedUntil = upsertRateLimit(data, {
        bucketId: writeRateLimitBucket(input.workspaceId, authenticated.credential.id),
        maxAttempts: positiveInteger(rateLimit.maxAttempts, DEFAULT_WRITE_RATE_LIMIT.maxAttempts),
        windowMs: positiveInteger(rateLimit.windowMs, DEFAULT_WRITE_RATE_LIMIT.windowMs),
        timestamp: Date.parse(timestamp),
        maxBuckets: positiveInteger(rateLimit.maxBuckets, DEFAULT_WRITE_RATE_LIMIT.maxBuckets),
      });
      if (limitedUntil !== null) {
        recordAuthorizationActivity(
          data,
          generateId("activity"),
          context,
          timestamp,
          "rate_limited",
        );
        return {
          ok: false as const,
          error: new PacketProductTrustError(
            "rate_limited",
            "Packet-product write rate limit exceeded.",
            429,
            { retryAt: new Date(limitedUntil).toISOString() },
          ),
        };
      }

      recordAuthorizationActivity(data, generateId("activity"), context, timestamp, "authorized");
      return { ok: true as const, context };
    });
    if (!decision.ok) throw decision.error;
    return decision.context;
  }

  async function acceptPackage(input: AcceptWorkerPackageInput): Promise<AcceptedWorkerPackage> {
    if (!Array.isArray(input.acceptedCapabilityIds)) {
      throw trustError(
        "invalid_input",
        "acceptedCapabilityIds must explicitly state the local capability decision.",
      );
    }
    const context = await authorizeWrite({
      authorization: input.authorization,
      workspaceId: input.workspaceId,
      operation: "package.validate",
    });
    const verification = await verifyWorkerPackage(input.workerPackage, {
      requireSignature: context.requirePackageSignature,
      verifySignature: dependencies.verifySignature,
    });
    if (!verification.ok) {
      await recordPackageOutcome(
        mutateStore,
        generateId,
        context,
        now(),
        "worker_package.rejected",
        {
          title: "PacketADE WorkerPackage rejected",
          reason: "integrity",
          issueCount: verification.issues.length,
          firstIssueCode: verification.issues[0]?.code ?? null,
        },
      );
      throw new PacketProductTrustError(
        "invalid_package",
        "WorkerPackage integrity or schema validation failed.",
        400,
        { issues: verification.issues },
      );
    }

    let compilation;
    try {
      assertLocalCapabilitySubset(verification.value, input.acceptedCapabilityIds);
      compilation = compileWorkerCapabilityPolicy({
        workerVersionContentDigest: computeWorkerVersionContentDigest(
          verification.value.worker.content,
        ),
        requestedCapabilities: verification.value.worker.content.tools,
        allowedCapabilityIds: input.acceptedCapabilityIds,
        credentialRefs: verification.value.worker.content.credentialRefs,
        deploymentGrants: input.capabilityGrants,
      });
    } catch (error) {
      const issues =
        error instanceof WorkerCapabilityCompilationError
          ? error.issues.map((issue) => ({
              path: `$.localPolicy.${issue.path}`,
              code: issue.code,
              message: issue.message,
            }))
          : [
              {
                path: "$.localPolicy.acceptedCapabilityIds",
                code: "package.capability.not_locally_accepted",
                message:
                  error instanceof Error ? error.message : "local capability policy rejected",
              },
            ];
      await recordPackageOutcome(
        mutateStore,
        generateId,
        context,
        now(),
        "worker_package.rejected",
        {
          title: "PacketADE WorkerPackage rejected",
          reason: "local_capability_policy",
          issueCount: issues.length,
          firstIssueCode: issues[0]?.code ?? null,
          packageId: verification.value.packageId,
          packageVersion: verification.value.packageVersion,
        },
      );
      throw new PacketProductTrustError(
        "capability_rejected",
        "WorkerPackage capability requests were not accepted by local policy.",
        400,
        { issues },
      );
    }

    const timestamp = now();
    const workerPackage = verification.value;
    const workerVersionContentDigest = computeWorkerVersionContentDigest(
      workerPackage.worker.content,
    );
    const requestDigest = digestRequest({
      packageDigest: workerPackage.integrity.digest,
      credentialId: context.credentialId,
      acceptedCapabilityIds: [...input.acceptedCapabilityIds].sort(),
      grants: compilation.grants,
      policyDigest: compilation.policy.policyDigest,
    });
    const result = await mutateStore((data) => {
      const authenticated = authenticateCredential(
        data,
        input.authorization,
        input.workspaceId,
        timestamp,
      );
      assertOperationAllowed(authenticated.credential, "package.validate");

      const existing = data.workerPackageReceipts.find(
        (receipt) =>
          receipt.workspaceId === input.workspaceId &&
          receipt.idempotencyKey === workerPackage.idempotencyKey,
      );
      if (existing) {
        if (existing.requestDigest !== requestDigest) {
          recordPackageActivity(
            data,
            generateId("activity"),
            context,
            timestamp,
            "worker_package.idempotency_mismatch",
            workerPackage,
            {
              title: "PacketADE WorkerPackage idempotency mismatch",
              receiptId: existing.id,
            },
          );
          return {
            ok: false as const,
            error: trustError(
              "idempotency_mismatch",
              "WorkerPackage idempotency key was already used for a different request.",
            ),
          };
        }
        recordPackageActivity(
          data,
          generateId("activity"),
          context,
          timestamp,
          "worker_package.replayed",
          workerPackage,
          {
            title: "PacketADE WorkerPackage receipt replayed",
            receiptId: existing.id,
          },
        );
        return {
          ok: true as const,
          value: { receipt: structuredClone(existing), replayed: true },
        };
      }

      const conflictingPackage = data.workerPackageReceipts.find(
        (receipt) =>
          receipt.workspaceId === input.workspaceId &&
          receipt.packageId === workerPackage.packageId &&
          receipt.packageVersion === workerPackage.packageVersion &&
          receipt.packageDigest !== workerPackage.integrity.digest,
      );
      if (conflictingPackage) {
        recordPackageActivity(
          data,
          generateId("activity"),
          context,
          timestamp,
          "worker_package.coordinate_conflict",
          workerPackage,
          {
            title: "PacketADE WorkerPackage coordinate conflict",
            receiptId: conflictingPackage.id,
          },
        );
        return {
          ok: false as const,
          error: trustError(
            "package_conflict",
            "WorkerPackage ID and version are already bound to different content.",
          ),
        };
      }

      const receipt: WorkerPackageReceipt = {
        schemaVersion: WORKER_PACKAGE_RECEIPT_SCHEMA_VERSION,
        id: generateId("receipt"),
        workspaceId: input.workspaceId,
        packageId: workerPackage.packageId,
        packageVersion: workerPackage.packageVersion,
        idempotencyKey: workerPackage.idempotencyKey,
        packageDigest: workerPackage.integrity.digest,
        requestDigest,
        workerVersionContentDigest,
        source: structuredClone(workerPackage.source),
        packageCreatedBy: structuredClone(workerPackage.createdBy),
        authenticatedActor: structuredClone(context.actor),
        credentialId: context.credentialId,
        integrity: {
          digestVerified: true,
          signatureRequired: context.requirePackageSignature,
          verifiedSignatures: verification.verifiedSignatures,
          verifiedAt: timestamp,
        },
        capabilityDecision: {
          requestedCapabilityIds: workerPackage.worker.content.tools
            .map((capability) => capability.id)
            .sort(),
          packageAllowedCapabilityIds: [
            ...workerPackage.worker.content.policy.permissions.allowedCapabilityIds,
          ].sort(),
          acceptedCapabilityIds: [...input.acceptedCapabilityIds].sort(),
          grants: structuredClone(compilation.grants),
          compiledPolicy: structuredClone(compilation.policy),
        },
        acceptedAt: timestamp,
      };
      assertValidWorkerPackageReceipt(receipt);
      data.workerPackageReceipts.push(receipt);
      recordPackageActivity(
        data,
        generateId("activity"),
        context,
        timestamp,
        "worker_package.accepted",
        workerPackage,
        {
          title: "PacketADE WorkerPackage accepted",
          receiptId: receipt.id,
          packageDigest: receipt.packageDigest,
          signatureRequired: receipt.integrity.signatureRequired,
          verifiedSignatures: receipt.integrity.verifiedSignatures,
          acceptedCapabilityCount: receipt.capabilityDecision.acceptedCapabilityIds.length,
        },
      );
      return {
        ok: true as const,
        value: { receipt: structuredClone(receipt), replayed: false },
      };
    });
    if (!result.ok) throw result.error;
    return result.value;
  }

  return {
    issueCredential,
    revokeCredential,
    authenticate,
    authorizeWrite,
    acceptPackage,
  };
}

function authenticateCredential(
  data: PacketAgentData,
  authorization: string | null | undefined,
  workspaceId: string,
  timestamp: string,
): { credential: PacketProductCredentialRecord } {
  const token = bearerToken(authorization);
  const parsed = parsePacketProductToken(token);
  const credential = data.packetProductCredentials.find(
    (record) => record.workspaceId === workspaceId && record.id === parsed.credentialId,
  );
  const actualDigest = digestPacketProductToken(parsed.credentialId, parsed.secret);
  const expectedDigest = credential?.tokenDigest ?? `sha256:${"0".repeat(64)}`;
  if (
    !safeEqual(actualDigest, expectedDigest) ||
    !credential ||
    credential.product !== "PacketADE" ||
    credential.status !== "active" ||
    (credential.expiresAt !== undefined && credential.expiresAt <= timestamp)
  ) {
    throw new PacketProductTrustError(
      "unauthorized",
      "Packet-product credentials are invalid or expired.",
      401,
    );
  }
  return { credential };
}

function authContext(
  credential: PacketProductCredentialRecord,
  operation: PacketProductOperation,
): PacketProductAuthContext {
  return {
    workspaceId: credential.workspaceId,
    credentialId: credential.id,
    product: credential.product,
    actor: {
      type: "packet_product",
      id: credential.subjectId,
      ...(credential.displayName ? { displayName: credential.displayName } : {}),
      product: credential.product,
    },
    operation,
    requirePackageSignature: credential.requirePackageSignature,
  };
}

function assertOperationAllowed(
  credential: PacketProductCredentialRecord,
  operation: PacketProductOperation,
): void {
  if (!credential.allowedOperations.includes(operation)) {
    throw new PacketProductTrustError(
      "forbidden",
      "The Packet-product credential does not allow this operation.",
      403,
    );
  }
}

function validateAuthorizationInput(input: AuthorizePacketProductWriteInput): void {
  requireNonEmpty(input.workspaceId, "workspaceId");
  if (!PACKET_PRODUCT_OPERATIONS.includes(input.operation)) {
    throw trustError("invalid_input", "Packet-product operation is invalid.");
  }
}

function validateOperations(
  operations: readonly PacketProductOperation[],
): readonly PacketProductOperation[] {
  if (
    !Array.isArray(operations) ||
    operations.length === 0 ||
    new Set(operations).size !== operations.length ||
    operations.some((operation) => !PACKET_PRODUCT_OPERATIONS.includes(operation))
  ) {
    throw trustError(
      "invalid_input",
      "allowedOperations must contain unique supported Packet-product operations.",
    );
  }
  return [...operations].sort();
}

function assertLocalCapabilitySubset(
  workerPackage: WorkerPackage,
  acceptedCapabilityIds: readonly string[],
): void {
  const packageAllowed = new Set(
    workerPackage.worker.content.policy.permissions.allowedCapabilityIds,
  );
  for (const capabilityId of acceptedCapabilityIds) {
    if (!packageAllowed.has(capabilityId)) {
      throw new Error(
        `Local policy cannot accept ${JSON.stringify(capabilityId)} outside the package allow list.`,
      );
    }
  }
}

function bearerToken(authorization: string | null | undefined): string {
  const match = authorization?.trim().match(/^Bearer +([A-Za-z0-9._~+/-]+=*)$/i);
  if (!match) {
    throw new PacketProductTrustError(
      "unauthorized",
      "A Bearer authorization header is required.",
      401,
    );
  }
  return match[1]!;
}

function parsePacketProductToken(token: string): {
  credentialId: string;
  secret: string;
} {
  const parts = token.split(".");
  if (
    parts.length !== 3 ||
    parts[0] !== "pkade" ||
    !parts[1] ||
    !/^[A-Za-z0-9_-]{32,}$/.test(parts[2] ?? "")
  ) {
    throw new PacketProductTrustError(
      "unauthorized",
      "Packet-product credentials are invalid or expired.",
      401,
    );
  }
  return { credentialId: parts[1], secret: parts[2] };
}

function packetProductToken(credentialId: string, secret: string): string {
  return `pkade.${credentialId}.${secret}`;
}

function digestPacketProductToken(credentialId: string, secret: string): string {
  return `sha256:${createHash("sha256")
    .update("packetagent.packet-product-token/v1\0")
    .update(credentialId)
    .update("\0")
    .update(secret)
    .digest("hex")}`;
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function writeRateLimitBucket(workspaceId: string, credentialId: string): string {
  return `packet-product-write:sha256:${createHash("sha256")
    .update("packetagent.packet-product-write-rate/v1\0")
    .update(workspaceId)
    .update("\0")
    .update(credentialId)
    .digest("hex")}`;
}

function digestRequest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalWorkerJson(value)).digest("hex")}`;
}

function recordAuthorizationActivity(
  data: PacketAgentData,
  id: string,
  context: PacketProductAuthContext,
  occurredAt: string,
  result: "authorized" | "denied" | "rate_limited",
): void {
  recordTrustActivity(data, {
    id,
    workspaceId: context.workspaceId,
    actor: context.actor,
    event: `packet_product.write_${result}`,
    occurredAt,
    data: {
      title: `PacketADE write ${result.replace("_", " ")}`,
      product: context.product,
      credentialId: context.credentialId,
      operation: context.operation,
      result,
    },
  });
}

async function recordPackageOutcome(
  mutateStore: NonNullable<PacketProductTrustDependencies["mutateStore"]>,
  generateId: NonNullable<PacketProductTrustDependencies["generateId"]>,
  context: PacketProductAuthContext,
  occurredAt: string,
  event: string,
  data: ActivityRecord["data"],
): Promise<void> {
  await mutateStore((store) => {
    recordTrustActivity(store, {
      id: generateId("activity"),
      workspaceId: context.workspaceId,
      actor: context.actor,
      event,
      occurredAt,
      data,
    });
  });
}

function recordPackageActivity(
  data: PacketAgentData,
  id: string,
  context: PacketProductAuthContext,
  occurredAt: string,
  event: string,
  workerPackage: WorkerPackage,
  details: ActivityRecord["data"],
): void {
  recordTrustActivity(data, {
    id,
    workspaceId: context.workspaceId,
    actor: context.actor,
    event,
    occurredAt,
    data: {
      ...details,
      product: context.product,
      credentialId: context.credentialId,
      packageId: workerPackage.packageId,
      packageVersion: workerPackage.packageVersion,
    },
  });
}

function recordTrustActivity(
  data: PacketAgentData,
  input: {
    readonly id: string;
    readonly workspaceId: string;
    readonly actor: WorkerActorReference;
    readonly event: string;
    readonly occurredAt: string;
    readonly data: ActivityRecord["data"];
  },
): void {
  recordActivity(data, {
    id: input.id,
    workspaceId: input.workspaceId,
    scope: "workspace",
    actor: input.actor,
    event: input.event,
    occurredAt: input.occurredAt,
    data: input.data,
  });
}

function requireActor(actor: WorkerActorReference, field: string): void {
  if (!actor || !["user", "system", "packet_product"].includes(actor.type) || !actor.id?.trim()) {
    throw trustError("invalid_input", `${field} must identify an actor.`);
  }
}

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw trustError("invalid_input", `${field} is required.`);
  }
}

function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function idPrefix(kind: "credential" | "receipt" | "activity"): string {
  if (kind === "credential") return "packet_product_credential";
  if (kind === "receipt") return "worker_package_receipt";
  return "activity";
}

function trustError(
  code: Exclude<PacketProductTrustErrorCode, "unauthorized" | "forbidden" | "rate_limited">,
  message: string,
): PacketProductTrustError {
  const status = code === "idempotency_mismatch" || code === "package_conflict" ? 409 : 400;
  return new PacketProductTrustError(code, message, status);
}

export type { WorkerPackageSignatureVerificationInput };
