import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { inputAuthorization, stringInput } from "./authorization.js";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";

type AgentChildProcess = ChildProcessByStdio<null, Readable, Readable>;

interface BoundedTextBuffer {
  append(chunk: Buffer | string): BoundedTextBuffer;
  read(): string;
}

export interface ShellForAgentInput extends Record<string, unknown> {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface ShellForAgentOutput {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  killed: boolean;
}

export interface ShellForAgentToolOptions {
  allowedCommands?: readonly string[];
  projectRoot?: string;
  artifactRoot?: string;
  cwdRoots?: readonly string[];
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  maxOutputBytes?: number;
  spawnImpl?: typeof spawn;
  allowNetworkSubcommands?: boolean;
}

const DEFAULT_ALLOWED_COMMANDS = [
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
] as const;

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const FORCE_KILL_GRACE_MS = 250;

const GIT_NETWORK_SUBCOMMANDS = new Set([
  "archive",
  "clone",
  "fetch",
  "pull",
  "push",
  "ls-remote",
  "send-email",
  "submodule",
]);

const NPM_NETWORK_SUBCOMMANDS = new Set([
  "add",
  "audit",
  "bugs",
  "ci",
  "docs",
  "exec",
  "fund",
  "i",
  "info",
  "init",
  "install",
  "login",
  "logout",
  "outdated",
  "owner",
  "profile",
  "publish",
  "repo",
  "search",
  "star",
  "stars",
  "team",
  "token",
  "uninstall",
  "unpublish",
  "update",
  "view",
  "whoami",
  "x",
]);

export function createShellForAgentTool(
  options: ShellForAgentToolOptions = {},
): ToolDefinition<ShellForAgentInput> {
  const projectRoot = resolvePath(options.projectRoot ?? process.cwd());
  const artifactRoot = resolvePath(
    options.artifactRoot ?? resolvePath(projectRoot, "data", "artifacts"),
  );
  const cwdRoots = uniqueResolved([projectRoot, artifactRoot, ...(options.cwdRoots ?? [])]);
  const allowedCommands = new Set(options.allowedCommands ?? DEFAULT_ALLOWED_COMMANDS);
  const maxTimeoutMs = clampInteger(options.maxTimeoutMs ?? MAX_TIMEOUT_MS, 1, 24 * 60 * 60 * 1000);
  const defaultTimeoutMs = clampInteger(
    options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    1,
    maxTimeoutMs,
  );
  const maxOutputBytes = clampInteger(
    options.maxOutputBytes ?? MAX_OUTPUT_BYTES,
    1024,
    1024 * 1024,
  );
  const spawnImpl = options.spawnImpl ?? spawn;
  const allowNetworkSubcommands = options.allowNetworkSubcommands === true;

  return {
    name: "shell_for_agent",
    description: `Run a tightly scoped agent shell command without shell interpolation. Allowed binaries: ${[
      ...allowedCommands,
    ].join(", ")}. cwd is limited to the project, artifact root, or injected roots.`,
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "Allowed executable name to run directly. Shell syntax, pipes, and path separators are not accepted.",
        },
        args: {
          type: "array",
          items: { type: "string" },
          default: [],
          description: "Arguments passed directly to the executable.",
        },
        cwd: {
          type: "string",
          description: "Working directory. Relative paths resolve from the project root.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: maxTimeoutMs,
          default: defaultTimeoutMs,
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    side: "exec",
    effect: {
      describe: () => ({
        classification: "non_replayable_mutation",
        operation: "shell.command.execute",
      }),
    },
    authorization: inputAuthorization((input: ShellForAgentInput, context) => {
      const requestedCwd = stringInput(input.cwd);
      const defaultCwd = resolvePath(
        context.artifactDir ? resolvePath(projectRoot, context.artifactDir) : artifactRoot,
        "agents",
        safeAgentPathSegment(context.agentId ?? context.worker?.run.id ?? "missing-agent"),
        "work",
      );
      const cwd = requestedCwd
        ? isAbsolute(requestedCwd)
          ? resolvePath(requestedCwd)
          : resolvePath(projectRoot, requestedCwd)
        : defaultCwd;
      return {
        verb: "EXECUTE",
        effect: "execute",
        resources: [`command:${stringInput(input.command)}`, pathToFileURL(cwd).toString()],
      };
    }),
    timeoutMs: maxTimeoutMs + FORCE_KILL_GRACE_MS + 1_000,
    async handle(input, ctx) {
      const normalized = normalizeInput(input, maxTimeoutMs, defaultTimeoutMs);
      if (!normalized.ok) return { ok: false, error: normalized.error };

      const { command, args, timeoutMs } = normalized.value;
      if (!ctx.agentId) return { ok: false, error: "shell_for_agent requires ctx.agentId" };
      if (!allowedCommands.has(command)) {
        return { ok: false, error: `command "${command}" is not in the shell_for_agent allowlist` };
      }

      const policyError = allowNetworkSubcommands ? null : networkSubcommandError(command, args);
      if (policyError) return { ok: false, error: policyError };

      if (ctx.worker) {
        if (normalized.value.cwd) {
          return {
            ok: false,
            error: "Worker sandbox commands cannot use a host working directory.",
          };
        }
        if (!ctx.worker.services) {
          return { ok: false, error: "Worker runtime security services are unavailable." };
        }
        try {
          const result = await ctx.worker.services.sandbox.execute({
            workspaceId: ctx.workspaceId,
            command,
            args,
            timeoutMs,
            signal: ctx.signal,
            network: "none",
          });
          const output: ShellForAgentOutput & { execId: string } = {
            command,
            args,
            cwd: "/tmp",
            exitCode: result.exitCode ?? null,
            signal: null,
            stdout: result.stdout,
            stderr: result.stderr,
            killed: result.status === "timeout" || result.status === "canceled",
            execId: result.execId,
          };
          return result.status === "success"
            ? { ok: true, output }
            : { ok: false, error: result.error ?? `sandbox ${result.status}`, output };
        } catch (error) {
          if (ctx.signal.aborted) throw error;
          return { ok: false, error: `sandbox failed: ${(error as Error).message}` };
        }
      }

      const scopedArtifactRoot = ctx.artifactDir
        ? resolvePath(projectRoot, ctx.artifactDir)
        : artifactRoot;
      const scopedCwdRoots = ctx.artifactDir
        ? uniqueResolved([...cwdRoots, scopedArtifactRoot])
        : cwdRoots;
      const cwdResult = resolveScopedCwd({
        requestedCwd: normalized.value.cwd,
        projectRoot,
        artifactRoot: scopedArtifactRoot,
        cwdRoots: scopedCwdRoots,
        agentId: ctx.agentId,
      });
      if (!cwdResult.ok) return { ok: false, error: cwdResult.error };

      return runDirectCommand({
        command,
        args,
        cwd: cwdResult.cwd,
        timeoutMs,
        maxOutputBytes,
        ctx,
        spawnImpl,
      });
    },
  };
}

export const shellForAgentTool = createShellForAgentTool();

function normalizeInput(
  input: ShellForAgentInput,
  maxTimeoutMs: number,
  defaultTimeoutMs: number,
):
  | {
      ok: true;
      value: Required<Pick<ShellForAgentInput, "command" | "args" | "timeoutMs">> & {
        cwd?: string;
      };
    }
  | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "input must be an object" };
  const candidate = input as Partial<ShellForAgentInput>;
  if (typeof candidate.command !== "string" || candidate.command.trim().length === 0) {
    return { ok: false, error: "command must be a non-empty string" };
  }
  const command = candidate.command.trim();
  if (command.includes("/") || command.includes("\\") || command.includes("\0")) {
    return { ok: false, error: "command must be an executable name without path separators" };
  }

  const args = candidate.args ?? [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    return { ok: false, error: "args must be an array of strings" };
  }
  if (args.some((arg) => arg.includes("\0"))) {
    return { ok: false, error: "args must not contain null bytes" };
  }

  if (
    candidate.cwd !== undefined &&
    (typeof candidate.cwd !== "string" || candidate.cwd.includes("\0"))
  ) {
    return { ok: false, error: "cwd must be a string without null bytes" };
  }

  const timeoutMs = candidate.timeoutMs ?? defaultTimeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxTimeoutMs) {
    return { ok: false, error: `timeoutMs must be an integer between 1 and ${maxTimeoutMs}` };
  }

  return {
    ok: true,
    value: {
      command,
      args: args.slice(),
      timeoutMs,
      ...(candidate.cwd !== undefined ? { cwd: candidate.cwd } : {}),
    },
  };
}

