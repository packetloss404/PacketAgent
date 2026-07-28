# PacketAgent

**Self-hosted runtime for creating and operating autonomous workers. PacketAgent wakes workers on schedules and events, gives them explicit permissions and budgets, and keeps their work recoverable and auditable.**

PacketAgent is the always-available worker runtime in the Packet suite. A worker can be launched manually or activated by a schedule, webhook, queue, or alert; plan and act through approved tools; stop when its objective is satisfied; and pause safely when it needs a person. "Always on" describes the control plane, not an endless token loop: each run must have an exit condition plus time, cost, iteration, and permission boundaries.

The inherited TaskLoom implementation supplied substantial parts of that runtime: a Hono REST+SSE API (`src/server.ts`), provider-agnostic LLM routing, a bounded tool-using agent loop with a cost ledger, a Playwright browser runtime, a Docker/native command sandbox, an AES-256-GCM secrets vault, RBAC, inbound/outbound webhooks, a persistent scheduler with distributed leader election, and a SQLite-to-Postgres dual-write migration path. PacketAgent now unifies those pieces through a durable Worker definition, activation envelope, bounded supervisor, immutable checkpoints, restart recovery, external-effect receipts, fine-grained tool policy, opaque credential references, hardened network/process boundaries, and rolling budgets. Operator controls and the Packet suite deployment contract remain roadmap work.

The existing full-bleed builder at `/builder` remains useful, but its role changes: it becomes the worker creation studio. Existing prompt-to-app functionality remains supported as an inherited capability rather than the product's organizing principle.

## Packet suite

- **PacketADE** is where development work is planned, built, and supervised.
- **PacketCode** is the terminal coding environment.
- **PacketChat** is the conversational surface.
- **PacketPhone** is the mobile and remote approval surface.
- **PacketAgent** is where approved workers continue running after the originating application closes.

The target handoff is simple: build or plan work in PacketADE, choose **Deploy to PacketAgent** or **Keep running**, and receive progress, approval, budget, and completion events back through the Packet surfaces.

The builder routes through `ProviderRouter` and supports **six BYOK providers** end-to-end: Anthropic, OpenAI, Gemini, OpenRouter, MiniMax, and a generic local-LLM provider that can talk to Ollama, vLLM, LM Studio, or llama.cpp - on `localhost` or on a separate GPU box on your LAN. Anthropic stays the default; operators can re-order priority with `PACKETAGENT_PROVIDER_PRIORITY` or pick the `local` preset to force the local provider. Without any key configured, the builder falls back to deterministic template-only generation, which is enough to verify the loop but not enough to produce real apps from open-ended prompts.

This is "Fork B": self-host first, MIT licensed, no telemetry, no vendor in the path. Hosted-only conveniences (free public subdomains, pre-wired OAuth, managed App Store submission, cross-tenant memory, vendor-managed credit meters) are intentionally out of scope - they are inventoried in [CLOUD.md](CLOUD.md) for reference, not as a roadmap commitment.

## What's actually inside

The following implemented subsystems are exercised by tests. Most are inherited and wired into `src/server.ts`; W1-W8.2 add the canonical Worker control plane, trigger-intake boundary, bounded execution supervisor, crash-safe recovery, runtime security boundary, atomic rolling-budget ledger, adversarial permission/control gates, versioned evidence journal, and deterministic observability projections.

