import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";
import type {
  AgentEvaluationSpec,
  AgentInputField,
  AgentMemoryEntry,
  AgentPlaybookStep,
  AgentRecord,
  AgentTriggerKind,
  ProviderKind,
  ProviderRecord,
} from "../packetagent-store.js";
import {
  isSensitiveKey,
  redactSensitiveString,
  redactSensitiveValue,
} from "../security/redaction.js";
import {
  canonicalJson,
  canonicalJsonBytes,
  dssePreAuthenticationEncoding,
} from "../security/canonical-json.js";
import { deriveMasterKey } from "../security/vault.js";
import {
  projectLegacyAgentToWorker,
  type LegacyAgentProjectionOptions,
} from "../workers/projections.js";
import {
  computeWorkerVersionContentDigest,
  validateWorkerVersionContent,
} from "../workers/validation.js";
import type { WorkerReadModelProjection, WorkerVersionContent } from "../workers/types.js";

export const AGENT_WORKER_BUNDLE_SCHEMA_VERSION = "packetagent.agent-worker-bundle/v1" as const;
export const AGENT_WORKER_BUNDLE_CANONICALIZATION =
  "packetagent.agent-worker-bundle-canonical-json/v1" as const;
export const AGENT_WORKER_BUNDLE_DIGEST_ALGORITHM = "sha256" as const;
export const AGENT_WORKER_BUNDLE_DSSE_PAYLOAD_TYPE =
  "application/vnd.packetagent.agent-worker-bundle.v1+json" as const;
export const AGENT_WORKER_BUNDLE_SIGNATURE_ALGORITHM = "ed25519" as const;
export const AGENT_WORKER_BUNDLE_MAX_BYTES = 512 * 1024;

const ED25519_PKCS8_SEED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SIGNING_DERIVATION_DOMAIN = "packetagent.agent-worker-bundle.ed25519/v1";
const PORTABLE_AGENT_ID = "portable-agent";
const PORTABLE_WORKSPACE_ID = "portable-workspace";
const PORTABLE_ACTOR_ID = "portable-author";

export interface PortableAgentProviderHint {
  readonly kind: ProviderKind;
  readonly name: string;
  readonly defaultModel: string;
}

export type PortableAgentPlaybookStep = Omit<AgentPlaybookStep, "id">;

export type PortableAgentMemoryEntry = Omit<AgentMemoryEntry, "id">;

export interface PortableAgentConfiguration {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly providerHint?: PortableAgentProviderHint;
  readonly model?: string;
  readonly tools: readonly string[];
  readonly enabledTools: readonly string[];
  readonly routeKey?: string;
  readonly schedule?: string;
  readonly triggerKind: AgentTriggerKind;
  readonly playbook: readonly PortableAgentPlaybookStep[];
  readonly memory: readonly PortableAgentMemoryEntry[];
  readonly evaluationSpec: AgentEvaluationSpec;
  readonly inputSchema: readonly AgentInputField[];
}

export interface AgentWorkerBundleDsseEnvelope {
  readonly payloadType: typeof AGENT_WORKER_BUNDLE_DSSE_PAYLOAD_TYPE;
  readonly payload: string;
  readonly signatures: readonly [
    {
      readonly keyid: string;
      readonly sig: string;
    },
  ];
}

export interface AgentWorkerBundle {
  readonly schemaVersion: typeof AGENT_WORKER_BUNDLE_SCHEMA_VERSION;
  readonly source: {
    readonly product: "PacketAgent";
    readonly exportedAt: string;
  };
  readonly agent: PortableAgentConfiguration;
  readonly worker: {
    readonly content: WorkerVersionContent;
    readonly contentDigest: string;
    readonly projectionWarnings: WorkerReadModelProjection["warnings"];
  };
  readonly integrity: {
    readonly canonicalization: typeof AGENT_WORKER_BUNDLE_CANONICALIZATION;
    readonly algorithm: typeof AGENT_WORKER_BUNDLE_DIGEST_ALGORITHM;
    readonly digest: string;
    readonly signature: {
      readonly algorithm: typeof AGENT_WORKER_BUNDLE_SIGNATURE_ALGORITHM;
      readonly keyId: string;
      readonly publicKey: {
        readonly format: "spki-der";
        readonly value: string;
      };
      readonly dsseEnvelope: AgentWorkerBundleDsseEnvelope;
    };
  };
}

export interface AgentBundleSigningIdentity {
  readonly keyId: string;
  readonly publicKeyDer: Buffer;
  readonly privateKey: KeyObject;
}

export interface AgentWorkerBundleIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export class AgentWorkerBundleSecretError extends Error {
  constructor() {
    super(
      "Agent bundle export refused secret-like authored content; move secrets to the workspace vault and remove secret defaults before exporting",
    );
    this.name = "AgentWorkerBundleSecretError";
  }
}

