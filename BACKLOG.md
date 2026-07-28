# Backlog

This backlog keeps PacketAgent aimed at one thing first: **create a bounded worker, deploy it, let it keep working, and always know what it did, why it stopped, what it cost, and whether it needs a person**.

It is intentionally not a phase list. Items are grouped by product outcome so we can ship useful vertical slices.

## PacketAgent autonomous-worker flagship

These loops supersede the old builder-first priority order. Existing builder, agent, scheduler, webhook, tool, approval, vault, storage, and operations code should be reused rather than replaced.

### PA0 - Brand and repository foundation

Status: foundation complete on `codex/packetagent-foundation`; inherited quality debt remains tracked below.

- [x] Clone TaskLoom history into an independent `PacketAgent` working directory without altering the source checkout.
- [x] Rename product, package, environment, storage, UI, Docker, documentation, and source identifiers.
- [x] Preserve `TASKLOOM_*` environment values and legacy default data files through a one-way compatibility layer.
- [x] Carry the only uncommitted TaskLoom worktree fix into the new branch.
- [x] Refresh every Markdown document, label historical plans, and add an authoritative Codex project handoff.
- [x] Pass typecheck, lint with zero errors, production web build, API tests, web tests, migration tests, diff check, and compatibility-only brand scan.
- [ ] Close the inherited repo-wide Prettier baseline. `npm run format:check` currently flags 367 files; files authored in this foundation pass are formatted.
- [ ] Reduce the inherited ESLint baseline of 146 warnings while preserving the current zero-error gate.
- [ ] Review and remediate dependency advisories deliberately. The full install reports 11 advisories (including 2 critical development-tree advisories); `npm audit --omit=dev` reports 5 production advisories (1 low, 1 moderate, 3 high, 0 critical). Do not apply a blind force-fix that causes unrelated dependency churn.
- Gate: a clean PacketAgent checkout starts with new defaults and can read an existing default TaskLoom deployment without destructive migration.

### W1 - Canonical Worker contract

Dependencies: PA0.

- [x] Define versioned `WorkerDefinition`, `WorkerVersion`, `WorkerDeployment`, `WorkerTrigger`, `WorkerPolicy`, `WorkerRun`, and `WorkerCheckpoint` schemas.
- [x] Define lifecycle and terminal-state transition guards.
- [x] Project existing agent/workflow records into the new read model without breaking current APIs.
- [x] Record source provenance, including PacketADE flight, project, conversation, repository, and revision when supplied.
- Gate: passed 2026-07-27. Schema tests reject invalid state transitions, mutable deployed versions, missing bounds, and ambiguous trigger definitions.

### W2 - Worker persistence, versioning, and activation

Dependencies: W1.

- [ ] Add repository support for JSON, SQLite, and managed Postgres modes.
- [ ] Make deployed Worker versions immutable and addressable.
- [ ] Implement draft, validate, deploy, activate, pause, resume, retire, and rollback operations.
- [ ] Add activation idempotency and optimistic concurrency.
- Gate: backend parity tests prove the same lifecycle and conflict behavior in every supported store.

### W3 - Trigger and activation envelope

Dependencies: W1, W2.

- [ ] Normalize manual, cron, webhook, alert, and queue inputs into one activation envelope.
- [ ] Preserve trigger identity, delivery identity, timestamp, actor, payload reference, and trace context.
- [ ] Deduplicate repeated deliveries without dropping legitimate repeats.
- [ ] Route current scheduler and webhook entry points through the envelope.
- Gate: replay and concurrency tests prove a delivery starts at most one Worker run.

### W4 - Bounded autonomous supervisor

Dependencies: W1-W3.

- [ ] Wrap the current tool-using agent loop in plan, act, evaluate, checkpoint, and decide phases.
- [ ] Enforce elapsed-time, iteration, provider-cost, failure, and tool-call budgets.
- [ ] Require an exit predicate and explicit terminal reason.
- [ ] Support cancellation and lease loss at every phase.
- Gate: adversarial tests cannot produce an unbounded loop or a run that outlives cancellation, lease expiry, or budget exhaustion.

### W5 - Checkpoint, recovery, and side-effect safety

Dependencies: W4.

- [ ] Persist phase cursor, working memory, completed actions, artifacts, pending approvals, and remaining budgets.
- [ ] Resume interrupted runs after process restart.
- [ ] Add idempotency keys and effect receipts around mutating tools.
- [ ] Quarantine runs when safe replay cannot be proven.
- Gate: crash-injection tests resume without duplicating completed external effects.

