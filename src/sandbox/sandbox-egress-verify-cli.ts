import { ensureCodegenValidationImage } from "../codegen/validation-image.js";
import type { PacketAgentData } from "../packetagent-store.js";
import { SandboxService } from "./sandbox-service.js";
import { createJsonSandboxStore } from "./sandbox-store.js";

const data: Partial<PacketAgentData> = {};
const store = createJsonSandboxStore({
  loadStore: () => data as PacketAgentData,
  mutateStore: <T>(mutator: (current: PacketAgentData) => T): T => mutator(data as PacketAgentData),
});
let brokerCalls = 0;
const service = new SandboxService({
  store,
  forcedDriver: "docker",
  env: {
    ...process.env,
    PACKETAGENT_SANDBOX_DRIVER: "docker",
    PACKETAGENT_SANDBOX_EGRESS_ALLOWLIST: "https://example.com",
  },
  network: {
    async request(input) {
      brokerCalls += 1;
      if (
        input.method !== "GET" ||
        input.url !== "https://example.com/r5.4?proof=transient-value"
      ) {
        throw new Error("sandbox egress verifier received an unexpected broker request");
      }
      return {
        status: 200,
        headers: { "content-type": "text/plain" },
        body: "packetagent-brokered-input",
        connectedAddress: "93.184.216.34",
      };
    },
  },
});
const image = await ensureCodegenValidationImage();

const started = await service.startExec({
  workspaceId: "sandbox-egress-verifier",
  runtime: "codegen-node-22",
  requiredDriver: "docker",
  image,
  workingDir: "/tmp",
  timeoutMs: 10_000,
  egress: [
    {
      id: "proof",
      url: "https://example.com/r5.4?proof=transient-value",
    },
  ],
  command: [
    'test "$(cat /input/egress/proof)" = "packetagent-brokered-input"',
    "test -f /input/egress/_manifest.json",
    "if echo mutate >> /input/egress/proof 2>/dev/null; then exit 8; fi",
    "node -e \"const net=require('node:net'); const socket=net.connect({host:'1.1.1.1',port:80}); socket.on('connect',()=>process.exit(9)); socket.on('error',()=>console.log('network-denied')); setTimeout(()=>{socket.destroy(); console.log('network-denied');},1000).unref();\"",
  ].join(" && "),
});
const final = (await service.waitForExec(started.id)) ?? started;
const serialized = JSON.stringify(final);
const receipt = final.egress?.[0];
const result = {
  ok:
    brokerCalls === 1 &&
    final.status === "success" &&
    final.stdoutPreview?.includes("network-denied") === true &&
    final.networkPolicy === "brokered-prefetch" &&
    receipt?.status === "materialized" &&
    receipt.mountPath === "/input/egress/proof" &&
    receipt.target === "https://example.com/r5.4?[redacted]" &&
    receipt.byteLength === Buffer.byteLength("packetagent-brokered-input") &&
    !serialized.includes("transient-value"),
  brokerCalls,
  status: final.status,
  exitCode: final.exitCode ?? null,
  networkPolicy: final.networkPolicy,
  receipt,
  containerNetworkDenied: final.stdoutPreview?.includes("network-denied") === true,
  transientQueryPersisted: serialized.includes("transient-value"),
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
