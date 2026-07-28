# Changelog

All notable changes to PacketAgent are tracked here.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning once releases are tagged.

## [Unreleased]

### 2026-07-27 - Bounded autonomous supervisor (W4)

- Added narrow Worker provider, tool, clock, checkpoint, event, lease, cancellation, and run ports plus adapters for the existing provider router, cost ledger, tool registry, and executor.
- Added the pure plan-act-evaluate-checkpoint-decide reducer; only it selects completed, failed, budget-exhausted, cancelled, or quarantined terminal outcomes from declared exit predicates and explicit evidence.
- Added monotonic elapsed-time, iteration, provider-cost, consecutive-failure, retry/backoff, and pre-execution tool-call enforcement around every awaited provider/tool boundary.
- Replaced `worker.run` deferral with canonical execution, optimistic run revisions, monotonic lease fencing, cursor checkpoints, lifecycle events, revocation/cancellation checks, and scheduler-shutdown release.
- Added adversarial coverage for endless tools, hung/failed providers, invalid evaluations, cost exhaustion, cancellation at every phase, ignored abort signals, lease theft, stale revisions, expired-lease takeover, and JSON/SQLite/managed-Postgres parity.

### 2026-07-27 - Trigger and activation envelope (W3)

- Added a versioned Worker activation envelope, durable deduplication inbox, and `0020_worker_activations.sql` migration across JSON, SQLite, and managed Postgres.
- Added atomic intake that validates the active deployment, enabled trigger, and Worker input schema before committing one version-pinned queued run, audit event, and execution job.
- Added encrypted, expiry-bound payload references for large or sensitive inputs; workspace exports include reference metadata without ciphertext.
- Routed manual requests, timezone-aware cron occurrences, opaque Worker webhooks, durable alerts, and queue deliveries through the common intake service while preserving legacy Agent triggers.
- Added W3C trace propagation, exact-replay receipts, changed-content delivery conflicts, JSON transaction rollback isolation, bounded scheduler deferral before W4, crash injection, and multi-backend concurrency coverage.

### 2026-07-27 - Worker persistence, versioning, and activation (W2)

- Added durable Worker definitions, versions, deployments, runs, checkpoints, rollout links, command receipts, and lifecycle events to every supported store.
- Added the forward-only `0019_worker_lifecycle.sql` migration with workspace-scoped keys, immutable version identity, deployment revisions, one-active-deployment enforcement, idempotency uniqueness, event sequencing, foreign keys, and lifecycle indexes.
- Added atomic lifecycle services and private RBAC-protected routes for definition/version creation, draft updates, validation, deployment, activation, pause/resume, retirement, and rollback to an older validated version.
- Bound idempotent replay to workspace, operation, target, actor, and canonical request content; stale digests and revisions return stable conflicts.
- Added JSON, SQLite, and managed-Postgres parity coverage for concurrent activation, rollback, reload, export, and JSON-to-SQLite backfill.

### 2026-07-27 - Canonical Worker contract (W1)

- Added versioned, storage-neutral schemas and runtime validators for `WorkerDefinition`, `WorkerVersion`, `WorkerDeployment`, `WorkerTrigger`, `WorkerPolicy`, `WorkerRun`, and `WorkerCheckpoint`.
- Added required time, iteration, provider-cost, failure, tool-call, retry, permission, trigger, exit-predicate, and provenance validation.
- Added lifecycle and terminal-state transition guards, validated/deployment-bound version immutability, deployment version pinning, and optimistic deployment revision checks.
- Added PacketADE source provenance fields for flight, project, conversation, repository, and revision.
- Added deterministic draft projections over existing Agent and workspace workflow records without changing their APIs or exposing webhook tokens.
- Added 31 focused contract tests and recorded the research, decisions, implementation loops, and W2 boundary in `dev/worker-contract-plan.md`.

### 2026-07-27 - PacketAgent foundation rename

- Created PacketAgent from the complete TaskLoom Git history while preserving the original checkout.
- Renamed product, package, environment, storage, UI, Docker, documentation, and source identifiers to PacketAgent.
- Added temporary read compatibility for legacy `TASKLOOM_*` environment values.
- Added non-destructive first-boot copying from legacy default TaskLoom JSON and SQLite files to PacketAgent defaults.
- Repositioned the existing builder, scheduler, agent runtime, tools, vault, storage, and operations platform as the foundation for a bounded autonomous-worker runtime.
- Added the Worker implementation loops and the planned PacketADE-to-PacketAgent deployment contract.
- Added an authoritative Codex project handoff with repository state, verified gates, implementation truth, and the initial W1 resume point.
- Marked the former Phase 3, playbook sprint, handoff, and repository-review documents as historical so they cannot override the current roadmap.
- Corrected active setup and product documentation to reflect the shipped bounded code-repair loop, per-app SQLite runtime, outbound agent tools, missing PacketAgent remote, and unimplemented durable Worker lifecycle.

