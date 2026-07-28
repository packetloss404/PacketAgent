import assert from "node:assert/strict";
import test from "node:test";
import { exportWorkspaceData } from "../jobs/export-workspace.js";
import { createSeedStore, type PacketAgentData } from "../packetagent-store.js";
import { deriveMasterKey } from "../security/vault.js";
import {
  createWorkerCredentialService,
  WorkerCredentialError,
  type WorkerCredentialServiceDeps,
} from "./credentials.js";

function fixture(): {
  data: PacketAgentData;
  service: ReturnType<typeof createWorkerCredentialService>;
} {
  const data = createSeedStore();
  let id = 0;
  let tick = 0;
  const deps: WorkerCredentialServiceDeps = {
    async mutateStore(mutator) {
      return mutator(data);
    },
    masterKey: () => deriveMasterKey("worker-credential-test"),
    generateId: () => `credential-${++id}`,
    now: () => new Date(Date.UTC(2026, 6, 27, 12, 0, tick++)).toISOString(),
  };
  return { data, service: createWorkerCredentialService(deps) };
}

test("Worker credential metadata never exposes encrypted material or secret values", async () => {
  const { data, service } = fixture();
  const metadata = await service.upsert({
    workspaceId: "alpha",
    reference: "vault:release-api",
    kind: "bearer_token",
    label: "Release API",
    value: "top-secret-token",
  });

  assert.equal(metadata.reference, "vault:release-api");
  assert.equal(metadata.encrypted, true);
  assert.equal(JSON.stringify(metadata).includes("top-secret-token"), false);
  assert.equal("ciphertext" in metadata, false);
  assert.equal("iv" in metadata, false);
  assert.equal("authTag" in metadata, false);
  assert.equal(data.workerCredentials[0].ciphertext.includes("top-secret-token"), false);

  const listed = await service.list("alpha");
  assert.deepEqual(listed, [metadata]);

  const exported = exportWorkspaceData({ workspaceId: "alpha" }, { loadStore: () => data });
  assert.deepEqual(exported.data.workerCredentials, [metadata]);
  assert.equal(JSON.stringify(exported).includes(data.workerCredentials[0].ciphertext), false);
});

test("Worker credential resolution is scoped, declared, kind checked, and usage tracked", async () => {
  const { data, service } = fixture();
  await service.upsert({
    workspaceId: "alpha",
    reference: "vault:release-api",
    kind: "api_key",
    label: "Release API",
    value: "alpha-secret",
  });
  await service.upsert({
    workspaceId: "beta",
    reference: "vault:release-api",
    kind: "api_key",
    label: "Release API",
    value: "beta-secret",
  });

  let consumed = "";
  const result = await service.use(
    {
      workspaceId: "alpha",
      reference: "vault:release-api",
      declaredCredentialRefs: ["vault:release-api"],
      expectedKinds: ["api_key", "bearer_token"],
    },
    (value, metadata) => {
      consumed = value;
      assert.equal(metadata.workspaceId, "alpha");
      assert.equal(metadata.kind, "api_key");
      return "called";
    },
  );
  assert.equal(result, "called");
  assert.equal(consumed, "alpha-secret");
  assert.ok(
    data.workerCredentials.find((record) => record.workspaceId === "alpha")?.lastResolvedAt,
  );
  assert.equal(
    data.workerCredentials.find((record) => record.workspaceId === "beta")?.lastResolvedAt,
    undefined,
  );

  await assert.rejects(
    service.use(
      {
        workspaceId: "alpha",
        reference: "vault:release-api",
        declaredCredentialRefs: [],
        expectedKinds: ["api_key"],
      },
      () => undefined,
    ),
    (error: unknown) => error instanceof WorkerCredentialError && error.code === "not_declared",
  );
  await assert.rejects(
    service.use(
      {
        workspaceId: "alpha",
        reference: "vault:release-api",
        declaredCredentialRefs: ["vault:release-api"],
        expectedKinds: ["webhook_url"],
      },
      () => undefined,
    ),
    (error: unknown) => error instanceof WorkerCredentialError && error.code === "kind_mismatch",
  );
});

test("Worker credential upsert rotates encrypted values without changing opaque identity", async () => {
  const { data, service } = fixture();
  const created = await service.upsert({
    workspaceId: "alpha",
    reference: "vault:release-api",
    kind: "opaque",
    label: "Initial",
    value: "first",
  });
  const firstCiphertext = data.workerCredentials[0].ciphertext;
  const rotated = await service.upsert({
    workspaceId: "alpha",
    reference: "vault:release-api",
    kind: "bearer_token",
    label: "Rotated",
    value: "second",
  });

  assert.equal(rotated.id, created.id);
  assert.equal(rotated.kind, "bearer_token");
  assert.equal(rotated.label, "Rotated");
  assert.notEqual(data.workerCredentials[0].ciphertext, firstCiphertext);
  assert.equal(await service.remove("alpha", "vault:release-api"), true);
  assert.equal(await service.remove("alpha", "vault:release-api"), false);
});
