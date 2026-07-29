import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type {
  GeneratedAppPublishArtifactManifest,
  GeneratedAppPublishArtifactManifestEntry,
  GeneratedAppPublishManifestIssue,
  GeneratedAppPublishStaticAssetReference,
} from "./store/types.js";

export const GENERATED_APP_ARTIFACT_MANIFEST_SCHEMA_VERSION =
  "packetagent.generated-app-artifact-manifest/v2" as const;
export const GENERATED_APP_ARTIFACT_MANIFEST_CANONICALIZATION =
  "packetagent.generated-app-artifact-manifest-canonical-json/v1" as const;
export const GENERATED_APP_ARTIFACT_MANIFEST_DIGEST_ALGORITHM = "sha256" as const;
export const GENERATED_APP_ARTIFACT_MANIFEST_FILE_NAME = "publish-artifacts.json" as const;

const MAX_MANIFEST_FILES = 1_000;
const MAX_MANIFEST_BYTES = 25 * 1024 * 1024;

export interface GeneratedAppPublishArtifactFile {
  path: string;
  content: string | Uint8Array;
  kind: GeneratedAppPublishArtifactManifestEntry["kind"];
  description: string;
  mediaType?: string;
}

export interface SealGeneratedAppPublishArtifactManifestInput {
  packageId: string;
  workspaceId: string;
  appId: string;
  checkpointId: string;
  generatedAt: string;
  entrypoint: string;
  files: GeneratedAppPublishArtifactFile[];
  signing?: {
    key: string;
    keyId: string;
  };
}

export interface VerifyGeneratedAppPublishArtifactManifestOptions {
  rootPath: string;
  signingKey?: string;
  expectedSubject?: {
    workspaceId: string;
    appId: string;
    checkpointId: string;
  };
}

export interface GeneratedAppPublishArtifactVerification {
  status: "verified" | "invalid";
  checksumVerified: boolean;
  signatureStatus: "unsigned" | "verified" | "unverifiable" | "invalid";
  checkedFiles: number;
  checkedBytes: number;
  issues: GeneratedAppPublishManifestIssue[];
}

type ManifestDigestSubject = Omit<GeneratedAppPublishArtifactManifest, "integrity"> & {
  integrity: {
    canonicalization: typeof GENERATED_APP_ARTIFACT_MANIFEST_CANONICALIZATION;
    algorithm: typeof GENERATED_APP_ARTIFACT_MANIFEST_DIGEST_ALGORITHM;
  };
};

export function sealGeneratedAppPublishArtifactManifest(
  input: SealGeneratedAppPublishArtifactManifestInput,
): GeneratedAppPublishArtifactManifest {
  const files = normalizeArtifactFiles(input.files);
  const staticAssets = validateStaticAssetGraph(files, input.entrypoint);
  const unsigned: Omit<GeneratedAppPublishArtifactManifest, "integrity"> = {
    schemaVersion: GENERATED_APP_ARTIFACT_MANIFEST_SCHEMA_VERSION,
    fileName: GENERATED_APP_ARTIFACT_MANIFEST_FILE_NAME,
    packageId: requiredText(input.packageId, "packageId"),
    generatedAt: canonicalTimestamp(input.generatedAt),
    subject: {
      workspaceId: requiredText(input.workspaceId, "workspaceId"),
      appId: requiredText(input.appId, "appId"),
      checkpointId: requiredText(input.checkpointId, "checkpointId"),
    },
    entries: files.map((file) => ({
      path: file.path,
      kind: file.kind,
      required: true,
      description: file.description,
      mediaType: file.mediaType ?? mediaTypeForPath(file.path),
      size: file.bytes.byteLength,
      sha256: sha256Hex(file.bytes),
    })),
    staticAssets,
  };
  const subject = manifestDigestSubject({
    ...unsigned,
    integrity: {
      canonicalization: GENERATED_APP_ARTIFACT_MANIFEST_CANONICALIZATION,
      algorithm: GENERATED_APP_ARTIFACT_MANIFEST_DIGEST_ALGORITHM,
      digest: "",
    },
  });
  const canonicalBytes = Buffer.from(canonicalJson(subject));
  const digest = `sha256:${sha256Hex(canonicalBytes)}`;
  const signature = input.signing
    ? {
        algorithm: "hmac-sha256" as const,
        keyId: requiredText(input.signing.keyId, "signing.keyId"),
        value: createHmac("sha256", validateSigningKey(input.signing.key))
          .update(canonicalBytes)
          .digest("base64url"),
      }
    : undefined;

  return {
    ...unsigned,
    integrity: {
      canonicalization: GENERATED_APP_ARTIFACT_MANIFEST_CANONICALIZATION,
      algorithm: GENERATED_APP_ARTIFACT_MANIFEST_DIGEST_ALGORITHM,
      digest,
      ...(signature ? { signature } : {}),
    },
  };
}