- **Canonical Worker control plane and supervisor** (`src/workers/`). W1-W5 provide versioned records and runtime validators; immutable definitions, versions, and deployments; lifecycle commands and audit events; a durable activation envelope/inbox; encrypted expiring references for large or sensitive inputs; atomic admission of one version-pinned queued run and execution job; and a port-isolated plan-act-evaluate-checkpoint-decide supervisor. Immutable digest-chained snapshots preserve the complete phase cursor, working memory, artifacts, effect receipts, trace, and remaining budget. Startup and periodic recovery requeue safe expired work and quarantine corrupt or uncertain replay. Mutating tools prepare and complete redacted effect receipts around the external call. W6 adds normalized tool/verb/resource capability compilation, deployment-only narrowing, deterministic policies tied to the immutable version digest, typed operation descriptors for every production tool, fail-closed authorization in `executeTool`, redacted allow/deny events, workspace-scoped encrypted credential references, pinned public DNS/connection validation, redirect denial, Docker-only no-network Worker command execution, atomic workspace/deployment rolling reservations for provider cost and externally billable actions, and a one-shot registry guard that prevents direct Worker handler bypass. W7 adds durable version-bound attention, approval, operator-command, and notification-delivery records; atomic pause, resume, stop, revoke, approve-once, approve-for-run, and reject; exact checkpointed attention with deadline enforcement and final-boundary grant rechecks; independent, workspace-scoped operator routes with separate inspect, run-control, deployment-control, and approval permissions; and adversarial restart, callback replay, approve/reject, phase-stop, and activation/revoke race coverage. W8.1 adds digest-bound v2 event envelopes with monotonic workspace/deployment/run sequences, W3C trace and durable-source correlations, atomically paired evidence entries, optional opaque raw-payload references, and content/provenance-bound artifact manifests while retaining legacy v1 reads. W8.2 rebuilds cumulative version/deployment/run views for provider/tool/effect calls, retries, queue duration, approvals, checkpoints, budgets, artifacts, outcomes, exit-predicate matches, and explained missing-source gaps. Manual, timezone-aware cron, opaque webhook, alert, and queue deliveries share this path across JSON, SQLite, and managed Postgres.
- **Two-phase LLM file-tree codegen** (`src/codegen/llm-author.ts`). The LLM authors whole React/Vite file trees via `write_file` tool calls: JSON plan parsing (fenced + bracket-scan fallback, one retry), token-budgeted chunked write rounds (`MAX_FILES_PER_WRITE_CHUNK=8`, `CHUNK_WRITE_THRESHOLD=10`), partial-result tolerance, and a workspace-escape `isSafePath` guard. `AppBuilderDraft` is a derived view; generated files land under `data/generated-apps/.../workspace` with sha256 manifests.
- **Provider-agnostic router** (`src/providers/router.ts`). Route-key -> provider/model dispatch, six real BYOK clients, `preset-resolver.ts` (cheap/fast/smart/local presets walking a priority list), `ledger.ts` cost recording, and an always-present `stub` fallback so the loop runs without keys.
- **Tool-using agent loop** (`src/tools/agent-loop.ts`). Provider-routed, cost-ledger-wrapped, registered tool execution with tool-result feedback, abort signals, and capped turns. Tool registry/executor and read/write/browser builtins under `src/tools/`.
- **Real Playwright browser runtime** (`src/tools/browser-runtime.ts`). Headless chromium, per-run page sessions, screenshot artifacts to `data/artifacts/<runId>`, graceful shutdown on SIGINT/SIGTERM.
- **Command sandbox** (`src/sandbox/`). A driver abstraction with a Docker driver (`--network=none`, CPU/memory/PID caps, dropped capabilities, no-new-privileges, non-root user, read-only rootfs) and a native child-process fallback for explicitly opted-in interactive development. Autonomous Workers refuse the native fallback.
- **AES-256-GCM secrets vault** (`src/security/vault.ts`). PBKDF2 100k iterations, auth-tag validation, masking, and a production `MASTER_KEY` enforcement guard. Backs the Integrations secret store.
- **SQLite-to-Postgres dual-write migration path** (`src/repositories/*`, `src/db/`). Per-entity repositories (jobs, agent-runs, activities, alert-events, provider-calls, invitation-email-deliveries) have `*-read.ts` read models, dual-write handlers, and parity suites. `src/db/postgres-client.ts` pools connections; `db:backfill-*` / `db:verify-*` scripts cover multiple entity types. Migrations live in `src/db/migrations`.
- **Distributed job scheduler** (`src/jobs/`). Persisted queue with five-field cron, exponential retry, and dead-letter - plus three leader-election strategies for multi-node coordination: a file TTL lock (`scheduler-lock.ts`), an HTTP coordinator (`scheduler-http-coordinator.ts`), and a noop, selected via `scheduler-leader-selection.ts`. Registers cron, metrics-snapshot, alert evaluate/deliver, and canonical `worker.run` job types; shutdown releases claimed work instead of reporting false success.
- **Integration connector verifier** (`src/integration-sandbox.ts`). Deterministically pre-flights model / db / email / webhook / payment / github / browser connector readiness before preview/runtime.
- **RBAC, webhooks, share links, activation analytics.** `rbac.ts` (viewer/member/admin/owner, server-enforced), API-key auth, inbound webhooks that trigger agent runs, outbound webhooks (alerts + invitation-email delivery) with retry/dead-letter/signing, public share links, and an onboarding/activation analytics subsystem (`src/activation/*`).

## How it compares

PacketAgent is not trying to match hosted AI app builders feature-for-feature. It is a self-hosted autonomous-worker runtime and operator workbench, not a hosted SaaS, and the tradeoffs are deliberate.

