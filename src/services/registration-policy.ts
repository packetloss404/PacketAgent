import type { PacketAgentData, WorkspaceInvitationRecord } from "../store/types.js";
import { normalizeEmail } from "../auth-utils";
import { httpError } from "./context.js";

export const REGISTRATION_MODE_ENV = "PACKETAGENT_REGISTRATION_MODE";

export type RegistrationMode = "invite_only" | "open";

/**
 * Self-service registration is invite-only unless an operator opts out. An open
 * instance on a public hostname lets anyone create an account and a workspace,
 * so the safe default is the closed one.
 */
export function resolveRegistrationMode(env: NodeJS.ProcessEnv = process.env): RegistrationMode {
  const raw = env[REGISTRATION_MODE_ENV]?.trim().toLowerCase();
  if (!raw) return "invite_only";
  if (raw === "open" || raw === "invite_only") return raw;
  throw httpError(500, `${REGISTRATION_MODE_ENV} must be "invite_only" or "open"`);
}

/**
 * The first account bootstraps the instance: with no users there is nobody who
 * could issue an invitation, so requiring one would lock the operator out of a
 * fresh install permanently.
 */
export function isBootstrapRegistration(data: PacketAgentData): boolean {
  return data.users.length === 0;
}

export interface RegistrationAdmission {
  readonly reason: "bootstrap" | "open" | "invitation";
  /** Present only when an invitation authorized the registration. */
  readonly invitation?: WorkspaceInvitationRecord;
}

/**
 * Decides whether an email may register, and returns the invitation that
 * authorized it so the caller can bind the new account to it. Throws a 403 with
 * a deliberately non-specific message when no invitation matches, so the
 * endpoint cannot be used to probe which addresses have been invited.
 */
export function admitRegistration(
  data: PacketAgentData,
  email: string,
  invitationToken: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): RegistrationAdmission {
  if (isBootstrapRegistration(data)) return { reason: "bootstrap" };
  if (resolveRegistrationMode(env) === "open") return { reason: "open" };

  const token = invitationToken?.trim();
  if (!token) {
    throw httpError(403, "registration is invite-only on this instance");
  }

  const normalized = normalizeEmail(email);
  const invitation = data.workspaceInvitations.find((record) => record.token === token);
  if (
    !invitation ||
    invitation.revokedAt ||
    invitation.acceptedAt ||
    new Date(invitation.expiresAt).getTime() <= Date.now() ||
    normalizeEmail(invitation.email) !== normalized
  ) {
    // One message for every failure mode: an attacker must not be able to tell
    // an unknown token from an expired, revoked, used, or mismatched one.
    throw httpError(403, "invitation is not valid for this email address");
  }

  return { reason: "invitation", invitation };
}
