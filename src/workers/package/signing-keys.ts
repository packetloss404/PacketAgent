import {
  createHash,
  createPublicKey,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import {
  loadStoreAsync as defaultLoadStore,
  mutateStoreAsync as defaultMutateStore,
  recordActivity,
  type PacketAgentData,
} from "../../packetagent-store.js";
import { dssePreAuthenticationEncoding } from "../../security/canonical-json.js";
import type { WorkerActorReference } from "../types.js";
import { workerPackageDssePreAuthenticationEncoding } from "./canonical.js";
import {
  PACKET_PRODUCT_SIGNING_KEY_ALGORITHM,
  PACKET_PRODUCT_SIGNING_KEY_SCHEMA_VERSION,
  assertValidPacketProductSigningKeyRecord,
  isValidPacketProductSigningKeyId,
  type PacketProductSigningKeyRecord,
  type PacketProductSigningKeyStatus,
} from "./trust-types.js";
import {
  WORKER_PACKAGE_DSSE_PAYLOAD_TYPE,
  isPacketProductName,
  type PacketProductName,
  type WorkerPackage,
  type WorkerPackageDsseSignature,
  type WorkerPackageSignatureVerificationInput,
} from "./types.js";
import { workerPackageDsseEnvelope } from "./validation.js";

type MaybePromise<T> = T | Promise<T>;

const ED25519_SIGNATURE_BYTES = 64;

/**
 * DSSE verification input extended with the workspace whose trust policy is
 * being evaluated. A key registered in one workspace never verifies a package
 * submitted to another.
 */
export interface PacketProductSignatureVerificationInput extends WorkerPackageSignatureVerificationInput {
  readonly workspaceId: string;
}

export type PacketProductSignatureVerifier = (
  input: PacketProductSignatureVerificationInput,
) => boolean | Promise<boolean>;

export type PacketProductSigningKeyErrorCode = "invalid_input" | "not_found" | "conflict";

export class PacketProductSigningKeyError extends Error {
  constructor(
    readonly code: PacketProductSigningKeyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PacketProductSigningKeyError";
  }
}

export interface RegisterPacketProductSigningKeyInput {
  readonly workspaceId: string;
  readonly keyid: string;
  /** Ed25519 SubjectPublicKeyInfo PEM (`-----BEGIN PUBLIC KEY-----`). */
  readonly publicKey: string;
  readonly product?: PacketProductName;
  readonly description?: string;
  readonly createdBy: WorkerActorReference;
}

export interface RevokePacketProductSigningKeyInput {
  readonly workspaceId: string;
  readonly keyid: string;
  readonly revokedBy: WorkerActorReference;
}

export interface ListPacketProductSigningKeysInput {
  readonly workspaceId: string;
  readonly status?: PacketProductSigningKeyStatus;
}

export interface PacketProductSigningKeyService {
  register(input: RegisterPacketProductSigningKeyInput): Promise<PacketProductSigningKeyRecord>;
  revoke(input: RevokePacketProductSigningKeyInput): Promise<PacketProductSigningKeyRecord>;
  list(input: ListPacketProductSigningKeysInput): Promise<PacketProductSigningKeyRecord[]>;
  readonly verify: PacketProductSignatureVerifier;
}

export interface PacketProductSigningKeyDependencies {
  readonly loadStore?: () => MaybePromise<PacketAgentData>;
  readonly mutateStore?: <T>(
    mutator: (data: PacketAgentData) => MaybePromise<T>,
  ) => MaybePromise<T>;
  readonly now?: () => string;
  readonly generateId?: (kind: "activity") => string;
}

export function packetProductSigningKeyId(workspaceId: string, keyid: string): string {
  const digest = createHash("sha256")
    .update("packetagent.packet-product-signing-key-id/v1\0")
    .update(workspaceId)
    .update("\0")
    .update(keyid)
    .digest("hex")
    .slice(0, 32);
  return `packet_product_signing_key_${digest}`;
}

export interface NormalizedEd25519PublicKey {
  /** Re-exported SPKI PEM with normalized line endings. */
  readonly publicKey: string;
  /** `sha256:<hex>` over the DER SubjectPublicKeyInfo. */
  readonly fingerprint: string;
}

/**
 * Parse an Ed25519 public key and re-export it in canonical SPKI PEM form.
 * Private keys, other algorithms, and unparsable input are rejected.
 */
export function normalizeEd25519PublicKey(value: string): NormalizedEd25519PublicKey {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    throw new PacketProductSigningKeyError("invalid_input", "publicKey is required.");
  }
  if (/PRIVATE KEY-----/.test(trimmed)) {
    throw new PacketProductSigningKeyError(
      "invalid_input",
      "publicKey must be a public key; private key material is never accepted.",
    );
  }
  let keyObject: KeyObject;
  try {
    keyObject = createPublicKey({ key: trimmed, format: "pem" });
  } catch {
    throw new PacketProductSigningKeyError(
      "invalid_input",
      "publicKey must be a PEM-encoded SubjectPublicKeyInfo.",
    );
  }
  if (keyObject.type !== "public" || keyObject.asymmetricKeyType !== "ed25519") {
    throw new PacketProductSigningKeyError(
      "invalid_input",
      "publicKey must be an Ed25519 public key.",
    );
  }
  const der = keyObject.export({ type: "spki", format: "der" });
  const pem = keyObject.export({ type: "spki", format: "pem" }) as string;
  return {
    publicKey: pem.replace(/\r\n/g, "\n"),
    fingerprint: `sha256:${createHash("sha256").update(der).digest("hex")}`,
  };
}

