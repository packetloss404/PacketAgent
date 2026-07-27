// =============================================================================
// LLM file-tree authoring orchestrator (Track B skeleton)
// =============================================================================
//
// The Builder MVP currently slot-fills one of a handful of hardcoded templates
// (`renderGeneratedAppTsx` + `TEMPLATE_DEFINITIONS`). That keeps generations
// fast and predictable but caps the kinds of apps the user can ask for at
// whatever the template author imagined.
//
// This orchestrator is the alternative path: instead of selecting a template,
// the LLM authors the actual file tree by emitting a sequence of
// `write_file(path, content)` tool calls. The orchestrator:
//
//   1. Asks the model to OUTLINE the files it will write (plan phase). The
//      plan is returned as JSON `[{ path, purpose }]` so the orchestrator (and
//      eventually the validator in B2) can decide whether to proceed or
//      abort before any real writes happen.
//   2. Asks the model to EMIT those files via `write_file` tool calls (write
//      phase). Prose narration is streamed to the caller's `emit` callback so
//      the chat thread shows what the model is doing.
//
// The orchestrator routes through `ProviderRouter` + the preset resolver so it
// works with any of the registered providers (Anthropic, OpenAI, OpenRouter,
// Minimax, Ollama, Gemini). It never imports a specific provider directly.
//
// This file is intentionally standalone: B2 will add `./path-validator.js`,
// B3 will add richer prompts in `./prompts.ts`, and B4 will wire the
// orchestrator into `app-builder-service.ts` behind an opt-in flag. Until
// those land, local placeholders keep this file compileable on its own.
// =============================================================================

import {
  getDefaultRouter,
  type ProviderRouter,
} from "../providers/router.js";
import {
  resolvePresetToProviderModel,
  type ModelPreset,
} from "../providers/preset-resolver.js";
import type {
  LLMProvider,
  ProviderStreamChunk,
  ProviderToolDef,
} from "../providers/types.js";
import { validateWorkspacePath } from "./path-validator.js";
import {
  validateFileTree,
  type ValidateOptions,
  type ValidationError,
  type ValidationResult,
} from "./validate.js";

// =============================================================================
// Public types
// =============================================================================

export interface GeneratedFile {
  /** Workspace-relative path, e.g. "src/App.tsx". */
  path: string;
  /** Complete file contents. */
  content: string;
}

export interface AuthorAppResult {
  files: GeneratedFile[];
  /** Short human-readable description of what was built. */
  summary: string;
  /** Always "llm" here; the template path is owned by the caller (B4). */
  source: "llm" | "template";
}

export interface PlannedFile {
  path: string;
  purpose: string;
}

export interface ResolvedPrompts {
  systemPrompt: string;
  planUserPrompt: (userGoal: string) => string;
  writeUserPrompt: (plan: string) => string;
}

export interface AuthorAppOptions {
  preset?: "cheap" | "fast" | "smart" | "local";
  workspaceId: string;
  signal?: AbortSignal;
  /** Optional override of the registered router (for tests). */
  router?: ProviderRouter;
  /** Optional override of the prompt resolver (for tests). */
  resolvePrompts?: () => ResolvedPrompts;
}

export type AuthorAppFn = typeof authorAppViaLLM;
export type ValidateFileTreeFn = typeof validateFileTree;

export interface AuthorAndValidateAppOptions extends AuthorAppOptions {
  /** Test-only override. Production callers should use the default author. */
  authorFn?: AuthorAppFn;
  /** Test-only override. Production callers should use the real validator. */
  validateFn?: ValidateFileTreeFn;
  validateOptions?: ValidateOptions;
  /** Number of repair passes after the initial authoring attempt. */
  maxValidationFixAttempts?: number;
}

