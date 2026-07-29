// Hardened workspace-path validator for the codegen `write_file` tool.
//
// The orchestrator hands us arbitrary strings the LLM emitted, and we are the
// only line of defense before the host calls `fs.writeFile`. The validator is
// deliberately strict and rejects every path-traversal trick the security
// review surfaced - especially Windows-specific ones (reserved device names,
// ADS via `:`, trailing-dot/space aliasing, UNC and `\\?\` extended paths).
//
// All normalization goes through `node:path/posix` so behavior is identical
// regardless of the host OS. Windows-style separators are converted to `/`
// before normalization so we evaluate one canonical form.

import path from "node:path/posix";

export interface PathValidationResult {
  ok: boolean;
  reason?: string;
  normalized?: string;
}

const MAX_PATH_LENGTH = 255;

// Windows reserved device names. Case-insensitive. Match the whole segment
// either bare (`CON`) or with any extension (`CON.txt`, `nul.json`). The Win32
// loader resolves these to devices regardless of where they appear in a path,
// so we reject any segment whose stem matches.
const WINDOWS_RESERVED_NAMES = new Set<string>([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

function fail(reason: string): PathValidationResult {
  return { ok: false, reason };
}

function isWindowsAbsolute(input: string): boolean {
  // Drive-letter absolute: `C:\foo`, `D:/foo`, or even bare `C:` (which Win32
  // interprets as the current dir on drive C and is therefore not safe).
  return /^[A-Za-z]:/.test(input);
}

function isUncOrExtended(input: string): boolean {
  // UNC paths (`\\server\share`) and Win32 extended-length paths (`\\?\C:\..`,
  // `\\.\PhysicalDrive0`). We test against both `\\` and `//` since callers
  // sometimes pre-convert separators.
  return /^(\\\\|\/\/)/.test(input);
}

export function validateWorkspacePath(rawPath: string): PathValidationResult {
  if (typeof rawPath !== "string") {
    return fail("path must be a string");
  }

  if (rawPath.length === 0 || rawPath.trim().length === 0) {
    return fail("path is empty");
  }

  if (rawPath.includes("\0")) {
    return fail("path contains a NUL byte");
  }

  if (rawPath.length > MAX_PATH_LENGTH) {
    return fail(`path exceeds ${MAX_PATH_LENGTH} characters`);
  }

  if (isUncOrExtended(rawPath)) {
    return fail("UNC and extended-length paths are not allowed");
  }

  if (isWindowsAbsolute(rawPath)) {
    return fail("absolute paths are not allowed; use workspace-relative paths");
  }

  // After the UNC check we can normalize separators safely.
  const unified = rawPath.replace(/\\/g, "/");

  if (unified.startsWith("/")) {
    return fail("absolute paths are not allowed; use workspace-relative paths");
  }

  // NTFS alternate data streams: `notes.txt:hidden.exe`. Colons have no
  // legitimate use in workspace-relative POSIX paths, so reject outright.
  if (unified.includes(":")) {
    return fail("path contains ':' (Windows alternate data streams are not allowed)");
  }

  const normalized = path.normalize(unified);

  // `path.posix.normalize` collapses `a/./b` and `a//b` but preserves a
  // leading `..` if the path tries to escape. Re-check after normalization to
  // defeat constructed bypasses like `foo/../../bar`.
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized === "." ||
    normalized === ""
  ) {
    if (normalized === "." || normalized === "") {
      return fail("path resolves to the workspace root");
    }
    return fail("path escapes the workspace via '..'");
  }

  // Belt-and-braces: split and look for any `..` segment that might have
  // survived normalization on an unusual input.
  const segments = normalized.split("/");
  for (const segment of segments) {
    if (segment === "..") {
      return fail("path contains a '..' segment");
    }
  }

  for (const segment of segments) {
    if (segment.length === 0) {
      return fail("path contains an empty segment");
    }

    // Trailing dot or trailing whitespace. Win32 strips both when opening a
    // file, so `foo.txt.` would alias `foo.txt`, and `foo.txt ` would alias
    // `foo.txt`. Both let an attacker overwrite a sibling file.
    if (/[. \t]$/.test(segment)) {
      return fail(`segment '${segment}' has a trailing dot or whitespace`);
    }

    // Windows reserved device name check. Strip extension and uppercase.
    const stem = segment.includes(".") ? segment.slice(0, segment.indexOf(".")) : segment;
    if (WINDOWS_RESERVED_NAMES.has(stem.toUpperCase())) {
      return fail(`segment '${segment}' is a reserved Windows device name`);
    }
  }

  // Defense in depth: resolve against a synthetic root and confirm the result
  // stays inside it. `path.posix.resolve("/", "foo/bar")` -> `/foo/bar`;
  // anything that escapes would surface as a path without the `/__root__/`
  // prefix.
  const ROOT = "/__packetagent_workspace_root__";
  const resolved = path.resolve(ROOT, normalized);
  if (resolved !== ROOT && !resolved.startsWith(`${ROOT}/`)) {
    return fail("path resolves outside the workspace root");
  }

  return { ok: true, normalized };
}