### 2026-05-17 - File-tree codegen filled out: iteration parity, chunked planning, vite-build validation, inline error UX, default-on

This entry covers the second round of Track B work. The opt-in skeleton from the previous round is filled out: file-tree codegen now runs by default when a BYOK provider key is configured, iteration mirrors the new path, plans for larger apps are batched across multiple write rounds, the validator runs a real `vite build` alongside `tsc`, and validation errors surface inline in the Builder chat thread.

#### Track B round 2

- **Default path flipped.** File-tree codegen now runs by default when a BYOK provider key is present. No env flag required. The structured-tool / template path remains the fallback when no key is configured or the orchestrator returns null.
- **New opt-out `PACKETAGENT_LEGACY_TEMPLATES=1`.** Forces the legacy template path, skipping the file-tree codegen orchestrator entirely. The previous opt-in flag `PACKETAGENT_FILETREE_CODEGEN=1` is preserved as a no-op for installs that already set it.
- **Iteration parity.** `src/app-iteration-service.ts` gained a file-tree iteration path. When the draft being iterated on was generated via the file-tree path (`source === "llm-filetree"`) and the file tree is available, iteration re-runs the orchestrator on an iteration-shaped prompt and computes a diff (added / modified / deleted) against the prior tree. Falls back to the regex iteration pipeline when the draft is template-shaped.
- **Chunked planning for large apps.** When the plan has more than 10 files, the orchestrator now batches `write_file` calls across multiple LLM rounds (chunks of up to 8 files each), with an early-stop when a chunk returns nothing. Small plans (10 files or fewer) keep the existing single-write-phase behaviour.
- **Vite-build validation.** The validator now runs `vite build` after `tsc --noEmit`, with phase-tagged errors (`phase: "typecheck" | "build"`). When tsc fails, the build step is skipped. Both phases are gated on the existing `PACKETAGENT_SANDBOX_SMOKE_ENABLED=1` env.
- **Inline error UX.** When the file-tree path returns validation errors, the Builder chat thread now renders them inline as a warn-toned card with a "Fix these errors" button. The button triggers an iteration with the errors as the prompt.

#### Known gaps

- Multi-round auto-fix on broken TypeScript is not implemented. The validator runs once; errors surface to the user; iteration is the user's choice via the new "Fix these errors" button.
- Iteration on legacy-template drafts still uses the regex pipeline - only file-tree drafts use the new iteration path.
- The new vite-build step is still gated on `PACKETAGENT_SANDBOX_SMOKE_ENABLED=1`; with the gate off, the validator returns a skipped result.

### 2026-05-17 - Six-provider BYOK, remote-pointable local LLM, cleanup

This entry covers the two rounds of provider work that landed after the builder-first refactor: the builder draft + iteration paths are now fully routed through `ProviderRouter` and accept six providers, and the local-LLM provider became remote-pointable so a separate GPU box can serve the workbench laptop.

#### Providers

- **Gemini adapter** (`src/providers/gemini.ts`). Speaks Google's OpenAI-compatible endpoint. Registered only when `GOOGLE_API_KEY` or `GEMINI_API_KEY` is set. Preset picks: `gemini-2.5-flash` (fast / cheap), `gemini-2.5-pro` (smart).
- **OpenRouter adapter** (`src/providers/openrouter.ts`). Marketplace access to Anthropic / Google / Mistral / DeepSeek / etc. via a single OpenAI-compatible endpoint. Registered only when `OPENROUTER_API_KEY` is set. First on the default `cheap` priority walk.
- **`ProviderRouter` now routes all six providers** for both builder and agent paths: Anthropic, OpenAI, Gemini, OpenRouter, MiniMax, and the generic local-LLM provider. `generateAppDraftViaLLM` and `applyAppIterationViaLLM` no longer hard-code `AnthropicProvider`.
- **Preset resolver** (`src/providers/preset-resolver.ts`). Maps the four Builder presets (`fast`, `smart`, `cheap`, `local`) to a concrete `(provider, model)` pair via a per-preset priority walk. The `local` preset is strict: only routes to local providers, or returns null.
- **`PACKETAGENT_PROVIDER_PRIORITY` env override**. Comma-separated provider list replaces the default walk for every non-`local` preset (e.g. `PACKETAGENT_PROVIDER_PRIORITY=ollama,openrouter,anthropic`). First registered provider with a configured key wins.
- **Builder UI surfaces the resolved provider+model** on each preset chip, so operators can see which key actually drives `fast` vs `smart` vs `cheap` without poking at the server.
- **New endpoint `GET /api/app/builder/providers/status`**. Returns the resolved preset map, the list of providers with credentials, and the active priority override string. Used by the chip UI and useful for ops verification. No secrets in the response.

