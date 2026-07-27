import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type { ActivationStatusDto, ActivationSubjectRef } from "../activation/domain";
import { deriveActivationStatus } from "../activation/service";
import { buildActivationSummaryCard } from "../activation/view-model";
import { readActivationStatus } from "../activation/api";
import {
  defaultWorkspaceIdForUser,
  createInvitationEmailDelivery,
  loadStore,
  loadStoreAsync,
  mutateStoreAsync,
  recordActivity,
  type ActivityRecord,
  type ActivationSignalRecord,
  type WorkspaceInvitationRecord,
  type WorkspaceMemberRecord,
  type WorkspaceRecord,
  type WorkspaceRole,
  type JobRecord,
  type PacketAgentData,
  snapshotForWorkspace,
} from "../packetagent-store";
import { maskSecret as maskBearerSecret, redactSensitiveValue } from "../security/redaction.js";
import { LOCAL_INVITATION_EMAIL_PROVIDER, invitationEmailSubject, resolveInvitationEmailMode, resolveInvitationEmailRetryMaxAttempts, resolveInvitationEmailWebhookConfig } from "../invitation-email.js";
import { deliverInvitationEmail, type InvitationEmailDeliveryAction } from "../invitation-email-delivery.js";
import {
  buildSessionCookieValue,
  generateId,
  generateSessionSecret,
  hashSessionSecret,
  now,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
} from "../auth-utils";

export type AuthenticatedContext = {
  user: import("../packetagent-store").UserRecord;
  workspace: import("../packetagent-store").WorkspaceRecord;
  role: import("../packetagent-store").WorkspaceRole;
};

export const INVITATION_EMAIL_JOB_TYPE = "invitation.email";

export async function listPublicActivationSummaries() {
  const data = await loadStoreAsync();
  const summaries = [];
  for (const workspace of data.workspaces) {
    const status = await syncWorkspaceActivation(workspace.id, false, { type: "system", id: "public-read" });
    summaries.push({
      subject: toSubject(workspace.id),
      status,
      summary: buildActivationSummaryCard(status),
    });
  }
  return summaries;
}

export async function getPublicActivationSummary(workspaceId: string) {
  const data = await loadStoreAsync();
  const workspace = data.workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) return null;
  const status = await syncWorkspaceActivation(workspace.id, false, { type: "system", id: "public-read" });
  return {
    subject: toSubject(workspace.id),
    status,
    summary: buildActivationSummaryCard(status),
  };
}

export function stringOrUndefined(value: unknown): string | undefined {
  const next = String(value ?? "").trim();
  return next || undefined;
}

export function createSessionRecord(userId: string, timestamp: string) {
  const sessionId = generateId();
  const sessionSecret = generateSessionSecret();
  return {
    record: {
      id: sessionId,
      userId,
      secretHash: hashSessionSecret(sessionSecret),
      createdAt: timestamp,
      lastAccessedAt: timestamp,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    },
    cookieValue: buildSessionCookieValue(sessionId, sessionSecret),
  };
}

export function buildAuthenticatedContext(data: ReturnType<typeof loadStore>, userId: string): AuthenticatedContext {
  const user = data.users.find((entry) => entry.id === userId);
  if (!user) throw httpError(404, "user not found");
  const workspaceId = defaultWorkspaceIdForUser(data, userId);
  const workspace = data.workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) throw httpError(404, "workspace not found");
  const membership = data.memberships.find((entry) => entry.workspaceId === workspace.id && entry.userId === user.id);
  return { user, workspace, role: membership?.role ?? "viewer" };
}

