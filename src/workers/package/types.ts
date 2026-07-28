import type {
  WorkerActorReference,
  WorkerSourceProvenance,
  WorkerVersionContent,
} from "../types.js";
import type {
  WorkerArtifactResourceDescriptor,
  WorkerEvidenceRedactionClassification,
} from "../observability/types.js";

export const WORKER_PACKAGE_SCHEMA_VERSION = "packetagent.worker-package/v1" as const;
export const WORKER_PACKAGE_CANONICALIZATION =
  "packetagent.worker-package-canonical-json/v1" as const;
export const WORKER_PACKAGE_DIGEST_ALGORITHM = "sha256" as const;
export const WORKER_PACKAGE_DSSE_PAYLOAD_TYPE =
  "application/vnd.packetagent.worker-package.v1+json" as const;

export interface WorkerPackageArtifactReference extends WorkerArtifactResourceDescriptor {
  readonly role: "source" | "configuration" | "acceptance" | "input" | "other";
  readonly classification: WorkerEvidenceRedactionClassification;
}

export interface WorkerPackageDsseSignature {
  readonly keyid?: string;
  readonly sig: string;
}

export interface WorkerPackageDsseEnvelope {
  readonly payloadType: typeof WORKER_PACKAGE_DSSE_PAYLOAD_TYPE;
  readonly payload: string;
  readonly signatures: readonly WorkerPackageDsseSignature[];
}

export interface WorkerPackageIntegrity {
  readonly canonicalization: typeof WORKER_PACKAGE_CANONICALIZATION;
  readonly algorithm: typeof WORKER_PACKAGE_DIGEST_ALGORITHM;
  readonly digest: string;
  readonly dsseEnvelope?: WorkerPackageDsseEnvelope;
}

export interface WorkerPackage {
  readonly schemaVersion: typeof WORKER_PACKAGE_SCHEMA_VERSION;
  readonly packageId: string;
  readonly packageVersion: number;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly createdBy: WorkerActorReference;
  readonly source: WorkerSourceProvenance & {
    readonly product: "PacketADE";
    readonly kind: "packetade";
  };
  readonly worker: {
    readonly name: string;
    readonly description: string;
    readonly content: WorkerVersionContent;
  };
  readonly artifacts: readonly WorkerPackageArtifactReference[];
  readonly integrity: WorkerPackageIntegrity;
}

export type WorkerPackageDigestSubject = Omit<WorkerPackage, "integrity"> & {
  readonly integrity: Pick<WorkerPackageIntegrity, "canonicalization" | "algorithm">;
};

export interface WorkerPackageSignatureVerificationInput {
  readonly keyid?: string;
  readonly sig: string;
  readonly payloadType: typeof WORKER_PACKAGE_DSSE_PAYLOAD_TYPE;
  readonly payload: Uint8Array;
  readonly preAuthenticationEncoding: Uint8Array;
}