export type AgentWorkerBundlePublisherTrust = "local" | "configured" | "untrusted";

export type AgentWorkerBundleVerification =
  | {
      readonly ok: true;
      readonly value: AgentWorkerBundle;
      readonly publisher: {
        readonly keyId: string;
        readonly trust: AgentWorkerBundlePublisherTrust;
        readonly signatureVerified: true;
      };
      readonly issues: readonly [];
    }
  | {
      readonly ok: false;
      readonly issues: readonly AgentWorkerBundleIssue[];
    };

export interface VerifyAgentWorkerBundleOptions {
  readonly localKeyId?: string;
  readonly trustedKeyIds?: Iterable<string>;
}

type AgentWorkerBundleDigestSubject = Omit<AgentWorkerBundle, "integrity"> & {
  readonly integrity: {
    readonly canonicalization: typeof AGENT_WORKER_BUNDLE_CANONICALIZATION;
    readonly algorithm: typeof AGENT_WORKER_BUNDLE_DIGEST_ALGORITHM;
  };
};

let developmentSigningIdentity: AgentBundleSigningIdentity | null = null;

export function portableAgentConfiguration(
  agent: AgentRecord,
  provider: ProviderRecord | null,
): PortableAgentConfiguration {
  return {
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    ...(provider
      ? {
          providerHint: {
            kind: provider.kind,
            name: provider.name,
            defaultModel: provider.defaultModel,
          },
        }
      : {}),
    ...(agent.model ? { model: agent.model } : {}),
    tools: [...agent.tools],
    enabledTools: [...(agent.enabledTools ?? [])],
    ...(agent.routeKey ? { routeKey: agent.routeKey } : {}),
    ...(agent.schedule ? { schedule: agent.schedule } : {}),
    triggerKind: agent.triggerKind ?? "manual",
    playbook: (agent.playbook ?? []).map(({ title, instruction }) => ({ title, instruction })),
    memory: (agent.memory ?? []).map(({ label, content }) => ({ label, content })),
    evaluationSpec: {
      expectedOutput: agent.evaluationSpec?.expectedOutput ?? "",
      requiredTools: [...(agent.evaluationSpec?.requiredTools ?? [])],
    },
    inputSchema: agent.inputSchema.map(cloneInputField),
  };
}

export function sealAgentWorkerBundle(input: {
  readonly agent: AgentRecord;
  readonly provider: ProviderRecord | null;
  readonly exportedAt?: string;
  readonly signingIdentity?: AgentBundleSigningIdentity;
  readonly projectionOptions?: LegacyAgentProjectionOptions;
}): AgentWorkerBundle {
  const exportedAt = canonicalTimestamp(input.exportedAt ?? new Date().toISOString());
  const agent = portableAgentConfiguration(input.agent, input.provider);
  assertPortableAgentContainsNoSecretLikeText(agent);
  const projection = portableWorkerProjection(agent, exportedAt, input.projectionOptions);
  const unsigned = {
    schemaVersion: AGENT_WORKER_BUNDLE_SCHEMA_VERSION,
    source: {
      product: "PacketAgent" as const,
      exportedAt,
    },
    agent,
    worker: {
      content: projection.version.content,
      contentDigest: projection.version.contentDigest,
      projectionWarnings: projection.warnings,
    },
  };
  const subject: AgentWorkerBundleDigestSubject = {
    ...unsigned,
    integrity: {
      canonicalization: AGENT_WORKER_BUNDLE_CANONICALIZATION,
      algorithm: AGENT_WORKER_BUNDLE_DIGEST_ALGORITHM,
    },
  };
  const payload = canonicalJsonBytes(subject);
  const digest = sha256Digest(payload);
  const identity = input.signingIdentity ?? defaultAgentBundleSigningIdentity();
  const signature = sign(
    null,
    dssePreAuthenticationEncoding(AGENT_WORKER_BUNDLE_DSSE_PAYLOAD_TYPE, payload),
    identity.privateKey,
  ).toString("base64");

  return {
    ...unsigned,
    integrity: {
      ...subject.integrity,
      digest,
      signature: {
        algorithm: AGENT_WORKER_BUNDLE_SIGNATURE_ALGORITHM,
        keyId: identity.keyId,
        publicKey: {
          format: "spki-der",
          value: identity.publicKeyDer.toString("base64"),
        },
        dsseEnvelope: {
          payloadType: AGENT_WORKER_BUNDLE_DSSE_PAYLOAD_TYPE,
          payload: Buffer.from(payload).toString("base64"),
          signatures: [
            {
              keyid: identity.keyId,
              sig: signature,
            },
          ],
        },
      },
    },
  };
}