export interface AuthorAndValidateAppResult extends AuthorAppResult {
  validation: ValidationResult;
  repairAttempts: number;
  stoppedReason?: "max-attempts" | "repeated-errors" | "repair-author-failed";
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Path safety check for the `write_file` handler.
 *
 * This is a thin boolean wrapper over the hardened, shared
 * `validateWorkspacePath()` in `./path-validator.js` — the single source of
 * truth for workspace-path safety. It defends against every traversal trick
 * the security review surfaced (NUL bytes, `..` escape after normalization,
 * absolute/UNC/extended paths, Windows reserved device names, NTFS alternate
 * data streams via `:`, and trailing-dot/whitespace aliasing).
 *
 * The write handler calls `validateWorkspacePath()` directly so it can log the
 * specific rejection reason; this wrapper exists so callers that only need a
 * yes/no answer keep a stable surface.
 */
export function isSafePath(input: string): boolean {
  return validateWorkspacePath(input).ok;
}

/**
 * Default prompts. The orchestrator carries a usable default that the tests
 * can override via `options.resolvePrompts`.
 */
function defaultPrompts(): ResolvedPrompts {
  const systemPrompt = [
    "You are PacketAgent's code authoring assistant. You generate small, self-",
    "contained web apps as a file tree. Your output runs in a Vite + React",
    "workspace under `src/`.",
    "",
    "You work in two phases:",
    "  1. PLAN — outline the files you will write. Respond with prose, then a",
    "     single JSON block formatted as `[{\"path\": string, \"purpose\":",
    "     string}, ...]`. The JSON MUST be parseable.",
    "  2. WRITE — emit one `write_file` tool call per planned file. Each call",
    "     carries a workspace-relative path and complete file contents.",
    "",
    "Constraints:",
    "  - All paths are relative to the workspace root.",
    "  - Never write outside the workspace (no `..`, no absolute paths).",
    "  - Keep the file count small (typically 5–15 files).",
  ].join("\n");
  return {
    systemPrompt,
    planUserPrompt: (userGoal: string) =>
      [
        `User goal: ${userGoal}`,
        "",
        "Plan the files you will write to satisfy this goal. Respond with a",
        "short narration followed by a JSON array of {path, purpose} objects.",
      ].join("\n"),
    writeUserPrompt: (plan: string) =>
      [
        "Now emit the files. For each entry in the plan below, call the",
        "`write_file` tool with the workspace-relative path and the COMPLETE",
        "file contents. Do not skip files; do not invent files that are not in",
        "the plan.",
        "",
        "Plan:",
        plan,
      ].join("\n"),
  };
}

// =============================================================================
// Chunking constants
// =============================================================================

/**
 * Maximum number of files emitted per write-phase round. When the plan has
 * more than 10 files, the orchestrator splits the write phase into multiple
 * rounds, each constrained to this many files, so the model doesn't run out
 * of output budget (`maxTokens=8192`) or simply forget files mid-stream.
 */
export const MAX_FILES_PER_WRITE_CHUNK = 8;

/**
 * Threshold above which the write phase is chunked. Plans with at most this
 * many files use the original single-round write phase to keep small-app
 * generation latency unchanged.
 */
const CHUNK_WRITE_THRESHOLD = 10;
const DEFAULT_VALIDATION_FIX_ATTEMPTS = 2;
const REPAIR_PROMPT_FILE_BUDGET_BYTES = 60_000;

// =============================================================================
// Tool definition
// =============================================================================

const WRITE_FILE_TOOL: ProviderToolDef = {
  name: "write_file",
  description:
    "Write a single file in the generated app's workspace. Path must be relative to the workspace root. Content is the complete file contents.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Workspace-relative path. e.g. src/App.tsx",
      },
      content: {
        type: "string",
        description: "Complete file contents.",
      },
    },
    required: ["path", "content"],
  },
};

// =============================================================================
// Plan parsing
// =============================================================================

/**
 * Extracts the first JSON array of `{path, purpose}` objects from a blob of
 * model prose. Returns `null` if no valid plan is found. The model is
 * encouraged to format the plan as ```json ... ``` but we accept any JSON
 * array that parses and has the right shape.
 */
