import { readFileSync } from "node:fs";
import { loadStoreFromBackend } from "../runtime.js";
import { DATA_FILE, persistJsonStore, runSerializedJsonMutation } from "../json-io.js";
import { normalizeStore } from "../normalize.js";
import { seedStore } from "../seed.js";
import type { PacketAgentData } from "../types.js";
import type { AsyncStoreBackend, StoreBackend } from "./types.js";

// BACKEND module: json file-backed store. Imports leaves only
// (json-io/normalize/seed) plus the cache-aware load helper from runtime — never
// another backend or the barrel.

export function jsonStoreBackend(): StoreBackend {
  return {
    key: `json:${DATA_FILE}`,
    load() {
      try {
        return normalizeStore(JSON.parse(readFileSync(DATA_FILE, "utf8")) as Partial<PacketAgentData>);
      } catch {
        const seeded = seedStore();
        persistJsonStore(seeded);
        return seeded;
      }
    },
    persist: persistJsonStore,
    reset() {
      const seeded = seedStore();
      persistJsonStore(seeded);
      return seeded;
    },
  };
}

export function syncStoreAsyncBackend(backend: StoreBackend): AsyncStoreBackend {
  return {
    key: backend.key,
    async load() {
      return backend.load();
    },
    mutate(mutator) {
      return runSerializedJsonMutation(async () => {
        const data = loadStoreFromBackend(backend);
        const result = await mutator(data);
        backend.persist(data);
        return result;
      });
    },
  };
}
