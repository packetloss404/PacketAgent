import { createHash } from "node:crypto";
import { strToU8, zipSync, type Zippable } from "fflate";
import { validateWorkspacePath } from "./path-validator.js";
import type { GeneratedFile } from "./llm-author.js";
import type { GeneratedAppPackageInstallPlan } from "./package-plan.js";

const MAX_EXPORT_FILE_COUNT = 500;
const MAX_EXPORT_SOURCE_BYTES = 10 * 1024 * 1024;
const DEFAULT_GITIGNORE = "node_modules/\ndist/\n.env\n.env.*\n!.env.example\n";

export interface GeneratedAppExportInput {
  appId: string;
  appSlug: string;
  workspaceId: string;
  checkpointId: string;
  checkpointCreatedAt?: string;
  files: GeneratedFile[];
  packagePlan: GeneratedAppPackageInstallPlan;
  exportedAt?: string;
}

export interface GeneratedAppExportManifest {
  version: "packetagent.generated-app-export/v1";
  appId: string;
  appSlug: string;
  workspaceId: string;
  checkpointId: string;
  exportedAt: string;
  packagePlanStatus: GeneratedAppPackageInstallPlan["status"];
  packagePlanSha256: string;
  files: Array<{ path: string; size: number; sha256: string }>;
}

export interface GeneratedAppExportResult {
  bytes: Uint8Array;
  fileName: string;
  manifest: GeneratedAppExportManifest;
}

export function buildGeneratedAppWorkspaceExport(
  input: GeneratedAppExportInput,
): GeneratedAppExportResult {
  if (input.files.length > MAX_EXPORT_FILE_COUNT) {
    throw new Error(`generated app export exceeds ${MAX_EXPORT_FILE_COUNT} files`);
  }
  const sourceFiles = normalizeExportFiles(input.files);
  const sourceBytes = sourceFiles.reduce(
    (total, file) => total + Buffer.byteLength(file.content),
    0,
  );
  if (sourceBytes > MAX_EXPORT_SOURCE_BYTES) {
    throw new Error(`generated app export exceeds ${MAX_EXPORT_SOURCE_BYTES} source bytes`);
  }

  const exportedAt = normalizedExportTimestamp(input.exportedAt ?? new Date().toISOString());
  const packagePlanJson = `${JSON.stringify(input.packagePlan, null, 2)}\n`;
  const payloadFiles = new Map(sourceFiles.map((file) => [file.path, file.content]));
  addExportFile(payloadFiles, ".packetagent/package-install-plan.json", packagePlanJson);
  if (!payloadFiles.has(".gitignore")) addExportFile(payloadFiles, ".gitignore", DEFAULT_GITIGNORE);
  addExportFile(payloadFiles, "PACKETAGENT_EXPORT.md", exportReadme(input.packagePlan));

  const manifestFiles = [...payloadFiles.entries()]
    .map(([path, content]) => ({
      path,
      size: Buffer.byteLength(content),
      sha256: sha256(content),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const manifest: GeneratedAppExportManifest = {
    version: "packetagent.generated-app-export/v1",
    appId: input.appId,
    appSlug: input.appSlug,
    workspaceId: input.workspaceId,
    checkpointId: input.checkpointId,
    exportedAt,
    packagePlanStatus: input.packagePlan.status,
    packagePlanSha256: sha256(packagePlanJson),
    files: manifestFiles,
  };
  addExportFile(
    payloadFiles,
    ".packetagent/generated-app-export-manifest.json",
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const root = safeArchiveSegment(input.appSlug || input.appId);
  const archive: Zippable = {};
  for (const [path, content] of [...payloadFiles.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    archive[`${root}/${path}`] = strToU8(content);
  }
  const bytes = zipSync(archive, {
    level: 6,
    mtime: new Date(exportedAt),
  });

  return {
    bytes,
    fileName: `${root}-${safeArchiveSegment(input.checkpointId)}.zip`,
    manifest,
  };
}

function normalizeExportFiles(files: GeneratedFile[]): GeneratedFile[] {
  const seen = new Set<string>();
  return files.map((file) => {
    const checked = validateWorkspacePath(file.path);
    if (!checked.ok || !checked.normalized) {
      throw new Error(`invalid generated app export path: ${file.path}`);
    }
    if (seen.has(checked.normalized)) {
      throw new Error(`duplicate generated app export path: ${checked.normalized}`);
    }
    seen.add(checked.normalized);
    return { path: checked.normalized, content: String(file.content ?? "") };
  });
}

function addExportFile(files: Map<string, string>, path: string, content: string): void {
  if (files.has(path))
    throw new Error(`generated app export metadata path already exists: ${path}`);
  files.set(path, content);
}

function exportReadme(plan: GeneratedAppPackageInstallPlan): string {
  const install =
    plan.status === "ready" && plan.command
      ? `The reviewed install plan is: \`${plan.command.join(" ")}\`. Run it only in a sandbox you control.`
      : plan.status === "not_required"
        ? "This source bundle does not require a package install."
        : "The package plan is blocked or invalid. Review `.packetagent/package-install-plan.json` before running any package-manager command.";
  return [
    "# PacketAgent generated app export",
    "",
    "This directory is git-ready source from one immutable PacketAgent checkpoint.",
    "PacketAgent did not run a package installation while creating this export.",
    "",
    install,
    "",
    "Suggested next steps:",
    "",
    "1. Review `.packetagent/generated-app-export-manifest.json` and the package plan.",
    "2. Initialize a repository with `git init` if desired.",
    "3. Run package installation only after the plan is ready and in an isolated environment.",
    "4. Run the app's documented build command.",
    "",
  ].join("\n");
}

function normalizedExportTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new Error("invalid generated app export time");
  const zipEpoch = Date.UTC(1980, 0, 1);
  if (timestamp.getTime() < zipEpoch) return new Date(zipEpoch).toISOString();
  return timestamp.toISOString();
}

function safeArchiveSegment(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || "generated-app";
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
