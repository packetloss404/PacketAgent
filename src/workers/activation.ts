import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { JobRecord } from "../packetagent-store.js";
import { isSensitiveKey } from "../security/redaction.js";
import {
  decryptSecret,
  encryptSecret,
  loadMasterKey,
  type EncryptedSecret,
} from "../security/vault.js";
import {
  createWorkerActivationRepository,
  makeWorkerActivationEvent,
  type WorkerActivationRepository,
} from "./activation-repository.js";
import {
  WORKER_ACTIVATION_INBOX_SCHEMA_VERSION,
  WORKER_ACTIVATION_PAYLOAD_SCHEMA_VERSION,
  WORKER_ACTIVATION_SCHEMA_VERSION,
  type WorkerActivationAdmissionResult,
  type WorkerActivationEnvelope,
  type WorkerActivationInboxRecord,
  type WorkerActivationPayloadClassification,
  type WorkerActivationPayloadRecord,
  type WorkerActivationPayloadReference,
  type WorkerActivationSource,
} from "./activation-types.js";
import { WorkerLifecycleError } from "./errors.js";
import {
  WORKER_CONTRACT_SCHEMA_VERSION,
  type JsonObject,
  type JsonValue,
  type WorkerActorReference,
  type WorkerInputField,
  type WorkerInputSchema,
  type WorkerRun,
  type WorkerTraceContext,
  type WorkerTrigger,
} from "./types.js";
import { canonicalWorkerJson } from "./validation.js";

export const WORKER_EXECUTION_JOB_TYPE = "worker.run" as const;
export const DEFAULT_WORKER_INLINE_PAYLOAD_BYTES = 32 * 1024;
export const DEFAULT_WORKER_PAYLOAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type WorkerActivationCommitPhase =
  | "before_inbox_reservation"
  | "after_inbox_reservation"
  | "before_run_creation"
  | "after_run_creation"
  | "before_event_append"
  | "after_event_append"
  | "before_job_enqueue"
  | "after_job_enqueue";

export interface AdmitWorkerActivationInput {
  readonly workspaceId: string;
  readonly workerDeploymentId: string;
  readonly triggerId: string;
  readonly source: WorkerActivationSource;
  readonly deliveryId: string;
  readonly occurredAt?: string;
  readonly actor: WorkerActorReference;
  readonly payload?: JsonObject;
  readonly trace?: WorkerTraceContext;
}

export interface WorkerActivationServiceDependencies {
  readonly repository?: WorkerActivationRepository;
  readonly now?: () => Date;
  readonly id?: (kind: "activation" | "inbox" | "payload" | "run" | "event" | "job") => string;
  readonly maxInlinePayloadBytes?: number;
  readonly payloadRetentionMs?: number;
  readonly encrypt?: (plaintext: string) => EncryptedSecret;
  readonly decrypt?: (encrypted: EncryptedSecret) => string;
  readonly onCommitPhase?: (phase: WorkerActivationCommitPhase) => void;
}

export interface WorkerActivationService {
  admit(input: AdmitWorkerActivationInput): Promise<WorkerActivationAdmissionResult>;
  listInboxes(
    workspaceId: string,
    options?: { workerDeploymentId?: string; limit?: number },
  ): Promise<readonly WorkerActivationInboxRecord[]>;
  resolvePayload(workspaceId: string, reference: string): Promise<JsonObject>;
  pruneExpiredPayloads(workspaceId: string): Promise<number>;
}

