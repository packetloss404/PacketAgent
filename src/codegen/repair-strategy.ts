import type { ValidationError, ValidationResult } from "./validate.js";

export type ValidationFailureCluster =
  | "module-graph"
  | "type-contract"
  | "jsx-syntax"
  | "entry-config"
  | "styling-config"
  | "runtime-api"
  | "generic";

export interface RepairFile {
  path: string;
  content: string;
}

export interface ValidationRepairStrategy {
  clusters: ValidationFailureCluster[];
  focusFiles: string[];
  instructions: string[];
}

const MAX_PROMPT_DIAGNOSTICS = 20;
const MAX_FOCUS_FILES = 8;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 500;
const REPAIR_PROMPT_FILE_BUDGET_BYTES = 60_000;

const CLUSTER_ORDER: readonly ValidationFailureCluster[] = [
  "entry-config",
  "styling-config",
  "module-graph",
  "jsx-syntax",
  "type-contract",
  "runtime-api",
  "generic",
];

const CLUSTER_INSTRUCTIONS: Readonly<Record<ValidationFailureCluster, string>> = {
  "module-graph":
    "Repair the module graph: use exact workspace-relative import paths and casing, remove stale imports, and only author a missing local module when the app actually needs it. Do not add new packages.",
  "type-contract":
    "Repair the TypeScript contract at its source: align props, state, entity fields, and function return types. Do not hide errors with `any`, `@ts-ignore`, or disabled strictness.",
  "jsx-syntax":
    "Repair JSX/TypeScript syntax first: balance tags and delimiters, keep hooks inside components, and return one valid React tree from each component.",
  "entry-config":
    "Repair the app entry/config contract: keep package scripts, index.html, src/main.tsx, tsconfig.json, and vite.config.ts mutually consistent with the Vite + React baseline.",
  "styling-config":
    "Repair the Tailwind/PostCSS contract: keep only the declared baseline packages, valid config exports/content globs, and the three Tailwind directives in src/index.css.",
  "runtime-api":
    "Repair generated-app data access: read the app id from document.body.dataset.appId and use the same-origin PacketAgent generated-app API. Do not introduce localStorage, IndexedDB, sql.js, or external network calls.",
  generic:
    "Make the smallest deterministic source change that resolves the reported diagnostic while preserving the requested behavior and the existing file tree.",
};

/**
 * Classify concrete TypeScript/Vite diagnostics into the small failure
 * families observed by the generated-app validator. The result is
 * deterministic and intentionally conservative: an unknown diagnostic gets
 * the generic strategy instead of an invented fix.
 */
export function classifyValidationFailures(
  validation: Pick<ValidationResult, "errors">,
): ValidationRepairStrategy {
  const clusterSet = new Set<ValidationFailureCluster>();
  const focusCounts = new Map<string, { count: number; first: number }>();

  validation.errors.forEach((error, index) => {
    clusterSet.add(classifyError(error));
    const file = normalizeDiagnosticFile(error.file);
    if (!file) return;
    const current = focusCounts.get(file);
    focusCounts.set(file, {
      count: (current?.count ?? 0) + 1,
      first: current?.first ?? index,
    });
  });

  const clusters = CLUSTER_ORDER.filter((cluster) => clusterSet.has(cluster));
  if (clusters.length === 0) clusters.push("generic");
  const focusFiles = [...focusCounts.entries()]
    .sort((left, right) => right[1].count - left[1].count || left[1].first - right[1].first)
    .slice(0, MAX_FOCUS_FILES)
    .map(([file]) => file);

  return {
    clusters,
    focusFiles,
    instructions: clusters.map((cluster) => CLUSTER_INSTRUCTIONS[cluster]),
  };
}

export function buildValidationRepairGoal(
  originalGoal: string,
  files: RepairFile[],
  validation: ValidationResult,
  attempt: number,
): string {
  const strategy = classifyValidationFailures(validation);
  const renderedFiles = renderFilesForRepairPrompt(
    files,
    strategy.focusFiles,
    REPAIR_PROMPT_FILE_BUDGET_BYTES,
  );
  const diagnostics = validation.errors
    .slice(0, MAX_PROMPT_DIAGNOSTICS)
    .map(formatValidationErrorForPrompt);
  const omittedDiagnosticCount = Math.max(0, validation.errors.length - diagnostics.length);

  return [
    "Repair the generated Vite + React app file tree.",
    "",
    `Original user goal: ${originalGoal}`,
    `Repair attempt: ${attempt}`,
    `Failure clusters: ${strategy.clusters.join(", ")}`,
    "",
    "Targeted repair instructions:",
    ...strategy.instructions.map((instruction) => `- ${instruction}`),
    ...(strategy.focusFiles.length > 0
      ? ["", `Focus files (highest diagnostic count first): ${strategy.focusFiles.join(", ")}`]
      : []),
    "",
    "The previous file tree failed validation. Return a COMPLETE corrected file tree using `write_file` calls.",
    "Keep the app's intended behavior. Do not explain instead of writing files, and do not omit unchanged files.",
    "",
    "Validation errors:",
    ...diagnostics,
    ...(omittedDiagnosticCount > 0
      ? [`- ... ${omittedDiagnosticCount} additional diagnostic(s) omitted by the prompt bound.`]
      : []),
    "",
    "Current file tree (focus files are rendered first):",
    renderedFiles,
  ].join("\n");
}

