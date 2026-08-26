import assert from "node:assert/strict";
import test from "node:test";
import { createSeedStore, type PacketAgentData } from "./packetagent-store.js";
import { createWorkerPackageRoutes } from "./worker-package-routes.js";
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
    supportedOperations: string[];
    credential: {
      id: string;
      subjectId: string;
      displayName: string;
      allowedOperations: string[];
      requirePackageSignature: boolean;
      status: string;
      expiresAt: string;
    };
    events: Record<string, string>;
    evidence: Record<string, string>;
  };

  assert.equal(body.contractSchemaVersion, "packetagent.worker-package-contract/v1");
  assert.equal(body.schemaVersion, "packetagent.worker-package/v1");
  assert.equal(body.canonicalization, "packetagent.worker-package-canonical-json/v1");
  assert.deepEqual(body.supportedOperations, [...PACKET_PRODUCT_OPERATIONS]);
  assert.equal(body.supportedOperations.includes("attention.list"), true);
  assert.equal(body.supportedOperations.includes("attention.respond"), true);

  assert.equal(body.credential.subjectId, "packetade:contract-test");
  assert.equal(body.credential.displayName, "PacketADE Desk");
  assert.deepEqual(body.credential.allowedOperations, harness.allowedOperations);
  assert.equal(body.credential.requirePackageSignature, false);
  assert.equal(body.credential.status, "active");
  assert.equal(body.credential.expiresAt, TEST_EXPIRY);

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
    ...(options.allowedOperations ?? [
      "deployment.inspect",
      "attention.list",
      "attention.respond",
    ]),
  ].sort();
  const issued = await trust.issueCredential({
    workspaceId: "alpha",
    subjectId: "packetade:contract-test",
    ...(options.displayName ? { displayName: options.displayName } : {}),
    allowedOperations: allowedOperations as PacketProductOperation[],
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
    createdBy: { type: "user", id: "user_alpha" },
  });
  return {
    data,
    token: issued.token,
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
