import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  compareManagedPostgresStores,
  managedPostgresStoreStats,
  STORE_COMPARISON_COLLECTIONS,
} from "../../db/cli.js";
import {
  createSeedStore,
  loadSqliteAppData,
  normalizeStore,
  persistSqliteAppData,
} from "../../packetagent-store.js";
import { validateWorkerPersistence } from "../repository.js";
import {
  attachWorkerPackageEd25519Envelope,
  createPacketProductSigningKeyService,
  createStoreSignatureVerifier,
} from "./signing-keys.js";
import type { WorkerPackage } from "./types.js";
import { verifyWorkerPackage } from "./validation.js";

const FIXTURE_URL = new URL("./fixtures/packetbench-worker-package-v1.valid.json", import.meta.url);
const ADMIN = { type: "user", id: "user_alpha" } as const;

test("signing-key records round-trip through JSON normalization, SQLite app_records, and managed-Postgres comparison", async () => {
  assert.deepEqual(normalizeStore({}).packetProductSigningKeys, []);
  assert.ok(
    (STORE_COMPARISON_COLLECTIONS as readonly string[]).includes("packetProductSigningKeys"),
  );

  const data = createSeedStore();
  const service = createPacketProductSigningKeyService({
    loadStore: () => data,
    mutateStore: (mutation) => mutation(data),
    now: () => "2026-09-03T12:00:00.000Z",
    generateId: () => "activity_signing_parity",
  });
  const active = generateKeyPairSync("ed25519");
  const retired = generateKeyPairSync("ed25519");
  await service.register({
    workspaceId: "alpha",
    keyid: "packetbench:parity-active",
    publicKey: active.publicKey.export({ type: "spki", format: "pem" }) as string,
    description: "parity",
    createdBy: ADMIN,
  });
  await service.register({
    workspaceId: "alpha",
    keyid: "packetbench:parity-retired",
    publicKey: retired.publicKey.export({ type: "spki", format: "pem" }) as string,
    createdBy: ADMIN,
  });
  await service.revoke({
    workspaceId: "alpha",
    keyid: "packetbench:parity-retired",
    revokedBy: ADMIN,
  });
  validateWorkerPersistence(data);

  const directory = mkdtempSync(join(tmpdir(), "packetagent-signing-key-parity-"));
  try {
    const dbPath = join(directory, "packetagent.sqlite");
    persistSqliteAppData(dbPath, data);
    const loaded = loadSqliteAppData(dbPath);
    assert.ok(loaded);
    validateWorkerPersistence(loaded);
    assert.deepEqual(
      [...(loaded.packetProductSigningKeys ?? [])].sort((left, right) =>
        left.keyid.localeCompare(right.keyid),
      ),
      [...(data.packetProductSigningKeys ?? [])].sort((left, right) =>
        left.keyid.localeCompare(right.keyid),
      ),
    );

    const stats = managedPostgresStoreStats(loaded);
    assert.equal(stats.collections.packetProductSigningKeys, 2);
    const comparison = compareManagedPostgresStores(data, loaded);
    assert.equal(comparison.sourceOnly, 0);
    assert.equal(comparison.targetOnly, 0);
    assert.equal(comparison.contentDrift, 0);

    // The reloaded registry verifies exactly like the in-memory one.
    const fixture = JSON.parse(await readFile(FIXTURE_URL, "utf8")) as WorkerPackage;
    const signed = attachWorkerPackageEd25519Envelope(fixture, [
      { keyid: "packetbench:parity-active", privateKey: active.privateKey },
      { keyid: "packetbench:parity-retired", privateKey: retired.privateKey },
    ]);
    const verify = createStoreSignatureVerifier({ loadStore: () => loaded });
    const verification = await verifyWorkerPackage(signed, {
      requireSignature: true,
      verifySignature: (input) => verify({ ...input, workspaceId: "alpha" }),
    });
    assert.equal(verification.ok, true);
    assert.equal(verification.verifiedSignatures, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
