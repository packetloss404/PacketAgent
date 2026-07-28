import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPublicAddress,
  createWorkerNetworkClient,
  validateWorkerNetworkUrl,
  WorkerNetworkError,
} from "./network.js";

const signal = new AbortController().signal;

test("Worker network URL and address validation rejects local and special destinations", () => {
  for (const url of [
    "file:///etc/passwd",
    "http://user:password@example.com/",
    "http://localhost/",
    "http://service.local/",
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://[::1]/",
    "http://169.254.169.254/latest/meta-data/",
  ]) {
    assert.throws(
      () => validateWorkerNetworkUrl(url),
      (error: unknown) => error instanceof WorkerNetworkError,
      url,
    );
  }

  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff00::1",
    "2001:db8::1",
  ]) {
    assert.throws(
      () => assertPublicAddress(address),
      (error: unknown) => error instanceof WorkerNetworkError && error.code === "blocked_address",
      address,
    );
  }

  assert.doesNotThrow(() => assertPublicAddress("93.184.216.34"));
  assert.doesNotThrow(() => assertPublicAddress("2606:2800:220:1:248:1893:25c8:1946"));
});

test("Worker network rejects a hostname when any A or AAAA result is non-public", async () => {
  let connected = false;
  const client = createWorkerNetworkClient({
    lookup: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ],
    connect: async () => {
      connected = true;
      throw new Error("must not connect");
    },
  });

  await assert.rejects(
    client.request({
      url: "https://example.com/",
      method: "GET",
      signal,
    }),
    (error: unknown) => error instanceof WorkerNetworkError && error.code === "blocked_address",
  );
  assert.equal(connected, false);
});

test("Worker network pins the chosen address and rejects DNS rebinding at connect time", async () => {
  const client = createWorkerNetworkClient({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    connect: async (input) => ({
      status: 200,
      headers: { "content-type": "text/plain" },
      body: "unexpected",
      connectedAddress:
        input.pinnedAddress.address === "93.184.216.34"
          ? "93.184.216.35"
          : input.pinnedAddress.address,
    }),
  });

  await assert.rejects(
    client.request({
      url: "https://example.com/",
      method: "GET",
      signal,
    }),
    (error: unknown) =>
      error instanceof WorkerNetworkError && error.code === "connected_address_mismatch",
  );
});

test("Worker network denies redirects and returns a bounded direct response", async () => {
  let status = 302;
  const client = createWorkerNetworkClient({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    connect: async (input) => ({
      status,
      headers: {
        "content-type": "application/json",
        location: "http://127.0.0.1/",
      },
      body: status === 200 ? '{"ok":true}' : "",
      connectedAddress: input.pinnedAddress.address,
    }),
  });

  await assert.rejects(
    client.request({
      url: "https://example.com/",
      method: "GET",
      signal,
    }),
    (error: unknown) => error instanceof WorkerNetworkError && error.code === "redirect_denied",
  );

  status = 200;
  const response = await client.request({
    url: "https://example.com/",
    method: "GET",
    signal,
  });
  assert.equal(response.status, 200);
  assert.equal(response.connectedAddress, "93.184.216.34");
  assert.equal(response.body, '{"ok":true}');
});

test("Worker network accepts a public IPv6 literal without invoking DNS", async () => {
  let lookedUp = false;
  const address = "2606:2800:220:1:248:1893:25c8:1946";
  const client = createWorkerNetworkClient({
    lookup: async () => {
      lookedUp = true;
      return [];
    },
    connect: async (input) => ({
      status: 204,
      headers: {},
      body: "",
      connectedAddress: input.pinnedAddress.address,
    }),
  });
  const response = await client.request({
    url: `https://[${address}]/`,
    method: "GET",
    signal,
  });
  assert.equal(response.status, 204);
  assert.equal(lookedUp, false);
});
