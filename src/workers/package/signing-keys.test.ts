import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createSeedStore, type PacketAgentData } from "../../packetagent-store.js";
import { validateWorkerPersistence } from "../repository.js";
import {
  canonicalWorkerPackageBytes,
  workerPackageDssePreAuthenticationEncoding,
} from "./canonical.js";
import {
  PacketProductSigningKeyError,
  attachWorkerPackageEd25519Envelope,
  createPacketProductSigningKeyService,
  createStoreSignatureVerifier,
  normalizeEd25519PublicKey,
  packetProductSigningKeyId,
} from "./signing-keys.js";
import { WORKER_PACKAGE_DSSE_PAYLOAD_TYPE, type WorkerPackage } from "./types.js";
import { validateWorkerPackage, verifyWorkerPackage } from "./validation.js";

const FIXTURE_URL = new URL("./fixtures/packetbench-worker-package-v1.valid.json", import.meta.url);
const TIMESTAMP = "2026-09-03T10:00:00.000Z";
const ADMIN = { type: "user", id: "user_alpha", displayName: "Alpha" } as const;

test("Ed25519 public keys are normalized, fingerprinted, and private or foreign keys are rejected", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" }) as string;

  const normalized = normalizeEd25519PublicKey(pem.replace(/\n/g, "\r\n"));
  assert.equal(normalized.publicKey, pem.replace(/\r\n/g, "\n"));
  assert.match(normalized.fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(normalizeEd25519PublicKey(`\n${pem}\n`).fingerprint, normalized.fingerprint);

  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  assert.throws(
    () => normalizeEd25519PublicKey(privatePem),
    (error: unknown) =>
      error instanceof PacketProductSigningKeyError &&
      error.code === "invalid_input" &&
      /private key material/.test(error.message),
  );

  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(
    () =>
      normalizeEd25519PublicKey(rsa.publicKey.export({ type: "spki", format: "pem" }) as string),
    /must be an Ed25519 public key/,
  );
  assert.throws(() => normalizeEd25519PublicKey("not a key"), /PEM-encoded/);
  assert.throws(() => normalizeEd25519PublicKey(""), /required/);
});