export function createWorkerActivationService(
  dependencies: WorkerActivationServiceDependencies = {},
): WorkerActivationService {
  const repository = dependencies.repository ?? createWorkerActivationRepository();
  const now = dependencies.now ?? (() => new Date());
  const id = dependencies.id ?? defaultId;
  const maxInlinePayloadBytes =
    dependencies.maxInlinePayloadBytes ?? DEFAULT_WORKER_INLINE_PAYLOAD_BYTES;
  const payloadRetentionMs = dependencies.payloadRetentionMs ?? DEFAULT_WORKER_PAYLOAD_RETENTION_MS;
  const encrypt =
    dependencies.encrypt ?? ((plaintext: string) => encryptSecret(plaintext, loadMasterKey()));
  const decrypt =
    dependencies.decrypt ??
    ((encrypted: EncryptedSecret) => decryptSecret(encrypted, loadMasterKey()));
  const onCommitPhase = dependencies.onCommitPhase ?? (() => undefined);

  if (!Number.isSafeInteger(maxInlinePayloadBytes) || maxInlinePayloadBytes < 1) {
    throw new Error("maxInlinePayloadBytes must be a positive integer.");
  }
  if (!Number.isSafeInteger(payloadRetentionMs) || payloadRetentionMs < 1) {
    throw new Error("payloadRetentionMs must be a positive integer.");
  }

  return {
    async admit(input) {
      validateAdmissionContext(input);
      const payload = assertJsonObject(input.payload ?? {}, "payload");
      const payloadJson = canonicalWorkerJson(payload);
      const payloadDigest = digest(payloadJson);
      const requestDigest = digest(
        canonicalWorkerJson({
          workspaceId: input.workspaceId,
          workerDeploymentId: input.workerDeploymentId,
          triggerId: input.triggerId,
          source: input.source,
          deliveryId: input.deliveryId,
          actor: input.actor,
          payloadDigest,
        }),
      );

      return await repository.transact(input.workspaceId, (transaction) => {
        const duplicate = transaction.findInbox({
          workerDeploymentId: input.workerDeploymentId,
          triggerId: input.triggerId,
          source: input.source,
          deliveryId: input.deliveryId,
        });
        const receivedAt = now().toISOString();
        if (duplicate) {
          if (duplicate.requestDigest !== requestDigest) {
            throw new WorkerLifecycleError(
              "idempotency_mismatch",
              "Worker activation delivery ID was reused with different input.",
            );
          }
          const updated: WorkerActivationInboxRecord = {
            ...duplicate,
            lastSeenAt: receivedAt,
            duplicateCount: duplicate.duplicateCount + 1,
          };
          transaction.replaceInbox(updated);
          return {
            disposition: "duplicate",
            inbox: updated,
            runId: updated.workerRunId,
            executionJobId: updated.executionJobId,
          };
        }

        const deployment = transaction.findDeployment(input.workerDeploymentId);
        if (!deployment) {
          throw new WorkerLifecycleError(
            "not_found",
            `WorkerDeployment ${input.workerDeploymentId} was not found.`,
          );
        }
        if (deployment.status !== "active") {
          throw new WorkerLifecycleError(
            "invalid_transition",
            "Worker activation requires an active deployment.",
          );
        }
        const version = transaction.findVersion(deployment.workerVersionId);
        if (
          !version ||
          version.workerDefinitionId !== deployment.workerDefinitionId ||
          version.status !== "validated"
        ) {
          throw new WorkerLifecycleError(
            "integrity",
            "Active Worker deployment does not resolve to its validated version.",
          );
        }
        const definition = transaction.findDefinition(deployment.workerDefinitionId);
        if (!definition) {
          throw new WorkerLifecycleError(
            "integrity",
            "Active Worker deployment does not resolve to its definition.",
          );
        }
        const trigger = version.content.triggers.find(
          (candidate) => candidate.id === input.triggerId,
        );
        if (!trigger) {
          throw new WorkerLifecycleError(
            "not_found",
            `Worker trigger ${input.triggerId} was not found on the deployed version.`,
          );
        }
        assertTriggerCanReceive(trigger, input.source);
        const validatedPayload = validateWorkerInput(version.content.inputSchema, payload);
        const validatedPayloadJson = canonicalWorkerJson(validatedPayload);
        const validatedPayloadDigest = digest(validatedPayloadJson);
        const occurredAt = input.occurredAt ?? receivedAt;
        assertCanonicalTimestamp(occurredAt, "occurredAt");
        const trace = normalizeWorkerTrace(input.trace);
        const activationId = id("activation");
        const inboxId = id("inbox");
        const runId = id("run");
        const eventId = id("event");
        const jobId = id("job");
        const sensitive = containsSensitiveKey(validatedPayload);
        const byteLength = Buffer.byteLength(validatedPayloadJson, "utf8");
        const referencePayload = sensitive || byteLength > maxInlinePayloadBytes;
        let payloadRecord: WorkerActivationPayloadRecord | undefined;
        let payloadReference: WorkerActivationPayloadReference | undefined;

        if (referencePayload) {
          const payloadId = id("payload");
          const reference = `worker-activation-payload:${payloadId}`;
          const expiresAt = new Date(Date.parse(receivedAt) + payloadRetentionMs).toISOString();
          const classification: WorkerActivationPayloadClassification =
            sensitive && byteLength > maxInlinePayloadBytes
              ? "large_and_sensitive"
              : sensitive
                ? "sensitive"
                : "large";
          const encrypted = encrypt(validatedPayloadJson);
          payloadRecord = {
            schemaVersion: WORKER_ACTIVATION_PAYLOAD_SCHEMA_VERSION,
            id: payloadId,
            reference,
            workspaceId: input.workspaceId,
            digest: validatedPayloadDigest,
            byteLength,
            classification,
            ciphertext: encrypted.ciphertext,
            iv: encrypted.iv,
            authTag: encrypted.authTag,
            createdAt: receivedAt,
            expiresAt,
          };
          payloadReference = {
            reference,
            digest: validatedPayloadDigest,
            byteLength,
            classification,
            encrypted: true,
            expiresAt,
          };
          transaction.insertPayload(payloadRecord);
        }

        const envelope: WorkerActivationEnvelope = {
          schemaVersion: WORKER_ACTIVATION_SCHEMA_VERSION,
          id: activationId,
          source: input.source,
          deliveryId: input.deliveryId,
          occurredAt,
          receivedAt,
          actor: input.actor,
          workspaceId: input.workspaceId,
          workerDeploymentId: deployment.id,
          workerVersionId: version.id,
          triggerId: trigger.id,
          triggerKind: trigger.kind,
          ...(payloadReference
            ? {
                payloadReference,
                payloadRetention: {
                  mode: "encrypted_reference" as const,
                  policy: "expire_at" as const,
                  expiresAt: payloadReference.expiresAt,
                },
              }
            : {
                payload: validatedPayload,
                payloadRetention: {
                  mode: "inline" as const,
                  policy: "worker_run_lifetime" as const,
                },
              }),
          trace,
        };
        const run: WorkerRun = {
          schemaVersion: WORKER_CONTRACT_SCHEMA_VERSION,
          id: runId,
          workspaceId: input.workspaceId,
          workerDefinitionId: definition.id,
          workerVersionId: version.id,
          workerDeploymentId: deployment.id,
          triggerId: trigger.id,
          triggerKind: trigger.kind,
          status: "queued",
          attempt: 1,
          revision: 1,
          runtimeFence: 0,
          ...(payloadReference
            ? { inputReference: payloadReference.reference }
            : { input: validatedPayload }),
          budgetUsage: {
            elapsedMs: 0,
            iterations: 0,
            providerCostUsd: 0,
            consecutiveFailures: 0,
            toolCalls: 0,
          },
          trace,
          createdAt: receivedAt,
          updatedAt: receivedAt,
        };
        const job: JobRecord = {
          id: jobId,
          workspaceId: input.workspaceId,
          type: WORKER_EXECUTION_JOB_TYPE,
          payload: {
            workerRunId: run.id,
            workerDeploymentId: deployment.id,
            workerVersionId: version.id,
            activationInboxId: inboxId,
          },
          status: "queued",
          attempts: 0,
          maxAttempts: Math.max(1, version.content.policy.retry.maxAttempts),
          scheduledAt: receivedAt,
          createdAt: receivedAt,
          updatedAt: receivedAt,
        };
        const inbox: WorkerActivationInboxRecord = {
          schemaVersion: WORKER_ACTIVATION_INBOX_SCHEMA_VERSION,
          id: inboxId,
          workspaceId: input.workspaceId,
          workerDeploymentId: deployment.id,
          workerVersionId: version.id,
          triggerId: trigger.id,
          source: input.source,
          deliveryId: input.deliveryId,
          requestDigest,
          disposition: "accepted",
          workerRunId: run.id,
          executionJobId: job.id,
          envelope,
          firstSeenAt: receivedAt,
          lastSeenAt: receivedAt,
          duplicateCount: 0,
        };

        onCommitPhase("before_inbox_reservation");
        transaction.insertInbox(inbox);
        onCommitPhase("after_inbox_reservation");
        onCommitPhase("before_run_creation");
        transaction.insertRun(run);
        onCommitPhase("after_run_creation");
        onCommitPhase("before_event_append");
        transaction.appendEvent(
          makeWorkerActivationEvent({
            id: eventId,
            workspaceId: input.workspaceId,
            sequence: transaction.nextEventSequence(),
            type: "worker.activation.accepted",
            workerDefinitionId: definition.id,
            workerVersionId: version.id,
            workerDeploymentId: deployment.id,
            actor: input.actor,
            summary: `Worker ${definition.name} activation accepted from ${input.source}.`,
            data: {
              activationId,
              activationInboxId: inbox.id,
              source: input.source,
              deliveryId: input.deliveryId,
              workerRunId: run.id,
              executionJobId: job.id,
              payloadDisposition: payloadReference ? "encrypted_reference" : "inline",
            },
            occurredAt: receivedAt,
          }),
        );
        onCommitPhase("after_event_append");
        onCommitPhase("before_job_enqueue");
        transaction.insertJob(job);
        onCommitPhase("after_job_enqueue");

        return {
          disposition: "accepted",
          inbox,
          runId: run.id,
          executionJobId: job.id,
        };
      });
    },
    listInboxes(workspaceId, options) {
      return repository.listInboxes(workspaceId, options);
    },
    async resolvePayload(workspaceId, reference) {
      const record = await repository.findPayloadByReference(workspaceId, reference);
      if (!record) {
        throw new WorkerLifecycleError(
          "not_found",
          "Worker activation payload reference was not found or has expired.",
        );
      }
      if (Date.parse(record.expiresAt) <= now().getTime()) {
        throw new WorkerLifecycleError(
          "not_found",
          "Worker activation payload reference has expired.",
        );
      }
      let plaintext: string;
      try {
        plaintext = decrypt({
          ciphertext: record.ciphertext,
          iv: record.iv,
          authTag: record.authTag,
        });
      } catch (error) {
        throw new WorkerLifecycleError(
          "integrity",
          "Worker activation payload could not be decrypted.",
          { cause: error },
        );
      }
      if (digest(plaintext) !== record.digest) {
        throw new WorkerLifecycleError(
          "integrity",
          "Worker activation payload digest does not match its reference.",
        );
      }
      try {
        return assertJsonObject(JSON.parse(plaintext) as unknown, "payload");
      } catch (error) {
        throw new WorkerLifecycleError(
          "integrity",
          "Worker activation payload is not valid JSON.",
          { cause: error },
        );
      }
    },
    pruneExpiredPayloads(workspaceId) {
      return repository.pruneExpiredPayloads(workspaceId, now());
    },
  };
}

