import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import {
  createWorkerNetworkClient,
  WorkerNetworkError,
  type WorkerNetworkPort,
} from "../workers/network.js";
import {
  describeSandboxEgressConfig,
  materializeSandboxEgress,
  resolveSandboxEgressPlan,
} from "./sandbox-egress.js";

const allowlistEnv = {
  PACKETAGENT_SANDBOX_EGRESS_ALLOWLIST: "https://example.com,https://api.example.com:8443",
};

test("sandbox egress defaults to deny-all and exposes canonical operator limits", () => {
  assert.deepEqual(describeSandboxEgressConfig({}), {
    policy: "deny-all",
    allowedOrigins: [],
    maxFetches: 8,
    maxResponseBytes: 64 * 1024,
  });
  assert.deepEqual(describeSandboxEgressConfig(allowlistEnv).allowedOrigins, [
    "https://api.example.com:8443",
    "https://example.com",
  ]);
  assert.throws(
    () =>
      describeSandboxEgressConfig({
        PACKETAGENT_SANDBOX_EGRESS_ALLOWLIST: "https://example.com/private",
      }),
    /exact http\(s\) origins/,
  );
});

test("sandbox egress requires Docker, an operator origin, bounded unique ids, and safe URLs", () => {
  assert.throws(
    () => resolveSandboxEgressPlan([{ id: "docs", url: "https://example.com/data" }], {}, "docker"),
    /disabled/,
  );
  assert.throws(
    () =>
      resolveSandboxEgressPlan(
        [{ id: "docs", url: "https://example.com/data" }],
        allowlistEnv,
        "native",
      ),
    /only by the isolated Docker driver/,
  );
  assert.throws(
    () =>
      resolveSandboxEgressPlan(
        [{ id: "../escape", url: "https://example.com/data" }],
        allowlistEnv,
        "docker",
      ),
    /egress id/,
  );
  assert.throws(
    () =>
      resolveSandboxEgressPlan(
        [
          { id: "docs", url: "https://example.com/a" },
          { id: "docs", url: "https://example.com/b" },
        ],
        allowlistEnv,
        "docker",
      ),
    /duplicate/,
  );
  for (const url of [
    "https://sub.example.com/data",
    "https://example.com/data#fragment",
    "http://2130706433/",
    "http://[::ffff:127.0.0.1]/",
  ]) {
    assert.throws(() => resolveSandboxEgressPlan([{ id: "docs", url }], allowlistEnv, "docker"));
  }
});

test("sandbox egress materializes bounded GET responses and never persists query values", async () => {
  let requestedUrl = "";
  const network: WorkerNetworkPort = {
    async request(input) {
      requestedUrl = input.url;
      assert.equal(input.method, "GET");
      assert.equal(input.maxResponseBytes, 64 * 1024);
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: '{"ok":true}',
        connectedAddress: "93.184.216.34",
      };
    },
  };
  const plan = resolveSandboxEgressPlan(
    [{ id: "docs", url: "https://example.com/data?token=transient-secret" }],
    allowlistEnv,
    "docker",
  );
  assert.ok(plan);
  const materialized = await materializeSandboxEgress(plan, { network });
  const source = materialized.mount.source;
  try {
    assert.equal(requestedUrl, "https://example.com/data?token=transient-secret");
    assert.equal(await readFile(`${source}/docs`, "utf8"), '{"ok":true}');
    const manifest = await readFile(`${source}/_manifest.json`, "utf8");
    assert.doesNotMatch(manifest, /transient-secret/);
    assert.equal(materialized.mount.target, "/input/egress");
    assert.equal(materialized.mount.readOnly, true);
    assert.deepEqual(materialized.receipts[0], {
      id: "docs",
      target: "https://example.com/data?[redacted]",
      origin: "https://example.com",
      method: "GET",
      status: "materialized",
      mountPath: "/input/egress/docs",
      responseStatus: 200,
      contentType: "application/json",
      byteLength: 11,
      sha256: "4062edaf750fb8074e7e83e0c9028c94e32468a8b6f1614774328ef045150f93",
      connectedAddress: "93.184.216.34",
    });
  } finally {
    await materialized.cleanup();
  }
  await assert.rejects(access(source));
});

test("sandbox egress inherits W6 mixed-address, rebinding, and redirect denial", async () => {
  const plan = resolveSandboxEgressPlan(
    [{ id: "docs", url: "https://example.com/data" }],
    allowlistEnv,
    "docker",
  );
  assert.ok(plan);

  const cases: Array<{
    code: string;
    network: WorkerNetworkPort;
  }> = [
    {
      code: "blocked_address",
      network: createWorkerNetworkClient({
        lookup: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
        connect: async () => {
          throw new Error("must not connect");
        },
      }),
    },
    {
      code: "connected_address_mismatch",
      network: createWorkerNetworkClient({
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        connect: async () => ({
          status: 200,
          headers: {},
          body: "no",
          connectedAddress: "93.184.216.35",
        }),
      }),
    },
    {
      code: "redirect_denied",
      network: createWorkerNetworkClient({
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        connect: async (input) => ({
          status: 302,
          headers: {},
          body: "",
          connectedAddress: input.pinnedAddress.address,
        }),
      }),
    },
  ];

  for (const item of cases) {
    await assert.rejects(
      materializeSandboxEgress(plan, { network: item.network }),
      (error: unknown) => error instanceof WorkerNetworkError && error.code === item.code,
    );
  }
});

test("sandbox egress independently rejects oversized or non-success injected responses", async () => {
  const plan = resolveSandboxEgressPlan(
    [{ id: "docs", url: "https://example.com/data" }],
    { ...allowlistEnv, PACKETAGENT_SANDBOX_EGRESS_MAX_RESPONSE_BYTES: "1024" },
    "docker",
  );
  assert.ok(plan);
  const response = {
    headers: {},
    connectedAddress: "93.184.216.34",
  };
  await assert.rejects(
    materializeSandboxEgress(plan, {
      network: {
        request: async () => ({ ...response, status: 200, body: "x".repeat(1025) }),
      },
    }),
    /response byte limit/,
  );
  await assert.rejects(
    materializeSandboxEgress(plan, {
      network: {
        request: async () => ({ ...response, status: 404, body: "" }),
      },
    }),
    /non-success/,
  );
});

test("sandbox egress caps aggregate materialized bytes across declarations", async () => {
  const plan = resolveSandboxEgressPlan(
    [
      { id: "first", url: "https://example.com/first" },
      { id: "second", url: "https://example.com/second" },
    ],
    {
      ...allowlistEnv,
      PACKETAGENT_SANDBOX_EGRESS_MAX_RESPONSE_BYTES: String(300 * 1024),
    },
    "docker",
  );
  assert.ok(plan);
  await assert.rejects(
    materializeSandboxEgress(plan, {
      network: {
        request: async () => ({
          status: 200,
          headers: {},
          body: "x".repeat(300 * 1024),
          connectedAddress: "93.184.216.34",
        }),
      },
    }),
    /total byte limit/,
  );
});
