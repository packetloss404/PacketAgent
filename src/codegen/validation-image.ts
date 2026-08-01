import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MAX_DOCKER_OUTPUT_BYTES = 64 * 1024;
const IMAGE_BUILD_TIMEOUT_MS = 5 * 60_000;
const IMAGE_INSPECT_TIMEOUT_MS = 15_000;
const REPOSITORY_ROOT = resolve(process.cwd());
const DOCKERFILE_PATH = resolve(REPOSITORY_ROOT, "src", "sandbox", "codegen-validator.Dockerfile");
const PACKAGE_LOCK_PATH = resolve(REPOSITORY_ROOT, "package-lock.json");

let preparedImage: Promise<string> | null = null;

export async function ensureCodegenValidationImage(): Promise<string> {
  preparedImage ??= prepareImage().catch((error) => {
    preparedImage = null;
    throw error;
  });
  return await preparedImage;
}

export function codegenValidationImageTag(): string {
  const digest = createHash("sha256")
    .update(readFileSync(DOCKERFILE_PATH))
    .update(readFileSync(PACKAGE_LOCK_PATH))
    .digest("hex")
    .slice(0, 16);
  return `packetagent-codegen-validator:${digest}`;
}

async function prepareImage(): Promise<string> {
  const image = codegenValidationImageTag();
  const inspected = await runDocker(["image", "inspect", image], IMAGE_INSPECT_TIMEOUT_MS, true);
  if (inspected.exitCode === 0) return image;

  const built = await runDocker(
    [
      "build",
      "--file",
      DOCKERFILE_PATH,
      "--tag",
      image,
      "--label",
      `packetagent.codegen-validator-lock=${image.split(":").at(-1) ?? "unknown"}`,
      REPOSITORY_ROOT,
    ],
    IMAGE_BUILD_TIMEOUT_MS,
    false,
  );
  if (built.exitCode !== 0) {
    throw new Error(
      `sandbox validator image build failed: ${boundedOutput(built.stderr || built.stdout)}`,
    );
  }
  return image;
}

async function runDocker(
  args: string[],
  timeoutMs: number,
  allowNonZero: boolean,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("docker", args, {
      cwd: REPOSITORY_ROOT,
      env: dockerCliEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let timedOut = false;
    const capture = (target: Buffer[]) => (chunk: Buffer) => {
      if (capturedBytes >= MAX_DOCKER_OUTPUT_BYTES) return;
      const bounded = chunk.subarray(0, MAX_DOCKER_OUTPUT_BYTES - capturedBytes);
      target.push(bounded);
      capturedBytes += bounded.length;
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      const result = {
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      };
      if (timedOut) {
        reject(new Error(`docker ${args[0] ?? "command"} exceeded ${timeoutMs}ms`));
      } else if (!allowNonZero && exitCode !== 0) {
        reject(
          new Error(
            `docker ${args[0] ?? "command"} exited ${exitCode}: ${boundedOutput(
              result.stderr || result.stdout,
            )}`,
          ),
        );
      } else {
        resolvePromise(result);
      }
    });
  });
}

function dockerCliEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
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
  return Object.fromEntries(
    allowed.flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]])),
  );
}

function boundedOutput(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 2_000 ? `${normalized.slice(0, 2_000)}…` : normalized;
}

export function resetCodegenValidationImageForTests(): void {
  preparedImage = null;
}
