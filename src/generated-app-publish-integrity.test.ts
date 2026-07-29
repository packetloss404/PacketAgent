import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  GENERATED_APP_ARTIFACT_MANIFEST_CANONICALIZATION,
  GENERATED_APP_ARTIFACT_MANIFEST_SCHEMA_VERSION,
  sealGeneratedAppPublishArtifactManifest,
  verifyGeneratedAppPublishArtifactManifest,
  type GeneratedAppPublishArtifactFile,
} from "./generated-app-publish-integrity.js";

const SIGNING_KEY = "packetagent-test-publish-signing-key-32-bytes";

function artifactFiles(): GeneratedAppPublishArtifactFile[] {
  return [
    {
      path: "bundle/index.html",
      content:
        '<!doctype html><link rel="stylesheet" href="/assets/app.css"><script type="module" src="/assets/app.js"></script>',
      kind: "generated_bundle",
      description: "Built app entrypoint.",
    },
    {
      path: "bundle/assets/app.css",
      content: ".hero{background:url('./background.svg')}",
      kind: "build_output",
      description: "Built app stylesheet.",
    },
    {
      path: "bundle/assets/app.js",
      content: "document.body.dataset.ready = 'true';",
      kind: "build_output",
      description: "Built app JavaScript.",
    },
    {
      path: "bundle/assets/background.svg",
      content: '<svg xmlns="http://www.w3.org/2000/svg"/>',
      kind: "build_output",
      description: "Built app background.",
    },
    {
      path: "runtime-config.json",
      content: '{"runtime":"packetagent-generated-app"}\n',
      kind: "config",
      description: "Runtime configuration.",
    },
  ];
}

function writeArtifactRoot(files: GeneratedAppPublishArtifactFile[]): string {
  const root = mkdtempSync(path.join(tmpdir(), "packetagent-publish-integrity-"));
  for (const file of files) {
    const destination = path.join(root, file.path);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, file.content);
  }
  return root;
}

test("generated app manifest v2 binds files, static assets, digest, and optional signature", (t) => {
  const files = artifactFiles();
  const root = writeArtifactRoot(files);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = sealGeneratedAppPublishArtifactManifest({
    packageId: "alpha/ops-board/app",
    workspaceId: "workspace_alpha",
    appId: "app_ops",
    checkpointId: "checkpoint_1",
    generatedAt: "2026-07-29T12:00:00.000Z",
    entrypoint: "bundle/index.html",
    files,
    signing: { key: SIGNING_KEY, keyId: "test-key" },
  });
  writeFileSync(
    path.join(root, manifest.fileName),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  assert.equal(manifest.schemaVersion, GENERATED_APP_ARTIFACT_MANIFEST_SCHEMA_VERSION);
  assert.equal(
    manifest.integrity?.canonicalization,
    GENERATED_APP_ARTIFACT_MANIFEST_CANONICALIZATION,
  );
  assert.match(manifest.integrity?.digest ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.equal(manifest.staticAssets?.status, "pass");
  assert.deepEqual(
    manifest.staticAssets?.references.map((reference) => reference.targetPath),
    ["bundle/assets/background.svg", "bundle/assets/app.css", "bundle/assets/app.js"],
  );

  const verification = verifyGeneratedAppPublishArtifactManifest(manifest, {
    rootPath: root,
    signingKey: SIGNING_KEY,
  });
  assert.equal(verification.status, "verified");
  assert.equal(verification.checksumVerified, true);
  assert.equal(verification.signatureStatus, "verified");
  assert.equal(verification.checkedFiles, files.length);
  assert.deepEqual(verification.issues, []);

  const substituted = verifyGeneratedAppPublishArtifactManifest(manifest, {
    rootPath: root,
    signingKey: SIGNING_KEY,
    expectedSubject: {
      workspaceId: "workspace_alpha",
      appId: "different_app",
      checkpointId: "checkpoint_1",
    },
  });
  assert.equal(substituted.status, "invalid");
  assert.ok(
    substituted.issues.some(
      (issue) => issue.code === "manifest.subject.mismatch" && issue.path === "subject.appId",
    ),
  );
});

test("generated app manifest verification rejects modified and unexpected files", (t) => {
  const files = artifactFiles();
  const root = writeArtifactRoot(files);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = sealGeneratedAppPublishArtifactManifest({
    packageId: "alpha/ops-board/app",
    workspaceId: "workspace_alpha",
    appId: "app_ops",
    checkpointId: "checkpoint_1",
    generatedAt: "2026-07-29T12:00:00.000Z",
    entrypoint: "bundle/index.html",
    files,
  });
  writeFileSync(path.join(root, "bundle/assets/app.js"), "tampered", "utf8");
  writeFileSync(path.join(root, "bundle/unlisted.txt"), "unexpected", "utf8");

  const verification = verifyGeneratedAppPublishArtifactManifest(manifest, { rootPath: root });
  assert.equal(verification.status, "invalid");
  assert.equal(verification.signatureStatus, "unsigned");
  assert.ok(
    verification.issues.some(
      (issue) =>
        issue.code === "manifest.entry.digest_mismatch" && issue.path === "bundle/assets/app.js",
    ),
  );
  assert.ok(
    verification.issues.some(
      (issue) => issue.code === "manifest.entry.unexpected" && issue.path === "bundle/unlisted.txt",
    ),
  );
});

test("generated app manifest seals a failing static graph when a referenced asset is missing", () => {
  const files = artifactFiles().filter((file) => file.path !== "bundle/assets/background.svg");
  const manifest = sealGeneratedAppPublishArtifactManifest({
    packageId: "alpha/ops-board/app",
    workspaceId: "workspace_alpha",
    appId: "app_ops",
    checkpointId: "checkpoint_1",
    generatedAt: "2026-07-29T12:00:00.000Z",
    entrypoint: "bundle/index.html",
    files,
  });

  assert.equal(manifest.staticAssets?.status, "fail");
  assert.ok(
    manifest.staticAssets?.issues.some(
      (issue) =>
        issue.code === "static_asset.target_missing" &&
        issue.path === "bundle/assets/background.svg",
    ),
  );
});

test("generated app manifest signing rejects weak configured keys", () => {
  assert.throws(
    () =>
      sealGeneratedAppPublishArtifactManifest({
        packageId: "alpha/ops-board/app",
        workspaceId: "workspace_alpha",
        appId: "app_ops",
        checkpointId: "checkpoint_1",
        generatedAt: "2026-07-29T12:00:00.000Z",
        entrypoint: "bundle/index.html",
        files: artifactFiles(),
        signing: { key: "too-short", keyId: "weak" },
      }),
    /at least 32 bytes/,
  );
});