export function validateAgentWorkerBundle(value: unknown): AgentWorkerBundleIssue[] {
  const issues: AgentWorkerBundleIssue[] = [];
  const bundle = recordAt(value, "$", issues);
  if (!bundle) return issues;
  expectKeys(bundle, ["schemaVersion", "source", "agent", "worker", "integrity"], "$", issues);
  if (bundle.schemaVersion !== AGENT_WORKER_BUNDLE_SCHEMA_VERSION) {
    issue(
      issues,
      "$.schemaVersion",
      "agent_bundle.schema_version.unsupported",
      `must equal ${JSON.stringify(AGENT_WORKER_BUNDLE_SCHEMA_VERSION)}`,
    );
  }
  validateSource(bundle.source, issues);
  validatePortableAgent(bundle.agent, issues);
  validateWorkerProjection(bundle.worker, issues);
  validateIntegrity(bundle.integrity, issues);

  if (issues.length === 0) {
    const typed = value as AgentWorkerBundle;
    try {
      const expectedProjection = portableWorkerProjection(typed.agent, typed.source.exportedAt);
      if (
        !safeTextEqual(
          canonicalJson(typed.worker.content),
          canonicalJson(expectedProjection.version.content),
        )
      ) {
        issue(
          issues,
          "$.worker.content",
          "agent_bundle.worker.projection_mismatch",
          "must equal the canonical draft Worker projection of the portable Agent",
        );
      }
      if (!safeTextEqual(typed.worker.contentDigest, expectedProjection.version.contentDigest)) {
        issue(
          issues,
          "$.worker.contentDigest",
          "agent_bundle.worker.digest_mismatch",
          "must equal the projected Worker content digest",
        );
      }
      const expectedDigest = sha256Digest(agentWorkerBundleCanonicalBytes(typed));
      if (!safeTextEqual(typed.integrity.digest, expectedDigest)) {
        issue(
          issues,
          "$.integrity.digest",
          "agent_bundle.integrity.digest_mismatch",
          `must equal the canonical bundle digest (${expectedDigest})`,
        );
      }
      const expectedPayload = Buffer.from(agentWorkerBundleCanonicalBytes(typed));
      const actualPayload = decodeBase64(
        typed.integrity.signature.dsseEnvelope.payload,
        "$.integrity.signature.dsseEnvelope.payload",
        issues,
      );
      if (actualPayload && !safeBytesEqual(actualPayload, expectedPayload)) {
        issue(
          issues,
          "$.integrity.signature.dsseEnvelope.payload",
          "agent_bundle.signature.payload_mismatch",
          "must contain the exact canonical bundle subject bytes",
        );
      }
    } catch (error) {
      issue(
        issues,
        "$",
        "agent_bundle.canonicalization.failed",
        error instanceof Error ? error.message : "could not canonicalize the bundle",
      );
    }
  }
  return issues;
}

export function verifyAgentWorkerBundle(
  value: unknown,
  options: VerifyAgentWorkerBundleOptions = {},
): AgentWorkerBundleVerification {
  const issues = validateAgentWorkerBundle(value);
  if (issues.length > 0) return { ok: false, issues };
  const bundle = value as AgentWorkerBundle;
  const signatureRecord = bundle.integrity.signature;
  const publicKeyDer = decodeBase64(
    signatureRecord.publicKey.value,
    "$.integrity.signature.publicKey.value",
    issues,
  );
  const signature = decodeBase64(
    signatureRecord.dsseEnvelope.signatures[0].sig,
    "$.integrity.signature.dsseEnvelope.signatures[0].sig",
    issues,
  );
  if (!publicKeyDer || !signature) return { ok: false, issues };

  const computedKeyId = keyIdForPublicKey(publicKeyDer);
  if (
    !safeTextEqual(signatureRecord.keyId, computedKeyId) ||
    !safeTextEqual(signatureRecord.dsseEnvelope.signatures[0].keyid, computedKeyId)
  ) {
    issue(
      issues,
      "$.integrity.signature.keyId",
      "agent_bundle.signature.key_id_mismatch",
      `must equal the embedded public key fingerprint (${computedKeyId})`,
    );
    return { ok: false, issues };
  }

  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({
      key: publicKeyDer,
      format: "der",
      type: "spki",
    });
    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw new Error("public key is not Ed25519");
    }
  } catch {
    issue(
      issues,
      "$.integrity.signature.publicKey.value",
      "agent_bundle.signature.public_key_invalid",
      "must contain a valid Ed25519 SPKI DER public key",
    );
    return { ok: false, issues };
  }

  const verified = verify(
    null,
    dssePreAuthenticationEncoding(
      AGENT_WORKER_BUNDLE_DSSE_PAYLOAD_TYPE,
      agentWorkerBundleCanonicalBytes(bundle),
    ),
    publicKey,
    signature,
  );
  if (!verified) {
    issue(
      issues,
      "$.integrity.signature.dsseEnvelope.signatures[0].sig",
      "agent_bundle.signature.invalid",
      "does not verify the canonical bundle subject",
    );
    return { ok: false, issues };
  }

  const trusted = new Set(options.trustedKeyIds ?? trustedAgentBundleKeyIds());
  const trust: AgentWorkerBundlePublisherTrust = safeTextEqual(
    computedKeyId,
    options.localKeyId ?? defaultAgentBundleSigningIdentity().keyId,
  )
    ? "local"
    : trusted.has(computedKeyId)
      ? "configured"
      : "untrusted";
  return {
    ok: true,
    value: bundle,
    publisher: {
      keyId: computedKeyId,
      trust,
      signatureVerified: true,
    },
    issues: [],
  };
}

