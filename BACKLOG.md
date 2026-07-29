# Backlog

This backlog keeps PacketAgent aimed at one thing first: **create a bounded worker, deploy it, let it keep working, and always know what it did, why it stopped, what it cost, and whether it needs a person**.

It is intentionally not a phase list. Items are grouped by product outcome so we can ship useful vertical slices.

This file is the single implementation ledger for all remaining work.
Dependency rationale, repository seams, verification mechanics, and
historical-plan reconciliation are supporting context in
[`dev/worker-implementation-loops.md`](dev/worker-implementation-loops.md);
that document must not introduce active work absent from this backlog. After a
gate passes, continue with the next dependency-ready unchecked loop here.
"Later, not MVP" remains decision-gated.

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
- [x] Close the inherited repo-wide Prettier baseline. All 326 inherited files were formatted in reviewable R1 batches, and `npm run format:check` is clean.
- [x] Reduce the inherited ESLint baseline of 145 warnings to zero while preserving the zero-error gate.
- [x] Review and remediate dependency advisories deliberately. Targeted non-major upgrades reduced the full and production audits from 11/5 findings to two package entries for one unreachable React Router RSC advisory; [`dev/r1-dependency-advisory-audit.md`](dev/r1-dependency-advisory-audit.md) records ownership, reachability, and the exact-pin decision. No forced fix was used.
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

- [x] Add repository support for JSON, SQLite, and managed Postgres modes.
- [x] Make deployed Worker versions immutable and addressable.
- [x] Implement draft, validate, deploy, activate, pause, resume, retire, and rollback operations.
- [x] Add activation idempotency and optimistic concurrency.
- Gate: passed 2026-07-27. One shared lifecycle scenario proves replay, stale-write conflicts, two-writer activation, rollback replacement, process reload, and export behavior across JSON, SQLite, and managed Postgres.

### W3 - Trigger and activation envelope

Dependencies: W1, W2.

- [x] Normalize manual, cron, webhook, alert, and queue inputs into one activation envelope.
- [x] Preserve trigger identity, delivery identity, timestamp, actor, payload reference, and trace context.
- [x] Deduplicate repeated deliveries without dropping legitimate repeats.
- [x] Route current scheduler and webhook entry points through the envelope.
- Gate: passed 2026-07-27. Crash injection and concurrent two-repository replay prove one delivery commits one version-pinned queued run and execution job across JSON, SQLite, and managed Postgres; changed-content key reuse conflicts, while distinct delivery IDs remain distinct occurrences.

### W4 - Bounded autonomous supervisor

Dependencies: W1-W3.

- [x] Wrap the current tool-using agent loop in plan, act, evaluate, checkpoint, and decide phases.
- [x] Enforce elapsed-time, iteration, provider-cost, failure, and tool-call budgets.
- [x] Require an exit predicate and explicit terminal reason.
- [x] Support cancellation and lease loss at every phase.
- Gate: passed 2026-07-27. Scripted endless tools, hung providers, provider failures, invalid evaluations, exact-cost exhaustion, operator cancellation at every phase, abort during an ignored provider signal, lease theft, stale revisions, and expired-lease takeover all terminate within finite provider/tool-call bounds. Runtime transitions and cursor checkpoints retain JSON, SQLite, and managed-Postgres parity.

### W5 - Checkpoint, recovery, and side-effect safety

Dependencies: W4.

- [x] Persist phase cursor, working memory, completed actions, artifacts, pending approvals, and remaining budgets.
- [x] Resume interrupted runs after process restart.
- [x] Add idempotency keys and effect receipts around mutating tools.
- [x] Quarantine runs when safe replay cannot be proven.
- Gate: passed 2026-07-27. Digest-chained full-state checkpoints, startup/periodic recovery, prepared/completed effect receipts, exact action-cursor resumption, corruption/uncertain-effect quarantine, scheduler restart coverage, and JSON/SQLite/managed-Postgres parity prove committed nonterminal work is not silently abandoned and completed mutations are not repeated.

### W6 - Permission and budget policy

Dependencies: W1, W4.

Status: complete.

W6.1-W6.5 are complete: validated versions compile normalized
tool/verb/resource tuples, deployments persist only version-bounded narrowed
grants, and every production Worker tool call is authorized again in
`executeTool` immediately before its handler. Opaque, workspace-scoped
credentials resolve only after that decision; Worker network calls pin
validated public DNS answers and deny redirects; autonomous command execution
requires the no-network Docker sandbox. Provider cost and externally billable
actions reserve workspace/deployment rolling capacity atomically before the
call, settle actual usage, and release abandoned holds after lease expiry.
Production registry entries now expose one-shot executor-guarded handlers, and
the adversarial matrix proves policy denial before credential resolution,
rolling reservation, effect preparation, or external I/O.

