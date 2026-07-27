import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { buildActivationSummaryCard } from "../activation/view-model";
import {
  findSessionByIdIndexed,
  loadStore,
  loadStoreAsync,
  mutateStore,
  mutateStoreAsync,
  recordActivity,
} from "../packetagent-store";
import {
  generateId,
  hashPassword,
  hashSessionSecret,
  normalizeEmail,
  now,
  parseSessionCookieValue,
  SESSION_COOKIE_NAME,
  slugify,
  verifyPassword,
} from "../auth-utils";
import {
  type AuthenticatedContext,
  buildAuthenticatedContext,
  clearSessionCookie,
  createSessionRecord,
  httpError,
  makeActivity,
  syncWorkspaceActivation,
} from "./context.js";

export function register(input: { email: string; password: string; displayName: string }) {
  const email = normalizeEmail(input.email);
  if (!email.includes("@")) throw httpError(400, "valid email is required");
  if (input.password.length < 8) throw httpError(400, "password must be at least 8 characters");
  if (input.displayName.trim().length < 2) throw httpError(400, "display name must be at least 2 characters");

  return mutateStore((data) => {
    if (data.users.some((user) => normalizeEmail(user.email) === email)) {
      throw httpError(409, "an account with that email already exists");
    }

    const timestamp = now();
    const userId = generateId();
    const workspaceId = generateId();
    const displayName = input.displayName.trim();
    const workspaceName = `${displayName.split(" ")[0] || "PacketAgent"} workspace`;

    data.users.push({
      id: userId,
      email,
      displayName,
      timezone: "UTC",
      passwordHash: hashPassword(input.password),
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    data.workspaces.push({
      id: workspaceId,
      slug: slugify(workspaceName) || workspaceId,
      name: workspaceName,
      website: "",
      automationGoal: "",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    data.memberships.push({
      workspaceId,
      userId,
      role: "owner",
      joinedAt: timestamp,
    });

    data.onboardingStates.push({
      workspaceId,
      status: "not_started",
      currentStep: "create_workspace_profile",
      completedSteps: [],
      updatedAt: timestamp,
    });

    data.activationFacts[workspaceId] = { now: timestamp };
    recordActivity(data, makeActivity(workspaceId, "account", "account.created", { type: "user", id: userId, displayName }, { title: `Account created for ${displayName}` }, timestamp));
    recordActivity(data, makeActivity(workspaceId, "workspace", "workspace.created", { type: "user", id: userId, displayName }, { title: `Workspace ${workspaceName} created` }, timestamp));

    const session = createSessionRecord(userId, timestamp);
    data.sessions.push(session.record);
    return {
      cookieValue: session.cookieValue,
      context: buildAuthenticatedContext(data, userId),
    };
  });
}

export async function registerAsync(input: { email: string; password: string; displayName: string }) {
  const email = normalizeEmail(input.email);
  if (!email.includes("@")) throw httpError(400, "valid email is required");
  if (input.password.length < 8) throw httpError(400, "password must be at least 8 characters");
  if (input.displayName.trim().length < 2) throw httpError(400, "display name must be at least 2 characters");

  return mutateStoreAsync((data) => {
    if (data.users.some((user) => normalizeEmail(user.email) === email)) {
      throw httpError(409, "an account with that email already exists");
    }

    const timestamp = now();
    const userId = generateId();
    const workspaceId = generateId();
    const displayName = input.displayName.trim();
    const workspaceName = `${displayName.split(" ")[0] || "PacketAgent"} workspace`;

    data.users.push({
      id: userId,
      email,
      displayName,
      timezone: "UTC",
      passwordHash: hashPassword(input.password),
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    data.workspaces.push({
      id: workspaceId,
      slug: slugify(workspaceName) || workspaceId,
      name: workspaceName,
      website: "",
      automationGoal: "",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    data.memberships.push({
      workspaceId,
      userId,
      role: "owner",
      joinedAt: timestamp,
    });

    data.onboardingStates.push({
      workspaceId,
      status: "not_started",
      currentStep: "create_workspace_profile",
      completedSteps: [],
      updatedAt: timestamp,
    });

    data.activationFacts[workspaceId] = { now: timestamp };
    recordActivity(data, makeActivity(workspaceId, "account", "account.created", { type: "user", id: userId, displayName }, { title: `Account created for ${displayName}` }, timestamp));
    recordActivity(data, makeActivity(workspaceId, "workspace", "workspace.created", { type: "user", id: userId, displayName }, { title: `Workspace ${workspaceName} created` }, timestamp));

    const session = createSessionRecord(userId, timestamp);
    data.sessions.push(session.record);
    return {
      cookieValue: session.cookieValue,
      context: buildAuthenticatedContext(data, userId),
    };
  });
}

export function login(input: { email: string; password: string }) {
  const email = normalizeEmail(input.email);
  return mutateStore((data) => {
    const user = data.users.find((entry) => normalizeEmail(entry.email) === email);
    if (!user || !verifyPassword(input.password, user.passwordHash)) {
      throw httpError(401, "invalid email or password");
    }

    const session = createSessionRecord(user.id, now());
    data.sessions = data.sessions.filter((entry) => entry.userId !== user.id);
    data.sessions.push(session.record);
    return {
      cookieValue: session.cookieValue,
      context: buildAuthenticatedContext(data, user.id),
    };
  });
}

export async function loginAsync(input: { email: string; password: string }) {
  const email = normalizeEmail(input.email);
  return mutateStoreAsync((data) => {
    const user = data.users.find((entry) => normalizeEmail(entry.email) === email);
    if (!user || !verifyPassword(input.password, user.passwordHash)) {
      throw httpError(401, "invalid email or password");
    }

    const session = createSessionRecord(user.id, now());
    data.sessions = data.sessions.filter((entry) => entry.userId !== user.id);
    data.sessions.push(session.record);
    return {
      cookieValue: session.cookieValue,
      context: buildAuthenticatedContext(data, user.id),
    };
  });
}

export function logout(c: Context) {
  const parsed = parseSessionCookieValue(getCookie(c, SESSION_COOKIE_NAME) ?? "");
  if (parsed) {
    mutateStore((data) => {
      data.sessions = data.sessions.filter((entry) => entry.id !== parsed.sessionId);
    });
  }
  clearSessionCookie(c);
}

export async function logoutAsync(c: Context) {
  const parsed = parseSessionCookieValue(getCookie(c, SESSION_COOKIE_NAME) ?? "");
  if (parsed) {
    await mutateStoreAsync((data) => {
      data.sessions = data.sessions.filter((entry) => entry.id !== parsed.sessionId);
    });
  }
  clearSessionCookie(c);
}

export function restoreSession(c: Context): AuthenticatedContext | null {
  const parsed = parseSessionCookieValue(getCookie(c, SESSION_COOKIE_NAME) ?? "");
  if (!parsed) return null;

  const session = findSessionByIdIndexed(parsed.sessionId);
  if (!session) return null;
  if (session.secretHash !== hashSessionSecret(parsed.secret)) return null;
  if (new Date(session.expiresAt).getTime() <= Date.now()) return null;
  const data = loadStore();
  const liveSession = data.sessions.find((entry) => entry.id === session.id);
  if (liveSession) liveSession.lastAccessedAt = now();
  const context = buildAuthenticatedContext(data, session.userId);
  return context;
}

export async function restoreSessionAsync(c: Context): Promise<AuthenticatedContext | null> {
  const parsed = parseSessionCookieValue(getCookie(c, SESSION_COOKIE_NAME) ?? "");
  if (!parsed) return null;

  return mutateStoreAsync((data) => {
    const session = data.sessions.find((entry) => entry.id === parsed.sessionId);
    if (!session) return null;
    if (session.secretHash !== hashSessionSecret(parsed.secret)) return null;
    if (new Date(session.expiresAt).getTime() <= Date.now()) return null;
    session.lastAccessedAt = now();
    return buildAuthenticatedContext(data, session.userId);
  });
}

export async function getPrivateBootstrap(context: AuthenticatedContext) {
  const status = await syncWorkspaceActivation(context.workspace.id, false, { type: "system", id: "bootstrap" });
  const data = await loadStoreAsync();
  const onboarding = data.onboardingStates.find((entry) => entry.workspaceId === context.workspace.id);
  const activities = data.activities.filter((entry) => entry.workspaceId === context.workspace.id).slice(0, 20);

  return {
    user: {
      id: context.user.id,
      email: context.user.email,
      displayName: context.user.displayName,
      timezone: context.user.timezone,
    },
    workspace: {
      id: context.workspace.id,
      slug: context.workspace.slug,
      name: context.workspace.name,
      website: context.workspace.website,
      automationGoal: context.workspace.automationGoal,
      role: context.role,
    },
    onboarding,
    activation: {
      status,
      summary: buildActivationSummaryCard(status),
    },
    activities,
  };
}

export async function getActivationDetail(context: AuthenticatedContext) {
  const bootstrap = await getPrivateBootstrap(context);
  return {
    workspace: bootstrap.workspace,
    onboarding: bootstrap.onboarding,
    activation: bootstrap.activation,
    activities: bootstrap.activities,
  };
}

export function getSessionPayload(context: AuthenticatedContext) {
  const data = loadStore();
  const onboarding = data.onboardingStates.find((entry) => entry.workspaceId === context.workspace.id);

  return {
    authenticated: true,
    user: {
      id: context.user.id,
      email: context.user.email,
      displayName: context.user.displayName,
      timezone: context.user.timezone,
    },
    workspace: {
      id: context.workspace.id,
      slug: context.workspace.slug,
      name: context.workspace.name,
      website: context.workspace.website,
      automationGoal: context.workspace.automationGoal,
      role: context.role,
    },
    onboarding: onboarding
      ? {
          status: onboarding.status,
          currentStep: onboarding.currentStep,
          completed: onboarding.status === "completed",
          completedSteps: onboarding.completedSteps,
          completedAt: onboarding.completedAt ?? null,
        }
      : {
          status: "not_started",
          currentStep: "create_workspace_profile",
          completed: false,
          completedSteps: [],
          completedAt: null,
        },
  };
}

export async function getSessionPayloadAsync(context: AuthenticatedContext) {
  const data = await loadStoreAsync();
  const onboarding = data.onboardingStates.find((entry) => entry.workspaceId === context.workspace.id);

  return {
    authenticated: true,
    user: {
      id: context.user.id,
      email: context.user.email,
      displayName: context.user.displayName,
      timezone: context.user.timezone,
    },
    workspace: {
      id: context.workspace.id,
      slug: context.workspace.slug,
      name: context.workspace.name,
      website: context.workspace.website,
      automationGoal: context.workspace.automationGoal,
      role: context.role,
    },
    onboarding: onboarding
      ? {
          status: onboarding.status,
          currentStep: onboarding.currentStep,
          completed: onboarding.status === "completed",
          completedSteps: onboarding.completedSteps,
          completedAt: onboarding.completedAt ?? null,
        }
      : {
          status: "not_started",
          currentStep: "create_workspace_profile",
          completed: false,
          completedSteps: [],
          completedAt: null,
        },
  };
}

export async function updateProfile(
  context: AuthenticatedContext,
  input: { displayName: string; timezone: string },
) {
  if (input.displayName.trim().length < 2) throw httpError(400, "display name must be at least 2 characters");
  if (!input.timezone.trim()) throw httpError(400, "timezone is required");

  return mutateStoreAsync((data) => {
    const user = data.users.find((entry) => entry.id === context.user.id);
    if (!user) throw httpError(404, "user not found");
    user.displayName = input.displayName.trim();
    user.timezone = input.timezone.trim();
    user.updatedAt = now();
    recordActivity(data, makeActivity(context.workspace.id, "account", "account.profile_updated", { type: "user", id: user.id, displayName: user.displayName }, { title: "Profile updated" }, user.updatedAt));
    return user;
  });
}

export function requireAuthenticatedContext(c: Context): AuthenticatedContext {
  const context = restoreSession(c);
  if (!context) throw httpError(401, "authentication required");
  return context;
}

export async function requireAuthenticatedContextAsync(c: Context): Promise<AuthenticatedContext> {
  const context = await restoreSessionAsync(c);
  if (!context) throw httpError(401, "authentication required");
  return context;
}
