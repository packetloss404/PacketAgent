import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  listGeneratedAppWorkspaceFiles,
  readGeneratedAppWorkspaceFile,
  readGeneratedAppWorkspaceManifest,
  resolveGeneratedAppWorkspacePath,
  writeGeneratedAppWorkspace,
} from "./generated-app-workspace";
import {
  buildGeneratedAppRuntimeArtifact,
  writeGeneratedAppRuntimeWorkspace,
  type GeneratedAppRuntimeDraft,
} from "./generated-app-runtime";

test("resolveGeneratedAppWorkspacePath resolves the safe generated app workspace root", async (t) => {
  const rootDir = await temporaryRoot(t);

  const paths = resolveGeneratedAppWorkspacePath(
    {
      workspaceSlug: "alpha",
      appSlug: "ops-board",
      checkpointId: "gapp_ckpt_001",
    },
    { rootDir },
  );

  assert.equal(
    paths.workspacePath,
    path.join(rootDir, "data", "generated-apps", "alpha", "ops-board", "workspace"),
  );
  assert.equal(paths.relativeWorkspacePath, "data/generated-apps/alpha/ops-board/workspace");
  assert.equal(
    paths.relativeManifestPath,
    "data/generated-apps/alpha/ops-board/workspace/.packetagent/generated-app-workspace-manifest.json",
  );
});

test("workspace path resolution rejects traversal in workspace app and checkpoint metadata", async (t) => {
  const rootDir = await temporaryRoot(t);
  const safe = {
    workspaceSlug: "alpha",
    appSlug: "ops-board",
    checkpointId: "gapp_ckpt_001",
  };

  assert.throws(
    () => resolveGeneratedAppWorkspacePath({ ...safe, workspaceSlug: ".." }, { rootDir }),
    /unsafe generated app workspaceSlug/,
  );
  assert.throws(
    () => resolveGeneratedAppWorkspacePath({ ...safe, appSlug: "../ops-board" }, { rootDir }),
    /unsafe generated app appSlug/,
  );
  assert.throws(
    () =>
      resolveGeneratedAppWorkspacePath({ ...safe, checkpointId: "checkpoints/001" }, { rootDir }),
    /unsafe generated app checkpointId/,
  );
});

test("writeGeneratedAppWorkspace writes source files and a manifest with hashes and sizes", async (t) => {
  const rootDir = await temporaryRoot(t);
  const result = await writeGeneratedAppWorkspace(
    {
      workspaceSlug: "alpha",
      workspaceId: "workspace_alpha",
      appSlug: "ops-board",
      appId: "gapp_ops",
      checkpointId: "gapp_ckpt_001",
      checkpointLabel: "Initial checkpoint",
      checkpointCreatedAt: "2026-05-12T10:00:00.000Z",
      writtenAt: "2026-05-12T10:01:00.000Z",
      files: [
        {
          path: "index.html",
          content: "<!doctype html><title>Ops Board</title>\n",
          contentType: "text/html; charset=utf-8",
          role: "entrypoint",
        },
        {
          path: "src/App.tsx",
          content: "export function App() { return <h1>Ops Board</h1>; }\n",
          contentType: "text/typescript; charset=utf-8",
          role: "source",
        },
      ],
    },
    { rootDir },
  );

  const appFilePath = path.join(result.paths.workspacePath, "src", "App.tsx");
  const manifest = await readGeneratedAppWorkspaceManifest(
    {
      workspaceSlug: "alpha",
      appSlug: "ops-board",
      checkpointId: "gapp_ckpt_001",
    },
    { rootDir },
  );

  assert.equal(
    await readFile(appFilePath, "utf8"),
    "export function App() { return <h1>Ops Board</h1>; }\n",
  );
  assert.equal(manifest.version, "generated-app-workspace.v1");
  assert.equal(manifest.workspacePath, result.paths.workspacePath);
  assert.equal(manifest.relativeWorkspacePath, "data/generated-apps/alpha/ops-board/workspace");
  assert.deepEqual(manifest.checkpoint, {
    id: "gapp_ckpt_001",
    label: "Initial checkpoint",
    createdAt: "2026-05-12T10:00:00.000Z",
  });
  assert.equal(manifest.workspace.id, "workspace_alpha");
  assert.equal(manifest.app.id, "gapp_ops");
  assert.equal(manifest.files.length, 2);
  assert.deepEqual(manifest, result.manifest);

  const appEntry = manifest.files.find((file) => file.path === "src/App.tsx");
  assert.equal(
    appEntry?.size,
    Buffer.byteLength("export function App() { return <h1>Ops Board</h1>; }\n", "utf8"),
  );
  assert.equal(appEntry?.sha256, sha256("export function App() { return <h1>Ops Board</h1>; }\n"));
  assert.equal(appEntry?.role, "source");
});