- [x] Replace whole-tool grants with verb/resource-scoped capabilities.
- [x] Resolve credentials by reference at execution time; never embed secret values in Worker packages.
- [x] Add per-run and rolling cost ceilings.
- [x] Default network, filesystem, shell, and external-write access to deny.
- Gate: passed 2026-07-27. Every production registry entry is covered through
  both executor and direct-access paths; direct Worker handler access and
  permit reuse fail closed. Redirects, alternate IP notation, DNS rebinding,
  linked/case-aliased host paths, hostile command arguments, credential
  mismatch, stale/tampered policy, policy-before-effect ordering, and
  concurrent rolling reservations are covered without an undeclared action or
  over-budget call.

### W7 - Attention, approval, and kill controls

Dependencies: W4-W6.

Status: complete.

- [x] Define and persist version-bound attention requests, approval grants,
      control commands, and notification delivery references with durable replay
      identities across JSON, SQLite, and managed Postgres.
- [x] Add pause, resume, stop, revoke, approve once, approve for run, and reject actions.
- [x] Persist pending attention state across restarts.
- [x] Add escalation deadlines and notification route references.
- [x] Make kill and revoke controls available independently of the authoring UI.
- Gate: passed 2026-07-27. Fresh-process approval resume and callback replay,
  both approve/reject and activation/revoke orderings, durable stop at every
  supervisor phase, and newly constructed headless operator routes leave no
  later action or runnable work. An operator can stop a run and revoke future
  activation without an authoring application.

### W8 - Worker observability, cost, and evidence

Dependencies: W2-W7.

