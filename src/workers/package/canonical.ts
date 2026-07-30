import { createHash } from "node:crypto";
import {
  canonicalJson,
  canonicalJsonBytes,
  dssePreAuthenticationEncoding,
} from "../../security/canonical-json.js";
import {
  WORKER_PACKAGE_CANONICALIZATION,
  WORKER_PACKAGE_DIGEST_ALGORITHM,
  WORKER_PACKAGE_DSSE_PAYLOAD_TYPE,
  type WorkerPackage,
  type WorkerPackageDigestSubject,
} from "./types.js";

export function workerPackageDigestSubject(
  workerPackage: WorkerPackage,
): WorkerPackageDigestSubject {
  const { integrity: _integrity, ...content } = workerPackage;
  return {
    ...content,
    integrity: {
      canonicalization: WORKER_PACKAGE_CANONICALIZATION,
      algorithm: WORKER_PACKAGE_DIGEST_ALGORITHM,
    },
  };
}

export function canonicalWorkerPackageJson(value: unknown): string {
  return canonicalJson(value);
}

export function canonicalWorkerPackageBytes(workerPackage: WorkerPackage): Uint8Array {
  return canonicalJsonBytes(workerPackageDigestSubject(workerPackage));
}

export function computeWorkerPackageDigest(workerPackage: WorkerPackage): string {
  return `${WORKER_PACKAGE_DIGEST_ALGORITHM}:${createHash(WORKER_PACKAGE_DIGEST_ALGORITHM)
    .update(canonicalWorkerPackageBytes(workerPackage))
    .digest("hex")}`;
}

export function workerPackageDssePreAuthenticationEncoding(
  workerPackage: WorkerPackage,
): Uint8Array {
  return dssePreAuthenticationEncoding(
    WORKER_PACKAGE_DSSE_PAYLOAD_TYPE,
    canonicalWorkerPackageBytes(workerPackage),
  );
}