export function agentWorkerBundleCanonicalBytes(bundle: AgentWorkerBundle): Uint8Array {
  return canonicalJsonBytes(agentWorkerBundleDigestSubject(bundle));
}

export function createAgentBundleSigningIdentityFromSecret(
  secret: string | Uint8Array,
): AgentBundleSigningIdentity {
  const keyMaterial =
    typeof secret === "string" ? Buffer.from(secret, "utf8") : Buffer.from(secret);
  const seed = createHmac("sha256", keyMaterial).update(SIGNING_DERIVATION_DOMAIN).digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  return signingIdentity(privateKey);
}

export function defaultAgentBundleSigningIdentity(
  env: NodeJS.ProcessEnv = process.env,
): AgentBundleSigningIdentity {
  const masterKey = env.MASTER_KEY?.trim();
  if (masterKey) {
    return createAgentBundleSigningIdentityFromSecret(deriveMasterKey(masterKey));
  }
  if (env.NODE_ENV === "production") {
    throw new Error(
      "agent bundle signing is unavailable: set MASTER_KEY before exporting or importing Agent bundles",
    );
  }
  developmentSigningIdentity ??= signingIdentity(generateKeyPairSync("ed25519").privateKey);
  return developmentSigningIdentity;
}

export function trustedAgentBundleKeyIds(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> {
  return new Set(
    String(env.PACKETAGENT_AGENT_BUNDLE_TRUSTED_KEY_IDS ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => /^sha256:[a-f0-9]{64}$/.test(entry)),
  );
}

export function resetDevelopmentAgentBundleSigningIdentityForTests(): void {
  developmentSigningIdentity = null;
}

function signingIdentity(privateKey: KeyObject): AgentBundleSigningIdentity {
  const publicKey = createPublicKey(privateKey);
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  return {
    keyId: keyIdForPublicKey(publicKeyDer),
    publicKeyDer,
    privateKey,
  };
}

function keyIdForPublicKey(publicKeyDer: Uint8Array): string {
  return sha256Digest(publicKeyDer);
}

function agentWorkerBundleDigestSubject(bundle: AgentWorkerBundle): AgentWorkerBundleDigestSubject {
  const { integrity: _integrity, ...content } = bundle;
  return {
    ...content,
    integrity: {
      canonicalization: AGENT_WORKER_BUNDLE_CANONICALIZATION,
      algorithm: AGENT_WORKER_BUNDLE_DIGEST_ALGORITHM,
    },
  };
}

function portableWorkerProjection(
  agent: PortableAgentConfiguration,
  timestamp: string,
  projectionOptions?: LegacyAgentProjectionOptions,
): WorkerReadModelProjection {
  const record: AgentRecord = {
    id: PORTABLE_AGENT_ID,
    workspaceId: PORTABLE_WORKSPACE_ID,
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    model: agent.model,
    tools: [...agent.tools],
    enabledTools: [...agent.enabledTools],
    routeKey: agent.routeKey,
    schedule: agent.schedule,
    triggerKind: agent.triggerKind,
    playbook: agent.playbook.map((step, index) => ({
      id: `portable-playbook-${index + 1}`,
      ...step,
    })),
    memory: agent.memory.map((entry, index) => ({
      id: `portable-memory-${index + 1}`,
      ...entry,
    })),
    evaluationSpec: {
      expectedOutput: agent.evaluationSpec.expectedOutput,
      requiredTools: [...agent.evaluationSpec.requiredTools],
    },
    status: "paused",
    createdByUserId: PORTABLE_ACTOR_ID,
    inputSchema: agent.inputSchema.map(cloneInputField),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return projectLegacyAgentToWorker(record, projectionOptions);
}

function cloneInputField(field: AgentInputField): AgentInputField {
  return {
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    ...(field.description ? { description: field.description } : {}),
    ...(field.options ? { options: [...field.options] } : {}),
    ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
    ...(field.exampleValue !== undefined ? { exampleValue: field.exampleValue } : {}),
  };
}

function validateSource(value: unknown, issues: AgentWorkerBundleIssue[]): void {
  const source = recordAt(value, "$.source", issues);
  if (!source) return;
  expectKeys(source, ["product", "exportedAt"], "$.source", issues);
  if (source.product !== "PacketAgent") {
    issue(issues, "$.source.product", "agent_bundle.source.product", "must equal PacketAgent");
  }
  if (typeof source.exportedAt !== "string" || !isCanonicalTimestamp(source.exportedAt)) {
    issue(
      issues,
      "$.source.exportedAt",
      "agent_bundle.timestamp.invalid",
      "must be a canonical ISO-8601 timestamp",
    );
  }
}

function validatePortableAgent(value: unknown, issues: AgentWorkerBundleIssue[]): void {
  const agent = recordAt(value, "$.agent", issues);
  if (!agent) return;
  expectKeys(
    agent,
    [
      "name",
      "description",
      "instructions",
      "providerHint",
      "model",
      "tools",
      "enabledTools",
      "routeKey",
      "schedule",
      "triggerKind",
      "playbook",
      "memory",
      "evaluationSpec",
      "inputSchema",
    ],
    "$.agent",
    issues,
  );
  textAt(agent, "name", "$.agent", issues, { min: 2, max: 80 });
  textAt(agent, "description", "$.agent", issues, { allowEmpty: true, max: 2_000 });
  textAt(agent, "instructions", "$.agent", issues, { min: 10, max: 100_000 });
  optionalTextAt(agent, "model", "$.agent", issues, 500);
  optionalTextAt(agent, "routeKey", "$.agent", issues, 200);
  optionalTextAt(agent, "schedule", "$.agent", issues, 500);
  if (!["manual", "schedule", "webhook", "email"].includes(String(agent.triggerKind))) {
    issue(
      issues,
      "$.agent.triggerKind",
      "agent_bundle.agent.trigger_kind",
      "must be manual, schedule, webhook, or email",
    );
  }
  validateProviderHint(agent.providerHint, issues);
  const tools = stringArrayAt(agent, "tools", "$.agent", issues, 12, 200);
  const enabledTools = stringArrayAt(agent, "enabledTools", "$.agent", issues, 24, 200);
  validatePlaybook(agent.playbook, issues);
  validateMemory(agent.memory, issues);
  validateEvaluationSpec(agent.evaluationSpec, enabledTools, issues);
  validateInputSchema(agent.inputSchema, issues);
  if (tools && new Set(tools).size !== tools.length) {
    issue(issues, "$.agent.tools", "agent_bundle.agent.duplicate_tool", "must not repeat tools");
  }
  if (containsSecretLikePortableAgentText(agent)) {
    issue(
      issues,
      "$.agent",
      "agent_bundle.agent.secret_like_content",
      "must not contain secret-like authored values or defaults",
    );
  }
}

function validateProviderHint(value: unknown, issues: AgentWorkerBundleIssue[]): void {
  if (value === undefined) return;
  const hint = recordAt(value, "$.agent.providerHint", issues);
  if (!hint) return;
  expectKeys(hint, ["kind", "name", "defaultModel"], "$.agent.providerHint", issues);
  if (
    ![
      "openai",
      "anthropic",
      "minimax",
      "azure_openai",
      "ollama",
      "gemini",
      "openrouter",
      "custom",
    ].includes(String(hint.kind))
  ) {
    issue(
      issues,
      "$.agent.providerHint.kind",
      "agent_bundle.agent.provider_kind",
      "must be a supported PacketAgent provider kind",
    );
  }
  textAt(hint, "name", "$.agent.providerHint", issues, { max: 200 });
  textAt(hint, "defaultModel", "$.agent.providerHint", issues, { max: 500 });
}

function validatePlaybook(value: unknown, issues: AgentWorkerBundleIssue[]): void {
  if (!Array.isArray(value)) {
    issue(issues, "$.agent.playbook", "type.array", "must be an array");
    return;
  }
  if (value.length > 20) {
    issue(issues, "$.agent.playbook", "agent_bundle.bounds.playbook", "must have at most 20 steps");
  }
  value.forEach((entry, index) => {
    const path = `$.agent.playbook[${index}]`;
    const step = recordAt(entry, path, issues);
    if (!step) return;
    expectKeys(step, ["title", "instruction"], path, issues);
    textAt(step, "title", path, issues, { max: 120 });
    textAt(step, "instruction", path, issues, { allowEmpty: true, max: 600 });
  });
}

function validateMemory(value: unknown, issues: AgentWorkerBundleIssue[]): void {
  if (!Array.isArray(value)) {
    issue(issues, "$.agent.memory", "type.array", "must be an array");
    return;
  }
  if (value.length > 12) {
    issue(issues, "$.agent.memory", "agent_bundle.bounds.memory", "must have at most 12 entries");
  }
  value.forEach((entry, index) => {
    const path = `$.agent.memory[${index}]`;
    const memory = recordAt(entry, path, issues);
    if (!memory) return;
    expectKeys(memory, ["label", "content"], path, issues);
    const label = textAt(memory, "label", path, issues, { max: 80 });
    const content = textAt(memory, "content", path, issues, { max: 1_000 });
    if (
      (label && redactSensitiveString(label) !== label) ||
      (content && redactSensitiveString(content) !== content)
    ) {
      issue(issues, path, "agent_bundle.secret_like_memory", "must not contain secret-like values");
    }
  });
}

function validateEvaluationSpec(
  value: unknown,
  enabledTools: readonly string[] | undefined,
  issues: AgentWorkerBundleIssue[],
): void {
  const spec = recordAt(value, "$.agent.evaluationSpec", issues);
  if (!spec) return;
  expectKeys(spec, ["expectedOutput", "requiredTools"], "$.agent.evaluationSpec", issues);
  const expected = textAt(spec, "expectedOutput", "$.agent.evaluationSpec", issues, {
    allowEmpty: true,
    max: 1_200,
  });
  if (expected && redactSensitiveString(expected) !== expected) {
    issue(
      issues,
      "$.agent.evaluationSpec.expectedOutput",
      "agent_bundle.secret_like_evaluation",
      "must not contain secret-like values",
    );
  }
  const required = stringArrayAt(spec, "requiredTools", "$.agent.evaluationSpec", issues, 24, 200);
  if (required && enabledTools) {
    const enabled = new Set(enabledTools);
    const missing = required.filter((tool) => !enabled.has(tool));
    if (missing.length > 0) {
      issue(
        issues,
        "$.agent.evaluationSpec.requiredTools",
        "agent_bundle.agent.evaluation_tool_not_enabled",
        `must only contain enabled tools (${missing.join(", ")})`,
      );
    }
  }
}

function validateInputSchema(value: unknown, issues: AgentWorkerBundleIssue[]): void {
  if (!Array.isArray(value)) {
    issue(issues, "$.agent.inputSchema", "type.array", "must be an array");
    return;
  }
  if (value.length > 12) {
    issue(
      issues,
      "$.agent.inputSchema",
      "agent_bundle.bounds.input_schema",
      "must have at most 12 fields",
    );
  }
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const path = `$.agent.inputSchema[${index}]`;
    const field = recordAt(entry, path, issues);
    if (!field) return;
    expectKeys(
      field,
      [
        "key",
        "label",
        "type",
        "required",
        "description",
        "options",
        "defaultValue",
        "exampleValue",
      ],
      path,
      issues,
    );
    const key = textAt(field, "key", path, issues, { max: 40 });
    if (key && !/^[a-z0-9_]{1,40}$/i.test(key)) {
      issue(issues, `${path}.key`, "agent_bundle.agent.input_key", "has an invalid format");
    }
    if (key && seen.has(key)) {
      issue(issues, `${path}.key`, "agent_bundle.agent.input_key_duplicate", "must be unique");
    }
    if (key) seen.add(key);
    textAt(field, "label", path, issues, { max: 200 });
    if (!["string", "number", "boolean", "url", "enum"].includes(String(field.type))) {
      issue(
        issues,
        `${path}.type`,
        "agent_bundle.agent.input_type",
        "must be string, number, boolean, url, or enum",
      );
    }
    if (typeof field.required !== "boolean") {
      issue(issues, `${path}.required`, "type.boolean", "must be a boolean");
    }
    optionalTextAt(field, "description", path, issues, 2_000);
    optionalTextAt(field, "defaultValue", path, issues, 1_000);
    const example = optionalTextAt(field, "exampleValue", path, issues, 1_000);
    if (example && redactSensitiveString(example) !== example) {
      issue(
        issues,
        `${path}.exampleValue`,
        "agent_bundle.secret_like_example",
        "must not contain secret-like values",
      );
    }
    if (field.type === "enum") {
      const options = stringArrayAt(field, "options", path, issues, 16, 500);
      if (options?.length === 0) {
        issue(
          issues,
          `${path}.options`,
          "agent_bundle.agent.enum_options",
          "must contain at least one option",
        );
      }
    } else if (field.options !== undefined) {
      issue(
        issues,
        `${path}.options`,
        "agent_bundle.agent.unexpected_options",
        "is only allowed for enum fields",
      );
    }
    if (
      key &&
      isSensitiveKey(key) &&
      (field.defaultValue !== undefined || field.exampleValue !== undefined)
    ) {
      issue(
        issues,
        path,
        "agent_bundle.agent.secret_default",
        "must not carry a default or example for a secret-named input",
      );
    }
  });
}

