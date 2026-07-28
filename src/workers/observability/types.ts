export const WORKER_EVIDENCE_SCHEMA_VERSION = "packetagent.worker-evidence/v1" as const;
export const WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION =
  "packetagent.worker-artifact-manifest/v1" as const;

export type WorkerEvidenceRedactionClassification =
  | "public_metadata"
  | "internal"
  | "sensitive_reference";

export type WorkerEvidenceSourceKind =
  | "worker_event"
  | "activation_inbox"
  | "execution_job"
  | "provider_call"
  | "tool_call"
  | "effect_receipt"
  | "checkpoint"
  | "attention_request"
  | "approval_grant"
  | "control_command";

export interface WorkerEvidenceSourceReference {
  readonly kind: WorkerEvidenceSourceKind;
  readonly id: string;
  readonly digest?: string;
}

export interface WorkerEvidencePayloadReference {
  readonly state: "retained";
  readonly reference: string;
  readonly contentDigest: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly classification: WorkerEvidenceRedactionClassification;
  readonly expiresAt?: string;
}

export interface WorkerEvidenceEntry {
  readonly schemaVersion: typeof WORKER_EVIDENCE_SCHEMA_VERSION;
  readonly id: string;
  readonly workspaceId: string;
  readonly sequence: number;
  readonly workerDefinitionId: string;
  readonly workerVersionId?: string;
  readonly workerDeploymentId?: string;
  readonly workerRunId?: string;
  readonly sourceEventId: string;
  readonly sourceEventDigest: string;
  readonly sourceReferences: readonly WorkerEvidenceSourceReference[];
  readonly traceId?: string;
  readonly spanId?: string;
  readonly summary: string;
  readonly classification: WorkerEvidenceRedactionClassification;
  readonly rawPayload?: WorkerEvidencePayloadReference;
  readonly artifactManifestIds?: readonly string[];
  readonly evidenceDigest: string;
  readonly createdAt: string;
}

export interface WorkerArtifactResourceDescriptor {
  readonly reference: string;
  readonly name?: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly contentDigest: string;
}

export type WorkerArtifactProducerKind =
  | "worker_provider"
  | "worker_tool"
  | "worker_runtime"
  | "external";

export interface WorkerArtifactProvenance {
  readonly producerKind: WorkerArtifactProducerKind;
  readonly producerId: string;
  readonly sourceEvidenceIds: readonly string[];
  readonly materials: readonly WorkerArtifactResourceDescriptor[];
}

export interface WorkerArtifactManifest {
  readonly schemaVersion: typeof WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION;
  readonly id: string;
  readonly workspaceId: string;
  readonly workerDefinitionId: string;
  readonly workerVersionId: string;
  readonly workerDeploymentId: string;
  readonly workerRunId: string;
  readonly artifact: WorkerArtifactResourceDescriptor;
  readonly classification: WorkerEvidenceRedactionClassification;
  readonly provenance: WorkerArtifactProvenance;
  readonly manifestDigest: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
}