export function validateWorkerInput(schema: WorkerInputSchema, input: JsonObject): JsonObject {
  const output: Record<string, JsonValue> = { ...input };
  const fields = new Map(schema.fields.map((field) => [field.key, field]));
  if (!schema.additionalProperties) {
    for (const key of Object.keys(output)) {
      if (!fields.has(key)) {
        throw invalidInput(`payload.${key} is not allowed by the Worker input schema.`);
      }
    }
  }
  for (const field of schema.fields) {
    let value = output[field.key];
    if (value === undefined && field.defaultValue !== undefined) {
      value = field.defaultValue;
      output[field.key] = value;
    }
    if (value === undefined) {
      if (field.required) {
        throw invalidInput(`payload.${field.key} is required.`);
      }
      continue;
    }
    validateInputField(field, value);
  }
  return output;
}

export function workerTraceFromTraceparent(
  traceparent: string | undefined,
  tracestate?: string,
): WorkerTraceContext {
  if (!traceparent) return generateWorkerTrace();
  const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i.exec(
    traceparent.trim(),
  );
  if (
    !match ||
    match[1].toLowerCase() === "ff" ||
    /^0{32}$/.test(match[2]) ||
    /^0{16}$/.test(match[3])
  ) {
    throw invalidInput("traceparent must be a valid W3C trace context.");
  }
  const normalizedTraceState = tracestate?.trim();
  if (
    normalizedTraceState &&
    (normalizedTraceState.length > 512 || /[^\x20-\x7e]/.test(normalizedTraceState))
  ) {
    throw invalidInput("tracestate must be printable ASCII and at most 512 characters.");
  }
  return {
    traceId: match[2].toLowerCase(),
    spanId: match[3].toLowerCase(),
    ...(normalizedTraceState ? { traceState: normalizedTraceState } : {}),
  };
}