test("signing keys are workspace-scoped registry records with revoke-only lifecycle", async () => {
  const harness = makeHarness();
  const { publicKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" }) as string;

  const registered = await harness.service.register({
    workspaceId: "alpha",
    keyid: "packetbench:desk-1",
    publicKey: pem,
    description: "  Desk 1 build signer  ",
    createdBy: ADMIN,
  });
  assert.equal(registered.schemaVersion, "packetagent.packet-product-signing-key/v1");
  assert.equal(registered.id, packetProductSigningKeyId("alpha", "packetbench:desk-1"));
  assert.equal(registered.algorithm, "ed25519");
  assert.equal(registered.product, "PacketBench");
  assert.equal(registered.status, "active");
  assert.equal(registered.description, "Desk 1 build signer");
  assert.equal(registered.createdAt, TIMESTAMP);
  validateWorkerPersistence(harness.data);
  assert.ok(
    harness.data.activities.some(
      (activity) =>
        activity.event === "packet_product.signing_key_registered" &&
        activity.data?.keyid === "packetbench:desk-1" &&
        activity.data?.fingerprint === registered.fingerprint,
    ),
  );

  await assert.rejects(
    harness.service.register({
      workspaceId: "alpha",
      keyid: "packetbench:desk-1",
      publicKey: pem,
      createdBy: ADMIN,
    }),
    (error: unknown) => error instanceof PacketProductSigningKeyError && error.code === "conflict",
  );
  await assert.rejects(
    harness.service.register({
      workspaceId: "missing",
      keyid: "packetbench:desk-2",
      publicKey: pem,
      createdBy: ADMIN,
    }),
    /workspace does not exist/,
  );
  await assert.rejects(
    harness.service.register({
      workspaceId: "alpha",
      keyid: "bad key id",
      publicKey: pem,
      createdBy: ADMIN,
    }),
    /keyid must be/,
  );
  await assert.rejects(
    harness.service.register({
      workspaceId: "alpha",
      keyid: "packetbench:desk-3",
      publicKey: pem,
      product: "PacketPhone" as never,
      createdBy: ADMIN,
    }),
    /product must be PacketBench/,
  );

  // The same keyid may be registered independently in another workspace.
  const other = await harness.service.register({
    workspaceId: "beta",
    keyid: "packetbench:desk-1",
    publicKey: pem,
    createdBy: ADMIN,
  });
  assert.notEqual(other.id, registered.id);
  validateWorkerPersistence(harness.data);

  const revoked = await harness.service.revoke({
    workspaceId: "alpha",
    keyid: "packetbench:desk-1",
    revokedBy: ADMIN,
  });
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.revokedAt, TIMESTAMP);
  const again = await harness.service.revoke({
    workspaceId: "alpha",
    keyid: "packetbench:desk-1",
    revokedBy: ADMIN,
  });
  assert.deepEqual(again, revoked);
  assert.equal(
    harness.data.activities.filter(
      (activity) => activity.event === "packet_product.signing_key_revoked",
    ).length,
    1,
  );
  await assert.rejects(
    harness.service.revoke({ workspaceId: "alpha", keyid: "unknown", revokedBy: ADMIN }),
    (error: unknown) => error instanceof PacketProductSigningKeyError && error.code === "not_found",
  );
  await assert.rejects(
    harness.service.register({
      workspaceId: "alpha",
      keyid: "packetbench:desk-1",
      publicKey: pem,
      createdBy: ADMIN,
    }),
    /revoked keyids cannot be reused/,
  );

  assert.deepEqual(
    (await harness.service.list({ workspaceId: "alpha" })).map((key) => key.status),
    ["revoked"],
  );
  assert.deepEqual(await harness.service.list({ workspaceId: "alpha", status: "active" }), []);
  assert.deepEqual(
    (await harness.service.list({ workspaceId: "beta" })).map((key) => key.keyid),
    ["packetbench:desk-1"],
  );
  assert.equal(JSON.stringify(harness.data).includes("PRIVATE KEY"), false);
});

