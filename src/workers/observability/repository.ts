import {
  loadStoreAsync as defaultLoadStore,
  type PacketAgentData,
} from "../../packetagent-store.js";
import type { WorkerEvent } from "../persistence-types.js";
import { validateWorkerPersistence } from "../repository.js";
import { isWorkerEventV2 } from "./journal.js";
import type { WorkerArtifactManifest, WorkerEvidenceEntry } from "./types.js";

type MaybePromise<T> = T | Promise<T>;

export interface WorkerObservabilityRepositoryDependencies {
  readonly loadStore?: () => MaybePromise<PacketAgentData>;
}

export interface WorkerObservabilityStreamOptions {
  readonly workerDeploymentId?: string;
  readonly workerRunId?: string;
  readonly afterSequence?: number;
  readonly limit?: number;
}

export interface WorkerArtifactManifestListOptions {
  readonly workerDeploymentId?: string;
  readonly workerRunId?: string;
  readonly limit?: number;
}

export interface WorkerObservabilityRepository {
  listEvents(
    workspaceId: string,
    options?: WorkerObservabilityStreamOptions,
  ): Promise<readonly WorkerEvent[]>;
  listEvidence(
    workspaceId: string,
    options?: WorkerObservabilityStreamOptions,
  ): Promise<readonly WorkerEvidenceEntry[]>;
  listArtifactManifests(
    workspaceId: string,
    options?: WorkerArtifactManifestListOptions,
  ): Promise<readonly WorkerArtifactManifest[]>;
}

export function createWorkerObservabilityRepository(
  dependencies: WorkerObservabilityRepositoryDependencies = {},
): WorkerObservabilityRepository {
  const loadStore = dependencies.loadStore ?? defaultLoadStore;
  return {
    async listEvents(workspaceId, options = {}) {
      const data = await loadStore();
      validateWorkerPersistence(data);
      return clone(
        data.workerEvents
          .filter(
            (event) =>
              event.workspaceId === workspaceId &&
              event.sequence > (options.afterSequence ?? 0) &&
              (options.workerDeploymentId === undefined ||
                event.workerDeploymentId === options.workerDeploymentId) &&
              (options.workerRunId === undefined ||
                (isWorkerEventV2(event)
                  ? event.workerRunId === options.workerRunId
                  : event.data?.workerRunId === options.workerRunId)),
          )
          .sort((left, right) => left.sequence - right.sequence)
          .slice(0, limit(options.limit)),
      );
    },
    async listEvidence(workspaceId, options = {}) {
      const data = await loadStore();
      validateWorkerPersistence(data);
      return clone(
        data.workerEvidenceEntries
          .filter(
            (entry) =>
              entry.workspaceId === workspaceId &&
              entry.sequence > (options.afterSequence ?? 0) &&
              (options.workerDeploymentId === undefined ||
                entry.workerDeploymentId === options.workerDeploymentId) &&
              (options.workerRunId === undefined || entry.workerRunId === options.workerRunId),
          )
          .sort((left, right) => left.sequence - right.sequence)
          .slice(0, limit(options.limit)),
      );
    },
    async listArtifactManifests(workspaceId, options = {}) {
      const data = await loadStore();
      validateWorkerPersistence(data);
      return clone(
        data.workerArtifactManifests
          .filter(
            (manifest) =>
              manifest.workspaceId === workspaceId &&
              (options.workerDeploymentId === undefined ||
                manifest.workerDeploymentId === options.workerDeploymentId) &&
              (options.workerRunId === undefined || manifest.workerRunId === options.workerRunId),
          )
          .sort((left, right) => {
            const created = left.createdAt.localeCompare(right.createdAt);
            return created !== 0 ? created : left.id.localeCompare(right.id);
          })
          .slice(0, limit(options.limit)),
      );
    },
  };
}

function limit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value <= 0) return 1;
  return Math.min(value, 500);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
