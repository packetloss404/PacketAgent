import type { PacketAgentData } from "./types.js";

// Shared in-process cache for the most recently loaded store, keyed by the
// backend that produced it. Kept module-private and exposed only through
// accessor functions so consumers never bind to a mutable `let` (which would
// be an ESM live-binding hazard if re-exported). This module is a LEAF: it
// imports only types and must never import a backend or the barrel.
let cache: PacketAgentData | null = null;
let cacheBackendKey: string | null = null;

export function getCachedStore(): PacketAgentData | null {
  return cache;
}

export function getCacheBackendKey(): string | null {
  return cacheBackendKey;
}

export function setCachedStore(data: PacketAgentData, backendKey: string): void {
  cache = data;
  cacheBackendKey = backendKey;
}

export function clearStoreCacheState(): void {
  cache = null;
  cacheBackendKey = null;
}

// Re-entrancy counter for synchronous/asynchronous sqlite mutations. Dual-write
// flushes are deferred until the outermost mutation completes (depth returns to
// zero), so this counter is shared between the sqlite backend and the
// dual-write layer.
let activeMutateSqliteDepth = 0;

export function getMutateSqliteDepth(): number {
  return activeMutateSqliteDepth;
}

export function incrementMutateSqliteDepth(): void {
  activeMutateSqliteDepth += 1;
}

export function decrementMutateSqliteDepth(): void {
  activeMutateSqliteDepth -= 1;
}