Status: complete. Resume at
[`W10.3 - Implement PacketPhone controls`](dev/worker-implementation-loops.md#w103---implement-packetphone-controls).

- [x] Add one Worker health/attention summary.
- [x] Roll provider calls, tool calls, effects, retries, queue time, approvals,
      checkpoints, budgets, artifacts, and outcome quality up by Worker version,
      deployment, and run with deterministic replay and explained source gaps.
- [x] Expose a chronological evidence trail and artifact manifest.
- [x] Add retention and redaction policy for prompts, tool payloads, and outputs,
      including bounded workspace jobs, read-only dry runs, deletion evidence,
      and terminal-only compaction.
- Gate: passed 2026-07-28. One workspace-scoped read model answers what is
  running, why, its immutable version/deployment, current hard-budget use,
  provider cost, last checkpoint, required attention, evidence, artifacts,
  source gaps, and outcome without client-side raw-table joins. Stable
  filter-bound cursors, reconnect semantics, redaction, accessible
  loading/error/empty states, tenant isolation, source-order replay, and
  JSON/SQLite/managed-Postgres parity are covered.

### W9 - PacketADE deployment handoff

Dependencies: W1-W7. Contract design may proceed earlier.

Status: complete. Resume at
[`W10.3 - Implement PacketPhone controls`](dev/worker-implementation-loops.md#w103---implement-packetphone-controls).

- [x] Implement the WorkerPackage contract in [`dev/packetade-packetagent-handoff.md`](dev/packetade-packetagent-handoff.md).
- [x] Add validate, deploy, update, activate, inspect, list-runs, pause, resume,
      rollback, and revoke endpoints through W2/W3/W7/W8 services.
- [x] Verify package provenance, schema version, integrity, local capability
      acceptance, and idempotency behind a workspace/actor-bound PacketADE
      credential.
- [x] Return progress, approval, completion, failure, and budget events to
      PacketADE through versioned pages and bounded SSE, with stable opaque
      IDs, `Last-Event-ID`, retention-window errors, and durable idempotent
      cursor acknowledgements.
- Gate: passed 2026-07-28. A serialized PacketADE scenario exercises
  validation, deployment, activation, client disconnect, durable-store
  serialization, fresh service reconstruction, cursor/evidence reconnect,
  inspection, update, pause/resume, rollback, and revoke without changing the
  pinned run or losing evidence. The real-network validation check is present
  and remains conditionally skipped until an operator supplies an endpoint,
  workspace, and PacketADE credential.

### W10 - PacketChat and PacketPhone routes

Dependencies: W7-W9.

Status: local gate complete. Resume at
[`R1 - Repository health and historical finding re-audit`](dev/worker-implementation-loops.md#r1---repository-health-and-historical-finding-re-audit).
Live PacketChat/PacketPhone interoperability remains conditional on external
endpoints and credentials.

- [x] Add a versioned channel-neutral notification outbox with atomic
      event/evidence binding, stable idempotency, bounded retry/expiry,
      dead-letter state, opaque route references, redacted delivery metadata,
      scheduler delivery, retention pinning, and JSON/SQLite/managed-Postgres
      parity.
- [x] Deliver concise Worker updates into PacketChat through an encrypted
      route credential, pinned-network transport, stable progress replacement,
      bounded state/budget/checkpoint/evidence cards, and short-lived
      exact-binding open/inspect callbacks.
- [x] **W10.3 - PacketPhone controls:** deliver approve, reject, pause, stop,
      and revoke actions only when the PacketPhone actor and role are allowed
      by W7.
- [x] Bind each W10.3 token to action, workspace, deployment, run, attention
      request when applicable, immutable version digest, actor, audience,
      nonce, and expiry.
- [x] Consume W10.3 callbacks durably and reject stale, replayed,
      cross-workspace, cross-version, and already-resolved actions.
- [x] **W10.4 - Remote-control certification:** contract-test PacketChat and
      PacketPhone adapters against fake endpoints; race local and remote
      actions; rotate credentials; restart with pending deliveries; replay
      callbacks; and verify dead-letter recovery.
- [ ] Run live PacketChat and PacketPhone interoperability checks when those
      endpoints and credentials are available.
- Gate: passed locally 2026-07-28. Fake-endpoint adapters, both local/remote
  race orderings, credential rotation, pending-delivery restart, read-only and
  single-use callback replay semantics, and bounded audited dead-letter redrive
  preserve W7 policy, idempotency, and audit guarantees. Two bounded live
  delivery probes are registered and conditionally skipped because no external
  endpoint configuration is present.

## Post-W10 execution ledger

These are the only autonomous continuation loops after W10. The detailed
inventory later in this file supplies additional context, but completion state
is recorded in these checklists.

### R1 - Repository health and historical finding re-audit

Status: complete as of 2026-07-29.

Supporting finding-by-finding evidence is maintained in
[`dev/r1-repository-health-audit.md`](dev/r1-repository-health-audit.md).
The first persistence slice closes managed pool churn, destructive-migration
integrity/restore checks, and target-only managed-backfill preservation; the
jobs slice closes the second writer and incomplete workspace scoping; and the
backend security slice closes production-start truth, import-safe bootstrap,
rate-limit/preview-token re-audit, baseline response headers/CSP, and
workspace-authorized opt-in artifact serving. The frontend slice additionally
closes render recovery, multi-secret
redaction, corrupt-row re-audit, the historical preview iframe contract,
audited dead controls, primary keyboard semantics, and stale web branding.
The persistence authority/cutover contract is now explicit, and deliberate
dependency remediation removed every critical, moderate, and low advisory
while recording the single unreachable React Router RSC exception.

- [x] Re-audit every still-relevant historical P0/P1 finding and close stale
      findings with evidence.
- [x] Finish the Prettier baseline in reviewable batches.
- [x] Reduce inherited ESLint warnings to zero and require an explicit type on
      every native React button.
- [x] Triage dependency advisories without blind or forced upgrades.
- [x] Close verified persistence, migration, queue, managed-pool, startup,
      redaction, rate-limit, CSP/header, artifact-scope, and dead-control
      findings.
- [x] Decide and document the persistence end-state before removing any
      compatibility facade.
- Gate: passed 2026-07-29. Every historical P0/P1 finding is fixed, proven
  stale, or assigned to a named later loop; typecheck, lint, formatting,
  production build, migration recovery, 30 web tests, and the 1,525-test API
  suite are green.

### R2 - Provider policy and key parity

Status: complete as of 2026-07-29. Resume at R3.

- [x] Add per-provider generation policy and capability metadata.
- [x] Add vLLM structured decoding/XGrammar with tested fallback.
- [x] Add one bounded malformed-tool-input correction attempt.
- [x] Add Gemini and OpenRouter vault-key parity.
- [x] Consolidate provider/model catalogs and readiness reporting.
- Gate: passed 2026-07-29. Every runtime provider has one tested catalog and
  generation-policy contract; vLLM constrained decoding has one bounded
  compatibility fallback; malformed tool input can be corrected once without
  execution; and every hosted provider key can use the encrypted workspace
  vault. Typecheck, lint, formatting, production build, 30 web tests, and the
  1,552-test API suite are green.

### R3 - File-tree generation depth

Status: active.

- [ ] Add targeted bounded repair prompts from real failure clusters.
- [ ] Move legacy-template iteration to the file-tree path or a deterministic
      one-time conversion.
- [ ] Stream per-file plan/write/validate progress.
- [ ] Add file-level change review and targeted route/entity/component
      regeneration.
- [ ] Add sandboxed package planning and workspace export as zip or git-ready
      files.
- Gate: new and legacy drafts use one reviewable, repairable, exportable
  file-tree source of truth.

### R4 - Generated-app runtime and self-host publish

- [ ] Add runtime health, metrics, crash visibility, and documented pool
      limits.
- [ ] Add health endpoints, static-asset manifest validation, and
      signed/checksummed artifact manifests.
- [ ] Turn publish handoff into a verified local Docker Compose run path.
- [ ] Add reverse-proxy/VPN examples and public-URL reachability verification.
- [ ] Preserve accurate schema/data migration claims.
- Gate: an exported app can be integrity-checked, started, health-checked, and
  reached through the documented self-host path.

### R5 - Sandbox, egress, and preview isolation

- [ ] Make real sandboxed TypeScript and Vite validation the default and remove
      synthetic success.
- [ ] Define a fail-closed isolated non-Docker fallback and remove `node:vm` as
      a security boundary.
- [ ] Enforce CPU, memory, process, timeout, filesystem, environment, and
      egress limits at the sandbox boundary.
- [ ] Reuse W6 redirect, SSRF, IPv4/IPv6, and DNS-rebinding protections.
- [ ] Isolate generated previews by origin with scoped cookies, CSP, and proxy
      rules.
- [ ] Harden containers with non-root users, dropped capabilities,
      no-new-privileges, and process limits.
- Gate: untrusted generated code cannot inherit secrets or sessions, reach
  undeclared networks, or escape resource bounds.

### R6 - Agent authoring and execution depth

- [ ] Wire the default SMTP transport through vault-backed credentials.
- [ ] Add LLM-authored Worker/agent templates beyond the heuristic builder.
- [ ] Show provider/model/key/capability readiness before first run.
- [ ] Add editable memory/input examples and first-run evaluation.
- [ ] Add signed, versioned agent/Worker import and export.
- [ ] Consolidate legacy agent execution onto canonical Workers only after
      compatibility and migration tests pass.
- Gate: authored agents can be evaluated, moved between installs, and operated
  canonically without losing compatibility.

### R7 - Builder and frontend maintainability

- [ ] Split remaining oversized views and routes along established seams.
- [ ] Add shared accessible loading/error/empty boundaries and keyboard-safe
      primitives.
- [ ] Remove duplicate client fetch/format utilities after characterization.
- [ ] Make styling direction explicit and migrate incrementally.
- [ ] Add stable component/browser coverage for Builder app and Worker modes.
- Gate: critical views have accessible state handling, bounded ownership, and
  regression coverage.

### R8 - Release reliability and production packaging

- [ ] Persist smoke transcripts per generated-app checkpoint.
- [ ] Add focused app and Worker happy paths through build, approval, run,
      inspect, reconnect, publish/deploy, and stop.
- [ ] Add path-traversal, preview, artifact, rollback, backup/restore, and
      tenant-isolation regression tests.
- [ ] Decide whether production images should run built JavaScript and prove
      source-map/Playwright compatibility.
- [ ] Remove placeholder, demo-only, fake-success, and unsupported coming-soon
      claims from release surfaces.
- [ ] Keep generated artifacts out of Git and document cleanup/reset.
- Gate: release checks, production image, backup round-trip, automated paths,
  and public claims describe the same tested product.

## Inherited capabilities already present

These capabilities were implemented before or during the TaskLoom foundation and are present in the PacketAgent working tree. They are recorded here so new Worker work reuses them instead of rebuilding them. This is implementation inventory, not the current priority list.

- **Full-bleed Builder.** `/builder` is now its own route outside the workbench Shell, with a chat thread, streamed prose, and a split preview. The Topbar no longer leaks into the builder.
- **Admin consolidation.** Twelve live operator surfaces (Roles, SSO, Secrets, Rate limits, Webhooks, Notifications, Operations, Integrations, Activation, Sandbox, Workflows, Billing) live under a single tabbed `/admin/:tab` page. Back-compat redirects keep supported old per-page URLs working.
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

After W10, execute these items as R1-R8 in
[`dev/worker-implementation-loops.md`](dev/worker-implementation-loops.md#r1-r8---inherited-continuation-after-w10).
A direct Worker blocker may be pulled forward only when the map names that
dependency.

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
