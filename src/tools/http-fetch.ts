import { isIP } from "node:net";
import { inputAuthorization } from "./authorization.js";
import type { ToolDefinition } from "./types.js";

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const DEFAULT_MAX_BODY_CHARS = 16_384;
const TRUNCATION_MARKER = "\n...[truncated]";

const SAFE_RESPONSE_HEADERS = [
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
] as const;

const METADATA_HOSTS = new Set(["metadata", "metadata.google.internal"]);

const SENSITIVE_HEADER_NAME_PATTERN =
  /(^|[-_])(authorization|cookie|credential|key|password|secret|session|token)([-_]|$)|proxy-authorization/i;

export type HttpFetchMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface HttpFetchInput extends Record<string, unknown> {
  url: string;
  method?: HttpFetchMethod;
  credentialRef?: string;
  headers?: Record<string, string>;
  query?: Record<string, QueryValue>;
  json?: unknown;
  body?: string;
}

export type QueryScalar = string | number | boolean | null | undefined;
export type QueryValue = QueryScalar | QueryScalar[];

export interface CreateHttpFetchToolOptions {
  fetchImpl?: typeof fetch;
  maxBodyChars?: number;
}

interface NormalizedRequest {
  url: string;
  method: HttpFetchMethod;
  headers: Headers;
  body?: string;
  sensitiveHeaderValues: string[];
}

type NormalizeResult = { ok: true; request: NormalizedRequest } | { ok: false; error: string };

export function createHttpFetchTool(
  options: CreateHttpFetchToolOptions = {},
): ToolDefinition<HttpFetchInput> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBodyChars = options.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;

  return {
    name: "http_fetch",
    description:
      "Fetch an http(s) URL with GET, POST, PUT, PATCH, or DELETE and return a safe, truncated response summary.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", format: "uri" },
        method: { type: "string", enum: [...ALLOWED_METHODS], default: "GET" },
        credentialRef: {
          type: "string",
          description: "Opaque vault: reference used as a Bearer credential for Worker calls.",
        },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        query: {
          type: "object",
          additionalProperties: {
            oneOf: [
              { type: "string" },
              { type: "number" },
              { type: "boolean" },
              { type: "null" },
              {
                type: "array",
                items: {
                  oneOf: [
                    { type: "string" },
                    { type: "number" },
                    { type: "boolean" },
                    { type: "null" },
                  ],
                },
              },
            ],
          },
        },
        json: {},
        body: { type: "string" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    side: "write",
    effect: {
      describe(input) {
        const method = String(input.method ?? "GET").toUpperCase();
        return {
          classification:
            method === "GET"
              ? ("read_only" as const)
              : method === "PUT" || method === "DELETE"
                ? ("idempotent_mutation" as const)
                : ("non_replayable_mutation" as const),
          operation: `http.${method.toLowerCase()}`,
        };
      },
    },
    authorization: inputAuthorization((input: HttpFetchInput) => {
      const method = String(input.method ?? "GET").toUpperCase();
      return {
        verb: method,
        effect: method === "GET" ? "read" : "write",
        resources: [typeof input.url === "string" ? input.url : ""],
      };
    }),
    timeoutMs: 15_000,
    async handle(input, ctx) {
      const normalized = normalizeRequest(input);
      if (!normalized.ok) return { ok: false, error: normalized.error };

      const request = normalized.request;
      if (ctx.effectKey && request.method !== "GET" && !request.headers.has("idempotency-key")) {
        request.headers.set("idempotency-key", ctx.effectKey);
      }
      if (ctx.worker) {
        const services = ctx.worker.services;
        if (!services) {
          return { ok: false, error: "Worker runtime security services are unavailable." };
        }
        if (request.sensitiveHeaderValues.length > 0) {
          return {
            ok: false,
            error: "Worker HTTP calls reject raw sensitive headers; use credentialRef.",
          };
        }
        const execute = async () => {
          const response = await services.network.request({
            url: request.url,
            method: request.method,
            headers: Object.fromEntries(request.headers.entries()),
            ...(request.body === undefined ? {} : { body: request.body }),
            signal: ctx.signal,
            maxResponseBytes: maxBodyChars + Buffer.byteLength(TRUNCATION_MARKER),
          });
          return summarizeResponse(
            response.status,
            new Headers(response.headers),
            response.body,
            maxBodyChars,
          );
        };
        try {
          if (input.credentialRef !== undefined) {
            if (typeof input.credentialRef !== "string" || !input.credentialRef.trim()) {
              return { ok: false, error: "credentialRef must be an opaque vault: reference." };
            }
            return await services.credentials.use(
              input.credentialRef,
              ["api_key", "bearer_token", "opaque"],
              async (value) => {
                request.headers.set("authorization", `Bearer ${value}`);
                return execute();
              },
            );
          }
          return await execute();
        } catch (error) {
          if (ctx.signal.aborted) throw error;
          return { ok: false, error: `fetch failed: ${errorMessage(error)}` };
        }
      }
      if (input.credentialRef !== undefined) {
        return {
          ok: false,
          error: "credentialRef is available only to the hardened Worker runtime.",
        };
      }
      let response: Response;
      try {
        response = await fetchImpl(request.url, {
          method: request.method,
          headers: request.headers,
          ...(request.body === undefined ? {} : { body: request.body }),
          redirect: "manual",
          signal: ctx.signal,
        });
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        return {
          ok: false,
          error: `fetch failed: ${redactSensitiveValues(errorMessage(error), request.sensitiveHeaderValues)}`,
        };
      }

      let rawBody: string;
      try {
        rawBody = await response.text();
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        return {
          ok: false,
          error: `failed to read response body: ${redactSensitiveValues(errorMessage(error), request.sensitiveHeaderValues)}`,
        };
      }

      return summarizeResponse(response.status, response.headers, rawBody, maxBodyChars);
    },
  };
}

