import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttpFetchTool, httpFetchTool, type HttpFetchMethod } from "../http-fetch.js";
import { toolCapabilityRisk } from "../approval.js";
import type { ToolContext } from "../types.js";

function ctx(signal = new AbortController().signal): ToolContext {
  return { workspaceId: "w", userId: "u", signal };
}

test("exports http_fetch as a write-side tool because it supports mutating HTTP methods", () => {
  assert.equal(httpFetchTool.name, "http_fetch");
  assert.equal(httpFetchTool.side, "write");
  assert.equal(toolCapabilityRisk(httpFetchTool), "medium");
  assert.equal(httpFetchTool.timeoutMs, 15_000);
});

test("GET appends query, sends headers and signal, and returns JSON with safe headers", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ ok: true, count: 2 }), {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        "set-cookie": "session=secret-cookie",
        "x-request-id": "req_123",
      },
    });
  };
  const tool = createHttpFetchTool({ fetchImpl });
  const ctrl = new AbortController();

  const result = await tool.handle({
    url: "https://api.example.com/v1/items?existing=1",
    headers: { authorization: "Bearer secret-token", "x-client": "packetagent" },
    query: { q: "search", page: 2, active: true, skip: null, tag: ["a", "b"] },
  }, ctx(ctrl.signal));

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.com/v1/items?existing=1&q=search&page=2&active=true&tag=a&tag=b");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.signal, ctrl.signal);
  const requestHeaders = calls[0].init.headers as Headers;
  assert.equal(requestHeaders.get("authorization"), "Bearer secret-token");
  assert.equal(requestHeaders.get("x-client"), "packetagent");

  const output = result.output as {
    status: number;
    contentType: string;
    headers: Record<string, string>;
    body: string;
    bodyTruncated: boolean;
    json: unknown;
  };
  assert.equal(output.status, 200);
  assert.equal(output.contentType, "application/json; charset=utf-8");
  assert.deepEqual(output.json, { ok: true, count: 2 });
  assert.equal(output.headers["cache-control"], "no-store");
  assert.equal(output.headers["x-request-id"], "req_123");
  assert.equal(output.headers["set-cookie"], undefined);
  assert.equal(output.bodyTruncated, false);
  assert.doesNotMatch(JSON.stringify(output), /secret-token|secret-cookie/);
});

test("POST JSON body sets content type and returns HTTP errors with output", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response("try later", {
      status: 503,
      headers: {
        "content-type": "text/plain",
        "retry-after": "30",
      },
    });
  };
  const tool = createHttpFetchTool({ fetchImpl });

  const result = await tool.handle({
    url: "https://api.example.com/jobs",
    method: "POST",
    json: { name: "nightly", enabled: true },
  }, ctx());

  assert.equal(result.ok, false);
  assert.equal(result.error, "HTTP 503");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, JSON.stringify({ name: "nightly", enabled: true }));
  assert.equal((calls[0].init.headers as Headers).get("content-type"), "application/json");

  const output = result.output as { status: number; headers: Record<string, string>; body: string };
  assert.equal(output.status, 503);
  assert.equal(output.headers["retry-after"], "30");
  assert.equal(output.body, "try later");
});

test("supports PUT, PATCH, and DELETE with raw string bodies", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response("ok", { status: 200 });
  };
  const tool = createHttpFetchTool({ fetchImpl });

  for (const method of ["PUT", "PATCH", "DELETE"] satisfies HttpFetchMethod[]) {
    const result = await tool.handle({
      url: `https://api.example.com/${method.toLowerCase()}`,
      method,
      body: `raw ${method}`,
    }, ctx());
    assert.equal(result.ok, true);
  }

  assert.deepEqual(calls.map((call) => [call.init.method, call.init.body]), [
    ["PUT", "raw PUT"],
    ["PATCH", "raw PATCH"],
    ["DELETE", "raw DELETE"],
  ]);
});

test("rejects ambiguous or unsupported request inputs before fetch", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response("unexpected");
  };
  const tool = createHttpFetchTool({ fetchImpl });

  const bothBodies = await tool.handle({
    url: "https://api.example.com",
    method: "POST",
    body: "raw",
    json: { raw: false },
  }, ctx());
  assert.equal(bothBodies.ok, false);
  assert.match(bothBodies.error ?? "", /either json or body/);

  const getBody = await tool.handle({
    url: "https://api.example.com",
    method: "GET",
    body: "raw",
  }, ctx());
  assert.equal(getBody.ok, false);
  assert.match(getBody.error ?? "", /GET requests cannot include a body/);

  const badMethod = await tool.handle({
    url: "https://api.example.com",
    method: "HEAD" as HttpFetchMethod,
  }, ctx());
  assert.equal(badMethod.ok, false);
  assert.match(badMethod.error ?? "", /not allowed/);
  assert.equal(calls, 0);
});

test("blocks unsafe URL targets before fetch", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response("unexpected");
  };
  const tool = createHttpFetchTool({ fetchImpl });

  const blockedUrls = [
    "file:///tmp/packetagent",
    "http://localhost/status",
    "http://service.local/status",
    "http://127.0.0.1/status",
    "http://10.1.2.3/status",
    "http://172.16.0.10/status",
    "http://172.31.255.255/status",
    "http://192.168.1.5/status",
    "http://169.254.169.254/latest/meta-data",
    "http://metadata.google.internal/computeMetadata/v1",
    "http://[::1]/status",
    "http://[fe80::1]/status",
    "http://[fc00::1]/status",
    "http://[::ffff:192.168.1.1]/status",
  ];

  for (const url of blockedUrls) {
    const result = await tool.handle({ url }, ctx());
    assert.equal(result.ok, false, url);
    assert.match(result.error ?? "", /blocked|protocol/, url);
  }
  assert.equal(calls, 0);
});

test("redacts sensitive request header values from fetch errors", async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error("connect failed with Bearer top-secret-token and api-key-123");
  };
  const tool = createHttpFetchTool({ fetchImpl });

  const result = await tool.handle({
    url: "https://api.example.com/private",
    headers: {
      authorization: "Bearer top-secret-token",
      "x-api-key": "api-key-123",
      "x-safe": "visible",
    },
  }, ctx());

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /fetch failed/);
  assert.doesNotMatch(result.error ?? "", /top-secret-token|api-key-123/);
  assert.match(result.error ?? "", /\[redacted\]/);
});

test("truncates large response bodies and skips JSON parsing when truncated", async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ message: "hello" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const tool = createHttpFetchTool({ fetchImpl, maxBodyChars: 6 });

  const result = await tool.handle({ url: "https://api.example.com/large" }, ctx());

  assert.equal(result.ok, true);
  const output = result.output as { body: string; bodyTruncated: boolean; json?: unknown };
  assert.equal(output.body, "{\"mess\n...[truncated]");
  assert.equal(output.bodyTruncated, true);
  assert.equal(output.json, undefined);
});