function validateWorkerProjection(value: unknown, issues: AgentWorkerBundleIssue[]): void {
  const worker = recordAt(value, "$.worker", issues);
  if (!worker) return;
  expectKeys(worker, ["content", "contentDigest", "projectionWarnings"], "$.worker", issues);
  const contentValidation = validateWorkerVersionContent(worker.content);
  for (const entry of contentValidation.issues) {
    issue(
      issues,
      `$.worker.content${entry.path === "$" ? "" : entry.path.slice(1)}`,
      entry.code,
      entry.message,
    );
  }
  if (
    typeof worker.contentDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(worker.contentDigest)
  ) {
    issue(
      issues,
      "$.worker.contentDigest",
      "agent_bundle.worker.digest_format",
      "must be a lowercase sha256 digest",
    );
  } else if (contentValidation.ok) {
    const expected = computeWorkerVersionContentDigest(contentValidation.value);
    if (!safeTextEqual(worker.contentDigest, expected)) {
      issue(
        issues,
        "$.worker.contentDigest",
        "agent_bundle.worker.digest_mismatch",
        `must equal the Worker content digest (${expected})`,
      );
    }
  }
  if (!Array.isArray(worker.projectionWarnings)) {
    issue(issues, "$.worker.projectionWarnings", "type.array", "must be an array");
  } else {
    worker.projectionWarnings.forEach((entry, index) => {
      const path = `$.worker.projectionWarnings[${index}]`;
      const warning = recordAt(entry, path, issues);
      if (!warning) return;
      expectKeys(warning, ["code", "message", "path"], path, issues);
      textAt(warning, "code", path, issues, { max: 200 });
      textAt(warning, "message", path, issues, { max: 2_000 });
      textAt(warning, "path", path, issues, { max: 500 });
    });
  }
}

