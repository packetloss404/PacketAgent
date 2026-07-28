import { timingSafeEqual } from "node:crypto";
import type { WorkerContractIssue } from "../validation.js";
import {
  validateWorkerActorReference,
  validateWorkerSourceProvenance,
  validateWorkerVersionContent,
} from "../validation.js";
import {
  canonicalWorkerPackageBytes,
  computeWorkerPackageDigest,
  workerPackageDssePreAuthenticationEncoding,
} from "./canonical.js";
import {
  WORKER_PACKAGE_CANONICALIZATION,
  WORKER_PACKAGE_DIGEST_ALGORITHM,
  WORKER_PACKAGE_DSSE_PAYLOAD_TYPE,
  WORKER_PACKAGE_SCHEMA_VERSION,
  type WorkerPackage,
  type WorkerPackageDsseEnvelope,
  type WorkerPackageSignatureVerificationInput,
} from "./types.js";

type UnknownRecord = Record<string, unknown>;

export type WorkerPackageValidation =
  | {
      readonly ok: true;
      readonly value: WorkerPackage;
      readonly issues: readonly [];
    }
  | {
      readonly ok: false;
      readonly issues: readonly WorkerContractIssue[];
    };

export class WorkerPackageValidationError extends Error {
  readonly issues: readonly WorkerContractIssue[];

  constructor(issues: readonly WorkerContractIssue[]) {
    super(
      `WorkerPackage is invalid: ${issues
        .map((entry) => `${entry.path} ${entry.message}`)
        .join("; ")}`,
    );
    this.name = "WorkerPackageValidationError";
    this.issues = issues;
  }
}

export interface VerifyWorkerPackageOptions {
  readonly requireSignature?: boolean;
  readonly verifySignature?: (
    input: WorkerPackageSignatureVerificationInput,
  ) => boolean | Promise<boolean>;
}

export type WorkerPackageVerification =
  | {
      readonly ok: true;
      readonly value: WorkerPackage;
      readonly verifiedSignatures: number;
      readonly issues: readonly [];
    }
  | {
      readonly ok: false;
      readonly verifiedSignatures: number;
      readonly issues: readonly WorkerContractIssue[];
    };

export function sealWorkerPackage(value: Omit<WorkerPackage, "integrity">): WorkerPackage {
  const draft: WorkerPackage = {
    ...value,
    integrity: {
      canonicalization: WORKER_PACKAGE_CANONICALIZATION,
      algorithm: WORKER_PACKAGE_DIGEST_ALGORITHM,
      digest: `sha256:${"0".repeat(64)}`,
    },
  };
  const sealed: WorkerPackage = {
    ...draft,
    integrity: {
      ...draft.integrity,
      digest: computeWorkerPackageDigest(draft),
    },
  };
  assertValidWorkerPackage(sealed);
  return sealed;
}

export function validateWorkerPackage(value: unknown): WorkerPackageValidation {
  const issues: WorkerContractIssue[] = [];
  const workerPackage = recordAt(value, "$", issues);
  if (!workerPackage) return { ok: false, issues };

  expectKeys(
    workerPackage,
    [
      "schemaVersion",
      "packageId",
      "packageVersion",
      "idempotencyKey",
      "createdAt",
      "createdBy",
      "source",
      "worker",
      "artifacts",
      "integrity",
    ],
    "$",
    issues,
  );
  if (workerPackage.schemaVersion !== WORKER_PACKAGE_SCHEMA_VERSION) {
    addIssue(
      issues,
      "$.schemaVersion",
      "package.schema_version.unsupported",
      `must equal ${JSON.stringify(WORKER_PACKAGE_SCHEMA_VERSION)}`,
    );
  }
  nonEmptyStringAt(workerPackage, "packageId", "$", issues);
  positiveIntegerAt(workerPackage, "packageVersion", "$", issues);
  nonEmptyStringAt(workerPackage, "idempotencyKey", "$", issues);
  canonicalTimestampAt(workerPackage, "createdAt", "$", issues);

  appendNestedIssues(
    issues,
    "$.createdBy",
    validateWorkerActorReference(workerPackage.createdBy).issues,
  );
  if (isRecord(workerPackage.createdBy)) {
    expectKeys(
      workerPackage.createdBy,
      ["type", "id", "displayName", "product"],
      "$.createdBy",
      issues,
    );
  }
  appendNestedIssues(
    issues,
    "$.source",
    validateWorkerSourceProvenance(workerPackage.source).issues,
  );
  validatePacketAdeSource(workerPackage.source, issues);
  validatePackageWorker(workerPackage.worker, issues);
  validateArtifacts(workerPackage.artifacts, issues);
  validateIntegrity(workerPackage.integrity, issues);

  if (issues.length === 0) {
    try {
      const expected = computeWorkerPackageDigest(workerPackage as unknown as WorkerPackage);
      if (!safeStringEqual((workerPackage.integrity as UnknownRecord).digest, expected)) {
        addIssue(
          issues,
          "$.integrity.digest",
          "package.integrity.digest_mismatch",
          `must equal the digest of the canonical package subject (${expected})`,
        );
      }
      validateDssePayloadBinding(workerPackage as unknown as WorkerPackage, issues);
    } catch (error) {
      addIssue(
        issues,
        "$",
        "package.canonicalization",
        error instanceof Error ? error.message : "could not canonicalize the package",
      );
    }
  }

  return issues.length === 0
    ? { ok: true, value: value as WorkerPackage, issues: [] }
    : { ok: false, issues };
}

