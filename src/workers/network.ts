import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const REDIRECT_STATUS_MIN = 300;
const REDIRECT_STATUS_MAX = 399;

const BLOCKED_HOSTS = new Set(["localhost", "local", "metadata", "metadata.google.internal"]);

const SAFE_RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-language",
  "content-length",
  "content-type",
  "date",
  "etag",
  "expires",
  "last-modified",
  "request-id",
  "retry-after",
  "vary",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-request-id",
]);

export interface WorkerNetworkRequest {
  readonly url: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export interface WorkerNetworkResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly connectedAddress: string;
}

export interface WorkerNetworkPort {
  request(input: WorkerNetworkRequest): Promise<WorkerNetworkResponse>;
}

export type WorkerNetworkErrorCode =
  | "invalid_url"
  | "blocked_host"
  | "blocked_address"
  | "resolution_failed"
  | "connected_address_mismatch"
  | "redirect_denied"
  | "response_too_large"
  | "request_failed";

export class WorkerNetworkError extends Error {
  readonly code: WorkerNetworkErrorCode;

  constructor(code: WorkerNetworkErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkerNetworkError";
    this.code = code;
  }
}

interface WorkerNetworkConnectInput {
  readonly url: URL;
  readonly method: WorkerNetworkRequest["method"];
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly pinnedAddress: LookupAddress;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

type WorkerNetworkConnectResponse = WorkerNetworkResponse;

export interface WorkerNetworkClientDeps {
  readonly lookup: (hostname: string) => Promise<readonly LookupAddress[]>;
  readonly connect: (input: WorkerNetworkConnectInput) => Promise<WorkerNetworkConnectResponse>;
}

const defaultDeps: WorkerNetworkClientDeps = {
  lookup: (hostname) => dnsLookup(hostname, { all: true, order: "verbatim" }),
  connect: connectPinned,
};

export function createWorkerNetworkClient(
  deps: WorkerNetworkClientDeps = defaultDeps,
): WorkerNetworkPort {
  return {
    async request(input) {
      const url = validateWorkerNetworkUrl(input.url);
      const hostname = normalizeHostname(url.hostname);
      let addresses: readonly LookupAddress[];
      if (isIP(hostname)) {
        addresses = [{ address: hostname, family: isIP(hostname) }];
      } else {
        try {
          addresses = await deps.lookup(hostname);
        } catch (error) {
          throw new WorkerNetworkError(
            "resolution_failed",
            "Worker network host resolution failed.",
            { cause: error },
          );
        }
      }
      if (addresses.length === 0) {
        throw new WorkerNetworkError(
          "resolution_failed",
          "Worker network host did not resolve to an address.",
        );
      }
      for (const address of addresses) {
        assertPublicAddress(address.address);
      }

      const pinnedAddress = addresses[0];
      let response: WorkerNetworkConnectResponse;
      try {
        response = await deps.connect({
          url,
          method: input.method,
          headers: input.headers ?? {},
          ...(input.body === undefined ? {} : { body: input.body }),
          pinnedAddress,
          signal: input.signal,
          timeoutMs: boundedPositive(input.timeoutMs, DEFAULT_TIMEOUT_MS, 60_000),
          maxResponseBytes: boundedPositive(
            input.maxResponseBytes,
            DEFAULT_MAX_RESPONSE_BYTES,
            1024 * 1024,
          ),
        });
      } catch (error) {
        if (error instanceof WorkerNetworkError) throw error;
        throw new WorkerNetworkError("request_failed", "Worker network request failed.", {
          cause: error,
        });
      }

      assertPublicAddress(response.connectedAddress);
      if (!addressesEqual(pinnedAddress.address, response.connectedAddress)) {
        throw new WorkerNetworkError(
          "connected_address_mismatch",
          "Worker network connection address did not match its pinned DNS result.",
        );
      }
      if (response.status >= REDIRECT_STATUS_MIN && response.status <= REDIRECT_STATUS_MAX) {
        throw new WorkerNetworkError(
          "redirect_denied",
          "Worker network redirects are denied; grant and call the destination URL directly.",
        );
      }
      return response;
    },
  };
}

export function validateWorkerNetworkUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new WorkerNetworkError("invalid_url", "Worker network URL is invalid.", {
      cause: error,
    });
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new WorkerNetworkError("invalid_url", "Worker network URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new WorkerNetworkError("invalid_url", "Worker network URL credentials are not allowed.");
  }
  const host = normalizeHostname(url.hostname);
  if (!host || BLOCKED_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new WorkerNetworkError("blocked_host", "Worker network host is blocked.");
  }
  if (isIP(host)) assertPublicAddress(host);
  return url;
}

