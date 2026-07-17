# Taskloom

**Self-hosted, open-source workbench for building internal apps and agents — backed by a production-grade platform layer (provider router, agent runtime, encrypted vault, distributed scheduler, and dual-write Postgres migration). Bring your own LLM key, own your runtime, own your source code.**

Taskloom is a self-hosted workbench for drafting internal apps and agents from natural-language prompts. The builder is a full-bleed surface at `/builder` — chat thread, streamed prose, draft, plan, generated files, and a saved local preview. The rest of the workbench (Projects, Runs, and a consolidated Admin) lives behind a four-item sidebar so operators can keep most of their day inside the builder.

Underneath the builder sits a substantial internal-developer-platform: a Hono REST+SSE API (`src/server.ts`), a provider-agnostic LLM router across six backends, a tool-using agent loop with a cost ledger, a Playwright browser runtime, a Docker/native command sandbox, an AES-256-GCM secrets vault, RBAC, inbound/outbound webhooks, a job scheduler with distributed leader election, and a zero-downtime SQLite→Postgres dual-write migration engine. It is hand-built, multi-phase product engineering — roughly 59K LOC of non-test TypeScript source backed by ~1,250 test cases — not a scaffold.

The builder routes through `ProviderRouter` and supports **six BYOK providers** end-to-end: Anthropic, OpenAI, Gemini, OpenRouter, MiniMax, and a generic local-LLM provider that can talk to Ollama, vLLM, LM Studio, or llama.cpp — on `localhost` or on a separate GPU box on your LAN. Anthropic stays the default; operators can re-order priority with `TASKLOOM_PROVIDER_PRIORITY` or pick the `local` preset to force the local provider. Without any key configured, the builder falls back to deterministic template-only generation, which is enough to verify the loop but not enough to produce real apps from open-ended prompts.

This is "Fork B": self-host first, MIT licensed, no telemetry, no vendor in the path. Hosted-only conveniences (free public subdomains, pre-wired OAuth, managed App Store submission, cross-tenant memory, vendor-managed credit meters) are intentionally out of scope — they are inventoried in [CLOUD.md](CLOUD.md) for reference, not as a roadmap commitment.

## What's actually inside

Taskloom's headline is "self-host app builder," but the surrounding platform is the larger story. Every subsystem below is wired into `src/server.ts`, exercised by tests, and shipped — not aspirational.

- **Two-phase LLM file-tree codegen** (`src/codegen/llm-author.ts`). The LLM authors whole React/Vite file trees via `write_file` tool calls: JSON plan parsing (fenced + bracket-scan fallback, one retry), token-budgeted chunked write rounds (`MAX_FILES_PER_WRITE_CHUNK=8`, `CHUNK_WRITE_THRESHOLD=10`), partial-result tolerance, and a workspace-escape `isSafePath` guard. `AppBuilderDraft` is a derived view; generated files land under `data/generated-apps/.../workspace` with sha256 manifests.
- **Provider-agnostic router** (`src/providers/router.ts`). Route-key → provider/model dispatch, six real BYOK clients, `preset-resolver.ts` (cheap/fast/smart/local presets walking a priority list), `ledger.ts` cost recording, and an always-present `stub` fallback so the loop runs without keys.
- **Tool-using agent loop** (`src/tools/agent-loop.ts`). Provider-routed, cost-ledger-wrapped, registered tool execution with tool-result feedback, abort signals, and capped turns. Tool registry/executor and read/write/browser builtins under `src/tools/`.
- **Real Playwright browser runtime** (`src/tools/browser-runtime.ts`). Headless chromium, per-run page sessions, screenshot artifacts to `data/artifacts/<runId>`, graceful shutdown on SIGINT/SIGTERM.
- **Command sandbox** (`src/sandbox/`). A driver abstraction with a Docker driver (`--network=none`, cpu/memory caps, read-only rootfs) and a native child-process fallback that does cross-platform process-tree kill (`taskkill` on Windows, SIGKILL elsewhere) with timeout-forced termination.
- **AES-256-GCM secrets vault** (`src/security/vault.ts`). PBKDF2 100k iterations, auth-tag validation, masking, and a production `MASTER_KEY` enforcement guard. Backs the Integrations secret store.
- **Zero-downtime SQLite→Postgres dual-write migration engine** (`src/repositories/*`, `src/db/`). Per-entity repositories (jobs, agent-runs, activities, alert-events, provider-calls, invitation-email-deliveries) with `*-read.ts` read models, dual-write handlers, and `*.dual-write.test.ts` + `*.read-parity.test.ts` suites proving SQLite/Postgres parity. `src/db/postgres-client.ts` pools connections; `db:backfill-*` / `db:verify-*` scripts cover 8+ entity types. 17 SQL migrations in `src/db/migrations`.
- **Distributed job scheduler** (`src/jobs/`). Persisted queue with five-field cron, exponential retry, and dead-letter — plus three leader-election strategies for multi-node coordination: a file TTL lock (`scheduler-lock.ts`), an HTTP coordinator (`scheduler-http-coordinator.ts`), and a noop, selected via `scheduler-leader-selection.ts`. Registers cron, metrics-snapshot, and alert evaluate/deliver job types.
- **Integration connector verifier** (`src/codegen/integration-sandbox.ts`). Deterministically pre-flights model / db / email / webhook / payment / github / browser connector readiness before preview/runtime.
- **RBAC, webhooks, share links, activation analytics.** `rbac.ts` (viewer/member/admin/owner, server-enforced), API-key auth, inbound webhooks that trigger agent runs, outbound webhooks (alerts + invitation-email delivery) with retry/dead-letter/signing, public share links, and an onboarding/activation analytics subsystem (`src/activation/*`).