function summarizeResponse(
  status: number,
  headers: Headers,
  rawBody: string,
  maxBodyChars: number,
): { ok: boolean; output: Record<string, unknown>; error?: string } {
  const bodyInfo = truncateBody(rawBody, maxBodyChars);
  const output: Record<string, unknown> = {
    status,
    contentType: headers.get("content-type") ?? "",
    headers: collectSafeResponseHeaders(headers),
    body: bodyInfo.body,
    bodyTruncated: bodyInfo.truncated,
  };
  if (!bodyInfo.truncated) {
    const parsedJson = parseJson(rawBody);
    if (parsedJson.ok) output.json = parsedJson.value;
  }
  const ok = status >= 200 && status < 300;
  return { ok, output, ...(ok ? {} : { error: `HTTP ${status}` }) };
}

export const httpFetchTool = createHttpFetchTool();

function normalizeRequest(input: HttpFetchInput): NormalizeResult {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "input must be an object" };
  }

  if (typeof input.url !== "string" || input.url.trim() === "") {
    return { ok: false, error: "url is required" };
  }

  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return { ok: false, error: `invalid url: ${input.url}` };
  }

  const urlError = validateUrl(parsed);
  if (urlError) return { ok: false, error: urlError };

  const methodInput = input.method ?? "GET";
  if (typeof methodInput !== "string") {
    return { ok: false, error: "method must be a string" };
  }
  const method = methodInput.toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    return { ok: false, error: `method ${methodInput} is not allowed` };
  }

  const queryError = appendQuery(parsed, input.query);
  if (queryError) return { ok: false, error: queryError };

  const headerResult = normalizeHeaders(input.headers);
  if (!headerResult.ok) return headerResult;

  const hasJson = Object.prototype.hasOwnProperty.call(input, "json") && input.json !== undefined;
  const hasBody = Object.prototype.hasOwnProperty.call(input, "body") && input.body !== undefined;
  if (hasJson && hasBody) {
    return { ok: false, error: "provide either json or body, not both" };
  }
  if (method === "GET" && (hasJson || hasBody)) {
    return { ok: false, error: "GET requests cannot include a body" };
  }

  let body: string | undefined;
  if (hasJson) {
    try {
      body = JSON.stringify(input.json);
    } catch (error) {
      return { ok: false, error: `json body could not be serialized: ${errorMessage(error)}` };
    }
    if (!headerResult.headers.has("content-type")) {
      headerResult.headers.set("content-type", "application/json");
    }
  } else if (hasBody) {
    if (typeof input.body !== "string") {
      return { ok: false, error: "body must be a string" };
    }
    body = input.body;
  }

  return {
    ok: true,
    request: {
      url: parsed.toString(),
      method: method as HttpFetchMethod,
      headers: headerResult.headers,
      body,
      sensitiveHeaderValues: headerResult.sensitiveHeaderValues,
    },
  };
}

function validateUrl(parsed: URL): string | null {
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `protocol ${parsed.protocol} not allowed; must be http or https`;
  }
  if (parsed.username || parsed.password) {
    return "url credentials are not allowed";
  }

  const host = normalizeHost(parsed.hostname);
  if (!host) return "url host is required";

  if (isBlockedHostname(host)) {
    return `host ${host} is blocked from tool fetch`;
  }

  const ipVersion = isIP(host);
  if (ipVersion === 4 && isBlockedIPv4(host)) {
    return `host ${host} is blocked from tool fetch`;
  }
  if (ipVersion === 6 && isBlockedIPv6(host)) {
    return `host ${host} is blocked from tool fetch`;
  }

  return null;
}

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
}