export function assertPublicAddress(address: string): void {
  const normalized = normalizeAddress(address);
  const family = isIP(normalized);
  if (family === 0) {
    throw new WorkerNetworkError(
      "blocked_address",
      "Worker network resolution returned an invalid address.",
    );
  }
  if (BLOCKED_ADDRESSES.check(normalized, family === 4 ? "ipv4" : "ipv6")) {
    throw new WorkerNetworkError(
      "blocked_address",
      "Worker network resolution returned a non-public address.",
    );
  }
}

function addressesEqual(expected: string, actual: string): boolean {
  const normalizedExpected = normalizeAddress(expected);
  const normalizedActual = normalizeAddress(actual);
  const family = isIP(normalizedExpected);
  if (family === 0 || family !== isIP(normalizedActual)) return false;
  const exact = new BlockList();
  exact.addAddress(normalizedExpected, family === 4 ? "ipv4" : "ipv6");
  return exact.check(normalizedActual, family === 4 ? "ipv4" : "ipv6");
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
}

function normalizeAddress(address: string): string {
  const withoutZone = address.trim().toLowerCase().split("%", 1)[0];
  const mapped = withoutZone.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  const mappedHex = withoutZone.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  }
  return withoutZone;
}

function boundedPositive(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), maximum);
}

function connectPinned(input: WorkerNetworkConnectInput): Promise<WorkerNetworkConnectResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, response?: WorkerNetworkConnectResponse): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(response!);
    };
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) {
        callback(null, [input.pinnedAddress]);
      } else {
        callback(null, input.pinnedAddress.address, input.pinnedAddress.family);
      }
    };
    const options: RequestOptions = {
      protocol: input.url.protocol,
      hostname: normalizeHostname(input.url.hostname),
      port: input.url.port || undefined,
      path: `${input.url.pathname}${input.url.search}`,
      method: input.method,
      headers: { ...input.headers },
      lookup,
      agent: false,
      signal: input.signal,
    };
    const requestFn = input.url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = requestFn(options, (response) => {
      const connectedAddress = response.socket.remoteAddress;
      if (!connectedAddress) {
        response.destroy();
        finish(
          new WorkerNetworkError(
            "request_failed",
            "Worker network connection did not expose its remote address.",
          ),
        );
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > input.maxResponseBytes) {
          response.destroy();
          request.destroy();
          finish(
            new WorkerNetworkError(
              "response_too_large",
              "Worker network response exceeded its byte limit.",
            ),
          );
          return;
        }
        chunks.push(buffer);
      });
      response.on("error", (error) => finish(error));
      response.on("end", () =>
        finish(null, {
          status: response.statusCode ?? 0,
          headers: safeHeaders(response.headers),
          body: Buffer.concat(chunks).toString("utf8"),
          connectedAddress,
        }),
      );
    });
    request.setTimeout(input.timeoutMs, () => {
      request.destroy(new Error("Worker network request timed out."));
    });
    request.on("error", (error) => finish(error));
    if (input.body !== undefined) request.write(input.body);
    request.end();
  });
}

function safeHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!SAFE_RESPONSE_HEADERS.has(name) || value === undefined) continue;
    safe[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return safe;
}

function createBlockedAddresses(): BlockList {
  const blocked = new BlockList();
  const ipv4Ranges: readonly [string, number][] = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  const ipv6Ranges: readonly [string, number][] = [
    ["::", 128],
    ["::1", 128],
    ["::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ];
  for (const [network, prefix] of ipv4Ranges) {
    blocked.addSubnet(network, prefix, "ipv4");
  }
  for (const [network, prefix] of ipv6Ranges) {
    blocked.addSubnet(network, prefix, "ipv6");
  }
  return blocked;
}

const BLOCKED_ADDRESSES = createBlockedAddresses();
