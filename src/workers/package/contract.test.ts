import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  canonicalWorkerPackageBytes,
  canonicalWorkerPackageJson,
  computeWorkerPackageDigest,
  workerPackageDssePreAuthenticationEncoding,
} from "./canonical.js";
import { WORKER_PACKAGE_DSSE_PAYLOAD_TYPE, type WorkerPackage } from "./types.js";
import {
  sealWorkerPackage,
  validateWorkerPackage,
  verifyWorkerPackage,
  workerPackageDsseEnvelope,
} from "./validation.js";

const VALID_FIXTURE_URL = new URL("./fixtures/worker-package-v1.valid.json", import.meta.url);
const UNSUPPORTED_FIXTURE_URL = new URL(
  "./fixtures/worker-package-v2.unsupported.json",
  import.meta.url,
);
const EXPECTED_FIXTURE_DIGEST =
  "sha256:fcea4fc3eb7cf0598c8d2312b1374bddd1a07c953380bd7a15792e35422e143d";

test("WorkerPackage v1 fixture is strict, digest-bound, and reproducible", async () => {
  const fixture = await readFixture(VALID_FIXTURE_URL);
  const validation = validateWorkerPackage(fixture);

  assert.equal(validation.ok, true);
  assert.equal(
    computeWorkerPackageDigest(fixture as unknown as WorkerPackage),
    EXPECTED_FIXTURE_DIGEST,
  );
  assert.equal((fixture.integrity as { digest: string }).digest, EXPECTED_FIXTURE_DIGEST);

  const { integrity, ...rest } = fixture;
  const reordered = {
    integrity,
    ...Object.fromEntries(Object.entries(rest).reverse()),
  };
  assert.equal(computeWorkerPackageDigest(reordered as WorkerPackage), EXPECTED_FIXTURE_DIGEST);

  const sealed = sealWorkerPackage(rest as Omit<WorkerPackage, "integrity">);
  assert.equal(sealed.integrity.digest, EXPECTED_FIXTURE_DIGEST);
});

test("canonical package JSON uses deterministic code-unit ordering and strict I-JSON values", () => {
  assert.equal(
    canonicalWorkerPackageJson({
      "\u20ac": "Euro Sign",
      "\r": "Carriage Return",
      "\ufb33": "Hebrew Letter Dalet With Dagesh",
      1: "One",
      "\ud83d\ude00": "Emoji: Grinning Face",
      "\u0080": "Control",
      "\u00f6": "Latin Small Letter O With Diaeresis",
    }),
    '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
  );
  assert.throws(() => canonicalWorkerPackageJson({ missing: undefined }), /must not be undefined/i);
  assert.throws(
    () => canonicalWorkerPackageJson({ amount: Number.POSITIVE_INFINITY }),
    /finite JSON numbers/i,
  );
  assert.throws(
    () => canonicalWorkerPackageJson({ invalid: "\ud800" }),
    /unpaired Unicode surrogate/i,
  );
});

test("unknown WorkerPackage major versions and unexpected secret fields fail closed", async () => {
  const unsupported = await readFixture(UNSUPPORTED_FIXTURE_URL);
  const unsupportedResult = validateWorkerPackage(unsupported);
  assert.equal(unsupportedResult.ok, false);
  if (unsupportedResult.ok) assert.fail("unsupported fixture unexpectedly validated");
  assert.ok(
    unsupportedResult.issues.some(
      (entry) =>
        entry.path === "$.schemaVersion" && entry.code === "package.schema_version.unsupported",
    ),
  );

  const valid = await readFixture(VALID_FIXTURE_URL);
  (
    ((valid.worker as Record<string, unknown>).content as Record<string, unknown>)
      .execution as Record<string, unknown>
  ).apiKey = "must-never-cross-the-package-boundary";
  const secretResult = validateWorkerPackage(valid);
  assert.equal(secretResult.ok, false);
  if (secretResult.ok) assert.fail("package with an unexpected secret field validated");
  assert.ok(
    secretResult.issues.some(
      (entry) =>
        entry.path === "$.worker.content.execution.apiKey" &&
        entry.code === "package.unexpected_field",
    ),
  );
});

