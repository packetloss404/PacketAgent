import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { createSeedStore, type PacketAgentData } from "./packetagent-store.js";
import { deriveMasterKey } from "./security/vault.js";
import { compileWorkerCapabilityPolicy } from "./workers/capabilities.js";
import { createWorkerCredentialService } from "./workers/credentials.js";
import type { WorkerToolRuntimeServices } from "./workers/runtime-services.js";
import { createWorkerSmtpClient } from "./workers/smtp.js";
import type { WorkerCompiledPolicy } from "./workers/types.js";
import { makeWorkerVersionContent } from "./workers/__tests__/fixtures.js";
import { computeWorkerVersionContentDigest } from "./workers/validation.js";
import { createEmailSendTool } from "./tools/email-sql.js";
import { executeTool } from "./tools/executor.js";
import type { ToolContext, ToolPolicyDecision } from "./tools/types.js";

const workspaceId = "smtp-verifier";
const credentialRef = "vault:smtp-primary";
const smtpSecret = "r6-verifier-secret-never-output";
const smtpValue = JSON.stringify({
  host: "smtp.example.com",
  port: 587,
  secure: false,
  requireTls: true,
  from: "PacketAgent <noreply@example.com>",
  user: "smtp-user",
  pass: smtpSecret,
});

const data = createSeedStore();
const credentialService = createWorkerCredentialService({
  async mutateStore<T>(mutator: (store: PacketAgentData) => T | Promise<T>): Promise<T> {
    return await mutator(data);
  },
  masterKey: () => deriveMasterKey("packetagent-r6-smtp-verifier"),
  generateId: () => "credential-smtp-primary",
  now: () => "2026-07-29T12:00:00.000Z",
});
await credentialService.upsert({
  workspaceId,
  reference: credentialRef,
  kind: "smtp_config",
  label: "Primary SMTP",
  value: smtpValue,
});

let transportOptions: SMTPTransport.Options | undefined;
const directSmtp = createWorkerSmtpClient({
  async resolveTarget(hostname) {
    return {
      hostname,
      addresses: [{ address: "93.184.216.34", family: 4 }],
      pinnedAddress: { address: "93.184.216.34", family: 4 },
    };
  },
  createTransport(options) {
    transportOptions = options;
    return {
      async sendMail() {
        return {
          envelope: { from: "noreply@example.com", to: ["ada@example.com"] },
          messageId: "verified-message\r\nignored-header",
          accepted: ["ada@example.com"],
          rejected: [],
          pending: [],
          response: "250 queued",
        };
      },
      close() {},
    };
  },
});
const directResult = await directSmtp.send({
  config: {
    host: "smtp.example.com",
    port: 587,
    secure: false,
    requireTls: true,
    from: "PacketAgent <noreply@example.com>",
    user: "smtp-user",
    pass: smtpSecret,
  },
  message: {
    from: "PacketAgent <noreply@example.com>",
    to: ["ada@example.com"],
    subject: "Verifier",
    text: "No live email is sent.",
  },
  signal: new AbortController().signal,
});

const policy = smtpPolicy();
const order: string[] = [];
const services: WorkerToolRuntimeServices = {
  credentials: {
    async use(reference, expectedKinds, consumer) {
      order.push("credential");
      return await credentialService.use(
        {
          workspaceId,
          reference,
          declaredCredentialRefs: [credentialRef],
          expectedKinds,
        },
        consumer,
      );
    },
  },
  network: {
    async request() {
      throw new Error("SMTP verifier must not use the HTTP broker.");
    },
  },
  sandbox: {
    async execute() {
      throw new Error("SMTP verifier must not use the sandbox.");
    },
  },
  smtp: {
    async send(input) {
      order.push("smtp");
      check(input.config.pass === smtpSecret, "Worker SMTP did not receive the vault value.");
      check(input.config.requireTls, "Worker SMTP did not require TLS.");
      check(
        input.message.from === "PacketAgent <noreply@example.com>",
        "Worker SMTP sender was not credential-bound.",
      );
      return { messageId: "worker-message", accepted: [...input.message.to], rejected: [] };
    },
  },
};
const tool = createEmailSendTool();

const denied = await executeTool({
  tool,
  input: {
    to: "admin@example.com",
    subject: "Denied",
    text: "This must not resolve a credential.",
    credentialRef,
  },
  context: workerContext(policy, services, async (decision) => {
    order.push(decision.allowed ? "policy:allow" : "policy:deny");
  }),
});
const deniedOrder = [...order];

order.length = 0;
const allowed = await executeTool({
  tool,
  input: {
    to: "ada@example.com",
    subject: "Allowed",
    text: "This is handled by the deterministic fake transport.",
    credentialRef,
  },
  context: workerContext(policy, services, async (decision) => {
    order.push(decision.allowed ? "policy:allow" : "policy:deny");
  }),
});
const allowedOrder = [...order];