function isBlockedHostname(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "local" ||
    host.endsWith(".local") ||
    METADATA_HOSTS.has(host)
  );
}

function isBlockedIPv4(address: string): boolean {
  const octets = address.split(".").map((part) => Number(part));
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }

  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function isBlockedIPv6(address: string): boolean {
  const hextets = expandIPv6(address);
  if (!hextets) return true;

  const first = hextets[0];
  const isUnspecified = hextets.every((part) => part === 0);
  const isLoopback = hextets.slice(0, 7).every((part) => part === 0) && hextets[7] === 1;
  const isUniqueLocal = (first & 0xfe00) === 0xfc00;
  const isLinkLocal = (first & 0xffc0) === 0xfe80;
  const isIPv4Mapped = hextets.slice(0, 5).every((part) => part === 0) && hextets[5] === 0xffff;
  const isIPv4Compatible =
    hextets.slice(0, 6).every((part) => part === 0) && !isUnspecified && !isLoopback;

  if (isUnspecified || isLoopback || isUniqueLocal || isLinkLocal) return true;

  if (isIPv4Mapped || isIPv4Compatible) {
    const mapped = [hextets[6] >> 8, hextets[6] & 0xff, hextets[7] >> 8, hextets[7] & 0xff].join(
      ".",
    );
    return isBlockedIPv4(mapped);
  }

  return false;
}

function expandIPv6(address: string): number[] | null {
  if (address.includes("%")) return null;

  const pieces = address.split("::");
  if (pieces.length > 2) return null;

  const left = pieces[0] ? parseHextets(pieces[0].split(":")) : [];
  const right = pieces.length === 2 && pieces[1] ? parseHextets(pieces[1].split(":")) : [];
  if (!left || !right) return null;

  if (pieces.length === 1) {
    return left.length === 8 ? left : null;
  }

  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function parseHextets(parts: string[]): number[] | null {
  const parsed: number[] = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    parsed.push(Number.parseInt(part, 16));
  }
  return parsed;
}

function appendQuery(parsed: URL, query: HttpFetchInput["query"]): string | null {
  if (query === undefined) return null;
  if (!query || typeof query !== "object" || Array.isArray(query)) {
    return "query must be an object";
  }

  for (const [key, value] of Object.entries(query)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item === null || item === undefined) continue;
      if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
        return `query parameter ${key} must be a string, number, boolean, null, or an array of those values`;
      }
      parsed.searchParams.append(key, String(item));
    }
  }

  return null;
}

function normalizeHeaders(
  headersInput: HttpFetchInput["headers"],
): { ok: true; headers: Headers; sensitiveHeaderValues: string[] } | { ok: false; error: string } {
  const headers = new Headers();
  const sensitiveHeaderValues: string[] = [];
  if (headersInput === undefined) return { ok: true, headers, sensitiveHeaderValues };
  if (!headersInput || typeof headersInput !== "object" || Array.isArray(headersInput)) {
    return { ok: false, error: "headers must be an object" };
  }

  for (const [name, value] of Object.entries(headersInput)) {
    if (typeof value !== "string") {
      return { ok: false, error: `header ${name} must be a string` };
    }
    const isSensitive = isSensitiveHeaderName(name) && value;
    try {
      headers.set(name, value);
    } catch (error) {
      const message = isSensitive
        ? redactSensitiveValues(errorMessage(error), [value])
        : errorMessage(error);
      return { ok: false, error: `invalid request header ${name}: ${message}` };
    }
    if (isSensitive) {
      sensitiveHeaderValues.push(value);
    }
  }

  return { ok: true, headers, sensitiveHeaderValues };
}

function isSensitiveHeaderName(name: string): boolean {
  return SENSITIVE_HEADER_NAME_PATTERN.test(name);
}

function collectSafeResponseHeaders(headers: Headers): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const name of SAFE_RESPONSE_HEADERS) {
    const value = headers.get(name);
    if (value !== null) selected[name] = value;
  }
  return selected;
}

function truncateBody(rawBody: string, maxBodyChars: number): { body: string; truncated: boolean } {
  const safeMax = Math.max(0, maxBodyChars);
  if (rawBody.length <= safeMax) return { body: rawBody, truncated: false };
  return { body: `${rawBody.slice(0, safeMax)}${TRUNCATION_MARKER}`, truncated: true };
}

function parseJson(rawBody: string): { ok: true; value: unknown } | { ok: false } {
  if (rawBody.trim() === "") return { ok: false };
  try {
    return { ok: true, value: JSON.parse(rawBody) };
  } catch {
    return { ok: false };
  }
}

function redactSensitiveValues(text: string, sensitiveValues: string[]): string {
  let redacted = text;
  for (const value of sensitiveValues) {
    redacted = redacted.split(value).join("[redacted]");
  }
  return redacted;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
