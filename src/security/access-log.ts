import { closeSync, existsSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import type { Context } from "hono";
import { redactSensitiveString } from "./redaction.js";

type AccessLogMode = "stdout" | "file" | "off";

type AccessLogConfig = {
  mode: AccessLogMode;
  filePath: string | null;
  maxBytes: number;
  maxFiles: number;
};

export type AccessLogLineInput = {
  method: string;
  status: number;
  path: string;
  query?: string | null;
  durationMs: number;
  userId: string | null;
  workspaceId: string | null;
  requestId: string | null;
  now: Date;
};

export interface RotateAccessLogResult {
  rotated: boolean;
  from: string;
  to: string | null;
}

let cachedFileFd: number | null = null;
let cachedFilePath: string | null = null;
let cachedFileSize: number | null = null;

function readConfig(): AccessLogConfig {
  const rawMode = (process.env.PACKETAGENT_ACCESS_LOG_MODE ?? "off").toLowerCase();
  const mode: AccessLogMode = rawMode === "stdout" || rawMode === "file" ? rawMode : "off";
  const rawPath = process.env.PACKETAGENT_ACCESS_LOG_PATH;
  const filePath = mode === "file" && rawPath ? resolve(process.cwd(), rawPath) : null;
  const rawMaxBytes = Number(process.env.PACKETAGENT_ACCESS_LOG_MAX_BYTES ?? "0");
  const maxBytes = Number.isFinite(rawMaxBytes) && rawMaxBytes > 0 ? Math.floor(rawMaxBytes) : 0;
  const rawMaxFiles = Number(process.env.PACKETAGENT_ACCESS_LOG_MAX_FILES ?? "5");
  const maxFiles = Number.isFinite(rawMaxFiles) && rawMaxFiles >= 1 ? Math.floor(rawMaxFiles) : 5;
  return { mode, filePath, maxBytes, maxFiles };
}

function closeCachedFd(): void {
  if (cachedFileFd !== null) {
    try { closeSync(cachedFileFd); } catch { /* ignore */ }
  }
  cachedFileFd = null;
  cachedFilePath = null;
  cachedFileSize = null;
}

function openFileForAppend(filePath: string): number {
  if (cachedFileFd !== null && cachedFilePath === filePath) return cachedFileFd;
  if (cachedFileFd !== null) closeCachedFd();
  cachedFileFd = openSync(filePath, "a");
  cachedFilePath = filePath;
  try {
    cachedFileSize = statSync(filePath).size;
  } catch {
    cachedFileSize = 0;
  }
  return cachedFileFd;
}

export function formatAccessLogLine(input: AccessLogLineInput): string {
  const { method, status, path, query, durationMs, userId, workspaceId, requestId, now } = input;
  const fullPath = query ? `${path}?${query}` : path;
  const redactedPath = redactSensitiveString(fullPath);
  const line = {
    ts: now.toISOString(),
    method,
    status,
    path: redactedPath,
    durationMs,
    userId,
    workspaceId,
    requestId,
  };
  return `${JSON.stringify(line)}\n`;
}

export function rotateAccessLogFile(filePath: string, maxFiles: number): RotateAccessLogResult {
  if (!existsSync(filePath)) {
    return { rotated: false, from: filePath, to: null };
  }
  const ceiling = Math.max(1, Math.floor(maxFiles));
  try {
    const top = `${filePath}.${ceiling}`;
    if (existsSync(top)) {
      try { rmSync(top, { force: true }); } catch { /* ignore */ }
    }
    for (let i = ceiling - 1; i >= 1; i -= 1) {
      const src = `${filePath}.${i}`;
      const dst = `${filePath}.${i + 1}`;
      if (existsSync(src)) {
        try { renameSync(src, dst); } catch { /* ignore */ }
      }
    }
    renameSync(filePath, `${filePath}.1`);
    return { rotated: true, from: filePath, to: `${filePath}.1` };
  } catch {
    return { rotated: false, from: filePath, to: null };
  }
}

export function __resetAccessLogForTests(): void {
  closeCachedFd();
}

export function accessLogMiddleware(): (c: Context, next: () => Promise<void>) => Promise<void> {
  const config = readConfig();
  if (config.mode === "off") {
    return async (_c, next) => {
      await next();
    };
  }
  return async (c, next) => {
    const start = Date.now();
    let threwError: unknown = null;
    let status = 500;
    try {
      await next();
      status = c.res.status;
    } catch (error) {
      threwError = error;
      status = 500;
    }
    const durationMs = Date.now() - start;
    const url = new URL(c.req.url);
    const query = url.search.slice(1);
    const userId = (c.get("user") as { id?: string } | undefined)?.id ?? null;
    const workspaceId = (c.get("workspace") as { id?: string } | undefined)?.id ?? null;
    const requestId = c.req.header("x-request-id") ?? null;
    const serialized = formatAccessLogLine({
      method: c.req.method,
      status,
      path: c.req.path,
      query: query || null,
      durationMs,
      userId,
      workspaceId,
      requestId,
      now: new Date(),
    });
    if (config.mode === "stdout") {
      process.stdout.write(serialized);
    } else if (config.mode === "file" && config.filePath) {
      // Windows: renameSync fails with EBUSY on an open file. We close the cached fd before rotating so the rename can proceed; rotation errors are swallowed so logging never tips over the request.
      if (config.maxBytes > 0 && cachedFileSize !== null) {
        const projected = cachedFileSize + serialized.length;
        if (projected > config.maxBytes) {
          closeCachedFd();
          try { rotateAccessLogFile(config.filePath, config.maxFiles); } catch { /* ignore */ }
        }
      }
      try {
        const fd = openFileForAppend(config.filePath);
        writeSync(fd, serialized);
        if (cachedFileSize !== null) cachedFileSize += serialized.length;
      } catch {
        closeCachedFd();
      }
    }
    if (threwError) throw threwError;
  };
}