## How it compares

Taskloom is not trying to match hosted AI app builders (twin.so, Replit Agents, Lovable, v0, anything.com) feature-for-feature. It is a different category — a self-host workbench, not a hosted SaaS — and the tradeoffs are deliberate.

- **What self-host gives up.** No free public subdomain with auto TLS (you bring your own DNS and certificate). No pre-wired OAuth connectors (you register your own OAuth clients with each provider). No one-click App Store / Play Store submission (no managed macOS build farm). No cross-tenant user memory. No vendor-hosted credit meter. No vendor-amortized LLM key — you bring your own across any of six providers (Anthropic, OpenAI, Gemini, OpenRouter, MiniMax, or a local Ollama / vLLM / LM Studio / llama.cpp endpoint).
- **What self-host gains.** Your data, your source code, your LLM key, and your deploy target — all on infrastructure you own. No vendor in the path between you and your customers. No per-seat pricing. No rate limits beyond what your own LLM provider imposes on your own key. The local-LLM provider can be pointed at a separate GPU box on your LAN, so the workbench laptop stays cheap while inference runs where the silicon is. Single MIT-licensed binary that runs anywhere Node 22 runs — laptop, container, VPS, homelab, behind a VPN.
- **Honest about what is not built yet.** Whole-file-tree codegen authored by the LLM via `write_file` tool calls is the default path when a BYOK key is configured (see [docs/CODEGEN_FILETREE.md](docs/CODEGEN_FILETREE.md)); the deterministic template path remains as a fallback and as an explicit opt-out via `TASKLOOM_LEGACY_TEMPLATES=1`. Iteration parity, chunked planning for large apps, and `vite build` validation alongside `tsc --noEmit` are wired in, but multi-round auto-fix on broken TypeScript is not — validation errors surface inline in the Builder chat thread for user-driven iteration. Generated apps persist data in the browser via sql.js loaded from a jsdelivr CDN — known issue, scheduled to move to a per-app server runtime with SQLite on disk in Phase 3 Track C. The agent tool catalog today is workspace-introspection plus the in-box browser runtime; outbound capabilities (`http_fetch`, `slack_post_webhook`, `github_api`, `email_send`, `sql_query`, `shell_for_agent`) are Track D.
- **Honest about the gap with hosted.** The deferred hosted-only capabilities and what a future "Taskloom Cloud" product would need to ship them are inventoried in [CLOUD.md](CLOUD.md). That document is for strategic reference, not a roadmap commitment — self-host stays the default.

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](#license)
[![Version](https://img.shields.io/badge/version-v0.1.0-blue.svg)](https://github.com/packetloss404/taskloom/releases)
[![Node](https://img.shields.io/badge/node-%3E%3D22.5.0-brightgreen.svg)](https://nodejs.org)
[![Built with TypeScript](https://img.shields.io/badge/built%20with-TypeScript-blue.svg)](https://www.typescriptlang.org)
[![React 19](https://img.shields.io/badge/React-19-61dafb.svg)](https://react.dev)
[![Hono](https://img.shields.io/badge/API-Hono-orange.svg)](https://hono.dev)

- **Website:** https://packetloss404.github.io/taskloom/
- **Source:** https://github.com/packetloss404/taskloom
- **License:** MIT

## Project docs

- [docs/SELF_HOST.md](docs/SELF_HOST.md) is the canonical setup guide: prerequisites, 5-minute quick start, BYO-LLM-key configuration, and Docker-Compose deploy.
- [CLOUD.md](CLOUD.md) inventories the hosted-only capabilities Taskloom intentionally does not ship as self-host, and what a hypothetical Taskloom Cloud product would need to ship them.
- [CHANGELOG.md](CHANGELOG.md) records notable product and platform changes.
- [BACKLOG.md](BACKLOG.md) tracks the remaining builder-first work needed before Taskloom can credibly present itself as an open-source alternative to hosted app/agent builders.
- [dev/TESTING.md](dev/TESTING.md) covers local verification and release checks.
- [dev/roadmap.md](dev/roadmap.md) captures the broader roadmap after the MVP path is reliable.

## Why Taskloom

Most prompt-to-app builders are hosted SaaS that own your data, your runtime, your model relationships, and your users. Taskloom is the opposite: a single Node app you can run on your laptop, in a container, behind your VPN, or on a colo box you own. The same workbench you use to draft an idea is the workbench your team uses to operate the result — agents, runs, secrets, webhooks, RBAC, and audit included.

This is a deliberate category split. If a free public URL, pre-wired OAuth connectors, or one-click App Store submission is what you actually need, a hosted vendor will serve you better — those features are structurally easier when a vendor owns the runtime. See [CLOUD.md](CLOUD.md) for a full inventory of what self-host gives up. If instead you want to own your data, your source code, and your LLM key end-to-end with no vendor in the path, Taskloom is built for that.

## Getting started

```bash
git clone https://github.com/packetloss404/taskloom.git
cd taskloom
npm install
npm run dev
```

Then open **http://localhost:7341**. Two processes start:

| Port | Process | Purpose |
| ---- | ------- | ------- |
| `7341` | Vite (web) | React workbench UI, proxies `/api/*` to the API |
| `8484` | Hono (api) | REST + SSE endpoints, jobs scheduler, sandbox |

For a built-and-served run on a single port (`8484`):

```bash
npm run build:web
npm start
```

### Bring your own LLM key

Taskloom does not ship with a bundled LLM key. The builder needs one to turn open-ended prompts into briefs, plans, and source files; without a key it falls back to deterministic template-only generation.

The builder routes through `ProviderRouter` and accepts six providers. Anthropic remains the default; the preset resolver walks a per-preset priority list and picks the first provider with a configured key. You can re-order the walk with `TASKLOOM_PROVIDER_PRIORITY`, force the `local` preset to your own GPU box, or hit `GET /api/app/builder/providers/status` to confirm what is actually resolved at runtime.

Configure a provider in one of two ways:

- **In the workbench** — open **Admin → Integrations** and paste a key. It is stored in the encrypted secrets vault (AES-256-GCM at rest), never logged.
- **As an environment variable** — copy `.env.example` to `.env` and set one or more of:
  - `ANTHROPIC_API_KEY=sk-ant-...` (default; targets `claude-sonnet-4-6`; see https://docs.claude.com/en/api)
  - `OPENAI_API_KEY=sk-...` (defaults to `gpt-4o` / `gpt-4o-mini`)
  - `GOOGLE_API_KEY=...` or `GEMINI_API_KEY=...` (Gemini 2.5; either env name is accepted)
  - `OPENROUTER_API_KEY=sk-or-...` (model marketplace; defaults to a Gemini / Claude pick depending on preset)
  - `MINIMAX_API_KEY=...`
  - `LOCAL_LLM_BASE_URL=http://gpu-box:8000` plus `LOCAL_LLM_API_FORMAT=openai` and optional `LOCAL_LLM_MODEL=...` for a remote vLLM / LM Studio / llama.cpp endpoint; `OLLAMA_BASE_URL` is still honored as a legacy synonym for plain Ollama
  - `TASKLOOM_PROVIDER_PRIORITY=ollama,openrouter,anthropic` to override the default per-preset walk

See [docs/SELF_HOST.md](docs/SELF_HOST.md) for per-provider recipes, the local-LLM matrix (Ollama / vLLM / LM Studio / llama.cpp), provider-precedence rules, and the template-only fallback behavior.

### First 10 minutes: self-host path

1. Run `npm install && npm run dev`.
2. Sign in at `http://localhost:7341` with `alpha@taskloom.local` / `demo12345`.
3. Open `/builder`, choose **Build an app**, and use a starter prompt such as `Build a lightweight CRM for renewal tracking`.
4. Review the generated brief, routes, data model, and acceptance checks. Approve only when the draft looks right.
5. Confirm Taskloom writes generated files under `data/generated-apps/<workspace>/<app>/workspace` and exposes the file manifest in **Generated source**.
6. Use the saved local preview at `/api/app/generated-apps/:appId/preview` to inspect the running checkpoint. Use scoped iteration for changes such as `Add renewal risk notes to accounts`.
7. Open **Publish handoff** after checks run. Treat it as a local package, artifact manifest, health/smoke checklist, and URL handoff. It opens the Taskloom-served generated preview locally; it does not deploy a separate cloud runtime for you.
8. For a single-port local serve, run `npm run build:web && npm start`, then validate the health and preview URLs shown by the handoff panel.

### Seed accounts (development only)

The local seed includes three workspace accounts; password is `demo12345` for each. **Do not use these in any production environment.**

- `alpha@taskloom.local`
- `beta@taskloom.local`
- `gamma@taskloom.local`

You can also register a new account from the sign-up page. To reset local data back to the seed state, stop the dev server and run `npm run store:reset`.

## Features

### Build

- **Prompt-to-app and prompt-to-agent.** Describe an internal app or agent in plain language; Taskloom drafts a brief, page map, data model, and acceptance checks, then has the LLM author the file tree directly.
- **Two-phase file-tree codegen.** Plan-then-write orchestrator with chunked planning for larger apps, partial-result tolerance, workspace-escape guards, and `tsc --noEmit` + `vite build` validation (phase-tagged, surfaced inline in chat).
- **Draft, preview, iterate, publish handoff.** Diff-review every change before applying. Each apply creates a checkpoint with source files on disk, a Taskloom-served local preview, smoke checks, and rollback metadata.
- **Template gallery.** Six ready-to-edit agent templates ship in the box (see below). Use them as starting points or compose from scratch.
- **First-class scoped iteration.** Targeted change prompts edit one slice of the app instead of regenerating everything.
- **Connector pre-flight.** The integration sandbox deterministically verifies model / db / email / webhook / payment / github / browser connector readiness before preview/runtime.

### Run

- **Workflows.** Briefs, requirements, plans, blockers, open questions, validation evidence, and release confirmation — all editable in the workbench, all versioned.
- **Agent runs and runs activity.** Drilldown view at `/runs/:id` with transcript, tool-call timeline, logs, and a one-click failure-diagnostic helper. Runs execute through a real provider-routed tool-use loop with per-call cost accounting.
- **Multi-provider routing.** Six providers wired through `ProviderRouter`: Anthropic, OpenAI, Gemini, OpenRouter, MiniMax, and a generic local-LLM provider (Ollama / vLLM / LM Studio / llama.cpp). Switch per-agent; bring your own keys.
- **Browser tools.** Playwright-backed `browser_goto`, screenshots, and DOM tools for agent runs — real per-run headless chromium sessions with artifacts persisted under `data/artifacts/<runId>`.

### Operate

- **Encrypted secrets vault** — AES-256-GCM at rest, PBKDF2 100k iterations, auth-tag validation, masking, production `MASTER_KEY` enforcement.
- **Audit log** for workspace actions, role changes, and sensitive mutations.
- **Webhooks in and out.** Inbound public webhooks trigger agent runs; outbound webhooks deliver alerts and invitation events with retry, dead-letter, and shared-secret signing.
- **Persistent jobs queue + cron + distributed leader election.** Five-field cron for any registered job type, exponential retry, dead-letter, plus three leader-election strategies (file TTL lock, HTTP coordinator, noop) for multi-process / multi-node deployments.
- **Alert engine.** `evaluateAlerts` + a delivery pipeline with metrics snapshots, scheduled as job types.
- **SSE run streaming** for live transcripts and tool-call output.
- **RBAC** with viewer / member / admin / owner roles, enforced server-side, plus API-key auth.
- **Consolidated Admin.** Sixteen operator surfaces (Roles, SSO, Secrets, Rate limits, Webhooks, Releases, Storage, Backups, Notifications, Operations, Integrations, Activation, Sandbox, Workflows, Billing, Alerts) live under a single tabbed `/admin/:tab` page. The sidebar collapses to four items: Build, Projects, Runs, Admin. Back-compat redirects keep the old per-page URLs working.
- **Command palette** (Cmd/Ctrl-K) for fast navigation and run shortcuts.

### Self-host

- **MIT licensed**, single-binary friendly, runs anywhere Node 22 runs.
- **No telemetry.** Nothing phones home.
- **BYO keys.** No vendored model relationships; no proxy in the middle.
- **JSON, SQLite, or managed Postgres.** Default is file-backed JSON for contributor flow; flip to SQLite for single-node deployments or managed Postgres for horizontal app writers — backed by a dual-write migration engine with read-parity test suites (see below).

## Data layer: SQLite → managed Postgres

Taskloom runs on Node's built-in `node:sqlite` (`DatabaseSync`, WAL, foreign keys on, busy_timeout) and ships a production-grade, zero-downtime path to managed Postgres:

- **Per-entity repositories** (`src/repositories/*`) for jobs, agent-runs, activities, alert-events, provider-calls, and invitation-email-deliveries, each with a `*-read.ts` read model.
- **Dual-write handlers** that write to both SQLite and Postgres during migration, with `*.dual-write.test.ts` and `*.read-parity.test.ts` suites proving the two stores stay in parity.
- **Pooled Postgres client** (`src/db/postgres-client.ts`) plus a managed-database startup boot guard that enforces explicit opt-in before any Postgres writer is engaged.
- **Backfill / verify CLIs** (`db:backfill-*`, `db:verify-*`) covering 8+ entity types, and 17 ordered SQL migrations in `src/db/migrations`.

Managed Postgres is gated behind explicit startup flags; the distributed scheduler and these repositories are what make multi-node operation real rather than aspirational.

## Agent templates

Six templates ship in `src/agent-templates.ts` and appear in the workbench template gallery:

| Template | Category | Schedule | What it does |
| -------- | -------- | -------- | ------------ |
| **Support inbox triage** | Support | `*/15 * * * *` | Watches a shared mailbox, classifies severity, drafts replies, escalates urgent threads. |
| **Daily workspace brief** | Operations | `0 8 * * 1-5` | Composes a 5-line morning brief from workspace activity, blockers, questions, and validations. |
| **Release audit** | Release | _on demand_ | Verifies validation evidence and release confirmation; blocks if required evidence is missing. |
| **Blocker watcher** | Operations | `0 9 * * 1-5` | Tracks unresolved blockers and prepares escalation notes for owners of critical items. |
| **Weekly release notes** | Comms | `0 16 * * 5` | Drafts customer-facing release notes from completed plan items and validation evidence. |
| **Research summarizer** | Research | _on demand_ | Reads a URL, returns a structured summary with key findings, risks, and follow-up questions. |

Every template is editable; instantiate one and tune the instructions, tools, schedule, and input schema for your workspace.

## Sandboxed code execution

A first-class sandbox runtime ships under `/api/app/sandbox/*` with a `/sandbox` view in the workbench. It powers ad-hoc command execution and (opt-in) the app-builder smoke pipeline that verifies generated apps before publish handoff.

- **Drivers.** `docker` (default) runs `docker run --rm -i --network=none --cpus --memory --read-only --tmpfs /tmp` against runtimes `node-20`, `python-3.11`, `ubuntu-22`. A `native` host-process fallback is available and clearly marked **insecure** in the UI; it does cross-platform process-tree termination (`taskkill` on Windows, SIGKILL elsewhere) with timeout-forced kill.
- **Endpoints.** `GET /status`, `GET /runtimes`, `POST /exec`, `GET /exec`, `GET /exec/:id`, `POST /exec/:id/cancel`, `GET /exec/:id/stream` (SSE).
- **Workbench UI.** Status panel, runtime readiness, command composer, exec history, and a live log viewer with stdout / stderr tabs and follow-tail. The Builder also gains a per-app Sandbox tab.
- **Smoke integration.** With `TASKLOOM_SANDBOX_SMOKE_ENABLED=1`, draft-apply, change-apply, and preview-refresh route every smoke check through the sandbox. Per-check details get `sandbox: exit N · Mms` appended and the message is suffixed with `(verified via sandbox · driver=…)`. Off by default — enable once Docker is available.

## Configuration

Common environment variables:

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `NODE_ENV` | `development` | Set to `production` to mark cookies `Secure` and disable dev shortcuts. |
| `PORT` | `8484` | API server port. |
| `TASKLOOM_STORE` | `json` | `json` (file-backed) or `sqlite`. |
| `TASKLOOM_DB_PATH` | `data/taskloom.sqlite` | SQLite database path when store is `sqlite`. |
| `TASKLOOM_TRUST_PROXY` | `false` | Trust `X-Forwarded-Host` / `X-Forwarded-For` from a known proxy. |
| `TASKLOOM_RATE_LIMIT_KEY_SALT` | _unset_ | Salt for hashed rate-limit bucket IDs. Set in production. |
| `TASKLOOM_SANDBOX_DRIVER` | `auto` | `docker`, `native`, or `auto`. |
| `TASKLOOM_SANDBOX_DEFAULT_RUNTIME` | `node-20` | Default container image. |
| `TASKLOOM_SANDBOX_DEFAULT_TIMEOUT_MS` | `30000` | Per-exec timeout. |
| `TASKLOOM_SANDBOX_MEMORY_MB` | `512` | Container memory limit. |
| `TASKLOOM_SANDBOX_CPUS` | `1` | Container CPU limit. |
| `TASKLOOM_SANDBOX_SMOKE_ENABLED` | `0` | Route builder smoke checks through the sandbox. Also gates the file-tree validator's `tsc --noEmit` and `vite build` phases. |
| `TASKLOOM_LEGACY_TEMPLATES` | _unset_ | Set to `1` to force the legacy template path and skip the file-tree codegen orchestrator entirely. The previous opt-in flag `TASKLOOM_FILETREE_CODEGEN=1` is preserved as a no-op for back-compat. |
| `TASKLOOM_PROVIDER_PRIORITY` | _unset_ | Comma-separated provider override (e.g. `ollama,openrouter,anthropic`). Applied to every preset; first registered provider with a configured key wins. |
| `LOCAL_LLM_BASE_URL` | _unset_ | Base URL of a local LLM server (vLLM, LM Studio, llama.cpp, remote Ollama). Takes precedence over `OLLAMA_BASE_URL`. |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Legacy synonym for `LOCAL_LLM_BASE_URL`; honored when `LOCAL_LLM_BASE_URL` is unset. |
| `LOCAL_LLM_API_FORMAT` | `ollama` | `ollama` (native `/api/chat`) or `openai` (`/v1/chat/completions`). Set to `openai` for vLLM / LM Studio / llama.cpp. |
| `LOCAL_LLM_MODEL` | _unset_ | Pins the model name when the remote server only loads one specific model. |

Provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY` / `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `MINIMAX_API_KEY`) are configured per-workspace under **Admin → Integrations**, stored in the encrypted secrets vault, and never logged. A production `MASTER_KEY` is required to unseal the vault.

## Architecture

- **Frontend.** React 19 + react-router 7 + Vite 7, mounted at `/`. Tailwind CSS, Geist fonts, a silver / grey / green-light theme. `/builder` is a full-bleed route outside the workbench Shell (chat thread, streamed prose, split preview). The rest of the workbench lives behind a four-item sidebar (Build, Projects, Runs, Admin); sixteen operator surfaces are tabbed under `/admin/:tab`.
- **Backend.** Hono on `@hono/node-server`. `src/server.ts` mounts ~20 route groups (`app-routes`, `workflow-routes`, `webhook-routes`, `share-routes`, `sandbox-routes`, four `operations-*-routes`, and more) with access-log middleware, redacted error envelopes, `enforcePrivateAppMutationSecurity` on `/api/app/*`, cross-origin/CSRF enforcement, public webhooks, and static serving of the built web + run artifacts.
- **LLM layer.** `ProviderRouter` route-key dispatch over six BYOK clients, `preset-resolver` priority walking, and a cost `ledger`. A `stub` provider keeps the loop runnable with zero keys.
- **Codegen + agents.** `src/codegen/` (plan/write/chunk orchestrator, path validator, derived-draft, app-builder/iteration services, generated-app runtime/workspace, preview/snapshot/publish-readiness) and `src/tools/` (agent loop, registry/executor, read/write/browser builtins, Playwright runtime) plus `src/sandbox/`.
- **Persistence.** File-backed JSON for contributor flow; `node:sqlite` (WAL, foreign keys on, busy_timeout) for single-node; managed Postgres via per-entity repositories with dual-write + read-parity. 17 SQL migrations.
- **Jobs / ops.** Persisted queue with five-field cron, exponential retry, dead-letter, three-way scheduler leader election, an alert engine, and metrics snapshots.

## Engineering & testing

Taskloom is hand-crafted, senior-level TypeScript (ESM, Node ≥22.5): strict typing, narrow interfaces, dependency injection for testability (clock / spawn / prompt overrides), and consistent error redaction at the API boundary. Structure is feature-sliced (`providers/`, `tools/`, `jobs/`, `sandbox/`, `repositories/`, `activation/`, `codegen/`, `security/`) with near-zero dead code.

Testing is first-class: **~1,250 test cases across 140 test files** (node:test) — roughly a 0.7:1 test-to-source ratio — including SQLite/Postgres parity suites, async-boundary tests, and managed-Postgres transaction/concurrency tests. Biggest modules by LOC: `taskloom-store` (4,941), `app-routes` (4,176), `app-builder-service` (3,255).

## Development

```bash
# Run API + web together
npm run dev

# Or separately
npm run dev:api   # Hono on :8484
npm run dev:web   # Vite on :7341

# Type-check the entire workspace (API + web)
npm run typecheck

# Tests
npm run test       # API + web
npm run test:api
npm run test:web

# Full release gate (build + typecheck + tests)
npm run build
```

Generated `web/dist/` is gitignored; rebuild locally rather than committing it.

## Known limits

- **File-tree codegen is the default path; legacy templates remain as a fallback.** When a BYOK provider key is configured, the LLM authors the file tree directly via `write_file` tool calls and `AppBuilderDraft` is computed as a derived view (see [docs/CODEGEN_FILETREE.md](docs/CODEGEN_FILETREE.md)). Setting `TASKLOOM_LEGACY_TEMPLATES=1` forces the older template path; the previous opt-in flag `TASKLOOM_FILETREE_CODEGEN=1` is preserved as a no-op. Multi-round auto-fix on broken TypeScript is not yet wired — validation errors (tsc + vite build, phase-tagged) surface inline in the Builder chat thread for user-driven iteration. See [docs/PHASE3_SCOPE.md](docs/PHASE3_SCOPE.md) for the broader scope.
- **Generated apps use sql.js loaded from a jsdelivr CDN.** Each generated app's index loads `sql-wasm.js` and the matching wasm file from `cdn.jsdelivr.net` and persists rows in browser `localStorage`. That means generated apps phone home on first load and lose data when the browser store is cleared. Replacing this with a per-app server runtime backed by SQLite on disk is Phase 3 Track C.
- **Agent tool catalog is workspace-introspection plus the in-box browser runtime.** Agents can read workspace state (workflows, runs, blockers, audit) and drive the Playwright browser runtime, but cannot yet make arbitrary outbound HTTP calls, post to Slack, hit GitHub, send email, run arbitrary SQL, or execute shell as a first-class agent tool. The six outbound tools (`http_fetch`, `slack_post_webhook`, `github_api`, `email_send`, `sql_query`, `shell_for_agent`) are Phase 3 Track D.
- **Preview is local.** Builder preview routes serve generated source files from disk through Taskloom. They are not public deployments unless you configure and validate a public URL.
- **Publish is a handoff.** The publish surface records package metadata, artifact manifests, validation state, compose guidance, history, and rollback targets. Operators still run the self-hosted runtime and networking.
- **Sandbox smoke is opt-in.** Docker-backed smoke checks require Docker and `TASKLOOM_SANDBOX_SMOKE_ENABLED=1`; otherwise statuses should remain explicit about pending, blocked, or fallback checks.
- **Self-host is the category, not a step toward hosted.** Taskloom is not pursuing parity with Replit, v0, Bolt, Lovable, or anything.com. Hosted-only capabilities (free public subdomain, pre-wired OAuth, managed App Store submission) are inventoried in [CLOUD.md](CLOUD.md) and intentionally out of scope.

### SQLite mode

```bash
TASKLOOM_STORE=sqlite npm run dev
npm run db:migrate
npm run db:seed
```

`npm run db:reset` recreates the schema and reseeds. `npm run db:backup` and `npm run db:restore` snapshot and restore the SQLite file. See `npm run` for the full list of database commands, including managed-Postgres backfill (`db:backfill-*`) and verify (`db:verify-*`) helpers.

## Project status

Taskloom is in active development under the Fork B (self-host first) positioning. The builder loop (prompt-to-agent, prompt-to-app, scoped iteration, saved local preview, publish handoff) and the operate surface (workflows, runs, jobs, audit, secrets, webhooks, RBAC, sandbox) are stable and used end-to-end. Managed Postgres for horizontal app writers is supported behind explicit startup gates, backed by the dual-write migration engine; active-active multi-region writes, Taskloom-owned regional failover, hosted cloud deployment, and distributed SQLite are not.

Multi-provider BYOK at the builder is done — six providers (Anthropic, OpenAI, Gemini, OpenRouter, MiniMax, and a generic local-LLM endpoint) route through `ProviderRouter`. File-tree codegen runs by default when a BYOK key is configured: plan-then-write orchestrator, chunked planning for larger apps, iteration parity, and `vite build` validation alongside `tsc --noEmit`. The remaining planned chunk — multi-round auto-fix on broken TypeScript, a real per-app SQLite runtime, a fuller outbound agent tool catalog, and the cross-cutting security hardening that goes with all of the above — is scoped in [docs/PHASE3_SCOPE.md](docs/PHASE3_SCOPE.md) (29–39 focused days, 6–9 calendar weeks for a solo engineer).

For current product changes, see [CHANGELOG.md](CHANGELOG.md). For the remaining MVP and post-MVP work, see [BACKLOG.md](BACKLOG.md), the [project website](https://packetloss404.github.io/taskloom/), and the [GitHub Issues](https://github.com/packetloss404/taskloom/issues) tab.

## Contributing

PRs welcome. Please open an issue first for non-trivial changes so we can align on scope. Run `npm run build` before opening a PR — it runs the web build, full TypeScript typecheck, API tests, and frontend smoke tests.

## License

Released under the [MIT License](https://opensource.org/licenses/MIT). Copyright (c) Taskloom contributors.
