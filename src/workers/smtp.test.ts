import assert from "node:assert/strict";
import test from "node:test";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { WorkerNetworkError } from "./network.js";
import { createWorkerSmtpClient, type WorkerSmtpClientDeps } from "./smtp.js";

const baseConfig = {
  host: "smtp.example.com",
  port: 587,
  secure: false,
  requireTls: true,
  from: "PacketAgent <noreply@example.com>",
  user: "smtp-user",
  pass: "smtp-secret",
};

const baseMessage = {
  from: baseConfig.from,
  to: ["ada@example.com"],
  subject: "Hello",
  text: "Plain body",
};

test("Worker SMTP pins the resolved address and requires authenticated TLS", async () => {
  let seenOptions: SMTPTransport.Options | undefined;
  let seenMessage: SMTPTransport.MailOptions | undefined;
  let closes = 0;
  const client = createWorkerSmtpClient(
    deps({
      createTransport(options) {
        seenOptions = options;
        return {
          async sendMail(message) {
            seenMessage = message;
            return smtpResult();
          },
          close() {
            closes += 1;
          },
        };
      },
    }),
  );

  const result = await client.send({
    config: baseConfig,
    message: baseMessage,
    signal: new AbortController().signal,
  });

  assert.equal(seenOptions?.host, "93.184.216.34");
  assert.equal(seenOptions?.port, 587);
  assert.equal(seenOptions?.secure, false);
  assert.equal(seenOptions?.requireTLS, true);
  assert.equal(seenOptions?.ignoreTLS, false);
  assert.equal(seenOptions?.opportunisticTLS, false);
  assert.equal(seenOptions?.disableFileAccess, true);
  assert.equal(seenOptions?.disableUrlAccess, true);
  assert.deepEqual(seenOptions?.auth, { user: "smtp-user", pass: "smtp-secret" });
  assert.equal(seenOptions?.tls?.servername, "smtp.example.com");
  assert.equal(seenOptions?.tls?.rejectUnauthorized, true);
  assert.equal(seenOptions?.tls?.minVersion, "TLSv1.2");
  assert.equal(seenMessage?.from, baseConfig.from);
  assert.equal(seenMessage?.disableFileAccess, true);
  assert.equal(seenMessage?.disableUrlAccess, true);
  assert.deepEqual(result, {
    messageId: "message-1injected",
    accepted: ["ada@example.com"],
    rejected: [],
  });
  assert.equal(closes, 1);
});

test("Worker SMTP rejects non-public resolution before transport creation", async () => {
  let created = 0;
  const client = createWorkerSmtpClient(
    deps({
      async resolveTarget() {
        throw new WorkerNetworkError("blocked_address", "blocked");
      },
      createTransport() {
        created += 1;
        throw new Error("must not create transport");
      },
    }),
  );

  await assert.rejects(
    () =>
      client.send({
        config: baseConfig,
        message: baseMessage,
        signal: new AbortController().signal,
      }),
    (error: unknown) => error instanceof WorkerNetworkError && error.code === "blocked_address",
  );
  assert.equal(created, 0);
});

test("Worker SMTP fails closed for plaintext transport and mismatched senders", async () => {
  const client = createWorkerSmtpClient(deps());
  await assert.rejects(
    () =>
      client.send({
        config: { ...baseConfig, secure: false, requireTls: false },
        message: baseMessage,
        signal: new AbortController().signal,
      }),
    /requires implicit TLS or mandatory STARTTLS/,
  );
  await assert.rejects(
    () =>
      client.send({
        config: baseConfig,
        message: { ...baseMessage, from: "spoof@example.com" },
        signal: new AbortController().signal,
      }),
    /sender must match/,
  );
});

test("Worker SMTP closes the transport exactly once when the run is aborted", async () => {
  let closes = 0;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const controller = new AbortController();
  const client = createWorkerSmtpClient(
    deps({
      createTransport() {
        return {
          async sendMail() {
            markStarted?.();
            return await new Promise<SMTPTransport.SentMessageInfo>(() => {});
          },
          close() {
            closes += 1;
          },
        };
      },
    }),
  );
  const sending = client.send({
    config: baseConfig,
    message: baseMessage,
    signal: controller.signal,
  });
  await started;
  controller.abort(new Error("run stopped"));

  await assert.rejects(() => sending, /run stopped/);
  assert.equal(closes, 1);
});

test("Worker SMTP does not resolve or create a transport when already aborted", async () => {
  let resolutions = 0;
  let transports = 0;
  const controller = new AbortController();
  controller.abort(new Error("already stopped"));
  const client = createWorkerSmtpClient(
    deps({
      async resolveTarget(hostname) {
        resolutions += 1;
        return {
          hostname,
          addresses: [{ address: "93.184.216.34", family: 4 }],
          pinnedAddress: { address: "93.184.216.34", family: 4 },
        };
      },
      createTransport() {
        transports += 1;
        throw new Error("must not create transport");
      },
    }),
  );

  await assert.rejects(
    () =>
      client.send({
        config: baseConfig,
        message: baseMessage,
        signal: controller.signal,
      }),
    /already stopped/,
  );
  assert.equal(resolutions, 0);
  assert.equal(transports, 0);
});

function deps(overrides: Partial<WorkerSmtpClientDeps> = {}): WorkerSmtpClientDeps {
  return {
    async resolveTarget(hostname) {
      return {
        hostname,
        addresses: [{ address: "93.184.216.34", family: 4 }],
        pinnedAddress: { address: "93.184.216.34", family: 4 },
      };
    },
    createTransport() {
      return {
        async sendMail() {
          return smtpResult();
        },
        close() {},
      };
    },
    ...overrides,
  };
}

function smtpResult(): SMTPTransport.SentMessageInfo {
  return {
    envelope: { from: "noreply@example.com", to: ["ada@example.com"] },
    messageId: "message-1\r\ninjected",
    accepted: ["ada@example.com"],
    rejected: [],
    pending: [],
    response: "250 queued",
  };
}
