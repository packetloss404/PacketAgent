/**
 * File-tree build validator.
 *
 * Takes an in-memory `{ path, content }[]` representing a generated
 * application, writes it to a fresh temp workspace, and validates it through
 * the existing sandbox infrastructure. Validation has two phases:
 *
 *   1. typecheck — runs `tsc --noEmit` against the workspace.
 *   2. build     — runs `vite build` against the workspace, but only when
 *                  the typecheck phase passed (no point bundling something
 *                  that doesn't typecheck).
 *
 * Each diagnostic is tagged with the phase that produced it, and the
 * `ValidationResult.phases` summary lets the caller see which phase ran and
 * which failed. The same `PACKETAGENT_SANDBOX_SMOKE_ENABLED` env gate controls
 * both phases — when it is off, both phases short-circuit to "skipped".
 *
 * The validator is gated on the same env switch as the sandbox smoke pipeline
 * (`PACKETAGENT_SANDBOX_SMOKE_ENABLED=1`). When the gate is off, or when the
 * sandbox cannot be spawned (e.g. the Windows ENOENT issue documented in
 * sandbox notes), `validateFileTree` returns `{ ok: true, source: "skipped" }`
 * so the surrounding codegen flow never blocks on a missing sandbox.
 *
 * Tests inject `options.runner` to avoid spawning a real sandbox. The runner
 * is invoked once per phase; tests can disambiguate by inspecting the
 * `command` string.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { getDefaultSandboxService } from "../sandbox/sandbox-service.js";
import { validateWorkspacePath } from "./path-validator.js";

export interface GeneratedFile {
  path: string;
  content: string;
}

export type ValidationPhase = "typecheck" | "build";

export interface ValidationError {
  /** Path of the offending file, relative to the temp workspace where possible. */
  file: string;
  line?: number;
  column?: number;
  message: string;
  severity: "error" | "warning";
  /** Which validation phase produced this diagnostic. */
  phase: ValidationPhase;
}

export type PhaseStatus = "passed" | "failed" | "skipped";

export interface ValidationResult {
  ok: boolean;
  /** "skipped" when the sandbox gate is off or the sandbox is unavailable. */
  source: "real" | "skipped";
  errors: ValidationError[];
  warnings: ValidationError[];
  durationMs: number;
  /** Per-phase outcome so callers can tell which step failed. */
  phases: {
    typecheck: PhaseStatus;
    build: PhaseStatus;
  };
}

/** Result of a single tsc/vite invocation, as observed from outside the sandbox. */
export interface RunnerResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  errorMessage?: string;
}

/** Function signature for the pluggable command runner. */
export type ValidationRunner = (params: {
  workspaceDir: string;
  command: string;
  timeoutMs: number;
  signal?: AbortSignal;
}) => Promise<RunnerResult>;

export interface ValidateOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Test-only override. When omitted, uses the real sandbox service. */
  runner?: ValidationRunner;
  /** Test-only override. When omitted, reads `process.env`. */
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const SMOKE_ENV_VAR = "PACKETAGENT_SANDBOX_SMOKE_ENABLED";
const LOG_PREFIX = "[codegen-validate]";

/**
 * tsc default diagnostic format:
 *   path/to/file.ts(line,col): error TSnnnn: message
 *   path/to/file.ts(line,col): warning TSnnnn: message
 *
 * tsc may also emit diagnostics without a location (e.g. config errors):
 *   error TSnnnn: message
 */
const TSC_LOCATED_RE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS\d+:\s*(.*)$/;
const TSC_GLOBAL_RE = /^(error|warning)\s+TS\d+:\s*(.*)$/;

/**
 * Vite logs errors in a few shapes. Most commonly:
 *   [vite]: Could not resolve "./missing.tsx" from "src/App.tsx"
 *   error during build:
 *   <path>:<line>:<col>: <message>
 * We try to capture a file:line:col location when present, otherwise fall
 * back to a generic capture.
 */
const VITE_TAGGED_RE = /^\s*(?:\[vite[^\]]*\][:\s]|error[: ])\s*(.*)$/i;
const VITE_LOCATION_RE = /^\s*(.+?):(\d+):(\d+)(?::\s*(.*))?$/;

function emptyPhases(): ValidationResult["phases"] {
  return { typecheck: "skipped", build: "skipped" };
}

function skipped(durationMs = 0): ValidationResult {
  return {
    ok: true,
    source: "skipped",
    errors: [],
    warnings: [],
    durationMs,
    phases: emptyPhases(),
  };
}

/**
 * Write the file tree to `workspaceDir`. Any nested directories are created.
 * Paths are normalized and constrained to the workspace (no `..` escapes).
 */