export function createStoreSignatureVerifier(
  dependencies: Pick<PacketProductSigningKeyDependencies, "loadStore"> = {},
): PacketProductSignatureVerifier {
  const loadStore = dependencies.loadStore ?? defaultLoadStore;
  return async (input) => {
    if (!isValidPacketProductSigningKeyId(input.keyid)) return false;
    if (input.payloadType !== WORKER_PACKAGE_DSSE_PAYLOAD_TYPE) return false;
    const signature = decodeSignature(input.sig);
    if (!signature) return false;

    const data = await loadStore();
    const key = (data.packetProductSigningKeys ?? []).find(
      (record) =>
        record.workspaceId === input.workspaceId &&
        record.keyid === input.keyid &&
        record.status === "active" &&
        record.algorithm === PACKET_PRODUCT_SIGNING_KEY_ALGORITHM,
    );
    if (!key) return false;

    let publicKey: KeyObject;
    try {
      publicKey = createPublicKey({ key: key.publicKey, format: "pem" });
    } catch {
      return false;
    }
    if (publicKey.asymmetricKeyType !== "ed25519") return false;
    const preAuthenticationEncoding = dssePreAuthenticationEncoding(
      input.payloadType,
      input.payload,
    );
    try {
      return cryptoVerify(null, preAuthenticationEncoding, publicKey, signature);
    } catch {
      return false;
    }
  };
}

export function createPacketProductSigningKeyService(
  dependencies: PacketProductSigningKeyDependencies = {},
): PacketProductSigningKeyService {
  const loadStore = dependencies.loadStore ?? defaultLoadStore;
  const mutateStore = dependencies.mutateStore ?? defaultMutateStore;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const generateId = dependencies.generateId ?? (() => `activity_${randomUUID()}`);

  async function register(
    input: RegisterPacketProductSigningKeyInput,
  ): Promise<PacketProductSigningKeyRecord> {
    requireNonEmpty(input.workspaceId, "workspaceId");
    requireActor(input.createdBy, "createdBy");
    if (!isValidPacketProductSigningKeyId(input.keyid)) {
      throw new PacketProductSigningKeyError(
        "invalid_input",
        "keyid must be 1-256 characters of letters, digits, or . _ : @ / + - and start with a letter or digit.",
      );
    }
    const product = input.product ?? "PacketBench";
    if (!isPacketProductName(product)) {
      throw new PacketProductSigningKeyError(
        "invalid_input",
        "product must be PacketBench or the legacy PacketADE identity.",
      );
    }
    const description = input.description?.trim();
    if (description !== undefined && description.length > 512) {
      throw new PacketProductSigningKeyError(
        "invalid_input",
        "description must not exceed 512 characters.",
      );
    }
    const normalized = normalizeEd25519PublicKey(input.publicKey);
    const timestamp = now();
    const record: PacketProductSigningKeyRecord = {
      schemaVersion: PACKET_PRODUCT_SIGNING_KEY_SCHEMA_VERSION,
      id: packetProductSigningKeyId(input.workspaceId, input.keyid),
      workspaceId: input.workspaceId,
      keyid: input.keyid,
      algorithm: PACKET_PRODUCT_SIGNING_KEY_ALGORITHM,
      publicKey: normalized.publicKey,
      fingerprint: normalized.fingerprint,
      product,
      status: "active",
      ...(description ? { description } : {}),
      createdBy: structuredClone(input.createdBy),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    assertValidPacketProductSigningKeyRecord(record);

    await mutateStore((data) => {
      if (!data.workspaces.some((workspace) => workspace.id === record.workspaceId)) {
        throw new PacketProductSigningKeyError(
          "invalid_input",
          "The Packet-product workspace does not exist.",
        );
      }
      const keys = signingKeys(data);
      if (
        keys.some(
          (existing) =>
            existing.workspaceId === record.workspaceId &&
            (existing.keyid === record.keyid || existing.id === record.id),
        )
      ) {
        throw new PacketProductSigningKeyError(
          "conflict",
          "keyid is already registered in this workspace; revoked keyids cannot be reused.",
        );
      }
      keys.push(record);
      recordActivity(data, {
        id: generateId("activity"),
        workspaceId: record.workspaceId,
        scope: "workspace",
        actor: input.createdBy,
        event: "packet_product.signing_key_registered",
        occurredAt: timestamp,
        data: {
          title: "Packet-product signing key registered",
          product: record.product,
          keyid: record.keyid,
          algorithm: record.algorithm,
          fingerprint: record.fingerprint,
        },
      });
    });
    return structuredClone(record);
  }

  async function revoke(
    input: RevokePacketProductSigningKeyInput,
  ): Promise<PacketProductSigningKeyRecord> {
    requireNonEmpty(input.workspaceId, "workspaceId");
    requireNonEmpty(input.keyid, "keyid");
    requireActor(input.revokedBy, "revokedBy");
    const timestamp = now();
    const revoked = await mutateStore((data) => {
      const keys = signingKeys(data);
      const index = keys.findIndex(
        (record) => record.workspaceId === input.workspaceId && record.keyid === input.keyid,
      );
      if (index < 0) {
        throw new PacketProductSigningKeyError(
          "not_found",
          "Packet-product signing key was not found in this workspace.",
        );
      }
      const existing = keys[index]!;
      if (existing.status === "revoked") return existing;
      const next: PacketProductSigningKeyRecord = {
        ...existing,
        status: "revoked",
        revokedAt: timestamp,
        updatedAt: timestamp,
      };
      assertValidPacketProductSigningKeyRecord(next);
      keys[index] = next;
      recordActivity(data, {
        id: generateId("activity"),
        workspaceId: next.workspaceId,
        scope: "workspace",
        actor: input.revokedBy,
        event: "packet_product.signing_key_revoked",
        occurredAt: timestamp,
        data: {
          title: "Packet-product signing key revoked",
          product: next.product,
          keyid: next.keyid,
          algorithm: next.algorithm,
          fingerprint: next.fingerprint,
        },
      });
      return next;
    });
    return structuredClone(revoked);
  }

  async function list(
    input: ListPacketProductSigningKeysInput,
  ): Promise<PacketProductSigningKeyRecord[]> {
    requireNonEmpty(input.workspaceId, "workspaceId");
    const data = await loadStore();
    return (data.packetProductSigningKeys ?? [])
      .filter(
        (record) =>
          record.workspaceId === input.workspaceId &&
          (input.status === undefined || record.status === input.status),
      )
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.keyid.localeCompare(right.keyid),
      )
      .map((record) => structuredClone(record));
  }

  return {
    register,
    revoke,
    list,
    verify: createStoreSignatureVerifier({ loadStore }),
  };
}

