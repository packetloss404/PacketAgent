import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createSeedStore, type PacketAgentData } from "../../packetagent-store.js";
import { createPacketProductTrustService, PacketProductTrustError } from "./trust.js";
import { workerPackageDsseEnvelope } from "./validation.js";
import type { WorkerPackage } from "./types.js";
import { validateWorkerPersistence } from "../repository.js";

const FIXTURE_URL = new URL("./fixtures/worker-package-v1.valid.json", import.meta.url);
const TIMESTAMP = "2026-07-28T18:00:00.000Z";
const ADMIN = {
  type: "user",
  id: "user_alpha",
  displayName: "Alpha",
} as const;

test("PacketADE credentials bind bearer authentication to workspace, actor, and operation", async () => {
  const harness = makeHarness();
  const issued = await harness.service.issueCredential({
    workspaceId: "alpha",
    subjectId: "packetade:flight-service",
    displayName: "PacketADE flight service",
    allowedOperations: ["package.validate", "deployment.inspect"],
    createdBy: ADMIN,
  });

  assert.equal(issued.credential.tokenConfigured, true);
  assert.equal("tokenDigest" in issued.credential, false);
  assert.match(issued.token, /^pkade\.credential_1\.[A-Za-z0-9_-]+$/);
  assert.equal(harness.data.packetProductCredentials.length, 1);
  assert.match(harness.data.packetProductCredentials[0]!.tokenDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(harness.data).includes(issued.token), false);
  assert.equal(JSON.stringify(harness.data).includes(TEST_SECRET), false);

  const authenticated = await harness.service.authenticate({
    authorization: `Bearer ${issued.token}`,
    workspaceId: "alpha",
    operation: "deployment.inspect",
  });
  assert.deepEqual(authenticated.actor, {
    type: "packet_product",
    id: "packetade:flight-service",
    displayName: "PacketADE flight service",
    product: "PacketADE",
  });
  assert.equal(authenticated.workspaceId, "alpha");

  await assertTrustError(
    () =>
      harness.service.authenticate({
        authorization: `Bearer ${issued.token}`,
        workspaceId: "beta",
        operation: "deployment.inspect",
      }),
    "unauthorized",
  );
  await assertTrustError(
    () =>
      harness.service.authorizeWrite({
        authorization: `Bearer ${issued.token}`,
        workspaceId: "alpha",
        operation: "deployment.pause",
      }),
    "forbidden",
  );
  assert.ok(
    harness.data.activities.some(
      (activity) =>
        activity.event === "packet_product.write_denied" &&
        activity.actor.type === "packet_product" &&
        activity.actor.id === "packetade:flight-service",
    ),
  );

  await harness.service.revokeCredential({
    workspaceId: "alpha",
    credentialId: issued.credential.id,
    revokedBy: ADMIN,
  });
  await assertTrustError(
    () =>
      harness.service.authenticate({
        authorization: `Bearer ${issued.token}`,
        workspaceId: "alpha",
        operation: "deployment.inspect",
      }),
    "unauthorized",
  );
});

