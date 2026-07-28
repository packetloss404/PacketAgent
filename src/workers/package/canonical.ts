import { createHash } from "node:crypto";
import {
  WORKER_PACKAGE_CANONICALIZATION,
  WORKER_PACKAGE_DIGEST_ALGORITHM,
  WORKER_PACKAGE_DSSE_PAYLOAD_TYPE,
  type WorkerPackage,
  type WorkerPackageDigestSubject,
} from "./types.js";

const textEncoder = new TextEncoder();

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
  return canonicalJson(value, "$");
}

export function canonicalWorkerPackageBytes(workerPackage: WorkerPackage): Uint8Array {
  return textEncoder.encode(canonicalWorkerPackageJson(workerPackageDigestSubject(workerPackage)));
}

export function computeWorkerPackageDigest(workerPackage: WorkerPackage): string {
  return `${WORKER_PACKAGE_DIGEST_ALGORITHM}:${createHash(WORKER_PACKAGE_DIGEST_ALGORITHM)
    .update(canonicalWorkerPackageBytes(workerPackage))
    .digest("hex")}`;
}

export function workerPackageDssePreAuthenticationEncoding(
  workerPackage: WorkerPackage,
): Uint8Array {
  const payloadType = textEncoder.encode(WORKER_PACKAGE_DSSE_PAYLOAD_TYPE);
  const payload = canonicalWorkerPackageBytes(workerPackage);
  return concatBytes(
    textEncoder.encode(`DSSEv1 ${payloadType.byteLength} `),
    payloadType,
    textEncoder.encode(` ${payload.byteLength} `),
    payload,
  );
}

function canonicalJson(value: unknown, path: string): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    assertUnicodeScalarString(value, path);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} must contain only finite JSON numbers`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((entry, index) => {
        if (entry === undefined) {
          throw new Error(`${path}[${index}] must not be undefined`);
        }
        return canonicalJson(entry, `${path}[${index}]`);
      })
      .join(",")}]`;
  }
  if (isPlainRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => {
        assertUnicodeScalarString(key, `${path} property name`);
        const entry = value[key];
        if (entry === undefined) {
          throw new Error(`${path}.${key} must not be undefined`);
        }
        return `${JSON.stringify(key)}:${canonicalJson(entry, `${path}.${key}`)}`;
      })
      .join(",")}}`;
  }
  throw new Error(`${path} must contain only plain JSON values`);
}

function assertUnicodeScalarString(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error(`${path} must not contain an unpaired Unicode surrogate`);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error(`${path} must not contain an unpaired Unicode surrogate`);
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}