async function writeTree(workspaceDir: string, files: GeneratedFile[]): Promise<void> {
  for (const file of files) {
    // Route every generated path through the shared hardened validator so the
    // two codegen write paths (this one and the llm-author `write_file`
    // handler) enforce one implementation. The validator rejects absolute,
    // UNC/extended, NUL-byte, `..`-escaping, Windows-reserved-name, ADS (`:`)
    // and trailing-dot/whitespace paths.
    const check = validateWorkspacePath(file.path);
    if (!check.ok) {
      // Preserve the historical "escapes workspace" wording so existing
      // callers/tests that match on it keep working, while surfacing the
      // validator's specific reason for diagnostics.
      throw new Error(`generated file path escapes workspace: ${file.path} (${check.reason})`);
    }
    const target = resolve(workspaceDir, check.normalized ?? file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }
}

/**
 * Returns true if the tree already contains a tsconfig at its root.
 */
function hasRootTsconfig(files: GeneratedFile[]): boolean {
  return files.some((f) => f.path === "tsconfig.json" || f.path === "./tsconfig.json");
}

/** Minimal tsconfig used when the generated tree does not include one. */
const DEFAULT_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      noEmit: true,
    },
    include: ["**/*.ts", "**/*.tsx"],
  },
  null,
  2,
);

/**
 * Parse tsc's combined stdout/stderr into structured diagnostics. tsc writes
 * diagnostics to stdout in default mode, but some hosts route via stderr; we
 * accept both. All diagnostics returned by this function are tagged with
 * `phase: "typecheck"`.
 */
export function parseTscOutput(combined: string): {
  errors: ValidationError[];
  warnings: ValidationError[];
} {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  const lines = combined.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const locatedMatch = TSC_LOCATED_RE.exec(line);
    if (locatedMatch) {
      const [, file, lineStr, colStr, severity, message] = locatedMatch;
      const diag: ValidationError = {
        file: file!,
        line: Number(lineStr),
        column: Number(colStr),
        message: message!,
        severity: severity === "warning" ? "warning" : "error",
        phase: "typecheck",
      };
      if (diag.severity === "warning") warnings.push(diag);
      else errors.push(diag);
      continue;
    }
    const globalMatch = TSC_GLOBAL_RE.exec(line);
    if (globalMatch) {
      const [, severity, message] = globalMatch;
      const diag: ValidationError = {
        file: "<tsconfig>",
        message: message!,
        severity: severity === "warning" ? "warning" : "error",
        phase: "typecheck",
      };
      if (diag.severity === "warning") warnings.push(diag);
      else errors.push(diag);
    }
  }
  return { errors, warnings };
}

/**
 * Parse vite's combined stdout/stderr into structured diagnostics. Vite's
 * error format is less structured than tsc's, so we do a best-effort
 * extraction: try to find a `file:line:col` location or a `[vite]:` tagged
 * line. If we find nothing useful, surface a single generic error with the
 * last few lines of output. All diagnostics returned here are tagged with
 * `phase: "build"`.
 */
export function parseViteOutput(combined: string): {
  errors: ValidationError[];
  warnings: ValidationError[];
} {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  const lines = combined.split(/\r?\n/);

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // First try to capture a `[vite]:` style tagged line.
    const taggedMatch = VITE_TAGGED_RE.exec(line);
    if (taggedMatch) {
      const message = (taggedMatch[1] ?? line).trim();
      if (!message) continue;
      errors.push({
        file: "<vite>",
        message,
        severity: "error",
        phase: "build",
      });
      continue;
    }

    // Otherwise look for a bare `path:line:col[: message]` form.
    const locMatch = VITE_LOCATION_RE.exec(line);
    if (locMatch) {
      const [, file, lineStr, colStr, message] = locMatch;
      errors.push({
        file: file!,
        line: Number(lineStr),
        column: Number(colStr),
        message: (message ?? line).trim(),
        severity: "error",
        phase: "build",
      });
    }
  }

  return { errors, warnings };
}

/**
 * Build the generic synthetic error returned when vite exits non-zero but
 * `parseViteOutput` couldn't extract anything specific. Captures the last
 * ~5 non-empty lines of combined output so the caller has something
 * actionable.
 */
function genericViteError(
  combined: string,
  exitCode: number | null,
  errorMessage?: string,
): ValidationError {
  const tail = combined
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-5)
    .join("\n");
  const codePart = typeof exitCode === "number" ? ` with code ${exitCode}` : "";
  const detail = tail ? `: ${tail}` : "";
  return {
    file: "<vite>",
    message: errorMessage ?? `vite build failed${codePart}${detail}`,
    severity: "error",
    phase: "build",
  };
}