function validateIntegrity(value: unknown, issues: AgentWorkerBundleIssue[]): void {
  const integrity = recordAt(value, "$.integrity", issues);
  if (!integrity) return;
  expectKeys(
    integrity,
    ["canonicalization", "algorithm", "digest", "signature"],
    "$.integrity",
    issues,
  );
  if (integrity.canonicalization !== AGENT_WORKER_BUNDLE_CANONICALIZATION) {
    issue(
      issues,
      "$.integrity.canonicalization",
      "agent_bundle.integrity.canonicalization",
      `must equal ${AGENT_WORKER_BUNDLE_CANONICALIZATION}`,
    );
  }
  if (integrity.algorithm !== AGENT_WORKER_BUNDLE_DIGEST_ALGORITHM) {
    issue(
      issues,
      "$.integrity.algorithm",
      "agent_bundle.integrity.algorithm",
      `must equal ${AGENT_WORKER_BUNDLE_DIGEST_ALGORITHM}`,
    );
  }
  if (typeof integrity.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(integrity.digest)) {
    issue(
      issues,
      "$.integrity.digest",
      "agent_bundle.integrity.digest_format",
      "must be a lowercase sha256 digest",
    );
  }
  const signature = recordAt(integrity.signature, "$.integrity.signature", issues);
  if (!signature) return;
  expectKeys(
    signature,
    ["algorithm", "keyId", "publicKey", "dsseEnvelope"],
    "$.integrity.signature",
    issues,
  );
  if (signature.algorithm !== AGENT_WORKER_BUNDLE_SIGNATURE_ALGORITHM) {
    issue(
      issues,
      "$.integrity.signature.algorithm",
      "agent_bundle.signature.algorithm",
      `must equal ${AGENT_WORKER_BUNDLE_SIGNATURE_ALGORITHM}`,
    );
  }
  if (typeof signature.keyId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(signature.keyId)) {
    issue(
      issues,
      "$.integrity.signature.keyId",
      "agent_bundle.signature.key_id_format",
      "must be a lowercase sha256 public-key fingerprint",
    );
  }
  const publicKey = recordAt(signature.publicKey, "$.integrity.signature.publicKey", issues);
  if (publicKey) {
    expectKeys(publicKey, ["format", "value"], "$.integrity.signature.publicKey", issues);
    if (publicKey.format !== "spki-der") {
      issue(
        issues,
        "$.integrity.signature.publicKey.format",
        "agent_bundle.signature.public_key_format",
        "must equal spki-der",
      );
    }
    base64At(publicKey, "value", "$.integrity.signature.publicKey", issues);
  }
  const envelope = recordAt(signature.dsseEnvelope, "$.integrity.signature.dsseEnvelope", issues);
  if (!envelope) return;
  expectKeys(
    envelope,
    ["payloadType", "payload", "signatures"],
    "$.integrity.signature.dsseEnvelope",
    issues,
  );
  if (envelope.payloadType !== AGENT_WORKER_BUNDLE_DSSE_PAYLOAD_TYPE) {
    issue(
      issues,
      "$.integrity.signature.dsseEnvelope.payloadType",
      "agent_bundle.signature.payload_type",
      `must equal ${AGENT_WORKER_BUNDLE_DSSE_PAYLOAD_TYPE}`,
    );
  }
  base64At(envelope, "payload", "$.integrity.signature.dsseEnvelope", issues);
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length !== 1) {
    issue(
      issues,
      "$.integrity.signature.dsseEnvelope.signatures",
      "agent_bundle.signature.count",
      "must contain exactly one signature",
    );
  } else {
    const entry = recordAt(
      envelope.signatures[0],
      "$.integrity.signature.dsseEnvelope.signatures[0]",
      issues,
    );
    if (entry) {
      expectKeys(
        entry,
        ["keyid", "sig"],
        "$.integrity.signature.dsseEnvelope.signatures[0]",
        issues,
      );
      textAt(entry, "keyid", "$.integrity.signature.dsseEnvelope.signatures[0]", issues, {
        max: 100,
      });
      base64At(entry, "sig", "$.integrity.signature.dsseEnvelope.signatures[0]", issues);
    }
  }
}

