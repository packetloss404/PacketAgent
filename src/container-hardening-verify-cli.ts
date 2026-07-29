import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { ensureCodegenValidationImage } from "./codegen/validation-image.js";
import {
  composeServiceHardening,
  containerHardeningControlsPass,
  isNonRootIdentity,
  liveContainerHardeningProbePass,
  parseComposeService,
  type LiveContainerHardeningProbe,
} from "./container-hardening.js";
import { generatedAppDockerComposeYaml } from "./generated-app-publish-package.js";
import { getDefaultSandboxService } from "./sandbox/sandbox-service.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const SANDBOX_PROCESS_LIMIT = 64;
const CONTROL_PLANE_PROCESS_LIMIT = 256;
const GENERATED_APP_PROCESS_LIMIT = 128;

const validatorImage = await ensureCodegenValidationImage();
const validatorImageUser = JSON.parse(
  (
    await runCommand(
      "docker",
      ["image", "inspect", "--format={{json .Config.User}}", validatorImage],
      undefined,
      30_000,
    )
  ).stdout,
) as unknown;
if (typeof validatorImageUser !== "string") {
  throw new Error("validator image inspection returned an invalid user");
}

const controlPlaneCompose = await runCompose(
  ["-p", "packetagent-hardening-verify", "-f", "docker-compose.yml", "config", "--format", "json"],
  undefined,
  30_000,
  {
    MASTER_KEY: "verification-only-master-key-not-a-secret",
    PACKETAGENT_RATE_LIMIT_KEY_SALT: "verification-only-rate-limit-salt",
    PACKETAGENT_APP_ORIGIN: "https://packetagent.verify.test",
    PACKETAGENT_PREVIEW_ORIGIN: "https://preview.packetagent.verify.test",
  },
);
const generatedAppCompose = await runCompose(
  ["-p", "packetagent-generated-hardening-verify", "-f", "-", "config", "--format", "json"],
  generatedAppDockerComposeYaml(),
  30_000,
);

const controlPlaneControls = composeServiceHardening(
  parseComposeService(controlPlaneCompose.stdout, "packetagent"),
);
const generatedAppControls = composeServiceHardening(
  parseComposeService(generatedAppCompose.stdout, "generated-app"),
);

const sandboxService = getDefaultSandboxService();
const probeScript = `
const fs = require("node:fs");
const status = fs.readFileSync("/proc/self/status", "utf8");
const field = (name) => (status.match(new RegExp("^" + name + ":\\\\s*(.+)$", "m")) || [])[1] || "";
const readFirst = (paths) => {
  for (const path of paths) {
    try { return fs.readFileSync(path, "utf8").trim(); } catch {}
  }
  return "";
};
let rootWriteDenied = false;
try { fs.writeFileSync("/packetagent-r56-write-probe", "blocked"); }
catch { rootWriteDenied = true; }
console.log("PACKETAGENT_HARDENING=" + JSON.stringify({
  uid: process.getuid(),
  gid: process.getgid(),
  capEff: field("CapEff"),
  noNewPrivs: field("NoNewPrivs"),
  pidsMax: readFirst(["/sys/fs/cgroup/pids.max", "/sys/fs/cgroup/pids/pids.max"]),
  rootWriteDenied,
}));
`;
const sandboxStart = await sandboxService.startExec({
  workspaceId: "container-hardening-verifier",
  runtime: "codegen-node-22",
  requiredDriver: "docker",
  image: validatorImage,
  workingDir: "/tmp",
  timeoutMs: 10_000,
  command: `node -e ${shellQuote(probeScript)}`,
});
const sandboxFinal = (await sandboxService.waitForExec(sandboxStart.id)) ?? sandboxStart;
const liveProbe = parseLiveProbe(sandboxFinal.stdoutPreview ?? "");

const result = {
  ok:
    isNonRootIdentity(validatorImageUser) &&
    containerHardeningControlsPass(controlPlaneControls, CONTROL_PLANE_PROCESS_LIMIT) &&
    containerHardeningControlsPass(generatedAppControls, GENERATED_APP_PROCESS_LIMIT) &&
    sandboxFinal.status === "success" &&
    liveContainerHardeningProbePass(liveProbe, SANDBOX_PROCESS_LIMIT),
  validatorImage: {
    image: validatorImage,
    user: validatorImageUser,
    nonRoot: isNonRootIdentity(validatorImageUser),
  },
  controlPlaneCompose: controlPlaneControls,
  generatedAppCompose: generatedAppControls,
  sandboxRuntime: {
    status: sandboxFinal.status,
    processLimit: sandboxFinal.processLimit,
    ...liveProbe,
  },
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;

function parseLiveProbe(output: string): LiveContainerHardeningProbe {
  const match = /(?:^|\n)PACKETAGENT_HARDENING=(\{[^\r\n]+\})/.exec(output);
  if (!match?.[1]) throw new Error("sandbox hardening probe did not return its result");
  const parsed = JSON.parse(match[1]) as Partial<LiveContainerHardeningProbe>;
  if (
    typeof parsed.uid !== "number" ||
    typeof parsed.gid !== "number" ||
    typeof parsed.capEff !== "string" ||
    typeof parsed.noNewPrivs !== "string" ||
    typeof parsed.pidsMax !== "string" ||
    typeof parsed.rootWriteDenied !== "boolean"
  ) {
    throw new Error("sandbox hardening probe returned an invalid result");
  }
  return parsed as LiveContainerHardeningProbe;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

async function runCompose(
  args: string[],
  stdin?: string,
  timeoutMs = 30_000,
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await runCommand("docker-compose", args, stdin, timeoutMs, extraEnv);
  } catch (error) {
    if (!(error instanceof Error) || !/spawn docker-compose ENOENT/i.test(error.message)) {
      throw error;
    }
    return await runCommand("docker", ["compose", ...args], stdin, timeoutMs, extraEnv);
  }
}

async function runCommand(
  command: string,
  args: string[],
  stdin?: string,
  timeoutMs = 30_000,
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: REPOSITORY_ROOT,
      env: dockerCliEnvironment(extraEnv),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else
        resolvePromise({
          stdout: Buffer.concat(stdout).toString("utf8").trim(),
          stderr: Buffer.concat(stderr).toString("utf8").trim(),
        });
    };
    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The close/error handler still settles the promise.
      }
      finish(new Error(`${command} ${args[0] ?? ""} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        finish(new Error(`${command} ${args[0] ?? ""} exited ${code}: ${detail}`));
      } else {
        finish();
      }
    });
    child.stdin.end(stdin);
  });
}

function dockerCliEnvironment(extra: Record<string, string>): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
  ] as const;
  return {
    ...Object.fromEntries(
      allowed.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
    ),
    ...extra,
  };
}
