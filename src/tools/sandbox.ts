import { spawn } from "node:child_process";
import { mkdirSync, existsSync, statSync, writeFileSync } from "node:fs";
import { resolve as resolvePath, dirname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { inputAuthorization, stringInput } from "./authorization.js";
import type { ToolDefinition } from "./types.js";

const PROJECT_ROOT = process.cwd();
const ARTIFACT_ROOT = resolvePath(PROJECT_ROOT, "data", "artifacts");

const DEFAULT_ALLOWLIST = [
  "node",
  "npm",
  "git",
  "ls",
  "cat",
  "echo",
  "pwd",
  "wc",
  "head",
  "tail",
  "grep",
  "find",
];

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

function ensureArtifactDir(runId: string): string {
  const dir = resolvePath(ARTIFACT_ROOT, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function isPathInside(parent: string, candidate: string): boolean {
  const rel = resolvePath(candidate);
  const base = resolvePath(parent);
  return rel === base || rel.startsWith(base + (process.platform === "win32" ? "\\" : "/"));
}

export interface SandboxOptions {
  allowedCommands?: string[];
  timeoutMs?: number;
  cwdAllowlist?: string[];
}

export function createSandboxedShellTool(options: SandboxOptions = {}): ToolDefinition {
  const allowed = new Set(options.allowedCommands ?? DEFAULT_ALLOWLIST);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwdAllow = options.cwdAllowlist ?? [PROJECT_ROOT, ARTIFACT_ROOT];

  return {
    name: "run_command",
    description: `Run a sandboxed shell command. Allowed binaries: ${[...allowed].join(", ")}. cwd must be inside the project or artifact root. Output is captured (max ${MAX_OUTPUT_BYTES} bytes).`,
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Binary to run (no shell, no pipes)." },
        args: { type: "array", items: { type: "string" }, default: [] },
        cwd: {
          type: "string",
          description: "Working directory (absolute or relative to project root).",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    side: "exec",
    effect: {
      describe: () => ({
        classification: "non_replayable_mutation",
        operation: "sandbox.command.execute",
      }),
    },
    authorization: inputAuthorization((input: Record<string, unknown>, context) => {
      const requestedCwd = stringInput(input.cwd);
      const cwd = requestedCwd
        ? isAbsolute(requestedCwd)
          ? resolvePath(requestedCwd)
          : resolvePath(PROJECT_ROOT, requestedCwd)
        : context.runId
          ? resolvePath(ARTIFACT_ROOT, context.runId)
          : PROJECT_ROOT;
      return {
        verb: "EXECUTE",
        effect: "execute",
        resources: [`command:${stringInput(input.command)}`, pathToFileURL(cwd).toString()],
      };
    }),
    timeoutMs: timeoutMs + 1_000,
    async handle(input, ctx) {
      const {
        command,
        args = [],
        cwd,
      } = input as { command: string; args?: string[]; cwd?: string };
      if (!allowed.has(command)) {
        return { ok: false, error: `command "${command}" is not in the sandbox allowlist` };
      }
      const resolvedCwd = cwd
        ? isAbsolute(cwd)
          ? cwd
          : resolvePath(PROJECT_ROOT, cwd)
        : ctx.runId
          ? ensureArtifactDir(ctx.runId)
          : PROJECT_ROOT;

      if (!cwdAllow.some((root) => isPathInside(root, resolvedCwd))) {
        return { ok: false, error: `cwd "${resolvedCwd}" is not inside the sandbox allowlist` };
      }
      if (!existsSync(resolvedCwd)) {
        try {
          mkdirSync(resolvedCwd, { recursive: true });
        } catch {
          return {
            ok: false,
            error: `cwd "${resolvedCwd}" does not exist and could not be created`,
          };
        }
      }
      try {
        if (!statSync(resolvedCwd).isDirectory()) {
          return { ok: false, error: `cwd "${resolvedCwd}" is not a directory` };
        }
      } catch (error) {
        return { ok: false, error: `cwd check failed: ${(error as Error).message}` };
      }

      return await new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let killed = false;

        const child = spawn(command, args, {
          cwd: resolvedCwd,
          env: { PATH: process.env.PATH ?? "", NODE_ENV: "sandbox" },
          shell: false,
          windowsHide: true,
        });

        const onAbort = () => {
          killed = true;
          try {
            child.kill("SIGTERM");
          } catch {
            /* ignore */
          }
        };
        ctx.signal.addEventListener("abort", onAbort, { once: true });

        const timer = setTimeout(() => {
          killed = true;
          try {
            child.kill("SIGTERM");
          } catch {
            /* ignore */
          }
        }, timeoutMs);

        child.stdout?.on("data", (chunk: Buffer) => {
          stdoutBytes += chunk.byteLength;
          if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderrBytes += chunk.byteLength;
          if (stderrBytes <= MAX_OUTPUT_BYTES) stderr += chunk.toString("utf8");
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          ctx.signal.removeEventListener("abort", onAbort);
          resolve({ ok: false, error: `spawn failed: ${error.message}` });
        });
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          ctx.signal.removeEventListener("abort", onAbort);
          const out = {
            command,
            args,
            cwd: resolvedCwd,
            exitCode: code,
            signal,
            stdout:
              stdoutBytes > MAX_OUTPUT_BYTES
                ? stdout + `\n…[stdout truncated at ${MAX_OUTPUT_BYTES} bytes]`
                : stdout,
            stderr:
              stderrBytes > MAX_OUTPUT_BYTES
                ? stderr + `\n…[stderr truncated at ${MAX_OUTPUT_BYTES} bytes]`
                : stderr,
            killed,
          };
          if (killed) {
            resolve({ ok: false, error: `command terminated (timeout or cancel)`, output: out });
          } else if (code === 0) {
            resolve({ ok: true, output: out });
          } else {
            resolve({ ok: false, error: `exit code ${code}`, output: out });
          }
        });
      });
    },
  };
}

export function writeArtifact(
  runId: string,
  name: string,
  contents: string | Buffer,
): { path: string; bytes: number } {
  const dir = ensureArtifactDir(runId);
  const path = resolvePath(dir, name);
  if (!isPathInside(dir, path)) throw new Error(`artifact path ${name} escapes runId dir`);
  mkdirSync(dirname(path), { recursive: true });
  const buffer = typeof contents === "string" ? Buffer.from(contents, "utf8") : contents;
  writeFileSync(path, buffer);
  return { path, bytes: buffer.byteLength };
}