export function parsePlan(blob: string): PlannedFile[] | null {
  if (typeof blob !== "string" || blob.trim().length === 0) return null;

  // 1. Try fenced ```json ... ``` blocks first.
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  const candidates: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(blob)) !== null) {
    if (match[1]) candidates.push(match[1]);
  }

  // 2. Also try to find a top-level JSON array anywhere in the text.
  const firstBracket = blob.indexOf("[");
  const lastBracket = blob.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    candidates.push(blob.slice(firstBracket, lastBracket + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate.trim());
      if (!Array.isArray(parsed)) continue;
      const files: PlannedFile[] = [];
      for (const entry of parsed) {
        if (!entry || typeof entry !== "object") continue;
        const path = (entry as Record<string, unknown>).path;
        const purpose = (entry as Record<string, unknown>).purpose;
        if (typeof path !== "string" || path.length === 0) continue;
        if (typeof purpose !== "string") continue;
        files.push({ path, purpose });
      }
      if (files.length > 0) return files;
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

// =============================================================================
// Provider resolution
// =============================================================================

interface ResolvedProvider {
  provider: LLMProvider;
  model: string;
}

function resolveProvider(
  options: AuthorAppOptions,
): ResolvedProvider | null {
  const router = options.router ?? getDefaultRouter();
  const resolved = resolvePresetToProviderModel(
    options.preset as ModelPreset | undefined,
    { router },
  );
  if (!resolved) return null;
  const provider = router.get(resolved.provider);
  if (!provider) return null;
  return { provider, model: resolved.model };
}

// =============================================================================
// Phase 1: planning
// =============================================================================

interface PlanPhaseResult {
  /** Parsed plan, or null if parsing failed twice. */
  plan: PlannedFile[] | null;
  /** Full prose blob for debug / pass-through to write phase. */
  prose: string;
}

async function runPlanPhase(
  userGoal: string,
  prompts: ResolvedPrompts,
  resolved: ResolvedProvider,
  options: AuthorAppOptions,
  emit: (chunk: string) => void | Promise<void>,
): Promise<PlanPhaseResult | null> {
  let lastProse = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const userContent =
      attempt === 0
        ? prompts.planUserPrompt(userGoal)
        : [
            prompts.planUserPrompt(userGoal),
            "",
            "Your previous response did not contain a parseable JSON plan.",
            "Respond with ONLY a JSON array of {path, purpose} objects.",
          ].join("\n");

    let stream: AsyncIterable<ProviderStreamChunk>;
    try {
      stream = resolved.provider.stream({
        model: resolved.model,
        workspaceId: options.workspaceId,
        routeKey: "code.generation",
        maxTokens: 2048,
        temperature: 0.2,
        ...(options.signal ? { signal: options.signal } : {}),
        messages: [
          { role: "system", content: prompts.systemPrompt },
          { role: "user", content: userContent },
        ],
      });
    } catch (error) {
      console.warn(
        `[llm-author] plan stream init failed: ${(error as Error).message}`,
      );
      return null;
    }

    const proseParts: string[] = [];
    try {
      for await (const chunk of stream) {
        if (chunk.error) {
          console.warn(`[llm-author] plan stream error: ${chunk.error}`);
          return null;
        }
        if (chunk.delta) {
          proseParts.push(chunk.delta);
          try {
            await emit(chunk.delta);
          } catch {
            // emit must not break generation
          }
        }
      }
    } catch (error) {
      console.warn(
        `[llm-author] plan stream consume failed: ${(error as Error).message}`,
      );
      return null;
    }

    lastProse = proseParts.join("");
    const plan = parsePlan(lastProse);
    if (plan && plan.length > 0) {
      return { plan, prose: lastProse };
    }
  }

  // Both attempts failed to produce a parseable plan.
  return { plan: null, prose: lastProse };
}

// =============================================================================
// Phase 2: writing
// =============================================================================

interface WritePhaseResult {
  files: GeneratedFile[];
}

/**
 * Runs a single write-phase round. The caller decides what prompt text to
 * send (the original single-round prompt for small plans, or a chunk-scoped
 * prompt for large plans). The tool list and streaming logic are identical
 * across both call sites; only the user message text differs.
 */
