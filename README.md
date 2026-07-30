# PacketAgent

**Self-hosted runtime for creating and operating autonomous workers. PacketAgent wakes workers on schedules and events, gives them explicit permissions and budgets, and keeps their work recoverable and auditable.**

PacketAgent is the always-available worker runtime in the Packet suite. A worker can be launched manually or activated by a schedule, webhook, queue, or alert; plan and act through approved tools; stop when its objective is satisfied; and pause safely when it needs a person. "Always on" describes the control plane, not an endless token loop: each run must have an exit condition plus time, cost, iteration, and permission boundaries.

The inherited TaskLoom implementation supplied substantial parts of that runtime: a Hono REST+SSE API (`src/server.ts`), provider-agnostic LLM routing, a bounded tool-using agent loop with a cost ledger, a Playwright browser runtime, a Docker/native command sandbox, an AES-256-GCM secrets vault, RBAC, inbound/outbound webhooks, a persistent scheduler with distributed leader election, and JSON/SQLite/managed-Postgres persistence with staged backfill and parity checks. PacketAgent now unifies those pieces through a durable Worker definition, activation envelope, bounded supervisor, immutable checkpoints, restart recovery, external-effect receipts, fine-grained tool policy, opaque credential references, hardened network/process boundaries, rolling budgets, operator controls, and an independently authorized operations read model. WorkerPackage v1 now defines the PacketADE handoff bytes, and PacketAgent authenticates workspace-bound PacketADE actors before persisting integrity, provenance, local-policy, and idempotency decisions. The Packet-product API validates, deploys, updates, activates, inspects, lists runs, pauses, resumes, rolls back, and revokes receipt-bound deployments, then exposes reconnectable deployment/run events with durable cursor acknowledgements. The PacketADE disconnect/restart handoff gate passes; PacketChat can receive bounded threaded Worker cards with authenticated read-only callbacks; and PacketPhone can receive role-bounded approve, reject, pause, stop, and revoke controls whose single-use callbacks execute through W7. W10.4 now certifies those adapters locally under races, restart, replay, credential rotation, and dead-letter recovery; live product interoperability remains unverified until external endpoints are supplied.

The existing full-bleed builder at `/builder` remains useful, but its role changes: it becomes the worker creation studio. Existing prompt-to-app functionality remains supported as an inherited capability rather than the product's organizing principle.

## Packet suite

- **PacketADE** is where development work is planned, built, and supervised.
- **PacketCode** is the terminal coding environment.
- **PacketChat** is the conversational surface.
- **PacketPhone** is the mobile and remote approval surface.
- **PacketAgent** is where approved workers continue running after the originating application closes.

The target handoff is simple: build or plan work in PacketADE, choose **Deploy to PacketAgent** or **Keep running**, and receive progress, approval, budget, and completion events back through the Packet surfaces.

The builder routes through `ProviderRouter` and supports **six BYOK providers** end-to-end: Anthropic, OpenAI, Gemini, OpenRouter, MiniMax, and a generic local-LLM provider that can talk to Ollama, vLLM, LM Studio, or llama.cpp - on `localhost` or on a separate GPU box on your LAN. Every hosted provider key can be stored in the encrypted workspace vault. A canonical provider catalog drives model defaults, readiness, capability reporting, and hosted-versus-local generation policy; vLLM structured decoding has one bounded prompt fallback, and malformed tool arguments get one non-executing correction attempt. Anthropic stays the default; operators can re-order priority with `PACKETAGENT_PROVIDER_PRIORITY` or pick the `local` preset to force the local provider. Without any key configured, the builder falls back to deterministic template-only generation, which is enough to verify the loop but not enough to produce real apps from open-ended prompts.

This is "Fork B": self-host first, MIT licensed, no telemetry, no vendor in the path. Hosted-only conveniences (free public subdomains, pre-wired OAuth, managed App Store submission, cross-tenant memory, vendor-managed credit meters) are intentionally out of scope - they are inventoried in [CLOUD.md](CLOUD.md) for reference, not as a roadmap commitment.

## What's actually inside

The following implemented subsystems are exercised by tests. Most are inherited and wired into `src/server.ts`; W1-W8 add the canonical Worker control plane, trigger-intake boundary, bounded execution supervisor, crash-safe recovery, runtime security boundary, atomic rolling-budget ledger, adversarial permission/control gates, versioned evidence journal, deterministic observability projections, bounded retention, and canonical operations API/workbench.