export interface WorkerPackageEd25519Signer {
  readonly keyid: string;
  /** Ed25519 private key (KeyObject or PKCS#8 PEM). Never persisted by PacketAgent. */
  readonly privateKey: KeyObject | string;
}

/**
 * Produce the DSSE signature entry PacketBench must emit for a package:
 * Ed25519 over `PAE(payloadType, canonical subject bytes)`, base64 encoded.
 */
export function signWorkerPackageEd25519(
  workerPackage: WorkerPackage,
  signer: WorkerPackageEd25519Signer,
): WorkerPackageDsseSignature {
  const signature = cryptoSign(
    null,
    workerPackageDssePreAuthenticationEncoding(workerPackage),
    signer.privateKey,
  );
  return { keyid: signer.keyid, sig: signature.toString("base64") };
}

/**
 * Attach an Ed25519 DSSE envelope to an already sealed package. The package
 * subject bytes and digest are unchanged; only `integrity.dsseEnvelope` is added.
 */
export function attachWorkerPackageEd25519Envelope(
  workerPackage: WorkerPackage,
  signers: readonly WorkerPackageEd25519Signer[],
): WorkerPackage {
  const signatures = signers.map((signer) => signWorkerPackageEd25519(workerPackage, signer));
  return {
    ...workerPackage,
    integrity: {
      ...workerPackage.integrity,
      dsseEnvelope: workerPackageDsseEnvelope(workerPackage, signatures),
    },
  };
}

function signingKeys(data: PacketAgentData): PacketProductSigningKeyRecord[] {
  if (!data.packetProductSigningKeys) data.packetProductSigningKeys = [];
  return data.packetProductSigningKeys;
}

function decodeSignature(value: string): Buffer | null {
  if (typeof value !== "string" || !value) return null;
  const decoded = Buffer.from(
    value,
    value.includes("-") || value.includes("_") ? "base64url" : "base64",
  );
  return decoded.byteLength === ED25519_SIGNATURE_BYTES ? decoded : null;
}

function requireActor(actor: WorkerActorReference, field: string): void {
  if (!actor || !["user", "system", "packet_product"].includes(actor.type) || !actor.id?.trim()) {
    throw new PacketProductSigningKeyError("invalid_input", `${field} must identify an actor.`);
  }
}

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new PacketProductSigningKeyError("invalid_input", `${field} is required.`);
  }
}
