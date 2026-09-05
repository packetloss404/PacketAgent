import type {
  WorkerActorReference,
  WorkerCompiledPolicy,
  WorkerDeploymentCapabilityGrant,
} from "../types.js";
import {
  isPacketProductName,
  isPacketProductSourceIdentity,
  type PacketProductName,
  type WorkerPackageSourceProvenance,
} from "./types.js";

export const PACKET_PRODUCT_CREDENTIAL_SCHEMA_VERSION =
  "packetagent.packet-product-credential/v1" as const;
export const PACKET_PRODUCT_SIGNING_KEY_SCHEMA_VERSION =
  "packetagent.packet-product-signing-key/v1" as const;
export const PACKET_PRODUCT_SIGNING_KEY_ALGORITHM = "ed25519" as const;
export const WORKER_PACKAGE_RECEIPT_SCHEMA_VERSION =
  "packetagent.worker-package-receipt/v1" as const;
export const WORKER_PACKAGE_DEPLOYMENT_SCHEMA_VERSION =
  "packetagent.worker-package-deployment/v1" as const;

export const PACKET_PRODUCT_OPERATIONS = [
  "package.validate",
  "package.deploy",
  "package.update",
  "deployment.activate",
  "deployment.inspect",
  "deployment.list_runs",
  "deployment.pause",
  "deployment.resume",
  "deployment.rollback",
  "deployment.revoke",
  "run.list_events",
  "run.ack_events",
  "attention.list",
  "attention.respond",
] as const;

export type PacketProductOperation = (typeof PACKET_PRODUCT_OPERATIONS)[number];
export type PacketProductCredentialStatus = "active" | "revoked";

export interface PacketProductCredentialRecord {
  readonly schemaVersion: typeof PACKET_PRODUCT_CREDENTIAL_SCHEMA_VERSION;
  readonly id: string;
  readonly workspaceId: string;
  readonly product: "PacketADE";
  readonly subjectId: string;
  readonly displayName?: string;
  readonly tokenDigest: string;
  readonly allowedOperations: readonly PacketProductOperation[];
  readonly requirePackageSignature: boolean;
  readonly status: PacketProductCredentialStatus;
  readonly createdBy: WorkerActorReference;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
}

export interface PacketProductCredentialMetadata extends Omit<
  PacketProductCredentialRecord,
  "tokenDigest"
> {
  readonly tokenConfigured: true;
}

export type PacketProductSigningKeyStatus = "active" | "revoked";

/**
 * Workspace-scoped public verification key for WorkerPackage DSSE envelopes.
 * Only public material is persisted; PacketAgent never holds a signing key.
 */
export interface PacketProductSigningKeyRecord {
  readonly schemaVersion: typeof PACKET_PRODUCT_SIGNING_KEY_SCHEMA_VERSION;
  readonly id: string;
  readonly workspaceId: string;
  readonly keyid: string;
  readonly algorithm: typeof PACKET_PRODUCT_SIGNING_KEY_ALGORITHM;
  /** SubjectPublicKeyInfo PEM. */
  readonly publicKey: string;
  /** `sha256:<hex>` of the DER-encoded SubjectPublicKeyInfo. */
  readonly fingerprint: string;
  readonly product: PacketProductName;
  readonly status: PacketProductSigningKeyStatus;
  readonly description?: string;
  readonly createdBy: WorkerActorReference;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revokedAt?: string;
}

export interface WorkerPackageIntegrityReceipt {
  readonly digestVerified: true;
  readonly signatureRequired: boolean;
  readonly verifiedSignatures: number;
  readonly verifiedAt: string;
}

export interface WorkerPackageCapabilityDecision {
  readonly requestedCapabilityIds: readonly string[];
  readonly packageAllowedCapabilityIds: readonly string[];
  readonly acceptedCapabilityIds: readonly string[];
  readonly grants: readonly WorkerDeploymentCapabilityGrant[];
  readonly compiledPolicy: WorkerCompiledPolicy;
}

