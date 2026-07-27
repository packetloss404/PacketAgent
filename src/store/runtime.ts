import { getCacheBackendKey, getCachedStore, setCachedStore } from "./cache.js";
import type { StoreBackend } from "./backends/types.js";
import type { PacketAgentData } from "./types.js";

// LEAF helper: cache-aware synchronous load from a StoreBackend. Imports cache
// and backend contract types only — never a concrete backend or the barrel.
export function loadStoreFromBackend(backend: StoreBackend): PacketAgentData {
  const cached = getCachedStore();
  if (cached && getCacheBackendKey() === backend.key) return cached;

  const loaded = backend.load();
  setCachedStore(loaded, backend.key);
  return loaded;
}
