import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkerNetworkClient,
  validateWorkerNetworkUrl,
  type WorkerNetworkPort,
  type WorkerNetworkResponse,
} from "../workers/network.js";
import type { SandboxDriverId } from "./sandbox-driver.js";
import type { SandboxEgressReceipt, SandboxEgressRequest } from "./types.js";

const MAX_FETCHES = 8;
const MAX_URL_BYTES = 2 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_TOTAL_RESPONSE_BYTES = 512 * 1024;
const EGRESS_MOUNT_ROOT = "/input/egress";
const EGRESS_ID = /^[a-z][a-z0-9_-]{0,31}$/;

export interface SandboxEgressConfigView {
  policy: "deny-all" | "brokered-prefetch";
  allowedOrigins: string[];
  maxFetches: number;
  maxResponseBytes: number;
}

export interface SandboxEgressPlan {
  requests: Array<{
    id: string;
    url: string;
    receipt: SandboxEgressReceipt;
  }>;
  maxResponseBytes: number;
  timeoutMs: number;
}

export interface SandboxEgressMaterialization {
  receipts: SandboxEgressReceipt[];
  mount: {
    source: string;
    target: typeof EGRESS_MOUNT_ROOT;
    readOnly: true;
  };
  cleanup(): Promise<void>;
}

export interface SandboxEgressDeps {
  network?: WorkerNetworkPort;
}

export function describeSandboxEgressConfig(env: NodeJS.ProcessEnv): SandboxEgressConfigView {
  const allowedOrigins = parseAllowedOrigins(env.PACKETAGENT_SANDBOX_EGRESS_ALLOWLIST);
  return {
    policy: allowedOrigins.length > 0 ? "brokered-prefetch" : "deny-all",
    allowedOrigins,
    maxFetches: MAX_FETCHES,
    maxResponseBytes: boundedConfigInteger(
      env.PACKETAGENT_SANDBOX_EGRESS_MAX_RESPONSE_BYTES,
      DEFAULT_MAX_RESPONSE_BYTES,
      1_024,
      1024 * 1024,
    ),
  };
}

export function resolveSandboxEgressPlan(
  requested: readonly SandboxEgressRequest[] | undefined,
  env: NodeJS.ProcessEnv,
  driver: SandboxDriverId,
): SandboxEgressPlan | null {
  if (requested === undefined || requested.length === 0) return null;
  if (driver !== "docker") {
    throw requestError("declared egress is supported only by the isolated Docker driver");
  }
  if (requested.length > MAX_FETCHES) {
    throw requestError(`at most ${MAX_FETCHES} declared egress fetches are allowed`);
  }

  const config = describeSandboxEgressConfig(env);
  if (config.allowedOrigins.length === 0) {
    throw requestError(
      "declared egress is disabled; configure PACKETAGENT_SANDBOX_EGRESS_ALLOWLIST",
    );
  }
  const allowed = new Set(config.allowedOrigins);
  const ids = new Set<string>();
  const requests = requested.map((entry) => {
    if (!entry || typeof entry.id !== "string" || !EGRESS_ID.test(entry.id)) {
      throw requestError("egress id must match [a-z][a-z0-9_-]{0,31}");
    }
    if (ids.has(entry.id)) throw requestError(`duplicate egress id: ${entry.id}`);
    ids.add(entry.id);
    if (typeof entry.url !== "string" || Buffer.byteLength(entry.url) > MAX_URL_BYTES) {
      throw requestError(`egress URL must contain at most ${MAX_URL_BYTES} bytes`);
    }
    const parsed = validateWorkerNetworkUrl(entry.url);
    if (parsed.hash) throw requestError("egress URL fragments are not allowed");
    if (!allowed.has(parsed.origin)) {
      throw requestError("egress URL origin is not in the operator allowlist");
    }
    const target = `${parsed.origin}${parsed.pathname}${parsed.search ? "?[redacted]" : ""}`;
    return {
      id: entry.id,
      url: parsed.toString(),
      receipt: {
        id: entry.id,
        target,
        origin: parsed.origin,
        method: "GET" as const,
        status: "declared" as const,
        mountPath: `${EGRESS_MOUNT_ROOT}/${entry.id}`,
      },
    };
  });

  return {
    requests,
    maxResponseBytes: config.maxResponseBytes,
    timeoutMs: boundedConfigInteger(
      env.PACKETAGENT_SANDBOX_EGRESS_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      1_000,
      60_000,
    ),
  };
}

export async function materializeSandboxEgress(
  plan: SandboxEgressPlan,
  deps: SandboxEgressDeps = {},
): Promise<SandboxEgressMaterialization> {
  const network = deps.network ?? createWorkerNetworkClient();
  const fetched: Array<{
    request: SandboxEgressPlan["requests"][number];
    response: WorkerNetworkResponse;
    body: Buffer;
  }> = [];
  let totalBytes = 0;

  for (const request of plan.requests) {
    const response = await network.request({
      url: request.url,
      method: "GET",
      headers: { accept: "*/*" },
      signal: AbortSignal.timeout(plan.timeoutMs),
      timeoutMs: plan.timeoutMs,
      maxResponseBytes: plan.maxResponseBytes,
    });
    if (response.status < 200 || response.status > 299) {
      throw new Error("sandbox egress: declared fetch returned a non-success status");
    }
    const body = Buffer.from(response.body, "utf8");
    if (body.byteLength > plan.maxResponseBytes) {
      throw new Error("sandbox egress: declared fetch exceeded its response byte limit");
    }
    totalBytes += body.byteLength;
    if (totalBytes > MAX_TOTAL_RESPONSE_BYTES) {
      throw new Error("sandbox egress: declared fetches exceeded their total byte limit");
    }
    fetched.push({ request, response, body });
  }

  const directory = await mkdtemp(join(tmpdir(), "packetagent-sandbox-egress-"));
  try {
    await chmod(directory, 0o755);
    const receipts: SandboxEgressReceipt[] = [];
    for (const item of fetched) {
      await writeFile(join(directory, item.request.id), item.body, {
        flag: "wx",
        mode: 0o444,
      });
      receipts.push({
        ...item.request.receipt,
        status: "materialized",
        responseStatus: item.response.status,
        ...(item.response.headers["content-type"]
          ? { contentType: item.response.headers["content-type"] }
          : {}),
        byteLength: item.body.byteLength,
        sha256: createHash("sha256").update(item.body).digest("hex"),
        connectedAddress: item.response.connectedAddress,
      });
    }
    await writeFile(
      join(directory, "_manifest.json"),
      `${JSON.stringify({ version: 1, receipts }, null, 2)}\n`,
      { flag: "wx", mode: 0o444 },
    );
    let cleaned = false;
    return {
      receipts,
      mount: {
        source: directory,
        target: EGRESS_MOUNT_ROOT,
        readOnly: true,
      },
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length > 32) {
    throw new Error("sandbox egress: operator allowlist may contain at most 32 origins");
  }
  const origins = new Set<string>();
  for (const entry of entries) {
    const parsed = validateWorkerNetworkUrl(entry);
    if (
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname !== "" && parsed.pathname !== "/")
    ) {
      throw new Error("sandbox egress: allowlist entries must be exact http(s) origins");
    }
    origins.add(parsed.origin);
  }
  return [...origins].sort();
}

function boundedConfigInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(Math.min(Math.max(parsed, min), max));
}

function requestError(message: string): Error {
  return Object.assign(new Error(`sandbox egress: ${message}`), { status: 400 });
}
