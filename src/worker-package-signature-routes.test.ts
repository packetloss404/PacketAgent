import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createSeedStore, type PacketAgentData } from "./packetagent-store.js";
import { createWorkerPackageRoutes } from "./worker-package-routes.js";
import { createWorkerActivationRepository } from "./workers/activation-repository.js";
import { createWorkerActivationService } from "./workers/activation.js";
import { createWorkerControlService } from "./workers/control-service.js";
import { createWorkerOperationsReadModel } from "./workers/observability/read-model.js";
import { createPacketProductDeploymentService } from "./workers/package/deployment.js";
import {
  attachWorkerPackageEd25519Envelope,
  createPacketProductSigningKeyService,
} from "./workers/package/signing-keys.js";
import { createPacketProductTrustService } from "./workers/package/trust.js";
import type { WorkerPackage } from "./workers/package/types.js";
import { sealWorkerPackage } from "./workers/package/validation.js";
import { createWorkerRepository } from "./workers/repository.js";
import { createWorkerLifecycleService } from "./workers/service.js";

const FIXTURE_URL = new URL(
  "./workers/package/fixtures/packetbench-worker-package-v1.valid.json",
  import.meta.url,
);
const TEST_SECRET = "s".repeat(43);
const ADMIN = { type: "user", id: "user_alpha" } as const;

interface ErrorBody {
  code: string;
  issues?: Array<{ path: string; code: string }>;
}

interface AcceptedBody {
  dryRun: boolean;
  replayed: boolean;
  receipt: {
    id: string;
    integrity: { signatureRequired: boolean; verifiedSignatures: number };
  };
  deployment?: { id: string; status: string };
}

test("a require-signature credential accepts an Ed25519 DSSE envelope through the production verifier", async () => {
  const harness = await createHarness();
  const signer = generateKeyPairSync("ed25519");
  await harness.signingKeys.register({
    workspaceId: "alpha",
    keyid: "packetbench:build-signer",
    publicKey: signer.publicKey.export({ type: "spki", format: "pem" }) as string,
    createdBy: ADMIN,
  });
  const signed = attachWorkerPackageEd25519Envelope(harness.v1, [
    { keyid: "packetbench:build-signer", privateKey: signer.privateKey },
  ]);

  const validated = await submit(harness, "POST", "/worker-packages/validate", signed);
  assert.equal(validated.status, 200);
  const validatedBody = (await validated.json()) as AcceptedBody;
  assert.equal(validatedBody.dryRun, true);
  assert.equal(validatedBody.receipt.integrity.signatureRequired, true);
  assert.equal(validatedBody.receipt.integrity.verifiedSignatures, 1);

  const deployed = await submit(harness, "POST", "/worker-deployments", signed);
  assert.equal(deployed.status, 201);
  const deployedBody = (await deployed.json()) as AcceptedBody;
  assert.equal(deployedBody.receipt.id, validatedBody.receipt.id);
  assert.equal(deployedBody.receipt.integrity.verifiedSignatures, 1);
  assert.equal(deployedBody.deployment?.status, "deployed");
  assert.equal(harness.data.workerPackageReceipts[0]?.integrity.verifiedSignatures, 1);
  assert.ok(
    harness.data.activities.some(
      (activity) =>
        activity.event === "worker_package.accepted" && activity.data?.verifiedSignatures === 1,
    ),
  );

  const serialized = JSON.stringify(harness.data);
  assert.equal(serialized.includes("PRIVATE KEY"), false);
  assert.equal(
    serialized.includes(
      signer.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    ),
    false,
  );
});