function classifyError(error: ValidationError): ValidationFailureCluster {
  const file = normalizeDiagnosticFile(error.file)?.toLowerCase() ?? "";
  const message = stripControlSequences(error.message).toLowerCase();

  if (
    /(^|\/)(package\.json|index\.html|vite\.config\.[cm]?[jt]s|tsconfig(?:\.[^/]+)?\.json)$/.test(
      file,
    ) ||
    message.includes("could not resolve entry module") ||
    message.includes("failed to load config")
  ) {
    return "entry-config";
  }
  if (
    /(^|\/)(tailwind\.config\.[cm]?[jt]s|postcss\.config\.[cm]?[jt]s|src\/index\.css)$/.test(
      file,
    ) ||
    /\b(tailwind|postcss|autoprefixer)\b/.test(message)
  ) {
    return "styling-config";
  }
  if (
    message.includes("cannot find module") ||
    message.includes("failed to resolve import") ||
    message.includes("could not resolve") ||
    message.includes("module not found")
  ) {
    return "module-graph";
  }
  if (
    file.endsWith(".tsx") &&
    (message.includes("jsx") ||
      message.includes("unterminated") ||
      message.includes("unexpected token") ||
      message.includes("corresponding closing tag") ||
      message.includes("expected '}'"))
  ) {
    return "jsx-syntax";
  }
  if (
    message.includes("is not assignable to") ||
    message.includes("does not exist on type") ||
    message.includes("cannot find name") ||
    message.includes("no overload matches") ||
    message.includes("implicitly has an 'any' type") ||
    message.includes("type '") ||
    message.includes("expected ")
  ) {
    return "type-contract";
  }
  if (
    message.includes("localstorage") ||
    message.includes("indexeddb") ||
    message.includes("sql.js") ||
    message.includes("dataset.appid") ||
    message.includes("generated-apps")
  ) {
    return "runtime-api";
  }
  return "generic";
}

function formatValidationErrorForPrompt(error: ValidationError): string {
  const message = stripControlSequences(error.message)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH);
  const location = `${error.file}${error.line ? `:${error.line}` : ""}${error.column ? `:${error.column}` : ""}`;
  return `- [${error.phase}] ${location}: ${message}`;
}

function renderFilesForRepairPrompt(
  files: RepairFile[],
  focusFiles: string[],
  budgetBytes: number,
): string {
  const focusOrder = new Map(focusFiles.map((path, index) => [path, index]));
  const ordered = files
    .map((file, index) => ({ file, index }))
    .sort((left, right) => {
      const leftFocus = focusOrder.get(left.file.path);
      const rightFocus = focusOrder.get(right.file.path);
      if (leftFocus !== undefined || rightFocus !== undefined) {
        if (leftFocus === undefined) return 1;
        if (rightFocus === undefined) return -1;
        return leftFocus - rightFocus;
      }
      return left.index - right.index;
    })
    .map(({ file }) => file);

  const chunks: string[] = [];
  let used = 0;
  for (let index = 0; index < ordered.length; index++) {
    const file = ordered[index]!;
    const header = `\n--- ${file.path}\n\`\`\`\n`;
    const footer = "\n```\n";
    const remaining = budgetBytes - used - Buffer.byteLength(header) - Buffer.byteLength(footer);
    if (remaining <= 0) {
      chunks.push(`\n... ${ordered.length - index} more file(s) omitted due to prompt budget.\n`);
      break;
    }
    const contentBytes = Buffer.byteLength(file.content);
    const content =
      contentBytes > remaining
        ? `${file.content.slice(0, Math.max(0, remaining))}\n... truncated ...`
        : file.content;
    const chunk = `${header}${content}${footer}`;
    chunks.push(chunk);
    used += Buffer.byteLength(chunk);
  }
  return chunks.join("");
}

function normalizeDiagnosticFile(file: string): string | null {
  const normalized = String(file ?? "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "");
  if (!normalized || normalized.startsWith("<")) return null;
  return normalized;
}

function stripControlSequences(value: string): string {
  return String(value ?? "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}
