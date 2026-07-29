import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decryptSecret,
  deriveMasterKey,
  encryptSecret,
  loadMasterKey,
  maskSecret,
  resetMasterKeyCacheForTests,
} from "../vault.js";

const KEY = deriveMasterKey("phase-1-test");

test("encrypt then decrypt round-trips ASCII", () => {
  const enc = encryptSecret("sk-test-1234567890", KEY);
  const out = decryptSecret(enc, KEY);
  assert.equal(out, "sk-test-1234567890");
});

test("encrypt then decrypt round-trips unicode and empty", () => {
  const enc1 = encryptSecret("héllo 世界 🚀", KEY);
  assert.equal(decryptSecret(enc1, KEY), "héllo 世界 🚀");
  const enc2 = encryptSecret("", KEY);
  assert.equal(decryptSecret(enc2, KEY), "");
});

test("tampered ciphertext throws", () => {
  const enc = encryptSecret("sk-secret", KEY);
  const tampered = { ...enc, ciphertext: Buffer.from("nope").toString("base64") };
  assert.throws(() => decryptSecret(tampered, KEY));
});

test("tampered authTag throws", () => {
  const enc = encryptSecret("sk-secret", KEY);
  const tampered = { ...enc, authTag: Buffer.alloc(16).toString("base64") };
  assert.throws(() => decryptSecret(tampered, KEY));
});

test("maskSecret reveals only last 4 chars and preserves length", () => {
  const masked = maskSecret("sk-1234567890abcd");
  assert.ok(masked.endsWith("abcd"));
  assert.equal(masked.length, "sk-1234567890abcd".length);
  assert.equal(masked.slice(0, masked.length - 4).replace(/•/g, "").length, 0);
});

test("maskSecret on empty returns empty", () => {
  assert.equal(maskSecret(""), "");
});

test("encryption uses fresh IV per call (different ciphertext)", () => {
  const a = encryptSecret("same", KEY);
  const b = encryptSecret("same", KEY);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext + a.authTag, b.ciphertext + b.authTag);
});

test("loadMasterKey requires MASTER_KEY in production", () => {
  resetMasterKeyCacheForTests();
  assert.throws(() => loadMasterKey({ NODE_ENV: "production" }), /MASTER_KEY must be set/);
});

test("loadMasterKey allows deterministic fallback outside production", () => {
  resetMasterKeyCacheForTests();
  const key = loadMasterKey({ NODE_ENV: "development" });
  assert.equal(key.length, 32);
});