function resolveScopedCwd(params: {
  requestedCwd?: string;
  projectRoot: string;
  artifactRoot: string;
  cwdRoots: readonly string[];
  agentId: string;
}): { ok: true; cwd: string } | { ok: false; error: string } {
  const defaultCwd = resolvePath(
    params.artifactRoot,
    "agents",
    safeAgentPathSegment(params.agentId),
    "work",
  );
  const requested = params.requestedCwd;
  const candidate = requested
    ? isAbsolute(requested)
      ? resolvePath(requested)
      : resolvePath(params.projectRoot, requested)
    : defaultCwd;

  if (!isInsideAny(params.cwdRoots, candidate)) {
    return { ok: false, error: `cwd "${candidate}" is not inside the shell_for_agent cwd scope` };
  }

  const mayCreate = !requested || isPathInside(params.artifactRoot, candidate);
  if (!existsSync(candidate)) {
    if (!mayCreate) return { ok: false, error: `cwd "${candidate}" does not exist` };
    try {
      mkdirSync(candidate, { recursive: true });
    } catch (error) {
      return {
        ok: false,
        error: `cwd "${candidate}" could not be created: ${(error as Error).message}`,
      };
    }
  }

  let realCandidate: string;
  try {
    if (!statSync(candidate).isDirectory())
      return { ok: false, error: `cwd "${candidate}" is not a directory` };
    realCandidate = realpathSync.native(candidate);
  } catch (error) {
    return { ok: false, error: `cwd check failed: ${(error as Error).message}` };
  }

  const realRoots = params.cwdRoots.map(realpathOrResolved);
  if (!isInsideAny(realRoots, realCandidate)) {
    return {
      ok: false,
      error: `cwd "${candidate}" resolves outside the shell_for_agent cwd scope`,
    };
  }

  return { ok: true, cwd: realCandidate };
}