export function assertValidWorkerPackage(value: unknown): asserts value is WorkerPackage {
  const result = validateWorkerPackage(value);
  if (!result.ok) throw new WorkerPackageValidationError(result.issues);
}

export async function verifyWorkerPackage(
  value: unknown,
  options: VerifyWorkerPackageOptions = {},
): Promise<WorkerPackageVerification> {
  const validation = validateWorkerPackage(value);
  if (!validation.ok) {
    return { ok: false, verifiedSignatures: 0, issues: validation.issues };
  }
  const envelope = validation.value.integrity.dsseEnvelope;
  if (!envelope) {
    return options.requireSignature
      ? {
          ok: false,
          verifiedSignatures: 0,
          issues: [
            {
              path: "$.integrity.dsseEnvelope",
              code: "package.signature.required",
              message: "is required by the active Packet-product trust policy",
            },
          ],
        }
      : { ok: true, value: validation.value, verifiedSignatures: 0, issues: [] };
  }
  if (!options.verifySignature) {
    return options.requireSignature
      ? {
          ok: false,
          verifiedSignatures: 0,
          issues: [
            {
              path: "$.integrity.dsseEnvelope.signatures",
              code: "package.signature.verifier_required",
              message: "cannot satisfy required signature policy without a verifier",
            },
          ],
        }
      : { ok: true, value: validation.value, verifiedSignatures: 0, issues: [] };
  }

  const payload = canonicalWorkerPackageBytes(validation.value);
  const preAuthenticationEncoding = workerPackageDssePreAuthenticationEncoding(validation.value);
  let verifiedSignatures = 0;
  for (const signature of envelope.signatures) {
    const verified = await options.verifySignature({
      keyid: signature.keyid,
      sig: signature.sig,
      payloadType: WORKER_PACKAGE_DSSE_PAYLOAD_TYPE,
      payload,
      preAuthenticationEncoding,
    });
    if (verified) verifiedSignatures += 1;
  }
  if (options.requireSignature && verifiedSignatures === 0) {
    return {
      ok: false,
      verifiedSignatures,
      issues: [
        {
          path: "$.integrity.dsseEnvelope.signatures",
          code: "package.signature.untrusted",
          message: "does not contain a signature accepted by the active trust policy",
        },
      ],
    };
  }
  return {
    ok: true,
    value: validation.value,
    verifiedSignatures,
    issues: [],
  };
}

function validatePacketAdeSource(value: unknown, issues: WorkerContractIssue[]): void {
  if (!isRecord(value)) return;
  expectKeys(
    value,
    [
      "product",
      "kind",
      "sourceId",
      "flightId",
      "projectId",
      "conversationId",
      "repository",
      "revision",
    ],
    "$.source",
    issues,
  );
  if (value.product !== "PacketADE") {
    addIssue(issues, "$.source.product", "package.source.product", "must be PacketADE");
  }
  if (value.kind !== "packetade") {
    addIssue(issues, "$.source.kind", "package.source.kind", "must be packetade");
  }
}

function validatePackageWorker(value: unknown, issues: WorkerContractIssue[]): void {
  const worker = recordAt(value, "$.worker", issues);
  if (!worker) return;
  expectKeys(worker, ["name", "description", "content"], "$.worker", issues);
  nonEmptyStringAt(worker, "name", "$.worker", issues);
  nonEmptyStringAt(worker, "description", "$.worker", issues);
  appendNestedIssues(
    issues,
    "$.worker.content",
    validateWorkerVersionContent(worker.content).issues,
  );
  validateStrictVersionContentKeys(worker.content, "$.worker.content", issues);
}