### W6 - Permission and budget policy

Dependencies: W1, W4.

- [ ] Replace whole-tool grants with verb/resource-scoped capabilities.
- [ ] Resolve credentials by reference at execution time; never embed secret values in Worker packages.
- [ ] Add per-run and rolling cost ceilings.
- [ ] Default network, filesystem, shell, and external-write access to deny.
- Gate: runtime enforcement rejects policy bypass at every tool boundary, not only at launch.

### W7 - Attention, approval, and kill controls

Dependencies: W4-W6.

- [ ] Add pause, resume, stop, revoke, approve once, approve for run, and reject actions.
- [ ] Persist pending attention state across restarts.
- [ ] Add escalation deadlines and notification route references.
- [ ] Make kill and revoke controls available independently of the authoring UI.
- Gate: an operator can stop a running Worker and revoke future activation even if its originating Packet application is closed.

### W8 - Worker observability, cost, and evidence

Dependencies: W2-W7.

- [ ] Add one Worker health/attention summary.
- [ ] Roll provider calls, tool calls, retries, queue time, approvals, and outcome quality up by Worker version and deployment.
- [ ] Expose a chronological evidence trail and artifact manifest.
- [ ] Add retention and redaction policy for prompts, tool payloads, and outputs.
- Gate: the UI and API answer what is running, why, current budget, last checkpoint, and required attention without joining raw tables manually.

### W9 - PacketADE deployment handoff

Dependencies: W1-W7. Contract design may proceed earlier.

- [ ] Implement the WorkerPackage contract in [`dev/packetade-packetagent-handoff.md`](dev/packetade-packetagent-handoff.md).
- [ ] Add validate, deploy, update, activate, inspect, pause, and revoke endpoints.
- [ ] Verify package provenance, schema version, integrity, and idempotency.
- [ ] Return progress, approval, completion, failure, and budget events to PacketADE.
- Gate: a PacketADE task can choose **Keep running**, close PacketADE, and later reconnect to the same durable Worker deployment and evidence trail.

### W10 - PacketChat and PacketPhone routes

Dependencies: W7-W9.

- [ ] Deliver concise Worker updates into PacketChat.
- [ ] Deliver approval and kill controls to PacketPhone.
- [ ] Authenticate callback actions and prevent stale or replayed approvals.
- Gate: remote approvals preserve the same policy and audit guarantees as local approvals.

## Inherited capabilities already present

These capabilities were implemented before or during the TaskLoom foundation and are present in the PacketAgent working tree. They are recorded here so new Worker work reuses them instead of rebuilding them. This is implementation inventory, not the current priority list.