function runDirectCommand(params: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  ctx: ToolContext;
  spawnImpl: typeof spawn;
}): Promise<ToolResult> {
  const baseOutput: ShellForAgentOutput = {
    command: params.command,
    args: params.args,
    cwd: params.cwd,
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    killed: params.ctx.signal.aborted,
  };

  if (params.ctx.signal.aborted) {
    return Promise.resolve({
      ok: false,
      error: "command terminated (canceled)",
      output: baseOutput,
    });
  }

  return new Promise<ToolResult>((resolve) => {
    let child: AgentChildProcess;
    try {
      child = params.spawnImpl(params.command, params.args, {
        cwd: params.cwd,
        env: scrubbedEnv(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }) as AgentChildProcess;
    } catch (error) {
      resolve({
        ok: false,
        error: `spawn failed: ${(error as Error).message}`,
        output: baseOutput,
      });
      return;
    }

    let settled = false;
    let killed = false;
    let killReason: "timeout" | "canceled" | null = null;
    let stdout = createBoundedTextBuffer(params.maxOutputBytes, "stdout");
    let stderr = createBoundedTextBuffer(params.maxOutputBytes, "stderr");
    let timeout: NodeJS.Timeout | null = null;
    let forceKill: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      params.ctx.signal.removeEventListener("abort", onAbort);
    };

    const terminate = (reason: "timeout" | "canceled") => {
      if (settled) return;
      killed = true;
      killReason ??= reason;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      forceKill ??= setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, FORCE_KILL_GRACE_MS);
    };

    const onAbort = () => terminate("canceled");
    params.ctx.signal.addEventListener("abort", onAbort, { once: true });

    timeout = setTimeout(() => terminate("timeout"), params.timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout = stdout.append(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = stderr.append(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        ok: false,
        error: `spawn failed: ${error.message}`,
        output: {
          ...baseOutput,
          stdout: stdout.read(),
          stderr: stderr.read(),
          killed,
        },
      });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();

      const output: ShellForAgentOutput = {
        command: params.command,
        args: params.args,
        cwd: params.cwd,
        exitCode: typeof code === "number" ? code : null,
        signal: signal ?? null,
        stdout: stdout.read(),
        stderr: stderr.read(),
        killed,
      };

      if (killed) {
        resolve({
          ok: false,
          error: `command terminated (${killReason ?? "killed"})`,
          output,
        });
      } else if (code === 0) {
        resolve({ ok: true, output });
      } else {
        resolve({ ok: false, error: `exit code ${code}`, output });
      }
    });
  });
}

