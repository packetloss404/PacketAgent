import assert from "node:assert/strict";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { planGeneratedAppPackageInstall } from "./package-plan.js";
import { buildGeneratedAppWorkspaceExport } from "./workspace-export.js";

test("workspace export produces a git-ready ZIP with plan and provenance", () => {
  const files = [
    {
      path: "package.json",
      content: JSON.stringify({ dependencies: { react: "^19.0.0" } }),
    },
    { path: "src/App.tsx", content: "export default function App() { return null; }\n" },
  ];
  const packagePlan = planGeneratedAppPackageInstall(files);
  const result = buildGeneratedAppWorkspaceExport({
    appId: "app_123",
    appSlug: "renewal-board",
    workspaceId: "workspace_123",
    checkpointId: "checkpoint_123",
    checkpointCreatedAt: "2026-07-29T12:00:00.000Z",
    exportedAt: "2026-07-29T12:00:00.000Z",
    files,
    packagePlan,
  });
  const entries = unzipSync(result.bytes);
  const names = Object.keys(entries).sort();

  assert.equal(result.fileName, "renewal-board-checkpoint_123.zip");
  assert.ok(names.includes("renewal-board/.gitignore"));
  assert.ok(names.includes("renewal-board/PACKETAGENT_EXPORT.md"));
  assert.ok(names.includes("renewal-board/package.json"));
  assert.ok(names.includes("renewal-board/src/App.tsx"));
  assert.ok(names.includes("renewal-board/.packetagent/package-install-plan.json"));
  assert.ok(names.includes("renewal-board/.packetagent/generated-app-export-manifest.json"));
  assert.match(
    strFromU8(entries["renewal-board/PACKETAGENT_EXPORT.md"]!),
    /did not run a package installation/i,
  );
  const manifest = JSON.parse(
    strFromU8(entries["renewal-board/.packetagent/generated-app-export-manifest.json"]!),
  ) as { checkpointId: string; packagePlanStatus: string; files: unknown[] };
  assert.equal(manifest.checkpointId, "checkpoint_123");
  assert.equal(manifest.packagePlanStatus, "ready");
  assert.equal(manifest.files.length, 5);
});

test("workspace export rejects unsafe and reserved metadata paths", () => {
  const packagePlan = planGeneratedAppPackageInstall([]);
  assert.throws(
    () =>
      buildGeneratedAppWorkspaceExport({
        appId: "app",
        appSlug: "app",
        workspaceId: "workspace",
        checkpointId: "checkpoint",
        exportedAt: "2026-07-29T12:00:00.000Z",
        files: [{ path: "../escape.txt", content: "bad" }],
        packagePlan,
      }),
    /invalid generated app export path/,
  );
  assert.throws(
    () =>
      buildGeneratedAppWorkspaceExport({
        appId: "app",
        appSlug: "app",
        workspaceId: "workspace",
        checkpointId: "checkpoint",
        exportedAt: "2026-07-29T12:00:00.000Z",
        files: [{ path: ".packetagent/package-install-plan.json", content: "{}" }],
        packagePlan,
      }),
    /metadata path already exists/,
  );
});