function validateStrictVersionContentKeys(
  value: unknown,
  path: string,
  issues: WorkerContractIssue[],
): void {
  if (!isRecord(value)) return;
  expectKeys(
    value,
    [
      "objective",
      "instructions",
      "inputSchema",
      "execution",
      "tools",
      "credentialRefs",
      "triggers",
      "policy",
      "exitPredicates",
      "acceptanceCommands",
      "notificationRoutes",
    ],
    path,
    issues,
  );
  if (isRecord(value.inputSchema)) {
    expectKeys(
      value.inputSchema,
      ["fields", "additionalProperties"],
      `${path}.inputSchema`,
      issues,
    );
    if (Array.isArray(value.inputSchema.fields)) {
      value.inputSchema.fields.forEach((field, index) => {
        if (isRecord(field)) {
          expectKeys(
            field,
            ["key", "label", "type", "required", "description", "options", "defaultValue"],
            `${path}.inputSchema.fields[${index}]`,
            issues,
          );
        }
      });
    }
  }
  if (isRecord(value.execution)) {
    expectKeys(
      value.execution,
      ["routeKey", "providerId", "model", "target"],
      `${path}.execution`,
      issues,
    );
    if (isRecord(value.execution.target)) {
      expectKeys(value.execution.target, ["kind", "reference"], `${path}.execution.target`, issues);
    }
  }
  strictArrayKeys(
    value.tools,
    ["id", "tool", "verbs", "resources", "effect", "approval"],
    `${path}.tools`,
    issues,
  );
  strictTriggerKeys(value.triggers, `${path}.triggers`, issues);
  strictPolicyKeys(value.policy, `${path}.policy`, issues);
  strictExitPredicateKeys(value.exitPredicates, `${path}.exitPredicates`, issues);
  strictArrayKeys(
    value.notificationRoutes,
    ["id", "kind", "reference", "events"],
    `${path}.notificationRoutes`,
    issues,
  );
}

function strictTriggerKeys(value: unknown, path: string, issues: WorkerContractIssue[]): void {
  if (!Array.isArray(value)) return;
  const keysByKind: Record<string, readonly string[]> = {
    manual: ["id", "kind", "enabled", "description"],
    cron: ["id", "kind", "enabled", "description", "expression", "timezone"],
    webhook: ["id", "kind", "enabled", "description", "adapter", "eventType", "webhookRef"],
    queue: ["id", "kind", "enabled", "description", "queueRef", "eventType"],
    alert: ["id", "kind", "enabled", "description", "alertRuleId"],
  };
  value.forEach((entry, index) => {
    if (!isRecord(entry) || typeof entry.kind !== "string") return;
    const keys = keysByKind[entry.kind];
    if (keys) expectKeys(entry, keys, `${path}[${index}]`, issues);
  });
}

function strictPolicyKeys(value: unknown, path: string, issues: WorkerContractIssue[]): void {
  if (!isRecord(value)) return;
  expectKeys(value, ["budgets", "retry", "permissions", "attention"], path, issues);
  if (isRecord(value.budgets)) {
    expectKeys(
      value.budgets,
      [
        "maxElapsedMs",
        "maxIterations",
        "maxProviderCostUsd",
        "maxConsecutiveFailures",
        "maxToolCalls",
        "rolling",
      ],
      `${path}.budgets`,
      issues,
    );
    if (isRecord(value.budgets.rolling)) {
      expectKeys(
        value.budgets.rolling,
        ["windowMs", "workspace", "deployment"],
        `${path}.budgets.rolling`,
        issues,
      );
      for (const scope of ["workspace", "deployment"] as const) {
        if (isRecord(value.budgets.rolling[scope])) {
          expectKeys(
            value.budgets.rolling[scope],
            ["maxProviderCostUsd", "maxBillableActions"],
            `${path}.budgets.rolling.${scope}`,
            issues,
          );
        }
      }
    }
  }
  if (isRecord(value.retry)) {
    expectKeys(
      value.retry,
      ["maxAttempts", "initialBackoffMs", "maxBackoffMs", "backoffMultiplier"],
      `${path}.retry`,
      issues,
    );
  }
  if (isRecord(value.permissions)) {
    expectKeys(
      value.permissions,
      ["default", "allowedCapabilityIds"],
      `${path}.permissions`,
      issues,
    );
  }
  if (isRecord(value.attention)) {
    expectKeys(
      value.attention,
      ["approvalTimeoutMs", "escalationAfterMs", "onExpiration"],
      `${path}.attention`,
      issues,
    );
  }
}

function strictExitPredicateKeys(
  value: unknown,
  path: string,
  issues: WorkerContractIssue[],
): void {
  if (!Array.isArray(value)) return;
  value.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    expectKeys(
      entry,
      entry.kind === "output_matches"
        ? ["id", "kind", "description", "expression"]
        : ["id", "kind", "description"],
      `${path}[${index}]`,
      issues,
    );
  });
}

