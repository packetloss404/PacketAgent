import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export interface GeneratedAppWorkspaceMetadata {
  workspaceSlug: string;
  appSlug: string;
  checkpointId: string;
  workspaceId?: string;
  appId?: string;
  checkpointLabel?: string;
  checkpointCreatedAt?: string;
}

export interface GeneratedAppWorkspaceResolveOptions {
  rootDir?: string;
  generatedAppsRoot?: string;
}

export interface GeneratedAppWorkspacePaths {
  generatedAppsRoot: string;
  workspacePath: string;
  relativeWorkspacePath: string;
  manifestPath: string;
  relativeManifestPath: string;
  workspaceSlug: string;
  appSlug: string;
  checkpointId: string;
}

export interface GeneratedAppWorkspaceWriteFile {
  path: string;
  content: string;
  contentType?: string;
  role?: string;
}

export interface GeneratedAppWorkspaceFileManifestEntry {
  path: string;
  contentType: string;
  role?: string;
  size: number;
  sha256: string;
}

export interface GeneratedAppWorkspaceManifest {
  version: "generated-app-workspace.v1";
  workspacePath: string;
  relativeWorkspacePath: string;
  checkpoint: {
    id: string;
    label?: string;
    createdAt?: string;
  };
  workspace: {
    slug: string;
    id?: string;
  };
  app: {
    slug: string;
    id?: string;
  };
  writtenAt: string;
  files: GeneratedAppWorkspaceFileManifestEntry[];
}

export interface GeneratedAppWorkspaceWriteInput extends GeneratedAppWorkspaceMetadata {
  files: GeneratedAppWorkspaceWriteFile[];
  writtenAt?: string;
}

export interface GeneratedAppWorkspaceWriteResult {
  paths: GeneratedAppWorkspacePaths;
  manifest: GeneratedAppWorkspaceManifest;
}

export interface GeneratedAppWorkspaceReadResult extends GeneratedAppWorkspaceFileManifestEntry {
  content: string;
}

const MANIFEST_RELATIVE_PATH = ".packetagent/generated-app-workspace-manifest.json";

export function resolveGeneratedAppWorkspacePath(
  metadata: GeneratedAppWorkspaceMetadata,
  options: GeneratedAppWorkspaceResolveOptions = {},
): GeneratedAppWorkspacePaths {
  const workspaceSlug = safePathSegment(metadata.workspaceSlug, "workspaceSlug");
  const appSlug = safePathSegment(metadata.appSlug, "appSlug");
  const checkpointId = safePathSegment(metadata.checkpointId, "checkpointId");
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const generatedAppsRoot = path.resolve(options.generatedAppsRoot ?? path.join(rootDir, "data", "generated-apps"));
  const workspacePath = path.resolve(generatedAppsRoot, workspaceSlug, appSlug, "workspace");

  assertInsidePath(generatedAppsRoot, workspacePath, "generated app workspace path");

  const manifestPath = path.resolve(workspacePath, MANIFEST_RELATIVE_PATH);
  assertInsidePath(workspacePath, manifestPath, "generated app workspace manifest path");

  return {
    generatedAppsRoot,
    workspacePath,
    relativeWorkspacePath: normalizeRelativePath(path.relative(rootDir, workspacePath)),
    manifestPath,
    relativeManifestPath: normalizeRelativePath(path.relative(rootDir, manifestPath)),
    workspaceSlug,
    appSlug,
    checkpointId,
  };
}

