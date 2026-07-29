// Barrel + orchestration for the app-builder draft pipeline.
//
// The cohesive pieces of this module now live under `src/app-builder/`:
//   - `app-builder/types.ts`            — the shared AppDraft type surface.
//   - `app-builder/template-data.ts`    — deterministic template + integration data tables.
//   - `app-builder/template-draft.ts`   — the deterministic template generation path.
//   - `app-builder/llm-draft.ts`        — the structured `submit_app_draft` tool-call path.
//   - `app-builder/filetree-draft.ts`   — the Track B file-tree codegen path.
//   - `app-builder/source-artifacts.ts` — the generated-app source artifact renderers.
//   - `app-builder/draft-helpers.ts`    — shared draft factory / clone / derive helpers.
//   - `app-builder/text-helpers.ts`     — shared pure string helpers.
//
// This file re-exports the public surface unchanged and keeps the high-level
// orchestrator (`generateAppDraftWithLLM`) that wires the three paths together.

export type {
  AppDraftTemplateId,
  RouteAccess,
  AppDraft,
  Phase71IntegrationId,
  Phase71IntegrationDraft,
  Phase71IntegrationMetadata,
  PageDraft,
  ComponentDraft,
  ApiRouteStub,
  DataSchemaDraft,
  EntitySchemaDraft,
  FieldSchemaDraft,
  SeedRecord,
  CrudFlowDraft,
  AuthDraft,
  GeneratedAppSourceFileKind,
  GeneratedAppSourceFile,
  GeneratedAppSourceArtifactBundle,
} from "./app-builder/types.js";

export {
  generateAppDraftFromPrompt,
  listAppDraftTemplateIds,
  detectPhase71Integrations,
} from "./app-builder/template-draft.js";

export { modelForPreset, generateAppDraftViaLLM } from "./app-builder/llm-draft.js";
export type {
  AppDraftLLMPreset,
  AppDraftLLMOptions,
  AppDraftEmit,
  GenerateAppDraftResult,
} from "./app-builder/llm-draft.js";

export { generateAppSourceArtifactBundle } from "./app-builder/source-artifacts.js";

import type {
  AppDraftEmit,
  AppDraftLLMOptions,
  GenerateAppDraftResult,
} from "./app-builder/llm-draft.js";
import { generateAppDraftViaLLM } from "./app-builder/llm-draft.js";
import { generateAppDraftFromPrompt } from "./app-builder/template-draft.js";
import { tryFileTreeCodegen } from "./app-builder/filetree-draft.js";

// ---------------------------------------------------------------------------
// LLM-backed draft generation (Fork B: self-host, bring-your-own Anthropic key)
// ---------------------------------------------------------------------------
//
// generateAppDraftWithLLM is the orchestrator the streaming HTTP route calls.
// It tries the Anthropic-backed path first, then falls back to the synchronous
// template generator (generateAppDraftFromPrompt) so keyless installs still
// work. `emit` receives prose narration tokens while the model is thinking,
// which is what the chat UI streams into the bubble.
//
// generateAppDraftFromPrompt remains untouched in signature and behavior so
// the deterministic template path and its tests keep working.

/**
 * High-level entry point used by the streaming route: prefer the LLM path,
 * but always return a valid AppDraft by falling back to the deterministic
 * template generator when no key is configured or the LLM call fails.
 *
 * Track B file-tree codegen is now the **default** path: when a BYOK key is
 * present we try the file-tree orchestrator first. When it returns null
 * (BYOK provider not configured, model declined the task, etc.) we fall
 * through to the existing structured-tool path so keyless installs keep
 * working exactly as before.
 *
 * Env vars:
 *  - `PACKETAGENT_LEGACY_TEMPLATES=1` is the opt-out / kill switch. When set,
 *    the file-tree path is skipped entirely and behaviour is identical to
 *    the pre-Track-B version (structured-tool → template).
 *  - `PACKETAGENT_FILETREE_CODEGEN=1` is preserved as a documented **no-op**
 *    for backward compatibility with installs that still set it. It used
 *    to be the opt-in flag for the file-tree path; since that path is now
 *    on by default, the flag is harmless.
 */
export async function generateAppDraftWithLLM(
  prompt: string,
  options: AppDraftLLMOptions = {},
  emit?: AppDraftEmit,
): Promise<GenerateAppDraftResult> {
  // Default-on: try the file-tree path first unless the legacy escape
  // hatch is explicitly set. `PACKETAGENT_FILETREE_CODEGEN` is preserved as a
  // no-op for backward compatibility with installs that set it; we only
  // gate on the new `PACKETAGENT_LEGACY_TEMPLATES` opt-out.
  if (process.env.PACKETAGENT_LEGACY_TEMPLATES !== "1") {
    const filetree = await tryFileTreeCodegen(prompt, options, emit);
    if (filetree) return filetree;
    // Orchestrator returned null (no BYOK key, model declined, etc.) —
    // fall through to the structured-tool path as before.
  }
  const llm = await generateAppDraftViaLLM(prompt, options, emit);
  if (llm) return { draft: llm, source: "llm" };
  return { draft: generateAppDraftFromPrompt(prompt), source: "template" };
}
