import {
  createJobMetricSnapshotsRepository,
  type JobMetricSnapshotsRepository,
} from "../repositories/job-metric-snapshots-repo.js";
import type { JobMetricSnapshotRecord, PacketAgentData } from "../packetagent-store.js";

export interface ListJobMetricSnapshotsOptions {
  type?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export interface ListJobMetricSnapshotsDeps {
  loadStore?: () => PacketAgentData;
  mutateStore?: <T>(mutator: (data: PacketAgentData) => T) => T;
  repository?: JobMetricSnapshotsRepository;
}

export function listJobMetricSnapshotsViaRepository(
  options: ListJobMetricSnapshotsOptions = {},
  deps: ListJobMetricSnapshotsDeps = {},
): JobMetricSnapshotRecord[] {
  const repo =
    deps.repository ??
    createJobMetricSnapshotsRepository({
      loadStore: deps.loadStore,
      mutateStore: deps.mutateStore,
    });
  return repo.list(options);
}