- **Full-bleed Builder.** `/builder` is now its own route outside the workbench Shell, with a chat thread, streamed prose, and a split preview. The Topbar no longer leaks into the builder.
- **Admin consolidation.** Sixteen operator surfaces (Roles, SSO, Secrets, Rate limits, Webhooks, Releases, Storage, Backups, Notifications, Operations, Integrations, Activation, Sandbox, Workflows, Billing, Alerts) live under a single tabbed `/admin/:tab` page. Back-compat redirects keep the old per-page URLs working.
- **Sidebar collapsed to four items.** Build, Projects, Runs, Admin. Removes the long secondary nav that competed with the Builder.
- **LLM wire-up via `ProviderRouter`.** Both `generateAppDraftViaLLM` and `applyAppIterationViaLLM` now route through `ProviderRouter`; iteration emits a real SSE prose stream. Template-only generation is the documented fallback when no provider is configured.
- **Six-provider BYOK at the builder.** Anthropic, OpenAI, Gemini, OpenRouter, MiniMax, and a generic local-LLM provider (Ollama / vLLM / LM Studio / llama.cpp) are first-class. Anthropic remains the default; `PACKETAGENT_PROVIDER_PRIORITY` re-orders the priority walk for every preset; the `local` preset is strict.
- **Remote-pointable local LLM.** `LOCAL_LLM_BASE_URL`, `LOCAL_LLM_API_FORMAT` (`ollama` | `openai`), and `LOCAL_LLM_MODEL` let the local provider talk to a separate GPU box on the LAN. `OLLAMA_BASE_URL` is honored as a legacy synonym.
- **Preset -> provider+model resolver with env override.** `src/providers/preset-resolver.ts` walks per-preset priority lists, respects `PACKETAGENT_PROVIDER_PRIORITY`, and surfaces the resolved provider+model on Builder UI chips. `GET /api/app/builder/providers/status` exposes the resolution snapshot for ops verification.
- **Sentence case copy.** The uppercase kicker / eyebrow pattern is gone across the workbench. Section labels are sentence case.
- **Hide raw IDs.** IDs are now behind a Details disclosure rather than rendered in primary copy.
- **Per-message revert in chat.** Each chat message in the Builder has a revert affordance back to the prior checkpoint.
- **Click-to-edit default-on.** No mode toggle - text in the Builder is editable by default.
- **CI / CD vocabulary softened.** "Deploy" / "pipeline" jargon swapped for plain terms where it leaked.
- **Builder empty state redesigned.** Direction A composer + four starter chips, matching the twin.so / Lovable shape.
- **App-preview header replaced.** Minimal header in the preview pane instead of the workbench Topbar.
- **Fork B positioning docs.** `CLOUD.md` inventories hosted-only capabilities; `docs/SELF_HOST.md` is the canonical setup guide; README reframed as self-host first.
- **Generated app generator quality.** New deterministic generated apps now use the PacketAgent per-app SQLite runtime API instead of sql.js; the API is served by supervised per-app Node workers kept warm in an LRU pool. Continue improving realistic seed data, typed form controls, and generated UI polish.
- **OSS launch basics.** MIT license, security policy, `.env.example`, Dockerfile, Docker Compose starter, production startup hardening.
- **File-tree codegen orchestrator.** Plan-then-write loop drives the LLM through `write_file(path, content)` tool calls; lives in `src/codegen/llm-author.ts` with system prompts in `src/codegen/prompts.ts`.
- **File-tree codegen as the default path.** Runs by default when a BYOK provider key is configured; opt-out via `PACKETAGENT_LEGACY_TEMPLATES=1`. The previous `PACKETAGENT_FILETREE_CODEGEN=1` opt-in flag is preserved as a no-op.
- **Hardened path validator.** Windows-aware checks (NTFS ADS, reserved device names, UNC paths, trailing dots, case collision) in `src/codegen/path-validator.ts`. 10 rules, 25 tests.
- **`AppDraft` projection over a file tree.** `src/codegen/derived-draft.ts` reads `package.json`, `src/pages/*`, `src/api/*`, and `src/data/*` / `src/schema/*` so the Files tab, Smoke tab, and publish flow keep working unchanged.
- **File-tree iteration parity.** `src/app-iteration-service.ts` re-runs the orchestrator on an iteration-shaped prompt for file-tree drafts and diffs the new tree against the prior one. Falls back to the regex pipeline for legacy-template drafts.
- **Chunked planning for large apps.** Plans with more than 10 files are batched across multiple LLM rounds (chunks of up to 8 files each) with early-stop when a chunk returns nothing.
- **Vite-build validation alongside tsc.** `src/codegen/validate.ts` runs `tsc --noEmit` and then `vite build`; diagnostics are tagged with `phase: "typecheck" | "build"`. Both phases are gated on `PACKETAGENT_SANDBOX_SMOKE_ENABLED=1`.
- **Inline error UX in the Builder chat thread.** Validation errors from the file-tree path render inline as a warn-toned card with a "Fix these errors" button that triggers an iteration using the errors as the prompt.
- **Agent tool catalog adapters.** Six runtime tools are registered: `http_fetch`, `slack_post_webhook`, `github_api`, `email_send`, `sql_query`, and `shell_for_agent`, each with deterministic unit coverage and agent-builder recommendation hooks.
- **Agent tool launch approval UX.** Tool-enabled manual agent runs now return a signed, expiring capability approval request before execution. The agent editor shows Launch / Edit tools / Cancel, Launch replays the run with the approved tool set, and the backend verifies the token against workspace, agent, trigger, inputs, and registered tools.
- **Agent/playbook builder parity.** `/builder` now routes app and agent intents separately; agent mode opens the agent builder instead of starting app generation. Generated agent drafts include readiness, typed inputs, schedules/webhook guidance, playbook steps, and optional preview runs.
- **Run trace inspector.** Agent run detail now returns derived trace spans from run metadata, inputs, transcript, tool calls, logs, output, error, model, and cost. The run detail view renders the trace timeline with legacy fallbacks plus retry/cancel/diagnose actions.
- **Playbook authoring polish.** The agent editor validates playbook steps, trims saved instructions, improves reorder/remove controls, and requires a review step before replacing a playbook from a prior run.

## Inherited lower-priority backlog

These items are not yet done, but W1-W10 take precedence unless one directly blocks the autonomous-worker runtime. The old Phase 3 labels survive only in the archived [`docs/PHASE3_SCOPE.md`](docs/PHASE3_SCOPE.md).

