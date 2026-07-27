import { fileURLToPath } from "node:url";
import { migrateLegacyDefaultDataFiles } from "./brand.js";
import { resolve } from "node:path";
import { readActivationStatus } from "./activation/api";
import type {
  ActivationMilestoneRecord,
  ActivationSignalSnapshot,
  ActivationStatusDto,
  ActivationSubjectRef,
} from "./activation/domain";
import { deriveActivationStatus } from "./activation/service";
import {
  loadStore as loadDefaultStore,
  mutateStore as mutateDefaultStore,
  snapshotForWorkspace,
  type PacketAgentData,
  upsertActivationSignal,
} from "./packetagent-store";
import { exportWorkspaceData } from "./jobs/export-workspace.js";
import { reconcileInvitationEmails } from "./jobs/reconcile-invitation-emails.js";
import { snapshotJobMetrics } from "./jobs/job-metrics-snapshot.js";

export interface StoreJobDeps {
  loadStore: () => PacketAgentData;
  mutateStore: <T>(mutator: (data: PacketAgentData) => T) => T;
}

export interface RecomputeActivationDeps extends StoreJobDeps {
  derive?: (
    subject: ActivationSubjectRef,
    snapshot: ActivationSignalSnapshot,
    priorMilestones: ReadonlyArray<ActivationMilestoneRecord>,
  ) => ActivationStatusDto;
  loadSnapshot?: (data: PacketAgentData, workspaceId: string) => ActivationSignalSnapshot | Promise<ActivationSignalSnapshot>;
}

export interface RecomputeActivationOptions {
  workspaceIds?: string[];
}

export interface RecomputeActivationResult {
  command: "recompute-activation";
  processed: number;
  workspaceIds: string[];
  statuses: ActivationStatusDto[];
}

export interface RepairActivationReadModelsResult {
  command: "repair-activation-read-models";
  processed: number;
  repaired: number;
  workspaceIds: string[];
  repairedWorkspaceIds: string[];
  statuses: ActivationStatusDto[];
}

export interface CleanupSessionsOptions {
  now?: Date | string | number;
}

export interface CleanupSessionsResult {
  command: "cleanup-sessions";
  removed: number;
  remaining: number;
  removedSessionIds: string[];
}

const defaultDeps: StoreJobDeps = {
  loadStore: loadDefaultStore,
  mutateStore: mutateDefaultStore,
};

export async function recomputeActivationReadModels(
  deps: RecomputeActivationDeps = defaultDeps,
  options: RecomputeActivationOptions = {},
): Promise<RecomputeActivationResult> {
  const initialData = deps.loadStore();
  const workspaceIds = options.workspaceIds ?? initialData.workspaces.map((workspace) => workspace.id);
  const statuses: ActivationStatusDto[] = [];

  for (const workspaceId of workspaceIds) {
    const subject = activationSubjectForWorkspace(workspaceId);
    normalizeLegacyActivationSignals(deps, workspaceId);
    const result = await readActivationStatus(
      {
        signals: {
          loadSnapshot: async () => {
            const data = deps.loadStore();
            return deps.loadSnapshot
              ? deps.loadSnapshot(data, workspaceId)
              : snapshotForWorkspace(data, workspaceId);
          },
        },
        milestones: {
          listForSubject: async () => deps.loadStore().activationMilestones[workspaceId] ?? [],
        },
        derive: deps.derive ?? deriveActivationStatus,
        readModel: {
          save: async (status) => {
            deps.mutateStore((data) => {
              data.activationReadModels[workspaceId] = status;
              data.activationMilestones[workspaceId] = status.milestones;
            });
          },
          load: async () => deps.loadStore().activationReadModels[workspaceId] ?? null,
        },
      },
      { subject },
    );

    statuses.push(result.status);
  }

  return {
    command: "recompute-activation",
    processed: statuses.length,
    workspaceIds,
    statuses,
  };
}

function normalizeLegacyActivationSignals(deps: StoreJobDeps, workspaceId: string): void {
  deps.mutateStore((data) => {
    const facts = data.activationFacts[workspaceId];
    if (!facts) return;
    const timestamp = facts.now;
    if (!timestamp) return;
    recordLegacySignalCount(data, workspaceId, "retry", "retryCount", facts.retryCount ?? 0, timestamp);
    recordLegacySignalCount(data, workspaceId, "scope_change", "scopeChangeCount", facts.scopeChangeCount ?? 0, timestamp);
  });
}

function recordLegacySignalCount(
  data: PacketAgentData,
  workspaceId: string,
  kind: "retry" | "scope_change",
  factName: "retryCount" | "scopeChangeCount",
  count: number,
  timestamp: string,
): void {
  if (data.activationSignals.some((entry) => entry.workspaceId === workspaceId && entry.kind === kind)) return;
  for (let index = 0; index < count; index += 1) {
    upsertActivationSignal(data, {
      workspaceId,
      kind,
      source: "user_fact",
      origin: "user_entered",
      stableKey: `${workspaceId}:${kind}:legacy_fact:${index}`,
      data: {
        origin: "legacy_fact",
        factName,
        factIndex: index,
      },
    }, timestamp);
  }
}

