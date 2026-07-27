import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { PacketAgentData } from "./types.js";

// LEAF module: JSON file I/O + serialization for the json-backed store, plus the
// in-process mutation serialization chain. Imports only node builtins and types
// — never a backend or the barrel. The atomic write and chain error handling are
// data-integrity-critical; behavior here is moved verbatim.

export const DATA_FILE = resolve(process.cwd(), "data", "packetagent.json");

let jsonTmpFileCounter = 0;

export function persistJsonStore(data: PacketAgentData): void {
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  const serialized = JSON.stringify(data, null, 2);
  // Write to a temp file in the same directory, then atomically rename it over
  // the target. rename(2) is atomic on the same filesystem (POSIX) and replaces
  // the destination on Windows/NTFS, so readers never observe a partial file.
  // A monotonic counter (in addition to the pid) avoids tmp-name collisions
  // between writes within the same process.
  jsonTmpFileCounter += 1;
  const tmpFile = `${DATA_FILE}.${process.pid}.${jsonTmpFileCounter}.tmp`;
  try {
    writeFileSync(tmpFile, serialized);
    renameSync(tmpFile, DATA_FILE);
  } catch (error) {
    try {
      rmSync(tmpFile, { force: true });
    } catch {
      // Best-effort cleanup; surface the original write/rename failure below.
    }
    throw error;
  }
}

// Serializes JSON-backed async mutations in-process. Each mutation chains onto
// the previous one so that the read-modify-persist sequence runs one-at-a-time;
// without this the `await mutator(data)` yield lets concurrent mutations share
// the same cached object and the last `persist` wins (lost updates). The
// sqlite/postgres backends serialize at the database layer and never use this.
let jsonMutateChain: Promise<unknown> = Promise.resolve();

export function runSerializedJsonMutation<T>(run: () => Promise<T>): Promise<T> {
  // Wait for the in-flight mutation to settle (success or failure) before
  // starting the next one. We swallow the predecessor's rejection here so a
  // failed mutation can never permanently break the chain / cause a deadlock;
  // the original caller still receives that rejection from its own promise.
  const result = jsonMutateChain.then(run, run);
  jsonMutateChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