export async function syncWorkspaceActivation(
  workspaceId: string,
  emitActivity: boolean,
  actor: ActivityRecord["actor"],
): Promise<ActivationStatusDto> {
  const status = await readActivationStatus(
    {
      signals: {
        loadSnapshot: async () => snapshotForWorkspace(await loadStoreAsync(), workspaceId),
      },
      milestones: {
        listForSubject: async () => (await loadStoreAsync()).activationMilestones[workspaceId] ?? [],
      },
      derive: deriveActivationStatus,
      readModel: {
        save: async (nextStatus) => {
          await mutateStoreAsync((data) => {
            const previous = data.activationReadModels[workspaceId];
            data.activationReadModels[workspaceId] = nextStatus;
            data.activationMilestones[workspaceId] = nextStatus.milestones;

            if (emitActivity) {
              emitActivationActivities(data, workspaceId, previous, nextStatus, actor);
            }
          });
        },
        load: async () => (await loadStoreAsync()).activationReadModels[workspaceId] ?? null,
      },
    },
    { subject: toSubject(workspaceId) },
  );

  return status.status;
}

export function emitActivationActivities(
  data: ReturnType<typeof loadStore>,
  workspaceId: string,
  previous: ActivationStatusDto | undefined,
  nextStatus: ActivationStatusDto,
  actor: ActivityRecord["actor"],
) {
  const timestamp = now();

  if (!previous || previous.stage !== nextStatus.stage) {
    recordActivity(data, makeActivity(workspaceId, "activation", "activation.stage_changed", actor, {
      title: `Activation stage is now ${nextStatus.stage}`,
      previousStage: previous?.stage,
      stage: nextStatus.stage,
    }, timestamp));
  }

  const previousMilestones = new Set((previous?.milestones ?? []).filter((entry) => entry.reached).map((entry) => entry.key));
  for (const milestone of nextStatus.milestones.filter((entry) => entry.reached && !previousMilestones.has(entry.key))) {
    recordActivity(data, makeActivity(workspaceId, "activation", "activation.milestone_reached", actor, {
      title: `Reached milestone: ${milestone.key}`,
      milestoneKey: milestone.key,
      stage: nextStatus.stage,
    }, milestone.reachedAt ?? timestamp));
  }

  const previousChecklist = new Set((previous?.checklist ?? []).filter((entry) => entry.completed).map((entry) => entry.key));
  for (const item of nextStatus.checklist.filter((entry) => entry.completed && !previousChecklist.has(entry.key))) {
    recordActivity(data, makeActivity(workspaceId, "activation", "activation.checklist_completed", actor, {
      title: `Checklist completed: ${item.key}`,
      checklistItemKey: item.key,
    }, item.completedAt ?? timestamp));
  }
}

export function applyOnboardingStepToFacts(facts: any, stepKey: string, timestamp: string) {
  switch (stepKey) {
    case "create_workspace_profile":
      facts.briefCapturedAt ??= timestamp;
      break;
    case "define_requirements":
      facts.requirementsDefinedAt ??= timestamp;
      break;
    case "define_plan":
      facts.planDefinedAt ??= timestamp;
      break;
    case "start_implementation":
      facts.implementationStartedAt ??= timestamp;
      facts.startedAt ??= timestamp;
      break;
    case "validate":
      facts.testsPassedAt ??= timestamp;
      facts.validationPassedAt ??= timestamp;
      facts.completedAt ??= timestamp;
      break;
    case "confirm_release":
      facts.releaseConfirmedAt ??= timestamp;
      facts.releasedAt ??= timestamp;
      break;
  }
}

const workspaceRoles = new Set<WorkspaceRole>(["viewer", "member", "admin", "owner"]);

export function parseWorkspaceRole(role: string): WorkspaceRole {
  if (!workspaceRoles.has(role as WorkspaceRole)) throw httpError(400, "valid workspace role is required");
  return role as WorkspaceRole;
}

export function assertCanManageRole(actorRole: WorkspaceRole, targetRole: WorkspaceRole) {
  if (targetRole === "owner" && actorRole !== "owner") {
    throw httpError(403, "workspace role owner is required");
  }
}

export function assertNotLastOwner(
  data: ReturnType<typeof loadStore>,
  workspaceId: string,
  currentMembership: WorkspaceMemberRecord,
  nextRole: WorkspaceRole | null,
) {
  if (currentMembership.role !== "owner" || nextRole === "owner") return;
  const ownerCount = data.memberships.filter((entry) => entry.workspaceId === workspaceId && entry.role === "owner").length;
  if (ownerCount <= 1) throw httpError(400, "workspace must keep at least one owner");
}