export async function repairActivationReadModels(
  deps: RecomputeActivationDeps = defaultDeps,
  options: RecomputeActivationOptions = {},
): Promise<RepairActivationReadModelsResult> {
  const initialData = deps.loadStore();
  const workspaceIds = options.workspaceIds ?? initialData.workspaces.map((workspace) => workspace.id);
  const before = new Map(workspaceIds.map((workspaceId) => [workspaceId, initialData.activationReadModels[workspaceId] ?? null]));
  const recompute = await recomputeActivationReadModels(deps, options);
  const repairedWorkspaceIds = recompute.statuses
    .filter((status) => !activationStatusEquals(before.get(status.subject.workspaceId) ?? null, status))
    .map((status) => status.subject.workspaceId);

  return {
    command: "repair-activation-read-models",
    processed: recompute.processed,
    repaired: repairedWorkspaceIds.length,
    workspaceIds: recompute.workspaceIds,
    repairedWorkspaceIds,
    statuses: recompute.statuses,
  };
}

export function cleanupExpiredSessions(
  deps: StoreJobDeps = defaultDeps,
  options: CleanupSessionsOptions = {},
): CleanupSessionsResult {
  const referenceTime = normalizeTimestamp(options.now ?? Date.now());
  return deps.mutateStore((data) => {
    const removedSessionIds: string[] = [];
    data.sessions = data.sessions.filter((session) => {
      const expiresAt = Date.parse(session.expiresAt);
      const keep = Number.isFinite(expiresAt) && expiresAt > referenceTime;
      if (!keep) removedSessionIds.push(session.id);
      return keep;
    });

    return {
      command: "cleanup-sessions",
      removed: removedSessionIds.length,
      remaining: data.sessions.length,
      removedSessionIds,
    };
  });
}

export async function runJobsCli(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...args] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    writeUsage();
    return command ? 0 : 1;
  }

  if (command === "recompute-activation") {
    const workspaceIds = parseWorkspaceIds(args);
    const result = await recomputeActivationReadModels(defaultDeps, { workspaceIds });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (command === "repair-activation-read-models") {
    const workspaceIds = parseWorkspaceIds(args);
    const result = await repairActivationReadModels(defaultDeps, { workspaceIds });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (command === "cleanup-sessions") {
    const result = cleanupExpiredSessions(defaultDeps);
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (command === "export-workspace") {
    const workspaceId = parseStringFlag(args, "--workspace-id=");
    if (!workspaceId) {
      console.error("export-workspace requires --workspace-id=<id>");
      writeUsage();
      return 1;
    }
    const result = exportWorkspaceData({ workspaceId });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (command === "reconcile-invitation-emails") {
    const workspaceId = parseStringFlag(args, "--workspace-id=");
    const invitationId = parseStringFlag(args, "--invitation-id=");
    const deliveryId = parseStringFlag(args, "--delivery-id=");
    const markResolved = args.includes("--mark-resolved");
    const requeue = args.includes("--requeue");
    if ((markResolved || requeue) && !deliveryId) {
      console.error("--mark-resolved and --requeue require --delivery-id=<id>");
      writeUsage();
      return 1;
    }
    const result = reconcileInvitationEmails({ workspaceId, invitationId, deliveryId, markResolved, requeue });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (command === "snapshot-job-metrics") {
    const retentionRaw = parseStringFlag(args, "--retention-days=");
    const retentionDays = retentionRaw !== undefined ? Number.parseInt(retentionRaw, 10) : undefined;
    if (retentionDays !== undefined && (!Number.isInteger(retentionDays) || retentionDays < 0)) {
      console.error("--retention-days must be a non-negative integer");
      writeUsage();
      return 1;
    }
    const result = snapshotJobMetrics({ retentionDays });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  console.error(`Unknown jobs command: ${command}`);
  writeUsage();
  return 1;
}

export function activationSubjectForWorkspace(workspaceId: string): ActivationSubjectRef {
  return { workspaceId, subjectType: "workspace", subjectId: workspaceId };
}

function parseWorkspaceIds(args: string[]): string[] | undefined {
  const workspaceArg = args.find((arg) => arg.startsWith("--workspace-ids="));
  if (!workspaceArg) return undefined;
  const value = workspaceArg.slice("--workspace-ids=".length).trim();
  if (!value) return undefined;
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parseStringFlag(args: string[], prefix: string): string | undefined {
  const arg = args.find((entry) => entry.startsWith(prefix));
  if (!arg) return undefined;
  const value = arg.slice(prefix.length).trim();
  return value || undefined;
}

function normalizeTimestamp(value: Date | string | number): number {
  const timestamp = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("cleanup-sessions requires a valid reference time");
  }
  return timestamp;
}

function activationStatusEquals(left: ActivationStatusDto | null, right: ActivationStatusDto): boolean {
  return Boolean(left) && JSON.stringify(left) === JSON.stringify(right);
}

function writeUsage(): void {
  console.error("Usage: node --import tsx src/jobs.ts <recompute-activation|repair-activation-read-models|cleanup-sessions|export-workspace|reconcile-invitation-emails|snapshot-job-metrics>");
  console.error("Options:");
  console.error("  recompute-activation --workspace-ids=alpha,beta");
  console.error("  repair-activation-read-models --workspace-ids=alpha,beta");
  console.error("  export-workspace --workspace-id=alpha");
  console.error("  reconcile-invitation-emails [--workspace-id=alpha] [--invitation-id=inv] [--delivery-id=del] [--mark-resolved] [--requeue]");
  console.error("  snapshot-job-metrics [--retention-days=30]");
}

function isExecutedDirectly(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  return resolve(fileURLToPath(import.meta.url)) === resolve(entrypoint);
}

if (isExecutedDirectly()) {
  migrateLegacyDefaultDataFiles();
  runJobsCli().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
