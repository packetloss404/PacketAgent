# File-tree codegen

> **Status: implemented inherited subsystem.** File-tree codegen supports the
> secondary prompt-to-app capability. It is not an active PacketAgent product
> track; the completed Worker lifecycle and remaining decision gates are
> recorded in [`../BACKLOG.md`](../BACKLOG.md).

File-tree codegen is the default path for app generation when a BYOK
provider key is configured. The LLM authors the actual file tree via
`write_file(path, content)` tool calls; the structured `AppDraft` shape
(pages, apiRoutes, dataSchema) is computed as a derived view over that
tree. The legacy template path runs only when no key is configured or
when `PACKETAGENT_LEGACY_TEMPLATES=1` is set.

## How it works

When `generateAppDraftWithLLM` is asked to author an app, the flow is:

1. **Pick the path.** If `PACKETAGENT_LEGACY_TEMPLATES=1` is set, skip
   straight to the legacy template path. Otherwise try the file-tree
   path first.
2. **Plan then write.** `authorAppViaLLM(prompt, ...)` runs the plan
   phase, which asks the model for a file list and a one-line summary
   per file. The write phase then drives `write_file` tool calls
   against that plan. For plans of 10 files or fewer the writes happen
   in a single round; for larger plans the orchestrator batches writes
   into chunks of up to 8 files across multiple LLM rounds, with an
   early-stop when a round returns nothing.
3. **Validate.** `validateFileTree(files, ...)` runs `tsc --noEmit`
   first, then `vite build`. Diagnostics are tagged with
   `phase: "typecheck" | "build"`. When tsc fails the build step is
   skipped (typecheck errors will dominate, and the build would just
   re-report them). Both phases are required. PacketAgent runs them in a
   network-disabled Docker container using a lockfile-addressed validator
   image and read-only generated-source mount. If isolated validation cannot
   start, the result is `{ ok: false, source: "blocked" }`.
4. **Project to `AppDraft`.** `deriveDraftFromFiles(files, prompt,
summary)` walks the tree (`package.json` for the app name,
   `src/pages/*` for pages, `src/api/*` for API routes,
   `src/data/*` / `src/schema/*` for the schema) and produces an
   `AppDraft` view. The Files tab, Smoke tab, and publish flow consume
   the projection; the original `files` array is returned alongside it
   for surfaces that want the raw tree.
5. **Surface errors.** When validation fails the result still carries
   the file tree and the validation errors. The Builder chat thread
   renders the errors inline as a warn-toned card with a "Fix these
   errors" button; the user can click through to trigger an iteration
   with the errors as the prompt.

The result shape is:

```ts
type GenerateAppDraftResult = {
  draft: AppDraft;
  source: "llm" | "template" | "llm-filetree";
  files?: GeneratedFile[];
  validationErrors?: string[];
};
```

`source === "llm-filetree"` is the discriminator that means _the file
tree is canonical, the draft is a derived view_.

### Iteration parity

`src/app-iteration-service.ts` mirrors the same split. When the draft
being iterated on was generated via the file-tree path
(`source === "llm-filetree"`) and the file tree is available, the
iteration service re-runs `authorAppViaLLM` on an iteration-shaped
prompt that includes the prior tree as context, then diffs the new
tree against the prior one and reports added / modified / deleted
files. Legacy-template drafts (`source === "template"` or
`source === "llm"`) continue to flow through the regex iteration
pipeline.

## Environment variables

- **`PACKETAGENT_LEGACY_TEMPLATES=1`** (new) - forces the legacy template
  path, skipping the file-tree orchestrator entirely. Use this when an
  install needs the old behaviour while keeping its BYOK key
  configured.
- **`PACKETAGENT_FILETREE_CODEGEN=1`** (legacy no-op) - preserved for
  back-compat. File-tree codegen is now the default, so this flag has
  no effect; installs that already set it can leave it in place.
- **BYOK key envs** - file-tree codegen requires a configured provider
  key. Any one of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GOOGLE_API_KEY` / `GEMINI_API_KEY`, `OPENROUTER_API_KEY`,
  `MINIMAX_API_KEY`, or a configured local LLM (`LOCAL_LLM_BASE_URL`
  plus the related `LOCAL_LLM_*` envs, or `OLLAMA_BASE_URL` as the
  legacy synonym) will satisfy the gate. See the [README](../README.md)
  and [docs/SELF_HOST.md](SELF_HOST.md) for the full provider matrix.

## Current limits

- **Repair is bounded.** Real validation failures can trigger up to two
  automatic repair passes. Repeated error signatures, exhausted attempts, or
  author failure stop the loop and surface phase-tagged validation errors.
- **Docker isolation is required.** A missing Docker daemon or validator-image
  failure stops authoring as `validation-blocked`; it does not consume repair
  attempts or become a successful draft.
- **Iteration on legacy-template drafts still uses the regex
  pipeline.** Drafts where `source === "template"` or `source === "llm"`
  do not get the new file-tree iteration path. Only `"llm-filetree"`
  drafts re-run the orchestrator.
- **The derived-draft projection is a forgiving heuristic.** It walks
  the tree with a small set of conventions (`src/pages/*`,
  `src/api/*`, `src/data/*` / `src/schema/*`, `package.json` for the
  app name) and returns a minimal valid draft when those conventions
  miss. Some fields may not round-trip perfectly between the file tree
  and the projection.

## Where the pieces live

- `src/codegen/llm-author.ts` - plan-then-write orchestrator
  (`authorAppViaLLM`). Handles the chunked write loop for larger
  plans.
- `src/codegen/prompts.ts` - system + per-phase user prompts (plan,
  write, iterate).
- `src/codegen/path-validator.ts` - workspace-relative path defense
  with Windows-aware checks (NTFS ADS, reserved device names, UNC,
  trailing dots, case collision). 10 rules, 25 tests.
- `src/codegen/validate.ts` - sandboxed build validator. Runs
  `tsc --noEmit` then `vite build`; errors carry a
  `phase: "typecheck" | "build"` tag.
- `src/codegen/derived-draft.ts` - `AppDraft` projection over a file
  tree.
- `src/app-builder-service.ts` - integration site for initial drafts
  (`generateAppDraftWithLLM` -> `tryFileTreeCodegen`). Owns the default-
  on flip and the `PACKETAGENT_LEGACY_TEMPLATES` opt-out.
- `src/app-iteration-service.ts` - integration site for iteration.
  Routes file-tree drafts through the orchestrator and template-shaped
  drafts through the existing regex pipeline.
- `web/src/workbench/views/builder.tsx` (and related Builder chat
  components) - renders the inline validation-error card with the
  "Fix these errors" button.