export function summarizeWorkspaceMember(data: ReturnType<typeof loadStore>, membership: WorkspaceMemberRecord) {
  const user = data.users.find((entry) => entry.id === membership.userId);
  return {
    userId: membership.userId,
    email: user?.email ?? "",
    displayName: user?.displayName ?? "Unknown user",
    role: membership.role,
    joinedAt: membership.joinedAt,
  };
}

export function summarizeWorkspaceInvitation(
  invitation: WorkspaceInvitationRecord,
  options: { includeToken?: boolean } = {},
) {
  const expired = new Date(invitation.expiresAt).getTime() <= Date.now();
  return {
    id: invitation.id,
    workspaceId: invitation.workspaceId,
    email: invitation.email,
    role: invitation.role,
    ...(options.includeToken ? { token: invitation.token } : {}),
    tokenPreview: maskBearerSecret(invitation.token),
    invitedByUserId: invitation.invitedByUserId,
    acceptedByUserId: invitation.acceptedByUserId ?? null,
    acceptedAt: invitation.acceptedAt ?? null,
    revokedAt: invitation.revokedAt ?? null,
    expiresAt: invitation.expiresAt,
    createdAt: invitation.createdAt,
    status: invitation.acceptedAt ? "accepted" : invitation.revokedAt ? "revoked" : expired ? "expired" : "pending",
  };
}

export function redactActivity(activity: ActivityRecord): ActivityRecord {
  return {
    ...activity,
    data: redactSensitiveValue(activity.data) as ActivityRecord["data"],
  };
}

export async function recordWorkspaceInvitationEmailDelivery(
  context: AuthenticatedContext,
  invitation: WorkspaceInvitationRecord,
  action: InvitationEmailDeliveryAction,
  options: { enqueueRetry?: boolean } = {},
) {
  return recordInvitationEmailDeliveryForWorkspace({
    workspace: context.workspace,
    actor: { type: "user", id: context.user.id, displayName: context.user.displayName },
    requestedByUserId: context.user.id,
    invitation,
    action,
    enqueueRetry: options.enqueueRetry ?? true,
  });
}

export async function recordInvitationEmailDeliveryForWorkspace(input: {
  workspace: WorkspaceRecord;
  actor: ActivityRecord["actor"];
  requestedByUserId?: string;
  invitation: WorkspaceInvitationRecord;
  action: InvitationEmailDeliveryAction;
  enqueueRetry: boolean;
}) {
  const delivery = await mutateStoreAsync((data) => {
    return deliverInvitationEmail(data, {
      action: input.action,
      workspaceId: input.invitation.workspaceId,
      workspaceName: input.workspace.name,
      invitationId: input.invitation.id,
      email: input.invitation.email,
      token: input.invitation.token,
      subject: invitationEmailSubject(input.workspace.name),
    });
  });

  const retryJob = input.enqueueRetry && delivery.status === "failed" && resolveInvitationEmailMode() === "webhook"
    ? await enqueueInvitationEmailRetryJob(input)
    : null;

  await mutateStoreAsync((data) => {
    recordActivity(data, makeActivity(input.invitation.workspaceId, "workspace", "workspace.invitation_email_delivery", input.actor, {
      title: delivery.status === "sent" ? `Invitation email sent to ${input.invitation.email}` : `Invitation email ${delivery.status} for ${input.invitation.email}`,
      invitationId: input.invitation.id,
      email: input.invitation.email,
      role: input.invitation.role,
      action: input.action,
      deliveryId: delivery.id,
      status: delivery.status,
      ...(delivery.error ? { error: delivery.error } : {}),
      ...(retryJob ? { retryJobId: retryJob.id } : {}),
    }, new Date().toISOString()));
  });

  return {
    id: delivery.id,
    status: delivery.status,
    action: input.action,
    error: delivery.error ?? null,
    retryJobId: retryJob?.id ?? null,
  };
}