test("the store-backed verifier accepts only active same-workspace keys over exact PAE bytes", async () => {
  const harness = makeHarness();
  const alphaKey = generateKeyPairSync("ed25519");
  const betaKey = generateKeyPairSync("ed25519");
  await harness.service.register({
    workspaceId: "alpha",
    keyid: "packetbench:alpha",
    publicKey: alphaKey.publicKey.export({ type: "spki", format: "pem" }) as string,
    createdBy: ADMIN,
  });
  await harness.service.register({
    workspaceId: "beta",
    keyid: "packetbench:beta",
    publicKey: betaKey.publicKey.export({ type: "spki", format: "pem" }) as string,
    createdBy: ADMIN,
  });
  const fixture = await readFixture();
  const payload = canonicalWorkerPackageBytes(fixture);
  const pae = workerPackageDssePreAuthenticationEncoding(fixture);
  const alphaSignature = sign(null, pae, alphaKey.privateKey);
  const verify = createStoreSignatureVerifier({ loadStore: () => harness.data });
  const base = {
    payloadType: WORKER_PACKAGE_DSSE_PAYLOAD_TYPE,
    payload,
    preAuthenticationEncoding: pae,
  } as const;

  assert.equal(
    await verify({
      ...base,
      workspaceId: "alpha",
      keyid: "packetbench:alpha",
      sig: alphaSignature.toString("base64"),
    }),
    true,
  );
  assert.equal(
    await verify({
      ...base,
      workspaceId: "alpha",
      keyid: "packetbench:alpha",
      sig: alphaSignature.toString("base64url"),
    }),
    true,
    "base64url signatures are accepted",
  );
  assert.equal(
    await verify({
      ...base,
      workspaceId: "beta",
      keyid: "packetbench:alpha",
      sig: alphaSignature.toString("base64"),
    }),
    false,
    "a key registered in alpha never verifies for beta",
  );
  assert.equal(
    await verify({
      ...base,
      workspaceId: "alpha",
      keyid: "packetbench:beta",
      sig: sign(null, pae, betaKey.privateKey).toString("base64"),
    }),
    false,
    "a key registered in beta never verifies for alpha even with a valid signature",
  );
  assert.equal(
    await verify({
      ...base,
      workspaceId: "alpha",
      keyid: "packetbench:unknown",
      sig: alphaSignature.toString("base64"),
    }),
    false,
  );
  assert.equal(
    await verify({ ...base, workspaceId: "alpha", sig: alphaSignature.toString("base64") }),
    false,
    "a missing keyid never verifies",
  );
  const tampered = Buffer.from(alphaSignature);
  tampered[0] = tampered[0]! ^ 0x01;
  assert.equal(
    await verify({
      ...base,
      workspaceId: "alpha",
      keyid: "packetbench:alpha",
      sig: tampered.toString("base64"),
    }),
    false,
  );
  assert.equal(
    await verify({
      ...base,
      workspaceId: "alpha",
      keyid: "packetbench:alpha",
      sig: Buffer.from("short").toString("base64"),
    }),
    false,
    "malformed signatures are rejected without throwing",
  );
  assert.equal(
    await verify({
      ...base,
      workspaceId: "alpha",
      keyid: "packetbench:alpha",
      payload: Buffer.concat([Buffer.from(payload), Buffer.from(" ")]),
      sig: alphaSignature.toString("base64"),
    }),
    false,
    "the verifier recomputes PAE from the payload rather than trusting a caller",
  );

  await harness.service.revoke({
    workspaceId: "alpha",
    keyid: "packetbench:alpha",
    revokedBy: ADMIN,
  });
  assert.equal(
    await verify({
      ...base,
      workspaceId: "alpha",
      keyid: "packetbench:alpha",
      sig: alphaSignature.toString("base64"),
    }),
    false,
    "revoked keys never verify",
  );
});

test("attachWorkerPackageEd25519Envelope produces an envelope verifyWorkerPackage accepts", async () => {
  const harness = makeHarness();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  await harness.service.register({
    workspaceId: "alpha",
    keyid: "packetbench:ci",
    publicKey: publicKey.export({ type: "spki", format: "pem" }) as string,
    createdBy: ADMIN,
  });
  const fixture = await readFixture();
  const signed = attachWorkerPackageEd25519Envelope(fixture, [
    { keyid: "packetbench:ci", privateKey },
  ]);
  assert.equal(signed.integrity.digest, fixture.integrity.digest);
  assert.equal(validateWorkerPackage(signed).ok, true);

  const verification = await verifyWorkerPackage(signed, {
    requireSignature: true,
    verifySignature: (input) => harness.service.verify({ ...input, workspaceId: "alpha" }),
  });
  assert.equal(verification.ok, true);
  assert.equal(verification.verifiedSignatures, 1);

  const crossWorkspace = await verifyWorkerPackage(signed, {
    requireSignature: true,
    verifySignature: (input) => harness.service.verify({ ...input, workspaceId: "beta" }),
  });
  assert.equal(crossWorkspace.ok, false);
  assert.equal(crossWorkspace.verifiedSignatures, 0);
});

function makeHarness() {
  const data: PacketAgentData = createSeedStore();
  let activitySequence = 0;
  const service = createPacketProductSigningKeyService({
    loadStore: () => data,
    mutateStore: (mutation) => mutation(data),
    now: () => TIMESTAMP,
    generateId: () => `activity_signing_${++activitySequence}`,
  });
  return { data, service };
}

async function readFixture(): Promise<WorkerPackage> {
  return JSON.parse(await readFile(FIXTURE_URL, "utf8")) as WorkerPackage;
}