#### Local LLM

- **Remote-pointable**. The local-LLM provider can now talk to any OpenAI-compatible (or Ollama-native) endpoint on `localhost` or on a separate machine on your LAN - vLLM, LM Studio, llama.cpp's OpenAI-compat server, or remote Ollama. Local is **not** the default for hosted presets; Anthropic stays the default unless you pick `local` or set the priority override.
- **New env var `LOCAL_LLM_BASE_URL`**. Takes precedence over `OLLAMA_BASE_URL`. Documents intent for non-Ollama servers.
- **New env var `LOCAL_LLM_API_FORMAT`** (`ollama` | `openai`, default `ollama`). Switches between native Ollama `/api/chat` and OpenAI-compatible `/v1/chat/completions`. Set to `openai` for vLLM, LM Studio, and llama.cpp.
- **New env var `LOCAL_LLM_MODEL`**. Overrides the per-call model name; required for vLLM / llama.cpp setups where the server only loads one specific model and matches names strictly.
- **`OLLAMA_BASE_URL`** is honored as a legacy synonym when `LOCAL_LLM_BASE_URL` is unset.

#### Cleanup

- Workflows sub-tabs distinguished from the AdminPage outer tabs - fixes a UI collision where the Workflows admin pane's internal tabs were being styled by the same active-state rules as the top-level Admin nav.
- Windows-incompatible sandbox test cleanly skipped (rather than failing the suite) on platforms without a POSIX shell.
- Dead code removed from `builder.tsx` - the unused `ChatBubble` component and its imports.
- `tmp/` Playwright artifacts no longer tracked; added to `.gitignore`.

#### Docs

- README reframed: opener and "How it compares" now describe six-provider BYOK and remote-pointable local LLM. "Known limits" no longer says the builder is Anthropic-only - that gap is closed.
- `docs/SELF_HOST.md` gained per-provider subsections for all six providers, five concrete local-LLM recipes (Ollama / remote Ollama / vLLM / LM Studio / llama.cpp), a "Provider precedence and override" section explaining `PACKETAGENT_PROVIDER_PRIORITY`, and a `curl` example for `/api/app/builder/providers/status`.
- `BACKLOG.md` moved Gemini, OpenRouter, remote-pointable local LLM, and the preset -> provider+model resolver from "Still planned" into "Done in this pass".

### 2026-05-17 - Builder-first refactor, admin consolidation, LLM wire-up

This entry covers the work that landed since the prior changelog snapshot: the workbench was reshaped around a full-bleed Builder, the operator surfaces collapsed under a single Admin tab, the Builder draft + iteration paths got their first real LLM wire-up (Anthropic), and the Fork B (self-host first) positioning was made explicit in the docs.

#### Builder UX

- `/builder` lifted out of the workbench Shell into its own full-bleed route with a dedicated `BuilderLayout`. Topbar no longer leaks into the builder.
- Builder empty state redesigned: Direction A composer + four starter chips, matching the twin.so / Lovable shape.
- Chat thread + per-turn streaming prose, with click-to-edit default-on and per-message revert back to the prior checkpoint.
- App-preview view replaced the workbench Topbar with a minimal header.
- Sentence case copy across the workbench; the uppercase kicker / eyebrow pattern is gone. Raw IDs hidden behind a Details disclosure. Softened CI / CD vocabulary where it leaked into user-facing copy.

#### Admin consolidation + sidebar

- New `/admin/:tab` page consolidates sixteen previously top-level operator surfaces: Roles, SSO, Secrets, Rate limits, Webhooks, Releases, Storage, Backups, Notifications, Operations, Integrations, Activation, Sandbox, Workflows, Billing, Alerts.
- All sixteen views had their page-level chrome stripped so they render correctly inside the tabbed Admin container.
- Back-compat redirects from the sixteen individual admin paths to `/admin/:tab` so existing bookmarks and links keep working.
- Sidebar collapsed from a long secondary nav to four items: Build, Projects, Runs, Admin.