test("workspace read and list helpers expose file contents and reject file path traversal", async (t) => {
  const rootDir = await temporaryRoot(t);
  const metadata = {
    workspaceSlug: "alpha",
    appSlug: "ops-board",
    checkpointId: "gapp_ckpt_001",
  };
  await writeGeneratedAppWorkspace(
    {
      ...metadata,
      files: [
        { path: "README.md", content: "# Ops Board\n", role: "docs" },
        { path: "src/main.tsx", content: "console.log('ready');\n", role: "source" },
      ],
    },
    { rootDir },
  );

  const files = await listGeneratedAppWorkspaceFiles(metadata, { rootDir });
  const readme = await readGeneratedAppWorkspaceFile(metadata, "README.md", { rootDir });

  assert.deepEqual(
    files.map((file) => file.path),
    ["README.md", "src/main.tsx"],
  );
  assert.equal(readme.content, "# Ops Board\n");
  assert.equal(readme.contentType, "text/markdown; charset=utf-8");
  assert.equal(readme.sha256, sha256("# Ops Board\n"));

  await assert.rejects(
    () => readGeneratedAppWorkspaceFile(metadata, "../README.md", { rootDir }),
    /cannot traverse directories/,
  );
  await assert.rejects(
    () =>
      writeGeneratedAppWorkspace(
        { ...metadata, files: [{ path: "src/../escape.ts", content: "" }] },
        { rootDir },
      ),
    /cannot traverse directories/,
  );
});

test("writeGeneratedAppRuntimeWorkspace writes a runtime artifact into the generated app workspace", async (t) => {
  const rootDir = await temporaryRoot(t);
  const artifact = buildGeneratedAppRuntimeArtifact({
    appId: "gapp_ops",
    workspaceId: "workspace_alpha",
    checkpointId: "gapp_ckpt_001",
    renderedAt: "2026-05-12T10:01:00.000Z",
    draft: sampleRuntimeDraft(),
  });

  const result = await writeGeneratedAppRuntimeWorkspace({
    workspaceSlug: "alpha",
    appSlug: "ops-board",
    appId: "gapp_ops",
    workspaceId: "workspace_alpha",
    checkpointId: "gapp_ckpt_001",
    artifact,
    rootDir,
  });

  const appTsx = await readFile(path.join(result.paths.workspacePath, "src", "App.tsx"), "utf8");
  const listed = await listGeneratedAppWorkspaceFiles(
    {
      workspaceSlug: "alpha",
      appSlug: "ops-board",
      checkpointId: "gapp_ckpt_001",
    },
    { rootDir },
  );

  assert.ok(appTsx.includes("Ops Board"));
  assert.equal(result.manifest.writtenAt, "2026-05-12T10:01:00.000Z");
  assert.equal(result.manifest.files.length, artifact.files.length);
  assert.ok(
    result.manifest.files.some((file) => file.path === "src/App.tsx" && file.role === "source"),
  );
  assert.deepEqual(
    listed.map((file) => file.path),
    result.manifest.files.map((file) => file.path).sort((left, right) => left.localeCompare(right)),
  );
});

async function temporaryRoot(t: { after: (callback: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(tmpdir(), "packetagent-generated-app-workspace-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function sha256(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

function sampleRuntimeDraft(): GeneratedAppRuntimeDraft {
  return {
    prompt: "Build an operations board for support follow-up.",
    intent: "internal_dashboard",
    summary: "Tracks open support work and owner follow-up.",
    app: {
      slug: "ops-board",
      name: "Ops Board",
      description: "Coordinate support issues and handoffs.",
      pages: [
        {
          name: "Board",
          route: "/board",
          access: "private",
          purpose: "Review open operational work.",
          actions: ["assign owner", "close issue"],
          components: ["IssueList"],
        },
      ],
      dataSchema: [
        {
          name: "issue",
          fields: [
            { name: "id", type: "string", required: true },
            { name: "title", type: "string", required: true },
            { name: "open", type: "boolean", required: true },
          ],
          relationships: ["issue belongs to workspace"],
        },
      ],
      apiRoutes: [
        {
          method: "GET",
          path: "/api/app/generated/ops-board/issues",
          access: "private",
          purpose: "List issues.",
          handler: "listIssues",
          authRequired: true,
        },
      ],
      crudFlows: [
        {
          entity: "issue",
          create: "Create issue",
          read: "List issues",
          update: "Update issue",
          delete: "Archive issue",
          validation: ["title is required"],
        },
      ],
      authDecisions: [
        {
          area: "board",
          decision: "private",
          rationale: "Operational issue data is workspace-private.",
        },
      ],
    },
  };
}
