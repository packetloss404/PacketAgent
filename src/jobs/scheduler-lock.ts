import {
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  closeSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export interface SchedulerLeaderLock {
  acquire(): Promise<boolean>;
  release(): Promise<void>;
  isHeld(): boolean;
}

export function noopLeaderLock(): SchedulerLeaderLock {
  return {
    async acquire() {
      return true;
    },
    async release() {
      /* noop */
    },
    isHeld() {
      return true;
    },
  };
}

export interface FileLeaderLockOptions {
  path: string;
  processId: string;
  ttlMs: number;
  now?: () => number;
}

interface FileLockState {
  processId: string;
  expiresAt: number;
}

function readLockState(path: string): FileLockState | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const raw = readFileSync(fd, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as FileLockState).processId === "string" &&
      typeof (parsed as FileLockState).expiresAt === "number"
    ) {
      return parsed as FileLockState;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function writeLockStateAtomic(path: string, state: FileLockState): void {
  const tmp = `${path}.tmp.${randomBytes(8).toString("hex")}`;
  writeFileSync(tmp, `${JSON.stringify(state)}\n`, { flag: "w" });
  renameSync(tmp, path);
}

export function fileLeaderLock(options: FileLeaderLockOptions): SchedulerLeaderLock {
  const { path, processId, ttlMs } = options;
  const clock = options.now ?? (() => Date.now());
  let held = false;

  return {
    async acquire() {
      const parent = dirname(path);
      if (!existsSync(parent)) {
        throw new Error(`scheduler leader lock parent directory does not exist: ${parent}`);
      }
      try {
        const stats = statSync(parent);
        if (!stats.isDirectory()) {
          throw new Error(`scheduler leader lock parent is not a directory: ${parent}`);
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("scheduler leader lock parent"))
          throw error;
        throw new Error(`scheduler leader lock parent directory does not exist: ${parent}`);
      }

      const now = clock();
      const current = readLockState(path);
      const ownedByUs = current?.processId === processId;
      const expired = current ? current.expiresAt <= now : true;
      const noHolder = current === null;

      if (noHolder || ownedByUs || expired) {
        writeLockStateAtomic(path, { processId, expiresAt: now + ttlMs });
        held = true;
        return true;
      }
      held = false;
      return false;
    },
    async release() {
      try {
        const current = readLockState(path);
        if (current && current.processId === processId) {
          try {
            unlinkSync(path);
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
      held = false;
    },
    isHeld() {
      return held;
    },
  };
}