export function generateWorkerTrace(): WorkerTraceContext {
  return {
    traceId: nonZeroRandomHex(16),
    spanId: nonZeroRandomHex(8),
  };
}

function validateInputField(field: WorkerInputField, value: JsonValue): void {
  if (field.type === "string" && typeof value !== "string") {
    throw invalidInput(`payload.${field.key} must be a string.`);
  }
  if (field.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    throw invalidInput(`payload.${field.key} must be a finite number.`);
  }
  if (field.type === "boolean" && typeof value !== "boolean") {
    throw invalidInput(`payload.${field.key} must be a boolean.`);
  }
  if (field.type === "url") {
    if (typeof value !== "string") {
      throw invalidInput(`payload.${field.key} must be a URL string.`);
    }
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
    } catch {
      throw invalidInput(`payload.${field.key} must be an HTTP or HTTPS URL.`);
    }
  }
  if (field.type === "enum" && (typeof value !== "string" || !field.options?.includes(value))) {
    throw invalidInput(`payload.${field.key} must be one of the configured enum values.`);
  }
}

function assertTriggerCanReceive(trigger: WorkerTrigger, source: WorkerActivationSource): void {
  if (!trigger.enabled) {
    throw new WorkerLifecycleError(
      "invalid_transition",
      `Worker trigger ${trigger.id} is disabled.`,
    );
  }
  if (trigger.kind !== source) {
    throw invalidInput(`Worker trigger ${trigger.id} is ${trigger.kind}, not ${source}.`);
  }
}