let agentDefaultPortUsed = false;
const agentTool = createEmailSendTool({
  env: {
    SMTP_HOST: "smtp.example.com",
    SMTP_PORT: "587",
    SMTP_USER: "smtp-user",
    SMTP_PASS: smtpSecret,
    SMTP_FROM: "PacketAgent <noreply@example.com>",
    SMTP_REQUIRE_TLS: "true",
  },
  smtp: {
    async send(input) {
      agentDefaultPortUsed = true;
      check(input.config.requireTls, "Agent default SMTP port did not require TLS.");
      return { messageId: "agent-message", accepted: [...input.message.to], rejected: [] };
    },
  },
});
const agentResult = await agentTool.handle(
  {
    to: "ada@example.com",
    subject: "Agent default port",
    text: "This is handled by the deterministic fake transport.",
  },
  {
    workspaceId,
    userId: "smtp-verifier",
    runId: "agent-run",
    signal: new AbortController().signal,
  },
);

const storedCredentialEncrypted = !JSON.stringify(data).includes(smtpSecret);
const addressPinned = transportOptions?.host === "93.184.216.34";
const tlsRequired =
  transportOptions?.requireTLS === true &&
  transportOptions?.ignoreTLS === false &&
  transportOptions?.opportunisticTLS === false &&
  transportOptions?.tls?.rejectUnauthorized === true &&
  transportOptions?.tls?.minVersion === "TLSv1.2";
const senderBound =
  transportOptions?.tls?.servername === "smtp.example.com" &&
  directResult.messageId === "verified-messageignored-header";
const deniedBeforeCredential = denied.status === "error" && deniedOrder.join(",") === "policy:deny";
const allowedAfterPolicy =
  allowed.status === "ok" &&
  allowedOrder.join(",") === "policy:allow,credential,smtp" &&
  !JSON.stringify(allowed.output).includes(smtpSecret);
const defaultAgentTransport =
  agentResult.ok &&
  agentDefaultPortUsed &&
  !JSON.stringify(agentResult.output).includes(smtpSecret);

const result = {
  ok:
    storedCredentialEncrypted &&
    addressPinned &&
    tlsRequired &&
    senderBound &&
    deniedBeforeCredential &&
    allowedAfterPolicy &&
    defaultAgentTransport,
  assertions: {
    storedCredentialEncrypted,
    addressPinned,
    tlsRequired,
    senderBound,
    deniedBeforeCredential,
    allowedAfterPolicy,
    defaultAgentTransport,
  },
  policyOrder: {
    denied: deniedOrder,
    allowed: allowedOrder,
  },
};
const serialized = JSON.stringify(result, null, 2);
check(!serialized.includes(smtpSecret), "SMTP verifier output exposed a credential.");
process.stdout.write(`${serialized}\n`);
if (!result.ok) process.exitCode = 1;

function smtpPolicy(): WorkerCompiledPolicy {
  const capability = {
    id: "email-send",
    tool: "email_send",
    verbs: ["SEND"],
    resources: ["mailto:ada@example.com"],
    effect: "write" as const,
    approval: "never" as const,
  };
  const base = makeWorkerVersionContent();
  const content = makeWorkerVersionContent({
    tools: [capability],
    credentialRefs: [credentialRef],
    policy: {
      ...base.policy,
      permissions: {
        default: "deny",
        allowedCapabilityIds: [capability.id],
      },
    },
  });
  return compileWorkerCapabilityPolicy({
    workerVersionContentDigest: computeWorkerVersionContentDigest(content),
    requestedCapabilities: content.tools,
    allowedCapabilityIds: content.policy.permissions.allowedCapabilityIds,
    credentialRefs: content.credentialRefs,
  }).policy;
}

function workerContext(
  policy: WorkerCompiledPolicy,
  runtimeServices: WorkerToolRuntimeServices,
  recordPolicyDecision: (decision: ToolPolicyDecision) => Promise<void>,
): Omit<ToolContext, "signal"> {
  return {
    workspaceId,
    userId: "packetagent.worker-supervisor",
    runId: "smtp-worker-run",
    worker: {
      run: { id: "smtp-worker-run" },
      deployment: {
        id: "smtp-worker-deployment",
        revision: 1,
        compiledPolicy: policy,
      },
      version: {
        id: "smtp-worker-version",
        contentDigest: policy.workerVersionContentDigest,
        declaredCredentialRefs: [credentialRef],
      },
      budget: {
        elapsedMs: 10,
        iterations: 1,
        providerCostUsd: 0,
        consecutiveFailures: 0,
        toolCalls: 1,
      },
      actor: { type: "system", id: "smtp-verifier" },
      services: runtimeServices,
      recordPolicyDecision,
    },
  };
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
