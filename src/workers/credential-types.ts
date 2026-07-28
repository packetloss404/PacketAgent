export const WORKER_CREDENTIAL_SCHEMA_VERSION = "packetagent.worker-credential/v1" as const;

export type WorkerCredentialKind =
  | "api_key"
  | "bearer_token"
  | "webhook_url"
  | "smtp_config"
  | "opaque";

export interface WorkerCredentialRecord {
  readonly schemaVersion: typeof WORKER_CREDENTIAL_SCHEMA_VERSION;
  readonly id: string;
  readonly workspaceId: string;
  readonly reference: string;
  readonly kind: WorkerCredentialKind;
  readonly label: string;
  readonly ciphertext: string;
  readonly iv: string;
  readonly authTag: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastResolvedAt?: string;
}

export interface WorkerCredentialMetadata extends Omit<
  WorkerCredentialRecord,
  "ciphertext" | "iv" | "authTag"
> {
  readonly encrypted: true;
}

export function isWorkerCredentialReference(value: string): boolean {
  return /^vault:[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value);
}

export function assertValidWorkerCredentialRecord(record: WorkerCredentialRecord): void {
  if (
    record.schemaVersion !== WORKER_CREDENTIAL_SCHEMA_VERSION ||
    !record.id ||
    !record.workspaceId ||
    !isWorkerCredentialReference(record.reference) ||
    !["api_key", "bearer_token", "webhook_url", "smtp_config", "opaque"].includes(record.kind) ||
    !record.label.trim() ||
    !record.ciphertext ||
    !record.iv ||
    !record.authTag ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    !Number.isFinite(Date.parse(record.updatedAt)) ||
    (record.lastResolvedAt !== undefined && !Number.isFinite(Date.parse(record.lastResolvedAt)))
  ) {
    throw new Error("Worker credential record is invalid.");
  }
}
