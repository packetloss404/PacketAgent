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

// The twelve consolidated Admin surfaces advertised by README.md. Each must
// render under /admin/:tab with its own tab selected.
const ADMIN_TABS = [
  ["roles", "Roles"],
  ["sso", "SSO & auth"],
  ["secrets", "Secrets vault"],
  ["rate-limits", "Rate limits"],
  ["webhooks", "Webhooks"],
  ["notifications", "Notifications"],
  ["operations", "Operations"],
  ["integrations", "Integrations"],
  ["activation", "Activation"],
  ["sandbox", "Sandbox"],
  ["workflows", "Workflows"],
  ["billing", "Billing"],
];

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

  // Collect uncaught exceptions and console errors across the whole run. A
  // clean console is part of the gate: a page that renders but throws is not a
  // working surface.
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  await page.goto(`${origin}/sign-in`);
  await page.getByLabel("Email").fill("alpha@packetagent.local");
  await page.getByLabel("Password").fill("demo12345");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(`${origin}/builder`);
  await page.getByRole("heading", { name: "What do you want to build today?" }).waitFor();
  const skipTour = page.getByRole("button", { name: "Skip tour" });
  if (await skipTour.isVisible()) await skipTour.click();
  const builderScreenshot = resolve(evidenceRoot, "builder-app-mode.png");
  await page.screenshot({ path: builderScreenshot, fullPage: true });

  // Builder agent mode: an agent prompt must route the primary action to the
  // agent authoring surface.
  const builderPrompt = page.getByPlaceholder("Describe what you want to build...");
  await builderPrompt.fill("Build an agent that posts a daily standup digest for the team");
  const agentAction = page.getByRole("button", { name: "Open agent builder" });
  await agentAction.waitFor();
  await agentAction.click();
  await page
    .getByPlaceholder(/Build an agent that reviews new support incidents/)
    .waitFor({ timeout: 10_000 });
  await page.screenshot({
    path: resolve(evidenceRoot, "builder-agent-mode.png"),
    fullPage: true,
  });

  // Command palette: Cmd/Ctrl-K opens it, typing filters, Escape closes it.
  // The palette is part of the Workbench shell (not the full-bleed Builder
  // layout), so it is exercised from the canonical Worker operations route.
  await page.goto(`${origin}/runs`);
  await page.getByRole("heading", { name: "Durable Workers" }).waitFor();
  await page.keyboard.press("Control+k");
  const paletteInput = page.getByPlaceholder("Search commands, agents, settings…");
  await paletteInput.waitFor();
  await paletteInput.fill("secrets vault");
  await page.getByText("Secrets vault", { exact: true }).first().waitFor();
  await page.screenshot({ path: resolve(evidenceRoot, "command-palette.png") });
  await page.keyboard.press("Escape");
  await paletteInput.waitFor({ state: "hidden" });

  // Canonical Worker operations workbench.
  await page.getByText("Loading Worker operations…").waitFor({ state: "hidden" });
  assert.equal(
    await page.getByRole("button", { name: "Workers", exact: true }).getAttribute("aria-pressed"),
    "true",
  );
  const workerScreenshot = resolve(evidenceRoot, "worker-operations-mode.png");
  await page.screenshot({ path: workerScreenshot, fullPage: true });

  // Every advertised Admin surface renders with its own tab selected.
  for (const [tabId, tabLabel] of ADMIN_TABS) {
    await page.goto(`${origin}/admin/${tabId}`);
    const tab = page.getByRole("tab", { name: tabLabel });
    await tab.waitFor();
    await page.waitForFunction(
      (label) =>
        document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.includes(label),
      tabLabel,
    );
    assert.equal(await tab.getAttribute("aria-selected"), "true", `${tabId} tab must be selected`);
    assert.ok(
      await page.locator(`#admin-panel-${tabId}`).isVisible(),
      `${tabId} panel must render`,
    );
  }

  // Keyboard tab navigation across the Admin tablist.
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

  // Legacy per-page URLs still redirect onto the consolidated Admin page.
  await page.goto(`${origin}/secrets`);
  await page.waitForURL(`${origin}/admin/secrets`);

  const [builderEvidence, workerEvidence] = await Promise.all([
    stat(builderScreenshot),
    stat(workerScreenshot),
  ]);
  assert.ok(builderEvidence.size > 1_000);
  assert.ok(workerEvidence.size > 1_000);

  assert.deepEqual(pageErrors, [], `uncaught page errors: ${pageErrors.join(" | ")}`);
  assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join(" | ")}`);

  console.log(
    JSON.stringify(
      {
        signIn: "passed",
        builderAppMode: "passed",
        builderAgentMode: "passed",
        commandPalette: "passed",
        workerOperationsMode: "passed",
        adminTabs: `${ADMIN_TABS.length} passed`,
        legacyAdminRedirect: "passed",
        keyboardTabs: "passed",
        consoleErrors: 0,
        screenshots: [
          "tmp/release-verification/builder-app-mode.png",
          "tmp/release-verification/builder-agent-mode.png",
          "tmp/release-verification/command-palette.png",
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
