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
 * which failed. Validation is required by default. The generated tree is
 * mounted read-only into a short-lived, network-disabled Docker container;
 * the trusted validator toolchain is copied from an image derived from
 * PacketAgent's lockfile. Missing Docker/image preparation or command spawn
 * failures return a fail-closed `source: "blocked"` result.
 *
 * Tests inject `options.runner` to avoid spawning a real sandbox. The runner
 * is invoked once per phase; tests can disambiguate by inspecting the
 * `command` string.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getDefaultSandboxService } from "../sandbox/sandbox-service.js";
import { ensureCodegenValidationImage } from "./validation-image.js";
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
  /** "blocked" means required isolated validation could not run. */
  source: "real" | "blocked";
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
}

const DEFAULT_TIMEOUT_MS = 60_000;
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

function blocked(
  message: string,
  durationMs = 0,
  phase: ValidationPhase = "typecheck",
): ValidationResult {
  return {
    ok: false,
    source: "blocked",
    errors: [
      {
        file: "<sandbox>",
        message,
        severity: "error",
        phase,
      },
    ],
    warnings: [],
    durationMs,
    phases: phase === "build" ? { typecheck: "passed", build: "skipped" } : emptyPhases(),
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
    const image = await ensureCodegenValidationImage();
    const sandbox = getDefaultSandboxService();
    const workspaceId = `codegen-validate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const started = await sandbox.startExec({
      workspaceId,
      command: [
        "rm -rf /tmp/work",
        "mkdir -p /tmp/work",
        "cp -R /input/. /tmp/work/",
        "ln -s /opt/packetagent/node_modules /tmp/work/node_modules",
        "cd /tmp/work",
        command,
      ].join(" && "),
      runtime: "codegen-node-22",
      workingDir: "/tmp",
      timeoutMs,
      requiredDriver: "docker",
      image,
      mounts: [{ source: workspaceDir, target: "/input", readOnly: true }],
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

const CONTAINER_TSC_COMMAND =
  "node /opt/packetagent/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json";
const CONTAINER_VITE_COMMAND =
  "node /opt/packetagent/node_modules/vite/bin/vite.js build --configLoader runner";

export async function validateFileTree(
  files: GeneratedFile[],
  options: ValidateOptions = {},
): Promise<ValidationResult> {
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
    const tscCommand = options.runner ? "tsc --noEmit -p tsconfig.json" : CONTAINER_TSC_COMMAND;

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
      console.warn(`${LOG_PREFIX} required sandbox typecheck failed to start: ${message}`);
      return blocked(
        `required sandbox typecheck could not start: ${message}`,
        Date.now() - started,
      );
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
    const viteCommand = options.runner ? "vite build" : CONTAINER_VITE_COMMAND;

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
      console.warn(`${LOG_PREFIX} required sandbox Vite build failed to start: ${message}`);
      return blocked(
        `required sandbox Vite build could not start after typecheck passed: ${message}`,
        Date.now() - started,
        "build",
      );
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
};