function recordAt(
  value: unknown,
  path: string,
  issues: AgentWorkerBundleIssue[],
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issue(issues, path, "type.object", "must be an object");
    return null;
  }
  return value as Record<string, unknown>;
}

function expectKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: AgentWorkerBundleIssue[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      issue(
        issues,
        `${path}.${key}`,
        "agent_bundle.unexpected_field",
        "is not allowed in this bundle version",
      );
    }
  }
}

function textAt(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: AgentWorkerBundleIssue[],
  options: { min?: number; max: number; allowEmpty?: boolean },
): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    issue(issues, `${path}.${key}`, "type.string", "must be a string");
    return undefined;
  }
  if (!options.allowEmpty && value.trim().length < (options.min ?? 1)) {
    issue(
      issues,
      `${path}.${key}`,
      "string.non_empty",
      `must contain at least ${options.min ?? 1} non-whitespace character(s)`,
    );
  }
  if (value.length > options.max) {
    issue(
      issues,
      `${path}.${key}`,
      "string.max_length",
      `must be at most ${options.max} characters`,
    );
  }
  return value;
}

function optionalTextAt(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: AgentWorkerBundleIssue[],
  max: number,
): string | undefined {
  if (record[key] === undefined) return undefined;
  return textAt(record, key, path, issues, { max });
}

