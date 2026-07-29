import assert from "node:assert/strict";
import test from "node:test";
import {
  deliverInvitationEmail,
  resetInvitationEmailDeliveryForTests,
  setInvitationEmailFetchForTests,
  type InvitationEmailDeliveryRequest,
} from "./invitation-email-delivery";
import {
  DEFAULT_INVITATION_EMAIL_WEBHOOK_TIMEOUT_MS,
  PACKETAGENT_INVITATION_EMAIL_MODE_ENV,
  PACKETAGENT_INVITATION_EMAIL_PROVIDER_ENV,
  PACKETAGENT_INVITATION_EMAIL_WEBHOOK_SECRET_ENV,
  PACKETAGENT_INVITATION_EMAIL_WEBHOOK_SECRET_HEADER_ENV,
  PACKETAGENT_INVITATION_EMAIL_WEBHOOK_TIMEOUT_MS_ENV,
  PACKETAGENT_INVITATION_EMAIL_WEBHOOK_URL_ENV,
} from "./invitation-email";
import { resetStoreForTests, type PacketAgentData } from "./packetagent-store";

const invitationRequest: InvitationEmailDeliveryRequest = {
  workspaceId: "alpha",
  workspaceName: "Alpha Workspace",
  invitationId: "invite_phase_13",
  email: "Invitee@Example.Com",
  token: "invite-phase-13-token",
  subject: "You're invited to Alpha Workspace on PacketAgent",
  action: "create",
};

const invitationEmailEnvVars = [
  PACKETAGENT_INVITATION_EMAIL_MODE_ENV,
  PACKETAGENT_INVITATION_EMAIL_PROVIDER_ENV,
  PACKETAGENT_INVITATION_EMAIL_WEBHOOK_URL_ENV,
  PACKETAGENT_INVITATION_EMAIL_WEBHOOK_SECRET_ENV,
  PACKETAGENT_INVITATION_EMAIL_WEBHOOK_SECRET_HEADER_ENV,
  PACKETAGENT_INVITATION_EMAIL_WEBHOOK_TIMEOUT_MS_ENV,
];