async function runSingleWriteRound(
  prompts: ResolvedPrompts,
  resolved: ResolvedProvider,
  options: AuthorAppOptions,
  userContent: string,
  emit: (chunk: string) => void | Promise<void>,
): Promise<WritePhaseResult | null> {
  let stream: AsyncIterable<ProviderStreamChunk>;
  try {
    stream = resolved.provider.stream({
      model: resolved.model,
      workspaceId: options.workspaceId,
      routeKey: "code.generation",
      maxTokens: 8192,
      temperature: 0.2,
      ...(options.signal ? { signal: options.signal } : {}),
      messages: [
        { role: "system", content: prompts.systemPrompt },
        { role: "user", content: userContent },
      ],
      tools: [WRITE_FILE_TOOL],
    });
  } catch (error) {
    console.warn(
      `[llm-author] write stream init failed: ${(error as Error).message}`,
    );
    return null;
  }

  const files: GeneratedFile[] = [];
  try {
    for await (const chunk of stream) {
      if (chunk.error) {
        console.warn(`[llm-author] write stream error: ${chunk.error}`);
        return null;
      }
      if (chunk.delta) {
        try {
          await emit(chunk.delta);
        } catch {
          // emit must not break generation
        }
      }
      if (chunk.toolCall && chunk.toolCall.name === WRITE_FILE_TOOL.name) {
        const input = chunk.toolCall.input ?? {};
        const path = (input as Record<string, unknown>).path;
        const content = (input as Record<string, unknown>).content;
        if (typeof path !== "string" || typeof content !== "string") {
          console.warn(
            `[llm-author] write_file call missing path/content; skipping`,
          );
          continue;
        }
        const pathCheck = validateWorkspacePath(path);
        if (!pathCheck.ok) {
          console.warn(
            `[llm-author] write_file rejected unsafe path: ${path} (${pathCheck.reason})`,
          );
          continue;
        }
        files.push({ path, content });
      }
    }
  } catch (error) {
    console.warn(
      `[llm-author] write stream consume failed: ${(error as Error).message}`,
    );
    return null;
  }

  return { files };
}

function buildPlanSummary(plan: PlannedFile[]): string {
  return plan.map((entry) => `- ${entry.path} — ${entry.purpose}`).join("\n");
}

function buildChunkUserPrompt(chunk: PlannedFile[]): string {
  const pathList = chunk.map((entry) => entry.path).join(", ");
  const chunkBullets = chunk
    .map((entry) => `- ${entry.path} — ${entry.purpose}`)
    .join("\n");
  return [
    `Write these files: ${pathList}. Don't write any other files in this turn.`,
    "",
    "For each file below, call the `write_file` tool with its workspace-",
    "relative path and the COMPLETE file contents.",
    "",
    "Files to emit in this turn:",
    chunkBullets,
  ].join("\n");
}

async function runWritePhase(
  plan: PlannedFile[],
  prompts: ResolvedPrompts,
  resolved: ResolvedProvider,
  options: AuthorAppOptions,
  emit: (chunk: string) => void | Promise<void>,
): Promise<WritePhaseResult | null> {
  const planSummary = buildPlanSummary(plan);
  return runSingleWriteRound(
    prompts,
    resolved,
    options,
    prompts.writeUserPrompt(planSummary),
    emit,
  );
}

/**
 * Chunked write phase used when `plan.length > CHUNK_WRITE_THRESHOLD`. The
 * plan is split (in plan order) into groups of at most
 * `MAX_FILES_PER_WRITE_CHUNK` files. Each chunk runs as an independent write
 * round; results accumulate. If a round emits zero `write_file` calls, the
 * orchestrator stops early and returns whatever it has so far (partial
 * result rather than all-or-nothing).
 */
async function runWritePhaseChunked(
  plan: PlannedFile[],
  prompts: ResolvedPrompts,
  resolved: ResolvedProvider,
  options: AuthorAppOptions,
  emit: (chunk: string) => void | Promise<void>,
): Promise<WritePhaseResult | null> {
  const chunks: PlannedFile[][] = [];
  for (let i = 0; i < plan.length; i += MAX_FILES_PER_WRITE_CHUNK) {
    chunks.push(plan.slice(i, i + MAX_FILES_PER_WRITE_CHUNK));
  }

  const accumulated: GeneratedFile[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    const userContent = buildChunkUserPrompt(chunk);
    const roundResult = await runSingleWriteRound(
      prompts,
      resolved,
      options,
      userContent,
      emit,
    );
    if (!roundResult) {
      // Hard error from the provider stream. Surface as null only if we
      // haven't accumulated anything yet; otherwise return the partial
      // result so the caller can still ship what was produced.
      if (accumulated.length === 0) return null;
      console.warn(
        `[llm-author] write chunk ${i + 1}/${chunks.length} stream failed; returning partial result`,
      );
      return { files: accumulated };
    }
    if (roundResult.files.length === 0) {
      console.warn(
        `[llm-author] write chunk ${i + 1}/${chunks.length} emitted 0 files; stopping`,
      );
      return { files: accumulated };
    }
    accumulated.push(...roundResult.files);
  }

  return { files: accumulated };
}

