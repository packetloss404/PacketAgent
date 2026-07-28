import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sqliteProviderCallsRepository } from "../repositories/provider-calls-repo.js";
import {
  loadStoreAsync,
  listProviderCallsForWorkspaceIndexed,
  mutateStoreAsync,
  type ProviderCallRecord,
} from "../packetagent-store.js";
import { redactedErrorMessage, redactSensitiveString } from "../security/redaction.js";
import type { ProviderName, ProviderStreamChunk, ProviderUsage } from "./types.js";

const DEFAULT_DB_FILE = "data/packetagent.sqlite";
const PROVIDER_CALL_CAP = 5_000;
let lastLedgerTimestampMs = 0;

interface ProviderCallsWriteRepository {
  insertMany?: (records: ProviderCallRecord[]) => void;
  upsert?: (record: ProviderCallRecord) => void;
  pruneRetainLatest?: (maxRows: number) => number;
}

export interface LedgerContext {
  workspaceId: string;
  routeKey: string;
  provider: ProviderName;
  model: string;
  recordId?: string;
}

function nowIso(): string {
  const current = Date.now();
  const timestamp = current > lastLedgerTimestampMs ? current : lastLedgerTimestampMs + 1;
  lastLedgerTimestampMs = timestamp;
  return new Date(timestamp).toISOString();
}

interface AppendCallResult {
  inserted: ProviderCallRecord;
  removedIds: string[];
}

async function appendCall(record: ProviderCallRecord): Promise<AppendCallResult> {
  const result = await mutateStoreAsync((data) => {
    data.providerCalls.push(record);
    const overflow = data.providerCalls.length - PROVIDER_CALL_CAP;
    const removedIds =
      overflow > 0 ? data.providerCalls.splice(0, overflow).map((entry) => entry.id) : [];
    return { inserted: record, removedIds };
  });

  dualWriteProviderCall(result);
  return result;
}

function dualWriteProviderCall(result: AppendCallResult): void {
  if (process.env.PACKETAGENT_STORE !== "sqlite") return;

  const repo = sqliteProviderCallsRepository({}) as ProviderCallsWriteRepository;
  if (repo.insertMany) {
    repo.insertMany([result.inserted]);
  } else if (repo.upsert) {
    repo.upsert(result.inserted);
  } else {
    throw new Error("sqliteProviderCallsRepository must expose insertMany or upsert");
  }

  if (result.removedIds.length > 0) {
    deleteProviderCallRows(result.removedIds);
  }
  repo.pruneRetainLatest?.(PROVIDER_CALL_CAP);
}

function deleteProviderCallRows(ids: string[]): void {
  const dbPath = resolve(process.env.PACKETAGENT_DB_PATH ?? DEFAULT_DB_FILE);
  const db = new DatabaseSync(dbPath);
  try {
    const stmt = db.prepare("delete from provider_calls where id = ?");
    for (const id of ids) {
      stmt.run(id);
    }
  } finally {
    db.close();
  }
}

function emptyUsage(): ProviderUsage {
  return { promptTokens: 0, completionTokens: 0, costUsd: 0 };
}

export async function recordedCall<T extends { usage: ProviderUsage }>(
  ctx: LedgerContext,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = nowIso();
  const t0 = Date.now();
  try {
    const result = await fn();
    await appendCall({
      id: ctx.recordId ?? randomUUID(),
      workspaceId: ctx.workspaceId,
      routeKey: ctx.routeKey,
      provider: ctx.provider,
      model: ctx.model,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      costUsd: result.usage.costUsd,
      durationMs: Date.now() - t0,
      status: "success",
      startedAt,
      completedAt: nowIso(),
    });
    return result;
  } catch (error) {
    await appendCall({
      id: ctx.recordId ?? randomUUID(),
      workspaceId: ctx.workspaceId,
      routeKey: ctx.routeKey,
      provider: ctx.provider,
      model: ctx.model,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      durationMs: Date.now() - t0,
      status: "error",
      errorMessage: redactedErrorMessage(error),
      startedAt,
      completedAt: nowIso(),
    });
    throw error;
  }
}

