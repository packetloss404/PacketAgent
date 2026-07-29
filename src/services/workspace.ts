import {
  findWorkspaceInvitationByToken,
  findWorkspaceMembership,
  loadStoreAsync,
  mutateStoreAsync,
  recordActivity,
  ONBOARDING_STEPS,
  nextIncompleteStep,
  upsertWorkspaceInvitation,
  upsertWorkspaceMembership,
  type JobRecord,
  type OnboardingStepKey,
} from "../packetagent-store";
import { generateId, normalizeEmail, now, SESSION_TTL_MS, slugify } from "../auth-utils";
import {
  applyOnboardingStepToFacts,
  assertCanManageRole,
  assertNotLastOwner,
  type AuthenticatedContext,
  httpError,
  inactiveInvitationRetryReason,
  INVITATION_EMAIL_JOB_TYPE,
  makeActivity,
  parseWorkspaceRole,
  recordInvitationEmailDeliveryForWorkspace,
  recordSkippedInvitationEmailRetry,
  recordWorkspaceInvitationEmailDelivery,
  summarizeWorkspaceInvitation,
  summarizeWorkspaceMember,
  syncWorkspaceActivation,
} from "./context.js";

export async function updateWorkspace(
  context: AuthenticatedContext,
  input: { name: string; website: string; automationGoal: string },
) {
  if (input.name.trim().length < 2)
    throw httpError(400, "workspace name must be at least 2 characters");
  if (input.website.trim()) {
    try {
      const url = new URL(input.website.trim());
      if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error("invalid website");
      }
    } catch {
      throw httpError(400, "website must be a valid URL");
    }
  }

  const result = await mutateStoreAsync((data) => {
    const workspace = data.workspaces.find((entry) => entry.id === context.workspace.id);
    if (!workspace) throw httpError(404, "workspace not found");
    workspace.name = input.name.trim();
    workspace.slug = slugify(workspace.name) || workspace.id;
    workspace.website = input.website.trim();
    workspace.automationGoal = input.automationGoal.trim();
    workspace.updatedAt = now();

    const facts = data.activationFacts[workspace.id] ?? { now: now() };
    if (workspace.automationGoal && !facts.briefCapturedAt) {
      facts.briefCapturedAt = now();
    }
    data.activationFacts[workspace.id] = facts;

    recordActivity(
      data,
      makeActivity(
        workspace.id,
        "workspace",
        "workspace.updated",
        { type: "user", id: context.user.id, displayName: context.user.displayName },
        { title: "Workspace settings updated" },
        workspace.updatedAt,
      ),
    );
    return workspace;
  });

  await syncWorkspaceActivation(context.workspace.id, true, {
    type: "user",
    id: context.user.id,
    displayName: context.user.displayName,
  });
  return result;
}