export function inactiveInvitationRetryReason(invitation: WorkspaceInvitationRecord): string | null {
  if (invitation.revokedAt) return "invitation was revoked before email retry";
  if (invitation.acceptedAt) return "invitation was accepted before email retry";
  if (new Date(invitation.expiresAt).getTime() <= Date.now()) return "invitation expired before email retry";
  return null;
}

export async function recordSkippedInvitationEmailRetry(
  workspace: WorkspaceRecord,
  actor: ActivityRecord["actor"],
  invitation: WorkspaceInvitationRecord,
  action: InvitationEmailDeliveryAction,
  reason: string,
) {
  const timestamp = now();
  const mode = resolveInvitationEmailMode();
  const provider = mode === "webhook" ? resolveInvitationEmailWebhookConfig().provider : LOCAL_INVITATION_EMAIL_PROVIDER;
  const delivery = await mutateStoreAsync((data) => {
    const record = createInvitationEmailDelivery(data, {
      workspaceId: invitation.workspaceId,
      invitationId: invitation.id,
      recipientEmail: invitation.email,
      subject: invitationEmailSubject(workspace.name),
      status: "skipped",
      provider,
      mode,
      error: reason,
    }, timestamp);
    recordActivity(data, makeActivity(invitation.workspaceId, "workspace", "workspace.invitation_email_delivery", actor, {
      title: `Invitation email skipped for ${invitation.email}`,
      invitationId: invitation.id,
      email: invitation.email,
      role: invitation.role,
      action,
      deliveryId: record.id,
      status: record.status,
      error: reason,
    }, timestamp));
    return record;
  });

  return { id: delivery.id, status: delivery.status, action, error: delivery.error ?? null, retryJobId: null };
}

export async function enqueueInvitationEmailRetryJob(input: {
  invitation: WorkspaceInvitationRecord;
  action: InvitationEmailDeliveryAction;
  requestedByUserId?: string;
}): Promise<JobRecord> {
  const timestamp = now();
  return mutateStoreAsync((data) => {
    const record: JobRecord = {
      id: generateId(),
      workspaceId: input.invitation.workspaceId,
      type: INVITATION_EMAIL_JOB_TYPE,
      payload: {
        invitationId: input.invitation.id,
        action: input.action,
        ...(input.requestedByUserId ? { requestedByUserId: input.requestedByUserId } : {}),
      },
      status: "queued",
      attempts: 0,
      maxAttempts: resolveInvitationEmailRetryMaxAttempts(),
      scheduledAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    data.jobs.push(record);
    return record;
  });
}

export function applySessionCookie(c: Context, cookieValue: string) {
  setCookie(c, SESSION_COOKIE_NAME, cookieValue, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
}

export function toSubject(workspaceId: string): ActivationSubjectRef {
  return { workspaceId, subjectType: "workspace", subjectId: workspaceId };
}

export function activationSignalStableKey(
  workspaceId: string,
  kind: ActivationSignalRecord["kind"],
  source: ActivationSignalRecord["source"],
  sourceId: string,
): string {
  return `${workspaceId}:${kind}:${source}:${sourceId}`;
}

export function activationActivityId(workspaceId: string, event: string, signalId: string): string {
  return `activity_${stableIdPart(workspaceId)}_${stableIdPart(event)}_${stableIdPart(signalId)}`;
}

export function stableIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_");
}

export function upsertActivationActivity(data: PacketAgentData, activity: ActivityRecord): ActivityRecord {
  return recordActivity(data, activity, { dedupe: true });
}

export function makeActivity(
  workspaceId: string,
  scope: ActivityRecord["scope"],
  event: string,
  actor: ActivityRecord["actor"],
  data: ActivityRecord["data"],
  timestamp: string,
  id = generateId(),
): ActivityRecord {
  return {
    id,
    workspaceId,
    scope,
    event,
    actor,
    data,
    occurredAt: timestamp,
  };
}

export function httpError(status: number, message: string) {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}
