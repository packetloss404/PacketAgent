import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(process.cwd());
const manifestPath = resolve(root, "dist", "build-manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

assert.equal(manifest.schemaVersion, "packetagent.production-build/v1");
assert.deepEqual(manifest.entrypoints, ["server.js", "generated-app-runtime/server-worker.js"]);
assert.ok(manifest.sourceMaps.some((path) => path.endsWith("dist/server.js.map")));
assert.ok(
  manifest.sourceMaps.some((path) =>
    path.endsWith("dist/generated-app-runtime/server-worker.js.map"),
  ),
);
const javaScriptOutputs = manifest.outputs.filter((path) => path.endsWith(".js"));
for (const output of javaScriptOutputs) {
  assert.ok(
    manifest.sourceMaps.includes(`${output}.map`),
    `production JavaScript output is missing its source map: ${output}`,
  );
  await stat(resolve(root, `${output}.map`));
}
await stat(resolve(root, "dist", "generated-app-publish-runtime", "server.mjs"));

const bundledJavaScript = await Promise.all(
  javaScriptOutputs.map((path) => readFile(resolve(root, path), "utf8")),
);
assert.ok(
  bundledJavaScript.some((source) => /import\("playwright"\)/.test(source)),
  "Playwright must remain an optional import in the production bundle",
);

let playwright = "not-installed";
try {
  const module = await import("playwright");
  assert.ok(module.chromium, "installed Playwright must expose chromium");
  playwright = "importable";
} catch (error) {
  if (!isMissingPlaywright(error)) throw error;
}

const port = await availablePort();
const tempRoot = await mkdtemp(join(tmpdir(), "packetagent-production-build-"));
const child = spawn(process.execPath, ["--enable-source-maps", "dist/server.js"], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    MASTER_KEY: "production-build-verification-master-key-32-bytes",
    PACKETAGENT_RATE_LIMIT_KEY_SALT: "production-build-verification-rate-salt",
    PACKETAGENT_STORE: "sqlite",
    PACKETAGENT_DB_PATH: resolve(tempRoot, "packetagent.sqlite"),
    PACKETAGENT_APP_ORIGIN: "https://app.packetagent.test",
    PACKETAGENT_PREVIEW_ORIGIN: "https://preview.packetagent.test",
    PACKETAGENT_ARTIFACT_SERVING_ENABLED: "false",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

try {
  await waitForReady(port, child, () => `${stdout}\n${stderr}`);
  const response = await fetch(`http://127.0.0.1:${port}/api/health/ready`, {
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ready" });
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await waitForExit(child);
  await rm(tempRoot, { recursive: true, force: true });
}

console.log(
  JSON.stringify(
    {
      schemaVersion: manifest.schemaVersion,
      server: "ready",
      entrypoints: manifest.entrypoints,
      sourceMaps: manifest.sourceMaps.length,
      playwright,
    },
    null,
    2,
  ),
);

function availablePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a production verification port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePromise(address.port)));
    });
  });
}

async function waitForReady(port, processHandle, output) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`production server exited ${processHandle.exitCode}: ${output()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health/live`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      // Startup includes durable scheduler reconciliation; retry within the bound.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`production server did not become ready: ${output()}`);
}

function waitForExit(processHandle) {
  if (processHandle.exitCode !== null) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      processHandle.kill("SIGKILL");
    }, 5_000);
    processHandle.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

function isMissingPlaywright(error) {
  return (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ERR_MODULE_NOT_FOUND" || error.code === "MODULE_NOT_FOUND")
  );
}