export async function listWorkspaceMembers(context: AuthenticatedContext) {
  const data = await loadStoreAsync();
  return {
    members: data.memberships
      .filter((membership) => membership.workspaceId === context.workspace.id)
      .map((membership) => summarizeWorkspaceMember(data, membership))
      .sort((left, right) => left.displayName.localeCompare(right.displayName)),
    invitations: data.workspaceInvitations
      .filter((invitation) => invitation.workspaceId === context.workspace.id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((invitation) => summarizeWorkspaceInvitation(invitation)),
  };
}

export async function createWorkspaceInvitation(
  context: AuthenticatedContext,
  input: { email: string; role: string },
) {
  const email = normalizeEmail(input.email);
  const role = parseWorkspaceRole(input.role);
  if (!email.includes("@")) throw httpError(400, "valid email is required");
  assertCanManageRole(context.role, role);

  const result = await mutateStoreAsync((data) => {
    const existingUser = data.users.find((entry) => normalizeEmail(entry.email) === email);
    if (existingUser && findWorkspaceMembership(data, context.workspace.id, existingUser.id)) {
      throw httpError(409, "user is already a workspace member");
    }

    const existingInvitation = data.workspaceInvitations.find((entry) => {
      return (
        entry.workspaceId === context.workspace.id &&
        normalizeEmail(entry.email) === email &&
        !entry.acceptedAt &&
        !entry.revokedAt &&
        new Date(entry.expiresAt).getTime() > Date.now()
      );
    });
    if (existingInvitation)
      throw httpError(409, "an active invitation already exists for that email");

    const timestamp = now();
    const invitation = upsertWorkspaceInvitation(data, {
      id: generateId(),
      workspaceId: context.workspace.id,
      email,
      role,
      token: generateId(),
      invitedByUserId: context.user.id,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      createdAt: timestamp,
    });

    recordActivity(
      data,
      makeActivity(
        context.workspace.id,
        "workspace",
        "workspace.invitation_created",
        {
          type: "user",
          id: context.user.id,
          displayName: context.user.displayName,
        },
        { title: `Invitation created for ${email}`, email, role },
        timestamp,
      ),
    );

    return {
      invitation: summarizeWorkspaceInvitation(invitation, { includeToken: true }),
      invitationRecord: { ...invitation },
    };
  });

  const emailDelivery = await recordWorkspaceInvitationEmailDelivery(
    context,
    result.invitationRecord,
    "create",
  );
  return { invitation: result.invitation, emailDelivery };
}

export async function acceptWorkspaceInvitation(context: AuthenticatedContext, token: string) {
  if (!token.trim()) throw httpError(400, "invitation token is required");

  return mutateStoreAsync((data) => {
    const invitation = findWorkspaceInvitationByToken(data, token.trim());
    if (!invitation) throw httpError(404, "invitation not found");
    if (invitation.revokedAt) throw httpError(400, "invitation has been revoked");
    if (invitation.acceptedAt) throw httpError(400, "invitation has already been accepted");
    if (new Date(invitation.expiresAt).getTime() <= Date.now())
      throw httpError(400, "invitation has expired");
    if (normalizeEmail(context.user.email) !== normalizeEmail(invitation.email)) {
      throw httpError(403, "invitation does not match the authenticated user");
    }

    const timestamp = now();
    const membership = upsertWorkspaceMembership(data, {
      workspaceId: invitation.workspaceId,
      userId: context.user.id,
      role: invitation.role,
      joinedAt: timestamp,
    });
    invitation.acceptedAt = timestamp;
    invitation.acceptedByUserId = context.user.id;

    recordActivity(
      data,
      makeActivity(
        invitation.workspaceId,
        "workspace",
        "workspace.invitation_accepted",
        {
          type: "user",
          id: context.user.id,
          displayName: context.user.displayName,
        },
        {
          title: `${context.user.displayName} joined the workspace`,
          email: context.user.email,
          role: invitation.role,
        },
        timestamp,
      ),
    );

    return {
      membership: summarizeWorkspaceMember(data, membership),
      invitation: summarizeWorkspaceInvitation(invitation),
    };
  });
}

export async function resendWorkspaceInvitation(
  context: AuthenticatedContext,
  invitationId: string,
) {
  if (!invitationId.trim()) throw httpError(400, "invitation id is required");

  const result = await mutateStoreAsync((data) => {
    const invitation = data.workspaceInvitations.find((entry) => {
      return entry.id === invitationId.trim() && entry.workspaceId === context.workspace.id;
    });
    if (!invitation) throw httpError(404, "invitation not found");
    assertCanManageRole(context.role, invitation.role);
    if (invitation.revokedAt) throw httpError(400, "invitation has been revoked");
    if (invitation.acceptedAt) throw httpError(400, "invitation has already been accepted");

    const timestamp = now();
    invitation.token = generateId();
    invitation.expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    invitation.invitedByUserId = context.user.id;

    recordActivity(
      data,
      makeActivity(
        context.workspace.id,
        "workspace",
        "workspace.invitation_resent",
        {
          type: "user",
          id: context.user.id,
          displayName: context.user.displayName,
        },
        {
          title: `Invitation resent for ${invitation.email}`,
          email: invitation.email,
          role: invitation.role,
        },
        timestamp,
      ),
    );

    return {
      invitation: summarizeWorkspaceInvitation(invitation, { includeToken: true }),
      invitationRecord: { ...invitation },
    };
  });

  const emailDelivery = await recordWorkspaceInvitationEmailDelivery(
    context,
    result.invitationRecord,
    "resend",
  );
  return { invitation: result.invitation, emailDelivery };
}

export async function revokeWorkspaceInvitation(
  context: AuthenticatedContext,
  invitationId: string,
) {
  if (!invitationId.trim()) throw httpError(400, "invitation id is required");

  return mutateStoreAsync((data) => {
    const invitation = data.workspaceInvitations.find((entry) => {
      return entry.id === invitationId.trim() && entry.workspaceId === context.workspace.id;
    });
    if (!invitation) throw httpError(404, "invitation not found");
    assertCanManageRole(context.role, invitation.role);
    if (invitation.acceptedAt) throw httpError(400, "invitation has already been accepted");
    if (invitation.revokedAt) throw httpError(400, "invitation has already been revoked");

    const timestamp = now();
    invitation.revokedAt = timestamp;

    recordActivity(
      data,
      makeActivity(
        context.workspace.id,
        "workspace",
        "workspace.invitation_revoked",
        {
          type: "user",
          id: context.user.id,
          displayName: context.user.displayName,
        },
        {
          title: `Invitation revoked for ${invitation.email}`,
          email: invitation.email,
          role: invitation.role,
        },
        timestamp,
      ),
    );

    return { invitation: summarizeWorkspaceInvitation(invitation) };
  });
}

export async function updateWorkspaceMemberRole(
  context: AuthenticatedContext,
  userId: string,
  input: { role: string },
) {
  const role = parseWorkspaceRole(input.role);
  assertCanManageRole(context.role, role);

  return mutateStoreAsync((data) => {
    const membership = findWorkspaceMembership(data, context.workspace.id, userId);
    if (!membership) throw httpError(404, "workspace member not found");
    assertCanManageRole(context.role, membership.role);
    assertNotLastOwner(data, context.workspace.id, membership, role);

    membership.role = role;
    const timestamp = now();
    recordActivity(
      data,
      makeActivity(
        context.workspace.id,
        "workspace",
        "workspace.member_role_updated",
        {
          type: "user",
          id: context.user.id,
          displayName: context.user.displayName,
        },
        { title: "Workspace member role updated", userId, role },
        timestamp,
      ),
    );

    return { member: summarizeWorkspaceMember(data, membership) };
  });
}

export async function removeWorkspaceMember(context: AuthenticatedContext, userId: string) {
  return mutateStoreAsync((data) => {
    const membership = findWorkspaceMembership(data, context.workspace.id, userId);
    if (!membership) throw httpError(404, "workspace member not found");
    assertCanManageRole(context.role, membership.role);
    assertNotLastOwner(data, context.workspace.id, membership, null);

    data.memberships = data.memberships.filter((entry) => {
      return !(entry.workspaceId === context.workspace.id && entry.userId === userId);
    });
    const timestamp = now();
    recordActivity(
      data,
      makeActivity(
        context.workspace.id,
        "workspace",
        "workspace.member_removed",
        {
          type: "user",
          id: context.user.id,
          displayName: context.user.displayName,
        },
        { title: "Workspace member removed", userId },
        timestamp,
      ),
    );

    return { ok: true };
  });
}

export async function getOnboarding(context: AuthenticatedContext) {
  const data = await loadStoreAsync();
  const onboarding = data.onboardingStates.find(
    (entry) => entry.workspaceId === context.workspace.id,
  );
  if (!onboarding) throw httpError(404, "onboarding state not found");
  return onboarding;
}

export async function completeOnboardingStep(context: AuthenticatedContext, stepKey: string) {
  const onboardingStep = ONBOARDING_STEPS.find(
    (candidate): candidate is OnboardingStepKey => candidate === stepKey,
  );
  if (!onboardingStep) {
    throw httpError(400, "unknown onboarding step");
  }

  const onboarding = await mutateStoreAsync((data) => {
    const record = data.onboardingStates.find(
      (entry) => entry.workspaceId === context.workspace.id,
    );
    if (!record) throw httpError(404, "onboarding state not found");
    if (!record.completedSteps.includes(onboardingStep)) {
      record.completedSteps.push(onboardingStep);
    }

    const timestamp = now();
    record.currentStep = nextIncompleteStep(record.completedSteps);
    record.status =
      record.completedSteps.length === ONBOARDING_STEPS.length ? "completed" : "in_progress";
    record.completedAt = record.status === "completed" ? timestamp : undefined;
    record.updatedAt = timestamp;

    const facts = data.activationFacts[context.workspace.id] ?? { now: timestamp };
    applyOnboardingStepToFacts(facts, onboardingStep, timestamp);
    data.activationFacts[context.workspace.id] = facts;

    recordActivity(
      data,
      makeActivity(
        context.workspace.id,
        "activation",
        "onboarding.step_completed",
        { type: "user", id: context.user.id, displayName: context.user.displayName },
        { title: `Completed step: ${onboardingStep}`, stepKey: onboardingStep },
        timestamp,
      ),
    );
    return record;
  });

  await syncWorkspaceActivation(context.workspace.id, true, {
    type: "user",
    id: context.user.id,
    displayName: context.user.displayName,
  });
  return onboarding;
}

export async function handleInvitationEmailJob(job: JobRecord) {
  if (job.type !== INVITATION_EMAIL_JOB_TYPE)
    throw new Error(`unsupported invitation email job type "${job.type}"`);
  const payload = job.payload as {
    invitationId?: unknown;
    action?: unknown;
    requestedByUserId?: unknown;
  };
  if (typeof payload.invitationId !== "string" || !payload.invitationId.trim())
    throw new Error("invitation.email job missing invitationId");
  if (payload.action !== "create" && payload.action !== "resend")
    throw new Error("invitation.email job missing action");

  const data = await loadStoreAsync();
  const invitation = data.workspaceInvitations.find(
    (entry) => entry.id === payload.invitationId && entry.workspaceId === job.workspaceId,
  );
  if (!invitation) throw new Error(`invitation ${payload.invitationId} not found`);
  const workspace = data.workspaces.find((entry) => entry.id === job.workspaceId);
  if (!workspace) throw new Error(`workspace ${job.workspaceId} not found`);

  const actorUser =
    typeof payload.requestedByUserId === "string"
      ? data.users.find((entry) => entry.id === payload.requestedByUserId)
      : undefined;
  const actor = actorUser
    ? { type: "user" as const, id: actorUser.id, displayName: actorUser.displayName }
    : {
        type: "system" as const,
        id: "invitation-email-retry",
        displayName: "Invitation email retry",
      };

  const inactiveReason = inactiveInvitationRetryReason(invitation);
  if (inactiveReason)
    return recordSkippedInvitationEmailRetry(
      workspace,
      actor,
      invitation,
      payload.action,
      inactiveReason,
    );

  const delivery = await recordInvitationEmailDeliveryForWorkspace({
    workspace,
    actor,
    requestedByUserId: actorUser?.id,
    invitation: { ...invitation },
    action: payload.action,
    enqueueRetry: false,
  });
  if (delivery.status === "failed")
    throw new Error(delivery.error ?? "invitation email delivery failed");
  return delivery;
}
