import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { connect as connectTcp } from "node:net";
import { connect as connectTls } from "node:tls";
import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

export type GeneratedAppReachabilityFailureCode =
  | "url_invalid"
  | "insecure_public_url"
  | "dns_lookup_failed"
  | "tcp_connect_failed"
  | "tls_handshake_failed"
  | "unexpected_redirect"
  | "http_status_failed"
  | "response_too_large"
  | "response_invalid"
  | "identity_mismatch";

export interface GeneratedAppReachabilityStep {
  id: "url" | "dns" | "transport" | "liveness" | "readiness" | "app-root";
  status: "pass" | "fail";
  durationMs: number;
  detail: string;
  code?: GeneratedAppReachabilityFailureCode;
}

export interface GeneratedAppReachabilityResult {
  schemaVersion: "packetagent.generated-app-reachability/v1";
  status: "pass" | "fail";
  origin: string;
  appId: string;
  checkpointId: string;
  startedAt: string;
  completedAt: string;
  steps: GeneratedAppReachabilityStep[];
}

interface RuntimeConfig {
  appId: string;
  workspaceId: string;
  checkpointId: string;
}

const STEP_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_RUNTIME_CONFIG_BYTES = 256 * 1024;

export async function verifyGeneratedAppReachability(
  publishRootInput: string,
  originInput: string,
): Promise<GeneratedAppReachabilityResult> {
  const publishRoot = resolve(publishRootInput);
  const config = readRuntimeConfig(publishRoot);
  const startedAt = new Date().toISOString();
  const steps: GeneratedAppReachabilityStep[] = [];
  const requestedOrigin = String(originInput || "").trim();
  let origin = "";

  try {
    const url = await runStep(steps, "url", () => validateOrigin(requestedOrigin));
    origin = url.origin;
    const hostname = networkHostname(url.hostname);
    const addresses = await runStep(steps, "dns", async () => {
      try {
        const resolved = isIP(hostname)
          ? [{ address: hostname, family: isIP(hostname) }]
          : await withTimeout(
              lookup(hostname, { all: true, verbatim: true }),
              STEP_TIMEOUT_MS,
              "DNS lookup timed out",
            );
        if (!resolved.length) {
          throw new ReachabilityError("dns_lookup_failed", "DNS returned no addresses.");
        }
        return {
          value: resolved,
          detail: `Resolved ${hostname} to ${resolved
            .slice(0, 8)
            .map((entry) => entry.address)
            .join(", ")}${resolved.length > 8 ? "…" : ""}.`,
        };
      } catch (error) {
        if (error instanceof ReachabilityError) throw error;
        throw new ReachabilityError("dns_lookup_failed", safeMessage(error));
      }
    });
    await runStep(steps, "transport", async () => {
      if (!addresses.length) {
        throw new ReachabilityError("dns_lookup_failed", "DNS returned no usable address.");
      }
      return await verifyTransport(url, hostname);
    });
    await runStep(steps, "liveness", async () => {
      const response = await fetchBounded(new URL("/health/live", url), "application/json");
      if (response.body.status !== "live") {
        throw new ReachabilityError("response_invalid", "Liveness body did not report live.");
      }
      return "GET /health/live returned the expected live status.";
    });
    await runStep(steps, "readiness", async () => {
      const response = await fetchBounded(new URL("/health/ready", url), "application/json");
      if (response.body.status !== "ready") {
        throw new ReachabilityError("response_invalid", "Readiness body did not report ready.");
      }
      if (
        response.body.appId !== config.appId ||
        response.body.checkpointId !== config.checkpointId
      ) {
        throw new ReachabilityError(
          "identity_mismatch",
          "Reachable service identity does not match this publish package.",
        );
      }
      return `GET /health/ready matched app ${config.appId} checkpoint ${config.checkpointId}.`;
    });
    await runStep(steps, "app-root", async () => {
      const response = await fetchBounded(url, "text/html");
      if (!response.text.toLowerCase().includes("<!doctype html")) {
        throw new ReachabilityError(
          "response_invalid",
          "App root did not contain an HTML doctype.",
        );
      }
      return "GET / returned generated HTML without a redirect.";
    });
  } catch {
    // The exact failed step is already recorded and later network steps are unsafe to infer.
  }

  return {
    schemaVersion: "packetagent.generated-app-reachability/v1",
    status: steps.length === 6 && steps.every((step) => step.status === "pass") ? "pass" : "fail",
    origin,
    appId: config.appId,
    checkpointId: config.checkpointId,
    startedAt,
    completedAt: new Date().toISOString(),
    steps,
  };
}

async function runStep<T>(
  steps: GeneratedAppReachabilityStep[],
  id: GeneratedAppReachabilityStep["id"],
  operation: () => Promise<T | { value: T; detail: string }> | T | { value: T; detail: string },
): Promise<T> {
  const started = Date.now();
  try {
    const output = await operation();
    const wrapped =
      output &&
      typeof output === "object" &&
      "value" in output &&
      "detail" in output &&
      typeof output.detail === "string";
    const value = wrapped ? output.value : output;
    const detail = wrapped
      ? output.detail
      : typeof output === "string"
        ? output
        : defaultDetail(id, value);
    steps.push({ id, status: "pass", durationMs: Date.now() - started, detail });
    return value as T;
  } catch (error) {
    const reachabilityError =
      error instanceof ReachabilityError
        ? error
        : new ReachabilityError(defaultFailureCode(id), safeMessage(error));
    steps.push({
      id,
      status: "fail",
      durationMs: Date.now() - started,
      detail: reachabilityError.message,
      code: reachabilityError.code,
    });
    throw reachabilityError;
  }
}

function validateOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ReachabilityError("url_invalid", "Reachability target is not a valid URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new ReachabilityError("url_invalid", "Reachability target must use HTTP or HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ReachabilityError(
      "url_invalid",
      "Reachability target cannot contain credentials, query, or fragment.",
    );
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new ReachabilityError(
      "url_invalid",
      "Generated apps must be verified at an origin root, not a path prefix.",
    );
  }
  if (url.protocol !== "https:" && !isLoopbackHostname(url.hostname)) {
    throw new ReachabilityError(
      "insecure_public_url",
      "Non-loopback reachability targets must use HTTPS.",
    );
  }
  return new URL(url.origin);
}

async function verifyTransport(
  url: URL,
  hostname: string,
): Promise<{ value: true; detail: string }> {
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (url.protocol === "https:") {
    try {
      const socket = await new Promise<import("node:tls").TLSSocket>((resolvePromise, reject) => {
        const candidate = connectTls({
          host: hostname,
          port,
          servername: isIP(hostname) ? undefined : hostname,
          rejectUnauthorized: true,
        });
        candidate.setTimeout(STEP_TIMEOUT_MS, () =>
          candidate.destroy(new Error("TLS handshake timed out")),
        );
        candidate.once("secureConnect", () => {
          candidate.setTimeout(0);
          resolvePromise(candidate);
        });
        candidate.once("error", reject);
      });
      const protocol = socket.getProtocol() || "unknown TLS";
      socket.destroy();
      return { value: true, detail: `TLS connected to ${hostname}:${port} using ${protocol}.` };
    } catch (error) {
      throw new ReachabilityError("tls_handshake_failed", safeMessage(error));
    }
  }
  try {
    const socket = await new Promise<import("node:net").Socket>((resolvePromise, reject) => {
      const candidate = connectTcp({ host: hostname, port });
      candidate.setTimeout(STEP_TIMEOUT_MS, () =>
        candidate.destroy(new Error("TCP connection timed out")),
      );
      candidate.once("connect", () => {
        candidate.setTimeout(0);
        resolvePromise(candidate);
      });
      candidate.once("error", reject);
    });
    socket.destroy();
    return { value: true, detail: `TCP connected to ${hostname}:${port}.` };
  } catch (error) {
    throw new ReachabilityError("tcp_connect_failed", safeMessage(error));
  }
}

async function fetchBounded(
  url: URL,
  expectedContentType: "application/json" | "text/html",
): Promise<{ body: Record<string, unknown>; text: string }> {
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "manual",
      headers: { accept: expectedContentType, "user-agent": "PacketAgent-Reachability/1" },
      signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ReachabilityError("http_status_failed", safeMessage(error));
  }
  if (response.status >= 300 && response.status < 400) {
    throw new ReachabilityError(
      "unexpected_redirect",
      `GET ${url.pathname} returned redirect ${response.status}. Verify the final HTTPS origin.`,
    );
  }
  if (!response.ok) {
    throw new ReachabilityError(
      "http_status_failed",
      `GET ${url.pathname} returned HTTP ${response.status}.`,
    );
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() || "";
  if (!contentType.includes(expectedContentType)) {
    throw new ReachabilityError(
      "response_invalid",
      `GET ${url.pathname} returned unexpected content type ${contentType || "(missing)"}.`,
    );
  }
  const text = await readBoundedResponse(response);
  if (expectedContentType === "text/html") return { body: {}, text };
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    return { body, text };
  } catch {
    throw new ReachabilityError("response_invalid", `GET ${url.pathname} returned invalid JSON.`);
  }
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new ReachabilityError("response_too_large", "Response exceeds the 64 KiB read limit.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ReachabilityError("response_too_large", "Response exceeds the 64 KiB read limit.");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function readRuntimeConfig(publishRoot: string): RuntimeConfig {
  const filePath = resolve(publishRoot, "runtime-config.json");
  const stats = statSync(filePath);
  if (!stats.isFile() || stats.size > MAX_RUNTIME_CONFIG_BYTES) {
    throw new Error(`${basename(filePath)} exceeds the reachability read limit`);
  }
  const config = JSON.parse(readFileSync(filePath, "utf8")) as RuntimeConfig;
  for (const field of ["workspaceId", "appId", "checkpointId"] as const) {
    if (typeof config[field] !== "string" || !config[field].trim()) {
      throw new Error(`runtime config is missing ${field}`);
    }
  }
  return config;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = networkHostname(hostname).toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost")
  );
}

function networkHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function defaultDetail(id: GeneratedAppReachabilityStep["id"], value: unknown): string {
  if (id === "url" && value instanceof URL) return `Accepted final origin ${value.origin}.`;
  return `${id} verification passed.`;
}

function defaultFailureCode(
  id: GeneratedAppReachabilityStep["id"],
): GeneratedAppReachabilityFailureCode {
  if (id === "url") return "url_invalid";
  if (id === "dns") return "dns_lookup_failed";
  if (id === "transport") return "tcp_connect_failed";
  return "http_status_failed";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\b(sk|pk|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/(password|secret|token|api[_-]?key)=([^\s&]+)/gi, "$1=[REDACTED]")
    .slice(0, 1_024);
}

class ReachabilityError extends Error {
  constructor(
    readonly code: GeneratedAppReachabilityFailureCode,
    message: string,
  ) {
    super(message);
  }
}
