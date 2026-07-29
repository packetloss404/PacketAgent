import { test } from "node:test";
import assert from "node:assert/strict";
import { resetStoreForTests } from "../../packetagent-store.js";
import {
  listApiKeysForWorkspaceAsync,
  listApiKeysForWorkspace,
  removeApiKeyForWorkspaceAsync,
  resolveApiKeyAsync,
  removeApiKey,
  resolveApiKey,
  upsertApiKeyAsync,
  upsertApiKey,
} from "../api-key-store.js";

test("upsert + resolve round-trips", () => {
  resetStoreForTests();
  const masked = upsertApiKey({
    workspaceId: "alpha",
    provider: "anthropic",
    label: "default",
    value: "sk-anth-1",
  });
  assert.equal(masked.provider, "anthropic");
  assert.equal(masked.label, "default");
  const decrypted = resolveApiKey("alpha", "anthropic");
  assert.equal(decrypted, "sk-anth-1");
});

test("upsert replaces existing record by (workspace, provider, label)", () => {
  resetStoreForTests();
  upsertApiKey({ workspaceId: "alpha", provider: "openai", label: "x", value: "v1" });
  upsertApiKey({ workspaceId: "alpha", provider: "openai", label: "x", value: "v2" });
  const list = listApiKeysForWorkspace("alpha").filter(
    (k) => k.provider === "openai" && k.label === "x",
  );
  assert.equal(list.length, 1);
  assert.equal(resolveApiKey("alpha", "openai"), "v2");
});

test("listApiKeysForWorkspace returns masked entries only", () => {
  resetStoreForTests();
  upsertApiKey({
    workspaceId: "alpha",
    provider: "minimax",
    label: "y",
    value: "very-secret-key-value",
  });
  const list = listApiKeysForWorkspace("alpha");
  for (const k of list) {
    assert.ok(!("value" in (k as object)));
    assert.ok(!("encryptedValue" in (k as object)));
    assert.ok(
      (k as { masked: string }).masked.includes("•") ||
        (k as { masked: string }).masked.length === 0,
    );
  }
});

test("resolve updates lastUsedAt", () => {
  resetStoreForTests();
  upsertApiKey({ workspaceId: "alpha", provider: "ollama", label: "local", value: "noop" });
  const before = listApiKeysForWorkspace("alpha").find((k) => k.provider === "ollama")?.lastUsedAt;
  resolveApiKey("alpha", "ollama");
  const after = listApiKeysForWorkspace("alpha").find((k) => k.provider === "ollama")?.lastUsedAt;
  assert.equal(before, undefined);
  assert.ok(after && after.length > 0);
});

test("remove deletes the record", () => {
  resetStoreForTests();
  const created = upsertApiKey({
    workspaceId: "alpha",
    provider: "anthropic",
    label: "delete-me",
    value: "x",
  });
  removeApiKey(created.id);
  const list = listApiKeysForWorkspace("alpha").filter((k) => k.id === created.id);
  assert.equal(list.length, 0);
  assert.equal(resolveApiKey("alpha", "anthropic"), null);
});

test("resolve returns null when no key exists", () => {
  resetStoreForTests();
  assert.equal(resolveApiKey("alpha", "openai"), null);
});

test("async api key operations round-trip through async store access", async () => {
  resetStoreForTests();
  const masked = await upsertApiKeyAsync({
    workspaceId: "alpha",
    provider: "openai",
    label: "async",
    value: "sk-async",
  });

  assert.equal(await resolveApiKeyAsync("alpha", "openai"), "sk-async");
  assert.equal(
    (await listApiKeysForWorkspaceAsync("alpha")).some((entry) => entry.id === masked.id),
    true,
  );
  assert.equal(await removeApiKeyForWorkspaceAsync(masked.id, "alpha"), true);
  assert.equal(await resolveApiKeyAsync("alpha", "openai"), null);
});

test("Gemini and OpenRouter vault keys store and resolve with full parity", async () => {
  resetStoreForTests();
  await upsertApiKeyAsync({
    workspaceId: "alpha",
    provider: "gemini",
    label: "Gemini",
    value: "gemini-vault-secret",
  });
  await upsertApiKeyAsync({
    workspaceId: "alpha",
    provider: "openrouter",
    label: "OpenRouter",
    value: "openrouter-vault-secret",
  });

  assert.equal(await resolveApiKeyAsync("alpha", "gemini"), "gemini-vault-secret");
  assert.equal(await resolveApiKeyAsync("alpha", "openrouter"), "openrouter-vault-secret");
  const masked = await listApiKeysForWorkspaceAsync("alpha");
  assert.ok(masked.some((entry) => entry.provider === "gemini"));
  assert.ok(masked.some((entry) => entry.provider === "openrouter"));
  assert.equal(JSON.stringify(masked).includes("vault-secret"), false);
});
