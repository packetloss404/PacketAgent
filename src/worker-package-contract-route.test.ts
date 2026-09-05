import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { createSeedStore, type PacketAgentData } from "./packetagent-store.js";
import { createWorkerPackageRoutes } from "./worker-package-routes.js";
import { createPacketProductSigningKeyService } from "./workers/package/signing-keys.js";
import { createPacketProductTrustService } from "./workers/package/trust.js";
import {
  PACKET_PRODUCT_OPERATIONS,
  type PacketProductOperation,
} from "./workers/package/trust-types.js";

const TEST_SECRET = "c".repeat(43);
const TEST_NOW = "2026-07-28T20:00:00.000Z";
const TEST_EXPIRY = "2026-12-31T00:00:00.000Z";

test("contract route describes schema, canonicalization, operations, and the caller's credential", async () => {
  const harness = await createHarness({
    displayName: "PacketADE Desk",
    expiresAt: TEST_EXPIRY,
  });

  const response = await harness.routes.request("/worker-packages/contract", {
    headers: readHeaders(harness.token),
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  const body = JSON.parse(text) as {
    contractSchemaVersion: string;
    schemaVersion: string;
    canonicalization: string;
    sourceIdentities: Array<{ product: string; kind: string; status: string }>;
    supportedOperations: string[];
    credential: {
      id: string;
      product: string;
      subjectId: string;
      displayName: string;
      allowedOperations: string[];
      requirePackageSignature: boolean;
      status: string;
      expiresAt: string;
    };
    signing: {
      envelope: string;
      payloadType: string;
      payloadEncoding: string;
      signedMessage: string;
      algorithm: string;
      digestAlgorithm: string;
      signatureEncoding: string;
      keyRegistry: {
        signingKeySchemaVersion: string;
        scope: string;
        keyidBinding: string;
        registration: string;
      };
      activeKeys: Array<{ keyid: string; algorithm: string; fingerprint: string; product: string }>;
    };
    events: Record<string, string>;
    evidence: Record<string, string>;
  };

  assert.equal(body.contractSchemaVersion, "packetagent.worker-package-contract/v1");
  assert.equal(body.schemaVersion, "packetagent.worker-package/v1");
  assert.equal(body.canonicalization, "packetagent.worker-package-canonical-json/v1");
  assert.deepEqual(body.sourceIdentities, [
    { product: "PacketBench", kind: "packetbench", status: "current" },
    { product: "PacketADE", kind: "packetade", status: "legacy" },
  ]);
  assert.deepEqual(body.supportedOperations, [...PACKET_PRODUCT_OPERATIONS]);
  assert.equal(body.supportedOperations.includes("attention.list"), true);
  assert.equal(body.supportedOperations.includes("attention.respond"), true);

  assert.equal(body.credential.subjectId, "packetade:contract-test");
  assert.equal(body.credential.product, "PacketADE");
  assert.equal(body.credential.displayName, "PacketADE Desk");
  assert.deepEqual(body.credential.allowedOperations, harness.allowedOperations);
  assert.equal(body.credential.requirePackageSignature, false);
  assert.equal(body.credential.status, "active");
  assert.equal(body.credential.expiresAt, TEST_EXPIRY);

  assert.equal(body.signing.envelope, "dsse/v1");
  assert.equal(body.signing.payloadType, "application/vnd.packetagent.worker-package.v1+json");
  assert.equal(body.signing.payloadEncoding, "base64");
  assert.equal(body.signing.signedMessage, "PAE(UTF8(payloadType), payload)");
  assert.equal(body.signing.algorithm, "ed25519");
  assert.equal(body.signing.digestAlgorithm, "sha256");
  assert.equal(body.signing.signatureEncoding, "base64");
  assert.equal(
    body.signing.keyRegistry.signingKeySchemaVersion,
    "packetagent.packet-product-signing-key/v1",
  );
  assert.equal(body.signing.keyRegistry.scope, "workspace");
  assert.match(body.signing.keyRegistry.keyidBinding, /signatures\[\]\.keyid/);
  assert.match(body.signing.keyRegistry.registration, /packet-product-signing-key add/);
  assert.deepEqual(body.signing.activeKeys, [
    {
      keyid: "packetbench:contract-key",
      algorithm: "ed25519",
      fingerprint: harness.signingKeyFingerprint,
      product: "PacketBench",
    },
  ]);
  assert.equal(text.includes("BEGIN PUBLIC KEY"), false, "the descriptor lists keyids, not PEM");
  assert.equal(text.includes("contract-revoked-key"), false, "revoked keys are not advertised");

  assert.deepEqual(body.events, {
    eventSchemaVersion: "packetagent.packet-product-worker-event/v1",
    eventPageSchemaVersion: "packetagent.packet-product-event-page/v1",
    eventAcknowledgementSchemaVersion: "packetagent.packet-product-event-acknowledgement/v1",
  });
  assert.deepEqual(body.evidence, {
    evidenceSchemaVersion: "packetagent.worker-evidence/v1",
    artifactManifestSchemaVersion: "packetagent.worker-artifact-manifest/v1",
  });

  assert.equal(text.includes("tokenDigest"), false);
  assert.equal(text.includes(TEST_SECRET), false);
  assert.equal(text.includes(harness.token), false);
});

test("contract route requires trust authentication and the deployment.inspect operation", async () => {
  const harness = await createHarness();

  const missingWorkspace = await harness.routes.request("/worker-packages/contract", {
    headers: { authorization: `Bearer ${harness.token}` },
  });
  const missingBody = (await missingWorkspace.json()) as {
    code: string;
    issues: Array<{ path: string }>;
  };
  assert.equal(missingWorkspace.status, 400);
  assert.equal(missingBody.code, "invalid_input");
  assert.equal(missingBody.issues[0]!.path, "$.headers.PacketAgent-Workspace-Id");

  const unauthorized = await harness.routes.request("/worker-packages/contract", {
    headers: readHeaders("not-a-token"),
  });
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get("www-authenticate") ?? "", /^Bearer /);

  const crossWorkspace = await harness.routes.request("/worker-packages/contract", {
    headers: {
      authorization: `Bearer ${harness.token}`,
      "packetagent-workspace-id": "beta",
    },
  });
  assert.equal(crossWorkspace.status, 401);

  const narrow = await createHarness({
    allowedOperations: ["package.validate"],
  });
  const forbidden = await narrow.routes.request("/worker-packages/contract", {
    headers: readHeaders(narrow.token),
  });
  assert.equal(forbidden.status, 403);
  assert.equal(((await forbidden.json()) as { code: string }).code, "forbidden");
});

async function createHarness(
  options: {
    readonly allowedOperations?: readonly PacketProductOperation[];
    readonly displayName?: string;
    readonly expiresAt?: string;
  } = {},
) {
  const data = createSeedStore();
  let mutationChain: Promise<unknown> = Promise.resolve();
  const mutateStore = <T>(mutation: (store: PacketAgentData) => T | Promise<T>) => {
    const result = mutationChain.then(() => mutation(data));
    mutationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  let generatedId = 0;
  const trust = createPacketProductTrustService({
    loadStore: () => data,
    mutateStore,
    now: () => TEST_NOW,
    generateSecret: () => TEST_SECRET,
    generateId: (kind) => `${kind}_contract_route_${++generatedId}`,
  });
  const allowedOperations = [
    ...(options.allowedOperations ?? ["deployment.inspect", "attention.list", "attention.respond"]),
  ].sort();
  const issued = await trust.issueCredential({
    workspaceId: "alpha",
    subjectId: "packetade:contract-test",
    ...(options.displayName ? { displayName: options.displayName } : {}),
    allowedOperations: allowedOperations as PacketProductOperation[],
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
    createdBy: { type: "user", id: "user_alpha" },
  });
  const signingKeys = createPacketProductSigningKeyService({
    loadStore: () => data,
    mutateStore,
    now: () => TEST_NOW,
    generateId: () => `activity_contract_route_${++generatedId}`,
  });
  const registered = await signingKeys.register({
    workspaceId: "alpha",
    keyid: "packetbench:contract-key",
    publicKey: generateKeyPairSync("ed25519").publicKey.export({
      type: "spki",
      format: "pem",
    }) as string,
    createdBy: { type: "user", id: "user_alpha" },
  });
  await signingKeys.register({
    workspaceId: "alpha",
    keyid: "packetbench:contract-revoked-key",
    publicKey: generateKeyPairSync("ed25519").publicKey.export({
      type: "spki",
      format: "pem",
    }) as string,
    createdBy: { type: "user", id: "user_alpha" },
  });
  await signingKeys.revoke({
    workspaceId: "alpha",
    keyid: "packetbench:contract-revoked-key",
    revokedBy: { type: "user", id: "user_alpha" },
  });
  await signingKeys.register({
    workspaceId: "beta",
    keyid: "packetbench:other-workspace-key",
    publicKey: generateKeyPairSync("ed25519").publicKey.export({
      type: "spki",
      format: "pem",
    }) as string,
    createdBy: { type: "user", id: "user_alpha" },
  });
  return {
    data,
    token: issued.token,
    signingKeyFingerprint: registered.fingerprint,
    allowedOperations,
    routes: createWorkerPackageRoutes({
      trust,
      loadStore: () => data,
    }),
  };
}

function readHeaders(token: string) {
  return {
    authorization: `Bearer ${token}`,
    "packetagent-workspace-id": "alpha",
  };
}
