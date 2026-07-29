import {
  authorAndValidateAppViaLLM,
  type AuthorAndValidateAppOptions,
} from "../codegen/llm-author.js";
import { deriveDraftFromFiles } from "../codegen/derived-draft.js";
import type { AppDraftEmit, AppDraftLLMOptions, GenerateAppDraftResult } from "./llm-draft.js";

/**
 * Track B file-tree path (now the default in `generateAppDraftWithLLM`):
 * ask the file-tree orchestrator to author a generated app as a list of
 * files, run the build validator, then project the file tree into an
 * AppDraft so all downstream consumers keep working.
 *
 * Returns null when the orchestrator declined (no BYOK key, model gave up,
 * etc.) so the caller can fall through to the existing structured-tool /
 * template paths. The legacy `PACKETAGENT_FILETREE_CODEGEN=1` opt-in flag is
 * preserved as a no-op; the opt-out is `PACKETAGENT_LEGACY_TEMPLATES=1`, which
 * is handled in `generateAppDraftWithLLM` before this function is called.
 *
 * Note: this code path's runtime behaviour depends on the real B1 / B2 / B3
 * modules under `src/codegen/`. With no BYOK key configured, the
 * orchestrator returns null and the caller falls through transparently.
 */
export async function tryFileTreeCodegen(
  prompt: string,
  options: AppDraftLLMOptions,
  emit?: AppDraftEmit,
): Promise<GenerateAppDraftResult | null> {
  try {
    const workspaceId = options.workspaceId ?? "";
    const authorOptions: AuthorAndValidateAppOptions = { workspaceId };
    if (options.preset) authorOptions.preset = options.preset;
    if (options.signal) authorOptions.signal = options.signal;
    if (options.onFileProgress) authorOptions.onProgress = options.onFileProgress;
    const noopEmit = (_: string) => {};
    const author = options.fileTreeAuthorFn ?? authorAndValidateAppViaLLM;
    const result = await author(prompt, authorOptions, emit ?? noopEmit);
    if (!result) return null;

    const validation = result.validation;

    if (!validation.ok && validation.source === "real") {
      console.warn(
        `[codegen] file-tree validation failed after ${result.repairAttempts} repair attempt(s): ${validation.errors.length} error(s) in ${validation.durationMs}ms`,
      );
    }

    const draft = deriveDraftFromFiles(result.files, prompt, result.summary);
    const out: GenerateAppDraftResult = {
      draft,
      source: "llm-filetree",
      files: result.files,
    };
    if (!validation.ok && validation.source === "real" && validation.errors.length > 0) {
      out.validationErrors = validation.errors.map(
        (e) => `${e.file}${e.line ? `:${e.line}` : ""}: ${e.message}`,
      );
    }
    return out;
  } catch (error) {
    console.warn(`[codegen] file-tree path failed: ${(error as Error).message}`);
    return null;
  }
}