export interface WorkerPackageReceipt {
  readonly schemaVersion: typeof WORKER_PACKAGE_RECEIPT_SCHEMA_VERSION;
  readonly id: string;
  readonly workspaceId: string;
  readonly packageId: string;
  readonly packageVersion: number;
  readonly idempotencyKey: string;
  readonly packageDigest: string;
  readonly requestDigest: string;
  readonly workerVersionContentDigest: string;
  readonly source: WorkerPackageSourceProvenance;
  readonly packageCreatedBy: WorkerActorReference;
  readonly authenticatedActor: WorkerActorReference & {
    readonly type: "packet_product";
    readonly product: "PacketADE";
  };
  readonly credentialId: string;
  readonly integrity: WorkerPackageIntegrityReceipt;
  readonly capabilityDecision: WorkerPackageCapabilityDecision;
  readonly acceptedAt: string;
}

export interface WorkerPackageDeploymentRecord {
  readonly schemaVersion: typeof WORKER_PACKAGE_DEPLOYMENT_SCHEMA_VERSION;
  readonly id: string;
  readonly workspaceId: string;
  readonly receiptId: string;
  readonly packageId: string;
  readonly packageVersion: number;
  readonly packageDigest: string;
  readonly workerDefinitionId: string;
  readonly workerVersionId: string;
  readonly workerDeploymentId: string;
  readonly operation: "deploy" | "update" | "rollback";
  readonly actor: WorkerActorReference & {
    readonly type: "packet_product";
    readonly product: "PacketADE";
  };
  readonly createdAt: string;
}

export function packetProductCredentialMetadata(
  record: PacketProductCredentialRecord,
): PacketProductCredentialMetadata {
  const { tokenDigest: _tokenDigest, ...metadata } = record;
  return { ...metadata, tokenConfigured: true };
}

export function assertValidPacketProductCredentialRecord(
  record: PacketProductCredentialRecord,
): void {
  if (
    record.schemaVersion !== PACKET_PRODUCT_CREDENTIAL_SCHEMA_VERSION ||
    !isNonEmpty(record.id) ||
    record.id.includes(".") ||
    !isNonEmpty(record.workspaceId) ||
    record.product !== "PacketADE" ||
    !isNonEmpty(record.subjectId) ||
    !isSha256Digest(record.tokenDigest) ||
    !Array.isArray(record.allowedOperations) ||
    new Set(record.allowedOperations).size !== record.allowedOperations.length ||
    record.allowedOperations.some((operation) => !PACKET_PRODUCT_OPERATIONS.includes(operation)) ||
    typeof record.requirePackageSignature !== "boolean" ||
    !["active", "revoked"].includes(record.status) ||
    !isWorkerActor(record.createdBy) ||
    !isTimestamp(record.createdAt) ||
    !isTimestamp(record.updatedAt) ||
    (record.expiresAt !== undefined && !isTimestamp(record.expiresAt)) ||
    (record.revokedAt !== undefined && !isTimestamp(record.revokedAt)) ||
    (record.status === "revoked" && record.revokedAt === undefined) ||
    (record.status === "active" && record.revokedAt !== undefined)
  ) {
    throw new Error("Packet-product credential record is invalid.");
  }
}

const SIGNING_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,255}$/;

export function isValidPacketProductSigningKeyId(value: unknown): value is string {
  return typeof value === "string" && SIGNING_KEY_ID_PATTERN.test(value);
}

export function assertValidPacketProductSigningKeyRecord(
  record: PacketProductSigningKeyRecord,
): void {
  if (
    record.schemaVersion !== PACKET_PRODUCT_SIGNING_KEY_SCHEMA_VERSION ||
    !isNonEmpty(record.id) ||
    !isNonEmpty(record.workspaceId) ||
    !isValidPacketProductSigningKeyId(record.keyid) ||
    record.algorithm !== PACKET_PRODUCT_SIGNING_KEY_ALGORITHM ||
    typeof record.publicKey !== "string" ||
    !isSpkiPem(record.publicKey) ||
    !isSha256Digest(record.fingerprint) ||
    !isPacketProductName(record.product) ||
    !["active", "revoked"].includes(record.status) ||
    (record.description !== undefined &&
      (typeof record.description !== "string" || record.description.length > 512)) ||
    !isWorkerActor(record.createdBy) ||
    !isTimestamp(record.createdAt) ||
    !isTimestamp(record.updatedAt) ||
    (record.revokedAt !== undefined && !isTimestamp(record.revokedAt)) ||
    (record.status === "revoked" && record.revokedAt === undefined) ||
    (record.status === "active" && record.revokedAt !== undefined)
  ) {
    throw new Error("Packet-product signing key record is invalid.");
  }
}

