import { randomUUID } from "node:crypto";
import {
  loadStoreAsync,
  mutateStore,
  mutateStoreAsync,
  type ApiKeyProvider,
  type ApiKeyRecord,
} from "../packetagent-store.js";
import { decryptSecret, encryptSecret, loadMasterKey, maskSecret } from "./vault.js";

export interface MaskedApiKey {
  id: string;
  workspaceId: string;
  provider: ApiKeyProvider;
  label: string;
  masked: string;
  lastUsedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertApiKeyInput {
  workspaceId: string;
  provider: ApiKeyProvider;
  label: string;
  value: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function maskedView(record: ApiKeyRecord): MaskedApiKey {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    provider: record.provider,
    label: record.label,
    masked: maskSecret(record.encryptedValue.slice(-12)),
    ...(record.lastUsedAt ? { lastUsedAt: record.lastUsedAt } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function listApiKeysForWorkspace(workspaceId: string): MaskedApiKey[] {
  return mutateStore((data) => {
    return data.apiKeys
      .filter((k) => k.workspaceId === workspaceId)
      .map(maskedView);
  });
}

export async function listApiKeysForWorkspaceAsync(workspaceId: string): Promise<MaskedApiKey[]> {
  const data = await loadStoreAsync();
  return data.apiKeys
    .filter((k) => k.workspaceId === workspaceId)
    .map(maskedView);
}

export function upsertApiKey(input: UpsertApiKeyInput): MaskedApiKey {
  if (!input.value || input.value.length === 0) throw new Error("api-key-store: value is required");
  const masterKey = loadMasterKey();
  const encrypted = encryptSecret(input.value, masterKey);
  const ts = nowIso();
  return mutateStore((data) => {
    const existing = data.apiKeys.find(
      (k) => k.workspaceId === input.workspaceId && k.provider === input.provider && k.label === input.label,
    );
    if (existing) {
      existing.encryptedValue = encrypted.ciphertext;
      existing.iv = encrypted.iv;
      existing.authTag = encrypted.authTag;
      existing.updatedAt = ts;
      return maskedView(existing);
    }
    const record: ApiKeyRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      provider: input.provider,
      label: input.label,
      encryptedValue: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      createdAt: ts,
      updatedAt: ts,
    };
    data.apiKeys.push(record);
    return maskedView(record);
  });
}

export async function upsertApiKeyAsync(input: UpsertApiKeyInput): Promise<MaskedApiKey> {
  if (!input.value || input.value.length === 0) throw new Error("api-key-store: value is required");
  const masterKey = loadMasterKey();
  const encrypted = encryptSecret(input.value, masterKey);
  const ts = nowIso();
  return mutateStoreAsync((data) => {
    const existing = data.apiKeys.find(
      (k) => k.workspaceId === input.workspaceId && k.provider === input.provider && k.label === input.label,
    );
    if (existing) {
      existing.encryptedValue = encrypted.ciphertext;
      existing.iv = encrypted.iv;
      existing.authTag = encrypted.authTag;
      existing.updatedAt = ts;
      return maskedView(existing);
    }
    const record: ApiKeyRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      provider: input.provider,
      label: input.label,
      encryptedValue: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      createdAt: ts,
      updatedAt: ts,
    };
    data.apiKeys.push(record);
    return maskedView(record);
  });
}

export function removeApiKey(id: string): void {
  mutateStore((data) => {
    const idx = data.apiKeys.findIndex((k) => k.id === id);
    if (idx >= 0) data.apiKeys.splice(idx, 1);
  });
}

export async function removeApiKeyAsync(id: string): Promise<void> {
  await mutateStoreAsync((data) => {
    const idx = data.apiKeys.findIndex((k) => k.id === id);
    if (idx >= 0) data.apiKeys.splice(idx, 1);
  });
}

export function removeApiKeyForWorkspace(id: string, workspaceId: string): boolean {
  return mutateStore((data) => {
    const idx = data.apiKeys.findIndex((k) => k.id === id && k.workspaceId === workspaceId);
    if (idx < 0) return false;
    data.apiKeys.splice(idx, 1);
    return true;
  });
}

export function removeApiKeyForWorkspaceAsync(id: string, workspaceId: string): Promise<boolean> {
  return mutateStoreAsync((data) => {
    const idx = data.apiKeys.findIndex((k) => k.id === id && k.workspaceId === workspaceId);
    if (idx < 0) return false;
    data.apiKeys.splice(idx, 1);
    return true;
  });
}

export function resolveApiKey(workspaceId: string, provider: ApiKeyProvider): string | null {
  const masterKey = loadMasterKey();
  const ts = nowIso();
  return mutateStore((data) => {
    const record = data.apiKeys.find((k) => k.workspaceId === workspaceId && k.provider === provider);
    if (!record) return null;
    record.lastUsedAt = ts;
    return decryptSecret({ ciphertext: record.encryptedValue, iv: record.iv, authTag: record.authTag }, masterKey);
  });
}

export function resolveApiKeyAsync(workspaceId: string, provider: ApiKeyProvider): Promise<string | null> {
  const masterKey = loadMasterKey();
  const ts = nowIso();
  return mutateStoreAsync((data) => {
    const record = data.apiKeys.find((k) => k.workspaceId === workspaceId && k.provider === provider);
    if (!record) return null;
    record.lastUsedAt = ts;
    return decryptSecret({ ciphertext: record.encryptedValue, iv: record.iv, authTag: record.authTag }, masterKey);
  });
}

export function vaultApiKeyResolver(workspaceId: string, provider: ApiKeyProvider): Promise<string | null> {
  return resolveApiKeyAsync(workspaceId, provider);
}
