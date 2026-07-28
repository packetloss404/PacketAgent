import { redactSensitiveString, redactSensitiveValue } from "../../security/redaction.js";
import type { WorkerEvent } from "../persistence-types.js";
import type {
  WorkerArtifactManifest,
  WorkerEvidenceEntry,
  WorkerEvidencePayloadReference,
} from "./types.js";

export function redactWorkerEventForRead(
  event: WorkerEvent,
  knownSecretValues: readonly (string | null | undefined)[] = [],
): WorkerEvent {
  return {
    ...event,
    summary: redactSensitiveString(event.summary, knownSecretValues),
    ...(event.data
      ? {
          data: redactSensitiveValue(event.data, knownSecretValues) as WorkerEvent["data"],
        }
      : {}),
  };
}

export function redactWorkerEvidenceForRead(
  evidence: WorkerEvidenceEntry,
  knownSecretValues: readonly (string | null | undefined)[] = [],
): WorkerEvidenceEntry {
  return {
    ...evidence,
    summary: redactSensitiveString(evidence.summary, knownSecretValues),
    ...(evidence.rawPayload
      ? {
          rawPayload: redactPayloadReference(evidence.rawPayload, knownSecretValues),
        }
      : {}),
  };
}

export function redactWorkerArtifactManifestForRead(
  manifest: WorkerArtifactManifest,
  knownSecretValues: readonly (string | null | undefined)[] = [],
): WorkerArtifactManifest {
  return {
    ...manifest,
    artifact: {
      ...manifest.artifact,
      reference: redactSensitiveString(manifest.artifact.reference, knownSecretValues),
      ...(manifest.artifact.name
        ? {
            name: redactSensitiveString(manifest.artifact.name, knownSecretValues),
          }
        : {}),
    },
    provenance: {
      ...manifest.provenance,
      materials: manifest.provenance.materials.map((material) => ({
        ...material,
        reference: redactSensitiveString(material.reference, knownSecretValues),
        ...(material.name
          ? {
              name: redactSensitiveString(material.name, knownSecretValues),
            }
          : {}),
      })),
    },
  };
}

function redactPayloadReference(
  reference: WorkerEvidencePayloadReference,
  knownSecretValues: readonly (string | null | undefined)[],
): WorkerEvidencePayloadReference {
  return {
    ...reference,
    reference: redactSensitiveString(reference.reference, knownSecretValues),
  };
}
