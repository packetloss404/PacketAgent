import { isIP } from "node:net";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { resolveWorkerPublicHost, type WorkerPublicNetworkTarget } from "./network.js";

export interface WorkerSmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly requireTls: boolean;
  readonly from: string;
  readonly user?: string;
  readonly pass?: string;
}

export interface WorkerSmtpMessage {
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly replyTo?: string;
}

export interface WorkerSmtpSendResult {
  readonly messageId?: string;
  readonly accepted?: readonly string[];
  readonly rejected?: readonly string[];
}

export interface WorkerSmtpSendInput {
  readonly config: WorkerSmtpConfig;
  readonly message: WorkerSmtpMessage;
  readonly signal: AbortSignal;
}

export interface WorkerSmtpPort {
  send(input: WorkerSmtpSendInput): Promise<WorkerSmtpSendResult>;
}

export interface WorkerSmtpTransport {
  sendMail(message: SMTPTransport.MailOptions): Promise<SMTPTransport.SentMessageInfo>;
  close(): void;
}

export interface WorkerSmtpClientDeps {
  readonly resolveTarget: (hostname: string) => Promise<WorkerPublicNetworkTarget>;
  readonly createTransport: (options: SMTPTransport.Options) => WorkerSmtpTransport;
}

const defaultDeps: WorkerSmtpClientDeps = {
  resolveTarget: resolveWorkerPublicHost,
  createTransport(options) {
    return nodemailer.createTransport(options);
  },
};

export function createWorkerSmtpClient(deps: WorkerSmtpClientDeps = defaultDeps): WorkerSmtpPort {
  return {
    async send(input) {
      assertSmtpBoundary(input.config, input.message);
      if (input.signal.aborted) throw abortError(input.signal);
      const target = await deps.resolveTarget(input.config.host);
      if (input.signal.aborted) throw abortError(input.signal);
      const options: SMTPTransport.Options = {
        host: target.pinnedAddress.address,
        port: input.config.port,
        secure: input.config.secure,
        requireTLS: !input.config.secure && input.config.requireTls,
        ignoreTLS: false,
        opportunisticTLS: false,
        name: "packetagent.local",
        connectionTimeout: 15_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
        disableFileAccess: true,
        disableUrlAccess: true,
        logger: false,
        debug: false,
        tls: {
          ...(isIP(target.hostname) === 0 ? { servername: target.hostname } : {}),
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
        },
        ...(input.config.user && input.config.pass
          ? {
              auth: {
                user: input.config.user,
                pass: input.config.pass,
              },
            }
          : {}),
      };
      const transport = deps.createTransport(options);
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        transport.close();
      };
      try {
        const result = await abortable(
          transport.sendMail({
            from: input.message.from,
            to: [...input.message.to],
            subject: input.message.subject,
            text: input.message.text,
            ...(input.message.html !== undefined ? { html: input.message.html } : {}),
            ...(input.message.cc ? { cc: [...input.message.cc] } : {}),
            ...(input.message.bcc ? { bcc: [...input.message.bcc] } : {}),
            ...(input.message.replyTo ? { replyTo: input.message.replyTo } : {}),
            disableFileAccess: true,
            disableUrlAccess: true,
          }),
          input.signal,
          close,
        );
        return {
          messageId: normalizeMessageId(result.messageId),
          accepted: normalizeAddresses(result.accepted),
          rejected: normalizeAddresses(result.rejected),
        };
      } finally {
        close();
      }
    },
  };
}

function assertSmtpBoundary(config: WorkerSmtpConfig, message: WorkerSmtpMessage): void {
  if (
    !config.host.trim() ||
    !Number.isInteger(config.port) ||
    config.port < 1 ||
    config.port > 65_535
  )
    throw new Error("SMTP configuration is invalid.");
  if (!config.secure && !config.requireTls) {
    throw new Error("SMTP transport requires implicit TLS or mandatory STARTTLS.");
  }
  if (Boolean(config.user) !== Boolean(config.pass)) {
    throw new Error("SMTP username and password must be configured together.");
  }
  if (message.from !== config.from) {
    throw new Error("SMTP sender must match the credential-bound from address.");
  }
}

function normalizeAddresses(values: SMTPTransport.SentMessageInfo["accepted"]): string[] {
  return values.flatMap((value) =>
    typeof value === "string" ? [value] : value.address ? [value.address] : [],
  );
}

function normalizeMessageId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\r\n\0]/g, "").slice(0, 512);
  return normalized || undefined;
}

async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onAbort: () => void,
): Promise<T> {
  if (signal.aborted) {
    onAbort();
    throw abortError(signal);
  }
  let onSignal: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onSignal = () => {
      onAbort();
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onSignal, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onSignal) signal.removeEventListener("abort", onSignal);
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(typeof signal.reason === "string" ? signal.reason : "SMTP send aborted.");
}