function validateAdmissionContext(input: AdmitWorkerActivationInput): void {
  for (const [name, value] of [
    ["workspaceId", input.workspaceId],
    ["workerDeploymentId", input.workerDeploymentId],
    ["triggerId", input.triggerId],
    ["deliveryId", input.deliveryId],
    ["actor.id", input.actor?.id],
  ] as const) {
    if (typeof value !== "string" || !value.trim()) {
      throw invalidInput(`${name} is required.`);
    }
    if (value.length > 512) throw invalidInput(`${name} must be at most 512 characters.`);
  }
  if (!["manual", "cron", "webhook", "alert", "queue"].includes(input.source)) {
    throw invalidInput("source is not a supported Worker activation source.");
  }
  if (!["user", "system", "packet_product"].includes(input.actor.type)) {
    throw invalidInput("actor.type is invalid.");
  }
  if (input.occurredAt !== undefined) {
    assertCanonicalTimestamp(input.occurredAt, "occurredAt");
  }
  if (input.trace !== undefined) normalizeWorkerTrace(input.trace);
}

function normalizeWorkerTrace(trace: WorkerTraceContext | undefined): WorkerTraceContext {
  if (!trace) return generateWorkerTrace();
  if (
    !/^[0-9a-f]{32}$/i.test(trace.traceId) ||
    /^0{32}$/.test(trace.traceId) ||
    (trace.spanId !== undefined &&
      (!/^[0-9a-f]{16}$/i.test(trace.spanId) || /^0{16}$/.test(trace.spanId)))
  ) {
    throw invalidInput("trace must contain valid W3C trace and span identifiers.");
  }
  if (
    trace.traceState !== undefined &&
    (trace.traceState.length > 512 || /[^\x20-\x7e]/.test(trace.traceState))
  ) {
    throw invalidInput("trace.traceState must be printable ASCII and at most 512 characters.");
  }
  return {
    traceId: trace.traceId.toLowerCase(),
    ...(trace.spanId ? { spanId: trace.spanId.toLowerCase() } : {}),
    ...(trace.traceState ? { traceState: trace.traceState } : {}),
  };
}

function assertJsonObject(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidInput(`${name} must be a JSON object.`);
  }
  assertJsonValue(value, name, new Set());
  return value as JsonObject;
}

function assertJsonValue(value: unknown, path: string, seen: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidInput(`${path} must contain finite numbers.`);
    return;
  }
  if (typeof value !== "object") {
    throw invalidInput(`${path} must contain only JSON values.`);
  }
  if (seen.has(value)) throw invalidInput(`${path} must not contain circular values.`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${path}[${index}]`, seen));
  } else {
    for (const [key, entry] of Object.entries(value)) {
      assertJsonValue(entry, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function containsSensitiveKey(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveKey);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, entry]) => isSensitiveKey(key) || containsSensitiveKey(entry),
  );
}

function assertCanonicalTimestamp(value: string, name: string): void {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== value) {
    throw invalidInput(`${name} must be a canonical UTC ISO-8601 timestamp.`);
  }
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function nonZeroRandomHex(bytes: number): string {
  let value = "";
  while (!value || /^0+$/.test(value)) value = randomBytes(bytes).toString("hex");
  return value;
}

function defaultId(kind: "activation" | "inbox" | "payload" | "run" | "event" | "job"): string {
  return `worker-${kind}-${randomUUID()}`;
}

function invalidInput(message: string): WorkerLifecycleError {
  return new WorkerLifecycleError("invalid_input", message);
}
