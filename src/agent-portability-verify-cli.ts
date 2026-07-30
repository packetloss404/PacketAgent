import {
  createAgentBundleSigningIdentityFromSecret,
  sealAgentWorkerBundle,
  verifyAgentWorkerBundle,
} from "./agents/portable-bundle.js";
import type { AgentRecord } from "./store/types.js";

const timestamp = "2026-07-29T19:00:00.000Z";
const sourceIdentity = createAgentBundleSigningIdentityFromSecret(
  "packetagent-portability-verifier-source",
);
const otherIdentity = createAgentBundleSigningIdentityFromSecret(
  "packetagent-portability-verifier-other",
);
const agent = verifierAgent();
const bundle = sealAgentWorkerBundle({
  agent,
  provider: {
    id: "provider_verifier_local",
    workspaceId: "workspace_verifier_local",
    name: "Verifier OpenAI",
    kind: "openai",
    defaultModel: "gpt-5-mini",
    baseUrl: "https://local-verifier.invalid/v1",
    apiKeyConfigured: true,
    status: "connected",
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  exportedAt: timestamp,
  signingIdentity: sourceIdentity,
});
const verified = verifyAgentWorkerBundle(bundle, { localKeyId: sourceIdentity.keyId });
const foreign = verifyAgentWorkerBundle(bundle, { localKeyId: otherIdentity.keyId });
const tampered = structuredClone(bundle);
(tampered.agent as { instructions: string }).instructions =
  "These changed instructions must not pass bundle verification.";
const rejected = verifyAgentWorkerBundle(tampered, { localKeyId: sourceIdentity.keyId });
const serialized = JSON.stringify(bundle);

const assertions = {
  versionedEnvelope: bundle.schemaVersion === "packetagent.agent-worker-bundle/v1",
  canonicalDigests:
    /^sha256:[a-f0-9]{64}$/.test(bundle.integrity.digest) &&
    /^sha256:[a-f0-9]{64}$/.test(bundle.worker.contentDigest),
  exactDsseSignature:
    bundle.integrity.signature.algorithm === "ed25519" &&
    bundle.integrity.signature.dsseEnvelope.signatures.length === 1 &&
    verified.ok &&
    verified.publisher.signatureVerified,
  portableAgentDepth:
    bundle.agent.memory[0]?.content === agent.memory?.[0]?.content &&
    bundle.agent.evaluationSpec.expectedOutput === agent.evaluationSpec?.expectedOutput &&
    bundle.agent.inputSchema[0]?.exampleValue === "2026.07",
  canonicalWorkerProjection:
    bundle.worker.content.execution.providerId === undefined &&
    bundle.worker.content.triggers[0]?.enabled === false &&
    bundle.worker.projectionWarnings.some(
      (warning) => warning.code === "projection.requires_validation",
    ),
  noInstallLocalState:
    !serialized.includes(agent.workspaceId) &&
    !serialized.includes(agent.createdByUserId) &&
    !serialized.includes(agent.providerId ?? "") &&
    !serialized.includes(agent.webhookToken ?? "") &&
    !serialized.includes("apiKey") &&
    !serialized.includes("baseUrl"),
  trustIsExplicit:
    verified.ok &&
    verified.publisher.trust === "local" &&
    foreign.ok &&
    foreign.publisher.trust === "untrusted",
  tamperingFailsClosed:
    !rejected.ok &&
    rejected.issues.some(
      (issue) =>
        issue.code === "agent_bundle.worker.projection_mismatch" ||
        issue.code === "agent_bundle.integrity.digest_mismatch",
    ),
};

const result = {
  ok: Object.values(assertions).every(Boolean),
  assertions,
  bundle: {
    schemaVersion: bundle.schemaVersion,
    digest: bundle.integrity.digest,
    workerContentDigest: bundle.worker.contentDigest,
    publisherKeyId: bundle.integrity.signature.keyId,
  },
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;

function verifierAgent(): AgentRecord {
  return {
    id: "agent_verifier_local",
    workspaceId: "workspace_verifier_local",
    name: "Portability verifier",
    description: "Verifies the Agent–Worker portability boundary.",
    instructions: "Inspect the supplied release label and return a concise verified summary.",
    providerId: "provider_verifier_local",
    model: "gpt-5-mini",
    tools: ["http_fetch"],
    enabledTools: ["http_fetch"],
    routeKey: "agent.reasoning",
    webhookToken: "webhook_verifier_local",
    schedule: "0 9 * * 1",
    triggerKind: "schedule",
    playbook: [
      {
        id: "playbook_verifier_local",
        title: "Verify",
        instruction: "Inspect the release evidence.",
      },
    ],
    memory: [
      {
        id: "memory_verifier_local",
        label: "Policy",
        content: "Escalate an unresolved release blocker.",
      },
    ],
    evaluationSpec: {
      expectedOutput: "A concise verified summary.",
      requiredTools: ["http_fetch"],
    },
    status: "active",
    createdByUserId: "user_verifier_local",
    inputSchema: [
      {
        key: "release",
        label: "Release",
        type: "string",
        required: true,
        exampleValue: "2026.07",
      },
    ],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