function stringArrayAt(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: AgentWorkerBundleIssue[],
  maxItems: number,
  maxLength: number,
): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    issue(issues, `${path}.${key}`, "type.array", "must be an array");
    return undefined;
  }
  if (value.length > maxItems) {
    issue(
      issues,
      `${path}.${key}`,
      "agent_bundle.bounds.array",
      `must have at most ${maxItems} items`,
    );
  }
  const strings: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || !entry.trim() || entry.length > maxLength) {
      issue(
        issues,
        `${path}.${key}[${index}]`,
        "type.non_empty_string",
        `must be a non-empty string of at most ${maxLength} characters`,
      );
    } else {
      strings.push(entry);
    }
  });
  return strings;
}

function base64At(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: AgentWorkerBundleIssue[],
): void {
  if (typeof record[key] !== "string" || !isCanonicalBase64(record[key])) {
    issue(issues, `${path}.${key}`, "type.base64", "must be canonical base64");
  }
}

function decodeBase64(
  value: string,
  path: string,
  issues: AgentWorkerBundleIssue[],
): Buffer | null {
  if (!isCanonicalBase64(value)) {
    issue(issues, path, "type.base64", "must be canonical base64");
    return null;
  }
  return Buffer.from(value, "base64");
}

function isCanonicalBase64(value: unknown): value is string {
  if (typeof value !== "string" || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    return Buffer.from(value, "base64").toString("base64") === value;
  } catch {
    return false;
  }
}

function issue(
  issues: AgentWorkerBundleIssue[],
  path: string,
  code: string,
  message: string,
): void {
  issues.push({ path, code, message });
}

function sha256Digest(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function safeTextEqual(left: string, right: string): boolean {
  return safeBytesEqual(Buffer.from(left), Buffer.from(right));
}

function safeBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function canonicalTimestamp(value: string): string {
  if (!isCanonicalTimestamp(value)) throw new Error("exportedAt must be a canonical ISO timestamp");
  return value;
}

function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function assertPortableAgentContainsNoSecretLikeText(agent: PortableAgentConfiguration): void {
  if (containsSecretLikePortableAgentText(agent)) {
    throw new AgentWorkerBundleSecretError();
  }
}

function containsSecretLikePortableAgentText(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const agent = value as {
    memory?: unknown;
    inputSchema?: unknown;
  };
  if (
    Array.isArray(agent.memory) &&
    agent.memory.some(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        isSensitiveKey(String((entry as { label?: unknown }).label ?? "")),
    )
  ) {
    return true;
  }
  if (
    Array.isArray(agent.inputSchema) &&
    agent.inputSchema.some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const field = entry as {
        key?: unknown;
        defaultValue?: unknown;
        exampleValue?: unknown;
      };
      return (
        isSensitiveKey(String(field.key ?? "")) &&
        (field.defaultValue !== undefined || field.exampleValue !== undefined)
      );
    })
  ) {
    return true;
  }
  return JSON.stringify(redactSensitiveValue(value)) !== JSON.stringify(value);
}
