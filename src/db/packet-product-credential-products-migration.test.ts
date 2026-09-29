import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "./cli.js";

const MIGRATIONS_DIR = resolve(process.cwd(), "src", "db", "migrations");
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const RELAXED_MIGRATION = "0031_packet_product_credential_products.sql";
const SHA256_ZERO = `sha256:${"0".repeat(64)}`;
const TIMESTAMP = "2026-09-24T00:00:00.000Z";

test("packet_product_credentials accepts PacketChat on a fresh migration replay", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-cred-products-"));
  try {
    const dbPath = join(tempDir, "packetagent.sqlite");
    migrateDatabase({ dbPath });

    const db = new DatabaseSync(dbPath);
    try {
      db.exec("pragma foreign_keys = on");
      assert.doesNotThrow(() => insertCredential(db, "cred_chat", "PacketChat"));
      assert.doesNotThrow(() => insertCredential(db, "cred_bench", "PacketBench"));
      assert.doesNotThrow(() => insertCredential(db, "cred_ade", "PacketADE"));
      assert.throws(
        () => insertCredential(db, "cred_phone", "PacketPhone"),
        /CHECK constraint failed/,
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("upgrading a pre-PacketChat database preserves trust rows and the receipt foreign key", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "packetagent-cred-upgrade-"));
  try {
    const partialDir = join(tempDir, "partial-migrations");
    mkdirSync(partialDir);
    for (const name of ALL_MIGRATIONS) {
      if (name === RELAXED_MIGRATION) continue;
      cpSync(join(MIGRATIONS_DIR, name), join(partialDir, name));
    }

    const dbPath = join(tempDir, "packetagent.sqlite");
    const before = migrateDatabase({ dbPath, migrationsDir: partialDir });
    assert.equal(before.applied.includes(RELAXED_MIGRATION), false);

    const seeded = new DatabaseSync(dbPath);
    try {
      seeded.exec("pragma foreign_keys = on");
      insertCredential(seeded, "cred_legacy", "PacketADE");
      seeded
        .prepare(
          `insert into worker_package_receipts (
            workspace_id, id, package_id, package_version, idempotency_key,
            package_digest, request_digest, credential_id, accepted_at, payload
          ) values ('alpha', 'receipt_1', 'packetade:pkg', 1, 'idem-1', ?, ?, 'cred_legacy', ?, '{}')`,
        )
        .run(SHA256_ZERO, SHA256_ZERO, TIMESTAMP);
    } finally {
      seeded.close();
    }

    const upgraded = migrateDatabase({ dbPath });
    assert.ok(upgraded.applied.includes(RELAXED_MIGRATION));

    const db = new DatabaseSync(dbPath);
    try {
      db.exec("pragma foreign_keys = on");
      const credential = db
        .prepare("select product from packet_product_credentials where id = 'cred_legacy'")
        .get() as { product: string } | undefined;
      assert.equal(credential?.product, "PacketADE");

      const receipt = db
        .prepare("select credential_id from worker_package_receipts where id = 'receipt_1'")
        .get() as { credential_id: string } | undefined;
      assert.equal(receipt?.credential_id, "cred_legacy");

      const receiptForeignKeys = db
        .prepare("pragma foreign_key_list(worker_package_receipts)")
        .all() as Array<{ table: string }>;
      assert.ok(receiptForeignKeys.some((fk) => fk.table === "packet_product_credentials"));

      assert.doesNotThrow(() => insertCredential(db, "cred_chat", "PacketChat"));
      assert.throws(
        () => insertCredential(db, "cred_phone", "PacketPhone"),
        /CHECK constraint failed/,
      );
      assert.deepEqual(db.prepare("pragma foreign_key_check").all(), []);
    } finally {
      db.close();
    }

    const replay = migrateDatabase({ dbPath });
    assert.deepEqual(replay.applied, []);
    assert.deepEqual(replay.skipped, ALL_MIGRATIONS);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function insertCredential(db: DatabaseSync, id: string, product: string): void {
  db.prepare(
    `insert into packet_product_credentials (
      workspace_id, id, product, subject_id, status, token_digest,
      require_package_signature, expires_at, created_at, updated_at, payload
    ) values ('alpha', ?, ?, 'subject_1', 'active', ?, 0, null, ?, ?, '{}')`,
  ).run(id, product, SHA256_ZERO, TIMESTAMP, TIMESTAMP);
}