function createBoundedTextBuffer(
  limit: number,
  streamName: "stdout" | "stderr",
): BoundedTextBuffer {
  let value = "";
  let bytes = 0;
  let truncated = false;

  return {
    append(chunk: Buffer | string) {
      if (truncated) return this;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      const remaining = limit - bytes;
      if (buffer.byteLength <= remaining) {
        value += buffer.toString("utf8");
        bytes += buffer.byteLength;
        return this;
      }
      if (remaining > 0) {
        value += buffer.subarray(0, remaining).toString("utf8");
        bytes = limit;
      }
      value += `\n...[${streamName} truncated at ${limit} bytes]`;
      truncated = true;
      return this;
    },
    read() {
      return value;
    },
  };
}

function scrubbedEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    NODE_ENV: process.env.NODE_ENV ?? "",
  };
}

function networkSubcommandError(command: string, args: readonly string[]): string | null {
  if (command === "git") {
    const subcommand = firstSubcommand(
      args,
      new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]),
    );
    if (subcommand && GIT_NETWORK_SUBCOMMANDS.has(subcommand)) {
      return `git subcommand "${subcommand}" is not allowed for shell_for_agent`;
    }
  }
  if (command === "npm") {
    const subcommand = firstSubcommand(
      args,
      new Set(["--cache", "--prefix", "--userconfig", "--workspace", "-w"]),
    );
    if (subcommand && NPM_NETWORK_SUBCOMMANDS.has(subcommand)) {
      return `npm subcommand "${subcommand}" is not allowed for shell_for_agent`;
    }
  }
  return null;
}

function firstSubcommand(
  args: readonly string[],
  optionsWithValues: ReadonlySet<string>,
): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") return args[index + 1]?.toLowerCase() ?? null;
    if (optionsWithValues.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("--") && arg.includes("=")) continue;
    if (arg.startsWith("-")) continue;
    return arg.toLowerCase();
  }
  return null;
}

function safeAgentPathSegment(agentId: string): string {
  const cleaned = agentId
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  const hash = createHash("sha256").update(agentId).digest("hex").slice(0, 12);
  return cleaned ? `${cleaned}-${hash}` : `agent-${hash}`;
}

function uniqueResolved(paths: readonly string[]): string[] {
  return [...new Set(paths.map((entry) => resolvePath(entry)))];
}

function isInsideAny(roots: readonly string[], candidate: string): boolean {
  return roots.some((root) => isPathInside(root, candidate));
}

function isPathInside(root: string, candidate: string): boolean {
  const base = resolvePath(root);
  const target = resolvePath(candidate);
  const rel = relative(base, target);
  return rel === "" || (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel));
}

function realpathOrResolved(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolvePath(path);
  }
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