export function assertValidWorkerPackageReceipt(record: WorkerPackageReceipt): void {
  if (
    record.schemaVersion !== WORKER_PACKAGE_RECEIPT_SCHEMA_VERSION ||
    !isNonEmpty(record.id) ||
    !isNonEmpty(record.workspaceId) ||
    !isNonEmpty(record.packageId) ||
    !Number.isInteger(record.packageVersion) ||
    record.packageVersion < 1 ||
    !isNonEmpty(record.idempotencyKey) ||
    !isSha256Digest(record.packageDigest) ||
    !isSha256Digest(record.requestDigest) ||
    !isSha256Digest(record.workerVersionContentDigest) ||
    !isPacketProductSourceIdentity(record.source.product, record.source.kind) ||
    !isWorkerActor(record.packageCreatedBy) ||
    record.authenticatedActor.type !== "packet_product" ||
    record.authenticatedActor.product !== "PacketADE" ||
    !isNonEmpty(record.authenticatedActor.id) ||
    !isNonEmpty(record.credentialId) ||
    record.integrity.digestVerified !== true ||
    typeof record.integrity.signatureRequired !== "boolean" ||
    !Number.isInteger(record.integrity.verifiedSignatures) ||
    record.integrity.verifiedSignatures < 0 ||
    (record.integrity.signatureRequired && record.integrity.verifiedSignatures < 1) ||
    !isTimestamp(record.integrity.verifiedAt) ||
    !isTimestamp(record.acceptedAt) ||
    !validCapabilityDecision(record.capabilityDecision)
  ) {
    throw new Error("Worker package receipt is invalid.");
  }
}

export function assertValidWorkerPackageDeploymentRecord(
  record: WorkerPackageDeploymentRecord,
): void {
  if (
    record.schemaVersion !== WORKER_PACKAGE_DEPLOYMENT_SCHEMA_VERSION ||
    !isNonEmpty(record.id) ||
    !isNonEmpty(record.workspaceId) ||
    !isNonEmpty(record.receiptId) ||
    !isNonEmpty(record.packageId) ||
    !Number.isInteger(record.packageVersion) ||
    record.packageVersion < 1 ||
    !isSha256Digest(record.packageDigest) ||
    !isNonEmpty(record.workerDefinitionId) ||
    !isNonEmpty(record.workerVersionId) ||
    !isNonEmpty(record.workerDeploymentId) ||
    !["deploy", "update", "rollback"].includes(record.operation) ||
    record.actor.type !== "packet_product" ||
    record.actor.product !== "PacketADE" ||
    !isNonEmpty(record.actor.id) ||
    !isTimestamp(record.createdAt)
  ) {
    throw new Error("Worker package deployment record is invalid.");
  }
}

function validCapabilityDecision(decision: WorkerPackageCapabilityDecision): boolean {
  const requested = new Set(decision.requestedCapabilityIds);
  const packageAllowed = new Set(decision.packageAllowedCapabilityIds);
  const accepted = new Set(decision.acceptedCapabilityIds);
  return (
    requested.size === decision.requestedCapabilityIds.length &&
    packageAllowed.size === decision.packageAllowedCapabilityIds.length &&
    accepted.size === decision.acceptedCapabilityIds.length &&
    [...packageAllowed].every((id) => requested.has(id)) &&
    [...accepted].every((id) => packageAllowed.has(id)) &&
    decision.grants.every((grant) => accepted.has(grant.capabilityId)) &&
    isSha256Digest(decision.compiledPolicy.workerVersionContentDigest) &&
    isSha256Digest(decision.compiledPolicy.policyDigest)
  );
}

function isWorkerActor(actor: WorkerActorReference): boolean {
  return (
    ["user", "system", "packet_product"].includes(actor.type) &&
    isNonEmpty(actor.id) &&
    (actor.type !== "packet_product" || actor.product !== undefined)
  );
}

function isTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function isNonEmpty(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isSha256Digest(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}

function isSpkiPem(value: string): boolean {
  return /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n?$/.test(value);
}