export function verifyGeneratedAppPublishArtifactManifest(
  manifest: GeneratedAppPublishArtifactManifest,
  options: VerifyGeneratedAppPublishArtifactManifestOptions,
): GeneratedAppPublishArtifactVerification {
  const issues: GeneratedAppPublishManifestIssue[] = [];
  let checksumVerified = false;
  let signatureStatus: GeneratedAppPublishArtifactVerification["signatureStatus"] = "unsigned";
  let checkedFiles = 0;
  let checkedBytes = 0;

  if (
    manifest.schemaVersion !== GENERATED_APP_ARTIFACT_MANIFEST_SCHEMA_VERSION ||
    !manifest.integrity ||
    !manifest.subject ||
    !manifest.staticAssets
  ) {
    issues.push({
      code: "manifest.version.unsupported",
      path: GENERATED_APP_ARTIFACT_MANIFEST_FILE_NAME,
      message: "Artifact verification requires a generated-app manifest v2 record.",
    });
    return {
      status: "invalid",
      checksumVerified,
      signatureStatus,
      checkedFiles,
      checkedBytes,
      issues,
    };
  }

  if (options.expectedSubject) {
    for (const key of ["workspaceId", "appId", "checkpointId"] as const) {
      if (!safeEqual(manifest.subject[key], options.expectedSubject[key])) {
        issues.push({
          code: "manifest.subject.mismatch",
          path: `subject.${key}`,
          message: `Manifest ${key} does not match the requested publish checkpoint.`,
        });
      }
    }
  }

  let canonicalBytes: Buffer | null = null;
  try {
    const subject = manifestDigestSubject(manifest);
    canonicalBytes = Buffer.from(canonicalJson(subject));
    const expectedDigest = `sha256:${sha256Hex(canonicalBytes)}`;
    checksumVerified = safeEqual(manifest.integrity.digest, expectedDigest);
    if (!checksumVerified) {
      issues.push({
        code: "manifest.digest.mismatch",
        path: GENERATED_APP_ARTIFACT_MANIFEST_FILE_NAME,
        message: "The manifest digest does not match its canonical contents.",
      });
    }
  } catch {
    issues.push({
      code: "manifest.canonicalization.failed",
      path: GENERATED_APP_ARTIFACT_MANIFEST_FILE_NAME,
      message: "The manifest contains values that cannot be canonically encoded.",
    });
  }

  const signature = manifest.integrity.signature;
  if (signature) {
    if (!options.signingKey || !canonicalBytes) {
      signatureStatus = "unverifiable";
      issues.push({
        code: "manifest.signature.key_unavailable",
        path: GENERATED_APP_ARTIFACT_MANIFEST_FILE_NAME,
        message: `Signature ${signature.keyId} cannot be verified without the configured signing key.`,
      });
    } else {
      const expected = createHmac("sha256", options.signingKey)
        .update(canonicalBytes)
        .digest("base64url");
      signatureStatus = safeEqual(signature.value, expected) ? "verified" : "invalid";
      if (signatureStatus === "invalid") {
        issues.push({
          code: "manifest.signature.invalid",
          path: GENERATED_APP_ARTIFACT_MANIFEST_FILE_NAME,
          message: `Signature ${signature.keyId} does not match the canonical manifest.`,
        });
      }
    }
  }

  const normalizedEntries = new Map<string, GeneratedAppPublishArtifactManifestEntry>();
  if (manifest.entries.length > MAX_MANIFEST_FILES) {
    issues.push({
      code: "manifest.bounds.file_count",
      path: GENERATED_APP_ARTIFACT_MANIFEST_FILE_NAME,
      message: `Artifact manifest exceeds the ${MAX_MANIFEST_FILES}-file verification limit.`,
    });
  }
  for (const entry of manifest.entries.slice(0, MAX_MANIFEST_FILES + 1)) {
    let normalizedPath: string;
    try {
      normalizedPath = normalizeArtifactPath(entry.path);
    } catch {
      issues.push({
        code: "manifest.entry.path_invalid",
        path: String(entry.path ?? ""),
        message: "Manifest entry path is not a safe relative artifact path.",
      });
      continue;
    }
    if (normalizedEntries.has(normalizedPath)) {
      issues.push({
        code: "manifest.entry.duplicate",
        path: normalizedPath,
        message: "Manifest entry path is duplicated.",
      });
      continue;
    }
    normalizedEntries.set(normalizedPath, entry);
    const absolutePath = resolveInside(options.rootPath, normalizedPath);
    let bytes: Buffer;
    try {
      assertNoSymlinkPath(options.rootPath, normalizedPath);
      const stats = lstatSync(absolutePath);
      if (!stats.isFile()) throw new Error("not a regular file");
      if (checkedFiles >= MAX_MANIFEST_FILES || checkedBytes + stats.size > MAX_MANIFEST_BYTES) {
        issues.push({
          code: "manifest.bounds.byte_count",
          path: normalizedPath,
          message: `Artifact verification exceeds the ${MAX_MANIFEST_BYTES}-byte limit.`,
        });
        continue;
      }
      bytes = readFileSync(absolutePath);
    } catch {
      issues.push({
        code: "manifest.entry.missing",
        path: normalizedPath,
        message: "Required artifact file is missing.",
      });
      continue;
    }
    checkedFiles += 1;
    checkedBytes += bytes.byteLength;
    if (entry.size !== bytes.byteLength) {
      issues.push({
        code: "manifest.entry.size_mismatch",
        path: normalizedPath,
        message: "Artifact byte size does not match the manifest.",
      });
    }
    if (!entry.sha256 || !safeEqual(entry.sha256, sha256Hex(bytes))) {
      issues.push({
        code: "manifest.entry.digest_mismatch",
        path: normalizedPath,
        message: "Artifact SHA-256 does not match the manifest.",
      });
    }
  }

  const discoveredFiles = discoverArtifactFiles(options.rootPath);
  if (discoveredFiles.length > MAX_MANIFEST_FILES) {
    issues.push({
      code: "manifest.bounds.discovered_files",
      path: GENERATED_APP_ARTIFACT_MANIFEST_FILE_NAME,
      message: `Publish root exceeds the ${MAX_MANIFEST_FILES}-file verification limit.`,
    });
  }
  for (const discovered of discoveredFiles.slice(0, MAX_MANIFEST_FILES + 1)) {
    if (
      discovered !== GENERATED_APP_ARTIFACT_MANIFEST_FILE_NAME &&
      !normalizedEntries.has(discovered)
    ) {
      issues.push({
        code: "manifest.entry.unexpected",
        path: discovered,
        message: "Artifact file exists on disk but is not bound by the manifest.",
      });
    }
  }

  try {
    const diskFiles = [...normalizedEntries]
      .filter(([entryPath]) => !issues.some((issue) => issue.path === entryPath))
      .map(([entryPath, entry]) => ({
        path: entryPath,
        kind: entry.kind,
        description: entry.description,
        mediaType: entry.mediaType,
        bytes: readFileSync(resolveInside(options.rootPath, entryPath)),
      }));
    const observedStaticAssets = validateStaticAssetGraph(
      diskFiles,
      manifest.staticAssets.entrypoint,
    );
    if (canonicalJson(observedStaticAssets) !== canonicalJson(manifest.staticAssets)) {
      issues.push({
        code: "manifest.static_assets.mismatch",
        path: manifest.staticAssets.entrypoint,
        message: "Static asset references do not match the manifest.",
      });
    }
    if (manifest.staticAssets.status !== "pass") {
      issues.push(...manifest.staticAssets.issues);
    }
  } catch {
    issues.push({
      code: "manifest.static_assets.unverifiable",
      path: manifest.staticAssets.entrypoint,
      message: "Static asset references could not be verified.",
    });
  }

  return {
    status: issues.length === 0 ? "verified" : "invalid",
    checksumVerified,
    signatureStatus,
    checkedFiles,
    checkedBytes,
    issues: uniqueIssues(issues),
  };
}