#### LLM wire-up (Anthropic, Fork B)

- `generateAppDraftViaLLM` now calls `AnthropicProvider` for the initial app draft. Falls back to deterministic template-only generation when no key is set - documented explicitly, not silent.
- `applyAppIterationViaLLM` calls `AnthropicProvider` for scoped iteration and emits a real LLM prose stream over SSE, not a synthetic placeholder.
- Multi-provider routing for the builder draft + iteration paths is _not_ yet wired through `ProviderRouter` - only Anthropic is supported today at the builder. Agent runs continue to route through the full provider router (Anthropic / OpenAI / MiniMax / Ollama).

#### Generated apps

- sql.js persistence in generated apps with realistic seed data, typed form controls, and the PacketAgent eyebrow removed. **Known issue**: sql.js loads from a jsdelivr CDN, so generated apps phone home on first load. Per-app server-side SQLite is scoped under Phase 3 Track C.

#### Fork B positioning + docs

- Added `CLOUD.md`: a deferred-features inventory of hosted-only capabilities (free public subdomains, hosted browser-agent farm, App Store submission, hosted OAuth proxy, cross-tenant memory, shareable conversation URLs, vendor-managed credit meter) and what a hypothetical PacketAgent Cloud product would need to ship them.
- Reworked `docs/SELF_HOST.md` as the canonical setup guide: prerequisites, 5-minute quick start, BYO-LLM-key configuration, deploy-your-generated-app section, troubleshooting.
- Added `docs/PHASE3_SCOPE.md` v2 scoping the next chunk: multi-provider BYOK, file-tree codegen, real per-app runtime, six new agent tools, sandbox + farm work, and cross-cutting security hardening. 29-39 focused days, 6-9 calendar weeks for a solo engineer at ~60% focused time.
- README reframed to lead with the Fork B story: self-host first, multi-provider BYOK as the aim, honest about today's Anthropic-only builder and the sql.js CDN.
- Fixed five Fork B blockers caught in peer review (positioning + doc drift); Phase 1 UX debt cleanup (back chevron, kicker leftover, dead code, name dedup); leftover stash conflict marker fix.

### Earlier work (carried forward to this release)

#### Added

- Builder-first generated app runtime: prompt-to-app writes a real React/Vite source workspace to `data/generated-apps/<workspace>/<app>/workspace`.
- Generated app preview route at `/api/app/generated-apps/:appId/preview`, including nested source and asset serving from the generated workspace.
- Generated source manifest with file hashes, byte counts, workspace path, app slug, checkpoint ID, and source file summaries.
- Source-diff iteration flow that compares previous and candidate generated files before applying scoped app changes.
- Rollback support that restores checkpoint source artifacts instead of regenerating unrelated source metadata.
- Local publish handoff that materializes generated bundles, runtime config, artifact manifests, and PacketAgent-served preview URLs.
- Builder UI support for generated source file summaries, workspace metadata, publish handoff copy, and clearer preview status.
- OSS launch basics: MIT license, security policy, `.env.example`, Dockerfile, and Docker Compose starter.
- Production startup hardening for security-sensitive settings and clearer local/development defaults.

#### Changed

- Builder copy now distinguishes saved local previews from public deployments.
- Generated runtime output and publish exports are ignored by git to keep local build artifacts out of commits.

#### Fixed

- Provider/tool readiness now fails loudly for missing required setup instead of implying a real run happened.
- Agent dry-run paths are labelled explicitly.
- Publish validation now blocks missing generated bundle/workspace artifacts.
- Generated preview routes resolve actual app IDs, slugs, checkpoints, and nested files instead of relying on placeholder preview paths.

## [0.1.0] - In development

Initial public development line for the PacketAgent self-hosted app and agent workbench.

### Included

- Prompt-to-agent and prompt-to-app builder flows.
- App drafts, checkpoints, scoped iteration, local preview, smoke checks, and publish handoff.
- Agent templates, runs, transcripts, tool-call timeline, jobs, schedules, webhooks, secrets, audit, RBAC, and sandbox surfaces.
- JSON store for contributor flow, SQLite for single-node installs, and managed Postgres support behind explicit startup gates.
- React workbench, Hono API, and Node 22 runtime.
