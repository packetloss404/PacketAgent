import type { PacketAgentData } from "../types.js";

// Shared backend contracts. LEAF: types only.
export interface StoreBackend {
  key: string;
  load(): PacketAgentData;
  persist(data: PacketAgentData): void;
  reset(): PacketAgentData;
}

export interface AsyncStoreBackend {
  key: string;
  load(): Promise<PacketAgentData>;
  mutate<T>(mutator: (data: PacketAgentData) => T | Promise<T>): Promise<T>;
}