- **Canonical Worker control plane and supervisor** (`src/workers/`). W1-W5 provide versioned records and runtime validators; immutable definitions, versions, and deployments; lifecycle commands and audit events; a durable activation envelope/inbox; encrypted expiring references for large or sensitive inputs; atomic admission of one version-pinned queued run and execution job; and a port-isolated plan-act-evaluate-checkpoint-decide supervisor. Immutable digest-chained snapshots preserve the complete phase cursor, working memory, artifacts, effect receipts, trace, and remaining budget. Startup and periodic recovery requeue safe expired work and quarantine corrupt or uncertain replay. Mutating tools prepare and complete redacted effect receipts around the external call. W6 adds normalized tool/verb/resource capability compilation, deployment-only narrowing, deterministic policies tied to the immutable version digest, typed operation descriptors for every production tool, fail-closed authorization in `executeTool`, redacted allow/deny events, workspace-scoped encrypted credential references, pinned public DNS/connection validation, redirect denial, Docker-only no-network Worker command execution, atomic workspace/deployment rolling reservations for provider cost and externally billable actions, and a one-shot registry guard that prevents direct Worker handler bypass. W7 adds durable version-bound attention, approval, operator-command, and notification-delivery records; atomic pause, resume, stop, revoke, approve-once, approve-for-run, and reject; exact checkpointed attention with deadline enforcement and final-boundary grant rechecks; independent, workspace-scoped operator routes with separate inspect, run-control, deployment-control, and approval permissions; and adversarial restart, callback replay, approve/reject, phase-stop, and activation/revoke race coverage. W8.1 adds digest-bound v2 event envelopes with monotonic workspace/deployment/run sequences, W3C trace and durable-source correlations, atomically paired evidence entries, optional opaque raw-payload references, and content/provenance-bound artifact manifests while retaining legacy v1 reads. W8.2 rebuilds cumulative version/deployment/run views for provider/tool/effect calls, retries, queue duration, approvals, checkpoints, budgets, artifacts, outcomes, exit-predicate matches, and explained missing-source gaps. W8.3 adds separate metadata, summary, prompt, tool-payload, and artifact windows; central persistence plus read-boundary redaction; terminal-only payload compaction; digest-only deletion events; retention-explained source gaps; and bounded, dry-runnable, workspace-scoped cleanup jobs. W8.4-W8.5 expose independently authorized health/list/detail/evidence APIs, stable workspace/filter-bound cursors, bounded resumable SSE, and a canonical accessible Worker list/detail workbench whose required answers come from one server-side read model. Manual, timezone-aware cron, opaque webhook, alert, and queue deliveries share this path across JSON, SQLite, and managed Postgres.
- **Two-phase LLM file-tree codegen** (`src/codegen/llm-author.ts`). The LLM authors whole React/Vite file trees via `write_file` tool calls: JSON plan parsing (fenced + bracket-scan fallback, one retry), token-budgeted chunked write rounds (`MAX_FILES_PER_WRITE_CHUNK=8`, `CHUNK_WRITE_THRESHOLD=10`), partial-result tolerance, and a workspace-escape `isSafePath` guard. `AppBuilderDraft` is a derived view; generated files land under `data/generated-apps/.../workspace` with sha256 manifests.
- **Provider-agnostic router** (`src/providers/router.ts`). Route-key -> provider/model dispatch, six real BYOK clients, one canonical provider/model/policy catalog, workspace-vault-aware readiness, native or conditional structured responses, bounded malformed-tool correction, `ledger.ts` cost recording, and an always-present `stub` fallback so the loop runs without keys.
- **Tool-using agent loop** (`src/tools/agent-loop.ts`). Provider-routed, cost-ledger-wrapped, registered tool execution with tool-result feedback, abort signals, and capped turns. Tool registry/executor and read/write/browser builtins under `src/tools/`.
- **Real Playwright browser runtime** (`src/tools/browser-runtime.ts`). Headless chromium, per-run page sessions, screenshot artifacts to `data/artifacts/<runId>`, graceful shutdown on SIGINT/SIGTERM.
- **Command sandbox** (`src/sandbox/`). A driver abstraction with a Docker driver (`--network=none`, CPU/memory/PID caps, dropped capabilities, no-new-privileges, non-root user, read-only rootfs). Docker is the only supported untrusted-code driver. The native child process is a separately gated owner/admin trusted-host diagnostic path, not a sandbox or fallback; generated apps and autonomous Workers refuse it.
- **AES-256-GCM secrets vault** (`src/security/vault.ts`). PBKDF2 100k iterations, auth-tag validation, masking, and a production `MASTER_KEY` enforcement guard. Backs the Integrations secret store.
- **Three explicit persistence authorities** (`src/store/`, `src/repositories/`, `src/db/`). JSON is a contributor-only whole document; SQLite stores promoted collections in dedicated tables and the remainder in `app_records` inside one transaction; managed Postgres stores one advisory-lock-protected normalized document. Staged `db:backfill-*` / `db:verify-*` commands cover SQLite promotion and managed cutover; this is not live SQLite/Postgres dual-write replication.
- **Distributed job scheduler** (`src/jobs/`). Persisted queue with five-field cron, exponential retry, and dead-letter - plus three leader-election strategies for multi-node coordination: a file TTL lock (`scheduler-lock.ts`), an HTTP coordinator (`scheduler-http-coordinator.ts`), and a noop, selected via `scheduler-leader-selection.ts`. Registers cron, metrics-snapshot, alert evaluate/deliver, workspace-scoped Worker retention, and canonical `worker.run` job types; shutdown releases claimed work instead of reporting false success.
- **Integration connector verifier** (`src/integration-sandbox.ts`). Deterministically pre-flights model / db / email / webhook / payment / github / browser connector readiness before preview/runtime.
- **RBAC, webhooks, share links, activation analytics.** `rbac.ts` (viewer/member/admin/owner, server-enforced), API-key auth, inbound webhooks that trigger agent runs, outbound webhooks (alerts + invitation-email delivery) with retry/dead-letter/signing, public share links, and an onboarding/activation analytics subsystem (`src/activation/*`).

## How it compares

PacketAgent is not trying to match hosted AI app builders feature-for-feature. It is a self-hosted autonomous-worker runtime and operator workbench, not a hosted SaaS, and the tradeoffs are deliberate.