function normalizeArtifactFiles(files: GeneratedAppPublishArtifactFile[]): Array<
  Omit<GeneratedAppPublishArtifactFile, "content"> & {
    path: string;
    bytes: Buffer;
  }
> {
  if (files.length === 0) throw new Error("publish artifact manifest requires at least one file");
  if (files.length > MAX_MANIFEST_FILES) {
    throw new Error(`publish artifact manifest exceeds ${MAX_MANIFEST_FILES} files`);
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  const normalized = files.map((file) => {
    const filePath = normalizeArtifactPath(file.path);
    if (filePath === GENERATED_APP_ARTIFACT_MANIFEST_FILE_NAME) {
      throw new Error("publish artifact manifest cannot include itself");
    }
    if (seen.has(filePath)) throw new Error(`duplicate publish artifact path: ${filePath}`);
    seen.add(filePath);
    const bytes =
      typeof file.content === "string"
        ? Buffer.from(file.content, "utf8")
        : Buffer.from(file.content);
    totalBytes += bytes.byteLength;
    return {
      path: filePath,
      bytes,
      kind: file.kind,
      description: requiredText(file.description, `${filePath}.description`),
      mediaType: file.mediaType,
    };
  });
  if (totalBytes > MAX_MANIFEST_BYTES) {
    throw new Error(`publish artifact manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
  }
  return normalized.sort((left, right) => left.path.localeCompare(right.path));
}

function validateStaticAssetGraph(
  files: Array<{ path: string; bytes: Uint8Array }>,
  rawEntrypoint: string,
): GeneratedAppPublishArtifactManifest["staticAssets"] {
  const entrypoint = normalizeArtifactPath(rawEntrypoint);
  const byPath = new Map(files.map((file) => [file.path, file]));
  const issues: GeneratedAppPublishManifestIssue[] = [];
  const references: GeneratedAppPublishStaticAssetReference[] = [];
  const entry = byPath.get(entrypoint);
  if (!entry) {
    issues.push({
      code: "static_asset.entrypoint_missing",
      path: entrypoint,
      message: "Static asset entrypoint is missing from the artifact.",
    });
  } else {
    const html = Buffer.from(entry.bytes).toString("utf8");
    for (const reference of extractHtmlAssetReferences(entrypoint, html)) {
      references.push(reference);
      if (!byPath.has(reference.targetPath)) {
        issues.push({
          code: "static_asset.target_missing",
          path: reference.targetPath,
          message: `Static asset referenced by ${reference.sourcePath} is missing.`,
        });
      }
    }
  }
  for (const file of files.filter((candidate) => candidate.path.toLowerCase().endsWith(".css"))) {
    const css = Buffer.from(file.bytes).toString("utf8");
    for (const reference of extractCssAssetReferences(file.path, css)) {
      references.push(reference);
      if (!byPath.has(reference.targetPath)) {
        issues.push({
          code: "static_asset.target_missing",
          path: reference.targetPath,
          message: `Static asset referenced by ${reference.sourcePath} is missing.`,
        });
      }
    }
  }
  return {
    status: issues.length === 0 ? "pass" : "fail",
    entrypoint,
    references: uniqueReferences(references),
    issues: uniqueIssues(issues),
  };
}

function extractHtmlAssetReferences(
  sourcePath: string,
  html: string,
): GeneratedAppPublishStaticAssetReference[] {
  const references: GeneratedAppPublishStaticAssetReference[] = [];
  const tagPattern = /<(script|link|img|source|video|audio)\b[^>]*>/gi;
  for (const match of html.matchAll(tagPattern)) {
    const tag = match[0];
    for (const attribute of ["src", "href", "poster", "srcset"] as const) {
      const attributeMatch = tag.match(
        new RegExp(`\\b${attribute}\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))`, "i"),
      );
      if (!attributeMatch) continue;
      const value = attributeMatch[1] ?? attributeMatch[2] ?? attributeMatch[3] ?? "";
      const candidates =
        attribute === "srcset"
          ? value.split(",").map((part) => part.trim().split(/\s+/, 1)[0] ?? "")
          : [value];
      for (const candidate of candidates) {
        const targetPath = resolveStaticAssetTarget(sourcePath, candidate);
        if (!targetPath) continue;
        references.push({ sourcePath, targetPath, attribute });
      }
    }
  }
  return references;
}

function extractCssAssetReferences(
  sourcePath: string,
  css: string,
): GeneratedAppPublishStaticAssetReference[] {
  const references: GeneratedAppPublishStaticAssetReference[] = [];
  for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi)) {
    const targetPath = resolveStaticAssetTarget(sourcePath, match[1] ?? match[2] ?? match[3] ?? "");
    if (targetPath) references.push({ sourcePath, targetPath, attribute: "css-url" });
  }
  return references;
}

function resolveStaticAssetTarget(sourcePath: string, rawReference: string): string | null {
  const reference = rawReference.trim();
  if (
    !reference ||
    reference.startsWith("#") ||
    /^(?:data|blob|mailto|tel|javascript):/i.test(reference)
  ) {
    return null;
  }
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(reference)) {
    return `external:${reference}`;
  }
  const withoutQuery = reference.split(/[?#]/, 1)[0] ?? "";
  if (!withoutQuery) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    decoded = withoutQuery;
  }
  const artifactRoot = sourcePath.split("/", 1)[0] ?? "";
  const candidate = decoded.startsWith("/")
    ? path.posix.join(artifactRoot, decoded.slice(1))
    : path.posix.join(path.posix.dirname(sourcePath), decoded);
  return normalizeArtifactPath(candidate);
}

function manifestDigestSubject(
  manifest: GeneratedAppPublishArtifactManifest,
): ManifestDigestSubject {
  const { integrity: _integrity, ...content } = manifest;
  return {
    ...content,
    integrity: {
      canonicalization: GENERATED_APP_ARTIFACT_MANIFEST_CANONICALIZATION,
      algorithm: GENERATED_APP_ARTIFACT_MANIFEST_DIGEST_ALGORITHM,
    },
  };
}

function normalizeArtifactPath(value: string): string {
  const raw = String(value ?? "")
    .trim()
    .replace(/\\/g, "/");
  if (!raw || raw.includes("\0") || path.posix.isAbsolute(raw) || /^[a-zA-Z]:\//.test(raw)) {
    throw new Error("artifact path must be safe and relative");
  }
  const normalized = path.posix.normalize(raw);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("artifact path must stay inside the publish root");
  }
  return normalized;
}

function resolveInside(rootPath: string, relativePath: string): string {
  const root = path.resolve(rootPath);
  const target = path.resolve(root, normalizeArtifactPath(relativePath));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("artifact path escapes publish root");
  }
  return target;
}

function discoverArtifactFiles(rootPath: string, prefix = ""): string[] {
  let entries;
  try {
    entries = readdirSync(path.join(rootPath, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (files.length > MAX_MANIFEST_FILES) break;
    const relativePath = normalizeArtifactPath(path.posix.join(prefix, entry.name));
    if (entry.isDirectory()) files.push(...discoverArtifactFiles(rootPath, relativePath));
    else files.push(relativePath);
  }
  return files.sort();
}

function mediaTypeForPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".html")) return "text/html; charset=utf-8";
  if (lower.endsWith(".css")) return "text/css; charset=utf-8";
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "text/typescript; charset=utf-8";
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".woff2")) return "font/woff2";
  if (lower.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "application/yaml; charset=utf-8";
  return "application/octet-stream";
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    assertUnicodeScalarString(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON requires finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => {
        assertUnicodeScalarString(key);
        return `${JSON.stringify(key)}:${canonicalJson(value[key])}`;
      })
      .join(",")}}`;
  }
  throw new Error("canonical JSON requires plain JSON values");
}

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error("canonical JSON cannot contain an unpaired Unicode surrogate");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error("canonical JSON cannot contain an unpaired Unicode surrogate");
    }
  }
}

