import { randomUUID } from "node:crypto";
import { mutateStoreAsync, type PacketAgentData } from "../packetagent-store.js";
import {
  decryptSecret,
  encryptSecret,
  loadMasterKey,
  type EncryptedSecret,
} from "../security/vault.js";
import {
  WORKER_CREDENTIAL_SCHEMA_VERSION,
  assertValidWorkerCredentialRecord,
  isWorkerCredentialReference,
  type WorkerCredentialKind,
  type WorkerCredentialMetadata,
  type WorkerCredentialRecord,
} from "./credential-types.js";

export type WorkerCredentialErrorCode = "invalid" | "not_found" | "not_declared" | "kind_mismatch";

export class WorkerCredentialError extends Error {
  readonly code: WorkerCredentialErrorCode;

  constructor(code: WorkerCredentialErrorCode, message: string) {
    super(message);
    this.name = "WorkerCredentialError";
    this.code = code;
  }
}

export interface UpsertWorkerCredentialInput {
  readonly workspaceId: string;
  readonly reference: string;
  readonly kind: WorkerCredentialKind;
  readonly label: string;
  readonly value: string;
}

export interface UseWorkerCredentialInput {
  readonly workspaceId: string;
  readonly reference: string;
  readonly declaredCredentialRefs: readonly string[];
  readonly expectedKinds: readonly WorkerCredentialKind[];
}

export interface WorkerCredentialService {
  list(workspaceId: string): Promise<readonly WorkerCredentialMetadata[]>;
  upsert(input: UpsertWorkerCredentialInput): Promise<WorkerCredentialMetadata>;
  remove(workspaceId: string, reference: string): Promise<boolean>;
  use<TResult>(
    input: UseWorkerCredentialInput,
    consumer: (value: string, metadata: WorkerCredentialMetadata) => Promise<TResult> | TResult,
  ): Promise<TResult>;
}

export interface WorkerCredentialServiceDeps {
  readonly mutateStore: <T>(mutator: (data: PacketAgentData) => T | Promise<T>) => Promise<T>;
  readonly masterKey: () => Buffer;
  readonly generateId: () => string;
  readonly now: () => string;
}

const defaultDeps: WorkerCredentialServiceDeps = {
  mutateStore: mutateStoreAsync,
  masterKey: loadMasterKey,
  generateId: randomUUID,
  now: () => new Date().toISOString(),
};

export function createWorkerCredentialService(
  deps: WorkerCredentialServiceDeps = defaultDeps,
): WorkerCredentialService {
  return {
    async list(workspaceId) {
      assertNonEmpty(workspaceId, "workspaceId");
      return deps.mutateStore((data) =>
        data.workerCredentials
          .filter((record) => record.workspaceId === workspaceId)
          .map(toMetadata)
          .sort((left, right) => left.reference.localeCompare(right.reference)),
      );
    },

    async upsert(input) {
      validateUpsert(input);
      const encrypted = encryptSecret(input.value, deps.masterKey());
      const timestamp = deps.now();
      return deps.mutateStore((data) => {
        const existing = data.workerCredentials.find(
          (record) =>
            record.workspaceId === input.workspaceId && record.reference === input.reference,
        );
        if (existing) {
          const updated: WorkerCredentialRecord = {
            ...existing,
            kind: input.kind,
            label: input.label.trim(),
            ...encryptedFields(encrypted),
            updatedAt: timestamp,
          };
          assertValidWorkerCredentialRecord(updated);
          data.workerCredentials.splice(data.workerCredentials.indexOf(existing), 1, updated);
          return toMetadata(updated);
        }
        const record: WorkerCredentialRecord = {
          schemaVersion: WORKER_CREDENTIAL_SCHEMA_VERSION,
          id: deps.generateId(),
          workspaceId: input.workspaceId,
          reference: input.reference,
          kind: input.kind,
          label: input.label.trim(),
          ...encryptedFields(encrypted),
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        assertValidWorkerCredentialRecord(record);
        data.workerCredentials.push(record);
        return toMetadata(record);
      });
    },

    async remove(workspaceId, reference) {
      validateReferenceInput(workspaceId, reference);
      return deps.mutateStore((data) => {
        const index = data.workerCredentials.findIndex(
          (record) => record.workspaceId === workspaceId && record.reference === reference,
        );
        if (index < 0) return false;
        data.workerCredentials.splice(index, 1);
        return true;
      });
    },

    async use(input, consumer) {
      validateReferenceInput(input.workspaceId, input.reference);
      if (!input.declaredCredentialRefs.includes(input.reference)) {
        throw new WorkerCredentialError(
          "not_declared",
          "Worker credential reference is not declared by the immutable Worker version.",
        );
      }
      if (input.expectedKinds.length === 0) {
        throw new WorkerCredentialError(
          "invalid",
          "Worker credential resolution requires at least one expected kind.",
        );
      }

      const resolved = await deps.mutateStore((data) => {
        const index = data.workerCredentials.findIndex(
          (record) =>
            record.workspaceId === input.workspaceId && record.reference === input.reference,
        );
        if (index < 0) {
          throw new WorkerCredentialError("not_found", "Worker credential was not found.");
        }
        const record = data.workerCredentials[index];
        if (!input.expectedKinds.includes(record.kind)) {
          throw new WorkerCredentialError(
            "kind_mismatch",
            "Worker credential kind does not match the requested operation.",
          );
        }
        const updated: WorkerCredentialRecord = {
          ...record,
          lastResolvedAt: deps.now(),
        };
        data.workerCredentials[index] = updated;
        return {
          metadata: toMetadata(updated),
          value: decryptSecret(secretFields(record), deps.masterKey()),
        };
      });

      let value = resolved.value;
      try {
        return await consumer(value, resolved.metadata);
      } finally {
        value = "";
      }
    },
  };
}

function validateUpsert(input: UpsertWorkerCredentialInput): void {
  validateReferenceInput(input.workspaceId, input.reference);
  if (!input.label.trim()) {
    throw new WorkerCredentialError("invalid", "Worker credential label is required.");
  }
  if (!input.value) {
    throw new WorkerCredentialError("invalid", "Worker credential value is required.");
  }
}

function validateReferenceInput(workspaceId: string, reference: string): void {
  assertNonEmpty(workspaceId, "workspaceId");
  if (!isWorkerCredentialReference(reference)) {
    throw new WorkerCredentialError(
      "invalid",
      "Worker credentials require an opaque vault: reference.",
    );
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new WorkerCredentialError("invalid", `${field} is required.`);
  }
}

function encryptedFields(
  secret: EncryptedSecret,
): Pick<WorkerCredentialRecord, "ciphertext" | "iv" | "authTag"> {
  return secret;
}

function secretFields(
  record: WorkerCredentialRecord,
): Pick<WorkerCredentialRecord, "ciphertext" | "iv" | "authTag"> {
  return {
    ciphertext: record.ciphertext,
    iv: record.iv,
    authTag: record.authTag,
  };
}

export function workerCredentialMetadata(record: WorkerCredentialRecord): WorkerCredentialMetadata {
  return toMetadata(record);
}

function toMetadata(record: WorkerCredentialRecord): WorkerCredentialMetadata {
  const { ciphertext: _ciphertext, iv: _iv, authTag: _authTag, ...metadata } = record;
  return { ...metadata, encrypted: true };
}