// =============================================================================
// Public orchestrator
// =============================================================================

/**
 * Two-phase plan-then-write LLM orchestration. Returns `null` on any
 * non-recoverable error (no provider, stream error, zero files written, plan
 * parse failure after retry) so the caller can fall back to the template
 * generator.
 */
export async function authorAppViaLLM(
  userGoal: string,
  options: AuthorAppOptions,
  emit: (chunk: string) => void | Promise<void>,
): Promise<AuthorAppResult | null> {
  const trimmed = (userGoal ?? "").trim();
  if (trimmed.length === 0) return null;

  const resolved = resolveProvider(options);
  if (!resolved) {
    console.warn(`[llm-author] no provider resolved for preset=${options.preset ?? "fast"}`);
    return null;
  }

  const prompts = (options.resolvePrompts ?? defaultPrompts)();

  // Phase 1: plan.
  const planResult = await runPlanPhase(trimmed, prompts, resolved, options, emit);
  if (!planResult) return null;
  if (!planResult.plan) {
    console.warn(`[llm-author] plan unparseable after 1 retry; aborting`);
    return null;
  }

  // Phase 2: write. For plans up to CHUNK_WRITE_THRESHOLD files we run a
  // single write round (preserving small-app latency). Larger plans are
  // chunked across multiple rounds so we don't blow past maxTokens.
  const writeResult =
    planResult.plan.length > CHUNK_WRITE_THRESHOLD
      ? await runWritePhaseChunked(
          planResult.plan,
          prompts,
          resolved,
          options,
          emit,
        )
      : await runWritePhase(
          planResult.plan,
          prompts,
          resolved,
          options,
          emit,
        );
  if (!writeResult) return null;
  if (writeResult.files.length === 0) {
    console.warn(`[llm-author] model emitted zero write_file calls`);
    return null;
  }

  const summary = buildSummary(trimmed, planResult.plan, writeResult.files);

  return {
    files: writeResult.files,
    summary,
    source: "llm",
  };
}

export async function authorAndValidateAppViaLLM(
  userGoal: string,
  options: AuthorAndValidateAppOptions,
  emit: (chunk: string) => void | Promise<void>,
): Promise<AuthorAndValidateAppResult | null> {
  const author = options.authorFn ?? authorAppViaLLM;
  const validate = options.validateFn ?? validateFileTree;
  const maxRepairAttempts = Math.max(0, options.maxValidationFixAttempts ?? DEFAULT_VALIDATION_FIX_ATTEMPTS);
  const authorOptions = authorOptionsOnly(options);
  const validateOptions = validationOptionsOnly(options);
  const seenSignatures = new Set<string>();

  let result = await author(userGoal, authorOptions, emit);
  if (!result) return null;

  for (let repairAttempts = 0; ; repairAttempts++) {
    const validation = await runValidation(validate, result.files, validateOptions);
    if (validation.ok || validation.source !== "real" || validation.errors.length === 0) {
      return { ...result, validation, repairAttempts };
    }

    const signature = validationErrorSignature(validation);
    if (seenSignatures.has(signature)) {
      return { ...result, validation, repairAttempts, stoppedReason: "repeated-errors" };
    }
    seenSignatures.add(signature);

    if (repairAttempts >= maxRepairAttempts) {
      return { ...result, validation, repairAttempts, stoppedReason: "max-attempts" };
    }

    try {
      await emit(
        `\n\nBuild validation found ${validation.errors.length} issue${validation.errors.length === 1 ? "" : "s"}. ` +
        `Trying repair pass ${repairAttempts + 1} of ${maxRepairAttempts}.\n\n`,
      );
    } catch {
      // emit must not break generation
    }

    const repairGoal = buildValidationRepairGoal(userGoal, result.files, validation, repairAttempts + 1);
    const repaired = await author(repairGoal, authorOptions, emit);
    if (!repaired) {
      return { ...result, validation, repairAttempts, stoppedReason: "repair-author-failed" };
    }
    result = repaired;
  }
}