test("a require-signature credential rejects unsigned, unknown, revoked, cross-workspace, and tampered envelopes", async () => {
  const harness = await createHarness();
  const alphaSigner = generateKeyPairSync("ed25519");
  const betaSigner = generateKeyPairSync("ed25519");
  const revokedSigner = generateKeyPairSync("ed25519");
  await harness.signingKeys.register({
    workspaceId: "alpha",
    keyid: "packetbench:alpha-signer",
    publicKey: alphaSigner.publicKey.export({ type: "spki", format: "pem" }) as string,
    createdBy: ADMIN,
  });
  await harness.signingKeys.register({
    workspaceId: "beta",
    keyid: "packetbench:beta-signer",
    publicKey: betaSigner.publicKey.export({ type: "spki", format: "pem" }) as string,
    createdBy: ADMIN,
  });
  await harness.signingKeys.register({
    workspaceId: "alpha",
    keyid: "packetbench:retired-signer",
    publicKey: revokedSigner.publicKey.export({ type: "spki", format: "pem" }) as string,
    createdBy: ADMIN,
  });
  await harness.signingKeys.revoke({
    workspaceId: "alpha",
    keyid: "packetbench:retired-signer",
    revokedBy: ADMIN,
  });

  const unsigned = await submit(harness, "POST", "/worker-packages/validate", harness.v1);
  await assertRejected(unsigned, "package.signature.required", "$.integrity.dsseEnvelope");

  const unknownKey = await submit(
    harness,
    "POST",
    "/worker-packages/validate",
    attachWorkerPackageEd25519Envelope(harness.v1, [
      { keyid: "packetbench:never-registered", privateKey: alphaSigner.privateKey },
    ]),
  );
  await assertRejected(unknownKey, "package.signature.untrusted");

  const wrongWorkspace = await submit(
    harness,
    "POST",
    "/worker-packages/validate",
    attachWorkerPackageEd25519Envelope(harness.v1, [
      { keyid: "packetbench:beta-signer", privateKey: betaSigner.privateKey },
    ]),
  );
  await assertRejected(wrongWorkspace, "package.signature.untrusted");

  const revoked = await submit(
    harness,
    "POST",
    "/worker-packages/validate",
    attachWorkerPackageEd25519Envelope(harness.v1, [
      { keyid: "packetbench:retired-signer", privateKey: revokedSigner.privateKey },
    ]),
  );
  await assertRejected(revoked, "package.signature.untrusted");

  const wrongPrivateKey = await submit(
    harness,
    "POST",
    "/worker-packages/validate",
    attachWorkerPackageEd25519Envelope(harness.v1, [
      { keyid: "packetbench:alpha-signer", privateKey: betaSigner.privateKey },
    ]),
  );
  await assertRejected(wrongPrivateKey, "package.signature.untrusted");

  // Content changed after signing but resealed: digest is valid, the DSSE
  // payload no longer matches the canonical subject bytes.
  const signedOriginal = attachWorkerPackageEd25519Envelope(harness.v1, [
    { keyid: "packetbench:alpha-signer", privateKey: alphaSigner.privateKey },
  ]);
  const { integrity: _integrity, ...subject } = harness.v1;
  const resealed = sealWorkerPackage({
    ...subject,
    worker: {
      ...subject.worker,
      content: { ...subject.worker.content, instructions: "Tampered after signing." },
    },
  });
  const tamperedPayload = await submit(harness, "POST", "/worker-packages/validate", {
    ...resealed,
    integrity: { ...resealed.integrity, dsseEnvelope: signedOriginal.integrity.dsseEnvelope },
  });
  await assertRejected(tamperedPayload, "package.signature.payload_mismatch");

  // Same bytes, corrupted signature.
  const [signature] = signedOriginal.integrity.dsseEnvelope!.signatures;
  const corrupted = Buffer.from(signature!.sig, "base64");
  corrupted[10] = corrupted[10]! ^ 0xff;
  const badSignature = await submit(harness, "POST", "/worker-packages/validate", {
    ...signedOriginal,
    integrity: {
      ...signedOriginal.integrity,
      dsseEnvelope: {
        ...signedOriginal.integrity.dsseEnvelope!,
        signatures: [{ keyid: signature!.keyid, sig: corrupted.toString("base64") }],
      },
    },
  });
  await assertRejected(badSignature, "package.signature.untrusted");

  // Deploy is guarded by the same policy.
  const deployUnsigned = await submit(harness, "POST", "/worker-deployments", harness.v1);
  await assertRejected(deployUnsigned, "package.signature.required");

  assert.equal(harness.data.workerPackageReceipts.length, 0);
  assert.equal(harness.data.workerDeployments.length, 0);
  const rejections = harness.data.activities.filter(
    (activity) => activity.event === "worker_package.rejected",
  );
  assert.equal(rejections.length, 8);
  assert.equal(
    rejections.some(
      (activity) => activity.data?.firstIssueCode === "package.signature.verifier_required",
    ),
    false,
  );

  // The same signed package is accepted once the matching key is used.
  const accepted = await submit(harness, "POST", "/worker-packages/validate", signedOriginal);
  assert.equal(accepted.status, 200);
  assert.equal(((await accepted.json()) as AcceptedBody).receipt.integrity.verifiedSignatures, 1);
});

