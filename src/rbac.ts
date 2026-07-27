import type { Context } from "hono";
import { requireAuthenticatedContext, requireAuthenticatedContextAsync } from "./packetagent-services.js";
import { findWorkspaceMembership, loadStore, loadStoreAsync } from "./packetagent-store.js";

export const WORKSPACE_ROLES = ["viewer", "member", "admin", "owner"] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export type WorkspacePermission = "viewWorkspace" | "editWorkflow" | "manageWorkspace";

export interface WorkspaceMembershipLike {
  role?: string | null;
}

export type AuthenticatedWorkspaceContext = ReturnType<typeof requireAuthenticatedContext>;
export type AuthenticatedWorkspaceContextAsync = Awaited<ReturnType<typeof requireAuthenticatedContextAsync>>;

export interface WorkspaceRoleDefinition {
  rank: number;
  permissions: ReadonlySet<WorkspacePermission>;
}

export class WorkspaceAccessError extends Error {
  readonly code = "WORKSPACE_ACCESS_DENIED";
  readonly status = 403;

  constructor(message = "workspace access denied") {
    super(message);
    this.name = "WorkspaceAccessError";
  }
}

const roleRanks: Record<WorkspaceRole, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

export const WORKSPACE_ROLE_DEFINITIONS: Readonly<Record<WorkspaceRole, WorkspaceRoleDefinition>> = {
  viewer: {
    rank: roleRanks.viewer,
    permissions: new Set<WorkspacePermission>(["viewWorkspace"]),
  },
  member: {
    rank: roleRanks.member,
    permissions: new Set<WorkspacePermission>(["viewWorkspace", "editWorkflow"]),
  },
  admin: {
    rank: roleRanks.admin,
    permissions: new Set<WorkspacePermission>(["viewWorkspace", "editWorkflow", "manageWorkspace"]),
  },
  owner: {
    rank: roleRanks.owner,
    permissions: new Set<WorkspacePermission>(["viewWorkspace", "editWorkflow", "manageWorkspace"]),
  },
};

const permissionMinimumRoles: Record<WorkspacePermission, WorkspaceRole> = {
  viewWorkspace: "viewer",
  editWorkflow: "member",
  manageWorkspace: "admin",
};

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === "string" && value in WORKSPACE_ROLE_DEFINITIONS;
}

export function getWorkspaceRole(membership: WorkspaceMembershipLike | null | undefined): WorkspaceRole | null {
  return isWorkspaceRole(membership?.role) ? membership.role : null;
}

export function hasWorkspaceRole(
  membership: WorkspaceMembershipLike | null | undefined,
  minimumRole: WorkspaceRole,
): boolean {
  const role = getWorkspaceRole(membership);
  return role !== null && roleRanks[role] >= roleRanks[minimumRole];
}

export function canViewWorkspace(membership: WorkspaceMembershipLike | null | undefined): boolean {
  return hasWorkspacePermission(membership, "viewWorkspace");
}

export function canEditWorkflow(membership: WorkspaceMembershipLike | null | undefined): boolean {
  return hasWorkspacePermission(membership, "editWorkflow");
}

export function canManageWorkspace(membership: WorkspaceMembershipLike | null | undefined): boolean {
  return hasWorkspacePermission(membership, "manageWorkspace");
}

export function hasWorkspacePermission(
  membership: WorkspaceMembershipLike | null | undefined,
  permission: WorkspacePermission,
): boolean {
  return hasWorkspaceRole(membership, permissionMinimumRoles[permission]);
}

export function requireWorkspaceRole(
  membership: WorkspaceMembershipLike | null | undefined,
  minimumRole: WorkspaceRole,
): WorkspaceRole {
  const role = getWorkspaceRole(membership);
  if (role === null) {
    throw new WorkspaceAccessError("workspace membership is required");
  }

  if (roleRanks[role] < roleRanks[minimumRole]) {
    throw new WorkspaceAccessError(`workspace role ${minimumRole} is required`);
  }

  return role;
}

export function assertPermission(
  membership: WorkspaceMembershipLike | null | undefined,
  permission: WorkspacePermission,
): WorkspaceRole {
  return requireWorkspaceRole(membership, permissionMinimumRoles[permission]);
}

export function requirePrivateWorkspace(c: Context): AuthenticatedWorkspaceContext {
  const context = requireAuthenticatedContext(c);
  requireWorkspaceMembership(context);
  return context;
}

export async function requirePrivateWorkspaceAsync(c: Context): Promise<AuthenticatedWorkspaceContextAsync> {
  const context = await requireAuthenticatedContextAsync(c);
  await requireWorkspaceMembershipAsync(context);
  return context;
}

export function requirePrivateWorkspaceRole(c: Context, minimumRole: WorkspaceRole): AuthenticatedWorkspaceContext {
  const context = requireAuthenticatedContext(c);
  requireWorkspaceRole(requireWorkspaceMembership(context), minimumRole);
  return context;
}

export async function requirePrivateWorkspaceRoleAsync(
  c: Context,
  minimumRole: WorkspaceRole,
): Promise<AuthenticatedWorkspaceContextAsync> {
  const context = await requireAuthenticatedContextAsync(c);
  requireWorkspaceRole(await requireWorkspaceMembershipAsync(context), minimumRole);
  return context;
}

export function requirePrivateWorkspacePermission(
  c: Context,
  permission: WorkspacePermission,
): AuthenticatedWorkspaceContext {
  const context = requireAuthenticatedContext(c);
  assertPermission(requireWorkspaceMembership(context), permission);
  return context;
}

export async function requirePrivateWorkspacePermissionAsync(
  c: Context,
  permission: WorkspacePermission,
): Promise<AuthenticatedWorkspaceContextAsync> {
  const context = await requireAuthenticatedContextAsync(c);
  assertPermission(await requireWorkspaceMembershipAsync(context), permission);
  return context;
}

function requireWorkspaceMembership(context: AuthenticatedWorkspaceContext): WorkspaceMembershipLike {
  const membership = findWorkspaceMembership(loadStore(), context.workspace.id, context.user.id);
  if (!membership || getWorkspaceRole(membership) === null) {
    throw new WorkspaceAccessError("workspace membership is required");
  }
  return membership;
}

async function requireWorkspaceMembershipAsync(context: AuthenticatedWorkspaceContextAsync): Promise<WorkspaceMembershipLike> {
  const membership = findWorkspaceMembership(await loadStoreAsync(), context.workspace.id, context.user.id);
  if (!membership || getWorkspaceRole(membership) === null) {
    throw new WorkspaceAccessError("workspace membership is required");
  }
  return membership;
}
