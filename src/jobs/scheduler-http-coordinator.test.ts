import assert from "node:assert/strict";
import test from "node:test";
import { httpLeaderLock } from "./scheduler-http-coordinator.js";

interface CapturedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function recordingFetch(handler: (call: CapturedCall) => Response | Promise<Response>) {
  const calls: CapturedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? {});
    const rawBody = init?.body;
    const body = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
    const call: CapturedCall = { url, method, headers, body };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
}

test("acquire posts to <url>/acquire with the expected JSON body", async () => {
  const { fetchImpl, calls } = recordingFetch(() => jsonResponse(200, { leader: true }));
  const lock = httpLeaderLock({
    url: "https://coord.example.com/leader/",
    processId: "process-a",
    ttlMs: 30000,
    fetchImpl,
    now: () => 1717000000000,
  });

  const result = await lock.acquire();
  assert.equal(result, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://coord.example.com/leader/acquire");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers.get("content-type"), "application/json");
  assert.deepEqual(calls[0].body, {
    processId: "process-a",
    ttlMs: 30000,
    timestamp: 1717000000000,
  });
});

test("acquire includes Authorization header when secret is set", async () => {
  const { fetchImpl, calls } = recordingFetch(() => jsonResponse(200, { leader: true }));
  const lock = httpLeaderLock({
    url: "https://coord.example.com",
    processId: "process-a",
    ttlMs: 1000,
    secret: "shhh",
    fetchImpl,
  });

  await lock.acquire();
  assert.equal(calls[0].headers.get("authorization"), "Bearer shhh");
});

test("acquire omits Authorization header when secret is not set", async () => {
  const { fetchImpl, calls } = recordingFetch(() => jsonResponse(200, { leader: true }));
  const lock = httpLeaderLock({
    url: "https://coord.example.com",
    processId: "process-a",
    ttlMs: 1000,
    fetchImpl,
  });

  await lock.acquire();
  assert.equal(calls[0].headers.get("authorization"), null);
});

test("acquire returns true and isHeld is true on 200 leader:true", async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse(200, { leader: true }));
  const lock = httpLeaderLock({ url: "https://coord", processId: "p", ttlMs: 1000, fetchImpl });

  const result = await lock.acquire();
  assert.equal(result, true);
  assert.equal(lock.isHeld(), true);
});

test("acquire returns true on 200 acquired:true (alternate field)", async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse(200, { acquired: true }));
  const lock = httpLeaderLock({ url: "https://coord", processId: "p", ttlMs: 1000, fetchImpl });

  const result = await lock.acquire();
  assert.equal(result, true);
  assert.equal(lock.isHeld(), true);
});

test("acquire returns false on 200 leader:false", async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse(200, { leader: false }));
  const lock = httpLeaderLock({ url: "https://coord", processId: "p", ttlMs: 1000, fetchImpl });

  const result = await lock.acquire();
  assert.equal(result, false);
  assert.equal(lock.isHeld(), false);
});

test("acquire returns false on 409 conflict", async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse(409, { leader: false }));
  const lock = httpLeaderLock({ url: "https://coord", processId: "p", ttlMs: 1000, fetchImpl });

  const result = await lock.acquire();
  assert.equal(result, false);
  assert.equal(lock.isHeld(), false);
});

test("acquire throws on 401 and 403 even with failOpen", async () => {
  for (const status of [401, 403]) {
    const { fetchImpl } = recordingFetch(() => jsonResponse(status, { error: "nope" }));
    const lock = httpLeaderLock({
      url: "https://coord",
      processId: "p",
      ttlMs: 1000,
      fetchImpl,
      failOpen: true,
    });

    await assert.rejects(
      () => lock.acquire(),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(String(status)));
        return true;
      },
    );
  }
});

test("acquire returns false on network error when failOpen is false (default)", async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error("network down");
  };
  const lock = httpLeaderLock({ url: "https://coord", processId: "p", ttlMs: 1000, fetchImpl });

  const result = await lock.acquire();
  assert.equal(result, false);
  assert.equal(lock.isHeld(), false);
});

test("acquire preserves held flag on network error when failOpen is true", async () => {
  let mode: "ok" | "error" = "ok";
  const fetchImpl: typeof fetch = async () => {
    if (mode === "error") throw new Error("network down");
    return jsonResponse(200, { leader: true });
  };
  const lock = httpLeaderLock({
    url: "https://coord",
    processId: "p",
    ttlMs: 1000,
    fetchImpl,
    failOpen: true,
  });

  assert.equal(await lock.acquire(), true);
  assert.equal(lock.isHeld(), true);

  mode = "error";
  const result = await lock.acquire();
  assert.equal(result, true);
  assert.equal(lock.isHeld(), true);
});

test("acquire honors timeoutMs when fetch never resolves", async () => {
  let observedAbort = false;
  const fetchImpl: typeof fetch = (_input, init) =>
    new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => {
        observedAbort = true;
        reject(new Error("aborted"));
      });
    });
  const lock = httpLeaderLock({
    url: "https://coord",
    processId: "p",
    ttlMs: 1000,
    timeoutMs: 5,
    fetchImpl,
  });

  const result = await lock.acquire();
  assert.equal(result, false);
  assert.equal(observedAbort, true);
});

test("release posts to <url>/release only when previously held", async () => {
  let acquireCount = 0;
  let releaseCount = 0;
  const releaseCalls: CapturedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    if (url.endsWith("/acquire")) {
      acquireCount += 1;
      return jsonResponse(200, { leader: true });
    }
    releaseCount += 1;
    const headers = new Headers(init?.headers ?? {});
    const rawBody = init?.body;
    const body = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
    releaseCalls.push({ url, method: (init?.method ?? "GET").toUpperCase(), headers, body });
    return jsonResponse(200, {});
  };

  const lock = httpLeaderLock({
    url: "https://coord/",
    processId: "process-a",
    ttlMs: 1000,
    fetchImpl,
    now: () => 42,
  });

  await lock.release();
  assert.equal(releaseCount, 0);
  assert.equal(lock.isHeld(), false);

  assert.equal(await lock.acquire(), true);
  assert.equal(acquireCount, 1);

  await lock.release();
  assert.equal(releaseCount, 1);
  assert.equal(releaseCalls[0].url, "https://coord/release");
  assert.equal(releaseCalls[0].method, "POST");
  assert.deepEqual(releaseCalls[0].body, { processId: "process-a", timestamp: 42 });
  assert.equal(lock.isHeld(), false);
});

test("release swallows fetch errors and always sets isHeld to false", async () => {
  let acquired = false;
  const fetchImpl: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    if (url.endsWith("/acquire")) {
      acquired = true;
      return jsonResponse(200, { leader: true });
    }
    throw new Error("network down");
  };

  const lock = httpLeaderLock({ url: "https://coord", processId: "p", ttlMs: 1000, fetchImpl });
  assert.equal(await lock.acquire(), true);
  assert.ok(acquired);
  assert.equal(lock.isHeld(), true);

  await lock.release();
  assert.equal(lock.isHeld(), false);
});