### Provider policy

The router, preset resolver, and six adapters are present. What remains:

- Per-provider policy layer: local providers default to single-file tool calls + multi-turn iteration; hosted providers default to multi-file per turn.
- XGrammar / structured-decoding support when the provider is vLLM; best-effort JSON parsing fallback elsewhere.
- One-shot retry-with-correction loop for malformed tool_use input.
- Vault-storage support for Gemini and OpenRouter keys (today they are env-only; see the `VAULT_PROVIDERS` guard in `src/providers/bootstrap.ts`).

### File-tree codegen

The orchestrator, default-on flip, path validator, derived-draft projection, iteration parity, chunked planning, Vite-build validation, bounded repair, and inline error UX are present. What remains:

- Broaden the multi-round auto-fix loop with more targeted repair prompts once real-world generated apps expose common failure clusters. A bounded repair loop now runs automatically before surfacing errors.
- Iteration on legacy-template drafts (drafts where `source === "template"` or `source === "llm"`) still uses the regex pipeline. Only file-tree drafts get the new iteration path.
- Streaming per-file progress in the Files tab as the tree lands. Today the Files tab updates after the write phase finishes rather than file-by-file.

### Generated-app persistence and runtime

- Shipped: generated app templates emit same-origin `fetch('/api/...')` calls, the server owns a per-app `node:sqlite` file with `__schema_version`, schema changes drop and reseed app data, and each app runtime is isolated in a Node child process started on first request and kept warm with an LRU pool.
- Remaining: add runtime health/metrics surfaces, document `PACKETAGENT_GENERATED_APP_RUNTIME_MAX_PROCESSES`, and carry the separate-origin preview/CSRF hardening item from the security backlog.

### Existing agent path

- Shipped: six new tools are registered in the default runtime catalog (`http_fetch`, `slack_post_webhook`, `github_api`, `email_send`, `sql_query`, and `shell_for_agent`), manual tool-enabled runs now have the first-call Launch / Edit tools / Cancel approval flow, `/builder` separates app and agent intent, and run detail exposes a trace inspector.
- Remaining hardening: resource-scoped runtime enforcement per tool call, live SMTP adapter wiring, LLM-authored agent-template generation beyond the current heuristic draft builder, and broader end-to-end agent happy-path tests.

### Sandbox and execution farm

- Wire `src/codegen/validate.ts` to invoke the existing sandbox service for real `tsc --noEmit` + `vite build` against the generated tree.
- Remove synthetic smoke-pass default; sandbox is the default, opt-out for environments without Docker.
- Egress allowlist enforced at the sandbox boundary, not just documented.
- Per-build CPU + memory caps so a runaway build cannot take down the farm.

### Cross-cutting security

- Drop the `node:vm` sandbox option entirely. For users without Docker, add a Deno-subprocess sandbox with `--allow-fs-read/write=<workspace>` + `--allow-net=<allowlist>`.
- `process.env` scrubbing on every spawned process (sandbox build, per-app runtime, agent tool execution).
- Network egress deny-by-default + SSRF blocklist (`169.254.169.254`, RFC1918, loopback, IPv6 link-local) + DNS pinning at allowlist-check time.
- Same-origin CSRF fix for generated app preview: serve preview on a different port (or strict CSP) so LLM-authored `fetch('/api/internal-admin')` calls do not carry the user's PacketAgent session cookie.
- Typed agent capabilities per resource (`http.fetch:GET:api.github.com`, `fs.write:/workspace/agent-id/`) instead of per-tool global; runtime enforcer wraps every tool call.

### MVP reliability (continuing)

- Add a smoke-test transcript per generated app checkpoint: what ran, what passed, what failed, and how to rerun it.
- Tighten generated app empty/error/loading states so CRUD output feels deliberate, not template-ish.
- Add a focused end-to-end happy path: sign in, build app, approve, preview, iterate, publish handoff.
- Add a focused agent happy path: sign in, build agent, approve, run once with configured provider/tools, inspect result.

### Builder depth (continuing)

- Add file-level review UI for generated source files, with changed/unchanged/new/deleted grouping.
- Let users regenerate a single route, entity, or component instead of rerunning the whole app draft.
- Add export/download of the generated app workspace as a zip or git-ready folder.
- Add optional package-install planning for generated apps while keeping execution sandboxed.

### Agent depth (continuing)

