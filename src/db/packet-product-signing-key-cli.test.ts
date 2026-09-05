import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { createSeedStore, type PacketAgentData } from "../packetagent-store";
import { createPacketProductSigningKeyService } from "../workers/package/signing-keys.js";
import {
  addPacketProductSigningKey,
  listPacketProductSigningKeys,
  parsePacketProductSigningKeyAddArgs,
  parsePacketProductSigningKeyListArgs,
  parsePacketProductSigningKeyRevokeArgs,
  revokePacketProductSigningKey,
} from "./cli";

const TEST_NOW = "2026-09-03T12:00:00.000Z";

test("packet-product-signing-key add, list, and revoke manage workspace-scoped Ed25519 public keys", async () => {
  const harness = createHarness();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" }) as string;

  const added = await addPacketProductSigningKey(
    {
      workspaceId: "alpha",
      keyid: "packetbench:desk-7",
      publicKeyFile: "desk-7.pub.pem",
      description: "Desk 7",
    },
    { signingKeys: harness.signingKeys, readPublicKeyFile: () => pem },
  );
  assert.equal(added.command, "packet-product-signing-key-add");
  assert.equal(added.key.workspaceId, "alpha");
  assert.equal(added.key.keyid, "packetbench:desk-7");
  assert.equal(added.key.algorithm, "ed25519");
  assert.equal(added.key.product, "PacketBench");
  assert.equal(added.key.status, "active");
  assert.equal(added.key.description, "Desk 7");
  assert.equal(added.key.createdBy.id, "packetagent.db-cli");
  assert.equal(added.key.createdAt, TEST_NOW);
  assert.match(added.key.fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(harness.data.packetProductSigningKeys?.length, 1);
  assert.ok(
    harness.data.activities.some(
      (activity) => activity.event === "packet_product.signing_key_registered",
    ),
  );

  const listed = await listPacketProductSigningKeys(
    { workspaceId: "alpha" },
    { signingKeys: harness.signingKeys },
  );
  assert.equal(listed.command, "packet-product-signing-key-list");
  assert.deepEqual(
    listed.keys.map((key) => [key.keyid, key.status]),
    [["packetbench:desk-7", "active"]],
  );
  assert.deepEqual(
    (
      await listPacketProductSigningKeys(
        { workspaceId: "beta" },
        { signingKeys: harness.signingKeys },
      )
    ).keys,
    [],
  );

  const revoked = await revokePacketProductSigningKey(
    { workspaceId: "alpha", keyid: "packetbench:desk-7" },
    { signingKeys: harness.signingKeys },
  );
  assert.equal(revoked.command, "packet-product-signing-key-revoke");
  assert.equal(revoked.key.status, "revoked");
  assert.equal(revoked.key.revokedAt, TEST_NOW);
  assert.deepEqual(
    (
      await listPacketProductSigningKeys(
        { workspaceId: "alpha", status: "active" },
        { signingKeys: harness.signingKeys },
      )
    ).keys,
    [],
  );

  await assert.rejects(
    revokePacketProductSigningKey(
      { workspaceId: "alpha", keyid: "packetbench:missing" },
      { signingKeys: harness.signingKeys },
    ),
    /was not found/,
  );
  await assert.rejects(
    addPacketProductSigningKey(
      { workspaceId: "alpha", keyid: "packetbench:private", publicKeyFile: "private.pem" },
      {
        signingKeys: harness.signingKeys,
        readPublicKeyFile: () => privateKey.export({ type: "pkcs8", format: "pem" }) as string,
      },
    ),
    /private key material is never accepted/,
  );
  await assert.rejects(
    addPacketProductSigningKey(
      { workspaceId: "alpha", keyid: "packetbench:missing-file", publicKeyFile: "missing.pem" },
      {
        signingKeys: harness.signingKeys,
        readPublicKeyFile: () => {
          throw new Error("ENOENT");
        },
      },
    ),
    /--public-key-file could not be read: ENOENT/,
  );
  await assert.rejects(
    addPacketProductSigningKey(
      { workspaceId: "nope", keyid: "packetbench:desk-8", publicKeyFile: "desk-8.pub.pem" },
      { signingKeys: harness.signingKeys, readPublicKeyFile: () => pem },
    ),
    /workspace does not exist/,
  );
  assert.equal(JSON.stringify(harness.data).includes("PRIVATE KEY"), false);
});

test("packet-product-signing-key argument parsing accepts both flag styles and fails closed", () => {
  assert.deepEqual(
    parsePacketProductSigningKeyAddArgs([
      "--workspace",
      "alpha",
      "--keyid",
      "packetbench:desk-7",
      "--public-key-file",
      "keys/desk-7.pub.pem",
      "--description",
      "Desk 7",
    ]),
    {
      workspaceId: "alpha",
      keyid: "packetbench:desk-7",
      publicKeyFile: "keys/desk-7.pub.pem",
      description: "Desk 7",
    },
  );
  assert.deepEqual(
    parsePacketProductSigningKeyAddArgs([
      "--workspace=beta",
      "--keyid=packetade:legacy",
      "--public-key-file=legacy.pem",
      "--product=PacketADE",
    ]),
    {
      workspaceId: "beta",
      keyid: "packetade:legacy",
      publicKeyFile: "legacy.pem",
      product: "PacketADE",
    },
  );
  assert.throws(
    () => parsePacketProductSigningKeyAddArgs(["--workspace", "alpha", "--keyid", "k"]),
    /requires --workspace <id> --keyid <id> --public-key-file <path>/,
  );
  assert.throws(
    () =>
      parsePacketProductSigningKeyAddArgs([
        "--workspace",
        "alpha",
        "--keyid",
        "k",
        "--public-key-file",
      ]),
    /--public-key-file requires a value/,
  );
  assert.throws(
    () =>
      parsePacketProductSigningKeyAddArgs([
        "--workspace=alpha",
        "--keyid=k",
        "--public-key-file=k.pem",
        "--product=PacketPhone",
      ]),
    /--product must be PacketBench/,
  );

  assert.deepEqual(parsePacketProductSigningKeyRevokeArgs(["--workspace", "alpha", "--keyid=k"]), {
    workspaceId: "alpha",
    keyid: "k",
  });
  assert.throws(
    () => parsePacketProductSigningKeyRevokeArgs(["--workspace", "alpha"]),
    /requires --workspace <id> --keyid <id>/,
  );

  assert.deepEqual(parsePacketProductSigningKeyListArgs(["--workspace", "alpha"]), {
    workspaceId: "alpha",
  });
  assert.deepEqual(
    parsePacketProductSigningKeyListArgs(["--workspace=alpha", "--status=revoked"]),
    { workspaceId: "alpha", status: "revoked" },
  );
  assert.throws(() => parsePacketProductSigningKeyListArgs([]), /requires --workspace <id>/);
  assert.throws(
    () => parsePacketProductSigningKeyListArgs(["--workspace=alpha", "--status=expired"]),
    /--status must be active or revoked/,
  );
});

function createHarness() {
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
  const signingKeys = createPacketProductSigningKeyService({
    loadStore: () => data,
    mutateStore,
    now: () => TEST_NOW,
    generateId: () => `activity_signing_cli_${++generatedId}`,
  });
  return { data, signingKeys };
}
