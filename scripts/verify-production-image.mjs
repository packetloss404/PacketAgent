import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

const root = resolve(process.cwd());
const suffix = `${process.pid}-${randomBytes(3).toString("hex")}`;
const image = `packetagent:r8-verify-${suffix}`;
const container = `packetagent-r8-verify-${suffix}`;

try {
  await run("docker", ["build", "--tag", image, "."], 180_000);
  const inspected = JSON.parse(
    await run("docker", ["image", "inspect", "--format={{json .Config.Cmd}}", image], 30_000),
  );
  assert.deepEqual(inspected, ["node", "--enable-source-maps", "dist/server.js"]);
  const configuredUser = JSON.parse(
    await run("docker", ["image", "inspect", "--format={{json .Config.User}}", image], 30_000),
  );
  assert.ok(configuredUser && configuredUser !== "root" && configuredUser !== "0");

  await run(
    "docker",
    [
      "run",
      "--detach",
      "--name",
      container,
      "--read-only",
      "--tmpfs",
      "/tmp:size=64m,mode=1777,nosuid,nodev",
      "--env",
      "MASTER_KEY=production-image-verification-master-key-32-bytes",
      "--env",
      "PACKETAGENT_RATE_LIMIT_KEY_SALT=production-image-verification-rate-salt",
      "--env",
      "PACKETAGENT_APP_ORIGIN=https://app.packetagent.test",
      "--env",
      "PACKETAGENT_PREVIEW_ORIGIN=https://preview.packetagent.test",
      "--env",
      "PACKETAGENT_SCHEDULER_LEADER_MODE=off",
      image,
    ],
    30_000,
  );
  await waitForReady(container);
  const readOnlyRoot = JSON.parse(
    await run(
      "docker",
      ["container", "inspect", "--format={{json .HostConfig.ReadonlyRootfs}}", container],
      30_000,
    ),
  );
  assert.equal(readOnlyRoot, true);
  const runtimeIdentity = JSON.parse(
    await run(
      "docker",
      [
        "exec",
        container,
        "node",
        "-e",
        "console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid()}))",
      ],
      5_000,
    ),
  );
  assert.notEqual(runtimeIdentity.uid, 0);
  console.log(
    JSON.stringify(
      {
        image: "built",
        command: inspected,
        configuredUser,
        runtimeIdentity,
        readOnlyRoot,
        nonRootReadOnlyRuntime: "ready",
      },
      null,
      2,
    ),
  );
} finally {
  await run("docker", ["container", "rm", "--force", container], 30_000, true);
  await run("docker", ["image", "rm", "--force", image], 30_000, true);
}

async function waitForReady(containerName) {
  const deadline = Date.now() + 30_000;
  let detail = "";
  while (Date.now() < deadline) {
    try {
      const response = await run(
        "docker",
        [
          "exec",
          containerName,
          "node",
          "-e",
          "fetch('http://127.0.0.1:8484/api/health/ready').then(async r=>{if(!r.ok)process.exit(1);console.log(await r.text())})",
        ],
        5_000,
      );
      assert.deepEqual(JSON.parse(response), { status: "ready" });
      return;
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  throw new Error(`production image did not become ready: ${detail}`);
}

function run(command, args, timeoutMs, allowFailure = false) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`${command} ${args[0] ?? ""} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error && !allowFailure) reject(error);
      else resolvePromise(Buffer.concat(stdout).toString("utf8").trim());
    };
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        finish(new Error(`${command} ${args[0] ?? ""} exited ${code}: ${detail}`));
      } else finish();
    });
  });
}
