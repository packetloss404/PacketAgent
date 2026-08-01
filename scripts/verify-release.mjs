import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(process.cwd());
const gates = [
  [
    "build web",
    process.execPath,
    ["node_modules/vite/bin/vite.js", "build", "--config", "web/vite.config.ts"],
  ],
  ["build server", process.execPath, ["scripts/build-server.mjs"]],
  [
    "app happy path",
    process.execPath,
    [
      "--import",
      "tsx",
      "--test-concurrency=1",
      "--test",
      "--test-name-pattern=builder app draft can|builder app iteration can|builder publish creates|generated app preview route resolves|generated app source routes are workspace-scoped",
      "src/app-routes.test.ts",
    ],
  ],
  [
    "Worker deploy/reconnect/stop happy path",
    process.execPath,
    [
      "--import",
      "tsx",
      "--test-concurrency=1",
      "--test",
      "src/worker-package-handoff-gate.test.ts",
    ],
  ],
  [
    "checkpoint smoke transcripts",
    process.execPath,
    [
      "--import",
      "tsx",
      "--test-concurrency=1",
      "--test",
      "src/generated-app-smoke-transcript.test.ts",
    ],
  ],
  [
    "checkpoint storage parity",
    process.execPath,
    [
      "--import",
      "tsx",
      "--test-concurrency=1",
      "--test",
      "--test-name-pattern=Worker lifecycle has JSON, SQLite, and managed Postgres parity",
      "src/workers/__tests__/persistence-parity.test.ts",
    ],
  ],
  [
    "path, preview, artifact, and rollback regressions",
    process.execPath,
    [
      "--import",
      "tsx",
      "--test-concurrency=1",
      "--test",
      "src/codegen/path-validator.test.ts",
      "src/app-preview-isolation.test.ts",
      "src/app-preview-snapshots.test.ts",
      "src/generated-app-publish-integrity.test.ts",
    ],
  ],
  [
    "backup and restore regression",
    process.execPath,
    [
      "--import",
      "tsx",
      "--test-concurrency=1",
      "--test",
      "--test-name-pattern=backupDatabase copies|restoreDatabase rejects",
      "src/db/cli.test.ts",
    ],
  ],
  [
    "tenant isolation regression",
    process.execPath,
    [
      "--import",
      "tsx",
      "--test-concurrency=1",
      "--test",
      "--test-name-pattern=isolates workspaces",
      "src/workers/observability/rollups.test.ts",
    ],
  ],
  ["release claim audit", process.execPath, ["scripts/audit-release-claims.mjs"]],
  ["built server runtime", process.execPath, ["scripts/verify-production-build.mjs"]],
  ["workbench browser", process.execPath, ["scripts/verify-workbench-browser.mjs"]],
];

for (const [label, command, args] of gates) {
  console.log(`\n[release] ${label}`);
  await run(command, args);
}

console.log(`\n[release] ${gates.length} deterministic gates passed`);

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}
