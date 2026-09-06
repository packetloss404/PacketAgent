import { test } from "node:test";
import assert from "node:assert/strict";
import {
  admitRegistration,
  resolveRegistrationMode,
  REGISTRATION_MODE_ENV,
} from "./registration-policy.js";
import type { PacketAgentData, WorkspaceInvitationRecord } from "../store/types.js";

const HOUR_MS = 3_600_000;

function makeData(
  users: number,
  invitations: WorkspaceInvitationRecord[] = [],
): Pick<PacketAgentData, "users" | "workspaceInvitations"> {
  return {
    users: Array.from({ length: users }, (_, index) => ({
      id: `user_${index}`,
      email: `user${index}@example.com`,
      displayName: `User ${index}`,
      timezone: "UTC",
      passwordHash: "hash",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })),
    workspaceInvitations: invitations,
  } as Pick<PacketAgentData, "users" | "workspaceInvitations">;
}

function makeInvitation(
  overrides: Partial<WorkspaceInvitationRecord> = {},
): WorkspaceInvitationRecord {
  return {
    id: "inv_1",
    workspaceId: "ws_1",
    email: "invited@example.com",
    role: "member",
    token: "tok_valid",
    invitedByUserId: "user_0",
    expiresAt: new Date(Date.now() + HOUR_MS).toISOString(),
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const admit = (
  data: ReturnType<typeof makeData>,
  email: string,
  token: string | undefined,
  env: NodeJS.ProcessEnv = {},
) => admitRegistration(data as PacketAgentData, email, token, env);

test("registration defaults to invite-only", () => {
  assert.equal(resolveRegistrationMode({}), "invite_only");
  assert.equal(resolveRegistrationMode({ [REGISTRATION_MODE_ENV]: "open" }), "open");
  assert.equal(resolveRegistrationMode({ [REGISTRATION_MODE_ENV]: "INVITE_ONLY" }), "invite_only");
  assert.throws(() => resolveRegistrationMode({ [REGISTRATION_MODE_ENV]: "yes" }), /must be/);
});

test("the first account bootstraps the instance without an invitation", () => {
  const admission = admit(makeData(0), "founder@example.com", undefined);
  assert.equal(admission.reason, "bootstrap");
  assert.equal(admission.invitation, undefined);
});

test("once an account exists, registration requires an invitation", () => {
  assert.throws(
    () => admit(makeData(1), "stranger@example.com", undefined),
    /registration is invite-only/,
  );
});

test("a valid invitation admits exactly its own email address", () => {
  const invitation = makeInvitation();
  const data = makeData(1, [invitation]);

  const admission = admit(data, "invited@example.com", "tok_valid");
  assert.equal(admission.reason, "invitation");
  assert.equal(admission.invitation?.id, "inv_1");

  // Case-insensitive on the address, but bound to it.
  assert.equal(admit(data, "INVITED@example.com", "tok_valid").reason, "invitation");
  assert.throws(() => admit(data, "someone-else@example.com", "tok_valid"), /not valid/);
});

test("revoked, accepted, expired, and unknown tokens are all refused alike", () => {
  const cases: Array<[string, WorkspaceInvitationRecord | null, string]> = [
    ["revoked", makeInvitation({ revokedAt: new Date().toISOString() }), "tok_valid"],
    ["already accepted", makeInvitation({ acceptedAt: new Date().toISOString() }), "tok_valid"],
    [
      "expired",
      makeInvitation({ expiresAt: new Date(Date.now() - HOUR_MS).toISOString() }),
      "tok_valid",
    ],
    ["unknown token", makeInvitation(), "tok_wrong"],
  ];

  for (const [label, invitation, token] of cases) {
    const data = makeData(1, invitation ? [invitation] : []);
    assert.throws(
      () => admit(data, "invited@example.com", token),
      // Identical message for every case: the endpoint must not reveal which
      // addresses have been invited or why a token failed.
      /invitation is not valid for this email address/,
      `${label} must be refused`,
    );
  }
});

test("open mode restores self-service registration", () => {
  const admission = admit(makeData(1), "anyone@example.com", undefined, {
    [REGISTRATION_MODE_ENV]: "open",
  });
  assert.equal(admission.reason, "open");
});