test("credentials without a signature requirement still record verified signatures when keys match", async () => {
  const harness = await createHarness({ requirePackageSignature: false });
  const signer = generateKeyPairSync("ed25519");
  await harness.signingKeys.register({
    workspaceId: "alpha",
    keyid: "packetbench:optional",
    publicKey: signer.publicKey.export({ type: "spki", format: "pem" }) as string,
    createdBy: ADMIN,
  });

  const unsigned = await submit(harness, "POST", "/worker-packages/validate", harness.v1);
  assert.equal(unsigned.status, 200);
  const unsignedBody = (await unsigned.json()) as AcceptedBody;
  assert.equal(unsignedBody.receipt.integrity.signatureRequired, false);
  assert.equal(unsignedBody.receipt.integrity.verifiedSignatures, 0);

  const signedV2 = attachWorkerPackageEd25519Envelope(
    packageVersion(harness.v1, 2, "Signed optional version."),
    [
      { keyid: "packetbench:optional", privateKey: signer.privateKey },
      { keyid: "packetbench:unknown", privateKey: signer.privateKey },
    ],
  );
  const signed = await submit(harness, "POST", "/worker-packages/validate", signedV2);
  assert.equal(signed.status, 200);
  const signedBody = (await signed.json()) as AcceptedBody;
  assert.equal(signedBody.receipt.integrity.signatureRequired, false);
  assert.equal(signedBody.receipt.integrity.verifiedSignatures, 1);
});

async function assertRejected(response: Response, issueCode: string, path?: string) {
  assert.equal(response.status, 400);
  const body = (await response.json()) as ErrorBody;
  assert.equal(body.code, "invalid_package");
  assert.ok(
    body.issues?.some(
      (issue) => issue.code === issueCode && (path === undefined || issue.path === path),
    ),
    `expected issue ${issueCode}, got ${JSON.stringify(body.issues)}`,
  );
  assert.equal(
    body.issues?.some((issue) => issue.code === "package.signature.verifier_required"),
    false,
  );
}

async function createHarness(options: { readonly requirePackageSignature?: boolean } = {}) {
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
  let tick = 0;
  let generatedId = 0;
  const nowDate = () => new Date(Date.UTC(2026, 8, 3, 10, 0, tick++));
  const nowString = () => nowDate().toISOString();
  const repository = createWorkerRepository({ loadStore: () => data, mutateStore });
  const lifecycle = createWorkerLifecycleService({
    repository,
    now: nowDate,
    id: (kind) => `${kind}_signature_route_${++generatedId}`,
  });
  const activationRepository = createWorkerActivationRepository({
    loadStore: () => data,
    mutateStore,
  });
  const activation = createWorkerActivationService({
    repository: activationRepository,
    now: nowDate,
    id: (kind) => `${kind}_signature_route_${++generatedId}`,
  });
  const control = createWorkerControlService({
    mutateStore,
    now: nowDate,
    id: (kind) => `${kind}_signature_route_${++generatedId}`,
  });
  // No verifier is injected: the trust service must fall back to the
  // store-backed signing-key registry exactly as the production graph does.
  const trust = createPacketProductTrustService({
    loadStore: () => data,
    mutateStore,
    now: nowString,
    generateSecret: () => TEST_SECRET,
    generateId: (kind) => `${kind}_signature_route_${++generatedId}`,
  });
  const signingKeys = createPacketProductSigningKeyService({
    loadStore: () => data,
    mutateStore,
    now: nowString,
    generateId: () => `activity_signature_route_${++generatedId}`,
  });
  const issued = await trust.issueCredential({
    workspaceId: "alpha",
    subjectId: "packetbench:signature-route-test",
    allowedOperations: ["package.validate", "package.deploy", "deployment.inspect"],
    requirePackageSignature: options.requirePackageSignature ?? true,
    createdBy: ADMIN,
  });
  const service = createPacketProductDeploymentService({
    trust,
    lifecycle,
    activation,
    control,
    readModel: createWorkerOperationsReadModel({ loadStore: () => data }),
    loadStore: () => data,
    mutateStore,
    now: nowString,
  });
  const v1 = JSON.parse(await readFile(FIXTURE_URL, "utf8")) as WorkerPackage;
  return {
    data,
    token: issued.token,
    v1,
    signingKeys,
    routes: createWorkerPackageRoutes({ service, trust, loadStore: () => data }),
  };
}

function submit(
  harness: Awaited<ReturnType<typeof createHarness>>,
  method: "POST",
  path: string,
  workerPackage: WorkerPackage,
) {
  return Promise.resolve(
    harness.routes.request(path, {
      method,
      headers: {
        authorization: `Bearer ${harness.token}`,
        "packetagent-workspace-id": "alpha",
        "content-type": "application/json",
        "idempotency-key": workerPackage.idempotencyKey,
      },
      body: JSON.stringify({
        workerPackage,
        acceptedCapabilityIds: ["release-read"],
      }),
    }),
  );
}

function packageVersion(
  workerPackage: WorkerPackage,
  packageVersionNumber: number,
  instructions: string,
): WorkerPackage {
  const { integrity: _integrity, ...subject } = workerPackage;
  return sealWorkerPackage({
    ...subject,
    packageVersion: packageVersionNumber,
    idempotencyKey: `${workerPackage.packageId}:v${packageVersionNumber}`,
    worker: {
      ...workerPackage.worker,
      content: { ...workerPackage.worker.content, instructions },
    },
  });
}
