import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ValidationViolation {
  line: number;
  column: number;
  pattern: string;
  snippet: string;
}

export interface ValidationResult {
  violations: ValidationViolation[];
}

interface PatternRule {
  label: string;
  regex: RegExp;
}

const PATTERN_RULES: PatternRule[] = [
  { label: "bearer-token", regex: /Bearer\s+\S+/gi },
  { label: "webhook-token", regex: /\bwhk_[A-Za-z0-9_-]+/g },
  { label: "share-path", regex: /\/share\/[A-Za-z0-9._~-]+/g },
  { label: "public-share-path", regex: /\/api\/public\/share\/[A-Za-z0-9._~-]+/g },
  { label: "public-webhook-path", regex: /\/api\/public\/webhooks\/agents\/[A-Za-z0-9._~-]+/g },
  { label: "invitation-accept-path", regex: /\/api\/app\/invitations\/[A-Za-z0-9._~-]+\/accept/g },
  {
    label: "sensitive-query-param",
    regex: /[?&](?:token|access_token|api[_-]?key|apikey|key|secret)=[^&\s"']+/gi,
  },
];

const ALREADY_REDACTED_MARKERS = ["[redacted]", "***", "<redacted>", "xxx"];
const SNIPPET_MAX = 80;

function isAlreadyRedacted(match: string): boolean {
  const lower = match.toLowerCase();
  return ALREADY_REDACTED_MARKERS.some((marker) => lower.includes(marker));
}

function truncateSnippet(value: string): string {
  if (value.length <= SNIPPET_MAX) return value;
  return `${value.slice(0, SNIPPET_MAX - 1)}…`;
}

export function validateAccessLogContent(content: string): ValidationResult {
  const violations: ValidationViolation[] = [];
  if (!content) return { violations };

  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const lineNumber = index + 1;

    for (const rule of PATTERN_RULES) {
      rule.regex.lastIndex = 0;
      let match: RegExpExecArray | null = rule.regex.exec(line);
      while (match) {
        const matched = match[0];
        if (!isAlreadyRedacted(matched)) {
          violations.push({
            line: lineNumber,
            column: match.index + 1,
            pattern: rule.label,
            snippet: truncateSnippet(matched),
          });
        }
        if (match.index === rule.regex.lastIndex) {
          rule.regex.lastIndex += 1;
        }
        match = rule.regex.exec(line);
      }
    }
  }

  return { violations };
}

function writeUsage(): void {
  console.error(
    "Usage: node --import tsx src/security/proxy-access-log-validator.ts <log-path> [<log-path> ...]",
  );
}

export async function runValidatorCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0) {
    writeUsage();
    return 2;
  }

  let totalViolations = 0;
  let totalLines = 0;

  for (const rawPath of argv) {
    const path = resolve(rawPath);
    if (!existsSync(path)) {
      console.error(`error: file not found: ${rawPath}`);
      return 2;
    }

    const content = readFileSync(path, "utf8");
    const lineCount = content ? content.split(/\r?\n/).length : 0;
    totalLines += lineCount;

    const { violations } = validateAccessLogContent(content);
    totalViolations += violations.length;

    for (const violation of violations) {
      console.error(
        `${rawPath}:${violation.line}:${violation.column}: ${violation.pattern} ${violation.snippet}`,
      );
    }
  }

  if (totalViolations === 0) {
    console.log(`OK: scanned ${totalLines} lines, no sensitive patterns found.`);
    return 0;
  }

  console.error(`Found ${totalViolations} violations in ${totalLines} lines`);
  return 1;
}

function isExecutedDirectly(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  return resolve(fileURLToPath(import.meta.url)) === resolve(entrypoint);
}

if (isExecutedDirectly()) {
  runValidatorCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
