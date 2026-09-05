import assert from "node:assert/strict";
import test from "node:test";
import { createSeedStore, type PacketAgentData } from "../packetagent-store";
import { createPacketProductTrustService } from "../workers/package/trust.js";
import { PACKET_PRODUCT_OPERATIONS } from "../workers/package/trust-types.js";
import {
  issuePacketProductCredential,
  parsePacketProductCredentialIssueArgs,
  parsePacketProductOperationsCsv,
} from "./cli";

const TEST_SECRET = "t".repeat(43);
const TEST_NOW = "2026-07-28T20:00:00.000Z";

test("packet-product-credential issue mints a workspace credential and returns the token once", async () => {
  const harness = createHarness();

  const result = await issuePacketProductCredential(
    { workspaceId: "alpha" },
    { trust: harness.trust },
  );

  assert.equal(result.command, "packet-product-credential-issue");
  assert.match(result.token, /^pkade\.credential_cli_1\.[A-Za-z0-9_-]{32,}$/);
  assert.equal(result.token, `pkade.${result.credential.id}.${TEST_SECRET}`);
  assert.equal(result.credential.workspaceId, "alpha");
  assert.equal(result.credential.subjectId, "packetbench:alpha");
  assert.equal(result.credential.product, "PacketADE");
  assert.deepEqual(result.credential.allowedOperations, [...PACKET_PRODUCT_OPERATIONS].sort());
  assert.equal(result.credential.allowedOperations.includes("attention.list"), true);
  assert.equal(result.credential.allowedOperations.includes("attention.respond"), true);
  assert.equal(result.credential.requirePackageSignature, false);
  assert.equal(result.credential.status, "active");
  assert.equal("tokenDigest" in result.credential, false);

  const persisted = harness.data.packetProductCredentials.find(
    (record) => record.id === result.credential.id,
  );
  assert.ok(persisted);
  assert.equal(persisted.workspaceId, "alpha");
  assert.match(persisted.tokenDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(harness.data).includes(TEST_SECRET), false);
});

test("packet-product-credential issue honors an explicit operations subset and options", async () => {
  const harness = createHarness();

  const result = await issuePacketProductCredential(
    {
      workspaceId: "alpha",
      operations: ["deployment.inspect", "attention.list", "attention.respond"],
      subjectId: "packetade:desk-7",
      displayName: "Desk 7",
      expiresAt: "2026-12-31T00:00:00.000Z",
      requirePackageSignature: true,
    },
    { trust: harness.trust },
  );

  assert.deepEqual(result.credential.allowedOperations, [
    "attention.list",
    "attention.respond",
    "deployment.inspect",
  ]);
  assert.equal(result.credential.subjectId, "packetade:desk-7");
  assert.equal(result.credential.displayName, "Desk 7");
  assert.equal(result.credential.expiresAt, "2026-12-31T00:00:00.000Z");
  assert.equal(result.credential.requirePackageSignature, true);
});

test("packet-product-credential issue fails closed on unknown workspaces and operations", async () => {
  const harness = createHarness();

  await assert.rejects(
    issuePacketProductCredential({ workspaceId: "nope" }, { trust: harness.trust }),
    /workspace does not exist/i,
  );
  assert.equal(harness.data.packetProductCredentials.length, 0);

  assert.throws(
    () => parsePacketProductOperationsCsv("attention.list,package.delete_everything"),
    /unsupported: package\.delete_everything/,
  );
  assert.throws(() => parsePacketProductOperationsCsv(" , "), /comma-separated subset/);
});

test("packet-product-credential issue argument parsing accepts both flag styles", () => {
  const spaced = parsePacketProductCredentialIssueArgs([
    "--workspace",
    "alpha",
    "--operations",
    "attention.list , attention.respond",
    "--display-name",
    "Desk 7",
    "--require-signature",
  ]);
  assert.deepEqual(spaced, {
    workspaceId: "alpha",
    operations: ["attention.list", "attention.respond"],
    displayName: "Desk 7",
    requirePackageSignature: true,
  });

  const assigned = parsePacketProductCredentialIssueArgs([
    "--workspace=beta",
    "--operations=deployment.inspect",
    "--subject=packetade:beta",
    "--expires-at=2026-12-31T00:00:00.000Z",
  ]);
  assert.deepEqual(assigned, {
    workspaceId: "beta",
    operations: ["deployment.inspect"],
    subjectId: "packetade:beta",
    expiresAt: "2026-12-31T00:00:00.000Z",
  });

  assert.throws(
    () => parsePacketProductCredentialIssueArgs(["--operations=attention.list"]),
    /requires --workspace/,
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
  const trust = createPacketProductTrustService({
    loadStore: () => data,
    mutateStore,
    now: () => TEST_NOW,
    generateSecret: () => TEST_SECRET,
    generateId: (kind) => `${kind}_cli_${++generatedId}`,
  });
  return { data, trust };
}

test("packet-product-credential issue rejects flags that are missing a value", () => {
  assert.throws(
    () => parsePacketProductCredentialIssueArgs(["--workspace", "alpha", "--operations"]),
    /--operations requires a value/,
  );
  assert.throws(
    () =>
      parsePacketProductCredentialIssueArgs([
        "--workspace",
        "alpha",
        "--operations",
        "--require-signature",
      ]),
    /--operations requires a value/,
  );
  assert.throws(
    () => parsePacketProductCredentialIssueArgs(["--workspace", "alpha", "--expires-at="]),
    /--expires-at requires a value/,
  );
});