export async function writeGeneratedAppWorkspace(
  input: GeneratedAppWorkspaceWriteInput,
  options: GeneratedAppWorkspaceResolveOptions = {},
): Promise<GeneratedAppWorkspaceWriteResult> {
  const paths = resolveGeneratedAppWorkspacePath(input, options);
  const files = normalizeWorkspaceFiles(input.files);

  await mkdir(paths.workspacePath, { recursive: true });

  for (const file of files) {
    const destination = resolveWorkspaceFilePath(paths.workspacePath, file.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFileAtomically(destination, file.content);
  }

  const manifest: GeneratedAppWorkspaceManifest = removeUndefined({
    version: "generated-app-workspace.v1" as const,
    workspacePath: paths.workspacePath,
    relativeWorkspacePath: paths.relativeWorkspacePath,
    checkpoint: removeUndefined({
      id: paths.checkpointId,
      label: cleanOptionalString(input.checkpointLabel),
      createdAt: cleanOptionalString(input.checkpointCreatedAt),
    }),
    workspace: removeUndefined({
      slug: paths.workspaceSlug,
      id: cleanOptionalString(input.workspaceId),
    }),
    app: removeUndefined({
      slug: paths.appSlug,
      id: cleanOptionalString(input.appId),
    }),
    writtenAt: input.writtenAt ?? new Date().toISOString(),
    files: files.map((file) => ({
      path: file.path,
      contentType: file.contentType ?? contentTypeForPath(file.path),
      role: file.role,
      size: Buffer.byteLength(file.content, "utf8"),
      sha256: sha256(file.content),
    })),
  });

  await mkdir(path.dirname(paths.manifestPath), { recursive: true });
  await writeFileAtomically(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return { paths, manifest };
}

export async function readGeneratedAppWorkspaceManifest(
  metadata: GeneratedAppWorkspaceMetadata,
  options: GeneratedAppWorkspaceResolveOptions = {},
): Promise<GeneratedAppWorkspaceManifest> {
  const paths = resolveGeneratedAppWorkspacePath(metadata, options);
  const contents = await readFile(paths.manifestPath, "utf8");
  return JSON.parse(contents) as GeneratedAppWorkspaceManifest;
}

export async function listGeneratedAppWorkspaceFiles(
  metadata: GeneratedAppWorkspaceMetadata,
  options: GeneratedAppWorkspaceResolveOptions = {},
): Promise<GeneratedAppWorkspaceFileManifestEntry[]> {
  try {
    const manifest = await readGeneratedAppWorkspaceManifest(metadata, options);
    return [...manifest.files].sort(compareWorkspaceFiles);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }

  const paths = resolveGeneratedAppWorkspacePath(metadata, options);
  const discovered = await discoverWorkspaceFiles(paths.workspacePath);
  return discovered.sort(compareWorkspaceFiles);
}

export async function readGeneratedAppWorkspaceFile(
  metadata: GeneratedAppWorkspaceMetadata,
  filePath: string,
  options: GeneratedAppWorkspaceResolveOptions = {},
): Promise<GeneratedAppWorkspaceReadResult> {
  const paths = resolveGeneratedAppWorkspacePath(metadata, options);
  const normalizedFilePath = normalizeWorkspaceFilePath(filePath);
  const absoluteFilePath = resolveWorkspaceFilePath(paths.workspacePath, normalizedFilePath);
  const content = await readFile(absoluteFilePath, "utf8");

  return {
    path: normalizedFilePath,
    content,
    contentType: contentTypeForPath(normalizedFilePath),
    size: Buffer.byteLength(content, "utf8"),
    sha256: sha256(content),
  };
}

export function normalizeGeneratedAppWorkspaceFilePath(filePath: string): string {
  return normalizeWorkspaceFilePath(filePath);
}

async function writeFileAtomically(destination: string, content: string) {
  const tempPath = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(tempPath, content, "utf8");
  try {
    await rename(tempPath, destination);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

function normalizeWorkspaceFiles(files: GeneratedAppWorkspaceWriteFile[]): GeneratedAppWorkspaceWriteFile[] {
  const seen = new Set<string>();

  return files.map((file) => {
    const filePath = normalizeWorkspaceFilePath(file.path);
    if (seen.has(filePath)) throw new Error(`duplicate generated app workspace file path: ${filePath}`);
    seen.add(filePath);
    return {
      path: filePath,
      content: String(file.content ?? ""),
      contentType: file.contentType,
      role: file.role,
    };
  });
}

function resolveWorkspaceFilePath(workspacePath: string, filePath: string): string {
  const normalizedFilePath = normalizeWorkspaceFilePath(filePath);
  const absoluteFilePath = path.resolve(workspacePath, normalizedFilePath);
  assertInsidePath(workspacePath, absoluteFilePath, "generated app workspace file path");
  return absoluteFilePath;
}

async function discoverWorkspaceFiles(workspacePath: string, prefix = ""): Promise<GeneratedAppWorkspaceFileManifestEntry[]> {
  let entries;
  try {
    entries = await readdir(path.join(workspacePath, prefix), { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }

  const files: GeneratedAppWorkspaceFileManifestEntry[] = [];
  for (const entry of entries) {
    const relativePath = normalizeRelativePath(path.posix.join(prefix.replace(/\\/g, "/"), entry.name));
    if (relativePath === ".packetagent" || relativePath.startsWith(".packetagent/")) continue;
    const absolutePath = path.join(workspacePath, relativePath);
    if (entry.isDirectory()) {
      files.push(...await discoverWorkspaceFiles(workspacePath, relativePath));
      continue;
    }
    if (!entry.isFile()) continue;
    const content = await readFile(absolutePath, "utf8");
    const info = await stat(absolutePath);
    files.push({
      path: relativePath,
      contentType: contentTypeForPath(relativePath),
      size: info.size,
      sha256: sha256(content),
    });
  }
  return files;
}

function normalizeWorkspaceFilePath(filePath: string): string {
  const value = String(filePath ?? "").trim();
  if (!value) throw new Error("generated app workspace file path is required");
  if (value.includes("\0")) throw new Error("generated app workspace file path cannot contain null bytes");

  const withForwardSlashes = value.replace(/\\/g, "/");
  if (path.posix.isAbsolute(withForwardSlashes) || /^[a-zA-Z]:\//.test(withForwardSlashes)) {
    throw new Error(`generated app workspace file path must be relative: ${value}`);
  }

  const segments = withForwardSlashes.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`generated app workspace file path cannot traverse directories: ${value}`);
  }

  return path.posix.normalize(withForwardSlashes);
}

function safePathSegment(value: string, label: string): string {
  const cleaned = String(value ?? "").trim();
  if (
    !cleaned
    || cleaned === "."
    || cleaned === ".."
    || cleaned.includes("\0")
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(cleaned)
  ) {
    throw new Error(`unsafe generated app ${label}: ${String(value ?? "")}`);
  }
  return cleaned;
}

function assertInsidePath(parentPath: string, childPath: string, label: string) {
  const relative = path.relative(parentPath, childPath);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`${label} escapes generated app workspace root`);
}

function contentTypeForPath(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".tsx") || filePath.endsWith(".ts")) return "text/typescript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".md")) return "text/markdown; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function cleanOptionalString(value: string | undefined): string | undefined {
  const cleaned = String(value ?? "").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function removeUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

function compareWorkspaceFiles(left: GeneratedAppWorkspaceFileManifestEntry, right: GeneratedAppWorkspaceFileManifestEntry): number {
  return left.path.localeCompare(right.path);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