function validateArtifacts(value: unknown, issues: WorkerContractIssue[]): void {
  if (!Array.isArray(value)) {
    addIssue(issues, "$.artifacts", "type.array", "must be an array");
    return;
  }
  const references = new Set<string>();
  value.forEach((entry, index) => {
    const path = `$.artifacts[${index}]`;
    const artifact = recordAt(entry, path, issues);
    if (!artifact) return;
    expectKeys(
      artifact,
      ["reference", "name", "mediaType", "byteLength", "contentDigest", "role", "classification"],
      path,
      issues,
    );
    const reference = nonEmptyStringAt(artifact, "reference", path, issues);
    nonEmptyStringAt(artifact, "name", path, issues, true);
    nonEmptyStringAt(artifact, "mediaType", path, issues);
    nonNegativeIntegerAt(artifact, "byteLength", path, issues);
    digestAt(artifact, "contentDigest", path, issues);
    enumAt(
      artifact,
      "role",
      ["source", "configuration", "acceptance", "input", "other"],
      path,
      issues,
    );
    enumAt(
      artifact,
      "classification",
      ["public_metadata", "internal", "sensitive_reference"],
      path,
      issues,
    );
    if (reference && references.has(reference)) {
      addIssue(
        issues,
        `${path}.reference`,
        "package.artifact.duplicate_reference",
        `duplicates ${JSON.stringify(reference)}`,
      );
    }
    if (reference) references.add(reference);
  });
}

function validateIntegrity(value: unknown, issues: WorkerContractIssue[]): void {
  const integrity = recordAt(value, "$.integrity", issues);
  if (!integrity) return;
  expectKeys(
    integrity,
    ["canonicalization", "algorithm", "digest", "dsseEnvelope"],
    "$.integrity",
    issues,
  );
  if (integrity.canonicalization !== WORKER_PACKAGE_CANONICALIZATION) {
    addIssue(
      issues,
      "$.integrity.canonicalization",
      "package.integrity.canonicalization",
      `must equal ${JSON.stringify(WORKER_PACKAGE_CANONICALIZATION)}`,
    );
  }
  if (integrity.algorithm !== WORKER_PACKAGE_DIGEST_ALGORITHM) {
    addIssue(
      issues,
      "$.integrity.algorithm",
      "package.integrity.algorithm",
      `must equal ${JSON.stringify(WORKER_PACKAGE_DIGEST_ALGORITHM)}`,
    );
  }
  digestAt(integrity, "digest", "$.integrity", issues);
  if (integrity.dsseEnvelope !== undefined) {
    validateDsseEnvelope(integrity.dsseEnvelope, issues);
  }
}

function validateDsseEnvelope(value: unknown, issues: WorkerContractIssue[]): void {
  const envelope = recordAt(value, "$.integrity.dsseEnvelope", issues);
  if (!envelope) return;
  expectKeys(
    envelope,
    ["payloadType", "payload", "signatures"],
    "$.integrity.dsseEnvelope",
    issues,
  );
  if (envelope.payloadType !== WORKER_PACKAGE_DSSE_PAYLOAD_TYPE) {
    addIssue(
      issues,
      "$.integrity.dsseEnvelope.payloadType",
      "package.signature.payload_type",
      `must equal ${JSON.stringify(WORKER_PACKAGE_DSSE_PAYLOAD_TYPE)}`,
    );
  }
  base64At(envelope, "payload", "$.integrity.dsseEnvelope", issues);
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length === 0) {
    addIssue(
      issues,
      "$.integrity.dsseEnvelope.signatures",
      "package.signature.required",
      "must contain at least one signature",
    );
    return;
  }
  envelope.signatures.forEach((entry, index) => {
    const path = `$.integrity.dsseEnvelope.signatures[${index}]`;
    const signature = recordAt(entry, path, issues);
    if (!signature) return;
    expectKeys(signature, ["keyid", "sig"], path, issues);
    nonEmptyStringAt(signature, "keyid", path, issues, true);
    base64At(signature, "sig", path, issues);
  });
}

function validateDssePayloadBinding(
  workerPackage: WorkerPackage,
  issues: WorkerContractIssue[],
): void {
  const envelope = workerPackage.integrity.dsseEnvelope;
  if (!envelope) return;
  const decoded = decodeBase64(envelope.payload);
  const expected = canonicalWorkerPackageBytes(workerPackage);
  if (
    decoded.byteLength !== expected.byteLength ||
    !timingSafeEqual(Buffer.from(decoded), Buffer.from(expected))
  ) {
    addIssue(
      issues,
      "$.integrity.dsseEnvelope.payload",
      "package.signature.payload_mismatch",
      "must encode the exact canonical package subject bytes",
    );
  }
}