- Improve provider readiness: show which provider, model, key, and tool permissions are required before first run.
- Add first-run evaluation: expected input, actual output, tool calls, and pass/fail notes.
- Add agent memory / input schema examples that users can edit from the Builder.
- Add agent import/export so templates and generated agents can move between installs.

### Self-host publish

- Turn publish handoff into a clearer "run this generated app" path for local Docker Compose.
- Add generated app health endpoint and static asset manifest validation.
- Add signed or checksum-based artifact manifest verification for exported bundles.
- Document reverse-proxy examples for local network / VPN deployment.
- Add a minimal "public URL configured" check that verifies the configured URL actually reaches the published app.

### Quality bar

- Search for placeholders, demo-only text, fake success language, and vague "coming soon" states before every release.
- Keep `npm run typecheck`, `npm test`, `npm run build:web`, and `npm audit --omit=dev` green.
- Add regression tests for generated workspace path traversal, preview route serving, publish artifact validation, and rollback.
- Add browser-level screenshots for Builder app mode and agent mode once a stable local browser test path exists.
- Keep generated artifacts out of git and document cleanup / reset commands.

## Later, not MVP

> Hosted-only capabilities (managed deploy with free public subdomain, hosted browser-agent farm, one-click App Store / Play submission, hosted OAuth proxy with pre-wired connectors, cross-tenant user memory, shareable / remixable conversation URLs, managed credit meter) are intentionally out of scope for self-host. See [CLOUD.md](CLOUD.md) for the inventory and what a hypothetical PacketAgent Cloud product would need to ship them.

- Collaborative multiplayer editing.
- Hosted cloud deployment managed by PacketAgent.
- Full browser IDE with arbitrary repo editing.
- Marketplace templates and shared plugins.
- Multi-region active-active runtime.
- Distributed SQLite or custom database replication.
- Visual click-to-edit with direct DOM edits that bypass the LLM (Replit Element Editor pattern) - possible Phase 4.
- Conversation forking / shareable build URLs - overhyped per the 2026-norms review; skipped.

## Portfolio audit backlog - 2026-07-17

_Findings from a 2026-07-17 code audit, preserved for later._

### Later / deferred

- **[med/M]** server.ts:436 /data/artifacts/\* is not tenant-scoped: when serving is enabled, any reachable caller can read any workspace's artifacts
  - Fix: In the `/data/artifacts/*` middleware in src/server.ts (~L430-440), before serveStatic require a valid session/preview token and resolve the on-disk path against the requesting workspace's artifact subdir (scope root to ./data/artifacts/<workspaceId>), rejecting cross-workspace reads. Route is default-OFF (artifactServingEnabled()), so only bites multi-user deploys that opt in.
- **[low/L]** tsc+vite-build validation and multi-round auto-repair are gated behind PACKETAGENT_SANDBOX_SMOKE_ENABLED=1 (default off), so smoke/validation returns a synthetic 'pass' by default
  - Fix: Confirmed at src/app-routes/builder-core.ts:3041 (returns synthetic when flag!=1) and src/codegen/validate.ts:97 (SMOKE_ENV_VAR gate). Deliberate opt-in pending a provisioned sandbox driver; blockers already surface the fallback. To close: provision/wire a default sandbox driver so real smoke runs without the flag. Intended behavior, not a defect.
- **[low/M]** email_send has no default SMTP transport: returns 'SMTP adapter is not configured' unless an adapterFactory is injected
  - Fix: src/tools/email-sql.ts:165 returns config error when options.adapterFactory is absent; SMTP*\* env parsing exists but no default transport. To close, add a default nodemailer-backed adapterFactory built from parsed SMTP*\* config. Deliberate BYO-adapter DI design; email just doesn't work out-of-box.
- **[low/L]** Tool approval tokens are whole-tool-scoped; resource/verb-scoped approvals (e.g. http.fetch:GET:api.github.com) not supported
  - Fix: src/tools/approval.ts keys tokens purely by uniqueSortedToolNames (L131,190,283) - no resource/verb dimension. Current coarse approval is safe, just not granular. Closing requires designing resource-scoped token keys + matching call-site enforcement. Disclosed future work.
- **[med/L]** Generated-app previews are not origin-isolated: preview served same-origin, so CSRF/separate-origin hardening for previews remains open
  - Fix: Same-origin CSRF is solid (src/route-security.ts: origin-host check + token). Gap is defense-in-depth: serve generated-app previews from a distinct origin/subdomain so preview JS can't reach the main app's session cookies. Real architectural work (separate serving origin + cookie scoping). Disclosed roadmap item.