async function withInvitationEmailEnv(
  run: (store: PacketAgentData) => Promise<void> | void,
): Promise<void> {
  const previous = new Map(invitationEmailEnvVars.map((key) => [key, process.env[key]]));

  try {
    for (const key of invitationEmailEnvVars) delete process.env[key];
    resetInvitationEmailDeliveryForTests();
    await run(resetStoreForTests());
  } finally {
    resetInvitationEmailDeliveryForTests();
    for (const key of invitationEmailEnvVars) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("deliverInvitationEmail records local dev deliveries without external provider calls", async () => {
  await withInvitationEmailEnv(async (store) => {
    const result = await deliverInvitationEmail(
      store,
      invitationRequest,
      "2026-04-26T10:00:00.000Z",
    );
    const delivery = store.invitationEmailDeliveries.at(-1);

    assert.equal(result.status, "sent");
    assert.equal(result.error, null);
    assert.equal(delivery?.status, "sent");
    assert.equal(delivery?.mode, "dev");
    assert.equal(delivery?.provider, "local");
    assert.equal(delivery?.recipientEmail, "invitee@example.com");
    assert.equal(delivery?.sentAt, "2026-04-26T10:00:00.000Z");
  });
});

test("deliverInvitationEmail records skip mode deliveries without corrupting state", async () => {
  await withInvitationEmailEnv(async (store) => {
    process.env[PACKETAGENT_INVITATION_EMAIL_MODE_ENV] = "skip";

    const result = await deliverInvitationEmail(
      store,
      invitationRequest,
      "2026-04-26T10:01:00.000Z",
    );
    const delivery = store.invitationEmailDeliveries.at(-1);

    assert.equal(result.status, "skipped");
    assert.equal(result.error, `${PACKETAGENT_INVITATION_EMAIL_MODE_ENV}=skip`);
    assert.equal(delivery?.status, "skipped");
    assert.equal(delivery?.mode, "skip");
    assert.equal(delivery?.provider, "local");
    assert.equal(delivery?.sentAt, undefined);
    assert.equal(delivery?.error, `${PACKETAGENT_INVITATION_EMAIL_MODE_ENV}=skip`);
  });
});

test("deliverInvitationEmail posts webhook deliveries and records success", async () => {
  await withInvitationEmailEnv(async (store) => {
    let postedUrl: string | URL | Request | undefined;
    let postedInit: RequestInit | undefined;
    process.env[PACKETAGENT_INVITATION_EMAIL_MODE_ENV] = "webhook";
    process.env[PACKETAGENT_INVITATION_EMAIL_PROVIDER_ENV] = "mail-webhook";
    process.env[PACKETAGENT_INVITATION_EMAIL_WEBHOOK_URL_ENV] =
      "https://mail.example.test/invitations";
    process.env[PACKETAGENT_INVITATION_EMAIL_WEBHOOK_SECRET_ENV] = "secret-value";
    process.env[PACKETAGENT_INVITATION_EMAIL_WEBHOOK_SECRET_HEADER_ENV] = "x-mail-secret";
    setInvitationEmailFetchForTests(async (url, init) => {
      postedUrl = url;
      postedInit = init;
      return new Response(null, { status: 202, statusText: "Accepted" });
    });

    const result = await deliverInvitationEmail(
      store,
      invitationRequest,
      "2026-04-26T10:02:00.000Z",
    );
    const delivery = store.invitationEmailDeliveries.at(-1);

    assert.equal(result.status, "sent");
    assert.equal(postedUrl, "https://mail.example.test/invitations");
    assert.equal(postedInit?.method, "POST");
    assert.deepEqual(postedInit?.headers, {
      "content-type": "application/json",
      "x-mail-secret": "secret-value",
    });
    assert.deepEqual(JSON.parse(String(postedInit?.body)), invitationRequest);
    assert.equal(delivery?.status, "sent");
    assert.equal(delivery?.mode, "webhook");
    assert.equal(delivery?.provider, "mail-webhook");
    assert.equal(delivery?.sentAt, "2026-04-26T10:02:00.000Z");
    assert.equal(delivery?.error, undefined);
  });
});

test("deliverInvitationEmail applies configured webhook timeout", async () => {
  await withInvitationEmailEnv(async (store) => {
    let timeoutMs: number | undefined;
    const timeout = AbortSignal.timeout;
    AbortSignal.timeout = ((milliseconds: number) => {
      timeoutMs = milliseconds;
      return timeout(milliseconds);
    }) as typeof AbortSignal.timeout;

    try {
      process.env[PACKETAGENT_INVITATION_EMAIL_MODE_ENV] = "webhook";
      process.env[PACKETAGENT_INVITATION_EMAIL_WEBHOOK_URL_ENV] =
        "https://mail.example.test/invitations";
      process.env[PACKETAGENT_INVITATION_EMAIL_WEBHOOK_TIMEOUT_MS_ENV] = "2500";
      setInvitationEmailFetchForTests(
        async () => new Response(null, { status: 202, statusText: "Accepted" }),
      );

      const result = await deliverInvitationEmail(
        store,
        invitationRequest,
        "2026-04-26T10:02:30.000Z",
      );

      assert.equal(result.status, "sent");
      assert.equal(timeoutMs, 2500);
    } finally {
      AbortSignal.timeout = timeout;
    }
  });
});

test("deliverInvitationEmail falls back to default webhook timeout for invalid values", async () => {
  await withInvitationEmailEnv(async (store) => {
    let timeoutMs: number | undefined;
    const timeout = AbortSignal.timeout;
    AbortSignal.timeout = ((milliseconds: number) => {
      timeoutMs = milliseconds;
      return timeout(milliseconds);
    }) as typeof AbortSignal.timeout;

    try {
      process.env[PACKETAGENT_INVITATION_EMAIL_MODE_ENV] = "webhook";
      process.env[PACKETAGENT_INVITATION_EMAIL_WEBHOOK_URL_ENV] =
        "https://mail.example.test/invitations";
      process.env[PACKETAGENT_INVITATION_EMAIL_WEBHOOK_TIMEOUT_MS_ENV] = "0";
      setInvitationEmailFetchForTests(
        async () => new Response(null, { status: 202, statusText: "Accepted" }),
      );

      const result = await deliverInvitationEmail(
        store,
        invitationRequest,
        "2026-04-26T10:02:45.000Z",
      );

      assert.equal(result.status, "sent");
      assert.equal(timeoutMs, DEFAULT_INVITATION_EMAIL_WEBHOOK_TIMEOUT_MS);
    } finally {
      AbortSignal.timeout = timeout;
    }
  });
});

test("deliverInvitationEmail records webhook timeout abort failures", async () => {
  await withInvitationEmailEnv(async (store) => {
    process.env[PACKETAGENT_INVITATION_EMAIL_MODE_ENV] = "webhook";
    process.env[PACKETAGENT_INVITATION_EMAIL_WEBHOOK_URL_ENV] =
      "https://mail.example.test/invitations";
    process.env[PACKETAGENT_INVITATION_EMAIL_WEBHOOK_TIMEOUT_MS_ENV] = "1";
    setInvitationEmailFetchForTests(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("webhook request aborted")),
            { once: true },
          );
        }),
    );

    const result = await deliverInvitationEmail(
      store,
      invitationRequest,
      "2026-04-26T10:02:50.000Z",
    );
    const delivery = store.invitationEmailDeliveries.at(-1);

    assert.equal(result.status, "failed");
    assert.equal(result.error, "webhook request aborted");
    assert.equal(delivery?.status, "failed");
    assert.equal(delivery?.mode, "webhook");
    assert.equal(delivery?.provider, "webhook");
    assert.equal(delivery?.sentAt, undefined);
    assert.equal(delivery?.error, "webhook request aborted");
  });
});