function strictArrayKeys(
  value: unknown,
  keys: readonly string[],
  path: string,
  issues: WorkerContractIssue[],
): void {
  if (!Array.isArray(value)) return;
  value.forEach((entry, index) => {
    if (isRecord(entry)) expectKeys(entry, keys, `${path}[${index}]`, issues);
  });
}

function recordAt(
  value: unknown,
  path: string,
  issues: WorkerContractIssue[],
): UnknownRecord | null {
  if (!isRecord(value)) {
    addIssue(issues, path, "type.object", "must be an object");
    return null;
  }
  return value;
}

function expectKeys(
  record: UnknownRecord,
  allowed: readonly string[],
  path: string,
  issues: WorkerContractIssue[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      addIssue(
        issues,
        `${path}.${key}`,
        "package.unexpected_field",
        "is not part of WorkerPackage v1",
      );
    }
  }
}

function nonEmptyStringAt(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: WorkerContractIssue[],
  optional = false,
): string | undefined {
  const value = record[key];
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    addIssue(issues, `${path}.${key}`, "type.non_empty_string", "must be a non-empty string");
    return undefined;
  }
  if (value.length > 2_048) {
    addIssue(issues, `${path}.${key}`, "string.max_length", "must not exceed 2048 characters");
  }
  return value;
}

function positiveIntegerAt(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: WorkerContractIssue[],
): void {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    addIssue(
      issues,
      `${path}.${key}`,
      "number.positive_safe_integer",
      "must be a positive safe integer",
    );
  }
}

function nonNegativeIntegerAt(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: WorkerContractIssue[],
): void {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    addIssue(
      issues,
      `${path}.${key}`,
      "number.non_negative_safe_integer",
      "must be a non-negative safe integer",
    );
  }
}

function canonicalTimestampAt(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: WorkerContractIssue[],
): void {
  const value = nonEmptyStringAt(record, key, path, issues);
  if (!value) return;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== value) {
    addIssue(
      issues,
      `${path}.${key}`,
      "timestamp.utc_iso",
      "must be a canonical UTC ISO-8601 timestamp",
    );
  }
}

function enumAt(
  record: UnknownRecord,
  key: string,
  allowed: readonly string[],
  path: string,
  issues: WorkerContractIssue[],
): void {
  if (typeof record[key] !== "string" || !allowed.includes(record[key])) {
    addIssue(issues, `${path}.${key}`, "enum", `must be one of: ${allowed.join(", ")}`);
  }
}

function digestAt(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: WorkerContractIssue[],
): void {
  if (typeof record[key] !== "string" || !/^sha256:[a-f0-9]{64}$/.test(record[key])) {
    addIssue(
      issues,
      `${path}.${key}`,
      "package.digest_format",
      "must be a lowercase sha256 digest",
    );
  }
}

function base64At(
  record: UnknownRecord,
  key: string,
  path: string,
  issues: WorkerContractIssue[],
): void {
  const value = record[key];
  if (typeof value !== "string" || !isBase64(value)) {
    addIssue(
      issues,
      `${path}.${key}`,
      "package.base64",
      "must be non-empty standard or URL-safe base64",
    );
  }
}

function isBase64(value: string): boolean {
  if (!value || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return false;
  const unpaddedLength = value.replace(/=+$/, "").length;
  return unpaddedLength % 4 !== 1;
}

function decodeBase64(value: string): Uint8Array {
  return Buffer.from(value, value.includes("-") || value.includes("_") ? "base64url" : "base64");
}

function appendNestedIssues(
  target: WorkerContractIssue[],
  path: string,
  nested: readonly WorkerContractIssue[],
): void {
  target.push(
    ...nested.map((entry) => ({
      ...entry,
      path: entry.path === "$" ? path : `${path}${entry.path.slice(1)}`,
    })),
  );
}

function safeStringEqual(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string") return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function addIssue(
  issues: WorkerContractIssue[],
  path: string,
  code: string,
  message: string,
): void {
  issues.push({ path, code, message });
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function workerPackageDsseEnvelope(
  workerPackage: WorkerPackage,
  signatures: WorkerPackageDsseEnvelope["signatures"],
): WorkerPackageDsseEnvelope {
  return {
    payloadType: WORKER_PACKAGE_DSSE_PAYLOAD_TYPE,
    payload: Buffer.from(canonicalWorkerPackageBytes(workerPackage)).toString("base64"),
    signatures,
  };
}
