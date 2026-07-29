import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  buildGeneratedAppPublishPackageFiles,
  generatedAppDockerComposeYaml,
} from "./generated-app-publish-package";
import type { GeneratedAppRuntimeModel } from "./generated-app-runtime";

const model: GeneratedAppRuntimeModel = {
  primaryEntity: "ticket",
  schema: [
    {
      name: "ticket",
      label: "Ticket",
      fields: [
        { name: "id", type: "string", required: true },
        { name: "name", type: "string", required: true },
        { name: "status", type: "string", required: true },
      ],
      requiredFields: ["id", "name", "status"],
      editableFields: ["name", "status"],
      relationships: [],
    },
  ],
  seedData: {
    ticket: [{ id: "tick_seed", name: "Seed ticket", status: "open" }],
  },
};

test("generated app publish package contains a single hardened standalone service", () => {
  const files = buildGeneratedAppPublishPackageFiles({
    workspaceId: "workspace_alpha",
    appId: "gapp_alpha",
    checkpointId: "checkpoint_alpha",
    appName: "Alpha desk",
    model,
  });
  const byPath = new Map(files.map((file) => [file.path, String(file.content)]));
  const compose = generatedAppDockerComposeYaml();

  assert.deepEqual(
    files.map((file) => file.path),
    [
      "Dockerfile.publish",
      "docker-compose.publish.yml",
      ".dockerignore",
      "runtime/server.mjs",
      "runtime/runtime-model.json",
      "RUNBOOK.md",
      "deploy/Caddyfile.example",
      "deploy/nginx.generated-app.conf.example",
      "deploy/TAILSCALE.md",
    ],
  );
  assert.match(compose, /^services:\n  generated-app:/);
  assert.equal(compose.includes("packetagent-db"), false);
  assert.equal(compose.includes("packetagent-app"), false);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop:\n      - ALL/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /generated-app-data:\/app\/data/);
  assert.match(
    compose,
    /\$\{PACKETAGENT_GENERATED_APP_BIND_ADDRESS:-127\.0\.0\.1\}:\$\{PACKETAGENT_GENERATED_APP_PORT:-8787\}:8080/,
  );
  assert.match(byPath.get("Dockerfile.publish") ?? "", /RUN --network=none/);
  assert.match(byPath.get("Dockerfile.publish") ?? "", /USER node/);
  assert.match(byPath.get("runtime/server.mjs") ?? "", /node:sqlite/);
  assert.match(byPath.get("RUNBOOK.md") ?? "", /declared policy is `reset-and-reseed`/);
  assert.match(byPath.get("RUNBOOK.md") ?? "", /Offline backup and restore/);
  assert.match(byPath.get("RUNBOOK.md") ?? "", /copyFileSync/);
  assert.match(byPath.get("runtime/server.mjs") ?? "", /SCHEMA_CHANGE_POLICY = "reset-and-reseed"/);
  assert.match(byPath.get("deploy/Caddyfile.example") ?? "", /reverse_proxy 127\.0\.0\.1/);
  assert.match(
    byPath.get("deploy/nginx.generated-app.conf.example") ?? "",
    /proxy_set_header X-Forwarded-For/,
  );
  assert.match(byPath.get("deploy/TAILSCALE.md") ?? "", /tailscale serve --bg/);
  assert.deepEqual(JSON.parse(byPath.get("runtime/runtime-model.json") ?? "{}"), model);
});