test("acceptPackage durably records integrity, provenance, local policy, and idempotency", async () => {
  const harness = makeHarness();
  const issued = await issueValidationCredential(harness);
  const workerPackage = await readFixture();

  const accepted = await harness.service.acceptPackage({
    authorization: `Bearer ${issued.token}`,
    workspaceId: "alpha",
    workerPackage,
    acceptedCapabilityIds: ["release-read"],
    capabilityGrants: [
      {
        capabilityId: "release-read",
        verbs: ["GET"],
        resources: ["https://releases.example.test/stable"],
        approval: "never",
      },
    ],
  });

  assert.equal(accepted.replayed, false);
  assert.equal(harness.data.workerPackageReceipts.length, 1);
  assert.equal(harness.data.workerDeployments.length, 0);
  assert.equal(accepted.receipt.packageId, "packetade:flight-42:release-watcher");
  assert.equal(accepted.receipt.packageVersion, 1);
  assert.equal(accepted.receipt.integrity.digestVerified, true);
  assert.equal(accepted.receipt.integrity.verifiedSignatures, 0);
  assert.equal(accepted.receipt.source.flightId, "flight-42");
  assert.equal(accepted.receipt.authenticatedActor.id, "packetade:flight-service");
  assert.deepEqual(accepted.receipt.capabilityDecision.acceptedCapabilityIds, ["release-read"]);
  assert.deepEqual(accepted.receipt.capabilityDecision.grants[0]!.resources, [
    "https://releases.example.test/stable",
  ]);

  const replay = await harness.service.acceptPackage({
    authorization: `Bearer ${issued.token}`,
    workspaceId: "alpha",
    workerPackage,
    acceptedCapabilityIds: ["release-read"],
    capabilityGrants: [
      {
        capabilityId: "release-read",
        verbs: ["GET"],
        resources: ["https://releases.example.test/stable"],
        approval: "never",
      },
    ],
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.receipt.id, accepted.receipt.id);
  assert.equal(harness.data.workerPackageReceipts.length, 1);

  await assertTrustError(
    () =>
      harness.service.acceptPackage({
        authorization: `Bearer ${issued.token}`,
        workspaceId: "alpha",
        workerPackage,
        acceptedCapabilityIds: [],
      }),
    "idempotency_mismatch",
  );
  assert.equal(JSON.stringify(harness.data).includes(issued.token), false);
  assert.equal(JSON.stringify(harness.data).includes(TEST_SECRET), false);
  assert.ok(
    harness.data.activities.every(
      (activity) =>
        !JSON.stringify(activity).includes(issued.token) &&
        !JSON.stringify(activity).includes(TEST_SECRET),
    ),
  );
  assert.doesNotThrow(() => validateWorkerPersistence(harness.data));

  const withoutCredential = structuredClone(harness.data);
  withoutCredential.packetProductCredentials = [];
  assert.throws(
    () => validateWorkerPersistence(withoutCredential),
    /missing Packet-product credential/i,
  );

  const changedPolicy = structuredClone(harness.data);
  const originalReceipt = changedPolicy.workerPackageReceipts[0]!;
  changedPolicy.workerPackageReceipts[0] = {
    ...originalReceipt,
    capabilityDecision: {
      ...originalReceipt.capabilityDecision,
      compiledPolicy: {
        ...originalReceipt.capabilityDecision.compiledPolicy,
        policyDigest: `sha256:${"0".repeat(64)}`,
      },
    },
  };
  assert.throws(
    () => validateWorkerPersistence(changedPolicy),
    /compiled policy digest is invalid/i,
  );
});

test("local policy cannot broaden the package capability upper bound", async () => {
  const harness = makeHarness();
  const issued = await issueValidationCredential(harness);
  const workerPackage = await readFixture();

  await assertTrustError(
    () =>
      harness.service.acceptPackage({
        authorization: `Bearer ${issued.token}`,
        workspaceId: "alpha",
        workerPackage,
        acceptedCapabilityIds: ["release-read"],
        capabilityGrants: [
          {
            capabilityId: "release-read",
            verbs: ["POST"],
            resources: ["https://releases.example.test/*"],
            approval: "never",
          },
        ],
      }),
    "capability_rejected",
  );
  await assertTrustError(
    () =>
      harness.service.acceptPackage({
        authorization: `Bearer ${issued.token}`,
        workspaceId: "alpha",
        workerPackage,
        acceptedCapabilityIds: ["not-in-package"],
      }),
    "capability_rejected",
  );
  assert.equal(harness.data.workerPackageReceipts.length, 0);
  assert.equal(
    harness.data.activities.filter((activity) => activity.event === "worker_package.rejected")
      .length,
    2,
  );
});

test("required package signatures are enforced by the credential trust policy", async () => {
  const harness = makeHarness({ signatureVerifier: () => true });
  const issued = await issueValidationCredential(harness, true);
  const unsigned = await readFixture();

  await assertTrustError(
    () =>
      harness.service.acceptPackage({
        authorization: `Bearer ${issued.token}`,
        workspaceId: "alpha",
        workerPackage: unsigned,
        acceptedCapabilityIds: ["release-read"],
      }),
    "invalid_package",
  );

  const signed: WorkerPackage = {
    ...unsigned,
    integrity: {
      ...unsigned.integrity,
      dsseEnvelope: workerPackageDsseEnvelope(unsigned, [
        {
          keyid: "packetade:test-key",
          sig: Buffer.from("fixture-signature").toString("base64"),
        },
      ]),
    },
  };
  const accepted = await harness.service.acceptPackage({
    authorization: `Bearer ${issued.token}`,
    workspaceId: "alpha",
    workerPackage: signed,
    acceptedCapabilityIds: ["release-read"],
  });
  assert.equal(accepted.receipt.integrity.signatureRequired, true);
  assert.equal(accepted.receipt.integrity.verifiedSignatures, 1);
});

test("authorized writes use durable per-credential rate buckets and audit rejections", async () => {
  const harness = makeHarness({ maxAttempts: 1 });
  const issued = await issueValidationCredential(harness);
  const input = {
    authorization: `Bearer ${issued.token}`,
    workspaceId: "alpha",
    operation: "package.validate" as const,
  };

  await harness.service.authorizeWrite(input);
  const error = await assertTrustError(() => harness.service.authorizeWrite(input), "rate_limited");
  assert.equal(error.status, 429);
  assert.equal(error.options.retryAt, "2026-07-28T18:01:00.000Z");
  assert.equal(harness.data.rateLimits?.[0]?.count, 2);
  assert.ok(
    harness.data.activities.some(
      (activity) => activity.event === "packet_product.write_rate_limited",
    ),
  );
});

const TEST_SECRET = "a".repeat(43);

function makeHarness(
  options: {
    readonly maxAttempts?: number;
    readonly signatureVerifier?: () => boolean;
  } = {},
) {
  const data = createSeedStore();
  let credentialSequence = 0;
  let receiptSequence = 0;
  let activitySequence = 0;
  const service = createPacketProductTrustService({
    loadStore: () => data,
    mutateStore: (mutation) => mutation(data),
    now: () => TIMESTAMP,
    generateSecret: () => TEST_SECRET,
    generateId: (kind) => {
      if (kind === "credential") return `credential_${++credentialSequence}`;
      if (kind === "receipt") return `receipt_${++receiptSequence}`;
      return `activity_trust_${++activitySequence}`;
    },
    verifySignature: options.signatureVerifier,
    writeRateLimit:
      options.maxAttempts === undefined
        ? undefined
        : { maxAttempts: options.maxAttempts, windowMs: 60_000, maxBuckets: 10 },
  });
  return { data, service };
}

async function issueValidationCredential(
  harness: ReturnType<typeof makeHarness>,
  requirePackageSignature = false,
) {
  return harness.service.issueCredential({
    workspaceId: "alpha",
    subjectId: "packetade:flight-service",
    allowedOperations: ["package.validate"],
    requirePackageSignature,
    createdBy: ADMIN,
  });
}

async function readFixture(): Promise<WorkerPackage> {
  return JSON.parse(await readFile(FIXTURE_URL, "utf8")) as WorkerPackage;
}

async function assertTrustError(
  action: () => Promise<unknown>,
  code: PacketProductTrustError["code"],
): Promise<PacketProductTrustError> {
  try {
    await action();
    assert.fail(`Expected PacketProductTrustError ${code}.`);
  } catch (error) {
    assert.ok(error instanceof PacketProductTrustError);
    assert.equal(error.code, code);
    return error;
  }
}
