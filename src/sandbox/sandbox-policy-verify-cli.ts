import { ensureCodegenValidationImage } from "../codegen/validation-image.js";
import { getDefaultSandboxService } from "./sandbox-service.js";

const service = getDefaultSandboxService();
const image = await ensureCodegenValidationImage();

const boundary = await service.startExec({
  workspaceId: "sandbox-policy-verifier",
  runtime: "codegen-node-22",
  requiredDriver: "docker",
  image,
  workingDir: "/tmp",
  timeoutMs: 10_000,
  env: { R53_MARKER: "visible" },
  command: [
    "if touch /packetagent-root-write 2>/dev/null; then exit 8; fi",
    "touch /tmp/packetagent-write",
    'test "$R53_MARKER" = "visible"',
    "node -e \"const net=require('node:net'); const socket=net.connect({host:'1.1.1.1',port:80}); socket.on('connect',()=>process.exit(9)); socket.on('error',()=>console.log('network-denied')); setTimeout(()=>{socket.destroy(); console.log('network-denied');},1000).unref();\"",
  ].join(" && "),
});
const boundaryFinal = (await service.waitForExec(boundary.id)) ?? boundary;

const timeout = await service.startExec({
  workspaceId: "sandbox-policy-verifier",
  runtime: "codegen-node-22",
  requiredDriver: "docker",
  image,
  workingDir: "/tmp",
  timeoutMs: 1_000,
  command: 'node -e "setTimeout(() => {}, 5000)"',
});
const timeoutFinal = (await service.waitForExec(timeout.id)) ?? timeout;

const result = {
  ok:
    boundaryFinal.status === "success" &&
    boundaryFinal.stdoutPreview?.includes("network-denied") === true &&
    boundaryFinal.env?.R53_MARKER === "[redacted]" &&
    boundaryFinal.networkPolicy === "none" &&
    boundaryFinal.filesystemPolicy === "read-only-root+bounded-tmpfs" &&
    timeoutFinal.status === "timeout",
  boundary: {
    status: boundaryFinal.status,
    exitCode: boundaryFinal.exitCode ?? null,
    networkPolicy: boundaryFinal.networkPolicy,
    filesystemPolicy: boundaryFinal.filesystemPolicy,
    environmentPolicy: boundaryFinal.environmentPolicy,
    wallClockTimeoutMs: boundaryFinal.wallClockTimeoutMs,
    cpuLimit: boundaryFinal.cpuLimit,
    memoryLimitMb: boundaryFinal.memoryLimitMb,
    processLimit: boundaryFinal.processLimit,
    tmpfsSizeMb: boundaryFinal.tmpfsSizeMb,
    env: boundaryFinal.env,
  },
  timeout: {
    status: timeoutFinal.status,
    wallClockTimeoutMs: timeoutFinal.wallClockTimeoutMs,
    errorMessage: timeoutFinal.errorMessage,
  },
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
