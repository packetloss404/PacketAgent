import type { SchedulerLeaderLock } from "./scheduler-lock.js";

export interface HttpLeaderLockOptions {
  url: string;
  processId: string;
  ttlMs: number;
  secret?: string;
  timeoutMs?: number;
  failOpen?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function buildHeaders(secret: string | undefined): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (secret) headers.set("Authorization", `Bearer ${secret}`);
  return headers;
}

function leaderFlagFromPayload(payload: unknown): boolean | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.leader === "boolean") return record.leader;
  if (typeof record.acquired === "boolean") return record.acquired;
  return null;
}

async function readJsonObject(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const text = await response.text();
    if (!text.trim()) return null;
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function httpLeaderLock(options: HttpLeaderLockOptions): SchedulerLeaderLock {
  const baseUrl = options.url.replace(/\/+$/, "");
  const acquireUrl = `${baseUrl}/acquire`;
  const releaseUrl = `${baseUrl}/release`;
  const timeoutMs = options.timeoutMs ?? 5000;
  const failOpen = options.failOpen === true;
  const fetchImpl = options.fetchImpl ?? fetch;
  const clock = options.now ?? (() => Date.now());
  let held = false;

  return {
    async acquire(): Promise<boolean> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(acquireUrl, {
          method: "POST",
          headers: buildHeaders(options.secret),
          body: JSON.stringify({
            processId: options.processId,
            ttlMs: options.ttlMs,
            timestamp: clock(),
          }),
          signal: controller.signal,
        });

        if (response.status === 401 || response.status === 403) {
          throw new Error(`scheduler leader coordinator returned ${response.status}`);
        }
        if (response.status === 409) {
          held = false;
          return false;
        }
        if (!response.ok) {
          if (failOpen) return held;
          held = false;
          return false;
        }

        const payload = await readJsonObject(response);
        const flag = leaderFlagFromPayload(payload);
        if (flag === null) {
          if (failOpen) return held;
          held = false;
          return false;
        }
        held = flag;
        return flag;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith("scheduler leader coordinator returned ")
        ) {
          throw error;
        }
        if (failOpen) return held;
        held = false;
        return false;
      } finally {
        clearTimeout(timeout);
      }
    },
    async release(): Promise<void> {
      if (!held) return;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        await fetchImpl(releaseUrl, {
          method: "POST",
          headers: buildHeaders(options.secret),
          body: JSON.stringify({
            processId: options.processId,
            timestamp: clock(),
          }),
          signal: controller.signal,
        });
      } catch {
        /* best-effort */
      } finally {
        clearTimeout(timeout);
        held = false;
      }
    },
    isHeld(): boolean {
      return held;
    },
  };
}
