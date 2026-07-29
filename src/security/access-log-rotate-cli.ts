import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { rotateAccessLogFile } from "./access-log.js";
import { redactedErrorMessage } from "./redaction.js";

export interface RunAccessLogRotateOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export async function runAccessLogRotateCli(
  options: RunAccessLogRotateOptions = {},
): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const out = options.out ?? ((line: string) => console.log(line));
  const err = options.err ?? ((line: string) => console.error(line));

  const argvPath = parseStringFlag(argv, "--path=");
  const envPath = env.PACKETAGENT_ACCESS_LOG_PATH;
  const targetPath = argvPath
    ? resolve(argvPath)
    : envPath
      ? resolve(process.cwd(), envPath)
      : null;

  if (!targetPath) {
    err("access-log:rotate requires --path=<file> or PACKETAGENT_ACCESS_LOG_PATH");
    return 2;
  }

  const maxFiles = resolveMaxFiles(argv, env);

  try {
    const result = rotateAccessLogFile(targetPath, maxFiles);
    out(
      JSON.stringify(
        {
          command: "access-log:rotate",
          path: targetPath,
          maxFiles,
          ...result,
        },
        null,
        2,
      ),
    );
    return 0;
  } catch (error) {
    err(redactedErrorMessage(error));
    return 1;
  }
}

function parseStringFlag(args: string[], prefix: string): string | undefined {
  const arg = args.find((entry) => entry.startsWith(prefix));
  if (!arg) return undefined;
  const value = arg.slice(prefix.length).trim();
  return value || undefined;
}

function resolveMaxFiles(argv: string[], env: NodeJS.ProcessEnv): number {
  const argvValue = parseStringFlag(argv, "--max-files=");
  if (argvValue !== undefined) {
    const parsed = Number(argvValue);
    if (Number.isInteger(parsed) && parsed >= 1) {
      return parsed;
    }
  }
  const envRaw = env.PACKETAGENT_ACCESS_LOG_MAX_FILES;
  if (envRaw !== undefined && envRaw !== "") {
    const parsed = Number(envRaw);
    if (Number.isInteger(parsed) && parsed >= 1) {
      return parsed;
    }
  }
  return 5;
}

function isExecutedDirectly(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  return resolve(fileURLToPath(import.meta.url)) === resolve(entrypoint);
}

if (isExecutedDirectly()) {
  runAccessLogRotateCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