test("WorkerPackage rejects changed content and missing canonical Worker bounds", async () => {
  const changed = await readFixture(VALID_FIXTURE_URL);
  (changed.worker as { content: { objective: string } }).content.objective = "A changed objective.";
  const changedResult = validateWorkerPackage(changed);
  assert.equal(changedResult.ok, false);
  if (changedResult.ok) assert.fail("changed package unexpectedly validated");
  assert.ok(
    changedResult.issues.some((entry) => entry.code === "package.integrity.digest_mismatch"),
  );

  const unbounded = await readFixture(VALID_FIXTURE_URL);
  delete (
    ((unbounded.worker as Record<string, unknown>).content as Record<string, unknown>)
      .policy as Record<string, unknown>
  ).budgets;
  const unboundedResult = validateWorkerPackage(unbounded);
  assert.equal(unboundedResult.ok, false);
  if (unboundedResult.ok) assert.fail("unbounded package unexpectedly validated");
  assert.ok(
    unboundedResult.issues.some((entry) => entry.path === "$.worker.content.policy.budgets"),
  );
});

test("DSSE payload binding and required signature verification use the exact canonical bytes", async () => {
  const fixture = (await readFixture(VALID_FIXTURE_URL)) as unknown as WorkerPackage;
  const envelope = workerPackageDsseEnvelope(fixture, [
    {
      keyid: "packetade:test-key",
      sig: Buffer.from("test-signature").toString("base64"),
    },
  ]);
  const signed: WorkerPackage = {
    ...fixture,
    integrity: {
      ...fixture.integrity,
      dsseEnvelope: envelope,
    },
  };
  assert.equal(validateWorkerPackage(signed).ok, true);

  const verified = await verifyWorkerPackage(signed, {
    requireSignature: true,
    verifySignature: (input) => {
      assert.equal(input.keyid, "packetade:test-key");
      assert.equal(input.payloadType, WORKER_PACKAGE_DSSE_PAYLOAD_TYPE);
      assert.deepEqual(input.payload, canonicalWorkerPackageBytes(signed));
      assert.deepEqual(
        input.preAuthenticationEncoding,
        workerPackageDssePreAuthenticationEncoding(signed),
      );
      assert.match(
        Buffer.from(input.preAuthenticationEncoding).toString("utf8"),
        /^DSSEv1 \d+ application\/vnd\.packetagent\.worker-package\.v1\+json \d+ /,
      );
      return true;
    },
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.verifiedSignatures, 1);

  const rejected = await verifyWorkerPackage(signed, {
    requireSignature: true,
    verifySignature: () => false,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.verifiedSignatures, 0);
  if (rejected.ok) assert.fail("untrusted signature unexpectedly verified");
  assert.ok(rejected.issues.some((entry) => entry.code === "package.signature.untrusted"));

  const unsigned = await verifyWorkerPackage(fixture, { requireSignature: true });
  assert.equal(unsigned.ok, false);
  if (unsigned.ok) assert.fail("unsigned package unexpectedly met required policy");
  assert.ok(unsigned.issues.some((entry) => entry.code === "package.signature.required"));
});

test("a DSSE envelope cannot substitute different package bytes", async () => {
  const fixture = (await readFixture(VALID_FIXTURE_URL)) as unknown as WorkerPackage;
  const envelope = workerPackageDsseEnvelope(fixture, [
    { sig: Buffer.from("test-signature").toString("base64url") },
  ]);
  const changedEnvelope = {
    ...envelope,
    payload: Buffer.from("different package").toString("base64"),
  };
  const result = validateWorkerPackage({
    ...fixture,
    integrity: {
      ...fixture.integrity,
      dsseEnvelope: changedEnvelope,
    },
  });
  assert.equal(result.ok, false);
  if (result.ok) assert.fail("mismatched DSSE payload unexpectedly validated");
  assert.ok(result.issues.some((entry) => entry.code === "package.signature.payload_mismatch"));
});

async function readFixture(url: URL): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(url, "utf8")) as Record<string, unknown>;
}