function buildSummary(
  userGoal: string,
  plan: PlannedFile[],
  files: GeneratedFile[],
): string {
  const fileCount = files.length;
  const goalSnippet = userGoal.length > 80 ? `${userGoal.slice(0, 77)}...` : userGoal;
  const plannedNote =
    plan.length === files.length
      ? `${fileCount} files`
      : `${fileCount}/${plan.length} files`;
  return `LLM-authored app for: ${goalSnippet} (${plannedNote})`;
}

function authorOptionsOnly(options: AuthorAndValidateAppOptions): AuthorAppOptions {
  const out: AuthorAppOptions = { workspaceId: options.workspaceId };
  if (options.preset) out.preset = options.preset;
  if (options.signal) out.signal = options.signal;
  if (options.router) out.router = options.router;
  if (options.resolvePrompts) out.resolvePrompts = options.resolvePrompts;
  return out;
}

function validationOptionsOnly(options: AuthorAndValidateAppOptions): ValidateOptions {
  const out: ValidateOptions = { ...(options.validateOptions ?? {}) };
  if (options.signal && !out.signal) out.signal = options.signal;
  return out;
}

async function runValidation(
  validate: ValidateFileTreeFn,
  files: GeneratedFile[],
  options: ValidateOptions,
): Promise<ValidationResult> {
  try {
    return await validate(files, options);
  } catch (error) {
    return {
      ok: false,
      source: "real",
      errors: [{
        file: "<validator>",
        message: error instanceof Error ? error.message : String(error),
        severity: "error",
        phase: "typecheck",
      }],
      warnings: [],
      durationMs: 0,
      phases: { typecheck: "failed", build: "skipped" },
    };
  }
}

function validationErrorSignature(validation: ValidationResult): string {
  return validation.errors
    .slice(0, 12)
    .map((error) => [
      error.phase,
      error.file,
      error.line ?? "",
      error.column ?? "",
      normalizeValidationMessage(error.message),
    ].join(":"))
    .join("|");
}

function normalizeValidationMessage(message: string): string {
  return message
    .replace(/\b\d+:\d+\b/g, "N:N")
    .replace(/\b\d+\b/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function buildValidationRepairGoal(
  originalGoal: string,
  files: GeneratedFile[],
  validation: ValidationResult,
  attempt: number,
): string {
  const renderedFiles = renderFilesForRepairPrompt(files, REPAIR_PROMPT_FILE_BUDGET_BYTES);
  return [
    "Repair the generated Vite + React app file tree.",
    "",
    `Original user goal: ${originalGoal}`,
    `Repair attempt: ${attempt}`,
    "",
    "The previous file tree failed validation. Return a COMPLETE corrected file tree using `write_file` calls.",
    "Keep the app's intended behavior, but fix the TypeScript/build errors. Do not explain instead of writing files.",
    "",
    "Validation errors:",
    ...validation.errors.map(formatValidationErrorForPrompt),
    "",
    "Current file tree:",
    renderedFiles,
  ].join("\n");
}

function formatValidationErrorForPrompt(error: ValidationError): string {
  const location = `${error.file}${error.line ? `:${error.line}` : ""}${error.column ? `:${error.column}` : ""}`;
  return `- [${error.phase}] ${location}: ${error.message}`;
}

function renderFilesForRepairPrompt(files: GeneratedFile[], budgetBytes: number): string {
  const chunks: string[] = [];
  let used = 0;
  for (const file of files) {
    const header = `\n--- ${file.path}\n\`\`\`\n`;
    const footer = "\n```\n";
    const remaining = budgetBytes - used - Buffer.byteLength(header) - Buffer.byteLength(footer);
    if (remaining <= 0) {
      chunks.push(`\n... ${files.length - chunks.length} more file(s) omitted due to prompt budget.\n`);
      break;
    }
    const contentBytes = Buffer.byteLength(file.content);
    const content = contentBytes > remaining
      ? `${file.content.slice(0, Math.max(0, remaining))}\n... truncated ...`
      : file.content;
    chunks.push(`${header}${content}${footer}`);
    used += Buffer.byteLength(chunks[chunks.length - 1] ?? "");
  }
  return chunks.join("");
}