function assertNoSymlinkPath(rootPath: string, relativePath: string): void {
  let current = path.resolve(rootPath);
  for (const segment of normalizeArtifactPath(relativePath).split("/")) {
    current = path.join(current, segment);
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error("artifact path cannot contain symbolic links");
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateSigningKey(value: string): string {
  if (Buffer.byteLength(value, "utf8") < 32) {
    throw new Error("publish manifest signing key must be at least 32 bytes");
  }
  return value;
}

function requiredText(value: string, label: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function canonicalTimestamp(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error("generatedAt must be an ISO timestamp");
  return new Date(time).toISOString();
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(String(left ?? ""));
  const rightBytes = Buffer.from(String(right ?? ""));
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function uniqueReferences(
  references: GeneratedAppPublishStaticAssetReference[],
): GeneratedAppPublishStaticAssetReference[] {
  const seen = new Set<string>();
  return references
    .filter((reference) => {
      const key = `${reference.sourcePath}\0${reference.targetPath}\0${reference.attribute}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(
      (left, right) =>
        left.sourcePath.localeCompare(right.sourcePath) ||
        left.targetPath.localeCompare(right.targetPath) ||
        left.attribute.localeCompare(right.attribute),
    );
}

function uniqueIssues(
  issues: GeneratedAppPublishManifestIssue[],
): GeneratedAppPublishManifestIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}\0${issue.path}\0${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