test("deliverInvitationEmail records webhook provider failures", async () => {
  await withInvitationEmailEnv(async (store) => {
    process.env[PACKETAGENT_INVITATION_EMAIL_MODE_ENV] = "webhook";
    process.env[PACKETAGENT_INVITATION_EMAIL_WEBHOOK_URL_ENV] =
      "https://mail.example.test/invitations";
    setInvitationEmailFetchForTests(
      async () => new Response(null, { status: 503, statusText: "Unavailable" }),
    );

    const result = await deliverInvitationEmail(
      store,
      invitationRequest,
      "2026-04-26T10:03:00.000Z",
    );
    const delivery = store.invitationEmailDeliveries.at(-1);

    assert.equal(result.status, "failed");
    assert.equal(result.error, "webhook invitation email provider returned 503 Unavailable");
    assert.equal(delivery?.status, "failed");
    assert.equal(delivery?.mode, "webhook");
    assert.equal(delivery?.provider, "webhook");
    assert.equal(delivery?.sentAt, undefined);
    assert.equal(delivery?.error, "webhook invitation email provider returned 503 Unavailable");
  });
});

test("deliverInvitationEmail records missing webhook configuration as failed delivery", async () => {
  await withInvitationEmailEnv(async (store) => {
    process.env[PACKETAGENT_INVITATION_EMAIL_MODE_ENV] = "webhook";

    const result = await deliverInvitationEmail(
      store,
      invitationRequest,
      "2026-04-26T10:04:00.000Z",
    );
    const delivery = store.invitationEmailDeliveries.at(-1);

    assert.equal(result.status, "failed");
    assert.equal(
      result.error,
      `${PACKETAGENT_INVITATION_EMAIL_WEBHOOK_URL_ENV} is required when ${PACKETAGENT_INVITATION_EMAIL_MODE_ENV}=webhook`,
    );
    assert.equal(delivery?.status, "failed");
    assert.equal(delivery?.mode, "webhook");
    assert.equal(delivery?.provider, "webhook");
    assert.equal(delivery?.sentAt, undefined);
    assert.equal(
      delivery?.error,
      `${PACKETAGENT_INVITATION_EMAIL_WEBHOOK_URL_ENV} is required when ${PACKETAGENT_INVITATION_EMAIL_MODE_ENV}=webhook`,
    );
  });
});