/**
 * Build the default runner that drives commands through the real sandbox
 * service. This intentionally lives behind a function so tests can inject a
 * lightweight fake without spinning up the sandbox store.
 */
function createDefaultRunner(): ValidationRunner {
  return async ({ workspaceDir, command, timeoutMs, signal }) => {
    const sandbox = getDefaultSandboxService();
    const workspaceId = `codegen-validate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const started = await sandbox.startExec({
      workspaceId,
      command,
      workingDir: workspaceDir,
      timeoutMs,
    });
    let canceled = false;
    const onAbort = (): void => {
      if (canceled) return;
      canceled = true;
      void sandbox.cancelExec(workspaceId, started.id).catch(() => {});
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      const final = await sandbox.waitForExec(started.id);
      const stdout = final?.stdoutPreview ?? "";
      const stderr = final?.stderrPreview ?? "";
      const exitCode = typeof final?.exitCode === "number" ? final.exitCode : null;
      const result: RunnerResult = { exitCode, stdout, stderr };
      if (final?.status === "timeout") result.timedOut = true;
      if (final?.errorMessage) result.errorMessage = final.errorMessage;
      return result;
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  };
}

/**
 * Resolve the absolute path of the locally-installed tsc binary by walking up
 * from this module location. Returns null when the package is not installed
 * (which is the typical sandbox-spawn-failure path we should treat as
 * "skipped").
 */
function resolveTscBinary(): string | null {
  try {
    const requireFn = createRequire(import.meta.url);
    // typescript/package.json is the safest resolve target; the bin sits at a
    // known relative location.
    const pkgJsonPath = requireFn.resolve("typescript/package.json");
    return join(dirname(pkgJsonPath), "bin", "tsc");
  } catch {
    return null;
  }
}

/**
 * Resolve the absolute path of the locally-installed vite binary. Mirrors
 * `resolveTscBinary`: returns null when vite isn't installed so the caller
 * can treat that case as "skipped".
 */
function resolveViteBinary(): string | null {
  try {
    const requireFn = createRequire(import.meta.url);
    const pkgJsonPath = requireFn.resolve("vite/package.json");
    return join(dirname(pkgJsonPath), "bin", "vite.js");
  } catch {
    return null;
  }
}

/**
 * Build the shell command used to invoke tsc. Quoting handles spaces in paths
 * on Windows.
 */
function buildTscCommand(tscBinary: string): string {
  const quoted = JSON.stringify(tscBinary);
  // tsc as a JS file → invoke with node. `-p .` picks up the tsconfig we
  // either wrote or that the generated tree already provided.
  return `node ${quoted} --noEmit -p tsconfig.json`;
}

/**
 * Build the shell command used to invoke vite build.
 */
function buildViteCommand(viteBinary: string): string {
  const quoted = JSON.stringify(viteBinary);
  return `node ${quoted} build`;
}

export async function validateFileTree(
  files: GeneratedFile[],
  options: ValidateOptions = {},
): Promise<ValidationResult> {
  const env = options.env ?? process.env;
  if (env[SMOKE_ENV_VAR] !== "1") {
    console.warn(
      `${LOG_PREFIX} sandbox smoke gate ${SMOKE_ENV_VAR} is not "1"; returning skipped result`,
    );
    return skipped();
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runner = options.runner ?? createDefaultRunner();
  const started = Date.now();
  let workspaceDir: string | null = null;

  try {
    workspaceDir = await mkdtemp(join(tmpdir(), "packetagent-codegen-"));

    // Ensure a tsconfig exists.
    const treeWithConfig = hasRootTsconfig(files)
      ? files
      : [...files, { path: "tsconfig.json", content: DEFAULT_TSCONFIG }];
    await writeTree(workspaceDir, treeWithConfig);

    // ----- Phase 1: typecheck -----
    let tscCommand: string;
    if (options.runner) {
      // Tests provide their own runner; the command string is opaque to them.
      tscCommand = "tsc --noEmit -p tsconfig.json";
    } else {
      const tscBinary = resolveTscBinary();
      if (!tscBinary) {
        console.warn(`${LOG_PREFIX} could not resolve typescript binary; returning skipped result`);
        return skipped(Date.now() - started);
      }
      tscCommand = buildTscCommand(tscBinary);
    }

    let tscResult: RunnerResult;
    try {
      const runArgs: Parameters<ValidationRunner>[0] = {
        workspaceDir,
        command: tscCommand,
        timeoutMs,
      };
      if (options.signal) runArgs.signal = options.signal;
      tscResult = await runner(runArgs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`${LOG_PREFIX} sandbox spawn failed: ${message}; returning skipped result`);
      return skipped(Date.now() - started);
    }

    if (tscResult.timedOut) {
      return {
        ok: false,
        source: "real",
        errors: [
          {
            file: "<sandbox>",
            message: `tsc timed out after ${Math.round(timeoutMs / 1000)}s`,
            severity: "error",
            phase: "typecheck",
          },
        ],
        warnings: [],
        durationMs: Date.now() - started,
        phases: { typecheck: "failed", build: "skipped" },
      };
    }

    const tscCombined = `${tscResult.stdout}\n${tscResult.stderr}`;
    const { errors: tscErrors, warnings: tscWarnings } = parseTscOutput(tscCombined);

    // If tsc exited non-zero but we couldn't parse a diagnostic, surface a
    // generic error so callers don't see ok=true on a real failure.
    if (
      typeof tscResult.exitCode === "number" &&
      tscResult.exitCode !== 0 &&
      tscErrors.length === 0
    ) {
      tscErrors.push({
        file: "<sandbox>",
        message:
          tscResult.errorMessage ??
          `tsc exited with code ${tscResult.exitCode}${
            tscCombined.trim() ? `: ${tscCombined.trim().split(/\r?\n/).pop() ?? ""}` : ""
          }`,
        severity: "error",
        phase: "typecheck",
      });
    }

    if (tscErrors.length > 0) {
      // tsc failed → skip the build phase entirely.
      return {
        ok: false,
        source: "real",
        errors: tscErrors,
        warnings: tscWarnings,
        durationMs: Date.now() - started,
        phases: { typecheck: "failed", build: "skipped" },
      };
    }

    // ----- Phase 2: vite build -----
    let viteCommand: string;
    if (options.runner) {
      viteCommand = "vite build";
    } else {
      const viteBinary = resolveViteBinary();
      if (!viteBinary) {
        console.warn(`${LOG_PREFIX} could not resolve vite binary; returning skipped result`);
        // tsc already passed, but we couldn't even attempt the build. Treat
        // this as overall skipped so the caller doesn't silently get a
        // build-skipped pass under the "real" source. The contract for the
        // pre-gate paths is symmetric: when we can't run the pipeline at
        // all, return the standard skipped() result.
        return skipped(Date.now() - started);
      }
      viteCommand = buildViteCommand(viteBinary);
    }

    let viteResult: RunnerResult;
    try {
      const runArgs: Parameters<ValidationRunner>[0] = {
        workspaceDir,
        command: viteCommand,
        timeoutMs,
      };
      if (options.signal) runArgs.signal = options.signal;
      viteResult = await runner(runArgs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`${LOG_PREFIX} vite sandbox spawn failed: ${message}; returning skipped result`);
      return skipped(Date.now() - started);
    }

    const durationMs = Date.now() - started;

    if (viteResult.timedOut) {
      return {
        ok: false,
        source: "real",
        errors: [
          {
            file: "<sandbox>",
            message: `vite build timed out after ${Math.round(timeoutMs / 1000)}s`,
            severity: "error",
            phase: "build",
          },
        ],
        warnings: [...tscWarnings],
        durationMs,
        phases: { typecheck: "passed", build: "failed" },
      };
    }

    const viteCombined = `${viteResult.stdout}\n${viteResult.stderr}`;
    const { errors: viteErrors, warnings: viteWarnings } = parseViteOutput(viteCombined);

    // If vite exited non-zero but we couldn't parse a diagnostic, surface a
    // generic error so callers don't see ok=true on a real failure.
    if (
      typeof viteResult.exitCode === "number" &&
      viteResult.exitCode !== 0 &&
      viteErrors.length === 0
    ) {
      viteErrors.push(genericViteError(viteCombined, viteResult.exitCode, viteResult.errorMessage));
    }

    const buildPassed = viteErrors.length === 0;
    return {
      ok: buildPassed,
      source: "real",
      errors: viteErrors,
      warnings: [...tscWarnings, ...viteWarnings],
      durationMs,
      phases: {
        typecheck: "passed",
        build: buildPassed ? "passed" : "failed",
      },
    };
  } finally {
    if (workspaceDir) {
      await rm(workspaceDir, { recursive: true, force: true }).catch(() => {
        /* best-effort cleanup */
      });
    }
  }
}

// Re-export for tests/diagnostics. The `fileURLToPath` import is needed when
// callers want to resolve relative paths from this module's URL; not used in
// the validator body itself but kept available so internal tests can probe it.
export const __internal = {
  parseTscOutput,
  parseViteOutput,
  hasRootTsconfig,
  resolveTscBinary,
  resolveViteBinary,
  fileURLToPath,
};