test("standalone generated app runtime serves health, static output, and persistent CRUD", async () => {
  const root = mkdtempSync(join(tmpdir(), "packetagent-generated-publish-"));
  const staticRoot = join(root, "static");
  const runtimeRoot = join(root, "runtime");
  const dataRoot = join(root, "data");
  mkdirSync(join(staticRoot, ".vite"), { recursive: true });
  mkdirSync(join(staticRoot, "assets"), { recursive: true });
  mkdirSync(runtimeRoot, { recursive: true });
  mkdirSync(dataRoot, { recursive: true });
  writeFileSync(
    join(staticRoot, "index.html"),
    '<!doctype html><body data-app-id="gapp_alpha"><script type="module" src="/assets/app.js"></script></body>',
  );
  writeFileSync(join(staticRoot, "assets", "app.js"), "document.body.dataset.ready = 'true';\n");
  writeFileSync(
    join(staticRoot, ".vite", "manifest.json"),
    `${JSON.stringify({
      "index.html": { file: "assets/app.js", name: "index", src: "index.html", isEntry: true },
    })}\n`,
  );
  writeFileSync(
    join(runtimeRoot, "runtime-config.json"),
    `${JSON.stringify({
      runtime: "packetagent-generated-app-standalone",
      workspaceId: "workspace_alpha",
      appId: "gapp_alpha",
      checkpointId: "checkpoint_alpha",
      schemaChangePolicy: "reset-and-reseed",
    })}\n`,
  );
  const modelPath = join(runtimeRoot, "runtime-model.json");
  writeFileSync(modelPath, `${JSON.stringify(model)}\n`);

  let port = await availablePort();
  let child: ChildProcess | undefined;
  try {
    child = spawnStandaloneRuntime({ port, staticRoot, dataRoot, runtimeRoot });
    await waitUntilReady(port, child);

    const live = await fetch(`http://127.0.0.1:${port}/health/live`);
    assert.equal(live.status, 200);
    assert.equal(((await live.json()) as { status: string }).status, "live");

    const ready = await fetch(`http://127.0.0.1:${port}/health/ready`);
    assert.equal(ready.status, 200);
    assert.equal(
      ((await ready.json()) as { checkpointId: string }).checkpointId,
      "checkpoint_alpha",
    );
    const readyAgain = (await (await fetch(`http://127.0.0.1:${port}/health/ready`)).json()) as {
      schemaChangePolicy?: string;
    };
    assert.equal(readyAgain.schemaChangePolicy, "reset-and-reseed");

    const metadata = (await (await fetch(`http://127.0.0.1:${port}/meta`)).json()) as {
      schemaChangePolicy?: string;
    };
    assert.equal(metadata.schemaChangePolicy, "reset-and-reseed");

    const rootResponse = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(rootResponse.status, 200);
    assert.match(await rootResponse.text(), /data-app-id="gapp_alpha"/);

    const api = `http://127.0.0.1:${port}/api/app/generated-apps/gapp_alpha/api/tickets`;
    const initial = (await (await fetch(api)).json()) as Array<{ id: string }>;
    assert.deepEqual(
      initial.map((record) => record.id),
      ["tick_seed"],
    );

    const createdResponse = await fetch(api, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Runtime ticket", status: "open" }),
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()) as { id: string; name: string };
    assert.equal(created.name, "Runtime ticket");

    const updatedResponse = await fetch(`${api}/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "closed" }),
    });
    assert.equal(updatedResponse.status, 200);
    assert.equal(((await updatedResponse.json()) as { status: string }).status, "closed");

    const deletedResponse = await fetch(`${api}/${created.id}`, { method: "DELETE" });
    assert.equal(deletedResponse.status, 200);
    assert.equal(((await deletedResponse.json()) as { archivedId: string }).archivedId, created.id);

    const transientResponse = await fetch(api, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Reset by schema change", status: "open" }),
    });
    assert.equal(transientResponse.status, 201);
    const transient = (await transientResponse.json()) as { id: string };

    child.kill("SIGTERM");
    await waitForExit(child);
    child = undefined;
    writeFileSync(
      modelPath,
      `${JSON.stringify({
        ...model,
        schema: [
          {
            ...model.schema[0]!,
            fields: [
              ...model.schema[0]!.fields,
              { name: "ownerEmail", type: "string", required: false },
            ],
            editableFields: [...model.schema[0]!.editableFields, "ownerEmail"],
          },
        ],
      })}\n`,
    );
    port = await availablePort();
    child = spawnStandaloneRuntime({ port, staticRoot, dataRoot, runtimeRoot });
    await waitUntilReady(port, child);
    const resetApi = `http://127.0.0.1:${port}/api/app/generated-apps/gapp_alpha/api/tickets`;
    const resetRecords = (await (await fetch(resetApi)).json()) as Array<{ id: string }>;
    assert.deepEqual(
      resetRecords.map((record) => record.id),
      ["tick_seed"],
    );
    assert.equal(
      resetRecords.some((record) => record.id === transient.id),
      false,
    );
  } finally {
    child?.kill("SIGTERM");
    await waitForExit(child);
    rmSync(root, { recursive: true, force: true });
  }
});

function spawnStandaloneRuntime(input: {
  port: number;
  staticRoot: string;
  dataRoot: string;
  runtimeRoot: string;
}): ChildProcess {
  return spawn(
    process.execPath,
    [join(process.cwd(), "src/generated-app-publish-runtime/server.mjs")],
    {
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(input.port),
        PACKETAGENT_GENERATED_APP_STATIC_ROOT: input.staticRoot,
        PACKETAGENT_GENERATED_APP_DATA_ROOT: input.dataRoot,
        PACKETAGENT_GENERATED_APP_CONFIG_PATH: join(input.runtimeRoot, "runtime-config.json"),
        PACKETAGENT_GENERATED_APP_MODEL_PATH: join(input.runtimeRoot, "runtime-model.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitUntilReady(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`runtime exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
      if (response.ok) return;
    } catch {
      // The bounded startup poll retries while the server binds.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("runtime did not become ready within 5 seconds");
}

async function waitForExit(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
}