export async function* recordedStream<T extends ProviderStreamChunk>(
  ctx: LedgerContext,
  iter: AsyncIterable<T>,
): AsyncIterable<T> {
  const startedAt = nowIso();
  const t0 = Date.now();
  let usage: ProviderUsage = emptyUsage();
  let errorMessage: string | undefined;
  let canceled = false;
  try {
    for await (const chunk of iter) {
      if (chunk.usage) usage = chunk.usage;
      if (chunk.error) {
        errorMessage = redactSensitiveString(chunk.error);
        if (chunk.error === "aborted") canceled = true;
      }
      yield chunk;
    }
  } catch (error) {
    errorMessage = redactedErrorMessage(error);
    throw error;
  } finally {
    await appendCall({
      id: ctx.recordId ?? randomUUID(),
      workspaceId: ctx.workspaceId,
      routeKey: ctx.routeKey,
      provider: ctx.provider,
      model: ctx.model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      costUsd: usage.costUsd,
      durationMs: Date.now() - t0,
      status: errorMessage ? (canceled ? "canceled" : "error") : "success",
      ...(errorMessage ? { errorMessage } : {}),
      startedAt,
      completedAt: nowIso(),
    });
  }
}

export interface UsageSummary {
  totalCalls: number;
  totalCostUsd: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  last24h: { calls: number; costUsd: number };
  byProvider: { provider: ProviderName; calls: number; costUsd: number }[];
  byRoute: { routeKey: string; calls: number; costUsd: number }[];
  recent: ProviderCallRecord[];
}

function summarizeProviderCallEntries(entries: ProviderCallRecord[]): UsageSummary {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let last24Calls = 0,
    last24Cost = 0;
  let totalCost = 0,
    totalPrompt = 0,
    totalCompletion = 0;
  const byProvider = new Map<ProviderName, { calls: number; costUsd: number }>();
  const byRoute = new Map<string, { calls: number; costUsd: number }>();
  for (const c of entries) {
    totalCost += c.costUsd;
    totalPrompt += c.promptTokens;
    totalCompletion += c.completionTokens;
    const ts = Date.parse(c.completedAt);
    if (ts >= cutoff) {
      last24Calls++;
      last24Cost += c.costUsd;
    }
    const p = byProvider.get(c.provider) ?? { calls: 0, costUsd: 0 };
    p.calls++;
    p.costUsd += c.costUsd;
    byProvider.set(c.provider, p);
    const r = byRoute.get(c.routeKey) ?? { calls: 0, costUsd: 0 };
    r.calls++;
    r.costUsd += c.costUsd;
    byRoute.set(c.routeKey, r);
  }
  return {
    totalCalls: entries.length,
    totalCostUsd: totalCost,
    totalPromptTokens: totalPrompt,
    totalCompletionTokens: totalCompletion,
    last24h: { calls: last24Calls, costUsd: last24Cost },
    byProvider: [...byProvider.entries()]
      .map(([provider, v]) => ({ provider, ...v }))
      .sort((a, b) => b.calls - a.calls),
    byRoute: [...byRoute.entries()]
      .map(([routeKey, v]) => ({ routeKey, ...v }))
      .sort((a, b) => b.calls - a.calls),
    recent: entries.slice(0, 50),
  };
}

export function summarizeUsage(workspaceId: string): UsageSummary {
  return summarizeProviderCallEntries(listProviderCallsForWorkspaceIndexed(workspaceId));
}

export async function summarizeUsageAsync(workspaceId: string): Promise<UsageSummary> {
  return summarizeProviderCallEntries(await listProviderCallsAsync(workspaceId));
}

export function listProviderCalls(
  workspaceId: string,
  opts: { since?: string; limit?: number } = {},
): ProviderCallRecord[] {
  return listProviderCallsForWorkspaceIndexed(workspaceId, opts);
}

export async function listProviderCallsAsync(
  workspaceId: string,
  opts: { since?: string; limit?: number } = {},
): Promise<ProviderCallRecord[]> {
  const data = await loadStoreAsync();
  let entries = data.providerCalls
    .filter((entry) => entry.workspaceId === workspaceId)
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt));
  if (opts.since) {
    const since = opts.since;
    entries = entries.filter((entry) => entry.completedAt >= since);
  }
  if (opts.limit !== undefined) entries = entries.slice(0, opts.limit);
  return entries;
}