- **What self-host gives up.** No free public subdomain with auto TLS (you bring your own DNS and certificate). No pre-wired OAuth connectors (you register your own OAuth clients with each provider). No one-click App Store / Play Store submission (no managed macOS build farm). No cross-tenant user memory. No vendor-hosted credit meter. No vendor-amortized LLM key - you bring your own across any of six providers (Anthropic, OpenAI, Gemini, OpenRouter, MiniMax, or a local Ollama / vLLM / LM Studio / llama.cpp endpoint).
- **What self-host gains.** Your data, your source code, your LLM key, and your deploy target - all on infrastructure you own. No vendor in the path between you and your customers. No per-seat pricing. No rate limits beyond what your own LLM provider imposes on your own key. The local-LLM provider can be pointed at a separate GPU box on your LAN, so the workbench laptop stays cheap while inference runs where the silicon is. Single MIT-licensed binary that runs anywhere Node 22 runs - laptop, container, VPS, homelab, behind a VPN.
- **Honest about what is not built yet.** Trigger delivery creates durable canonical queued Worker runs, and `worker.run` executes them through a bounded, checkpointed, restart-recoverable supervisor with external-effect receipts, fine-grained runtime policy, durable rolling budgets, a closed adversarial permission gate, automatic approval attention, and independent operator controls whose restart/kill race gate passes. The W8 answerability gate covers the versioned evidence substrate, deterministic rollups, bounded retention cleanup, consolidated Worker health/cost/evidence API, bounded resumable event stream, and accessible canonical Worker list/detail workbench. W9's PacketADE handoff and W10's PacketChat/PacketPhone adapters and remote-control gate pass locally. This does not certify the external PacketChat or PacketPhone products: the two live probes are conditionally skipped until operators supply their endpoints and credentials. Artifact bytes are deleted only when a storage adapter implements the digest-checked retention port; no generic path deletion is attempted. Worker SMTP is now TLS-only, vault-backed, and public-address-pinned; Worker browser and SQL paths still fail closed until equally hardened drivers exist. Other remaining limits include opt-in real sandbox validation for non-Worker app flows and legacy template artifacts that may still use browser-side sql.js.
- **Honest about the gap with hosted.** The deferred hosted-only capabilities and what a future "PacketAgent Cloud" product would need to ship them are inventoried in [CLOUD.md](CLOUD.md). That document is for strategic reference, not a roadmap commitment - self-host stays the default.

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](#license)
![Version](https://img.shields.io/badge/version-v0.1.0-blue.svg)
[![Node](https://img.shields.io/badge/node-%3E%3D22.5.0-brightgreen.svg)](https://nodejs.org)
[![Built with TypeScript](https://img.shields.io/badge/built%20with-TypeScript-blue.svg)](https://www.typescriptlang.org)
[![React 19](https://img.shields.io/badge/React-19-61dafb.svg)](https://react.dev)
[![Hono](https://img.shields.io/badge/API-Hono-orange.svg)](https://hono.dev)

- **Repository:** `git@github.com:packetloss404/PacketAgent.git`; primary branch `main`
- **License:** MIT

## Project docs

- [docs/SELF_HOST.md](docs/SELF_HOST.md) is the canonical setup guide: prerequisites, 5-minute quick start, BYO-LLM-key configuration, and Docker-Compose deploy.
- [CLOUD.md](CLOUD.md) inventories the hosted-only capabilities PacketAgent intentionally does not ship as self-host, and what a hypothetical PacketAgent Cloud product would need to ship them.
- [CHANGELOG.md](CHANGELOG.md) records notable product and platform changes.
- [BACKLOG.md](BACKLOG.md) is the single implementation ledger for all remaining autonomous-worker and inherited platform work.
- [dev/CODEX-HANDOFF.md](dev/CODEX-HANDOFF.md) is the authoritative state and resume point for a new Codex project.
- [dev/worker-implementation-loops.md](dev/worker-implementation-loops.md) turns W2-W10 and the inherited backlog into dependency-ordered implementation and verification loops.
- [dev/packetade-packetagent-handoff.md](dev/packetade-packetagent-handoff.md) defines the versioned WorkerPackage v1 contract and PacketADE deployment lifecycle.
- [dev/taskloom-to-packetagent.md](dev/taskloom-to-packetagent.md) records rename compatibility and repository migration details.
- [dev/worker-contract-plan.md](dev/worker-contract-plan.md) records W1 research, contract decisions, implementation loops, and verification.
- [dev/TESTING.md](dev/TESTING.md) covers local verification and release checks.
- [dev/persistence-authority.md](dev/persistence-authority.md) records the physical authority, migration stages, and compatibility-facade decision for every control-plane store mode.
- [dev/r2-provider-policy.md](dev/r2-provider-policy.md) records the researched provider capability, structured-output, correction, vault, and readiness contract.
- [dev/r6-smtp-transport.md](dev/r6-smtp-transport.md) records the vault-backed SMTP trust boundary, configuration contract, research, and executable verification.
- [dev/roadmap.md](dev/roadmap.md) captures the broader roadmap after the MVP path is reliable.
- [Canonical Worker implementation report](output/pdf/packetagent-worker-implementation-report.pdf) is the committed pre-W10.3 pause snapshot summarizing W1-W10.2 and its verification.
- [Packet suite integration reality check](output/pdf/packet-suite-integration-reality-check.pdf) is the matching pre-W10.3 snapshot separating PacketAgent-side work from changes required in the other Packet repositories.

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

The current foundation checkout is `D:\projects\PacketAgent`. Its `origin` is
`git@github.com:packetloss404/PacketAgent.git`, with `main` as the primary
branch. The `taskloom-source` remote is historical and must not receive
PacketAgent changes.

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

- **In the workbench** - open **Admin -> Integrations** for Anthropic, OpenAI, Gemini, OpenRouter, or MiniMax credentials. Entries are stored in the encrypted secrets vault (AES-256-GCM at rest) and never logged.
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
7. Canonical Workers are bounded and crash-resumable through W1-W5. W6 compiles and enforces deployment-scoped verb/resource grants, resolves opaque credentials only after approval, pins public network destinations, requires isolated Docker execution for Worker commands, atomically reserves rolling provider/action budgets, and closes direct-registry plus adversarial bypasses. W7 adds independently authorized attention, approval, pause, resume, stop, and revoke controls whose restart and race gate passes. W8 adds the digest-bound evidence trail, deterministic rollups, retention, operations API, and accessible workbench. W9 completes the strict PacketADE package, trust boundary, receipt-bound deployment/control API, reconnectable event/cursor contract, and serialized disconnect/restart handoff gate. W10 adds the notification outbox, PacketChat delivery, PacketPhone controls, and a passing local remote-control certification gate; live interoperability stays conditional.
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
- **Draft, preview, iterate, export, publish handoff.** Review live
  plan/write/validate progress and every changed or unchanged file before
  applying. Each apply creates a checkpoint with source files on disk, a
  PacketAgent-served local preview, smoke checks, and rollback metadata. The
  Source view exports that immutable checkpoint as a git-ready ZIP with
  SHA-256 provenance and a plan-only, never-executed package-install review.
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
- **Consolidated Admin.** Twelve live operator surfaces (Roles, SSO, Secrets, Rate limits, Webhooks, Notifications, Operations, Integrations, Activation, Sandbox, Workflows, Billing) live under a single tabbed `/admin/:tab` page. The sidebar collapses to four items: Build, Projects, Runs, Admin. Back-compat redirects keep supported old per-page URLs working.
- **Command palette** (Cmd/Ctrl-K) for fast navigation and run shortcuts.

### Self-host

- **MIT licensed**, self-hosted, and runs anywhere the supported Node 22 runtime and required services are available.
- **No telemetry.** Nothing phones home.
- **BYO keys.** No vendored model relationships; no proxy in the middle.
- **JSON, SQLite, or managed Postgres.** Default is file-backed JSON for contributor flow; use SQLite for a single process on one host or managed Postgres when multiple app processes must share state. The managed adapter serializes whole-document writes for correctness; it is not a per-entity relational scale-out layer.

## Data layer and migration

PacketAgent keeps one logical `PacketAgentData` mutation contract with a different physical authority in each mode:

- **JSON** stores the complete normalized document in one atomically replaced file and is limited to contributor/evaluation use.
- **SQLite** uses Node's built-in `node:sqlite` with WAL, foreign keys, `busy_timeout`, and one `BEGIN IMMEDIATE` whole-store transaction. Promoted hot and Worker collections live in dedicated relational tables; remaining records live in `app_records`.
- **Managed Postgres** stores one normalized document in `packetagent_document_store`. A row lock plus transaction-scoped advisory lock serializes writers across processes. It does not currently use the SQLite per-entity migration tables.
- **Staged backfill and verification** move old `app_records` collections into dedicated SQLite tables or copy a stopped JSON/SQLite source into the managed document adapter. There is no live SQLite-to-Postgres dual-write cutover.
- **27 ordered SQLite migrations** live in `src/db/migrations`.

Managed startup requires a database URL plus
`PACKETAGENT_MANAGED_DATABASE_ADAPTER=postgres`. Multiple app processes can
share the document safely, but write throughput remains globally serialized.
See [the persistence-authority decision](dev/persistence-authority.md) and
[deployment guidance](dev/deployment/persistence.md).

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

A first-class sandbox runtime ships under `/api/app/sandbox/*` with a `/sandbox`
view in the workbench. It powers ad-hoc command execution and the required
app-builder TypeScript/Vite validation pipeline before publish handoff.

- **Drivers.** `docker` (default) runs each untrusted command with no network or
  IPC namespace sharing, a read-only root, bounded writable `/tmp`, non-root
  identity, dropped capabilities, `no-new-privileges`, CPU/memory/PID/file
  descriptor limits, and an exact wall-clock deadline. Docker is the only
  untrusted-code boundary. An explicitly opted-in `native` host process is
  available only to owners/admins for trusted-host diagnostics; ordinary
  sandbox calls, generated-code validation, and Workers reject it.
- **Boundary policy.** One resolver validates command/stdin size, container
  working directories, requested timeout, and a small explicit environment
  before the driver starts. Host environment values are never inherited by
  containers; secret-bearing and runtime-control variable names are rejected,
  and accepted values are redacted in stored records. The selected exec view
  reports the effective resource, network, filesystem, and environment policy.
- **Declared egress.** Containers always retain Docker `--network=none`.
  Operators may configure exact HTTP(S) origins for bounded, GET-only input
  prefetch. PacketAgent performs those requests through the W6 pinned-network
  client, which validates all A/AAAA answers and the connected address and
  refuses redirects. Successful bodies are mounted read-only under
  `/input/egress`; records contain a query-redacted target, size, digest,
  status, and connected address, while broker receipts never copy the body or
  query values. As with any command input, code can still print body content
  into its bounded stdout/stderr preview.
- **Endpoints.** `GET /status`, `GET /runtimes`, `POST /exec`, `GET /exec`, `GET /exec/:id`, `POST /exec/:id/cancel`, `GET /exec/:id/stream` (SSE).
- **Workbench UI.** Status panel, runtime readiness, command composer, exec history, and a live log viewer with stdout / stderr tabs and follow-tail. The Builder also gains a per-app Sandbox tab.
- **Generated-code validation.** Draft apply, change apply, preview refresh, and
  file-tree authoring require real `tsc --noEmit` and Vite results. PacketAgent
  builds a Dockerfile/lockfile-addressed local validator image on first use,
  mounts generated source read-only, copies it to an ephemeral workspace, and
  disables container networking. Missing Docker or image/execution failure is
  reported as blocked failure, never success. Run
  `npm run verify:codegen-sandbox` to prove the real local path.

## Generated-app runtime

Generated apps call PacketAgent's workspace-scoped API and store their data in
one SQLite database per app. A supervised Node child process starts on the
first runtime request, stays warm, and is reused until the least-recently-used
idle process must be evicted. `PACKETAGENT_GENERATED_APP_RUNTIME_MAX_PROCESSES`
sets the per-server pool limit; it defaults to `4` and is clamped to `1-64`.

An authenticated workspace viewer can inspect aggregate health at
`GET /api/app/generated-app-runtime/health` or an owned app at
`GET /api/app/generated-apps/:appId/runtime/health`. The response reports
process state, active requests, request/failure/retry/start/restart/eviction
counters, and bounded recent crash metadata without raw error or secret
content. An unexpected exit or failed request gets one supervised retry and
remains `degraded` in health for five minutes. The same per-app health is
visible in the Builder's Sandbox tab. Reading health does not start an idle
runtime.

Generated-app publish materialization writes `publish-artifacts.json` using
`packetagent.generated-app-artifact-manifest/v2`. It binds the workspace, app,
and immutable checkpoint; records every exported file's relative path, media
type, byte count, and SHA-256; validates local HTML and CSS asset references;
rejects missing, modified, extra, traversing, or symlinked files; and seals the
canonical manifest subject with its own SHA-256 digest. Set a
32-byte-or-longer `PACKETAGENT_PUBLISH_MANIFEST_SIGNING_KEY` to add an optional
HMAC-SHA256 authenticity check and
`PACKETAGENT_PUBLISH_MANIFEST_SIGNING_KEY_ID` to label the non-secret key. The
key is never written to the manifest. Authenticated viewers can re-check the
current publish at
`GET /api/app/generated-apps/:appId/publish/integrity`; the Builder Publish tab
shows the same file/byte totals and signature state.

Each materialized publish is also a standalone container package under
`data/published-apps/<workspace>/<app>/` (or the selected publish root). It
contains `Dockerfile.publish`, `docker-compose.publish.yml`, the generated
source bundle, a small dependency-free Node static/health/SQLite runtime, the
checkpoint's runtime model, and a runbook. The single generated-app service
does not start PacketAgent or Postgres. Its final image is non-root with a
read-only root filesystem, bounded resources, dropped capabilities,
`no-new-privileges`, and a named SQLite data volume. Vite compiles with build
networking disabled, and runtime readiness validates Vite's emitted asset
manifest and referenced files.

Run the bounded local certification path from the repository root:

```bash
npm run verify:generated-app-publish -- data/published-apps/<workspace>/<app>
```

The verifier validates Compose, builds and starts on a free loopback port,
checks health/static/CRUD, restarts the container to prove SQLite persistence,
runs a stopped-service SQLite backup/mutate/restore round trip, then removes
its uniquely named containers, network, volume, local image, and temporary
backup.
For ordinary use, follow the generated `RUNBOOK.md`; the default app URL is
`http://localhost:8787`, configurable with
`PACKETAGENT_GENERATED_APP_PORT`.

The host port binds to `127.0.0.1` by default. Each sealed package includes
`deploy/Caddyfile.example`, `deploy/nginx.generated-app.conf.example`, and
`deploy/TAILSCALE.md` for automatic-HTTPS reverse proxying, explicit nginx TLS,
or private tailnet access. PacketAgent does not provision DNS, certificates,
or VPN policy. After configuring the final origin, prove that it reaches the
exact app and checkpoint:

```bash
npm run verify:generated-app-reachability -- data/published-apps/<workspace>/<app> https://app.example.com
```

The verifier requires HTTPS away from loopback, bounds DNS/TCP/TLS/HTTP work,
validates the certificate, refuses redirects, and requires health identity plus
an HTML app root.

## Configuration

Common environment variables:

| Variable                                          | Default                    | Purpose                                                                                                                                                                                               |
| ------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                        | `development`              | Set to `production` to mark cookies `Secure` and disable dev shortcuts.                                                                                                                               |
| `PORT`                                            | `8484`                     | API server port.                                                                                                                                                                                      |
| `PACKETAGENT_STORE`                               | `json`                     | `json`, `sqlite`, or `postgres`. A configured managed URL also selects managed mode unless SQLite is explicit.                                                                                        |
| `PACKETAGENT_DB_PATH`                             | `data/packetagent.sqlite`  | SQLite database path when store is `sqlite`.                                                                                                                                                          |
| `PACKETAGENT_DATABASE_URL`                        | _unset_                    | Managed Postgres URL. `PACKETAGENT_MANAGED_DATABASE_URL` and `DATABASE_URL` are accepted aliases.                                                                                                     |
| `PACKETAGENT_MANAGED_DATABASE_ADAPTER`            | _unset_                    | Set to `postgres` when enabling the managed adapter.                                                                                                                                                  |
| `PACKETAGENT_TRUST_PROXY`                         | `false`                    | Trust `X-Forwarded-Host` / `X-Forwarded-For` from a known proxy.                                                                                                                                      |
| `PACKETAGENT_APP_ORIGIN`                          | _unset_ in development     | Canonical workbench origin. Required as an HTTPS origin in production and used to bind interactive preview framing.                                                                                   |
| `PACKETAGENT_PREVIEW_ORIGIN`                      | `http://127.0.0.2:8484`    | Isolated generated-preview origin. Production requires a different HTTPS hostname from `PACKETAGENT_APP_ORIGIN`; a different port on the same hostname is rejected.                                   |
| `PACKETAGENT_PREVIEW_TOKEN_SECRET`                | master key or dev fallback | Optional dedicated HMAC key for checkpoint-bound preview capabilities. Production requires this, `PACKETAGENT_MASTER_KEY`, or `MASTER_KEY`; the source fallback is development-only.                  |
| `PACKETAGENT_RATE_LIMIT_KEY_SALT`                 | _unset_                    | Salt for hashed rate-limit bucket IDs. Set in production.                                                                                                                                             |
| `PACKETAGENT_SANDBOX_DRIVER`                      | `auto`                     | `docker`, `native`, or `auto`. `native` is never an untrusted-code fallback.                                                                                                                          |
| `PACKETAGENT_ALLOW_INSECURE_NATIVE_SANDBOX`       | `false`                    | Allow owner/admin trusted-host diagnostics when the selected driver is `native`. This provides no isolation and is rejected by generated-code and Worker paths.                                       |
| `PACKETAGENT_SANDBOX_DEFAULT_RUNTIME`             | `node-20`                  | Default container image.                                                                                                                                                                              |
| `PACKETAGENT_SANDBOX_DEFAULT_TIMEOUT_MS`          | `120000`                   | Default wall-clock timeout for an execution.                                                                                                                                                          |
| `PACKETAGENT_SANDBOX_MAX_TIMEOUT_MS`              | `120000`                   | Maximum client-requested wall-clock timeout; clamped to `1000-900000`.                                                                                                                                |
| `PACKETAGENT_SANDBOX_MEMORY_MB`                   | `512`                      | Container memory limit.                                                                                                                                                                               |
| `PACKETAGENT_SANDBOX_CPUS`                        | `1`                        | Container CPU limit.                                                                                                                                                                                  |
| `PACKETAGENT_SANDBOX_PIDS_LIMIT`                  | `64`                       | Container PID and process-count limit.                                                                                                                                                                |
| `PACKETAGENT_SANDBOX_TMPFS_MB`                    | `256`                      | Size limit for the container's writable `/tmp`.                                                                                                                                                       |
| `PACKETAGENT_SANDBOX_EGRESS_ALLOWLIST`            | _unset_                    | Comma-separated exact HTTP(S) origins allowed for GET-only brokered input prefetch. Empty means deny-all; containers always remain networkless.                                                       |
| `PACKETAGENT_SANDBOX_EGRESS_TIMEOUT_MS`           | `15000`                    | Per-fetch broker timeout, clamped to `1000-60000`.                                                                                                                                                    |
| `PACKETAGENT_SANDBOX_EGRESS_MAX_RESPONSE_BYTES`   | `65536`                    | Per-fetch response cap, clamped to `1024-1048576`; the total per exec is capped at 512 KiB.                                                                                                           |
| `PACKETAGENT_GENERATED_APP_RUNTIME_MAX_PROCESSES` | `4`                        | Maximum warm generated-app child processes per PacketAgent server. Values are clamped to `1-64`; an idle least-recently-used process is evicted at the limit.                                         |
| `PACKETAGENT_GENERATED_APP_BIND_ADDRESS`          | `127.0.0.1`                | Host address used by a generated publish package's Compose port mapping. Set `0.0.0.0` only for deliberate, protected direct LAN exposure.                                                            |
| `PACKETAGENT_GENERATED_APP_PORT`                  | `8787`                     | Host port used by a generated publish package. The container always listens on `8080`.                                                                                                                |
| `PACKETAGENT_PUBLISH_MANIFEST_SIGNING_KEY`        | _unset_                    | Optional HMAC-SHA256 key for generated-app manifest authenticity; must be at least 32 bytes. Per-file and canonical-manifest SHA-256 verification is always enabled.                                  |
| `PACKETAGENT_PUBLISH_MANIFEST_SIGNING_KEY_ID`     | `packetagent-local`        | Non-secret label recorded with an optional publish-manifest signature.                                                                                                                                |
| `PACKETAGENT_AGENT_BUNDLE_TRUSTED_KEY_IDS`        | _unset_                    | Comma-separated SHA-256 SPKI fingerprints trusted for signed Agent–Worker imports. A cryptographically valid unlisted publisher requires explicit admin acknowledgement.                              |
| `PACKETAGENT_ARTIFACT_SERVING_ENABLED`            | `false`                    | Opt in to artifact-file serving. Reads still require an authenticated viewer in the workspace that owns the exact run ID in the URL.                                                                  |
| `PACKETAGENT_LEGACY_TEMPLATES`                    | _unset_                    | Set to `1` to force the legacy template path and skip the file-tree codegen orchestrator entirely. The previous opt-in flag `PACKETAGENT_FILETREE_CODEGEN=1` is preserved as a no-op for back-compat. |
| `PACKETAGENT_PROVIDER_PRIORITY`                   | _unset_                    | Comma-separated provider override (e.g. `ollama,openrouter,anthropic`). Applied to every preset; first registered provider with a configured key wins.                                                |
| `LOCAL_LLM_BASE_URL`                              | _unset_                    | Base URL of a local LLM server (vLLM, LM Studio, llama.cpp, remote Ollama). Takes precedence over `OLLAMA_BASE_URL`.                                                                                  |
| `OLLAMA_BASE_URL`                                 | `http://localhost:11434`   | Legacy synonym for `LOCAL_LLM_BASE_URL`; honored when `LOCAL_LLM_BASE_URL` is unset.                                                                                                                  |
| `LOCAL_LLM_API_FORMAT`                            | `ollama`                   | `ollama` (native `/api/chat`) or `openai` (`/v1/chat/completions`). Set to `openai` for vLLM / LM Studio / llama.cpp.                                                                                 |
| `LOCAL_LLM_MODEL`                                 | _unset_                    | Pins the model name when the remote server only loads one specific model.                                                                                                                             |
| `LOCAL_LLM_STRUCTURED_OUTPUTS`                    | `auto`                     | `auto` sends vLLM's `structured_outputs` schema and permits one prompt fallback on an unsupported-field response; `off` uses the prompt fallback directly.                                            |

Anthropic, OpenAI, Gemini, OpenRouter, and MiniMax keys can be configured per workspace under **Admin -> Integrations** and stored in the encrypted vault. A production `MASTER_KEY` is required to unseal the vault.

Generated previews never run on the workbench origin. In development, open the
workbench at `http://localhost:7341`; its preview iframe uses
`http://127.0.0.2:8484`. In production, configure two HTTPS hostnames that
proxy to the same PacketAgent process. The workbench session cookies remain
host-only on the primary hostname. A preview link carries a short-lived,
checkpoint-bound capability in its URL fragment, exchanges it for a Secure,
HttpOnly, partitioned cookie scoped to one generated-app path, then removes the
fragment before generated code is served. Read-only share links cannot mutate
runtime data; the Builder uses a shorter interactive scope. Caddy and nginx
examples live in
[`dev/deployment/examples/preview-origin/`](dev/deployment/examples/preview-origin/).
Run `npm run verify:preview-isolation` after changing origin or proxy settings.

Workspace admins configure Worker credentials through metadata-only `GET`,
`PUT`, and `DELETE /api/app/workers/credentials` routes. A PacketChat
notification route uses an `opaque` credential whose reference is declared by
the immutable Worker version and whose value follows
`packetagent.packetchat-route/v1`; plaintext and encrypted fields are never
returned by these routes.

## Architecture

- **Frontend.** React 19 + react-router 7 + Vite 7, mounted at `/`. Tailwind CSS, Geist fonts, a silver / grey / green-light theme. `/builder` is a full-bleed route outside the workbench Shell (chat thread, streamed prose, split preview). The rest of the workbench lives behind a four-item sidebar (Build, Projects, Runs, Admin); twelve live operator surfaces are tabbed under `/admin/:tab`.
- **Backend.** Hono on `@hono/node-server`. `src/server.ts` mounts ~20 route groups (`app-routes`, `workflow-routes`, `webhook-routes`, `share-routes`, `sandbox-routes`, four `operations-*-routes`, and more) with access-log middleware, redacted error envelopes, baseline security headers/CSP, `enforcePrivateAppMutationSecurity` on `/api/app/*`, cross-origin/CSRF enforcement, a fail-closed primary/preview host split, public webhooks, and static serving of the built web plus explicitly enabled, authenticated, workspace-scoped run artifacts.
- **LLM layer.** `ProviderRouter` route-key dispatch over six BYOK clients, a canonical capability/model/generation catalog, vault-aware preset resolution and readiness, native/conditional structured response mapping, one bounded malformed-tool correction, and a cost `ledger`. A `stub` provider keeps the loop runnable with zero keys.
- **Codegen + agents.** `src/codegen/` (plan/write/chunk orchestrator, path validator, derived-draft, app-builder/iteration services, generated-app runtime/workspace, preview/snapshot/publish-readiness) and `src/tools/` (agent loop, registry/executor, read/write/browser builtins, Playwright runtime) plus `src/sandbox/`.
- **Persistence.** File-backed JSON for contributor flow; `node:sqlite` (WAL, foreign keys on, `busy_timeout`) for single-node; and an advisory-lock-serialized managed-Postgres document adapter for shared app processes. SQLite has 27 ordered SQL migrations.
- **Jobs / ops.** Persisted queue with five-field cron, exponential retry, dead-letter, three-way scheduler leader election, an alert engine, and metrics snapshots.

## Engineering & testing

PacketAgent is TypeScript ESM on Node >=22.5 with a React/Vite frontend. The code uses strict typechecking, dependency injection in many runtime boundaries, and feature directories for providers, tools, jobs, sandboxing, repositories, activation, codegen, and security. The repository lint gate currently passes with zero warnings.

The W8.3 validation ran **1,452 API tests** (1,451 passed, 1 skipped) plus **25 web tests** with no failures, covering separate retention windows, pre-persistence and read-boundary redaction, read-only dry runs, bounded tenant cleanup, terminal-only compaction, artifact deletion ports, idempotent tombstones, retention-explained gaps, and stable JSON/SQLite/managed-Postgres parity in addition to the W8.2 and prior Worker gates.

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

- **The canonical runtime and Packet-side handoff/control adapters pass their local gates; live product interoperability is not certified.** W1-W5 provide versioned Worker records, lifecycle routes, durable trigger intake, bounded execution, immutable full-state checkpoints, scheduler recovery, and mutation effect receipts across JSON, SQLite, and managed Postgres. W6 compiles version-bound verb/resource grants, rejects deployment broadening, normalizes and authorizes each operation, resolves only declared opaque credentials, pins public network destinations, denies redirects, requires isolated no-network Docker command execution, atomically reserves provider cost and externally billable actions across rolling workspace/deployment windows, and prevents direct registered-handler bypass. W7 persists and executes exact attention/control state, exposes concise independently authorized operator routes, and closes restart/callback/control/activation races without later work. W8 persists versioned evidence and artifact provenance, rebuilds deterministic cumulative rollups, applies bounded redaction/retention with deletion evidence, and exposes the consolidated server-side operations read model, cursor APIs, resumable SSE, and accessible canonical Worker workbench. W9 defines strict digest-bound WorkerPackage v1 bytes, optional DSSE verification, authenticated workspace-bound PacketADE actors, durable local-policy receipts, the receipt-bound deployment/control API, reconnectable PacketADE events with explicit acknowledgements, and a passing disconnect/restart contract gate. W10 adds the durable notification outbox, encrypted pinned-network PacketChat delivery with exact-binding read-only callbacks, encrypted HTTPS-only PacketPhone delivery with role-bounded durable single-use W7 controls, and a local certification matrix covering race orderings, restart, replay, credential rotation, and audited dead-letter redrive. The registered live PacketChat and PacketPhone probes have not run because no external configuration is present.
- **File-tree codegen is an inherited secondary capability.** With a BYOK key,
  the LLM authors files through `write_file`, requires isolated `tsc` and Vite
  validation, and can make up to two bounded repair passes. If Docker-backed
  validation cannot run, authoring stops with a blocked result. Legacy
  template-shaped drafts still use their older iteration path.
- **Per-app SQLite has an explicit reset/reseed schema policy.** PacketAgent previews use the supervised per-app SQLite runtime. Standalone publish packages use the same CRUD/storage semantics inside their own container and named volume. Same-schema restarts preserve records; a schema-signature change clears and reseeds that app's records. Runtime health/readiness declares `schemaChangePolicy: "reset-and-reseed"`, generated SQL is labeled reference DDL rather than an executed migration, and the runbook includes a verified stopped-service backup/restore path. Automatic data-preserving schema migration is not implemented or claimed. Legacy template/source artifacts and older saved drafts can still contain sql.js/jsdelivr browser persistence.
- **Outbound Worker tools fail closed when a hardened dependency is unavailable.** `http_fetch`, `slack_post_webhook`, and `github_api` use Worker-scoped credential and pinned-network ports; `email_send` uses the vault-backed, public-address-pinned TLS SMTP port; and `run_command` and `shell_for_agent` use the Docker-only execution port. Worker browser and SQL calls are refused until equivalent hardened drivers are implemented. Approval tokens remain on the inherited Agent path, and legacy interactive Agent adapters retain their existing configuration behavior.
- **Preview is local.** Builder preview routes serve generated source files from disk through PacketAgent. They are not public deployments unless you configure and validate a public URL.
- **Publish is a verified local handoff, not managed hosting.** PacketAgent emits and integrity-checks the standalone package and provides a Docker certification command. Operators still run the long-lived service and configure DNS, TLS, reverse proxy, VPN, backups, and public networking.
- **Secure generated-code validation requires Docker.** Interactive sandbox
  commands may use the explicitly insecure native driver only as owner/admin
  trusted-host diagnostics, but it is not a security fallback. Generated
  TypeScript/Vite validation and Workers require Docker and fail closed when it
  is unavailable. PacketAgent does not use `node:vm` or claim Deno permissions
  alone isolate arbitrary untrusted code.
- **Self-host is the category, not a step toward hosted.** PacketAgent is not pursuing parity with Replit, v0, Bolt, Lovable, or anything.com. Hosted-only capabilities (free public subdomain, pre-wired OAuth, managed App Store submission) are inventoried in [CLOUD.md](CLOUD.md) and intentionally out of scope.

### SQLite mode

```bash
PACKETAGENT_STORE=sqlite npm run dev
npm run db:migrate
npm run db:seed
```

`npm run db:reset` recreates the schema and reseeds. `npm run db:backup` and `npm run db:restore` snapshot and restore the SQLite file. See `npm run` for the full list of database commands, including managed-Postgres backfill (`db:backfill-*`) and verify (`db:verify-*`) helpers.

## Project status

PacketAgent is in its foundation transition from TaskLoom's app/agent workbench to the autonomous-worker runtime described at the top of this file. The inherited Builder and operate surfaces work; the rename and compatibility layer are committed on the current foundation branch. The canonical Worker model, lifecycle, trigger intake, bounded-supervisor, W5 recovery/effect-safety, W6 permission/budget, W7 attention/control, and W8 observability/answerability gates are complete. W9.1-W9.2 freeze the strict WorkerPackage v1 handoff schema and canonical digest bytes, then bind PacketADE bearer credentials to one workspace, actor, operation set, expiry/revocation state, and optional DSSE policy before persisting token-safe integrity and local capability receipts. W9.3 maps those receipts to immutable Worker definitions, versions, and deployments, then exposes validate/deploy/update/activate/inspect/list/pause/resume/rollback/revoke through the canonical lifecycle, activation, control, and observability services. W9.4 projects versioned deployment/run events through cursor pages and bounded SSE, links evidence, and persists idempotent ETag-guarded acknowledgements. W9.5 proves the serialized handoff survives client disconnect and service reconstruction through later update, pause/resume, rollback, and revoke. W10.1 adds a channel-neutral, event/evidence-bound notification outbox with stable idempotency, bounded delivery leases, retries, expiry, dead-letter state, opaque route references, redacted delivery metadata, and durable scheduler integration. W10.2 resolves PacketChat routes only through declared encrypted credentials, sends concise run-bound cards through the hardened network port, collapses progress into one replaceable thread message, and verifies short-lived open/inspect callbacks against the exact Worker identity and version digest. W10.3 resolves HTTPS-only PacketPhone routes through the same vault and hardened network port, emits only role- and state-valid controls, and consumes signed callbacks exactly once through atomic W7 commands with digest-only remote audit metadata. W10.4 certifies both local adapters under race orderings, callback replay, credential rotation, pending-delivery restart, and bounded audited dead-letter redrive while leaving live probes conditional. Current trigger sources create deduplicated, version-pinned runs that execute within explicit bounds, recover from immutable snapshots without repeating a completed mutation or double-crediting an abandoned budget hold, and expose their identity, purpose, version, budgets, checkpoint, attention, evidence, artifacts, and outcome from one server-side operations read model.

The inherited generated-app R4 gate is also complete: packages are
checkpoint-bound and integrity-checked, run as one hardened standalone
Node/Vite/SQLite service, expose exact health/identity/schema-policy evidence,
support verified reverse-proxy/VPN reachability, and prove same-schema
persistence plus stopped-service backup/restore. R5.1 also requires real
network-disabled Docker validation for generated TypeScript/Vite and removes
the old synthetic-success path. R5.2 makes Docker the sole untrusted-code
driver, restricts native host execution to explicit owner/admin diagnostics,
and permanently guards against `node:vm`. R5.3 centralizes the sandbox boundary
policy, enforces and records the effective wall-clock, CPU, memory, PID,
filesystem, environment, and deny-all-network limits, and proves the boundary
against real Docker. R5.4 adds operator-allowlisted, W6-hardened, GET-only
read-only input prefetch without giving the container a network interface.
R5.5 moves generated preview documents and runtime APIs to a distinct browser
origin, replaces query/session inheritance with fragment-exchanged scoped
capabilities, constrains generated code with per-response CSP, and preserves
click-to-edit through a validated cross-origin message bridge. R5.6 closes the
containment gate with one verified non-root/read-only-root/capability-drop/
no-new-privileges/process-limit matrix across the validator, control-plane
Compose service, generated-app package, and live untrusted sandbox.
R6.1 adds the default TLS-only SMTP transport: legacy Agents may use `SMTP_*`
environment settings, while Workers require a declared encrypted
`smtp_config` reference, credential-bound sender identity, recipient policy
approval before secret resolution, and the W6 public-address pinning boundary.
R6.2 adds LLM-authored agent templates through one bounded provider call. It
uses strict JSON Schema when the selected provider supports structured output,
always performs local semantic validation and redaction, preserves
deterministic triggers and registered-tool bounds, and visibly falls back to
the heuristic builder on unavailable, failed, incomplete, or invalid output.
Users still review before save. Saved agents project to valid canonical Worker
drafts; they are not deployed through the unified Worker lifecycle until R6.6.
R6.3 makes execution readiness explicit before save: the same canonical preset
resolution now drives authoring, the displayed provider and exact model, the
saved model, and a restart-safe execution route. The Builder reports only
secret-free key-source metadata, distinguishes configured models from live
verified models, and shows streaming, tool-use, and structured-output support.
Missing runtimes block the first run; conditional capabilities are carried
into R6.4 evaluation.
R6.4 adds editable bounded non-secret memory, saved typed input examples, and
expected-output review context in both the Builder and Agent editor. Builder
approval persists the examples, then uses the real bounded Agent loop; enabled
tools still require the existing explicit launch approval. The resulting
versioned evaluation records exact input matching, run success, non-empty
redacted output, required successful tool calls, model identity, and review
notes across JSON, SQLite, managed Postgres, Agent detail, and run traces. It
does not make a second model call or claim an automatic semantic score.
R6.5 adds a separate self-host portability contract rather than weakening the
PacketADE-only `WorkerPackage v1` source boundary. A strict signed
`packetagent.agent-worker-bundle/v1` download contains the complete portable
Agent authoring plus its deterministic canonical Worker draft projection.
RFC 8785 canonical bytes, SHA-256 digests, and Ed25519 DSSE bind the content
and media type. Production derives the signing identity from `MASTER_KEY`;
remote publisher fingerprints can be configured through
`PACKETAGENT_AGENT_BUNDLE_TRUSTED_KEY_IDS`, and an otherwise valid publisher
requires explicit admin acknowledgement. Export omits local IDs, credentials,
provider destinations, webhook tokens, history, and active state. Import
preflight exposes signature/trust and provider/tool readiness; the idempotent
mutation assigns fresh IDs and always lands paused with a draft Worker
projection. R6.6 still owns canonical-only Agent execution and migration.

The exact resume point is R6.6 in [BACKLOG.md](BACKLOG.md), the sole ledger for
the conditional live W10 check and all remaining R6-R8 work. New Codex projects
should begin with [dev/CODEX-HANDOFF.md](dev/CODEX-HANDOFF.md), not the archived
Phase 3 or legacy handoff documents.

For current product changes, see [CHANGELOG.md](CHANGELOG.md). The repository is
published at `git@github.com:packetloss404/PacketAgent.git`; a website, issue
tracker policy, and release feed have not yet been established.

## Contributing

Make changes on local `codex/*` branches and publish PacketAgent work to
`origin`, never to the historical `taskloom-source` remote. Run `npm run build`
before publishing work; it runs the web build, full TypeScript typecheck, API
tests, and frontend tests.

## License

Released under the [MIT License](https://opensource.org/licenses/MIT). Copyright (c) PacketAgent contributors.
