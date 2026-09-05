import type { WorkerClockPort } from "../ports.js";

interface VirtualTimer {
  readonly at: number;
  readonly sequence: number;
  readonly fire: () => void;
}

export interface VirtualWorkerClock extends WorkerClockPort {
  /** Milliseconds of virtual time elapsed since the clock was created. */
  readonly elapsedMs: number;
}

/**
 * A deterministic clock for supervisor tests. `sleep` never touches real
 * timers: whenever the event loop would otherwise go idle, virtual time jumps
 * to the earliest pending sleep and resolves it. Long provider calls, retry
 * backoffs, and lease heartbeats therefore play out in the order their
 * virtual deadlines dictate, in a few milliseconds of wall time.
 */
export function createVirtualWorkerClock(
  startAt = Date.parse("2026-07-27T12:00:00.000Z"),
): VirtualWorkerClock {
  let nowMs = startAt;
  let sequence = 0;
  let pumpScheduled = false;
  const timers = new Set<VirtualTimer>();

  const pump = (): void => {
    if (pumpScheduled) return;
    pumpScheduled = true;
    setImmediate(() => {
      pumpScheduled = false;
      let next: VirtualTimer | undefined;
      for (const timer of timers) {
        if (
          !next ||
          timer.at < next.at ||
          (timer.at === next.at && timer.sequence < next.sequence)
        ) {
          next = timer;
        }
      }
      if (!next) return;
      timers.delete(next);
      nowMs = Math.max(nowMs, next.at);
      next.fire();
      if (timers.size > 0) pump();
    });
  };

  return {
    get elapsedMs() {
      return nowMs - startAt;
    },
    now: () => new Date(nowMs),
    monotonicMs: () => nowMs - startAt,
    sleep(ms, signal) {
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(abortError(signal));
          return;
        }
        const timer: VirtualTimer = {
          at: nowMs + Math.max(0, ms),
          sequence: sequence++,
          fire: () => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          },
        };
        const onAbort = (): void => {
          timers.delete(timer);
          reject(abortError(signal));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        timers.add(timer);
        pump();
      });
    },
  };
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === "string" ? reason : "Virtual sleep aborted.");
}