- **What self-host gives up.** No free public subdomain with auto TLS (you bring your own DNS and certificate). No pre-wired OAuth connectors (you register your own OAuth clients with each provider). No one-click App Store / Play Store submission (no managed macOS build farm). No cross-tenant user memory. No vendor-hosted credit meter. No vendor-amortized LLM key - you bring your own across any of six providers (Anthropic, OpenAI, Gemini, OpenRouter, MiniMax, or a local Ollama / vLLM / LM Studio / llama.cpp endpoint).
- **What self-host gains.** Your data, your source code, your LLM key, and your deploy target - all on infrastructure you own. No vendor in the path between you and your customers. No per-seat pricing. No rate limits beyond what your own LLM provider imposes on your own key. The local-LLM provider can be pointed at a separate GPU box on your LAN, so the workbench laptop stays cheap while inference runs where the silicon is. Single MIT-licensed binary that runs anywhere Node 22 runs - laptop, container, VPS, homelab, behind a VPN.
- **Honest about what is not built yet.** Trigger delivery creates durable canonical queued Worker runs, and `worker.run` executes them through a bounded, checkpointed, restart-recoverable supervisor with external-effect receipts, fine-grained runtime policy, durable rolling budgets, a closed adversarial permission gate, automatic approval attention, and independent operator controls whose restart/kill race gate passes. The versioned evidence substrate and deterministic rollups are implemented, but W8.3-W8.5 still need retention cleanup, the consolidated Worker health/cost/evidence API and UI, and the final answerability gate. Queued notification references do not yet imply every external delivery transport is shipped. Worker browser, SMTP, and SQL paths currently fail closed until equally hardened drivers exist. Other remaining limits include no default live SMTP transport, opt-in real sandbox validation for non-Worker app flows, and legacy template artifacts that may still use browser-side sql.js.
- **Honest about the gap with hosted.** The deferred hosted-only capabilities and what a future "PacketAgent Cloud" product would need to ship them are inventoried in [CLOUD.md](CLOUD.md). That document is for strategic reference, not a roadmap commitment - self-host stays the default.

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](#license)
![Version](https://img.shields.io/badge/version-v0.1.0-blue.svg)
[![Node](https://img.shields.io/badge/node-%3E%3D22.5.0-brightgreen.svg)](https://nodejs.org)
[![Built with TypeScript](https://img.shields.io/badge/built%20with-TypeScript-blue.svg)](https://www.typescriptlang.org)
[![React 19](https://img.shields.io/badge/React-19-61dafb.svg)](https://react.dev)
[![Hono](https://img.shields.io/badge/API-Hono-orange.svg)](https://hono.dev)

- **Repository status:** local foundation branch; PacketAgent `origin` is not configured yet
- **License:** MIT

## Project docs

- [docs/SELF_HOST.md](docs/SELF_HOST.md) is the canonical setup guide: prerequisites, 5-minute quick start, BYO-LLM-key configuration, and Docker-Compose deploy.
- [CLOUD.md](CLOUD.md) inventories the hosted-only capabilities PacketAgent intentionally does not ship as self-host, and what a hypothetical PacketAgent Cloud product would need to ship them.
- [CHANGELOG.md](CHANGELOG.md) records notable product and platform changes.
- [BACKLOG.md](BACKLOG.md) is the master ledger for the autonomous-worker foundation and inherited platform work.
- [dev/CODEX-HANDOFF.md](dev/CODEX-HANDOFF.md) is the authoritative state and resume point for a new Codex project.
- [dev/worker-implementation-loops.md](dev/worker-implementation-loops.md) turns W2-W10 and the inherited backlog into dependency-ordered implementation and verification loops.
- [dev/packetade-packetagent-handoff.md](dev/packetade-packetagent-handoff.md) defines the planned PacketADE deployment contract.
- [dev/taskloom-to-packetagent.md](dev/taskloom-to-packetagent.md) records rename compatibility and repository migration details.
- [dev/worker-contract-plan.md](dev/worker-contract-plan.md) records W1 research, contract decisions, implementation loops, and verification.
- [dev/TESTING.md](dev/TESTING.md) covers local verification and release checks.
- [dev/roadmap.md](dev/roadmap.md) captures the broader roadmap after the MVP path is reliable.

## Why PacketAgent

Most autonomous-agent services own the control plane that holds your data, credentials, model relationships, and execution history. PacketAgent is the opposite: a Node application you can run on your laptop, in a container, behind your VPN, or on infrastructure you own. Its inherited workbench already combines authoring with agents, runs, secrets, webhooks, RBAC, jobs, and audit; the current roadmap turns that substrate into a durable Worker runtime.

This is a deliberate category split. If a free public URL, pre-wired OAuth connectors, or one-click App Store submission is what you actually need, a hosted vendor will serve you better - those features are structurally easier when a vendor owns the runtime. See [CLOUD.md](CLOUD.md) for a full inventory of what self-host gives up. If instead you want to own your data, your source code, and your LLM key end-to-end with no vendor in the path, PacketAgent is built for that.

## Getting started

```bash
cd /path/to/PacketAgent
npm ci
npm run dev
```

Then open **http://localhost:7341**. Two processes start:

The current foundation checkout is `D:\projects\PacketAgent`. A PacketAgent
`origin` has not been configured yet; do not clone from or push to the
historical `taskloom-source` remote.

| Port   | Process    | Purpose                                         |
| ------ | ---------- | ----------------------------------------------- |
| `7341` | Vite (web) | React workbench UI, proxies `/api/*` to the API |
| `8484` | Hono (api) | REST + SSE endpoints, jobs scheduler, sandbox   |

For a built-and-served run on a single port (`8484`):

```bash
npm run build:web
npm start
```

### Bring your own LLM key

PacketAgent does not ship with a bundled LLM key. The builder needs one to turn open-ended prompts into briefs, plans, and source files; without a key it falls back to deterministic template-only generation.

The builder routes through `ProviderRouter` and accepts six providers. Anthropic remains the default; the preset resolver walks a per-preset priority list and picks the first provider with a configured key. You can re-order the walk with `PACKETAGENT_PROVIDER_PRIORITY`, force the `local` preset to your own GPU box, or hit `GET /api/app/builder/providers/status` to confirm what is actually resolved at runtime.

Configure a provider in one of two ways:

- **In the workbench** - open **Admin -> Integrations** for Anthropic, OpenAI, or MiniMax credentials. Supported entries are stored in the encrypted secrets vault (AES-256-GCM at rest) and never logged.
- **As an environment variable** - copy `.env.example` to `.env` and set one or more of:
  - `ANTHROPIC_API_KEY=sk-ant-...` (default; targets `claude-sonnet-4-6`; see https://docs.claude.com/en/api)
  - `OPENAI_API_KEY=sk-...` (defaults to `gpt-4o` / `gpt-4o-mini`)
  - `GOOGLE_API_KEY=...` or `GEMINI_API_KEY=...` (Gemini 2.5; either env name is accepted)
  - `OPENROUTER_API_KEY=sk-or-...` (model marketplace; defaults to a Gemini / Claude pick depending on preset)
  - `MINIMAX_API_KEY=...`
  - `LOCAL_LLM_BASE_URL=http://gpu-box:8000` plus `LOCAL_LLM_API_FORMAT=openai` and optional `LOCAL_LLM_MODEL=...` for a remote vLLM / LM Studio / llama.cpp endpoint; `OLLAMA_BASE_URL` is still honored as a legacy synonym for plain Ollama
  - `PACKETAGENT_PROVIDER_PRIORITY=ollama,openrouter,anthropic` to override the default per-preset walk

See [docs/SELF_HOST.md](docs/SELF_HOST.md) for per-provider recipes, the local-LLM matrix (Ollama / vLLM / LM Studio / llama.cpp), provider-precedence rules, and the template-only fallback behavior.

### First 10 minutes: self-host path

1. Run `npm ci && npm run dev`.
2. Sign in at `http://localhost:7341` with `alpha@packetagent.local` / `demo12345`.
3. Open `/builder`, choose **Build an agent**, and create or adapt a bounded agent definition.
4. Review its instructions, typed inputs, trigger guidance, requested tools, and readiness blockers.
5. Run it manually, approve risky tools explicitly, and inspect the transcript, tool calls, logs, model, and cost in Runs.
6. Use the existing schedule or webhook surfaces only for work that fits the current capped agent-run model.
7. Canonical Workers are bounded and crash-resumable through W1-W5. W6 compiles and enforces deployment-scoped verb/resource grants, resolves opaque credentials only after approval, pins public network destinations, requires isolated Docker execution for Worker commands, atomically reserves rolling provider/action budgets, and closes direct-registry plus adversarial bypasses. W7 adds independently authorized attention, approval, pause, resume, stop, and revoke controls whose restart and race gate passes. Until W8 passes, do not treat the runtime as proof that consolidated evidence is complete.
8. To exercise the inherited prompt-to-app path, choose **Build an app** and use its generated source, preview, iteration, and publish-handoff surfaces.

### Seed accounts (development only)

The local seed includes three workspace accounts; password is `demo12345` for each. **Do not use these in any production environment.**

- `alpha@packetagent.local`
- `beta@packetagent.local`
- `gamma@packetagent.local`

You can also register a new account from the sign-up page. To reset local data back to the seed state, stop the dev server and run `npm run store:reset`.

## Features

### Build

- **Prompt-to-app and prompt-to-agent.** Describe an internal app or agent in plain language; PacketAgent drafts a brief, page map, data model, and acceptance checks, then has the LLM author the file tree directly.
- **Two-phase file-tree codegen.** Plan-then-write orchestrator with chunked planning for larger apps, partial-result tolerance, workspace-escape guards, and `tsc --noEmit` + `vite build` validation (phase-tagged, surfaced inline in chat).
- **Draft, preview, iterate, publish handoff.** Diff-review every change before applying. Each apply creates a checkpoint with source files on disk, a PacketAgent-served local preview, smoke checks, and rollback metadata.
- **Template gallery.** Six ready-to-edit agent templates ship in the box (see below). Use them as starting points or compose from scratch.
- **First-class scoped iteration.** Targeted change prompts edit one slice of the app instead of regenerating everything.
- **Connector pre-flight.** The integration sandbox deterministically verifies model / db / email / webhook / payment / github / browser connector readiness before preview/runtime.

### Run

- **Workflows.** Briefs, requirements, plans, blockers, open questions, validation evidence, and release confirmation - all editable in the workbench, all versioned.
- **Agent runs and runs activity.** Drilldown view at `/runs/:id` with transcript, tool-call timeline, logs, and a one-click failure-diagnostic helper. Runs execute through a real provider-routed tool-use loop with per-call cost accounting.
- **Multi-provider routing.** Six providers wired through `ProviderRouter`: Anthropic, OpenAI, Gemini, OpenRouter, MiniMax, and a generic local-LLM provider (Ollama / vLLM / LM Studio / llama.cpp). Switch per-agent; bring your own keys.
- **Browser tools.** Playwright-backed `browser_goto`, screenshots, and DOM tools for agent runs - real per-run headless chromium sessions with artifacts persisted under `data/artifacts/<runId>`.

### Operate

- **Encrypted secrets vault** - AES-256-GCM at rest, PBKDF2 100k iterations, auth-tag validation, masking, production `MASTER_KEY` enforcement.
- **Audit log** for workspace actions, role changes, and sensitive mutations.
- **Webhooks in and out.** Inbound public webhooks trigger agent runs; outbound webhooks deliver alerts and invitation events with retry, dead-letter, and shared-secret signing.
- **Persistent jobs queue + cron + distributed leader election.** Five-field cron for any registered job type, exponential retry, dead-letter, plus three leader-election strategies (file TTL lock, HTTP coordinator, noop) for multi-process / multi-node deployments.
- **Alert engine.** `evaluateAlerts` + a delivery pipeline with metrics snapshots, scheduled as job types.
- **SSE run streaming** for live transcripts and tool-call output.
- **RBAC** with viewer / member / admin / owner roles, enforced server-side, plus API-key auth.
- **Consolidated Admin.** Sixteen operator surfaces (Roles, SSO, Secrets, Rate limits, Webhooks, Releases, Storage, Backups, Notifications, Operations, Integrations, Activation, Sandbox, Workflows, Billing, Alerts) live under a single tabbed `/admin/:tab` page. The sidebar collapses to four items: Build, Projects, Runs, Admin. Back-compat redirects keep the old per-page URLs working.
- **Command palette** (Cmd/Ctrl-K) for fast navigation and run shortcuts.

### Self-host

- **MIT licensed**, self-hosted, and runs anywhere the supported Node 22 runtime and required services are available.
- **No telemetry.** Nothing phones home.
- **BYO keys.** No vendored model relationships; no proxy in the middle.
- **JSON, SQLite, or managed Postgres.** Default is file-backed JSON for contributor flow; flip to SQLite for single-node deployments or managed Postgres for horizontal app writers - backed by a dual-write migration engine with read-parity test suites (see below).

## Data layer: SQLite -> managed Postgres

PacketAgent runs on Node's built-in `node:sqlite` (`DatabaseSync`, WAL, foreign keys on, busy_timeout) and includes a dual-write/backfill path to managed Postgres:

- **Per-entity repositories** (`src/repositories/*`) for jobs, agent-runs, activities, alert-events, provider-calls, and invitation-email-deliveries, each with a `*-read.ts` read model.
- **Dual-write handlers** that write to both SQLite and Postgres during migration, with `*.dual-write.test.ts` and `*.read-parity.test.ts` suites proving the two stores stay in parity.
- **Pooled Postgres client** (`src/db/postgres-client.ts`) plus a managed-database startup boot guard that enforces explicit opt-in before any Postgres writer is engaged.
- **Backfill / verify CLIs** (`db:backfill-*`, `db:verify-*`) covering 8+ entity types, and 17 ordered SQL migrations in `src/db/migrations`.

Managed Postgres is gated behind explicit startup flags; the distributed scheduler and these repositories are what make multi-node operation real rather than aspirational.

## Agent templates

Six templates ship in `src/agent-templates.ts` and appear in the workbench template gallery:

| Template                  | Category   | Schedule       | What it does                                                                                   |
| ------------------------- | ---------- | -------------- | ---------------------------------------------------------------------------------------------- |
| **Support inbox triage**  | Support    | `*/15 * * * *` | Watches a shared mailbox, classifies severity, drafts replies, escalates urgent threads.       |
| **Daily workspace brief** | Operations | `0 8 * * 1-5`  | Composes a 5-line morning brief from workspace activity, blockers, questions, and validations. |
| **Release audit**         | Release    | _on demand_    | Verifies validation evidence and release confirmation; blocks if required evidence is missing. |
| **Blocker watcher**       | Operations | `0 9 * * 1-5`  | Tracks unresolved blockers and prepares escalation notes for owners of critical items.         |
| **Weekly release notes**  | Comms      | `0 16 * * 5`   | Drafts customer-facing release notes from completed plan items and validation evidence.        |
| **Research summarizer**   | Research   | _on demand_    | Reads a URL, returns a structured summary with key findings, risks, and follow-up questions.   |

Every template is editable; instantiate one and tune the instructions, tools, schedule, and input schema for your workspace.

## Sandboxed code execution

A first-class sandbox runtime ships under `/api/app/sandbox/*` with a `/sandbox` view in the workbench. It powers ad-hoc command execution and (opt-in) the app-builder smoke pipeline that verifies generated apps before publish handoff.

- **Drivers.** `docker` (default) runs `docker run --rm -i --network=none --cpus --memory --read-only --tmpfs /tmp` against runtimes `node-20`, `python-3.11`, `ubuntu-22`. A `native` host-process fallback is available and clearly marked **insecure** in the UI; it does cross-platform process-tree termination (`taskkill` on Windows, SIGKILL elsewhere) with timeout-forced kill.
- **Endpoints.** `GET /status`, `GET /runtimes`, `POST /exec`, `GET /exec`, `GET /exec/:id`, `POST /exec/:id/cancel`, `GET /exec/:id/stream` (SSE).
- **Workbench UI.** Status panel, runtime readiness, command composer, exec history, and a live log viewer with stdout / stderr tabs and follow-tail. The Builder also gains a per-app Sandbox tab.
- **Smoke integration.** With `PACKETAGENT_SANDBOX_SMOKE_ENABLED=1`, draft-apply, change-apply, and preview-refresh route every smoke check through the sandbox. Per-check details get `sandbox: exit N  |  Mms` appended and the message is suffixed with `(verified via sandbox  |  driver=...)`. Off by default - enable once Docker is available.

## Configuration

Common environment variables:

| Variable                                 | Default                   | Purpose                                                                                                                                                                                               |
| ---------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                               | `development`             | Set to `production` to mark cookies `Secure` and disable dev shortcuts.                                                                                                                               |
| `PORT`                                   | `8484`                    | API server port.                                                                                                                                                                                      |
| `PACKETAGENT_STORE`                      | `json`                    | `json` (file-backed) or `sqlite`.                                                                                                                                                                     |
| `PACKETAGENT_DB_PATH`                    | `data/packetagent.sqlite` | SQLite database path when store is `sqlite`.                                                                                                                                                          |
| `PACKETAGENT_TRUST_PROXY`                | `false`                   | Trust `X-Forwarded-Host` / `X-Forwarded-For` from a known proxy.                                                                                                                                      |
| `PACKETAGENT_RATE_LIMIT_KEY_SALT`        | _unset_                   | Salt for hashed rate-limit bucket IDs. Set in production.                                                                                                                                             |
| `PACKETAGENT_SANDBOX_DRIVER`             | `auto`                    | `docker`, `native`, or `auto`.                                                                                                                                                                        |
| `PACKETAGENT_SANDBOX_DEFAULT_RUNTIME`    | `node-20`                 | Default container image.                                                                                                                                                                              |
| `PACKETAGENT_SANDBOX_DEFAULT_TIMEOUT_MS` | `30000`                   | Per-exec timeout.                                                                                                                                                                                     |
| `PACKETAGENT_SANDBOX_MEMORY_MB`          | `512`                     | Container memory limit.                                                                                                                                                                               |
| `PACKETAGENT_SANDBOX_CPUS`               | `1`                       | Container CPU limit.                                                                                                                                                                                  |
| `PACKETAGENT_SANDBOX_SMOKE_ENABLED`      | `0`                       | Route builder smoke checks through the sandbox. Also gates the file-tree validator's `tsc --noEmit` and `vite build` phases.                                                                          |
| `PACKETAGENT_LEGACY_TEMPLATES`           | _unset_                   | Set to `1` to force the legacy template path and skip the file-tree codegen orchestrator entirely. The previous opt-in flag `PACKETAGENT_FILETREE_CODEGEN=1` is preserved as a no-op for back-compat. |
| `PACKETAGENT_PROVIDER_PRIORITY`          | _unset_                   | Comma-separated provider override (e.g. `ollama,openrouter,anthropic`). Applied to every preset; first registered provider with a configured key wins.                                                |
| `LOCAL_LLM_BASE_URL`                     | _unset_                   | Base URL of a local LLM server (vLLM, LM Studio, llama.cpp, remote Ollama). Takes precedence over `OLLAMA_BASE_URL`.                                                                                  |
| `OLLAMA_BASE_URL`                        | `http://localhost:11434`  | Legacy synonym for `LOCAL_LLM_BASE_URL`; honored when `LOCAL_LLM_BASE_URL` is unset.                                                                                                                  |
| `LOCAL_LLM_API_FORMAT`                   | `ollama`                  | `ollama` (native `/api/chat`) or `openai` (`/v1/chat/completions`). Set to `openai` for vLLM / LM Studio / llama.cpp.                                                                                 |
| `LOCAL_LLM_MODEL`                        | _unset_                   | Pins the model name when the remote server only loads one specific model.                                                                                                                             |

Anthropic, OpenAI, and MiniMax keys can be configured per workspace under **Admin -> Integrations** and stored in the encrypted vault. Gemini and OpenRouter are currently environment-only because their provider names are not yet part of the vault key enum. A production `MASTER_KEY` is required to unseal the vault.

## Architecture

- **Frontend.** React 19 + react-router 7 + Vite 7, mounted at `/`. Tailwind CSS, Geist fonts, a silver / grey / green-light theme. `/builder` is a full-bleed route outside the workbench Shell (chat thread, streamed prose, split preview). The rest of the workbench lives behind a four-item sidebar (Build, Projects, Runs, Admin); sixteen operator surfaces are tabbed under `/admin/:tab`.
- **Backend.** Hono on `@hono/node-server`. `src/server.ts` mounts ~20 route groups (`app-routes`, `workflow-routes`, `webhook-routes`, `share-routes`, `sandbox-routes`, four `operations-*-routes`, and more) with access-log middleware, redacted error envelopes, `enforcePrivateAppMutationSecurity` on `/api/app/*`, cross-origin/CSRF enforcement, public webhooks, and static serving of the built web + run artifacts.
- **LLM layer.** `ProviderRouter` route-key dispatch over six BYOK clients, `preset-resolver` priority walking, and a cost `ledger`. A `stub` provider keeps the loop runnable with zero keys.
- **Codegen + agents.** `src/codegen/` (plan/write/chunk orchestrator, path validator, derived-draft, app-builder/iteration services, generated-app runtime/workspace, preview/snapshot/publish-readiness) and `src/tools/` (agent loop, registry/executor, read/write/browser builtins, Playwright runtime) plus `src/sandbox/`.
- **Persistence.** File-backed JSON for contributor flow; `node:sqlite` (WAL, foreign keys on, busy_timeout) for single-node; managed Postgres via repositories and document transactions with parity coverage. 21 SQL migrations.
- **Jobs / ops.** Persisted queue with five-field cron, exponential retry, dead-letter, three-way scheduler leader election, an alert engine, and metrics snapshots.

## Engineering & testing

PacketAgent is TypeScript ESM on Node >=22.5 with a React/Vite frontend. The code uses strict typechecking, dependency injection in many runtime boundaries, and feature directories for providers, tools, jobs, sandboxing, repositories, activation, codegen, and security. The inherited lint baseline still contains 145 warnings and is tracked as cleanup debt.

The W8.2 validation ran **1,448 API tests** (1,447 passed, 1 skipped) plus **25 web tests** with no failures, covering deterministic replay under reordered sources and process restart; version/deployment/run aggregation of provider/tool/effect calls, retries, queue duration, approvals, checkpoints, budgets, artifacts, outcomes, and exit evaluations; failed-tool and phase-retry journaling; missing-source gaps; workspace isolation; JSON/SQLite/managed-Postgres parity; and all W8.1 plus prior Worker contract, lifecycle, security, budget, recovery, attention, control, trigger, route, job, tool, and UI gates.

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

- **Worker permission, budget, internal control, supervisor attention, independent operator access, and the restart/kill gate are enforced, but the W8 answerability gate is not complete.** W1-W5 provide versioned Worker records, lifecycle routes, durable trigger intake, bounded execution, immutable full-state checkpoints, scheduler recovery, and mutation effect receipts across JSON, SQLite, and managed Postgres. W6 compiles version-bound verb/resource grants, rejects deployment broadening, normalizes and authorizes each operation, resolves only declared opaque credentials, pins public network destinations, denies redirects, requires isolated no-network Docker command execution, atomically reserves provider cost and externally billable actions across rolling workspace/deployment windows, and prevents direct registered-handler bypass. W7 persists and executes exact attention/control state, exposes concise independently authorized operator routes, and closes restart/callback/control/activation races without later work. W8.1 persists the versioned event/evidence and artifact-provenance substrate, and W8.2 rebuilds deterministic cumulative rollups; W8.3-W8.5 still own retention, the consolidated API/UI, and the read-model gate. External notification transports remain later work.
- **File-tree codegen is an inherited secondary capability.** With a BYOK key, the LLM authors files through `write_file`, validates with `tsc` and Vite when real sandbox validation is enabled, and can make up to two bounded repair passes. Legacy template-shaped drafts still use their older iteration path.
- **Per-app SQLite is current, with a compatibility caveat.** Current generated apps use the PacketAgent-served per-app SQLite API and supervised runtime processes. The legacy template/source-artifact path and older saved drafts can still contain sql.js/jsdelivr browser persistence.
- **Outbound Worker tools fail closed when a hardened dependency is unavailable.** `http_fetch`, `slack_post_webhook`, and `github_api` use Worker-scoped credential and pinned-network ports; `run_command` and `shell_for_agent` use the Docker-only execution port. Worker browser, email, and SQL calls are refused until equivalent hardened drivers are implemented. Approval tokens remain on the inherited Agent path, and legacy interactive Agent adapters retain their existing configuration behavior.
- **Preview is local.** Builder preview routes serve generated source files from disk through PacketAgent. They are not public deployments unless you configure and validate a public URL.
- **Publish is a handoff.** The publish surface records package metadata, artifact manifests, validation state, compose guidance, history, and rollback targets. Operators still run the self-hosted runtime and networking.
- **Sandbox smoke is opt-in.** Docker-backed smoke checks require Docker and `PACKETAGENT_SANDBOX_SMOKE_ENABLED=1`; otherwise statuses should remain explicit about pending, blocked, or fallback checks.
- **Self-host is the category, not a step toward hosted.** PacketAgent is not pursuing parity with Replit, v0, Bolt, Lovable, or anything.com. Hosted-only capabilities (free public subdomain, pre-wired OAuth, managed App Store submission) are inventoried in [CLOUD.md](CLOUD.md) and intentionally out of scope.

### SQLite mode

```bash
PACKETAGENT_STORE=sqlite npm run dev
npm run db:migrate
npm run db:seed
```

`npm run db:reset` recreates the schema and reseeds. `npm run db:backup` and `npm run db:restore` snapshot and restore the SQLite file. See `npm run` for the full list of database commands, including managed-Postgres backfill (`db:backfill-*`) and verify (`db:verify-*`) helpers.

## Project status

PacketAgent is in its foundation transition from TaskLoom's app/agent workbench to the autonomous-worker runtime described at the top of this file. The inherited Builder and operate surfaces work; the rename and compatibility layer are committed on the current foundation branch. The canonical Worker model, lifecycle, trigger intake, bounded-supervisor, W5 recovery/effect-safety, W6 permission/budget, and W7 attention/control gates are complete. W8.1 persists digest-bound, trace-correlated Worker events, evidence, and artifact provenance across all storage modes; W8.2 deterministically rebuilds version/deployment/run health, cost, activity, artifact, and outcome projections from those records. Current trigger sources create deduplicated, version-pinned runs that execute within explicit bounds and recover from immutable snapshots without repeating a completed mutation or double-crediting an abandoned budget hold.

The exact resume point is W8.3 in [BACKLOG.md](BACKLOG.md). New Codex projects should begin with [dev/CODEX-HANDOFF.md](dev/CODEX-HANDOFF.md), not the archived Phase 3 or legacy handoff documents.

For current product changes, see [CHANGELOG.md](CHANGELOG.md). PacketAgent does not yet have a configured GitHub `origin`, website, issue tracker, or release feed.

## Contributing

Until the PacketAgent remote is created, make changes on local `codex/*` branches and do not push to `taskloom-source`. Run `npm run build` before publishing work; it runs the web build, full TypeScript typecheck, API tests, and frontend tests.

## License

Released under the [MIT License](https://opensource.org/licenses/MIT). Copyright (c) PacketAgent contributors.
