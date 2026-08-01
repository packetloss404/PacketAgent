import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { chromium } from "playwright";

const root = resolve(process.cwd());
const port = await availablePort();
const tempRoot = await mkdtemp(join(tmpdir(), "packetagent-workbench-browser-"));
const evidenceRoot = resolve(root, "tmp", "release-verification");
await mkdir(evidenceRoot, { recursive: true });

const child = spawn(process.execPath, ["--enable-source-maps", "dist/server.js"], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: "development",
    PORT: String(port),
    MASTER_KEY: "workbench-browser-verification-master-key-32-bytes",
    PACKETAGENT_RATE_LIMIT_KEY_SALT: "workbench-browser-verification-rate-salt",
    PACKETAGENT_STORE: "sqlite",
    PACKETAGENT_DB_PATH: resolve(tempRoot, "packetagent.sqlite"),
    PACKETAGENT_APP_ORIGIN: `http://127.0.0.1:${port}`,
    PACKETAGENT_PREVIEW_ORIGIN: `http://127.0.0.2:${port}`,
    PACKETAGENT_ARTIFACT_SERVING_ENABLED: "false",
    PACKETAGENT_SCHEDULER_LEADER_MODE: "off",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let output = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  output += chunk;
});
child.stderr.on("data", (chunk) => {
  output += chunk;
});

let browser;
try {
  await waitForReady(port, child, () => output);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const origin = `http://127.0.0.1:${port}`;

  await page.goto(`${origin}/sign-in`);
  await page.getByLabel("Email").fill("alpha@packetagent.local");
  await page.getByLabel("Password").fill("demo12345");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(`${origin}/builder`);
  await page.getByRole("heading", { name: "What do you want to build today?" }).waitFor();
  const builderScreenshot = resolve(evidenceRoot, "builder-app-mode.png");
  await page.screenshot({ path: builderScreenshot, fullPage: true });

  await page.goto(`${origin}/runs`);
  await page.getByRole("heading", { name: "Durable Workers" }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Workers", exact: true }).getAttribute("aria-pressed"),
    "true",
  );
  const workerScreenshot = resolve(evidenceRoot, "worker-operations-mode.png");
  await page.screenshot({ path: workerScreenshot, fullPage: true });

  await page.goto(`${origin}/admin/roles`);
  const rolesTab = page.getByRole("tab", { name: "Roles" });
  await rolesTab.focus();
  await rolesTab.press("ArrowRight");
  await page.waitForURL(`${origin}/admin/sso`);
  const ssoTab = page.getByRole("tab", { name: "SSO & auth" });
  await page.waitForFunction(() =>
    document
      .querySelector('[role="tab"][aria-selected="true"]')
      ?.textContent?.includes("SSO & auth"),
  );
  assert.equal(await ssoTab.getAttribute("aria-selected"), "true");
  assert.equal(await ssoTab.getAttribute("tabindex"), "0");
  assert.equal(await ssoTab.evaluate((element) => element === document.activeElement), true);

  const [builderEvidence, workerEvidence] = await Promise.all([
    stat(builderScreenshot),
    stat(workerScreenshot),
  ]);
  assert.ok(builderEvidence.size > 1_000);
  assert.ok(workerEvidence.size > 1_000);

  console.log(
    JSON.stringify(
      {
        signIn: "passed",
        builderAppMode: "passed",
        workerOperationsMode: "passed",
        keyboardTabs: "passed",
        screenshots: [
          "tmp/release-verification/builder-app-mode.png",
          "tmp/release-verification/worker-operations-mode.png",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  if (child.exitCode === null) child.kill("SIGTERM");
  await waitForExit(child);
  await rm(tempRoot, { recursive: true, force: true });
}

function availablePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a browser verification port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePromise(address.port)));
    });
  });
}

async function waitForReady(port, processHandle, childOutput) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(
        `browser verification server exited ${processHandle.exitCode}: ${childOutput()}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health/ready`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      // Server startup includes durable reconciliation; retry within the bound.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`browser verification server did not become ready: ${childOutput()}`);
}

function waitForExit(processHandle) {
  if (processHandle.exitCode !== null) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => processHandle.kill("SIGKILL"), 5_000);
    processHandle.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}
